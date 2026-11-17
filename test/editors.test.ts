import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { detectEditors, editorArgs, editorPath, parseEditorTarget } from "../src/core/editors.js";
import { tmpDir } from "./helpers.js";

function executable(file: string) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
}

describe("editor detection", () => {
  it("finds executable PATH entries with stable ids and rejects non-executable files", () => {
    const dir = tmpDir("editor-path");
    for (const name of ["code", "cursor", "zed", "windsurf", "idea", "webstorm", "pycharm", "subl"]) executable(path.join(dir, name));
    if (process.platform !== "win32") fs.writeFileSync(path.join(dir, "goland"), "not executable", { mode: 0o644 });
    const result = detectEditors({ env: { PATH: dir }, platform: "darwin", appDirs: [] });
    expect(result.map(e => e.id)).toEqual(["code", "cursor", "zed", "windsurf", "idea", "webstorm", "pycharm", "subl"]);
    expect(result.every(e => e.executable.startsWith(dir))).toBe(true);
  });

  it("finds standard macOS app launchers without PATH setup", () => {
    const apps = tmpDir("apps");
    executable(path.join(apps, "Visual Studio Code.app/Contents/Resources/app/bin/code"));
    executable(path.join(apps, "Zed.app/Contents/MacOS/cli"));
    expect(detectEditors({ env: { PATH: "" }, platform: "darwin", appDirs: [apps] }).map(e => e.id)).toEqual(["code", "zed"]);
  });
});

it("rejects traversal, sibling-prefix tricks and existing/new symlink escapes", () => {
  const project = tmpDir("editor-project");
  const outside = tmpDir("editor-outside");
  fs.writeFileSync(path.join(outside, "secret"), "private");
  fs.symlinkSync(outside, path.join(project, "escape"), "dir");
  fs.symlinkSync(path.join(outside, "absent"), path.join(project, "dangling"));
  for (const file of ["../secret", "sub/../../secret", outside, `${project}-other/file`, "escape/secret", "escape/new-file", "dangling/new", "bad\0file"]) {
    expect(() => editorPath(project, file), file).toThrow();
  }
  fs.mkdirSync(path.join(project, "src"));
  fs.symlinkSync(path.join(project, "src"), path.join(project, "safe"), "dir");
  expect(editorPath(project, "safe/new.ts")).toBe(path.join(fs.realpathSync(project), "src/new.ts"));
  expect(editorPath(project)).toBe(fs.realpathSync(project));
});

it("uses editor-specific argv and parses file:line without splitting Windows drive letters", () => {
  const file = "/project/a space;$(touch nope).ts";
  expect(editorArgs("code", file, 12)).toEqual(["--goto", `${file}:12`]);
  expect(editorArgs("zed", file, 12)).toEqual([`${file}:12`]);
  expect(editorArgs("idea", file, 12)).toEqual(["--line", "12", file]);
  expect(editorArgs("xcode", file)).toEqual([file]);
  expect(parseEditorTarget("C:\\src\\file.ts:12")).toEqual({ path: "C:\\src\\file.ts", line: 12 });
  expect(parseEditorTarget("C:\\src\\file.ts")).toEqual({ path: "C:\\src\\file.ts" });
  for (const line of [0, -1, 1.5, NaN, Infinity]) expect(() => editorArgs("code", file, line)).toThrow();
});
