import CoreVideo
import VideoToolbox
import XCTest
@testable import SimNative

/// The encoder falls back from low-latency to default rate control once, after its first failed
/// encode, and counts it.
final class H264EncoderFallbackTests: XCTestCase {
    func testExplicitDefaultRateControlIsNotReportedAsFallback() async throws {
        let encoder = H264Encoder(fps: 60, bitrate: 500_000, constrainedBaseline: true,
                                  dynamicBitrate: true, lowLatencyRateControl: false)
        let flat = try frame()
        for _ in 0..<5 { _ = try await encoder.encode(flat) }
        let fallbacks = await encoder.lowLatencyFallbacks
        await encoder.stop()
        XCTAssertEqual(fallbacks, 0)
    }

    private let width = 320
    private let height = 640

    /// Flat gray in the default format; a depth format VideoToolbox cannot encode as H.264.
    private func frame(format: OSType = kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange) throws -> CVPixelBuffer {
        var buffer: CVPixelBuffer?
        let attributes: [String: Any] = [kCVPixelBufferIOSurfacePropertiesKey as String: [:]]
        XCTAssertEqual(CVPixelBufferCreate(kCFAllocatorDefault, width, height, format,
                                           attributes as CFDictionary, &buffer), kCVReturnSuccess)
        let pixels = try XCTUnwrap(buffer)
        guard format == kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange else { return pixels }
        CVPixelBufferLockBaseAddress(pixels, [])
        defer { CVPixelBufferUnlockBaseAddress(pixels, []) }
        for plane in 0..<2 {
            memset(CVPixelBufferGetBaseAddressOfPlane(pixels, plane), 128,
                   CVPixelBufferGetBytesPerRowOfPlane(pixels, plane) * CVPixelBufferGetHeightOfPlane(pixels, plane))
        }
        return pixels
    }

    private func requireLowLatencyRateControl() throws {
        var session: VTCompressionSession?
        let spec = [kVTVideoEncoderSpecification_EnableLowLatencyRateControl: kCFBooleanTrue!] as CFDictionary
        let status = VTCompressionSessionCreate(
            allocator: nil, width: Int32(width), height: Int32(height), codecType: kCMVideoCodecType_H264,
            encoderSpecification: spec, imageBufferAttributes: nil, compressedDataAllocator: nil,
            outputCallback: nil, refcon: nil, compressionSessionOut: &session
        )
        guard status == noErr, let session else { throw XCTSkip("no low-latency H.264 encoder here") }
        VTCompressionSessionInvalidate(session)
    }

    private func makeEncoder() -> H264Encoder {
        H264Encoder(fps: 60, bitrate: 500_000, constrainedBaseline: true, dynamicBitrate: true)
    }

    func testEncodeFailureCountsOneFallback() async throws {
        try requireLowLatencyRateControl()
        let encoder = makeEncoder()
        let depth = try frame(format: kCVPixelFormatType_DepthFloat32)
        for _ in 0..<3 {
            _ = try? await encoder.encode(depth)
        }
        let fallbacks = await encoder.lowLatencyFallbacks
        XCTAssertEqual(fallbacks, 1)
    }

    /// A successful VideoToolbox frame drop must not permanently change rate-control mode.
    func testDroppedFrameKeepsLowLatencySession() async throws {
        try await checkDroppedFrameKeepsLowLatencySession(constrainedBaseline: false)
    }

    func testDroppedFrameKeepsLowLatencyConstrainedBaselineSession() async throws {
        try await checkDroppedFrameKeepsLowLatencySession(constrainedBaseline: true)
    }

