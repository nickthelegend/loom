import fs from "node:fs";
import path from "node:path";
import { spawn as rawSpawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import { spawnContained } from "../src/core/process.js";
import { hasWindowsJob, quiesceWindowsJob, windowsJobReady } from "../src/core/windows-jobs.js";
import { launched, spawnHarness, stopHarness } from "../src/providers/process.js";
import { tmpDir, waitUntil } from "./helpers.js";

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const descendant = (file: string) => `const fs=require('fs');fs.writeFileSync(${JSON.stringify(file)},String(process.pid));setInterval(()=>{},1000);`;

describe.skipIf(process.platform !== "win32")("Windows Job Object containment", () => {
  it("preserves literal argv, cwd, environment and all three protocol streams", async () => {
    const dir = tmpDir("job-argv");
    const args = ['a "quoted" prompt', "& echo nope", "%PATH%", "line one\nline two", "", "trailing\\"];
    const proc = spawnHarness(process.execPath, ["-e", "process.stdin.once('data',d=>{console.error('stderr');console.log(JSON.stringify([process.argv.slice(1),process.cwd(),process.env.LOOM_JOB_TEST,d.toString()]));});", ...args], { cwd: dir, env: { ...process.env, LOOM_JOB_TEST: "value & literal" } });
    let out = ""; proc.child.stdout!.on("data", d => out += d);
    await launched(proc.child);
    expect(hasWindowsJob(proc.child)).toBe(true);
    proc.child.stdin!.end("stdin protocol");
    expect((await proc.closed).code).toBe(0);
    await stopHarness(proc);
    expect(JSON.parse(out)).toEqual([args, dir, "value & literal", "stdin protocol"]);
    expect(proc.stderr()).toContain("stderr");
  });

  it.each([false, true])("kills inherited and detached descendants on explicit stop (detached: %s)", async detached => {
    const file = path.join(tmpDir("job-tool"), "tool.pid");
    const script = `require('child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant(file))}],{detached:${detached},windowsHide:true,stdio:'ignore'}).unref();setInterval(()=>{},1000);`;
    const proc = spawnHarness(process.execPath, ["-e", script], { cwd: process.cwd() });
    try {
      await launched(proc.child);
      await waitUntil(() => fs.existsSync(file));
      const pid = Number(fs.readFileSync(file, "utf8"));
      expect(alive(pid)).toBe(true);
      await Promise.all([stopHarness(proc, 0), stopHarness(proc, 0)]);
      expect(alive(pid)).toBe(false);
      await quiesceWindowsJob(proc.child); // idempotent after handles are closed
    } finally { await stopHarness(proc, 0); }
  });

  it("runs user Node preload hooks only after containment, in the target", async () => {
    const dir = tmpDir("job-preload"), marker = path.join(dir, "preloads"), preload = path.join(dir, "hook.cjs");
    fs.writeFileSync(preload, `require('fs').appendFileSync(${JSON.stringify(marker)},process.pid+'\\n')`);
    const proc = spawnHarness(process.execPath, ["-e", "console.log(process.pid)"], { cwd: dir,
      env: { ...process.env, NODE_OPTIONS: `--require "${preload.replaceAll("\\", "/")}"` } });
    let out = ""; proc.child.stdout!.on("data", d => out += d);
    await launched(proc.child); const result = await proc.closed; await stopHarness(proc);
    expect(result.code, proc.stderr()).toBe(0);
    expect(fs.readFileSync(marker, "utf8").trim()).toBe(out.trim());
    expect(Number(out)).not.toBe(proc.child.pid);
  });

  it("kills tools holding inherited output pipes when the harness exits naturally", async () => {
    const file = path.join(tmpDir("job-parent-exit"), "tool.pid");
    const script = `require('child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant(file))}],{stdio:['ignore','inherit','inherit']}).unref();setTimeout(()=>process.exit(7),500);`;
    const proc = spawnHarness(process.execPath, ["-e", script], { cwd: process.cwd() });
    await launched(proc.child);
    await waitUntil(() => fs.existsSync(file));
    const pid = Number(fs.readFileSync(file, "utf8"));
    expect((await proc.closed).code).toBe(7);
    await stopHarness(proc);
    expect(alive(pid)).toBe(false);
  });

  it("cancels before bootstrap admission without launching the target", async () => {
    const file = path.join(tmpDir("job-cancel"), "must-not-exist");
    const proc = spawnHarness(process.execPath, ["-e", `require('fs').writeFileSync(${JSON.stringify(file)},'launched')`], { cwd: process.cwd() });
    const ready = launched(proc.child);
    await stopHarness(proc, 0);
    await expect(ready).rejects.toThrow(/bootstrap|launch/);
    expect(fs.existsSync(file)).toBe(false);
  });

  it("fails closed for a process without an owned job", async () => {
    const child = rawSpawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { windowsHide: true });
    const closed = new Promise(resolve => child.once("close", resolve));
    try { await expect(quiesceWindowsJob(child)).rejects.toMatchObject({ name: "NativeQuiescenceUnknown" }); }
    finally { child.kill(); await closed; }
  });

  it("kills tools when the daemon owning the last job handle crashes", async () => {
    const file = path.join(tmpDir("job-crash"), "tool.pid");
    const module = new URL("../dist/core/process.js", import.meta.url).href;
    const script = `import {spawnContained} from ${JSON.stringify(module)};spawnContained(process.execPath,['-e',${JSON.stringify(descendant(file))}],{stdio:'ignore'});setInterval(()=>{},1000);`;
    const host = rawSpawn(process.execPath, ["--input-type=module", "-e", script], { windowsHide: true, stdio: "pipe" });
    let stderr = ""; host.stderr.on("data", d => stderr += d);
    const closed = new Promise(resolve => host.once("close", resolve));
    try {
      await waitUntil(() => fs.existsSync(file), { timeoutMs: 15_000 });
      const pid = Number(fs.readFileSync(file, "utf8"));
      expect(alive(pid), stderr).toBe(true);
      host.kill("SIGKILL"); await closed;
      await waitUntil(() => !alive(pid));
      await sleep(100);
      expect(alive(pid)).toBe(false);
    } finally { if (host.exitCode === null && host.signalCode === null) { host.kill(); await closed; } }
  });

  it("supports nested owned jobs as on hosted Windows runners", async () => {
    const module = new URL("../dist/core/process.js", import.meta.url).href;
    const script = `import {spawnContained} from ${JSON.stringify(module)};const p=spawnContained(process.execPath,['-e','console.log("nested")'],{stdio:'pipe'});p.stdout.pipe(process.stdout);p.stderr.pipe(process.stderr);p.once('close',code=>process.exit(code));`;
    const child = spawnContained(process.execPath, ["--input-type=module", "-e", script], { stdio: "pipe" });
    let out = ""; child.stdout!.on("data", d => out += d);
    const closed = new Promise<number | null>(resolve => child.once("close", resolve));
    await windowsJobReady(child);
    expect(await closed).toBe(0);
    await quiesceWindowsJob(child);
    expect(out.trim()).toBe("nested");
  });
});
