import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readDaemonConfig, readProjectConfig } from "../src/core/registry.js";
import type { QueueItem } from "../src/core/prompt-queue.js";
import { DaemonClient } from "../src/daemon/client.js";
import { LoomDaemon } from "../src/daemon/server.js";
import { makeProjectDir, tmpDir, waitUntil } from "./helpers.js";

let daemon: LoomDaemon;
let client: DaemonClient;
let base: string;
let token: string;
let dir: string;
let id: string;

async function start() {
  daemon = new LoomDaemon({ host: "127.0.0.1", port: 0 });
  const { host, port } = await daemon.listen();
  base = `http://${host}:${port}`;
  token = readDaemonConfig()!.adminToken;
  client = new DaemonClient(readDaemonConfig()!);
}

async function post(route: string, body: Record<string, unknown>) {
  return fetch(`${base}/api/projects/${id}${route}`, {
    method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function send(body: Record<string, unknown>) {
  const res = await post("/messages", { text: "hello", ...body });
  expect(res.status).toBe(200);
  return res.json() as Promise<{ agentId: string; queued?: number }>;
}

async function completed(count: number) {
  await waitUntil(async () => (await client.events(id)).events.filter(e => e.kind === "run_complete").length === count);
  return (await client.events(id)).events.filter(e => e.kind === "run_complete").map(e => e.payload);
}

async function queue() {
  const res = await fetch(`${base}/api/projects/${id}/queue`, { headers: { authorization: `Bearer ${token}` } });
  expect(res.status).toBe(200);
  return res.json() as Promise<{ queue: QueueItem[]; paused: boolean }>;
}

beforeEach(async () => {
  process.env.LOOM_HOME = tmpDir("home-send-effort");
  process.env.LOOM_NO_NOTIFY = "1";
  await start();
  dir = makeProjectDir({ agents: [
    { id: "one", kind: "echo", options: { model: "default-model", effort: "medium" } },
    { id: "two", kind: "echo" },
  ] });
  id = (await client.addProject(dir)).project.id;
});

afterEach(async () => { await daemon.close(); });

describe("per-message model and effort", () => {
  it("overrides just this turn, inherits blank fields, and leaves stored selections alone", async () => {
    const before = readProjectConfig(dir);
    const { chat } = await client.createChat(id, "review", { agentId: "one", model: "chat-model", effort: "low" });
    await send({ chat: chat.id, effort: " high " });
    expect((await completed(1))[0]).toMatchObject({ model: "chat-model", effort: "high" });
    await send({ chat: chat.id, model: " turn-model ", effort: "max" });
    expect((await completed(2))[1]).toMatchObject({ model: "turn-model", effort: "max" });
    await send({ chat: chat.id });
    expect((await completed(3))[2]).toMatchObject({ model: "chat-model", effort: "low" });
    await send({ chat: chat.id, model: " ", effort: "" });
    expect((await completed(4))[3]).toMatchObject({ model: "chat-model", effort: "low" });
    expect((await client.chats(id)).chats.find(c => c.id === chat.id)).toMatchObject(chat);
    expect(readProjectConfig(dir)).toEqual(before);

    await client.handoff(id, "two");
    await send({ chat: chat.id, agentId: "two", effort: "high" });
    expect((await completed(5))[4]).toMatchObject({ model: "echo-1", effort: "high" });
    await send({ chat: chat.id, agentId: "two" });
    expect((await completed(6))[5]).not.toHaveProperty("effort");
  });

  it("rejects the same malformed selections as chat bindings before logging or queuing", async () => {
    const { chat } = await client.createChat(id, "review", { agentId: "one" });
    const before = (await client.events(id)).events;
    for (const selection of [
      { effort: 1 }, { effort: null }, { effort: ["high"] }, { effort: {} },
      { effort: "h".repeat(41) }, { effort: "hi\u0000gh" },
      { model: false }, { model: null }, { model: "m".repeat(201) }, { model: "mo\ndel" },
    ]) {
      const sent = await post("/messages", { text: "invalid", chat: chat.id, ...selection });
      const bound = await post(`/chats/${chat.id}/agent`, { agentId: "one", ...selection });
      expect(sent.status).toBe(400);
      expect(bound.status).toBe(400);
      expect(await sent.json()).toMatchObject(await bound.json());
    }
    expect((await client.events(id)).events).toEqual(before);
    expect((await queue()).queue).toEqual([]);
  });

  it("keeps explicit, inherited and default selections through chat edits and a restart", async () => {
    const { chat } = await client.createChat(id, "review", { agentId: "one", model: "chat-model", effort: "low" });
    expect((await post("/queue/pause", {})).status).toBe(200);
    await send({ chat: chat.id, text: "sleep:1500" });
    expect(await send({ chat: chat.id, model: "queued-model", effort: "max" })).toMatchObject({ queued: 1 });
    expect(await send({ chat: chat.id })).toMatchObject({ queued: 2 });
    await client.setChatAgent(id, chat.id, "one");
    expect(await send({ chat: chat.id })).toMatchObject({ queued: 3 });
    await client.setChatAgent(id, chat.id, "one", { model: "new-model", effort: "high" });
    const waiting = (await queue()).queue;
    expect(waiting.map(i => [i.model, i.effort])).toEqual([
      ["queued-model", "max"], ["chat-model", "low"], [null, null],
    ]);
    await completed(1);
    await daemon.close();
    await start();
    expect(await queue()).toMatchObject({ queue: waiting, paused: true });
    expect((await post("/queue/pause", { paused: false })).status).toBe(200);
    expect(await completed(4)).toMatchObject([
      { model: "chat-model", effort: "low" }, { model: "queued-model", effort: "max" },
      { model: "chat-model", effort: "low" }, { model: "default-model", effort: "medium" },
    ]);
    expect((await client.chats(id)).chats.find(c => c.id === chat.id)).toMatchObject({ model: "new-model", effort: "high" });
  }, 30_000);

  it("accepts selection fields in the strict continuity request schema", async () => {
    const nativeDir = makeProjectDir({ brain: { continuity: true, extractor: "off" }, agents: [{ id: "echo", kind: "echo" }] });
    id = (await client.addProject(nativeDir)).project.id;
    const res = await post("/messages", { text: "hello", model: "echo-model", effort: "high" });
    // Echo cannot run native continuity; reaching that refusal proves the schema accepted the fields.
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ code: "unsupported" });
    const invalid = await post("/messages", { text: "hello", effort: 1 });
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({ code: "invalid" });
  });

  it("passes CLI flags through the client and preserves them when a handoff retries the send", async () => {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    const run = (args: string[]) => new Promise<{ code: number; out: string; err: string }>(resolve => {
      execFile(process.execPath, [path.join(root, "node_modules/tsx/dist/cli.mjs"), path.join(root, "src/cli/index.ts"), "send", "--wait", "--json", ...args],
        { cwd: dir, env: { ...process.env, NO_COLOR: "1" } }, (err, out, stderr) =>
          resolve({ code: err ? 1 : 0, out, err: stderr }));
    });
    const first = await run(["hello", "--model", "cli-model", "--effort", "high"]);
    expect(first.code, first.err).toBe(0);
    expect(JSON.parse(first.out)).toMatchObject({ status: "ok", agent: "one" });
    expect((await completed(1))[0]).toMatchObject({ model: "cli-model", effort: "high" });
    const next = await run(["hello again"]);
    expect(next.code, next.err).toBe(0);
    expect((await completed(2))[1]).toMatchObject({ model: "default-model", effort: "medium" });
    const handed = await run(["review", "-a", "two", "--handoff", "--model", "review-model", "--effort", "max"]);
    expect(handed.code, handed.err).toBe(0);
    expect(JSON.parse(handed.out)).toMatchObject({ status: "ok", agent: "two" });
    expect((await completed(3))[2]).toMatchObject({ model: "review-model", effort: "max" });
    const bad = await run(["invalid", "--effort", "x".repeat(41)]);
    expect(bad.code).toBe(1);
    expect(bad.err).toContain("invalid effort");
  }, 30_000);
});
