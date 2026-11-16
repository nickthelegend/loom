import { execFile, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TeamLink } from "../src/daemon/team.js";
import { ProviderAgent } from "../src/providers/agent.js";
import { FileSessionDirectory } from "../src/providers/directory.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CHAT_MOVE_MAX_BYTES, packChatMove, parseChatMove } from "../src/core/chat-move.js";
import { listProjects, readDaemonConfig, readProjectState, writeProjectState } from "../src/core/registry.js";
import { openFromTeam } from "../src/core/team-crypto.js";
import { DaemonClient } from "../src/daemon/client.js";
import { LoomDaemon } from "../src/daemon/server.js";
import { startHubServer } from "../src/hub/server.js";
import type { ChatInfo, LoomEvent } from "../src/types.js";
import { makeProjectDir, tmpDir, waitUntil } from "./helpers.js";

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" });
let hub: Awaited<ReturnType<typeof startHubServer>>;
let source: LoomDaemon, target: LoomDaemon;
let client: DaemonClient, remote: DaemonClient;
let project: string, destination: string, teamId: string, targetDevice: string, sourceDevice: string;
let base: string, token: string, sourceDir: string, targetDir: string;
let statePath: string, targetStatePath: string;
const runnerConfig = { enabled: false, shared: true, capacity: 2, isolation: "inline" as const, kinds: ["echo"] };

beforeAll(async () => {
  process.env.LOOM_HOME = tmpDir("chat-move-home");
  process.env.LOOM_NO_NOTIFY = "1";
  process.env.LOOM_NO_PUSH = "1";
  hub = await startHubServer({ port: 0, secret: "move" });
  statePath = path.join(tmpDir("chat-move-source"), "team.json");
  source = new LoomDaemon({ host: "127.0.0.1", port: 0, teamOptions: { statePath, runnerConfig: () => runnerConfig, projects: () => listProjects().filter(p => p.dir === sourceDir) } });
  const listen = await source.listen();
  base = `http://${listen.host}:${listen.port}`;
  token = readDaemonConfig()!.adminToken;
  client = new DaemonClient({ ...readDaemonConfig()! });
  targetStatePath = path.join(tmpDir("chat-move-target"), "team.json");
  target = new LoomDaemon({ host: "127.0.0.1", port: 0, teamOptions: {
    statePath: targetStatePath, runnerConfig: () => runnerConfig, projects: () => listProjects().filter(p => p.dir === targetDir),
    runnerCloneUrl: () => sourceDir,
  } });
  await target.listen();
  remote = new DaemonClient({ ...readDaemonConfig()! });
  sourceDir = makeProjectDir({ agents: [{ id: "writer", kind: "echo", role: "worker" }] });
  targetDir = makeProjectDir({ agents: [{ id: "local-writer", kind: "echo", role: "worker" }] });
  for (const dir of [sourceDir, targetDir]) {
    git(dir, "init", "-q", "-b", "main");
    git(dir, "config", "loom.repo", "acme/chat-move");
    fs.writeFileSync(path.join(dir, "loom.team.json"), JSON.stringify({ runners: { shared: true } }));
    fs.writeFileSync(path.join(dir, ".gitignore"), ".loom/\n");
    git(dir, "add", ".");
    git(dir, "-c", "user.name=test", "-c", "user.email=test@example.com", "commit", "-qm", "seed");
    git(dir, "update-ref", "refs/remotes/origin/main", "HEAD");
  }
  project = (await client.addProject(sourceDir)).project.id;
  destination = (await remote.addProject(targetDir)).project.id;
  await client.chats(project); await remote.chats(destination);
  await source.team.signIn(hub.url, { github: "alice", secret: "move" });
  teamId = (await source.team.createTeam("Move team")).id;
  await source.team.share(await source["runtime"](project), teamId);
  await target.team.joinAsRunner(source.team.pairRunnerLink(), { secret: "move" });
  targetDevice = String(target.team.status().device);
  await source.team.startRunner();
  sourceDevice = String(source.team.status().device);
});
afterAll(async () => {
  await source?.close(); await target?.close(); await hub?.close();
});