    private func checkDroppedFrameKeepsLowLatencySession(constrainedBaseline: Bool) async throws {
        try requireLowLatencyRateControl()
        let encoder = H264Encoder(fps: 60, bitrate: 500_000, constrainedBaseline: constrainedBaseline)
        let flat = try frame()
        var descriptions = 0
        var delivered = 0
        for _ in 0..<12 {
            if let output = try await encoder.encode(flat) {
                delivered += 1
                if output.description != nil { descriptions += 1 }
            }
        }
        let initialFallbacks = await encoder.lowLatencyFallbacks
        if delivered == 12 && initialFallbacks == 0 {
            await encoder.stop()
            throw XCTSkip("VideoToolbox did not drop a frame for constrainedBaseline=\(constrainedBaseline)")
        }
        XCTAssertLessThan(delivered, 12, "the regression requires a successful frame drop")
        XCTAssertGreaterThan(delivered, 1, "the encoder must continue producing frames after a drop")
        XCTAssertEqual(descriptions, 1, "a dropped frame must not replace the decoder configuration")
        await encoder.update(fps: 30, bitrate: 500_000)
        let reset = try await encoder.encode(flat)
        XCTAssertNotNil(reset?.description)
        await encoder.stop()
        let reconnected = try await encoder.encode(flat)
        XCTAssertNotNil(reconnected?.description)
        let fallbacks = await encoder.lowLatencyFallbacks
        XCTAssertEqual(fallbacks, 0)
        await encoder.stop()
    }

    /// A dropped forced keyframe carries to the next frame on the same session.
    func testDroppedKeyframeCarriesToNextFrame() async throws {
        try requireLowLatencyRateControl()
        let encoder = H264Encoder(fps: 60, bitrate: 500_000, simulateDrop: { frame, _, _ in frame == 1 })
        let flat = try frame()
        let dropped = try await encoder.encode(flat, forceKeyframe: true)
        XCTAssertNil(dropped)
        let nextOutput = try await encoder.encode(flat)
        let next = try XCTUnwrap(nextOutput)
        XCTAssertEqual(next.kind, .keyframe)
        XCTAssertNotNil(next.description)
        let fallbacks = await encoder.lowLatencyFallbacks
        let drops = await encoder.droppedFrames
        await encoder.stop()
        XCTAssertEqual(fallbacks, 0)
        XCTAssertEqual(drops, 1)
    }

    /// Repeated dropped keyframes fall back to a fresh default-rate-control session.
    func testRepeatedDroppedKeyframesFallBack() async throws {
        try requireLowLatencyRateControl()
        let encoder = H264Encoder(fps: 60, bitrate: 500_000,
                                  simulateDrop: { _, forced, lowLatency in forced && lowLatency })
        let flat = try frame()
        let limit = H264Encoder.maxConsecutiveDroppedKeyframes
        for _ in 1..<limit {
            let dropped = try await encoder.encode(flat, forceKeyframe: true)
            XCTAssertNil(dropped)
        }
        let recoveredOutput = try await encoder.encode(flat, forceKeyframe: true)
        let recovered = try XCTUnwrap(recoveredOutput)
        XCTAssertEqual(recovered.kind, .keyframe)
        XCTAssertNotNil(recovered.description)
        let fallbacks = await encoder.lowLatencyFallbacks
        let drops = await encoder.droppedFrames
        await encoder.stop()
        XCTAssertEqual(fallbacks, 1)
        XCTAssertEqual(drops, UInt64(limit))
    }

    /// Shared WebRTC keeps its policy: a drop in default mode rebuilds the session.
    func testWebRTCDefaultModeDropRebuildsSession() async throws {
        let encoder = H264Encoder(fps: 60, bitrate: 500_000, constrainedBaseline: true,
                                  dynamicBitrate: true, lowLatencyRateControl: false,
                                  fallbackOnFrameDrop: true, simulateDrop: { frame, _, _ in frame == 2 })
        let flat = try frame()
        let first = try await encoder.encode(flat, forceKeyframe: true)
        XCTAssertNotNil(first?.description)
        do {
            _ = try await encoder.encode(flat)
            XCTFail("a default-mode WebRTC drop must rebuild the session and throw")
        } catch {}
        let rebuiltOutput = try await encoder.encode(flat)
        let rebuilt = try XCTUnwrap(rebuiltOutput)
        XCTAssertEqual(rebuilt.kind, .keyframe)
        XCTAssertNotNil(rebuilt.description, "a rebuilt session emits a new decoder configuration")
        let drops = await encoder.droppedFrames
        await encoder.stop()
        XCTAssertEqual(drops, 1)
    }
}
