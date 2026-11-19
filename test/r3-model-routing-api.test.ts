import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { LoomDaemon } from "../src/daemon/server.js";
import { DaemonClient } from "../src/daemon/client.js";
import { readDaemonConfig, readProjectConfig } from "../src/core/registry.js";
import { setPriceBook } from "../src/core/prices.js";
import { makeProjectDir, tmpDir, waitUntil } from "./helpers.js";
let daemon: LoomDaemon, client: DaemonClient, base: string, token: string, pid: string, dir: string;
const settings = { aliases: { fast: "echo-a", cheap: "echo-b" }, caps: {}, mondayDigest: false };
async function request(route: string, method = "GET", body?: unknown, auth = token) {
  return fetch(base + route, { method, headers: { authorization: `Bearer ${auth}`, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
async function json(route: string, method = "GET", body?: unknown) {
  const r = await request(route, method, body); const j = await r.json(); if (!r.ok) throw new Error(JSON.stringify(j)); return j as any;
}
beforeAll(async () => {
  process.env.LOOM_HOME = tmpDir("r3-api-home"); process.env.LOOM_NO_NOTIFY = "1";
  daemon = new LoomDaemon({ host: "127.0.0.1", port: 0 });
  const address = await daemon.listen(); base = `http://${address.host}:${address.port}`;
  token = readDaemonConfig()!.adminToken; client = new DaemonClient(readDaemonConfig()!);
  dir = makeProjectDir({ agents: [{ id: "echo", kind: "echo", role: "general", options: { model: "fast" } }] });
  await json("/api/model-routing", "PUT", settings);
  pid = (await client.addProject(dir)).project.id;
});
afterAll(async () => { await daemon.close(); setPriceBook(undefined); });

describe("r3 model routing API", () => {
  it("uses aliases and project effort in actual echo turns, with chat overrides taking precedence", async () => {
    const root = `/api/projects/${pid}`;
    await json(root + "/config", "PATCH", { defaultEffort: "high" });
    await client.send(pid, "hello", "echo");
    const rt = await daemon.runtime(pid);
    await waitUntil(() => rt.log.list({ kinds: ["run_complete"] }).length === 1);
    expect(rt.log.list({ kinds: ["run_complete"] })[0]?.payload).toMatchObject({ model: "echo-a", effort: "high" });
    const chat = await json(root + "/chats", "POST", { title: "cheap chat", agentId: "echo", model: "cheap", effort: "low" });
    await client.send(pid, "again", undefined, { chat: chat.chat.id });
    await waitUntil(() => rt.log.list({ kinds: ["run_complete"] }).length === 2);
    expect(rt.log.list({ kinds: ["run_complete"] }).at(-1)?.payload).toMatchObject({ model: "echo-b", effort: "low" });
    expect((await json(root + "/agents/echo/models")).models).toContain("fast");
  });
  it("rejects invalid options and effort without changing persisted state", async () => {
    const before = readProjectConfig(dir);
    const route = `/api/projects/${pid}/agents/echo/options`;
    const r = await request(route, "PUT", { extraArgs: "--oops" });
    expect(r.status).toBe(400); expect(await r.json()).toMatchObject({ error: expect.stringMatching(/extraArgs/) });
    expect(readProjectConfig(dir)).toEqual(before);
    expect((await request(`/api/projects/${pid}/agents`, "POST", { kind: "echo", options: "--oops" })).status).toBe(400);
    expect(readProjectConfig(dir)).toEqual(before);
    expect((await request(`/api/projects/${pid}/config`, "PATCH", { defaultEffort: "extreme" })).status).toBe(400);
    await json(route, "PUT", { extraArgs: ["--name", "two words"], effort: "medium" });
    expect((await json(route)).extraArgs).toEqual(["--name", "two words"]);
    (await daemon.runtime(pid)).baton.release("echo");
    await json(`/api/projects/${pid}/agents/echo/enabled`, "PUT", { enabled: false });
    await json(route, "PUT", { effort: "low" });
    expect(readProjectConfig(dir)!.agents[0]).toMatchObject({ enabled: false, options: { effort: "low" } });
    await json(`/api/projects/${pid}/agents/echo/enabled`, "PUT", { enabled: true });
  });
  it("warns at 80%, blocks a send before recording its prompt at 100%, and estimates aliases", async () => {
    setPriceBook({ at: Date.now(), models: { "echo-a": { in: 0.001, out: 0.002 } } });
    await json("/api/model-routing", "PUT", { ...settings, caps: { fast: { usd: 0.00125 } } });
    const route = `/api/projects/${pid}`;
    const estimate = await json(route + "/estimate", "POST", { text: "hello", agentId: "echo", model: "fast" });
    expect(estimate).toMatchObject({ model: "echo-a", approximate: true, usage: { warning: true, stopped: false } });
    expect(estimate.usd).toBeGreaterThan(0);
    await json("/api/model-routing", "PUT", { ...settings, caps: { fast: { usd: 0.001 } } });
    const rt = await daemon.runtime(pid), count = rt.log.list({ kinds: ["message"] }).length;
    await expect(client.send(pid, "must not enter history", "echo")).rejects.toThrow(/daily model cap/);
    expect(rt.log.list({ kinds: ["message"] })).toHaveLength(count);
    await json("/api/model-routing", "PUT", settings);
  });
  it("refuses machine-wide reads/writes/probes from scoped and guest tokens; the owner's own phone may use them", async () => {
    for (const body of [{}, { projects: [pid] }, { guest: { project: pid, chat: "main", role: "view", name: "guest" } }]) {
      const pair = await json("/api/pair/new", "POST", body);
      const claim = await json("/api/pair/claim", "POST", { token: pair.token, name: "r3" });
      const refused = "projects" in body || "guest" in body;
      // reads and probes only: a PUT here would replace the machine settings later tests rely on
      for (const [route, method, data] of [["/api/model-routing", "GET", undefined], ["/api/model-routing/health", "POST", {}]] as const)
        expect((await request(route, method, data, claim.clientToken)).status).toBe(refused ? 403 : 200);
      if (refused) expect((await request("/api/model-routing", "PUT", settings, claim.clientToken)).status).toBe(403);
      if ("projects" in body || "guest" in body) {
        expect((await request(`/api/projects/${pid}/estimate`, "POST", { text: "hello" }, claim.clientToken)).status).toBe(403);
        expect((await request(`/api/projects/${pid}/agents/echo/options`, "PUT", { extraArgs: [] }, claim.clientToken)).status).toBe(403);
        expect((await request(`/api/projects/${pid}/config`, "PATCH", { defaultEffort: "low" }, claim.clientToken)).status).toBe(403);
        expect((await request(`/api/scoreboard?project=${pid}&format=csv`, "GET", undefined, claim.clientToken)).status).toBe(403);
      }
    }
  });
  it("exports the scoreboard and weekly digest over API and CLI", async () => {
    const csv = await request(`/api/scoreboard?project=${pid}&format=csv`);
    expect(csv.headers.get("content-type")).toContain("text/csv");
    expect(csv.headers.get("content-disposition")).toContain("loom-scoreboard.csv");
    expect(await csv.text()).toContain("echo-a");
    const digest = await json(`/api/scoreboard?project=${pid}&digest=1`);
    expect(digest.board.window).toBe("7d"); expect(digest.text).toContain("echo-b");
    const cli = async (...args: string[]) => (await promisify(execFile)(process.execPath, ["--import", import.meta.resolve("tsx"), fileURLToPath(new URL("../src/cli/index.ts", import.meta.url)), ...args], { cwd: dir, env: process.env })).stdout;
    expect(await cli("scoreboard", "--csv")).toContain('"totalCostUsd"');
    expect(await cli("digest", "--scoreboard")).toContain("Weekly scoreboard");
    expect(await cli("models:config")).toContain('"fast"');
    expect(await cli("models:effort", "medium")).toContain("medium");
    expect(readProjectConfig(dir)?.defaultEffort).toBe("medium");
    expect(await cli("agents:options", "echo", '{"extraArgs":[]}')).toContain('"saved": true');
  });
});