async function send(c: DaemonClient, id: string, text: string, agentId: string | undefined, opts: { chat: string }) {
  return c["request"]("POST", `/api/projects/${id}/messages`, { text, agentId, ...opts });
}
async function post(chat: string, body: unknown, auth = token) {
  return fetch(`${base}/api/projects/${project}/chats/${chat}/move`, {
    method: "POST", headers: { authorization: `Bearer ${auth}`, "content-type": "application/json" }, body: JSON.stringify(body),
  });
}
async function arrived(jobId: string) {
  let result: { projectId: string; chatId: string } | undefined;
  await waitUntil(async () => {
    const view = await source.team.runnersView(await source["runtime"](project));
    const job = view.jobs.find(j => j.id === jobId);
    if (job?.state === "failed") throw new Error(String(job.error));
    result = job?.result as typeof result;
    return job?.state === "done" && !!result;
  });
  return result!;
}
async function idle(daemon: LoomDaemon, id: string, chat: string) {
  const rt = await daemon["runtime"](id);
  await waitUntil(() => !rt.activity().agents.some(a => a.busy && a.chat === chat));
}

it("moves completed history, preserves attribution, binds the local kind, and briefs once", async () => {
  const chat = (await client.createChat(project, "Portable discussion", { agentId: "writer", model: "echo-custom", effort: "high" })).chat;
  const rt = await source["runtime"](project);
  rt.setChatInstructions(chat.id, "Keep the agreed scope.");
  await send(client, project, "our secret plan run: npm test", undefined, { chat: chat.id });
  await waitUntil(async () => (await client.chatEvents(project, chat.id)).events.some(e => e.kind === "run_complete"));
  await idle(source, project, chat.id);
  const before = rt.log.list({ chat: chat.id, kinds: ["message", "tool_call"] });
  const moved = await client.moveChat(project, chat.id, targetDevice);
  expect(moved.chat.movedTo).toMatchObject({ device: targetDevice, jobId: moved.jobId });
  expect((await client.chats(project)).chats.find(c => c.id === chat.id)?.movedTo).toEqual(moved.chat.movedTo);
  const there = await arrived(moved.jobId);
  expect(there.projectId).toBe(destination);
  const imported = (await remote.chats(destination)).chats.find(c => c.id === there.chatId)!;
  expect(imported).toMatchObject({ title: chat.title, agentId: "local-writer", createdAt: chat.createdAt, model: "echo-custom", effort: "high" });
  expect(imported.movedTo).toBeUndefined();
  const events = (await remote.chatEvents(destination, there.chatId)).events.filter(e => e.payload.imported);
  expect(events).toHaveLength(before.length);
  for (const [i, event] of events.entries()) {
    expect(event).toMatchObject({ ts: before[i]!.ts, payload: before[i]!.payload });
    expect(event.agentId).toBe(before[i]!.agentId);
    expect(event.payload.imported).toMatchObject({ jobId: moved.jobId, eventId: before[i]!.id });
  }
  expect(readProjectState(targetDir).chatInstructions?.[there.chatId]).toBe("Keep the agreed scope.");
  expect(readProjectState(targetDir).chatMoveBriefings?.[there.chatId]).toContain("our secret plan");
  await expect(send(client, project, "too late", undefined, { chat: chat.id })).rejects.toMatchObject({ status: 409 });
  await expect(client.moveChat(project, chat.id, targetDevice)).rejects.toMatchObject({ status: 409 });
  expect(rt.log.list({ chat: chat.id }).some(e => e.kind === "status" && e.payload.text === `Moved to ${moved.chat.movedTo!.name}`)).toBe(true);
  await target.close();
  target = new LoomDaemon({ host: "127.0.0.1", port: 0, teamOptions: {
    statePath: targetStatePath, runnerConfig: () => runnerConfig, projects: () => listProjects().filter(p => p.dir === targetDir), runnerCloneUrl: () => sourceDir,
  } });
  await target.listen();
  remote = new DaemonClient({ ...readDaemonConfig()! });
  await target.team.connect(); await target.team.startRunner();
  const afterRestart = (await client.createChat(project, "Move into an unopened project", { agentId: "writer" })).chat;
  expect(target["runtimes"].has(destination)).toBe(false);
  const reopened = await arrived((await client.moveChat(project, afterRestart.id, targetDevice)).jobId);
  expect(reopened.projectId).toBe(destination);
  const targetRt = await target["runtime"](destination);
  expect(readProjectState(targetDir).chatMoveBriefings?.[there.chatId]).toContain("our secret plan");
  targetRt.setChatInstructions(there.chatId, "");
  const unrelated = (await remote.createChat(destination, "Unrelated", { agentId: "local-writer" })).chat;
  await send(remote, destination, "unrelated turn", undefined, { chat: unrelated.id });
  await waitUntil(() => targetRt.log.list({ chat: unrelated.id }).some(e => e.payload.text === "echo(local-writer): unrelated turn"));
  await idle(target, destination, unrelated.id);
  expect(readProjectState(targetDir).chatMoveBriefings?.[there.chatId]).toContain("our secret plan");
  await send(remote, destination, "continue here", undefined, { chat: there.chatId });
  await waitUntil(() => targetRt.log.list({ chat: there.chatId }).some(e => String(e.payload.text).includes("echo(local-writer): continue here (briefed:")));
  await idle(target, destination, there.chatId);
  expect(readProjectState(targetDir).chatMoveBriefings?.[there.chatId]).toBeUndefined();
  await send(remote, destination, "second turn", undefined, { chat: there.chatId });
  await waitUntil(() => targetRt.log.list({ chat: there.chatId }).some(e => e.payload.text === "echo(local-writer): second turn"));
  await idle(target, destination, there.chatId);
  const back = await remote.moveChat(destination, there.chatId, sourceDevice);
  const home = await arrived(back.jobId);
  expect(home.projectId).toBe(project);
  expect((await client.chats(project)).chats.find(c => c.id === home.chatId)?.movedTo).toBeUndefined();
});

