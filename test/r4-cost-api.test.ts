import * as system from "../src/daemon/system.js";
import { turnOutcome } from "../src/core/turn-wait.js";
import { canUseSaver } from "../src/core/cost-r4/turns.js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { LoomDaemon } from "../src/daemon/server.js";
import { DaemonClient } from "../src/daemon/client.js";
import { readDaemonConfig } from "../src/core/registry.js";
import { makeProjectDir, tmpDir, waitUntil } from "./helpers.js";
import { writeBridges } from "../src/daemon/chat-bridge.js";
import { budgetNotices } from "../src/core/cost-r4/budgets.js";
import { deliverSpendAlert } from "../src/core/cost-r4/alerts.js";
import { setPriceBook } from "../src/core/prices.js";
let daemon: LoomDaemon, client: DaemonClient, base: string, token: string;
async function request(route: string, method = "GET", body?: unknown, auth = token) {
  return fetch(base + route, { method, headers: { authorization: `Bearer ${auth}`, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
async function json(route: string, method = "GET", body?: unknown, auth = token): Promise<any> {
  const r = await request(route, method, body, auth), j = await r.json(); if (!r.ok) throw new Error(JSON.stringify(j)); return j;
}
async function project() {
  const dir = makeProjectDir({ agents: [{ id: "echo", kind: "echo", role: "general" }] });
  const p = (await client.addProject(dir)).project; return { dir, id: p.id, root: `/api/projects/${p.id}`, rt: await daemon.runtime(p.id) };
}
async function send(id: string, opts = {}) {
  const rt = await daemon.runtime(id), n = rt.log.list({ kinds: ["run_complete"] }).length;
  await client.send(id, "hello", "echo", opts);
  await waitUntil(() => rt.log.list({ kinds: ["run_complete"] }).length > n);
  await waitUntil(async () => !(await rt.status()).agents.some(a => a.busy));
}
beforeAll(async () => {
  process.env.LOOM_HOME = tmpDir("r4-api"); process.env.LOOM_NO_NOTIFY = "1"; process.env.LOOM_NO_PRICE_FETCH = "1";
  daemon = new LoomDaemon({ host: "127.0.0.1", port: 0 }); const addr = await daemon.listen(); base = `http://${addr.host}:${addr.port}`;
  token = readDaemonConfig()!.adminToken; client = new DaemonClient(readDaemonConfig()!);
});
afterAll(async () => { await daemon.close(); setPriceBook(undefined); });

describe("r4 cost routes and real dispatch", () => {
  it("prices unknown turns immediately in usage, exports and metrics; validates writes and removal", async () => {
    const p = await project();
    p.rt.log.append({ kind: "run_complete", agentId: "echo", payload: { model: "private", inputTokens: 1e6, outputTokens: 1e6 } });
    expect((await json(p.root + "/costs/whatif?model=private")).estimatedUsd).toBeNull();
    await json("/api/prices", "PUT", { overrides: { private: { in: 1, out: 3, cacheRead: 0.1 } } });
    expect((await json(p.root + "/costs/export?by=model")).totals).toMatchObject({ usd: 0, estUsd: 4 });
    expect((await json(p.root + "/usage")).usage.totals.estUsd).toBe(4);
    expect((await json(p.root + "/costs/whatif?model=private")).estimatedUsd).toBe(4);
    expect((await request("/api/prices", "PUT", { private: { in: -1, out: 2 } })).status).toBe(400);
    expect((await request(p.root + "/costs/export?since=bad")).status).toBe(400);
    expect((await request(p.root + "/costs/settings", "PUT", { monthlyUsd: -1 })).status).toBe(400);
    await json("/api/prices", "PUT", { overrides: {} });
    expect((await json(p.root + "/costs/whatif?model=private")).estimatedUsd).toBeNull();
  });
  it("pauses a capped chat before recording a prompt, leaves other chats usable, and resumes after Raise", async () => {
    const p = await project();
    await json(p.root + "/chats/main/budget", "PUT", { usd: 0.001 });
    await send(p.id);
    const before = p.rt.log.list({ kinds: ["message"] }).length;
    await expect(client.send(p.id, "blocked", "echo")).rejects.toThrow(/Chat budget/);
    expect(p.rt.log.list({ kinds: ["message"] })).toHaveLength(before);
    expect(p.rt.log.list({ kinds: ["status"] }).filter(e => e.payload.state === "cost_budget_notice" && e.payload.scope === "chat")).toHaveLength(1);
    const chat = await json(p.root + "/chats", "POST", { title: "other", agentId: "echo" }); await send(p.id, { chat: chat.chat.id });
    await json(p.root + "/chats/main/budget", "PUT", { usd: 0.01 }); await send(p.id);
    expect((await json(p.root + "/costs/settings")).chats.main.spentUsd).toBeCloseTo(0.002);
  });
  it("warns monthly at 80%, pauses project-wide at 100%, and Saver loses to every explicit pick", async () => {
    const catalog = vi.spyOn(system, "listModelsForKind").mockResolvedValue({ models: ["echo-cheap"], source: "builtin" });
    const p = await project();
    await json("/api/model-routing", "PUT", { aliases: { cheap: "echo-cheap" }, caps: {}, mondayDigest: false });
    await json(p.root + "/costs/settings", "PUT", { monthlyUsd: 0.005, saver: { alias: "cheap", share: 0.4, period: "month" } });
    await send(p.id); await send(p.id); await send(p.id);
    expect(p.rt.log.list({ kinds: ["run_complete"] }).at(-1)?.payload.model).toBe("echo-cheap");
    expect(await json(p.root + "/estimate", "POST", { text: "next", agentId: "echo", chat: "main" })).toMatchObject({ model: "echo-cheap", saver: { alias: "cheap" } });
    expect(p.rt.log.list({ kinds: ["message"] }).some(e => e.payload.state === "cost_saver")).toBe(true);
    await send(p.id, { model: "explicit-turn" });
    expect(p.rt.log.list({ kinds: ["run_complete"] }).at(-1)?.payload.model).toBe("explicit-turn");
    expect((await json(p.root + "/costs/settings")).monthly).toMatchObject({ warning: true, stopped: false });
    const chat = await json(p.root + "/chats", "POST", { title: "picked", agentId: "echo", model: "explicit-chat" });
    await send(p.id, { chat: chat.chat.id });
    expect(p.rt.log.list({ kinds: ["run_complete"] }).at(-1)?.payload.model).toBe("explicit-chat");
    await expect(client.send(p.id, "no", "echo")).rejects.toThrow(/Monthly/);
    await json(p.root + "/costs/settings", "PUT", { monthlyUsd: 1, saver: { alias: "cheap", share: 0.001, period: "month" } });
    await json(p.root + "/agents/echo/model", "POST", { model: "explicit-agent" });
    await send(p.id);
    expect(p.rt.log.list({ kinds: ["run_complete"] }).at(-1)?.payload.model).toBe("explicit-agent");
    catalog.mockRestore();
  });
  it("allows the owner's phone and scoped project routes, refuses other projects and shared guests", async () => {
    const p = await project(), other = await project();
    for (const body of [{}, { projects: [p.id] }, { guest: { project: p.id, chat: "main", role: "view", name: "guest" } }]) {
      const pair = await json("/api/pair/new", "POST", body), claim = await json("/api/pair/claim", "POST", { token: pair.token, name: "cost test" });
      const guest = "guest" in body, scoped = "projects" in body;
      expect((await request(p.root + "/costs/export", "GET", undefined, claim.clientToken)).status).toBe(guest ? 403 : 200);
      expect((await request(p.root + "/chats/main/budget", "PUT", { usd: 2 }, claim.clientToken)).status).toBe(guest ? 403 : 200);
      expect((await request(p.root + "/costs/settings", "PUT", { alerts: [] }, claim.clientToken)).status).toBe(guest ? 403 : 200);
      for (const [url, data] of [["/api/prices", {}], ["/api/fleets/suggest", { goal: "review", size: 1 }]] as const)
        expect((await request(url, url === "/api/prices" ? "PUT" : "POST", data, claim.clientToken)).status).toBe(guest || scoped ? 403 : 200);
      if (scoped) expect((await request(other.root + "/costs/export", "GET", undefined, claim.clientToken)).status).toBe(403);
    }
  });
  it("delivers selected spend alerts via a configured Discord destination once, and records delivery failures", async () => {
    const messages: string[] = [];
    const server = createServer((req, res) => { let body = ""; req.on("data", d => { body += d; }); req.on("end", () => { messages.push(body); res.setHeader("content-type", "application/json"); res.end('{"id":"1"}'); }); });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    process.env.LOOM_DISCORD_API = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const p = await project();
    try {
      writeBridges({ discord: { enabled: true, botToken: "fake", channels: ["123"], users: [], project: p.id } });
      await json(p.root + "/costs/settings", "PUT", { monthlyUsd: 0.001, alerts: ["discord"] });
      await send(p.id);
      await waitUntil(() => messages.length === 1);
      const notice = p.rt.log.list({ kinds: ["status"] }).find(e => e.payload.state === "cost_budget_notice")!;
      await waitUntil(() => p.rt.log.list({ kinds: ["status"] }).some(e => e.payload.state === "cost_alert_delivered"));
      budgetNotices(p.rt); await deliverSpendAlert(p.rt, notice); expect(messages).toHaveLength(1);
      expect(JSON.parse(messages[0]!).content).toContain("Paused"); expect(JSON.parse(messages[0]!).allowed_mentions.parse).toEqual([]);
      await json(p.root + "/costs/settings", "PUT", { alerts: ["email"] });
      await deliverSpendAlert(p.rt, notice);
      expect(p.rt.log.list({ kinds: ["status"] }).at(-1)?.payload).toMatchObject({ state: "cost_alert_failed", channel: "email" });
    } finally { writeBridges({}); delete process.env.LOOM_DISCORD_API; await new Promise<void>(resolve => server.close(() => resolve())); }
  });
  it("runs the new CLI commands against the test daemon without changing default costs or send JSON", async () => {
    const p = await project();
    const cli = async (...args: string[]) => (await promisify(execFile)(process.execPath, ["--import", import.meta.resolve("tsx"), fileURLToPath(new URL("../src/cli/index.ts", import.meta.url)), ...args], { cwd: p.dir, env: process.env })).stdout;
    expect(JSON.parse(await cli("prices", "set", "echo-a", "--in", "2", "--out", "3")).overrides["echo-a"].in).toBe(2);
    expect(JSON.parse(await cli("budget:month", "5")).settings.monthlyUsd).toBe(5);
    expect(JSON.parse(await cli("chat:budget", "main", "1")).chats.main.capUsd).toBe(1);
    expect(JSON.parse(await cli("budget:alerts", "none")).settings.alerts).toEqual([]);
    const sent = JSON.parse(await cli("send", "hello", "--wait", "--json")); expect(sent).toBeTruthy();
    expect(await cli("costs")).toContain("total");
    const costs = JSON.parse(await cli("costs", "--by", "chat", "--json")); expect(costs.rows[0].chat).toBe("main");
    expect(await cli("costs", "--by", "day", "--csv")).toContain('"day","usd"');
    expect(JSON.parse(await cli("costs", "--cache")).rows[0]).toHaveProperty("cacheSavedUsd");
    expect(JSON.parse(await cli("costs:whatif", "--model", "echo-a")).model).toBe("echo-a");
    expect(JSON.parse(await cli("models:compare", "echo-a", "unknown")).models).toHaveLength(2);
    expect(JSON.parse(await cli("fleets:suggest", "review", "--size", "1")).picks.length).toBeLessThanOrEqual(1);
    expect(JSON.parse(await cli("prices", "rm", "echo-a")).overrides).not.toHaveProperty("echo-a");
  });
});


it("records no Saver note for refusal and never exposes the note as an agent reply", async () => {
  const catalog = vi.spyOn(system, "listModelsForKind").mockResolvedValue({ models: ["echo-cheap"], source: "builtin" });
  try {
    const p = await project();
    await json("/api/model-routing", "PUT", { aliases: { cheap: "echo-cheap" }, caps: {}, mondayDigest: false });
    await json(p.root + "/costs/settings", "PUT", { monthlyUsd: 1, saver: { alias: "cheap", share: 0.1, period: "month" } });
    p.rt.log.append({ kind: "run_complete", agentId: "echo", payload: { costUsd: 0.2 } });
    p.rt.quarantine("echo", "test quarantine", false);
    await expect(client.send(p.id, "refused", "echo")).rejects.toThrow(/quarantin/);
    expect(p.rt.log.list({ kinds: ["message"] }).filter(e => e.payload.state === "cost_saver")).toEqual([]);
    p.rt.unquarantine("echo");
    await send(p.id);
    const note = p.rt.log.list({ kinds: ["message"] }).find(e => e.payload.state === "cost_saver")!;
    expect(note).toBeDefined(); expect(note.agentId).toBeUndefined();
    const failed = { id: note.id + 1, ts: note.ts + 1, kind: "error" as const, agentId: "echo", chat: "main", payload: { message: "launch failed" } };
    expect(turnOutcome([note, failed], "echo", note.id - 1)).toMatchObject({ status: "error", reply: "" });
    // The core hook leaves the instance methods owned by RuntimeTurns.
    expect(Object.hasOwn((p.rt as any).turns, "sendMessage")).toBe(false);
    expect(Object.hasOwn((p.rt as any).turns, "steer")).toBe(false);
  } finally { catalog.mockRestore(); }
});

it("owns asynchronous Saver preparation and releases it when the catalog fails", async () => {
  const p = await project();
  await json("/api/model-routing", "PUT", { aliases: { cheap: "echo-cheap" }, caps: {}, mondayDigest: false });
  await json(p.root + "/costs/settings", "PUT", { monthlyUsd: 1, saver: { alias: "cheap", share: 0.1, period: "month" } });
  p.rt.log.append({ kind: "run_complete", agentId: "echo", payload: { costUsd: 0.2 } });
  let reject!: (error: Error) => void;
  const catalog = vi.spyOn(system, "listModelsForKind").mockImplementationOnce(() => new Promise((_, no) => { reject = no; }));
  const pending = p.rt.sendMessage("refused prompt");
  try {
    expect(() => p.rt.setAgentModel("echo", "replacement")).toThrow(/mid-turn/);
    expect(() => p.rt.patchConfig({ brain: { continuity: true } })).toThrow(/finish or reconcile/);
    reject(new Error("catalog unavailable"));
    await expect(pending).rejects.toThrow("catalog unavailable");
    expect(p.rt.log.list({ kinds: ["message"] })).toHaveLength(0);
    expect(() => p.rt.setAgentModel("echo", "replacement")).not.toThrow();
    await send(p.id);
    expect(p.rt.log.list({ kinds: ["run_complete"] }).at(-1)?.payload.model).toBe("replacement");
  } finally {
    reject(new Error("test cleanup"));
    await pending.catch(() => {});
    catalog.mockRestore();
  }
});

it("skips incompatible Saver models for CLI agents in both dispatch and estimates", async () => {
  const p = await project();
  await json("/api/model-routing", "PUT", { aliases: { cheap: "openrouter/vendor-model" }, caps: {}, mondayDigest: false });
  await json(p.root + "/costs/settings", "PUT", { monthlyUsd: 1, saver: { alias: "cheap", share: 0.1, period: "month" } });
  p.rt.log.append({ kind: "run_complete", agentId: "echo", payload: { costUsd: 0.2 } });
  await send(p.id);
  expect(p.rt.log.list({ kinds: ["message"] }).some(e => e.payload.state === "cost_saver")).toBe(false);
  expect(p.rt.log.list({ kinds: ["run_complete"] }).at(-1)?.payload.model).not.toBe("openrouter/vendor-model");
  expect(await json(p.root + "/estimate", "POST", { text: "hi", agentId: "echo" })).not.toHaveProperty("saver");
  expect(await canUseSaver({ kind: "claude-code" }, "openrouter/vendor-model")).toBe(false);
  expect(await canUseSaver({ kind: "model" }, "openrouter/vendor-model")).toBe(true);
});

it("refuses capped queue and route handoffs before moving the baton, then resumes after Raise", async () => {
  const p = await project();
  await json(p.root + "/agents", "POST", { kind: "echo", id: "second" });
  await send(p.id);
  await json(p.root + "/chats/main/budget", "PUT", { usd: 0.0005 });
  const holder = p.rt.baton.holder();
  await expect(p.rt.handoff("second", { source: "route", chat: "main" })).rejects.toThrow(/Chat budget/);
  expect(p.rt.baton.holder()).toBe(holder);
  const item = p.rt.enqueue({ text: "queued", target: { kind: "agent", agentId: "second" }, chat: "main" });
  await waitUntil(() => p.rt.queue.snapshot().paused);
  expect(p.rt.baton.holder()).toBe(holder);
  expect(p.rt.log.list({ kinds: ["message"] }).some(e => e.payload.text === "queued")).toBe(false);
  await json(p.root + "/chats/main/budget", "PUT", { usd: 1 });
  p.rt.queue.setPaused(false); (p.rt as any).kickQueue();
  await waitUntil(() => p.rt.log.list({ kinds: ["run_complete"] }).some(e => e.agentId === "second"));
  expect(p.rt.queue.snapshot().items.some(i => i.id === item.id)).toBe(false);
});
