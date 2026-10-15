import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { commandInvocation, execFile, execFileSync, findExecutable, spawn, fileCommand } from "../src/core/process.js";
import { probeHarness } from "../src/core/continuity/capabilities.js";
import { tmpDir } from "./helpers.js";

describe("portable CLI launches", () => {
  it("runs a configured shell command with a file containing spaces and shell characters", async () => {
    const file = path.join(tmpDir("file-command"), "a & b.txt");
    fs.writeFileSync(file, "expected content");
    const launch = fileCommand(`node -e "console.log(require('fs').readFileSync(process.argv[1],'utf8'))" {file}`, file);
    const { stdout } = await promisify(execFile)(launch.command, launch.args, { env: launch.env, windowsVerbatimArguments: launch.windowsVerbatimArguments });
    expect(stdout.trim()).toBe("expected content");
  });
  it("preserves literal arguments through spawn, execFile and its promise form", async () => {
    const dir = path.join(tmpDir("process"), "path with spaces");
    fs.mkdirSync(dir);
    const script = path.join(dir, "agent");
    fs.writeFileSync(script, '#!/usr/bin/env node\nconsole.log(JSON.stringify(process.argv.slice(2)));\n', { mode: 0o755 });
    const args = ['a "quoted" prompt', "& echo must-not-run", "%PATH%", "line one\nline two", "$(whoami)", "a>b", ""];
    const result = await promisify(execFile)(script, args);
    expect(JSON.parse(result.stdout)).toEqual(args);
    expect(JSON.parse(execFileSync(script, args, { encoding: "utf8" }))).toEqual(args);
    const child = spawn(script, args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", data => { out += data; });
    await new Promise<void>((resolve, reject) => { child.on("error", reject); child.on("close", code => code === 0 ? resolve() : reject(new Error(`exit ${code}`))); });
    expect(JSON.parse(out)).toEqual(args);
  });

  it.skipIf(process.platform !== "win32")("resolves npm cmd shims and PATHEXT in a PATH with spaces", async () => {
    const dir = path.join(tmpDir("npm-shim"), "bin with spaces");
    fs.mkdirSync(path.join(dir, "node_modules", "agent"), { recursive: true });
    const entry = path.join(dir, "node_modules", "agent", "cli.js");
    fs.writeFileSync(entry, 'console.log(JSON.stringify(process.argv.slice(2)));');
    fs.writeFileSync(path.join(dir, "agent"), '#!/bin/sh\n');
    fs.writeFileSync(path.join(dir, "agent.cmd"), '@echo off\n"node.exe" "%dp0%\\node_modules\\agent\\cli.js" %*\n');
    const env = { ...process.env, PATH: dir };
    expect(findExecutable("agent", env)).toBe(path.join(dir, "agent"));
    expect(commandInvocation("agent", ["a&b"], { env })).toEqual({ command: process.execPath, args: [entry, "a&b"] });
    const { stdout } = await promisify(execFile)("agent", ['"quoted" & %PATH%'], { env });
    expect(JSON.parse(stdout)).toEqual(['"quoted" & %PATH%']);
    fs.mkdirSync(path.join(dir, "node_modules", "native"));
    const native = path.join(dir, "node_modules", "native", "native.exe");
    fs.writeFileSync(native, "fixture");
    fs.writeFileSync(path.join(dir, "native-agent.cmd"), '@echo off\n"%dp0%\\node_modules\\native\\native.exe"   %*\n');
    expect(commandInvocation("native-agent", ["a&b", '"quoted"'], { env })).toEqual({ command: native, args: ["a&b", '"quoted"'] });
    fs.writeFileSync(path.join(dir, "tool.exe"), "");
    expect(findExecutable("tool", env)).toBe(path.join(dir, "tool.exe"));
  });

  it.skipIf(process.platform !== "win32")("allows native continuity after verifying Job Object containment", async () => {
    const bin = path.join(tmpDir("native-probe"), "codex");
    fs.writeFileSync(bin, '#!/usr/bin/env node\nconsole.log("codex-cli 9.9.9");');
    expect(await probeHarness("codex", { bin })).toMatchObject({ available: true, version: "9.9.9" });
  });
});