it("returns busy without waiting, waits for the final reply by default, and locks out competing sends", async () => {
  const chat = (await client.createChat(project, "Moving while busy", { agentId: "writer" })).chat;
  await send(client, project, "sleep:500 finish this turn", undefined, { chat: chat.id });
  const busy = await post(chat.id, { to: targetDevice, wait: false });
  expect(busy.status).toBe(409); expect(await busy.json()).toEqual({ error: "busy" });
  const pending = client.moveChat(project, chat.id, targetDevice);
  await waitUntil(() => source["runtimes"].get(project)!["movingChats"].has(chat.id));
  await expect(send(client, project, "racing send", undefined, { chat: chat.id })).rejects.toMatchObject({ status: 409 });
  await expect(client.moveChat(project, chat.id, targetDevice)).rejects.toMatchObject({ status: 409 });
  const there = await arrived((await pending).jobId);
  expect((await remote.chatEvents(destination, there.chatId)).events.some(e => e.payload.text === "echo(writer): sleep:500 finish this turn")).toBe(true);
});

it("rejects invalid destinations and unauthorized callers without moving the chat", async () => {
  const chat = (await client.createChat(project, "Validation", { agentId: "writer" })).chat;
  expect((await post(chat.id, { to: targetDevice, wait: "no" })).status).toBe(400);
  expect((await post(chat.id, { to: "absent" })).status).toBe(400);
  expect((await post(chat.id, { to: sourceDevice })).status).toBe(400);
  expect((await post("absent", { to: targetDevice })).status).toBe(404);
  // the owner's own (unscoped) phone may move a chat; a token scoped to some projects may not
  const paired = source["auth"].newPairingToken([project]);
  const device = source["auth"].claim(paired.token)!;
  expect((await post(chat.id, { to: targetDevice }, device.clientToken)).status).toBe(403);
  expect((await post(chat.id, { to: targetDevice }, "bad-token")).status).toBe(401);
  expect((await client.chats(project)).chats.find(c => c.id === chat.id)?.movedTo).toBeUndefined();
});

it("seals the transcript, omits echo cursors, and imports a retry only once", async () => {
  const chat = (await client.createChat(project, "Sealed", { agentId: "writer" })).chat;
  const rt = await source["runtime"](project);
  rt.log.append({ kind: "message", chat: chat.id, ts: 1234, payload: { author: "user", by: "teammate", text: "private transcript" } });
  const state = readProjectState(sourceDir);
  state.agents.writer = { sessionId: "not-an-echo-session" }; writeProjectState(sourceDir, state);
  const moved = await client.moveChat(project, chat.id, targetDevice);
  const there = await arrived(moved.jobId);
  const stored = JSON.parse(fs.readFileSync(statePath, "utf8"));
  const jobs = await source.team["hub"]().jobs(teamId);
  const job = jobs.find(j => j.id === moved.jobId)!;
  expect(JSON.stringify(job)).not.toContain("private transcript");
  const payload = parseChatMove(openFromTeam(stored.teams[teamId].keys, job.sealed));
  expect(payload.resume).toBeNull();
  const targetRt = await target["runtime"](there.projectId);
  const count = targetRt.log.count({ chat: there.chatId });
  expect(targetRt.importMovedChat(payload, job.id, true).id).toBe(there.chatId);
  expect(targetRt.log.count({ chat: there.chatId })).toBe(count);
});

