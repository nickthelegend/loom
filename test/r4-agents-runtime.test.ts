import { afterAll, beforeAll, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { execFileSync, execFile } from "node:child_process";
import { registerAgentKind } from "../src/adapters/index.js";
import { EchoAdapter } from "../src/adapters/echo.js";
import { AdapterBase } from "../src/adapters/base.js";
import { LoomDaemon } from "../src/daemon/server.js";
import { DaemonClient } from "../src/daemon/client.js";
import { readDaemonConfig } from "../src/core/registry.js";
import type { SendInput } from "../src/types.js";
import { makeProjectDir, tmpDir, waitUntil } from "./helpers.js";

let daemon: LoomDaemon, client: DaemonClient, id: string, dir: string, tries = 0, behaviour = "retry";
let captured: Record<string, unknown> = {};
const constructed = new Map<string, Record<string, unknown>>();
class FailureAgent extends AdapterBase {
  constructor(id: string, dir: string, private options: Record<string, unknown>) { super(id, "echo", dir); constructed.set(id, options); }
  async available() { return true; }
  async start() { captured = this.options; }
  async stop() {}
  async interrupt() { if (!this._busy) return; this._busy = false; this.emit({ kind: "status", payload: { state: "interrupted" } }); }
  async send(_input: SendInput) {
    if (this.busy()) throw new Error("busy");
    this._busy = true; tries++;
    try {
      this.emit({ kind: "status", payload: { state: "turn_cost", costUsd: 0.01 } });
      if (behaviour === "throw" && tries < 3) throw new Error("ECONNRESET");
      if (behaviour === "edit") { fs.writeFileSync(path.join(dir, "changed.txt"), String(tries)); this.emit({ kind: "file_edit", payload: { path: "changed.txt" } }); }
      if (behaviour === "reverted") { this.emit({ kind: "file_edit", payload: { path: "changed.txt" } }); }
      if (["retry", "throw"].includes(behaviour) && tries >= 3) this.emit({ kind: "run_complete", payload: { costUsd: 0.01 } });
      else this.emit({ kind: "error", payload: { message: behaviour === "permanent" ? "invalid request" : "429 rate limit" } });
    } finally { this._busy = false; }
  }
}
const request = async (route: string, body: unknown, method = "PUT") => {
  const r = await fetch(client.baseUrl + `/api/projects/${id}` + route, { method, headers: { authorization: `Bearer ${readDaemonConfig()!.adminToken}`, "content-type": "application/json" }, body: JSON.stringify(body) });
  expect(r.status, await r.text()).toBe(200);
};
const events = async () => (await client.chatEvents(id, "main", { limit: 1000 })).events;
beforeAll(async () => {
  vi.stubEnv("LOOM_HOME", tmpDir("r4-retry-home")); vi.stubEnv("LOOM_NO_NOTIFY", "1");
  registerAgentKind("echo", (cfg, dir) => new FailureAgent(cfg.id, dir, cfg.options ?? {}));
  dir = makeProjectDir({ agents: [{ id: "echo", kind: "echo", role: "test" }] });
  execFileSync("git", ["init", "-q"], { cwd: dir }); fs.writeFileSync(path.join(dir, ".gitignore"), ".loom/\n");
  execFileSync("git", ["add", ".gitignore"], { cwd: dir }); execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@test", "commit", "-qm", "seed"], { cwd: dir });
  daemon = new LoomDaemon({ host: "127.0.0.1", port: 0 }); await daemon.listen(); client = new DaemonClient(readDaemonConfig()!); id = (await client.addProject(dir)).project.id;
});
afterAll(async () => { await daemon?.close(); registerAgentKind("echo", (cfg, dir) => new EchoAdapter(cfg.id, "echo", dir, cfg.options)); vi.unstubAllEnvs(); });
it("applies private environment on construction, retries transient unchanged turns, and accounts for every attempt", async () => {
  await request("/agents/echo/env", { key: "R4_PRIVATE", value: "only-the-child-gets-this" });
  await request("/agents/echo/limits", { retries: { count: 2, waitSeconds: 0.01 } });
  await client.send(id, "retry me", "echo");
  await waitUntil(async () => (await events()).some(e => e.kind === "run_complete"));
  expect(tries).toBe(3); expect(captured.env).toMatchObject({ R4_PRIVATE: "only-the-child-gets-this" });
  expect((await events()).filter(e => e.payload.state === "turn_retry")).toHaveLength(2);
  expect((await events()).filter(e => ["error", "run_complete"].includes(e.kind)).map(e => e.payload.costUsd)).toEqual([0.01, 0.01, 0.01]);
});
it.each(["edit", "reverted", "permanent"])("does not retry %s failures", async mode => {
  tries = 0; behaviour = mode;
  const before = (await events()).at(-1)!.id;
  await client.send(id, "no unsafe retry", "echo");
  await waitUntil(async () => (await events()).some(e => e.id > before && e.kind === "error"));
  await waitUntil(async () => !(await client.project(id)).project.agents[0]!.busy);
  expect(tries).toBe(1); expect((await events()).filter(e => e.id > before && e.payload.state === "turn_retry")).toEqual([]);
});
it("records thrown network failures as separate costed attempts", async () => {
  tries = 0; behaviour = "throw";
  const before = (await events()).at(-1)!.id;
  await client.send(id, "retry a thrown failure", "echo");
  await waitUntil(async () => (await events()).some(e => e.id > before && e.kind === "run_complete"));
  const failed = (await events()).filter(e => e.id > before && e.kind === "error");
  expect(tries).toBe(3); expect(failed).toHaveLength(2);
  expect(failed.every(e => e.payload.retrying && e.payload.costUsd === 0.01)).toBe(true);
});
it("Stop cancels retry backoff and prevents the next attempt", async () => {
  tries = 0; behaviour = "retry";
  await request("/agents/echo/limits", { retries: { count: 3, waitSeconds: 30 } });
  const before = (await events()).at(-1)!.id;
  await client.send(id, "stop my retries", "echo");
  await waitUntil(async () => (await events()).some(e => e.id > before && e.payload.state === "turn_retry"));
  await request("/interrupt", { chat: "main" }, "POST");
  await waitUntil(async () => !(await client.project(id)).project.agents[0]!.busy);
  expect(tries).toBe(1);
  expect((await events()).some(e => e.id > before && e.payload.state === "interrupted")).toBe(true);
  await request("/agents/echo/limits", { retries: { count: 0, waitSeconds: 0 } });
  expect(await client.send(id, "a new turn", "echo")).not.toHaveProperty("queued");
  await waitUntil(() => tries === 2);
});
it("keeps CLI wait as one JSON object and stream as NDJSON across retries", async () => {
  await request("/agents/echo/limits", { retries: { count: 2, waitSeconds: 0 } });
  for (const mode of [["--wait", "--json"], ["--stream"]]) {
    tries = 0; behaviour = "retry";
    const result = await new Promise<{ error: unknown; out: string; err: string }>(resolve => execFile(process.execPath, [path.resolve("node_modules/tsx/dist/cli.mjs"), path.resolve("src/cli/index.ts"), "send", ...mode, "try again"], { cwd: dir, env: process.env }, (error, out, err) => resolve({ error, out, err })));
    expect(result.error, result.err).toBeNull();
    if (mode[0] === "--wait") expect(JSON.parse(result.out).status).toBe("ok");
    else {
      const rows = result.out.trim().split("\n").map(s => JSON.parse(s));
      expect(rows.some(r => r.type === "event" && r.payload?.retrying)).toBe(true);
      expect(rows.filter(r => r.type === "outcome")).toHaveLength(1);
      expect(rows.at(-1).status).toBe("ok");
    }
    expect(tries).toBe(3);
  }
});
it("charges failed attempts against the budget before admitting another try", async () => {
  tries = 0; behaviour = "retry";
  const spent = (await events()).filter(e => e.kind === "status" && e.payload.state === "turn_cost").reduce((n, e) => n + Number(e.payload.costUsd ?? 0), 0);
  await request("/budgets/echo", { usdPerDay: spent + 0.005 });
  await request("/agents/echo/limits", { retries: { count: 3, waitSeconds: 0 } });
  const before = (await events()).at(-1)!.id;
  await client.send(id, "budgeted retry", "echo");
  await waitUntil(async () => (await events()).some(e => e.id > before && e.kind === "error"));
  await waitUntil(async () => !(await client.project(id)).project.agents[0]!.busy);
  expect(tries).toBe(1);
  await request("/budgets/echo", { usdPerDay: 0 });
});

it("a time limit during silent retry backoff releases the turn and admits Continue", async () => {
  tries = 0; behaviour = "retry";
  await request("/agents/echo/limits", { retries: { count: 3, waitSeconds: 30 }, maxTurnMinutes: 0.005 });
  const before = (await events()).at(-1)!.id;
  await client.send(id, "time out my retries", "echo");
  await waitUntil(async () => (await events()).some(e => e.id > before && e.kind === "needs_input" && e.payload.reason === "turn_time_limit"));
  expect(tries).toBe(1);
  expect((await events()).some(e => e.id > before && e.payload.state === "interrupted")).toBe(true);
  await request("/agents/echo/limits", { retries: { count: 0, waitSeconds: 0 }, maxTurnMinutes: 0 });
  expect(await client.send(id, "Continue", "echo")).not.toHaveProperty("queued");
  await waitUntil(() => tries === 2);
});

it("removing and recreating an id clears secrets, including stale files from older builds", async () => {
  const { changeEnvironment } = await import("../src/core/agents-r4/store.js");
  await request("/agents", { kind: "echo", id: "reused" }, "POST");
  await request("/agents/reused/env", { key: "DEPLOY_TOKEN", value: "never-inherit-this-token" });
  expect(constructed.get("reused")!.env).toMatchObject({ DEPLOY_TOKEN: "never-inherit-this-token" });
  await request("/agents/reused", {}, "DELETE");
  expect((await import("../src/core/agents-r4/store.js")).agentEnvironment(id, "reused")).toEqual({});
  // Emulate an orphan left by a previous build or interrupted cleanup.
  changeEnvironment(id, "reused", "DEPLOY_TOKEN", "stale-token-from-old-build");
  await request("/agents", { kind: "echo", id: "reused" }, "POST");
  expect(constructed.get("reused")).not.toHaveProperty("env");
  const response = await fetch(client.baseUrl + `/api/projects/${id}/agents/reused/env`, { headers: { authorization: `Bearer ${readDaemonConfig()!.adminToken}` } });
  expect(await response.json()).toEqual({ names: [] });
});
