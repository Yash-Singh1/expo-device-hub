import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { create, Header } from "tar";
import { runHostActionAsync } from "../host-actions";
import { UPLOAD_DIR } from "../host-paths";
import { UDID, installShims, withActionTimeoutAsync } from "./helpers";
let root: string;
let shims: ReturnType<typeof installShims>;
beforeAll(async () => {
  await mkdir(UPLOAD_DIR, { recursive: true });
  root = await mkdtemp(join(UPLOAD_DIR, "install-test-"));
  shims = installShims({
    xcrun:
      '#!/bin/sh\n[ -z "$SERVE_SIM_INSTALL_STARTED" ] || touch "$SERVE_SIM_INSTALL_STARTED"\nprintf "%s\\n" "$3"\n[ -z "$SERVE_SIM_INSTALL_SLEEP" ] || sleep "$SERVE_SIM_INSTALL_SLEEP"\ncat "$4/Info.plist"\nprintf "\\n%s\\n" "$4"\n[ -x "$4/App" ] || exit 9\nexit "${SERVE_SIM_INSTALL_EXIT:-0}"\n',
  });
});
afterAll(async () => {
  shims.restore();
  await rm(root, { recursive: true, force: true });
  delete process.env.SERVE_SIM_INSTALL_EXIT;
});
async function app(name = "My App.app") {
  const path = join(root, name);
  await mkdir(path, { recursive: true });
  await writeFile(join(path, "Info.plist"), "test app");
  await writeFile(join(path, "App"), "executable");
  await chmod(join(path, "App"), 0o755);
  return path;
}
async function install(path: string) {
  return runHostActionAsync({ action: "app.install", params: { udid: UDID, path } }, "unused");
}
async function archive(name: string, paths: string[]) {
  const file = join(root, name);
  await create({ cwd: root, file, gzip: true }, paths);
  return file;
}
function installedPath(stdout: string) {
  return stdout.trim().split("\n").at(-1)!;
}
test("installs a direct app bundle", async () => {
  const bundle = await app();
  const result = await install(bundle);
  expect(result.exitCode).toBe(0);
  expect(installedPath(result.stdout)).toBe(bundle);
});
test.each(["Device.ipa", "Device.IPA", "Build.zip", "uploaded-without-extension"])(
  "rejects unsupported install files before invoking simctl: %s",
  async (name) => {
    const file = join(root, name);
    await writeFile(file, Buffer.from([0x50, 0x4b, 0x03, 0x04]));
    const started = join(root, `unsupported-${name}-started`);
    process.env.SERVE_SIM_INSTALL_STARTED = started;
    try {
      expect(await install(file)).toMatchObject({
        exitCode: 1,
        stderr: expect.stringContaining(
          "Simulator installs require a Simulator .app bundle or .tar.gz/.tgz archive.",
        ),
      });
      expect(existsSync(started)).toBe(false);
    } finally {
      delete process.env.SERVE_SIM_INSTALL_STARTED;
    }
  },
);
test("rejects an extensionless staged ZIP upload before invoking simctl", async () => {
  const uploadId = "unsupported-staged-archive";
  const started = join(root, "unsupported-staged-started");
  await runHostActionAsync(
    {
      action: "upload.append",
      params: {
        uploadId,
        first: true,
        data: Buffer.from([0x50, 0x4b, 0x03, 0x04]).toString("base64"),
      },
    },
    "unused",
  );
  process.env.SERVE_SIM_INSTALL_STARTED = started;
  try {
    expect(
      await runHostActionAsync(
        { action: "app.install", params: { udid: UDID, uploadId } },
        "unused",
      ),
    ).toMatchObject({ exitCode: 1, stderr: expect.stringContaining("Simulator installs require") });
    expect(existsSync(started)).toBe(false);
  } finally {
    delete process.env.SERVE_SIM_INSTALL_STARTED;
    await runHostActionAsync({ action: "upload.remove", params: { uploadId } }, "unused");
  }
});
test("installs tar.gz and extensionless uploaded archives, preserving executable bits and cleaning extraction", async () => {
  await app();
  for (const name of ["build.tar.gz", "build.tgz", "uploaded-file"]) {
    const result = await install(await archive(name, ["My App.app"]));
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("test app");
    expect(existsSync(installedPath(result.stdout))).toBe(false);
  }
});
test("cleans extraction when simctl install fails", async () => {
  process.env.SERVE_SIM_INSTALL_EXIT = "7";
  try {
    const result = await install(await archive("failure.tgz", ["My App.app"]));
    expect(result.exitCode).toBe(7);
    expect(existsSync(installedPath(result.stdout))).toBe(false);
  } finally {
    delete process.env.SERVE_SIM_INSTALL_EXIT;
  }
});
test("finds a single app under wrapper folders but does not count nested watch apps", async () => {
  await app("Payload/Main.app");
  await app("Payload/Main.app/Watch/Watch.app");
  expect((await install(await archive("wrapper.tgz", ["Payload"]))).exitCode).toBe(0);
});
test("rejects archives with zero or multiple app bundles", async () => {
  await writeFile(join(root, "readme"), "no app");
  expect(await install(await archive("empty.tgz", ["readme"]))).toMatchObject({
    exitCode: 1,
    stderr: expect.stringContaining("exactly one .app"),
  });
  await app("Second.app");
  expect(await install(await archive("multiple.tgz", ["My App.app", "Second.app"]))).toMatchObject({
    exitCode: 1,
    stderr: expect.stringContaining("exactly one .app"),
  });
});
async function headerArchive(
  name: string,
  path: string,
  size = 0,
  type: "File" | "SymbolicLink" = "File",
  linkpath?: string,
) {
  const h = new Header({ path, size, type, mode: 0o644, linkpath });
  h.encode();
  const file = join(root, name);
  await writeFile(file, gzipSync(Buffer.concat([Buffer.from(h.block!), Buffer.alloc(1024)])));
  return file;
}
test("rejects traversal, absolute paths, and oversized archive entries before installing", async () => {
  for (const path of ["../escape.app/Info.plist", "/escape.app/Info.plist"]) {
    expect(await install(await headerArchive("bad-path.tgz", path))).toMatchObject({
      exitCode: 1,
      stderr: expect.stringContaining("unsafe"),
    });
  }
  expect(
    await install(await headerArchive("oversized.tgz", "Huge.app/data", 2 * 1024 ** 3 + 1)),
  ).toMatchObject({
    exitCode: 1,
    stderr: expect.stringContaining("size limit"),
  });
});
test("rejects links escaping extraction and supports internal bundle links", async () => {
  expect(
    await install(
      await headerArchive("bad-link.tgz", "My.app/link", 0, "SymbolicLink", "../../outside"),
    ),
  ).toMatchObject({ exitCode: 1, stderr: expect.stringContaining("unsafe") });
  await symlink("App", join(root, "My App.app", "Internal"));
  expect((await install(await archive("internal-link.tgz", ["My App.app"]))).exitCode).toBe(0);
});
test("reports a malformed gzip archive without running install", async () => {
  const file = join(root, "corrupt.tgz");
  await writeFile(file, Buffer.from([0x1f, 0x8b, 1, 2, 3]));
  expect((await install(file)).exitCode).toBe(1);
});

