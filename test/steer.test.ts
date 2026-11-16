import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { readDaemonConfig } from "../src/core/registry.js";
import { PromptQueue } from "../src/core/prompt-queue.js";
import { DaemonClient } from "../src/daemon/client.js";
import { LoomDaemon } from "../src/daemon/server.js";
import type { ProjectRuntime } from "../src/daemon/runtime.js";
import { EchoAdapter } from "../src/adapters/echo.js";
import { makeProjectDir, tmpDir, waitUntil } from "./helpers.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let daemon: LoomDaemon, client: DaemonClient, rt: ProjectRuntime;
let id: string, dir: string, base: string, token: string;

beforeAll(async () => {
  process.env.LOOM_HOME = tmpDir("home-steer");
  process.env.LOOM_NO_NOTIFY = "1";
  daemon = new LoomDaemon({ host: "127.0.0.1", port: 0 });
  const listening = await daemon.listen();
  base = `http://${listening.host}:${listening.port}`;
  const config = readDaemonConfig()!;
  client = new DaemonClient(config);
  token = config.adminToken;
});
beforeEach(async () => {
  dir = makeProjectDir({ agents: [{ id: "echo", kind: "echo" }, { id: "other", kind: "echo" },
    { id: "off", kind: "echo", enabled: false }] });
  id = (await client.addProject(dir)).project.id;
  // Inspect the real runtime to wait for dispatch, and exercise an older adapter's capability contract.
  rt = await (daemon as unknown as { runtime(id: string): Promise<ProjectRuntime> }).runtime(id);
});
afterAll(async () => { await daemon?.close(); });

const post = (route: string, body: unknown = {}) => fetch(`${base}/api/projects/${id}${route}`, {
  method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body),
});
const replies = () => rt.log.list({ kinds: ["message"], limit: 500 }).filter(e => e.agentId);
const prompts = () => rt.log.list({ kinds: ["message"], limit: 500 }).filter(e => !e.agentId);
async function running(chat = "main", agentId = "echo", text = "sleep:900 working") {
  const sent = await post("/messages", { text, chat, agentId });
  expect(sent.status).toBe(200);
  await waitUntil(() => (rt.agent(agentId) as EchoAdapter).busy());
}

describe("steering over HTTP", () => {
  it("adds input to the same turn and publishes one ordinary user message in its chat", async () => {
    await running();
    expect(await client.steer(id, "use the smaller change")).toEqual({ steered: true });
    expect(await client.steer(id, "and explain why")).toEqual({ steered: true });
    expect(rt.queue.length).toBe(0);
    expect(prompts().map(e => e.payload)).toEqual([
      { text: "sleep:900 working", author: "user" },
      { text: "use the smaller change", author: "user", steer: true },
      { text: "and explain why", author: "user", steer: true },
    ]);
    await waitUntil(() => replies().length === 1);
    expect(replies()[0]!.payload.text).toContain("use the smaller change\nand explain why");
    expect(rt.log.list({ kinds: ["run_complete"] })).toHaveLength(1);
    const status = (await client.project(id)).project;
    expect(status.agents.find(a => a.id === "echo")?.capabilities).toEqual({ steer: true });
    expect(status.agents.find(a => a.id === "off")?.capabilities).toEqual({ steer: false });
  });

  it("uses the chat binding and never injects into a different chat's active turn", async () => {
    const chat = rt.createChat("Side", { agentId: "other" });
    await running(chat.id, "other");
    expect(await client.steer(id, "side instruction", { chat: chat.id })).toEqual({ steered: true });
    const fallback = await client.steer(id, "main only", { agentId: "other" });
    expect(fallback).toMatchObject({ steered: false, queued: 1, queueId: expect.any(String), reason: expect.stringMatching(/No turn/) });
    expect(rt.queue.snapshot().items[0]).toMatchObject({ text: "main only", chat: "main", target: { kind: "agent", agentId: "other" } });
    await waitUntil(() => replies().length === 2);
    expect(replies()[0]).toMatchObject({ chat: chat.id });
    expect(replies()[0]!.payload.text).toContain("side instruction");
    expect(replies()[0]!.payload.text).not.toContain("main only");
    expect(prompts().find(e => e.payload.steer)).toMatchObject({ chat: chat.id });
  });

  it("honors an explicit agent over the chat binding", async () => {
    const chat = rt.createChat("Bound", { agentId: "other" });
    await running(chat.id);
    expect(await client.steer(id, "explicit", { chat: chat.id, agentId: "echo" })).toEqual({ steered: true });
    await waitUntil(() => replies().length === 1);
    expect(replies()[0]).toMatchObject({ agentId: "echo", chat: chat.id });
    expect(replies()[0]!.payload.text).toContain("explicit");
  });

  it("queues an idle-chat request and dispatches it as a normal turn", async () => {
    const result = await client.steer(id, "nothing running");
    expect(result).toMatchObject({ steered: false, queued: 1, queueId: expect.any(String), reason: expect.stringMatching(/No turn/) });
    await waitUntil(() => replies().length === 1);
    expect(prompts()[0]!.payload.steer).toBeUndefined();
    expect(replies()[0]!.payload.text).toContain("nothing running");
    expect(rt.queue.length).toBe(0);
  });

  it("falls back for an adapter without steering and reports why", async () => {
    const echo = rt.agent("echo") as EchoAdapter;
    echo.capabilities.steer = false;
    await running();
    const result = await client.steer(id, "next turn");
    expect(result).toMatchObject({ steered: false, queued: 1, reason: expect.stringMatching(/does not support/) });
    expect((await client.project(id)).project.agents.find(a => a.id === "echo")?.capabilities.steer).toBe(false);
    await waitUntil(() => replies().length === 2);
    expect(replies()[0]!.payload.text).not.toContain("next turn");
    expect(replies()[1]!.payload.text).toContain("next turn");
    expect(prompts().some(e => e.payload.steer)).toBe(false);
  });

  it("keeps a rejected steer when the turn is already stopping", async () => {
    await running();
    await (rt.agent("echo") as EchoAdapter).interrupt();
    const result = await rt.steerMessage("after stopping");
    expect(result).toMatchObject({ steered: false, queued: 1, reason: expect.stringMatching(/did not accept/) });
    await waitUntil(() => replies().length === 1);
    expect(replies()[0]!.payload.text).toContain("after stopping");
  });

  it("validates bodies and requires authentication", async () => {
    for (const body of [{}, { text: " " }, { text: 1 }, { text: "ok", chat: [] }, { text: "ok", agentId: 3 }])
      expect((await post("/steer", body)).status).toBe(400);
    expect((await fetch(`${base}/api/projects/${id}/steer`, { method: "POST" })).status).toBe(401);
    expect((await post("/queue/missing/steer")).status).toBe(404);
    expect(prompts()).toHaveLength(0);
    expect(rt.queue.length).toBe(0);
  });
});

