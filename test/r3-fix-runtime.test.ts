import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { ProjectRuntime } from "../src/daemon/runtime.js";
import type { OrchestraHost } from "../src/core/orchestra.js";
import { OPEN_POLICY } from "../src/core/team-policy.js";
import { writeProjectConfig } from "../src/core/registry.js";
import { capture, preview } from "../src/core/checkpoint.js";
import { waitUntil } from "./helpers.js";
import { deferred, git, open } from "./r3-fix-helpers.js";

let rt: ProjectRuntime;
afterEach(async () => { await rt?.close(); });
const replies = () => rt.log.list({ kinds: ["message"] }).filter(e => e.agentId);

it("#1 resumes a refused queued prompt immediately after the budget is raised", async () => {
  rt = await open();
  rt.baton.acquire("a");
  rt.log.append({ kind: "status", agentId: "a", payload: { state: "turn_cost", costUsd: 2 } });
  rt.setBudget("a", 1);
  rt.enqueue({ text: "retained prompt", target: { kind: "agent", agentId: "a" } });
  await waitUntil(() => rt.queue.paused);
  expect(rt.queue.length).toBe(1);
  rt.setBudget("a", 10);
  rt.queue.setPaused(false);
  await rt.drainPromptQueue();
  await waitUntil(() => replies().some(e => String(e.payload.text).includes("retained prompt")), { timeoutMs: 2000 });
  expect(rt.queue.length).toBe(0);
});

it("#2 refuses a forbidden resolved orchestrator before creating a run, and on later turns", async () => {
  rt = await open();
  rt.teamPolicy = { ...OPEN_POLICY, agents: { allow: ["codex"] } };
  await expect(rt.orchestra.start({ goal: "inspect", orchestrator: "a@model", workers: ["b"] })).rejects.toThrow(/policy.*echo/);
  expect(rt.orchestra.list()).toHaveLength(0);
  expect(git(rt.info.dir, "for-each-ref", "refs/heads/loom/orchestra")).toBe("");
  rt.teamPolicy = null;
  const run = await rt.orchestra.start({ goal: "inspect", orchestrator: "a", workers: ["b"] });
  await waitUntil(() => run.status === "waiting_human");
  rt.teamPolicy = { ...OPEN_POLICY, agents: { allow: ["codex"] } };
  await rt.orchestra.reply(run.id, "continue");
  await waitUntil(() => run.status === "failed");
  expect(run.error).toMatch(/policy.*echo/);
});

it("#6 isolates agents added or enabled after opening the project", async () => {
  rt = await open({ git: { worktreePerAgent: true }, agents: [{ id: "a", kind: "echo" }, { id: "b", kind: "echo", enabled: false }] });
  rt.addAgent("echo", { id: "added" });
  rt.setAgentEnabled("b", true);
  writeProjectConfig(rt.info.dir, { ...rt.config, agents: [...rt.config.agents, { id: "reloaded", kind: "echo" }] });
  await waitUntil(() => rt.agents.has("reloaded"));
  for (const id of ["added", "b", "reloaded"]) {
    if (rt.baton.holder()) await rt.handoff(id);
    await rt.sendMessage(`write:${id}.txt`, id);
    await waitUntil(() => replies().some(e => e.agentId === id));
    expect(rt.agentDir(id)).not.toBe(rt.info.dir);
    expect(git(rt.agentDir(id), "rev-parse", "--abbrev-ref", "HEAD")).toBe(`agent/${id}`);
    expect(fs.existsSync(path.join(rt.info.dir, `${id}.txt`))).toBe(false);
    expect(fs.readFileSync(path.join(rt.agentDir(id), `${id}.txt`), "utf8")).toContain(id);
  }
});

it("#9 refuses a chat move while its Orchestra run can still write", async () => {
  rt = await open();
  const chat = rt.createChat("goal").id;
  const gate = deferred();
  const host = (rt.orchestra as unknown as { host: OrchestraHost }).host;
  const make = host.makeAgent;
  let preparing = false;
  host.makeAgent = (cfg, dir) => {
    const agent = make(cfg, dir);
    const start = agent.start.bind(agent);
    agent.start = async () => { preparing = true; await gate.promise; await start(); };
    return agent;
  };
  let exported = false;
  const move = (wait: boolean) => rt.moveChat(chat, true, wait, async () => {
    exported = true;
    return { device: "runner", name: "runner", jobId: "job", at: Date.now() };
  });
  const starting = rt.orchestra.start({ goal: "inspect", chat, orchestrator: "a", workers: ["b"] });
  try {
    await expect(move(false)).rejects.toThrow(/busy/);
    const run = await starting;
    await waitUntil(() => preparing);
    await expect(move(true)).rejects.toThrow(/busy/);
    const abort = rt.orchestra.abort(run.id);
    await expect(move(false)).rejects.toThrow(/busy/);
    gate.release();
    await abort;
    expect(exported).toBe(false);
    await move(false);
    await expect(rt.orchestra.start({ goal: "too late", chat, orchestrator: "a", workers: ["b"] })).rejects.toThrow(/moved/);
  } finally { gate.release(); await starting; }
});