test("queued archive installs share one action deadline and do not install after expiry", async () => {
  const file = await archive("deadline.tgz", ["My App.app"]);
  process.env.SERVE_SIM_INSTALL_SLEEP = "0.2";
  try {
    await withActionTimeoutAsync(30, async () => {
      const [first, second] = await Promise.all([install(file), install(file)]);
      expect(first.exitCode).not.toBe(0);
      expect(second).toMatchObject({ exitCode: 1, stderr: expect.stringContaining("timed out") });
    });
  } finally {
    delete process.env.SERVE_SIM_INSTALL_SLEEP;
  }
});

test("removes partially extracted files after an unsafe later entry", async () => {
  const { tmpdir } = await import("node:os");
  const before = await readdir(tmpdir());
  const chunks: Buffer[] = [];
  for (let n = 0; n < 100; n++) {
    const h = new Header({ path: `Partial.app/file-${n}`, type: "File", size: 1, mode: 0o644 });
    h.encode();
    chunks.push(Buffer.from(h.block!), Buffer.concat([Buffer.from("x"), Buffer.alloc(511)]));
  }
  const bad = new Header({ path: "../escape", type: "File", size: 0, mode: 0o644 });
  bad.encode();
  chunks.push(Buffer.from(bad.block!), Buffer.alloc(1024));
  const file = join(root, "partial.tgz");
  await writeFile(file, gzipSync(Buffer.concat(chunks)));
  expect((await install(file)).exitCode).toBe(1);
  await Bun.sleep(50);
  expect(
    (await readdir(tmpdir())).filter(
      (name) => name.startsWith("serve-sim-app-install-") && !before.includes(name),
    ),
  ).toEqual([]);
});

