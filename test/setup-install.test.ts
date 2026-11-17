import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { runSetupCommand, SetupInstaller, setupRequirements, type InstallEvent, type SetupCommandRunner } from "../src/core/setup-install.js";
import { AGENT_INSTALLS } from "../src/core/setup.js";
import { tmpDir, waitUntil } from "./helpers.js";

const node = (source: string) => ({ command: process.execPath, args: ["-e", source] });
afterEach(() => vi.unstubAllEnvs());

it("executes literal arguments without a shell, streams both channels and flushes partial lines", async () => {
  const events: string[] = [];
  const text = "$(exit 9); `exit 8` & literal";
  const result = await runSetupCommand({ command: process.execPath, args: ["-e", 'console.log(process.argv[1]); process.stderr.write("warning\\nlast"); process.stdout.write("tail")', text] }, {
    timeoutMs: 2000, line: (stream, line) => events.push(`${stream}:${line}`),
  });
  expect(result.code).toBe(0);
  expect(result.stdout).toBe(`${text}\ntail`);
  expect(events).toEqual(expect.arrayContaining([`stdout:${text}`, "stdout:tail", "stderr:warning", "stderr:last"]));
});

it("bounds retained output and line size, times out and reports missing executables", async () => {
  const lines: string[] = [];
  const result = await runSetupCommand(node('process.stdout.write("x".repeat(200000))'), { timeoutMs: 2000, line: (_stream, line) => lines.push(line) });
  expect(result.stdout.length).toBe(65536);
  expect(lines.every(line => line.length <= 4096)).toBe(true);
  await expect(runSetupCommand(node("setInterval(() => {}, 1000)"), { timeoutMs: 30 })).rejects.toThrow("timed out");
  await expect(runSetupCommand({ command: path.join(tmpDir("missing-cli"), "missing"), args: [] }, { timeoutMs: 2000 })).rejects.toThrow();
});

it("uses fixed allowlisted argv, excludes prototype keys and redetects after installing", async () => {
  const calls: Array<{ command: string; args: readonly string[] }> = [];
  const runner: SetupCommandRunner = async (spec, opts) => {
    calls.push(spec);
    return runSetupCommand(node(spec.command === "npm" ? 'console.log("installed"); console.error("notice")' : 'console.log("fake 1.2.3")'), opts);
  };
  const installer = new SetupInstaller(runner);
  const events: InstallEvent[] = [];
  // grok-code ships its own native installer: there is no npm package to run
  for (const invalid of ["nope", "constructor", "__proto__", "codex; touch bad", "npm", null, {}, "demo", "model", "grok-code"]) {
    await expect(installer.install(invalid, e => events.push(e))).rejects.toMatchObject({ status: 400 });
  }
  expect(calls).toEqual([]);
  for (const kind of ["codex", "opencode", "claude-code"] as const) {
    expect(await installer.install(kind, e => events.push(e))).toEqual({ ok: true, version: "fake 1.2.3" });
    expect(calls.at(-2)).toEqual(AGENT_INSTALLS[kind]);
    expect(calls.at(-1)).toEqual({ command: AGENT_INSTALLS[kind].bin, args: ["--version"] });
  }
  expect(events.filter(e => e.phase === "finished")).toHaveLength(3);
  expect(events).toContainEqual({ type: "setup:install", kind: "codex", phase: "output", stream: "stderr", line: "notice" });
});

it("locks only the running kind and unlocks after failure, redetection failure and success", async () => {
  let fail = true, detect = false;
  const installer = new SetupInstaller((spec, opts) => runSetupCommand(node(spec.command === "npm"
    ? `console.log("started"); setTimeout(() => { console.error("${fail ? "EACCES" : "ok"}"); process.exit(${fail ? 1 : 0}); }, 200)`
    : `console.log("v1"); process.exit(${detect ? 0 : 1})`), opts));
  const events: InstallEvent[] = [];
  const first = installer.install("codex", e => events.push(e));
  await waitUntil(() => events.some(e => e.phase === "output"));
  await expect(installer.install("codex", () => {})).rejects.toMatchObject({ status: 409 });
  const other = installer.install("opencode", () => {});
  expect(await first).toMatchObject({ ok: false, version: null, error: expect.stringContaining("never runs sudo") });
  expect((await other).ok).toBe(false);
  fail = false;
  expect(await installer.install("codex", () => {})).toMatchObject({ ok: false, error: expect.stringContaining("PATH") });
  detect = true;
  expect(await installer.install("codex", () => {})).toEqual({ ok: true, version: "v1" });
});

it("aborts an active install when the daemon closes", async () => {
  const installer = new SetupInstaller((_spec, opts) => runSetupCommand(node('console.log("ready"); setInterval(() => {}, 1000)'), opts));
  const events: InstallEvent[] = [];
  const pending = installer.install("codex", e => events.push(e));
  await waitUntil(() => events.some(e => e.phase === "output"));
  installer.close();
  expect(await pending).toMatchObject({ ok: false, version: null });
  await expect(installer.install("codex", () => {})).rejects.toMatchObject({ status: 503 });
});

it("checks Node, Git, npm's real prefix permissions, and actual free disk without running npm", async () => {
  const prefix = tmpDir("npm-prefix");
  vi.stubEnv("LOOM_HOME", tmpDir("requirements"));
  const fake: SetupCommandRunner = (spec, opts) => runSetupCommand(node(`console.log(${JSON.stringify(spec.args[0] === "prefix" ? prefix : "1.2.3")})`), opts);
  const report = await setupRequirements(fake);
  expect(report.node).toMatchObject({ ok: true, version: process.versions.node, fix: "" });
  expect(report.git).toMatchObject({ ok: true, fix: "" });
  expect(report.npm).toMatchObject({ ok: true, prefix, needsSudo: false, fix: "" });
  expect(report.disk.freeBytes).toBeGreaterThan(0);
  expect(report.disk.minimumBytes).toBe(512 * 1024 * 1024);
  if (process.platform !== "win32" && process.getuid?.() !== 0) {
    fs.chmodSync(prefix, 0o500);
    try {
      const denied = await setupRequirements(fake);
      expect(denied.npm).toMatchObject({ ok: false, needsSudo: true, fix: expect.stringContaining("user-owned") });
    } finally { fs.chmodSync(prefix, 0o700); }
  }
  const missing = await setupRequirements((_spec, opts) => runSetupCommand(node("process.exit(1)"), opts));
  expect(missing.git).toMatchObject({ ok: false, fix: expect.stringContaining("Install Git") });
  expect(missing.npm).toMatchObject({ ok: false, prefix: null, needsSudo: null });
  expect(missing.disk.freeBytes).toBeGreaterThan(0);
});
