import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readModelRouting, writeModelRouting, resolveModel, promptEstimate, validateAgentOptions, probeModel, modelUsage, modelHealth, savedModelHealth } from "../src/core/model-routing.js";
import { parseAgentSpec } from "../src/core/fleets.js";
import { modelScoreboard, scoreboardCsv, scoreboardDigest } from "../src/core/scoreboard.js";
import { mondayScoreboard } from "../src/core/scoreboard-digest.js";
import { setPriceBook } from "../src/core/prices.js";
import { setProvider } from "../src/core/providers.js";
import { ModelAdapter } from "../src/adapters/model.js";
import { registerProject } from "../src/core/registry.js";
import { EventLog } from "../src/core/eventlog.js";
import type { NewEvent } from "../src/types.js";
import { makeProjectDir, tmpDir } from "./helpers.js";

beforeEach(() => { process.env.LOOM_HOME = tmpDir("r3-models"); process.env.LOOM_NO_NOTIFY = "1"; setPriceBook(null); });
afterEach(() => setPriceBook(undefined));
const settings = { aliases: { fast: "model-a", smart: "model-b", cheap: "fast" }, caps: {}, mondayDigest: false };

describe("r3 routing primitives", () => {
  it("persists aliases and resolves fleet models, rejecting cycles atomically", () => {
    writeModelRouting(settings);
    expect(resolveModel("cheap")).toBe("model-a");
    expect(parseAgentSpec("echo@cheap:highx2")).toMatchObject({ model: "model-a", effort: "high", count: 2 });
    expect(() => writeModelRouting({ ...settings, aliases: { fast: "smart", smart: "fast" } })).toThrow(/cycle/);
    expect(readModelRouting()).toEqual(settings);
    expect(resolveModel("unlisted/model")).toBe("unlisted/model");
  });
  it("validates caps and typed options before saving", () => {
    expect(() => writeModelRouting({ ...settings, caps: { fast: { tokens: -1 } } })).toThrow(/positive/);
    expect(() => writeModelRouting({ ...settings, caps: { fast: { usd: NaN } } })).toThrow(/positive/);
    for (const options of [{ extraArgs: "--flag" }, { extraArgs: [1] }, { env: { A: 1 } }, { maxTokens: 1.5 }, { temperature: 3 }, { fallbacks: [null] }, { extraArgs: ["a\0b"] }])
      expect(() => validateAgentOptions("model", options)).toThrow(/options/);
    expect(() => validateAgentOptions("echo", { fallbacks: ["fast"] })).toThrow(/model agents/);
    expect(() => validateAgentOptions("model", { extraArgs: ["--value", "two words"], fallbacks: ["cheap"], temperature: 0, maxTokens: 1 })).not.toThrow();
  });
  it("estimates selected alias with known context and distinguishes unavailable from free", () => {
    writeModelRouting(settings);
    expect(promptEstimate("fast", "hello").usd).toBeNull();
    setPriceBook({ at: Date.now(), models: { "model-a": { in: 0.001, out: 0.002 } } });
    expect(promptEstimate("cheap", "hello", 100, 10)).toMatchObject({ model: "model-a", inputTokens: 102, outputTokens: 10 });
    expect(promptEstimate("cheap", "hello", 100, 10).usd).toBeCloseTo(0.122);
    setPriceBook({ at: Date.now(), models: { "model-a": { in: 0, out: 0 } } });
    expect(promptEstimate("fast", "hello").usd).toBe(0);
  });
  it("exports quoted CSV with inert formulas and stable columns even when empty", () => {
    const board = modelScoreboard([{ id: "p", agents: [], runs: [], events: [{ id: 1, ts: Date.now(), kind: "run_complete", agentId: "e", payload: { model: '=SUM(1,2)\n"x"', inputTokens: 12, costUsd: 0 } }] }]);
    const csv = scoreboardCsv(board);
    expect(csv).toContain('"\'=SUM(1,2)\n""x"""');
    expect(csv).toContain('"avgCostUsd"');
    expect(scoreboardCsv(modelScoreboard([])).split("\r\n")).toHaveLength(2);
    expect(scoreboardDigest(board)).toContain("1 turns, 1 finished");
  });
  it("reads daily actual usage from all projects with provider qualification and UTC reset", async () => {
    writeModelRouting({ ...settings, caps: { "test/model-a": { tokens: 100, usd: 1 } } });
    const dir = makeProjectDir(); registerProject(dir);
    const log = await EventLog.open(path.join(dir, ".loom"));
    log.append({ kind: "run_complete", agentId: "plannerbot", payload: { model: "model-a", provider: "test", inputTokens: 70, outputTokens: 10, costUsd: 0.8 } });
    log.append({ kind: "status", agentId: "plannerbot", payload: { model: "model-a", provider: "test", state: "turn_cost", costUsd: 0.8 } });
    expect(await modelUsage("test/model-a")).toMatchObject({ tokens: 80, usd: 0.8, warning: true, stopped: false });
    log.append({ kind: "error", agentId: "plannerbot", payload: { model: "model-a", provider: "test", inputTokens: 20, costUsd: 0.2 } });
    expect(await modelUsage("test/model-a")).toMatchObject({ tokens: 100, usd: 1, stopped: true });
    expect(await modelUsage("test/model-a", Date.now() + 86_400_000)).toMatchObject({ tokens: 0, usd: 0, stopped: false });
    log.close();
  });
  it("sends an opted-in Monday digest once across restarts, and never on Tuesday", async () => {
    const notices: string[] = [];
    const monday = Date.parse("2026-11-16T09:00:00Z");
    expect(await mondayScoreboard(monday, n => notices.push(n.body))).toBe(false);
    writeModelRouting({ ...settings, mondayDigest: true });
    expect(await mondayScoreboard(monday, n => notices.push(n.body))).toBe(true);
    expect(await mondayScoreboard(monday + 3_600_000, n => notices.push(n.body))).toBe(false);
    expect(await mondayScoreboard(monday + 86_400_000, n => notices.push(n.body))).toBe(false);
    expect(notices).toHaveLength(1);
    expect(fs.readFileSync(path.join(process.env.LOOM_HOME!, "scoreboard-monday"), "utf8")).toBe("2026-11-16");
  });
});

