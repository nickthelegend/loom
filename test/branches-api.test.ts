import fs from "node:fs";
import path from "node:path";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DaemonClient } from "../src/daemon/client.js";
import type { ProjectRuntime } from "../src/daemon/runtime.js";
import type { RuntimeBriefings } from "../src/daemon/runtime/briefings.js";
import { LoomDaemon } from "../src/daemon/server.js";
import { readDaemonConfig, readProjectState } from "../src/core/registry.js";
import type { ChatBranch, LoomEvent } from "../src/types.js";
import { makeProjectDir, tmpDir, waitUntil } from "./helpers.js";

let daemon: LoomDaemon, client: DaemonClient, base: string, token: string, dir: string, id: string;
const exec = promisify(execFile);
beforeEach(async () => {
  process.env.LOOM_HOME = tmpDir("home-branches");
  process.env.LOOM_NO_NOTIFY = "1";
  daemon = new LoomDaemon({ host: "127.0.0.1", port: 0 });
  await connect();
  dir = makeProjectDir({ agents: [{ id: "echo", kind: "echo", role: "general" }] });
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "pipe" });
  git("init", "-q");
  fs.writeFileSync(path.join(dir, ".gitignore"), ".loom/\n");
  fs.writeFileSync(path.join(dir, "tracked.txt"), "before\n");
  git("add", "."); git("-c", "user.name=Test", "-c", "user.email=test@local", "commit", "-qm", "initial");
  id = (await client.addProject(dir)).project.id;
});
afterEach(async () => { await daemon.close(); });
async function connect() {
  const { host, port } = await daemon.listen();
  base = `http://${host}:${port}`;
  const config = readDaemonConfig()!;
  client = new DaemonClient(config); token = config.adminToken;
}
async function request(endpoint: string, body?: unknown) {
  return fetch(`${base}/api/projects/${id}${endpoint}`, { method: body === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
}
async function events(chat = "main"): Promise<LoomEvent[]> { return (await client.chatEvents(id, chat)).events; }
async function idle() {
  await waitUntil(async () => !(await client.project(id)).project.agents.some(a => a.busy));
}
async function send(text: string, chat = "main") {
  const res = await request("/messages", { text, chat });
  expect(res.status).toBe(200);
  await idle();
  return (await events(chat)).filter(e => e.kind === "message");
}
async function branch(from: number, mode: "edit" | "retry", text?: string, chat = "main"): Promise<ChatBranch> {
  const out = await client.createBranch(id, chat, from, mode, text);
  await idle();
  return out.branch;
}
const user = (events: LoomEvent[], text: string) => events.find(e => e.payload.author === "user" && e.payload.text === text)!;
const texts = (events: LoomEvent[]) => events.filter(e => e.kind === "message" && !e.agentId).map(e => e.payload.text);
const cli = async (...args: string[]) => (await exec(process.execPath,
  ["--import", import.meta.resolve("tsx"), fileURLToPath(new URL("../src/cli/index.ts", import.meta.url)), ...args],
  { cwd: dir, env: process.env })).stdout;

describe("in-place branches", () => {
  it("edits, retries, groups siblings and paginates the active history, including nested forks", async () => {
    await send("first");
    const original = await send("second original");
    const second = user(original, "second original");
    const a = await branch(second.id, "edit", "second edited");
    expect(a.parent).toBe("0");
    expect(texts(await events())).toEqual(["first", "second edited"]);
    expect((await events()).filter(e => e.id > a.forkEventId).every(e => e.branch === a.id)).toBe(true);
    const reply = (await events()).filter(e => e.kind === "message" && e.agentId).at(-1)!;
    const b = await branch(reply.id, "retry");
    expect(b.parent).toBe(a.parent);
    expect(b.forkEventId).toBe(a.forkEventId);
    expect(texts(await events())).toEqual(["first", "second edited"]);
    const listing = await client.branches(id, "main");
    expect(listing.active).toBe(b.id);
    expect(listing.siblingsByEventId[second.id]).toEqual(["0", a.id, b.id]);
    expect(listing.siblingsByEventId[reply.id]).toEqual(["0", a.id, b.id]);
    const third = user(await send("third"), "third");
    const nested = await branch(third.id, "edit", "third edited");
    expect(nested.parent).toBe(b.id);
    expect(texts(await events())).toEqual(["first", "second edited", "third edited"]);
    const runtime = await (daemon as unknown as { runtime(id: string): Promise<ProjectRuntime> }).runtime(id);
    const extracted = (runtime as unknown as { briefings: RuntimeBriefings }).briefings.gatherAgentTurn("main", "echo");
    expect(extracted.text).toContain("third edited");
    expect(extracted.text).not.toContain("second original");
    expect(extracted.replyId).toBe((await events()).filter(e => e.kind === "message" && e.agentId).at(-1)!.id);
    const page = (await client.chatEvents(id, "main", { before: third.id, limit: 2 })).events;
    expect(page).toHaveLength(2);
    expect(page.every(e => (e.branch ?? "0") === b.id)).toBe(true);
    await client.activateBranch(id, "main", "0");
    expect(texts(await events())).toEqual(["first", "second original"]);
    await client.activateBranch(id, "main", nested.id);
    const replay = await (await request("/chats/main/replay")).text();
    expect(replay).toContain("third edited");
    expect(replay).not.toContain("second original");
    expect((await client.chats(id)).chats.find(c => c.id === "main")?.activeBranch).toBe(nested.id);
  });

  it("keeps chats isolated and restores the selected branch after a daemon restart", async () => {
    const chat = (await client.createChat(id, "Topic", { agentId: "echo" })).chat.id;
    await send("main stays");
    const original = user(await send("topic old", chat), "topic old");
    const fork = await branch(original.id, "edit", "topic new", chat);
    await daemon.close();
    daemon = new LoomDaemon({ host: "127.0.0.1", port: 0 });
    await connect();
    expect((await client.branches(id, chat)).active).toBe(fork.id);
    expect(texts(await events(chat))).toEqual(["topic new"]);
    expect(texts(await events())).toEqual(["main stays"]);
    expect(texts(await send("continue", chat))).toEqual(["topic new", "continue"]);
    await client.activateBranch(id, chat, "0");
    expect(texts(await events(chat))).toEqual(["topic old"]);
  });

  it("previews tracked and untracked changes and rewinds files only on explicit activation", async () => {
    const original = user(await send("original"), "original");
    const fork = await branch(original.id, "edit", "alternate");
    fs.writeFileSync(path.join(dir, "tracked.txt"), "changed\n");
    fs.writeFileSync(path.join(dir, "untracked.txt"), "new\n");
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" });
    const index = fs.readFileSync(path.join(dir, ".git", "index"));
    const preview = await client.branchRewindPreview(id, "main", "0");
    expect(preview.changed.sort()).toEqual(["tracked.txt", "untracked.txt"]);
    expect(preview.diff).toContain("-changed");
    expect(preview.diff).toContain("+before");
    expect(preview.diff).toContain("-new");
    expect(fs.readFileSync(path.join(dir, ".git", "index"))).toEqual(index);
    expect(fs.existsSync(path.join(dir, "untracked.txt"))).toBe(true);
    expect((await client.activateBranch(id, "main", "0")).rewind).toBeUndefined();
    expect(fs.readFileSync(path.join(dir, "tracked.txt"), "utf8")).toBe("changed\n");
    const switched = await client.activateBranch(id, "main", fork.id, true);
    expect(switched.rewind?.changed.sort()).toEqual(preview.changed);
    expect(switched.rewind?.diff).toBe(preview.diff);
    expect(switched.rewind?.undo.id).toBeTruthy();
    expect(fs.readFileSync(path.join(dir, "tracked.txt"), "utf8")).toBe("before\n");
    expect(fs.existsSync(path.join(dir, "untracked.txt"))).toBe(false);
    expect(execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" })).toBe(head);
  });

  it("validates requests and rejects busy or queued branch changes without mutating metadata", async () => {
    const original = user(await send("original"), "original");
    for (const body of [{ fromEventId: original.id, mode: "edit", text: " " }, { fromEventId: "1", mode: "retry" },
      { fromEventId: original.id, mode: "retry" }, { fromEventId: original.id, mode: "invalid" }])
      expect((await request("/chats/main/branches", body)).status).toBe(400);
    expect((await request("/chats/missing/branches")).status).toBe(404);
    expect((await request("/chats/main/branches/nope/activate", {})).status).toBe(404);
    expect((await request("/chats/main/branches/0/activate", { rewindFiles: "yes" })).status).toBe(400);
    await request("/messages", { text: "sleep:400", chat: "main" });
    expect((await request("/chats/main/branches", { fromEventId: original.id, mode: "edit", text: "new" })).status).toBe(409);
    expect((await request("/chats/main/branches/0/activate", {})).status).toBe(409);
    await idle();
    await client.queuePause(id, true);
    await client.queueAdd(id, { text: "queued", target: "echo", chat: "main" });
    expect((await request("/chats/main/branches/0/activate", {})).status).toBe(409);
    expect((await client.branches(id, "main")).branches).toHaveLength(1);
    expect(readProjectState(dir).chats?.find(c => c.id === "main")?.activeBranch).toBeUndefined();
  });

  it("serializes concurrent branch creation", async () => {
    const original = user(await send("original"), "original");
    const responses = await Promise.all(["left", "right"].map(text => request("/chats/main/branches", { fromEventId: original.id, mode: "edit", text })));
    expect(responses.map(r => r.status).sort()).toEqual([200, 409]);
    await idle();
    expect((await client.branches(id, "main")).branches).toHaveLength(2);
    expect(texts(await events())).toHaveLength(1);
  });

  it("rejects hidden and foreign event targets and reports unavailable fork checkpoints", async () => {
    const original = user(await send("original"), "original");
    const fork = await branch(original.id, "edit", "alternate");
    expect((await request("/chats/main/branches", { fromEventId: original.id, mode: "edit", text: "hidden" })).status).toBe(400);
    const other = (await client.createChat(id, "Other")).chat.id;
    expect((await request(`/chats/${other}/branches`, { fromEventId: original.id, mode: "edit", text: "foreign" })).status).toBe(400);
    const cp = readProjectState(dir).branchSources!.main![fork.id]!.checkpointId!;
    execFileSync("git", ["update-ref", "-d", `refs/loom/checkpoints/${cp}`], { cwd: dir });
    expect((await request(`/chats/main/branches/${fork.id}/rewind`)).status).toBe(409);
    await client.activateBranch(id, "main", "0");
    expect((await request(`/chats/main/branches/${fork.id}/activate`, { rewindFiles: true })).status).toBe(409);
    expect((await client.branches(id, "main")).active).toBe("0");
  });

  it("exposes list, edit, retry, preview and activation through the CLI", async () => {
    const original = user(await send("original"), "original");
    expect(JSON.parse(await cli("chat:branches", "--json")).active).toBe("0");
    const fork = JSON.parse(await cli("chat:edit", String(original.id), "CLI edit")).branch;
    await idle();
    const reply = (await events()).filter(e => e.agentId && e.kind === "message").at(-1)!;
    const retried = JSON.parse(await cli("chat:retry", String(reply.id))).branch;
    await idle();
    expect(retried.parent).toBe(fork.parent);
    expect(await cli("chat:branch", "0", "--preview")).toContain("No file changes");
    expect(JSON.parse(await cli("chat:branch", "0")).active).toBe("0");
    expect(texts(await events())).toEqual(["original"]);
  });
});