it("retains a newly cloned project after the job finishes, including a large sealed transcript", async () => {
  const dir = makeProjectDir({ agents: [{ id: "writer", kind: "echo", role: "worker" }] });
  git(dir, "init", "-q"); git(dir, "config", "loom.repo", "acme/another-chat-repo");
  const id = (await client.addProject(dir)).project.id;
  const rt = await source["runtime"](id);
  await source.team.share(rt, teamId);
  const chat = rt.createChat("Large imported history", { agentId: "writer" });
  const text = "a".repeat(1_200_000);
  rt.log.append({ kind: "message", chat: chat.id, payload: { author: "user", text } });
  const moved = await client.moveChat(id, chat.id, targetDevice);
  let result: { projectId: string; chatId: string } | undefined;
  await waitUntil(async () => {
    const job = (await source.team.runnersView(rt)).jobs.find(j => j.id === moved.jobId);
    if (job?.state === "failed") throw new Error(String(job.error));
    result = job?.result as typeof result;
    return job?.state === "done";
  });
  const local = await target["runtime"](result!.projectId);
  expect(local.info.id).not.toBe(destination);
  expect(fs.existsSync(local.info.dir)).toBe(true);
  expect(local.runnerMode).toBe(false);
  expect(local.log.list({ chat: result!.chatId, kinds: ["message"] })[0]!.payload.text).toBe(text);
  await send(remote, local.info.id, "continue in clone", undefined, { chat: result!.chatId });
  await waitUntil(() => local.log.list({ chat: result!.chatId }).some(e => String(e.payload.text).startsWith("echo(echo): continue in clone")));
});

it("supports main, rejects queued work, and preserves the tombstone after reopening", async () => {
  await client.queuePause(project, true);
  const queued = await client.queueAdd(project, { chat: "main", text: "still waiting" });
  await expect(client.moveChat(project, "main", targetDevice)).rejects.toMatchObject({ status: 409 });
  await client["request"]("DELETE", `/api/projects/${project}/queue/${queued.item.id}`);
  await client.queuePause(project, false);
  const moved = await client.moveChat(project, "main", targetDevice);
  await arrived(moved.jobId);
  const rt = await source["runtime"](project);
  source.team.detachRuntime(project);
  await rt.close(); source["runtimes"].delete(project);
  expect((await client.chats(project)).chats.find(c => c.id === "main")?.movedTo).toEqual(moved.chat.movedTo);
  await expect(client.send(project, "cannot send to old main")).rejects.toMatchObject({ status: 409 });
  await expect(client.queueAdd(project, { chat: "main", text: "cannot queue either" })).rejects.toMatchObject({ status: 409 });
});

it("moves a teammate's chat only through shared-runner and repo policy checks", async () => {
  const rt = await source["runtime"](project);
  const bob = new TeamLink({ runtimes: () => [rt], broadcast: () => {}, statePath: path.join(tmpDir("chat-move-bob"), "team.json") });
  try {
    await bob.join((await source.team.invite(teamId)).link, { github: "bob", secret: "move" });
    const first = rt.createChat("Bob's chat", { agentId: "writer" });
    runnerConfig.shared = false; await target.team.runner!.register();
    await expect(bob.moveChat(rt, first.id, targetDevice)).rejects.toThrow("isn't shared");
    expect(rt.chats().find(c => c.id === first.id)?.movedTo).toBeUndefined();
    runnerConfig.shared = true; await target.team.runner!.register();
    const moved = await bob.moveChat(rt, first.id, targetDevice);
    expect((await arrived(moved.jobId)).projectId).toBe(destination);
    fs.writeFileSync(path.join(targetDir, "loom.team.json"), JSON.stringify({ runners: { shared: false } }));
    const blocked = rt.createChat("Policy refuses", { agentId: "writer" });
    const denied = await bob.moveChat(rt, blocked.id, targetDevice);
    await waitUntil(async () => (await source.team.runnersView(rt)).jobs.some(j => j.id === denied.jobId && j.state === "failed"));
    // A failed import must not close or unregister an existing project.
    expect((await remote.chats(destination)).chats.some(c => c.title === "Bob's chat")).toBe(true);
    expect((await remote.chats(destination)).chats.some(c => c.title === "Policy refuses")).toBe(false);
  } finally {
    runnerConfig.shared = true;
    fs.writeFileSync(path.join(targetDir, "loom.team.json"), JSON.stringify({ runners: { shared: true } }));
    await bob.stop();
  }
});

