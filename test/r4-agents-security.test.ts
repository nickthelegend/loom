import { afterEach, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { agentEnvironment, changeEnvironment, saveProfile, profiles, updateSessionSettings } from "../src/core/agents-r4/store.js";
import { EnvironmentStream, EnvironmentLiveThrottle } from "../src/core/agents-r4/redaction.js";
import { makeBackup } from "../src/core/backup.js";
import { normalizeLabels } from "../src/core/agents-r4/chats.js";
import { tmpDir } from "./helpers.js";
afterEach(() => vi.unstubAllEnvs());
it("redacts exact values across every possible stream split and finishes partial prefixes safely", () => {
  vi.stubEnv("LOOM_HOME", tmpDir("r4-redact")); changeEnvironment("p", "a", "PRIVATE", "private-value");
  for (let split = 0; split <= 13; split++) {
    const s = new EnvironmentStream("p", "a");
    const value = "private-value";
    const out = s.push("before " + value.slice(0, split)) + s.push(value.slice(split) + " after") + s.finish();
    expect(out).toBe("before [redacted] after");
  }
  const s = new EnvironmentStream("p", "a"); expect(s.push("priv") + s.finish()).toBe("[redacted]");
  const other = new EnvironmentStream("p", "b"); expect(other.push("private-value") + other.finish()).toBe("private-value");
});
it("keeps provider delta and tool streams private, including separate items", () => {
  vi.stubEnv("LOOM_HOME", tmpDir("r4-delta")); changeEnvironment("p", "a", "PRIVATE", "private-value");
  const frames: unknown[] = [], stream = new EnvironmentLiveThrottle(() => "p", d => frames.push(d), 50, true);
  const delta = { agentId: "a", chat: "main", streamKind: "assistant_text" as const, itemId: "x" };
  stream.push({ ...delta, delta: "private-" }); stream.flush(); expect(frames).toEqual([]);
  stream.push({ ...delta, delta: "value!" }); stream.finish("a", "main"); stream.close();
  expect(JSON.stringify(frames)).not.toContain("private-value"); expect(JSON.stringify(frames)).toContain("[redacted]!");
});
it("never exports environment values in a backup or puts them in a project config", () => {
  vi.stubEnv("LOOM_HOME", tmpDir("r4-backup")); changeEnvironment("p", "a", "KEY", "a-secret-never-exported");
  const out = path.join(tmpDir("r4-archive"), "backup.tar.gz"); makeBackup(out);
  const files = execFileSync("tar", ["-tzf", out], { encoding: "utf8" });
  expect(files).not.toContain("agent-environment");
  expect(agentEnvironment("p", "a")).toEqual({ KEY: "a-secret-never-exported" });
});
it("validates policy/profile/label writes without partially applying invalid fields", () => {
  vi.stubEnv("LOOM_HOME", tmpDir("r4-validation")); const dir = tmpDir("r4-policies");
  expect(() => updateSessionSettings(dir, { maxTurnMinutes: 2, idleSleepMinutes: -1 })).toThrow();
  expect(fs.existsSync(path.join(dir, ".loom", "agents-r4.json"))).toBe(false);
  expect(() => updateSessionSettings(dir, { retries: { count: 1.5, waitSeconds: 1 } })).toThrow();
  expect(() => changeEnvironment("p", "a", "KEY", "bad\0value")).toThrow();
  expect(() => saveProfile("../../bad", { kind: "echo" })).toThrow(); expect(profiles()).toEqual([]);
  expect(normalizeLabels(["bug", "bug", "docs"])).toHaveLength(2);
});
it("keeps send --wait pending through retry events and totals their costs", async () => {
  const { turnOutcome } = await import("../src/core/turn-wait.js");
  const events = [
    { id: 1, ts: 1, agentId: "a", kind: "status" as const, payload: { state: "turn_cost", costUsd: 0.1 } },
    { id: 2, ts: 2, agentId: "a", kind: "error" as const, payload: { message: "429", retrying: true } },
  ];
  expect(turnOutcome(events, "a", 0)).toBeNull();
  expect(turnOutcome([...events, { id: 3, ts: 3, agentId: "a", kind: "status", payload: { state: "turn_cost", costUsd: 0.2 } }, { id: 4, ts: 4, agentId: "a", kind: "run_complete", payload: {} }], "a", 0)).toMatchObject({ status: "ok", costUsd: 0.30000000000000004 });
});
it("detects changes outside Git's tracked set and refuses incomplete snapshots", async () => {
  const { retrySnapshot } = await import("../src/core/agents-r4/snapshot.js");
  const dir = tmpDir("r4-snapshot"); fs.writeFileSync(path.join(dir, "ignored.txt"), "before");
  const before = await retrySnapshot(dir);
  fs.writeFileSync(path.join(dir, "ignored.txt"), "after"); expect(await retrySnapshot(dir)).not.toBe(before);
  expect(await retrySnapshot(path.join(dir, "missing"))).toBeNull();
});
it("discards buffered failure events after the agent is retired", async () => {
  const { RuntimeAgents } = await import("../src/daemon/runtime/agents.js");
  const { runAttempts } = await import("../src/core/agents-r4/attempts.js");
  const { EchoAdapter } = await import("../src/adapters/echo.js");
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  class RetiredEcho extends EchoAdapter {
    override async send() {
      this.emit({ kind: "error", payload: { message: "429 rate limit" } });
      entered.resolve(); await release.promise;
    }
  }
  const dir = tmpDir("r4-retired"), agent = new RetiredEcho("echo", "echo", dir);
  const lifecycle = new RuntimeAgents(), delivered: unknown[] = [];
  lifecycle.install(agent, event => delivered.push(event));
  const running = runAttempts(agent, { text: "try" }, { retries: { count: 1, waitSeconds: 0 } }, {
    dir, budget() {}, current: () => lifecycle.agents.get(agent.id) === agent,
    say: event => delivered.push(event), interrupted: async () => { await agent.interrupt(); return true; }, abandoned() {},
  });
  await entered.promise; await lifecycle.retire(agent.id); release.resolve(); await running; await lifecycle.close();
  expect(delivered).toEqual([]);
});

it("leaves short values and structural metadata intact, caches reads, and invalidates on changes", async () => {
  const { redactEnvironment, clearEnvironment } = await import("../src/core/agents-r4/store.js");
  vi.stubEnv("LOOM_HOME", tmpDir("r4-cache"));
  const secret = "12345678901234567890";
  changeEnvironment("cache", "a", "FLAG", "1");
  changeEnvironment("cache", "a", "SECRET", secret);
  changeEnvironment("cache", "b", "OTHER", "another-long-secret");
  const read = vi.spyOn(fs, "readFileSync");
  try {
    const payload = { text: `1 ${secret} another-long-secret`, nested: { text: secret }, state: secret, requestId: secret,
      kind: secret, tool: secret, reason: secret, adapter: secret, model: secret };
    expect(redactEnvironment(payload, "cache", ["a", "b"])).toEqual({ ...payload, text: "1 [redacted] [redacted]", nested: { text: "[redacted]" } });
    const reads = read.mock.calls.length;
    for (let i = 0; i < 20; i++) redactEnvironment(payload, "cache", ["a", "b"]);
    expect(read.mock.calls.length).toBe(reads);
    changeEnvironment("cache", "a", "SECRET", "replacement-secret");
    expect(redactEnvironment({ text: `${secret} replacement-secret` }, "cache", "a").text).toBe(`${secret} [redacted]`);
    clearEnvironment("cache", "a");
    expect(redactEnvironment({ text: "replacement-secret" }, "cache", "a").text).toBe("replacement-secret");
    changeEnvironment("cache", "a", "FLAG", "1");
    const stream = new EnvironmentStream("cache", "a");
    expect(stream.push("port 3000 flag 1") + stream.finish()).toBe("port 3000 flag 1");
  } finally { read.mockRestore(); }
});