it("#10 chat Stop skips a removed historical agent and interrupts the current one", async () => {
  rt = await open();
  const chat = rt.createChat("shared").id;
  await rt.sendMessage("first", "a", { chat });
  await waitUntil(() => replies().length === 1);
  await rt.handoff("b");
  rt.removeAgent("a");
  await rt.sendMessage("sleep:5000 second", "b", { chat });
  expect(await rt.interrupt({ chat })).toEqual({ interrupted: "b" });
});

it("#11 chat Stop holds the waiting follow-up", async () => {
  rt = await open();
  const chat = rt.createChat("stop").id;
  await rt.sendMessage("sleep:5000 first", "a", { chat });
  rt.enqueue({ text: "follow-up", chat, target: { kind: "agent", agentId: "a" } });
  await rt.interrupt({ chat });
  expect(rt.queue.paused).toBe(true);
  expect(rt.queue.length).toBe(1);
  expect(replies().some(e => String(e.payload.text).includes("follow-up"))).toBe(false);
  await waitUntil(() => !(rt.agent("a") as { busy(): boolean }).busy());
  const gate = deferred();
  const agent = rt.agent("b");
  const start = agent.start.bind(agent);
  let entered = false;
  agent.start = async () => { entered = true; await gate.promise; await start(); };
  const preparingChat = rt.createChat("preparing", { agentId: "b" }).id;
  const pending = rt.sendMessage("write:should-not-run.txt", undefined, { chat: preparingChat });
  const rejected = expect(pending).rejects.toThrow(/cancelled/);
  try {
    await waitUntil(() => entered);
    expect(await rt.interrupt({ chat: preparingChat })).toEqual({ interrupted: "b" });
  } finally { gate.release(); }
  await rejected;
  expect(rt.queue.paused).toBe(true);
  expect(fs.existsSync(path.join(rt.info.dir, "should-not-run.txt"))).toBe(false);
});

it("#12 retries the failed chat's prompt despite interleaved messages", async () => {
  rt = await open();
  const a = rt.createChat("A", { agentId: "a" }).id;
  const b = rt.createChat("B", { agentId: "b" }).id;
  await rt.sendMessage("sleep:300 fail:original A", undefined, { chat: a });
  await rt.sendMessage("unrelated B", undefined, { chat: b });
  await waitUntil(() => rt.log.list({ kinds: ["error"] }).length > 0);
  const result = await rt.retryTurn("b");
  expect(result.retried).toBe("sleep:300 fail:original A");
});

it("#13 captures checkpoints in linked worktrees without changing their index", async () => {
  rt = await open({ git: { worktreePerAgent: true } });
  const dir = rt.agentDir("a");
  fs.writeFileSync(path.join(dir, "seed.txt"), "dirty\n");
  const index = git(dir, "write-tree");
  const cp = await capture(dir, "linked");
  expect(cp).not.toBeNull();
  expect(git(dir, "show", `${cp!.commit}:seed.txt`)).toBe("dirty");
  expect(git(dir, "write-tree")).toBe(index);
  fs.writeFileSync(path.join(dir, "seed.txt"), "later\n");
  expect((await preview(dir, cp!.id)).changed).toContain("seed.txt");
  expect(git(dir, "write-tree")).toBe(index);
});

it("#14 attributes further edits to already modified and untracked files", async () => {
  rt = await open();
  for (const file of ["seed.txt", "new.txt"]) {
    fs.writeFileSync(path.join(rt.info.dir, file), "dirty before\n");
    const count = replies().length;
    await rt.sendMessage(`write:${file}`, "a");
    await waitUntil(() => replies().length > count);
    await waitUntil(() => rt.log.list({ kinds: ["turn_diff"] }).some(e => (e.payload.files as { path: string }[]).some(f => f.path === file)), { timeoutMs: 2000 });
    const diff = rt.log.list({ kinds: ["turn_diff"] }).at(-1)!;
    expect(diff.payload).toMatchObject({ added: 1, removed: 1 });
    expect(diff.payload.patch).toContain("-dirty before");
    expect(diff.payload.patch).toContain("+echo(a) wrote this");
  }
});