describe("promoting queued input", () => {
  it("removes only the promoted item, even in a paused queue, and never sends it twice", async () => {
    await running();
    rt.queue.setPaused(true, "manual pause");
    rt.enqueue({ text: "keep waiting", target: { kind: "agent", agentId: "echo" } });
    const item = rt.enqueue({ text: "do this now", target: { kind: "agent", agentId: "echo" }, when: { kind: "at", at: Date.now() + 60_000 } });
    const results = await Promise.all([post(`/queue/${item.id}/steer`), post(`/queue/${item.id}/steer`)]);
    expect(results.filter(r => r.status === 200)).toHaveLength(1);
    expect(await results.find(r => r.status === 200)!.json()).toEqual({ steered: true });
    expect(rt.queue.snapshot()).toMatchObject({ paused: true, items: [{ text: "keep waiting" }] });
    await waitUntil(() => replies().length === 1);
    expect(String(replies()[0]!.payload.text).split("do this now")).toHaveLength(2);
    expect(prompts().filter(e => e.payload.text === "do this now")).toHaveLength(1);
  });

  it("keeps an unsupported promotion's id, position, text and condition", async () => {
    await running();
    (rt.agent("echo") as EchoAdapter).capabilities.steer = false;
    rt.queue.setPaused(true);
    const item = rt.enqueue({ text: "stay put", target: { kind: "agent", agentId: "echo" }, when: { kind: "quiet", ms: 1000 } });
    const before = rt.queue.snapshot();
    expect(await client.steerQueued(id, item.id)).toMatchObject({ steered: false, queueId: item.id, queued: 1 });
    expect(rt.queue.snapshot()).toEqual(before);
  });

  it("promotes a plan prompt as input to the current turn but keeps orchestra goals queued", async () => {
    await running();
    rt.queue.setPaused(true);
    const plan = rt.enqueue({ text: "plan it", target: { kind: "agent", agentId: "echo" }, plan: true });
    const goal = rt.enqueue({ text: "new goal", target: { kind: "orchestra" } });
    expect(await client.steerQueued(id, plan.id)).toEqual({ steered: true });
    expect(await client.steerQueued(id, goal.id)).toMatchObject({ steered: false, queueId: goal.id, reason: expect.stringMatching(/own run/) });
    expect(rt.queue.snapshot().items).toEqual([goal]);
    await waitUntil(() => replies().length === 1);
    expect(replies()[0]!.payload.text).toContain("plan it");
  });
});

it("protects a reserved queue item from competing dispatch, promotion and edits", () => {
  const queue = new PromptQueue(null);
  const item = queue.add({ text: "reserved" });
  const release = queue.reserve(item.id);
  expect(queue.shift()).toBeUndefined();
  expect(() => queue.reserve(item.id)).toThrow(/being steered/);
  expect(() => queue.edit(item.id, { text: "changed" })).toThrow(/being steered/);
  expect(() => queue.remove(item.id)).toThrow(/being steered/);
  expect(() => queue.move(item.id, 0)).toThrow(/being steered/);
  expect(() => queue.clear()).toThrow(/being steered/);
  release();
  expect(queue.shift()).toMatchObject({ id: item.id, text: "reserved" });
});

it("loom steer resolves --chat by title and prints both acceptance and fallback", async () => {
  const chat = rt.createChat("CLI chat", { agentId: "echo" });
  await running(chat.id, "echo", "sleep:10000 CLI working");
  const cli = (...args: string[]): Promise<string> => new Promise((resolve, reject) => {
    execFile(process.execPath, [path.join(root, "node_modules/tsx/dist/cli.mjs"), path.join(root, "src/cli/index.ts"), ...args],
      { cwd: dir, env: { ...process.env, NO_COLOR: "1" } }, (err, stdout, stderr) => err ? reject(new Error(stderr || err.message)) : resolve(stdout));
  });
  expect(await cli("steer", "CLI instruction", "--chat", "CLI chat")).toContain("steered the running turn");
  expect(prompts().find(e => e.payload.text === "CLI instruction")).toMatchObject({ chat: chat.id, payload: { steer: true } });
  expect(await cli("steer", "main later")).toMatch(/queued.*No turn/s);
  await (rt.agent("echo") as EchoAdapter).interrupt();
});
