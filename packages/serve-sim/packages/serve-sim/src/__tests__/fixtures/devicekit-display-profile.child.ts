import { afterAll, expect, mock, test } from "bun:test";
import * as fs from "fs";
import * as childProcess from "child_process";
import { tmpdir } from "os";
import { join } from "path";

const installedRoot = "/Library/Developer/CoreSimulator/Profiles/DeviceTypes";
const root = fs.mkdtempSync(join(tmpdir(), "serve-sim-display-profiles-"));
const readdirSync = fs.readdirSync;
const profiles = [
  ["Single", [{ displayType: "integrated" }, { displayType: "tvOut" }], true],
  ["Duo", [{ displayType: "integrated" }, { displayType: "integrated" }], false],
  ["External", [{ displayType: "tvOut" }], false],
  ["Empty", [], false],
  ["Malformed", [{ displayType: "integrated" }, {}], false],
  ["Missing", undefined, false],
] as const;

for (const [name, displays] of profiles) {
  const contents = join(root, `${name}.simdevicetype`, "Contents");
  fs.mkdirSync(join(contents, "Resources"), { recursive: true });
  fs.writeFileSync(
    join(contents, "Info.plist"),
    JSON.stringify({ CFBundleIdentifier: `fixture.${name}`, CFBundleName: name }),
  );
  if (displays !== undefined)
    fs.writeFileSync(
      join(contents, "Resources", "capabilities.plist"),
      JSON.stringify({ capabilities: { displays } }),
    );
}
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

// Redirect the installed profile root and return JSON fixture contents at the
// plutil boundary. Keep the real identifier lookup, parsing, and display count.
mock.module("fs", () => ({
  ...fs,
  readdirSync: (path: string) => readdirSync(path === installedRoot ? root : path),
}));
mock.module("child_process", () => ({
  ...childProcess,
  execFileSync: (file: string, args: string[]) => {
    expect(file).toBe("plutil");
    expect(args.slice(0, 4)).toEqual(["-convert", "json", "-o", "-"]);
    const profilePath = args[4];
    if (!profilePath?.startsWith(`${installedRoot}/`)) throw new Error("Unexpected profile path");
    return fs.readFileSync(join(root, profilePath.slice(installedRoot.length)), "utf8");
  },
}));
const { hasSingleIntegratedDisplay } = await import("../../devicekit-chrome");

for (const [name, , expected] of profiles) {
  test(`${name} profile permits fallback: ${expected}`, () => {
    expect(hasSingleIntegratedDisplay(`fixture.${name}`)).toBe(expected);
  });
}
test("unknown and missing identifiers cannot permit fallback", () => {
  expect(hasSingleIntegratedDisplay("fixture.unknown")).toBe(false);
  expect(hasSingleIntegratedDisplay(undefined)).toBe(false);
});