test("keeps extracted entries owner-accessible for install and cleanup", async () => {
  const blocks: Buffer[] = [];
  for (const entry of [
    { path: "Locked.app/", type: "Directory" as const, mode: 0, body: "" },
    { path: "Locked.app/Info.plist", type: "File" as const, mode: 0, body: "test app" },
    { path: "Locked.app/App", type: "File" as const, mode: 0o111, body: "executable" },
  ]) {
    const body = Buffer.from(entry.body),
      h = new Header({ path: entry.path, type: entry.type, mode: entry.mode, size: body.length });
    h.encode();
    blocks.push(Buffer.from(h.block!), body, Buffer.alloc((512 - (body.length % 512)) % 512));
  }
  const file = join(root, "permissions.tgz");
  await writeFile(file, gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)])));
  const result = await install(file);
  expect(result.exitCode).toBe(0);
  expect(existsSync(installedPath(result.stdout))).toBe(false);
});

test("installs a highly compressible app below the expanded size limit", async () => {
  await app("Compressible.app");
  await writeFile(join(root, "Compressible.app", "zeros"), Buffer.alloc(20 * 1024 ** 2));
  const result = await install(await archive("compressible.tgz", ["Compressible.app"]));
  expect(result.exitCode, result.stderr).toBe(0);
});

test.each(["../../outside", "../../../etc/passwd", "folder/../../../../outside", "/etc/passwd"])(
  "rejects an escaping symlink target %s",
  async (target) => {
    expect(
      await install(
        await headerArchive("escaping-link.tgz", "My.app/link", 0, "SymbolicLink", target),
      ),
    ).toMatchObject({ exitCode: 1, stderr: expect.stringContaining("unsafe") });
  },
);

test.each(["uploadId", "path"])(
  "staged %s installs exclude removal while waiting for extraction",
  async (source) => {
    const uploadId = `install-reader-${source}`;
    const bytes = await readFile(await archive(`queued-${source}.tgz`, ["My App.app"]));
    await runHostActionAsync(
      {
        action: "upload.append",
        params: { uploadId, first: true, data: bytes.toString("base64") },
      },
      "unused",
    );
    process.env.SERVE_SIM_INSTALL_SLEEP = "0.1";
    try {
      const first = install(await archive(`ahead-${source}.tgz`, ["My App.app"]));
      await Bun.sleep(30);
      const pending = runHostActionAsync(
        {
          action: "app.install",
          params: {
            udid: UDID,
            [source]: source === "path" ? join(UPLOAD_DIR, uploadId) : uploadId,
          },
        },
        "unused",
      );
      const removed = runHostActionAsync(
        { action: "upload.remove", params: { uploadId } },
        "unused",
      );
      const results = await Promise.all([first, pending, removed]);
      expect(
        results.map((result) => result.exitCode),
        results[1]?.stderr,
      ).toEqual([0, 0, 0]);
      expect(existsSync(join(UPLOAD_DIR, uploadId))).toBe(false);
    } finally {
      delete process.env.SERVE_SIM_INSTALL_SLEEP;
    }
  },
);
