import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { OrchestraHost } from "../src/core/orchestra.js";
import { ProjectRuntime } from "../src/daemon/runtime.js";
import { waitUntil } from "./helpers.js";
import { deferred, git, open } from "./r3-fix-helpers.js";

let rt: ProjectRuntime;
const releases: (() => void)[] = [];
afterEach(async () => { releases.splice(0).forEach(release => release()); await rt?.close(); vi.restoreAllMocks(); });
const host = () => (rt.orchestra as unknown as { host: OrchestraHost }).host;

it("#3 abort waits for worker preparation and prevents sends after the briefing resolves", async () => {
  for (const phase of ["worktree", "startup", "briefing"]) {
    rt = await open();
    const gate = deferred();
    releases.push(gate.release);
    let entered = false;
    const pause = async () => { entered = true; await gate.promise; };
    if (phase === "briefing") host().briefingFor = async () => { await pause(); return "brief"; };
    if (phase === "startup") {
      const make = host().makeAgent;
      host().makeAgent = (cfg, dir) => {
        const agent = make(cfg, dir);
        const start = agent.start.bind(agent);
        agent.start = async () => { await pause(); await start(); };
        return agent;
      };
    }
    if (phase === "worktree") {
      const create = host().createChat;
      const lock = (rt.orchestra as unknown as { gitLock: { run(fn: () => Promise<void>): Promise<void> } }).gitLock;
      let held = false;
      host().createChat = (title, opts) => {
        if (!held && title.startsWith("🏁")) { held = true; void lock.run(pause); }
        return create(title, opts);
      };
    }
    const run = await rt.orchestra.compare({ prompt: "write:after-abort.txt", entrants: ["a", "b"] });
    await waitUntil(() => entered);
    let stopped = false;
    const abort = rt.orchestra.abort(run.id).then(() => { stopped = true; });
    await new Promise(resolve => setTimeout(resolve, 50));
    const waited = !stopped;
    gate.release();
    await abort;
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(run.tasks.every(t => !t.dir || !fs.existsSync(path.join(t.dir, "after-abort.txt"))), phase).toBe(true);
    expect(waited, phase).toBe(true);
    await rt.close();
  }
});

it("#4 Apply preserves an unrelated merge and its partial resolutions in both branches", async () => {
  rt = await open();
  const dir = rt.info.dir;
  const run = await rt.orchestra.compare({ prompt: "write:result.txt", entrants: ["a", "b"] });
  await waitUntil(() => run.status === "completed");
  const normal = await rt.orchestra.start({ goal: "normal apply", orchestrator: "a", workers: ["b"] });
  await waitUntil(() => normal.status === "waiting_human");
  fs.writeFileSync(path.join(normal.dir, "normal.txt"), "normal result\n");
  git(dir, "checkout", "-qb", "other");
  fs.writeFileSync(path.join(dir, "seed.txt"), "other\n");
  git(dir, "commit", "-qam", "other");
  git(dir, "checkout", "-q", "main");
  fs.writeFileSync(path.join(dir, "seed.txt"), "main\n");
  git(dir, "commit", "-qam", "main");
  try { git(dir, "merge", "other"); } catch { /* expected conflict */ }
  fs.writeFileSync(path.join(dir, "seed.txt"), "precious partial resolution\n");
  const mergeHead = git(dir, "rev-parse", "MERGE_HEAD");
  for (const current of [run, normal]) {
    await expect(rt.orchestra.apply(current.id, current.tasks[0]?.id)).rejects.toThrow(/merge.*progress/);
    expect(git(dir, "rev-parse", "MERGE_HEAD")).toBe(mergeHead);
    expect(fs.readFileSync(path.join(dir, "seed.txt"), "utf8")).toBe("precious partial resolution\n");
  }
});

it("#5 sweeping an aborted run keeps uncommitted task files and failed cleanup directories", async () => {
  rt = await open();
  const run = await rt.orchestra.start({ goal: "partial work", orchestrator: "a", workers: ["b"] });
  await waitUntil(() => run.status === "waiting_human");
  await rt.orchestra.reply(run.id, '```loom\n{"actions":[{"type":"spawn","id":"partial","title":"partial work","agent":"b","prompt":"sleep:5000 work"}]}\n```');
  await waitUntil(() => run.tasks.length === 1 && !!run.tasks[0]!.dir);
  const task = run.tasks[0]!;
  fs.writeFileSync(path.join(task.dir!, "only-copy.txt"), "unfinished work\n");
  await rt.orchestra.abort(run.id);
  const swept = await rt.orchestra.sweep(7, Date.now() + 8 * 86_400_000);
  expect(swept).not.toContain(run.id);
  expect(fs.readFileSync(path.join(task.dir!, "only-copy.txt"), "utf8")).toBe("unfinished work\n");
  fs.unlinkSync(path.join(task.dir!, "only-copy.txt"));
  git(rt.info.dir, "worktree", "lock", run.dir);
  expect(await rt.orchestra.sweep(7, Date.now() + 8 * 86_400_000)).not.toContain(run.id);
  expect(fs.existsSync(path.join(run.dir, "seed.txt"))).toBe(true);
  git(rt.info.dir, "worktree", "unlock", run.dir);
});

it("#7 concurrent goal starts cannot both pass a one-goal limit", async () => {
  rt = await open();
  const gate = deferred();
  releases.push(gate.release);
  const lock = (rt.orchestra as unknown as { gitLock: { run<T>(fn: () => Promise<T>): Promise<T> } }).gitLock;
  const held = lock.run(() => gate.promise);
  const first = rt.orchestra.start({ goal: "first", orchestrator: "a", workers: ["b"] });
  await new Promise(resolve => setTimeout(resolve, 100));
  const second = rt.orchestra.start({ goal: "second", orchestrator: "a", workers: ["b"] });
  const results = Promise.allSettled([first, second]);
  gate.release();
  await held;
  expect((await results).filter(r => r.status === "fulfilled")).toHaveLength(1);
});

it("#8 failed hidden-ref push clears moving durably and allows the source to continue", async () => {
  rt = await open();
  const run = await rt.orchestra.start({ goal: "inspect", orchestrator: "a", workers: ["b"] });
  await waitUntil(() => run.status === "waiting_human");
  await expect(rt.orchestra.moveOut(run.id, "runner", { graceMs: 0 })).rejects.toThrow();
  expect(run.moving).toBeFalsy();
  const stored = JSON.parse(fs.readFileSync(path.join(rt.info.dir, ".loom", "orchestra", `${run.id}.json`), "utf8"));
  expect(stored.moving).toBeFalsy();
  const round = run.round;
  await rt.orchestra.reply(run.id, "continue here");
  await waitUntil(() => run.round > round);
  await rt.orchestra.abort(run.id);
  const race = await rt.orchestra.compare({ prompt: "sleep:1000 write:recovered.txt", entrants: ["a", "b"] });
  await waitUntil(() => race.tasks.every(t => !!t.dir));
  await expect(rt.orchestra.moveOut(race.id, "runner", { graceMs: 0 })).rejects.toThrow();
  expect(race.moving).toBeFalsy();
  await waitUntil(() => race.status === "completed");
  expect(race.tasks.every(t => t.status === "done" && t.attempts === 2)).toBe(true);
});
