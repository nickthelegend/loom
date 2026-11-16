import { execFile, spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import type { PresenceSnapshot } from "../src/core/presence.js";
import { readDaemonConfig } from "../src/core/registry.js";
import { DaemonClient } from "../src/daemon/client.js";
import { LoomDaemon } from "../src/daemon/server.js";
import { makeProjectDir, tmpDir, waitUntil } from "./helpers.js";

let daemon: LoomDaemon;
let client: DaemonClient;
let base: string;
let admin: string;
let projectId: string;
let otherProject: string;
let side: string;
let projectDir: string;
const sockets: WebSocket[] = [];
const views: Array<{ close(): void }> = [];
const children: ChildProcess[] = [];
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliArgs = [path.join(root, "node_modules/tsx/dist/cli.mjs"), path.join(root, "src/cli/index.ts")];

const call = (token: string, method: string, route: string, body?: unknown) => fetch(base + route, {
  method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
  ...(body ? { body: JSON.stringify(body) } : {}),
});

async function pair(body: object, name = "phone") {
  const made = await (await call(admin, "POST", "/api/pair/new", body)).json() as { token: string };
  const claimed = await (await call(admin, "POST", "/api/pair/claim", { token: made.token, name })).json() as { clientToken: string };
  expect(claimed.clientToken).toBeTruthy();
  return claimed.clientToken;
}

const guest = (chat = "main", name = "Priya") => pair({ guest: { project: projectId, chat, name, role: "view" } });

async function connect(token = admin, project: string | undefined = projectId) {
  const frames: PresenceSnapshot[] = [];
  const ws = new WebSocket(base.replace("http", "ws") + `/ws${project ? `?project=${encodeURIComponent(project)}` : ""}`, [`loom.bearer.${token}`]);
  sockets.push(ws);
  ws.on("message", (data) => {
    const frame = JSON.parse(String(data)) as PresenceSnapshot;
    if (frame.type === "presence") frames.push(frame);
  });
  await new Promise<void>((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
  return { ws, frames, send: (chat = "main", typing?: boolean) => ws.send(JSON.stringify({ type: "presence", chat, ...(typing !== undefined ? { typing } : {}) })) };
}

beforeAll(async () => {
  process.env.LOOM_HOME = tmpDir("home-presence");
  process.env.LOOM_NO_NOTIFY = "1";
  daemon = new LoomDaemon({ host: "127.0.0.1", port: 0 });
  await daemon.listen();
  const cfg = readDaemonConfig()!;
  client = new DaemonClient(cfg);
  admin = cfg.adminToken;
  base = `http://${cfg.host}:${cfg.port}`;
  projectDir = makeProjectDir({ name: "presence", agents: [{ id: "bot", kind: "echo", role: "worker" }] });
  projectId = (await client.addProject(projectDir)).project.id;
  otherProject = (await client.addProject(makeProjectDir({ name: "elsewhere" }))).project.id;
  side = ((await (await call(admin, "POST", `/api/projects/${projectId}/chats`, { title: "Side chat" })).json()) as { chat: { id: string } }).chat.id;
}, 60_000);

afterEach(async () => {
  for (const child of children.splice(0)) child.kill("SIGTERM");
  for (const view of views.splice(0)) view.close();
  for (const ws of sockets.splice(0)) ws.terminate();
  await waitUntil(async () => (await client.presence(projectId)).people.length === 0 && (await client.presence(projectId, side)).people.length === 0);
});
afterAll(async () => { await daemon.close(); });

describe("Share-live presence", () => {
  it("counts each guest socket and owner view, broadcasts typing, and includes a safe guest snapshot", async () => {
    const token = await guest();
    const owner = await connect();
    const first = await connect(token);
    const second = await connect(token);
    owner.send();
    await waitUntil(() => [owner, first, second].every((c) => c.frames.at(-1)?.people.length === 3));
    const snapshot = await client.presence(projectId);
    expect(snapshot).toMatchObject({ type: "presence", projectId, chat: "main" });
    expect(snapshot.people.map((p) => p.kind).sort()).toEqual(["guest", "guest", "owner"]);
    expect(new Set(snapshot.people.map((p) => p.id)).size).toBe(3);
    expect(snapshot.people.every((p) => p.since > 0 && p.typing === false)).toBe(true);
    expect(snapshot.people.find((p) => p.kind === "owner")?.name).toBe("you");
    expect(snapshot.people.filter((p) => p.kind === "guest").every((p) => p.name === "Priya")).toBe(true);
    expect(JSON.stringify(snapshot)).not.toContain(token);
    expect(JSON.stringify(snapshot)).not.toContain(admin);
    expect(JSON.stringify(snapshot)).not.toContain("127.0.0.1");
    const bootstrap = await (await call(token, "GET", "/api/guest")).json() as { presence: PresenceSnapshot };
    expect(bootstrap.presence).toEqual(snapshot);
    first.send("main", true);
    await waitUntil(() => [owner, first, second].every((c) => c.frames.at(-1)?.people.filter((p) => p.typing).length === 1));
    first.send("main", false);
    await waitUntil(() => [owner, first, second].every((c) => c.frames.at(-1)?.people.every((p) => !p.typing)));
    first.ws.close();
    await waitUntil(() => owner.frames.at(-1)?.people.length === 2);
    expect((await client.presence(projectId)).people).toHaveLength(2);
    owner.send(side);
    await waitUntil(() => second.frames.at(-1)?.people.length === 1);
    expect((await client.presence(projectId, side)).people[0]?.kind).toBe("owner");
  });

  it("isolates chats and projects, scopes device snapshots, and ignores invalid announcements", async () => {
    const token = await guest();
    const owner = await connect(await pair({ owner: true }, "Desktop"));
    const all = await connect(admin, "");
    const restricted = await connect(await pair({ projects: [otherProject] }), "");
    const other = await connect(admin, otherProject);
    const first = await connect(token);
    const privateGuest = await connect(await guest(side, "Ada"));
    const deviceToken = await pair({ projects: [projectId] }, "Priya's phone");
    const device = await connect(deviceToken);
    device.send();
    owner.send();
    await waitUntil(() => first.frames.at(-1)?.people.length === 3 && privateGuest.frames.at(-1)?.people.length === 1);
    expect(first.frames.every((f) => f.chat === "main" && f.projectId === projectId)).toBe(true);
    expect(privateGuest.frames.every((f) => f.chat === side && f.people.every((p) => p.name === "Ada"))).toBe(true);
    expect(other.frames).toEqual([]);
    expect(restricted.frames).toEqual([]);
    expect(all.frames.some((f) => f.chat === "main" && f.people.length === 3)).toBe(true);
    expect(all.frames.some((f) => f.chat === side)).toBe(true);
    expect((await client.presence(projectId)).people.find((p) => p.kind === "device")?.name).toBe("Priya's phone");
    expect((await call(deviceToken, "GET", `/api/projects/${projectId}/chats/main/presence`)).status).toBe(200);
    expect((await call(deviceToken, "GET", `/api/projects/${otherProject}/chats/main/presence`)).status).toBe(403);
    expect((await call(token, "GET", `/api/projects/${projectId}/chats/${side}/presence`)).status).toBe(403);
    expect((await call(admin, "GET", `/api/projects/${projectId}/chats/missing/presence`)).status).toBe(404);
    expect((await call("invalid", "GET", `/api/projects/${projectId}/chats/main/presence`)).status).toBe(401);
    all.send("main", true);
    first.send(side, true);
    owner.send("missing", true);
    for (const invalid of [null, [], { type: "presence", chat: "main", typing: "yes" }, { type: "presence", chat: {} }]) owner.ws.send(JSON.stringify(invalid));
    owner.ws.send("{broken");
    // A valid final change proves the preceding invalid frames were processed.
    owner.send("main", true);
    await waitUntil(() => first.frames.at(-1)?.people.some((p) => p.kind === "owner" && p.typing) === true);
    expect((await client.presence(projectId, side)).people.map((p) => p.name)).toEqual(["Ada"]);
    expect((await client.presence(projectId)).people.filter((p) => p.typing).map((p) => p.kind)).toEqual(["owner"]);
    expect(privateGuest.frames.every((f) => f.chat === side && f.people.every((p) => p.name === "Ada"))).toBe(true);
    expect(restricted.frames).toEqual([]);
    const wrong = new WebSocket(base.replace("http", "ws") + `/ws?project=${otherProject}`, [`loom.bearer.${deviceToken}`]);
    sockets.push(wrong);
    expect(await new Promise<number>((resolve) => wrong.once("close", resolve))).toBe(4403);
  });

  it("expires a guest after 45 seconds despite WS pongs, while client heartbeats keep the owner present", async () => {
    const observer = await connect();
    const visitor = await connect(await guest());
    const frames: PresenceSnapshot[] = [];
    const view = client.watchPresence(projectId, "main", (frame) => frames.push(frame));
    views.push(view);
    view.setTyping(true);
    await waitUntil(() => frames.at(-1)?.people.length === 2 && frames.at(-1)?.people.some((p) => p.kind === "owner" && p.typing) === true);
    const initialOwner = frames.at(-1)!.people.find((p) => p.kind === "owner")!;
    await waitUntil(() => observer.frames.at(-1)?.people.length === 1 && observer.frames.at(-1)?.people[0]?.kind === "owner", { timeoutMs: 48_000, intervalMs: 100 });
    expect(visitor.ws.readyState).toBe(WebSocket.OPEN);
    expect(frames.at(-1)?.people).toEqual([initialOwner]);
    visitor.send();
    view.setTyping(false);
    await waitUntil(() => frames.at(-1)?.people.length === 2 && frames.at(-1)?.people.every((p) => !p.typing) === true);
    view.close();
    await waitUntil(() => visitor.frames.at(-1)?.people.length === 1 && visitor.frames.at(-1)?.people[0]?.kind === "guest");
  }, 60_000);

  it("exposes snapshots and live viewing through the CLI", async () => {
    const visitor = await connect(await guest(side));
    await waitUntil(() => visitor.frames.at(-1)?.people.length === 1);
    const run = (args: string[]) => new Promise<string>((resolve, reject) => {
      execFile(process.execPath, [...cliArgs, ...args], { cwd: projectDir, env: { ...process.env, NO_COLOR: "1" } },
        (error, stdout) => error ? reject(error) : resolve(stdout));
    });
    const snapshot = JSON.parse(await run(["presence", "Side chat", "--json"])) as PresenceSnapshot;
    expect(snapshot).toMatchObject({ chat: side, people: [{ name: "Priya", kind: "guest" }] });
    expect(await run(["presence", side])).toContain("Priya (guest)");
    expect(await run(["presence"])).toContain("nobody viewing this chat");
    const child = spawn(process.execPath, [...cliArgs, "presence", side, "--watch", "--json"], { cwd: projectDir, env: { ...process.env, NO_COLOR: "1" }, stdio: ["ignore", "pipe", "pipe"] });
    children.push(child);
    let output = "";
    child.stdout.on("data", (chunk) => { output += String(chunk); });
    await waitUntil(() => output.split("\n").slice(0, -1).filter(Boolean).some((line) => JSON.parse(line).people.length === 2));
    await waitUntil(() => visitor.frames.at(-1)?.people.some((p) => p.kind === "owner") === true);
    child.kill("SIGTERM");
    await waitUntil(() => visitor.frames.at(-1)?.people.length === 1);
  }, 30_000);

  it("counts the interactive CLI chat as an owner view and leaves on quit", async () => {
    const visitor = await connect(await guest());
    const child = spawn(process.execPath, [...cliArgs, "chat"], { cwd: projectDir, env: { ...process.env, NO_COLOR: "1" }, stdio: ["pipe", "pipe", "pipe"] });
    children.push(child);
    let output = "";
    child.stdout.on("data", (chunk) => { output += String(chunk); });
    await waitUntil(() => output.includes("you>") && visitor.frames.at(-1)?.people.some((p) => p.kind === "owner") === true);
    child.stdin.write("/quit\n");
    await waitUntil(() => visitor.frames.at(-1)?.people.length === 1);
    await waitUntil(() => child.exitCode === 0);
  }, 30_000);
});