it("the CLI resolves a chat title and prints the move result", async () => {
  const chat = (await remote.createChat(destination, "CLI conversation", { agentId: "local-writer" })).chat;
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const stdout = await new Promise<string>((resolve, reject) => {
    execFile(process.execPath, [path.join(root, "node_modules/tsx/dist/cli.mjs"), path.join(root, "src/cli/index.ts"),
      "chat:move", chat.title, "--to", sourceDevice, "--no-wait", "--json"],
    { cwd: targetDir, env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" } },
    (error, out, err) => error ? reject(new Error(err || error.message)) : resolve(out));
  });
  const result = JSON.parse(stdout);
  expect(result.chat.id).toBe(chat.id);
  expect(result.chat.movedTo.device).toBe(sourceDevice);
  expect((await arrived(result.jobId)).projectId).toBe(project);
});

it("keeps imported history usable when the target has no matching agent kind", async () => {
  const rt = await target["runtime"](destination);
  const imported = rt.importMovedChat(packChatMove({ chat: { id: "foreign", title: "Unavailable kind", agentId: "foreign-agent", createdAt: 1 },
    kind: "unavailable", resume: null, events: [{ id: 1, ts: 2, kind: "message", payload: { author: "user", text: "the earlier task" } }] }), "missing-kind-job", false);
  expect(imported.agentId).toBeUndefined();
  expect(rt.log.list({ chat: imported.id })[0]!.payload.text).toBe("the earlier task");
  rt.setChatAgent(imported.id, "local-writer");
  await send(remote, destination, "continue with echo", undefined, { chat: imported.id });
  await waitUntil(() => rt.log.list({ chat: imported.id }).some(e => String(e.payload.text).startsWith("echo(local-writer): continue with echo (briefed:")));
});

it("reuses only a locally known cursor from a moved provider chat without starting a CLI", () => {
  const dir = makeProjectDir();
  const directory = new FileSessionDirectory(path.join(dir, ".loom"));
  directory.upsert({ threadId: "old", instanceId: "native", provider: "codex", status: "stopped",
    resumeCursor: "local-session", runtimePayload: { cwd: dir }, runtimeMode: "approval-required" });
  const agent = new ProviderAgent("native", "codex", dir);
  expect(agent.resumeMovedChat("new", "unknown-on-this-machine")).toBe(false);
  expect(agent.resumeMovedChat("new", "local-session")).toBe(false);
  const state = readProjectState(dir);
  state.chats = [{ id: "old", title: "Original", createdAt: 1, movedTo: { device: "away", name: "away", at: 2, jobId: "j" } }];
  writeProjectState(dir, state);
  expect(agent.resumeMovedChat("new", "local-session")).toBe(true);
  expect(new FileSessionDirectory(path.join(dir, ".loom")).get("new", "native")?.resumeCursor).toBe("local-session");
});

describe("bounded chat payload", () => {
  const chat: ChatInfo = { id: "c", title: "History", createdAt: 1 };
  const message = (id: number, text: string): LoomEvent => ({ id, ts: id, kind: "message", payload: { author: "user", text } });
  it("drops raw tool output before message history", () => {
    const events: LoomEvent[] = [message(1, "preserve me"), { id: 2, ts: 2, kind: "tool_call", payload: {
      tool: "shell", summary: "test output", output: "x".repeat(CHAT_MOVE_MAX_BYTES),
    } }];
    const payload = packChatMove({ chat, kind: "echo", events, resume: null });
    expect(payload.dropped).toBe(0);
    expect(payload.events[0]).toEqual(events[0]);
    expect(payload.events[1]!.payload).toMatchObject({ tool: "shell", summary: "test output", outputOmitted: true });
    expect(payload.events[1]!.payload.output).toBeUndefined();
    expect(events[1]!.payload.output).toBeDefined();
  });
  it("keeps a complete recent tail inside the UTF-8 byte limit and rejects malformed imports", () => {
    const payload = packChatMove({ chat, kind: "echo", events: [message(1, "🙂".repeat(CHAT_MOVE_MAX_BYTES)), message(2, "newest")], resume: null });
    expect(payload.dropped).toBe(1); expect(payload.events).toEqual([message(2, "newest")]);
    expect(Buffer.byteLength(JSON.stringify(payload))).toBeLessThanOrEqual(CHAT_MOVE_MAX_BYTES);
    expect(() => parseChatMove({ ...payload, events: [{ kind: "decision" }] })).toThrow();
  });
});
