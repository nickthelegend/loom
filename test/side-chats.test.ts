import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DaemonClient } from "../src/daemon/client.js";
import { LoomDaemon } from "../src/daemon/server.js";
import { readDaemonConfig, readProjectState } from "../src/core/registry.js";
import { SideChats } from "../src/core/side-chats.js";
import { sideDriver } from "../src/daemon/side.js";
import { makeProjectDir, tmpDir, waitUntil } from "./helpers.js";

let daemon: LoomDaemon;
let client: DaemonClient;
let token: string;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
beforeAll(async () => {
  process.env.LOOM_HOME = tmpDir("home-side");
  process.env.LOOM_NO_NOTIFY = "1";
  daemon = new LoomDaemon({ host: "127.0.0.1", port: 0 });
  await daemon.listen();
  const config = readDaemonConfig()!;
  token = config.adminToken;
  client = new DaemonClient(config);
});
afterAll(async () => { await daemon.close(); });

async function project() {
  const dir = makeProjectDir();
  const id = (await client.addProject(dir)).project.id;
  return { dir, id };
}
async function request(method: string, url: string, body?: unknown, auth = token) {
  return fetch(client.baseUrl + url, { method, headers: { authorization: `Bearer ${auth}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
async function answer(id: string, chat: string, sideId: string) {
  await waitUntil(async () => !(await client.sideChat(id, chat, sideId)).busy);
  return client.sideChat(id, chat, sideId);
}
async function pair(body: unknown) {
  const made = await (await request("POST", "/api/pair/new", body)).json() as { token: string };
  const result = await (await request("POST", "/api/pair/claim", { token: made.token, name: "side test" })).json() as { clientToken: string };
  return result.clientToken;
}
async function socket(id: string, auth: string) {
  const frames: Array<Record<string, unknown>> = [];
  const ws = new WebSocket(client.baseUrl.replace("http", "ws") + `/ws?project=${id}`, [`loom.bearer.${auth}`]);
  ws.on("message", bytes => frames.push(JSON.parse(String(bytes))));
  await new Promise<void>((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
  return { ws, frames };
}

describe("private side chat API", () => {
  it("answers beside a running parent, continues, and never changes the log, memory, state or files", async () => {
    const { id, dir } = await project();
    await client.send(id, "sleep:3000 parent keeps working", "plannerbot");
    await waitUntil(async () => (await client.project(id)).project.agents.some(a => a.id === "plannerbot" && a.busy));
    const state = readProjectState(dir);
    const before = (await client.events(id)).events;
    const memory = await client.memory(id);
    const made = await client.sendSide(id, "main", "write:forbidden.txt private-question stream:1");
    const side = await answer(id, "main", made.sideId);
    expect(side.messages.map(m => m.role)).toEqual(["user", "agent"]);
    expect(side.messages[1]!.text).toContain("echo(plannerbot)");
    expect(side.messages.every(m => Number.isFinite(m.at))).toBe(true);
    expect((await client.project(id)).project.agents.find(a => a.id === "plannerbot")!.busy).toBe(true);
    expect((await client.events(id)).events).toEqual(before);
    expect(await client.memory(id)).toEqual(memory);
    expect(readProjectState(dir)).toEqual(state);
    expect(fs.existsSync(path.join(dir, "forbidden.txt"))).toBe(false);
    expect((await client.sendSide(id, "main", "follow-up")).sideId).toBe(made.sideId);
    expect((await answer(id, "main", made.sideId)).messages).toHaveLength(4);
    await client.closeSide(id, "main", made.sideId);
    await expect(client.sideChat(id, "main", made.sideId)).rejects.toMatchObject({ status: 404 });
    expect((await client.sendSide(id, "main", "new drawer")).sideId).not.toBe(made.sideId);
  });

  it("uses the pinned agent, isolates chats and projects, rejects invalid input and simultaneous sends", async () => {
    const { id } = await project();
    const other = await project();
    const { chat } = await (await request("POST", `/api/projects/${id}/chats`, { title: "Pinned", agentId: "execbot" })).json() as { chat: { id: string } };
    const { sideId } = await client.sendSide(id, chat.id, "sleep:150 pinned question");
    await expect(client.sendSide(id, chat.id, "too soon")).rejects.toMatchObject({ status: 409 });
    await expect(client.sideChat(id, "main", sideId)).rejects.toMatchObject({ status: 404 });
    await expect(client.closeSide(other.id, chat.id, sideId)).rejects.toMatchObject({ status: 404 });
    await expect(client.sendSide(id, "missing", "hello")).rejects.toMatchObject({ status: 404 });
    await expect(client.sendSide(id, chat.id, "hello", "missing")).rejects.toMatchObject({ status: 404 });
    for (const text of [null, {}, [], "", " ", "x".repeat(32_001)]) {
      expect((await request("POST", `/api/projects/${id}/chats/${chat.id}/side`, { text })).status).toBe(400);
    }
    expect((await answer(id, chat.id, sideId)).messages[1]!.text).toContain("echo(execbot)");
    await client.closeSide(id, chat.id, sideId);
  });

  it("streams only to owners and unscoped devices, with the same privacy for HTTP", async () => {
    const { id } = await project();
    const phone = await pair({});
    const scoped = await pair({ projects: [id] });
    const guest = await pair({ guest: { project: id, chat: "main", role: "reply", name: "Guest" } });
    const connections = await Promise.all([token, phone, scoped, guest].map(auth => socket(id, auth)));
    try {
      const made = await (await request("POST", `/api/projects/${id}/chats/main/side`, { text: "private stream:1" }, phone)).json() as { sideId: string };
      await answer(id, "main", made.sideId);
      await waitUntil(() => connections.slice(0, 2).every(c => c.frames.some(f => f.type === "side" && f.done)));
      for (const c of connections.slice(0, 2)) {
        const frames = c.frames.filter(f => f.type === "side");
        expect(frames.every(f => f.projectId === id && f.chat === "main" && f.sideId === made.sideId)).toBe(true);
        expect(frames.some(f => typeof f.delta === "string")).toBe(true);
        expect(frames.filter(f => f.message)).toHaveLength(2);
      }
      for (const auth of [scoped, guest]) for (const method of ["POST", "GET", "DELETE"]) {
        const suffix = method === "POST" ? "" : `/${made.sideId}`;
        expect((await request(method, `/api/projects/${id}/chats/main/side${suffix}`, method === "POST" ? { text: "no" } : undefined, auth)).status).toBe(403);
      }
      expect(connections.slice(2).every(c => c.frames.every(f => f.type !== "side"))).toBe(true);
    } finally { for (const c of connections) c.ws.close(); }
  });

  it("closes a running side without a late reply and surfaces failures outside the main log", async () => {
    const { id } = await project();
    const { sideId } = await client.sendSide(id, "main", "sleep:1000 write:late.txt");
    await client.closeSide(id, "main", sideId);
    await expect(client.sendSide(id, "main", "follow-up", sideId)).rejects.toMatchObject({ status: 404 });
    const failed = await client.sendSide(id, "main", "fail:side-only-error");
    expect(await answer(id, "main", failed.sideId)).toMatchObject({ busy: false, error: "side-only-error" });
    expect(JSON.stringify((await client.events(id)).events)).not.toContain("side-only-error");
  });

  it("forgets a side when its parent chat is deleted", async () => {
    const { id } = await project();
    const created = await request("POST", `/api/projects/${id}/chats`, { title: "Temporary" });
    const { chat } = await created.json() as { chat: { id: string } };
    const { sideId } = await client.sendSide(id, chat.id, "sleep:200 transient");
    expect((await request("DELETE", `/api/projects/${id}/chats/${chat.id}`)).status).toBe(200);
    await expect(client.sideChat(id, chat.id, sideId)).rejects.toMatchObject({ status: 404 });
  });

  it("prints the side reply from the real CLI and honors --chat", async () => {
    const { id, dir } = await project();
    const { chat } = await (await request("POST", `/api/projects/${id}/chats`, { agentId: "execbot" })).json() as { chat: { id: string } };
    const out = await new Promise<string>((resolve, reject) => execFile(process.execPath,
      [path.join(root, "node_modules/tsx/dist/cli.mjs"), path.join(root, "src/cli/index.ts"), "btw", "CLI private question", "--chat", chat.id],
      { cwd: dir, env: { ...process.env, NO_COLOR: "1" } }, (error, stdout, stderr) => error ? reject(new Error(stderr)) : resolve(stdout)));
    expect(out).toContain("echo(execbot): CLI private question");
    expect(JSON.stringify((await client.events(id)).events)).not.toContain("CLI private question");
  });
});

it("times out an echo turn, stops its work, and shuts down cleanly", async () => {
  const dir = makeProjectDir();
  const sides = new SideChats(() => sideDriver({ config: { id: "echo", kind: "echo" }, cwd: dir, context: "" }), 40);
  const { sideId } = sides.send("main", "sleep:200 write:late.txt");
  await waitUntil(() => !sides.get("main", sideId).busy);
  expect(sides.get("main", sideId).error).toMatch(/timed out/);
  expect(fs.existsSync(path.join(dir, "late.txt"))).toBe(false);
  await sides.close();
  expect(() => sides.send("main", "after shutdown")).toThrow(/closing/);
});

it("refuses adapters that cannot enforce read-only access before starting a process", () => {
  expect(() => sideDriver({ config: { id: "unsafe", kind: "opencode" }, cwd: makeProjectDir(), context: "" }))
    .toThrow(/cannot enforce read-only/);
});
