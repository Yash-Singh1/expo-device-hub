import { afterAll, afterEach, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { UDID, installShims, useTempStateDir } from "../helpers";
import * as native from "../../native";
import * as ui from "../../ui-settings";
import type { StreamEncoderSettings } from "../../stream-settings";

let active: number | Error = 1;
let sequence: Array<number | Error> = [];
let startupError: Error | undefined;
const captures: Array<{ udid: string; settings: StreamEncoderSettings }> = [];
class Capture {
  constructor(udid: string, settings: StreamEncoderSettings) { captures.push({ udid, settings }); }
  async start() { if (startupError) throw startupError; }
  async stop() {}
  async subscribeScreenChanges() { return async () => {}; }
  async subscribeDeviceState() { return async () => {}; }
  async screenSize() { return { width: 2007, height: 2853, screenId: 3, orientation: "portrait" }; }
  async activeScreenId() { const value = sequence.shift() ?? active; if (value instanceof Error) throw value; return value; }
}
mock.module("../../native", () => ({ ...native, NativeCapture: Capture, NativeHid: class {
  async setScreen() {}
  async supportsHingeAngle() { return false; }
  async supportsPhysicalOrientation() { return false; }
} }));
mock.module("../../ui-settings", () => ({ ...ui, refreshDeviceOptionState: async () => {} }));
const temp = useTempStateDir();
const { simMiddleware } = await import("../../middleware");
const { closeDeviceSession } = await import("../../device-session");
const { runHostActionAsync } = await import("../../host-actions");
const shims = installShims({
  xcrun: "#!/bin/sh\nfor last; do :; done\nprintf '%s\\n' \"$*\" >> \"$SERVE_SIM_HTTP_SHOTS\"\nprintf '\\211PNG\\r\\n\\032\\n%s' \"$*\" > \"$last\"\n",
  cp: "#!/bin/sh\nexit 0\n",
});
process.env.SERVE_SIM_HTTP_SHOTS = join(shims.dir, "shots");
const settings = { transport: "webrtc" as const, codec: "vp8" as const, h264Bitrate: 2_300_000, h264Fps: 24, maxDimension: 720 };
const middleware = simMiddleware({ basePath: "/preview", streamSettings: settings, corsOrigins: ["https://expo.dev"] });
async function shot(extra = "") {
  return (await middleware(new Request(`http://localhost/preview/api/screenshot?device=${UDID.toLowerCase()}${extra}`, { method: "POST", headers: { origin: "https://expo.dev" } })))!;
}
afterEach(() => { closeDeviceSession(UDID); active = 1; sequence = []; startupError = undefined; captures.length = 0; });
afterAll(() => { shims.restore(); temp.restore(); delete process.env.SERVE_SIM_HTTP_SHOTS; });

test("HTTP screenshots select the active cover or inner panel with trusted startup settings", async () => {
  for (const id of [1, 3, 1]) {
    active = id;
    const res = await shot(); expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("access-control-allow-origin")).toBe("https://expo.dev");
    expect(await res.text()).toContain(`--display=${id}`);
  }
  expect(captures).toHaveLength(1); expect(captures[0]?.udid).toBe(UDID);
  expect(captures[0]?.settings).toMatchObject({ h264Bitrate: 2_300_000, h264Fps: 24, maxDimension: 720 });
});
test("HTTP recaptures a panel switch and bounds an unstable fold", async () => {
  sequence = [1, 3, 3]; const stable = await shot(); expect(stable.status).toBe(200); expect(await stable.text()).toContain("--display=3");
  sequence = [1, 3, 1, 3]; const unstable = await shot(); expect(unstable.status).toBe(500); expect(await unstable.text()).toContain("kept changing");
});
test("HTTP explicit display avoids native startup and rejects invalid IDs", async () => {
  startupError = new Error("Must not start capture");
  const explicit = await shot("&display=3"); expect(explicit.status).toBe(200); expect(await explicit.text()).toContain("--display=3"); expect(captures).toHaveLength(0);
  for (const display of ["0", "-1", "1.5", "wrong", "4294967296"]) expect((await shot(`&display=${display}`)).status).toBe(400);
});
test("HTTP and host action surface real session startup failure before simctl", async () => {
  startupError = new Error("Native capture startup failed");
  const before = readFileSync(process.env.SERVE_SIM_HTTP_SHOTS!, "utf8");
  expect((await shot()).status).toBe(500);
  const result = await runHostActionAsync({action:"screenshot.capture",params:{udid:UDID}}, "true", settings);
  expect(result).toMatchObject({exitCode:1,stderr:"Native capture startup failed"});
  expect(readFileSync(process.env.SERVE_SIM_HTTP_SHOTS!, "utf8")).toBe(before);
});
test("HTTP fails explicitly when the native active display is unknown", async () => {
  active = new Error("Simulator did not report its active display");
  expect((await shot()).status).toBe(500);
});
