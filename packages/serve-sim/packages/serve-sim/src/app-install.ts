import { createReadStream } from "node:fs";
import { mkdtemp, open, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import { pipeline } from "node:stream/promises";
import { Unpack } from "tar";
import { isUnsupportedAppArchive, UNSUPPORTED_INSTALL_FORMAT } from "./app-install-format";
import {
  actionTimeoutMs,
  createSerialQueue,
  installAppInvocation,
  redactHostPaths,
  runInvocation,
  type HostActionResult,
} from "./host-actions-utils";

const MAX_ARCHIVE_BYTES = 2 * 1024 ** 3;
const MAX_ARCHIVE_ENTRIES = 100_000;
const MAX_ARCHIVE_DECOMPRESSION_RATIO = 2048;
// Bound expanded disk use across simultaneous install requests.
const installArchive = createSerialQueue();

async function isArchive(path: string): Promise<boolean> {
  if (isUnsupportedAppArchive(path)) throw new Error(UNSUPPORTED_INSTALL_FORMAT);
  if (/\.(?:tar\.gz|tgz)$/i.test(path)) return true;
  const file = await open(path, "r").catch(() => undefined);
  if (!file) return false; // Preserve simctl's diagnostics for an absent direct path.
  try {
    const magic = Buffer.alloc(2);
    await file.read(magic, 0, 2, 0);
    if (magic[0] === 0x1f && magic[1] === 0x8b) return true;
    throw new Error(UNSUPPORTED_INSTALL_FORMAT);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EISDIR") return false;
    throw error;
  } finally {
    await file.close();
  }
}

function safeArchivePath(path: string): boolean {
  return path.length > 0 && !posix.isAbsolute(path) && !path.split("/").includes("..");
}

async function appsIn(directory: string): Promise<string[]> {
  const apps: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const path = join(directory, entry.name);
    // A containing app may itself contain watch apps; install its outer bundle.
    if (entry.name.endsWith(".app")) apps.push(path);
    else apps.push(...(await appsIn(path)));
  }
  return apps;
}

export async function installAppAsync(
  udid: string,
  path: string,
  deadline = Date.now() + actionTimeoutMs(),
): Promise<HostActionResult> {
  const remaining = (): number => {
    const ms = deadline - Date.now();
    if (ms <= 0) throw new Error("App installation timed out.");
    return ms;
  };
  try {
    remaining();
    if (!(await isArchive(path)))
      return await runInvocation({ ...installAppInvocation(udid, path), timeoutMs: remaining() });
    return await installArchive(async () => {
      remaining();
      const directory = await mkdtemp(join(tmpdir(), "serve-sim-app-install-"));
      try {
        let bytes = 0,
          entries = 0;
        const unpack = new Unpack({
          cwd: directory,
          strict: true,
          // The expanded-byte and entry ceilings remain authoritative for compressible app assets.
          maxDecompressionRatio: MAX_ARCHIVE_DECOMPRESSION_RATIO,
          preservePaths: false,
          chmod: true,
          filter(name, entry) {
            let error: string | undefined;
            if (!safeArchivePath(name)) error = "App archive contains an unsafe path.";
            else if (
              !("type" in entry) ||
              !["File", "Directory", "SymbolicLink", "Link"].includes(entry.type)
            )
              error = "App archive contains an unsupported entry.";
            else {
              bytes += entry.size;
              entries++;
              if (bytes > MAX_ARCHIVE_BYTES || entries > MAX_ARCHIVE_ENTRIES)
                error = "App archive exceeds the expanded size limit.";
              if (entry.type === "SymbolicLink" || entry.type === "Link") {
                const linkpath = entry.linkpath ?? "";
                const target =
                  entry.type === "SymbolicLink"
                    ? posix.join(posix.dirname(name), linkpath)
                    : linkpath;
                if (
                  !linkpath ||
                  posix.isAbsolute(linkpath) ||
                  !safeArchivePath(posix.normalize(target))
                )
                  error = "App archive contains an unsafe link.";
              }
              entry.mode =
                ((entry.mode ?? 0) & 0o777) | (entry.type === "Directory" ? 0o700 : 0o600);
            }
            if (error) {
              unpack.abort(new Error(error));
              return false;
            }
            return true;
          },
        });
        await pipeline(createReadStream(path), unpack, {
          signal: AbortSignal.timeout(remaining()),
        });
        const apps = await appsIn(directory);
        if (apps.length !== 1) throw new Error("App archive must contain exactly one .app bundle.");
        return await runInvocation({
          ...installAppInvocation(udid, apps[0]!),
          timeoutMs: remaining(),
        });
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    });
  } catch (error) {
    return {
      stdout: "",
      stderr: redactHostPaths(error instanceof Error ? error.message : String(error)),
      exitCode: 1,
    };
  }
}