it("r3 probes real HTTP latency/errors and follows alias fallback only for retryable limits", async () => {
  const calls: string[] = [];
  const server = http.createServer(async (req, res) => {
    let raw = ""; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw); calls.push(body.model);
    if (body.model === "limited") { res.writeHead(429); res.end("rate limit"); return; }
    if (body.model === "bad") { res.writeHead(400); res.end("bad model"); return; }
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ choices: [{ message: { content: "OK" } }], usage: { prompt_tokens: 2, completion_tokens: 1 } }));
  });
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  setProvider("test", { key: "test", baseUrl: `http://127.0.0.1:${port}/v1` });
  writeModelRouting({ aliases: { fast: "test/limited", cheap: "test/ok" }, caps: {}, mondayDigest: false });
  try {
    const ok = await probeModel("cheap"), bad = await probeModel("fast");
    expect(ok).toMatchObject({ model: "test/ok", ok: true, lastError: null });
    expect(ok.latencyMs).toBeGreaterThanOrEqual(0);
    expect(bad.ok).toBe(false); expect(bad.lastError).toBeTruthy();
    expect(await modelUsage("test/ok")).toMatchObject({ tokens: 3 });
    const health = await modelHealth();
    expect(savedModelHealth()).toEqual(health);
    expect(health.find(h => h.model === "test/limited")?.lastError).toBeTruthy();
    calls.length = 0;
    const agent = new ModelAdapter("m", tmpDir("r3-adapter"), { model: "fast", fallbacks: ["cheap"] });
    const events: NewEvent[] = []; agent.onEvent(e => events.push(e));
    await agent.start(); await agent.send({ text: "hello" }); await agent.stop();
    expect(calls).toEqual(["limited", "ok"]);
    expect(events.find(e => e.payload.state === "model_fallback")?.payload.to).toBe("test/ok");
    expect(events.find(e => e.kind === "run_complete")?.payload).toMatchObject({ model: "ok", provider: "test" });
    calls.length = 0;
    const invalid = new ModelAdapter("m2", tmpDir("r3-adapter"), { provider: "test", model: "bad", fallbacks: ["cheap"] });
    await invalid.send({ text: "hello" }); await invalid.stop();
    expect(calls).toEqual(["bad"]);
  } finally { await new Promise<void>(r => server.close(() => r())); }
});
