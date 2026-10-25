/**
 * Team auto-orchestration, end to end.
 *
 * Alice and Bob each run Loom on their own machine with their own agents, and
 * meet on a real `loom hub`; origin is a real bare repo. Bob's daemon is a
 * shared runner and the repo's reviewed policy allows shared runners. Alice
 * posts ONE goal on her laptop: her orchestrator sees Bob's agent as a
 * `team:<kind>` worker, splits the goal, and one task runs on Bob's machine —
 * claimed by his runner without anyone clicking — with Bob's own agent. Its
 * commits come back through origin and merge into Alice's integration branch,
 * next to the task her own agent did: one goal, two machines, one branch.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { registerAgentKind } from "../src/adapters/index.js";
import { AdapterBase } from "../src/adapters/base.js";
import { registerProject, unregisterProject, writeProjectConfig } from "../src/core/registry.js";
import type { RunnerConfig } from "../src/daemon/runner.js";
import { ProjectRuntime } from "../src/daemon/runtime.js";
import { TeamLink } from "../src/daemon/team.js";
import { startHubServer } from "../src/hub/server.js";
import type { SendInput } from "../src/types.js";
import { tmpDir, waitUntil } from "./helpers.js";

const git = (dir: string, ...a: string[]) => execFileSync("git", a, { cwd: dir, encoding: "utf8" });
const loom = (actions: unknown[]) => "```loom\n" + JSON.stringify({ actions }) + "\n```";

// Alice's orchestrator: plans one task for her own writer and one for a teammate's
const plan: Array<(input: string) => string> = [];
const orchestratorSaw: string[] = [];
class Conductor extends AdapterBase {
  async available() { return true; }
  async start() {}
  async stop() {}
  async interrupt() {}
  async diff() { return ""; }
  async send(input: SendInput) {
    this._busy = true;
    orchestratorSaw.push(`${input.briefing ?? ""}\n${input.text}`);
    await new Promise((r) => setTimeout(r, 5));
    const next = plan.shift();
    this.emit({ kind: "message", payload: { text: next ? next(input.text) : loom([{ type: "done", summary: "done" }]) } });
    this._busy = false;
  }
}
registerAgentKind("ta-conductor", (cfg, dir) => new Conductor(cfg.id, "ta-conductor", dir));

/** Writes "write:<path>:<who>" files — the same agent kind on both machines. */
const wroteOn: string[] = [];
class Writer extends AdapterBase {
  async available() { return true; }
  async start() {}
  async stop() {}
  async interrupt() {}
  async diff() { return ""; }
  async send(input: SendInput) {
    this._busy = true;
    for (const m of input.text.matchAll(/write:([\w./-]+):(\w+)/g)) {
      const f = path.join(this.projectDir, m[1]!);
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, `written by ${m[2]}\n`);
      wroteOn.push(this.projectDir);
      this.emit({ kind: "file_edit", payload: { path: m[1] } });
    }
    this.emit({ kind: "message", payload: { text: "done — wrote it" } });
    this.emit({ kind: "run_complete", payload: { durationMs: 1, costUsd: 0.02 } });
    this._busy = false;
  }
}
registerAgentKind("ta-writer", (cfg, dir) => new Writer(cfg.id, "ta-writer", dir));

let hub: Awaited<ReturnType<typeof startHubServer>>;
let origin = "";
let teamId = "";
let laptop: ProjectRuntime;
let LA: TeamLink; // alice
let LB: TeamLink; // bob, a shared runner
let bobRts: ProjectRuntime[] = [];
let oldPath: string | undefined;
const bobRunner: RunnerConfig = { enabled: true, shared: true, capacity: 2, isolation: "inline", kinds: [] };

beforeAll(async () => {
  process.env.LOOM_HOME = tmpDir("home-team-auto");
  process.env.LOOM_NO_NOTIFY = "1";
  process.env.LOOM_NO_PUSH = "1";
  const bin = tmpDir("ta-bin");
  fs.writeFileSync(path.join(bin, "gh"), `#!/usr/bin/env node\nconsole.log(process.argv.includes("create") ? "https://github.com/acme/app/pull/7" : "[]");\n`, { mode: 0o755 });
  oldPath = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${process.env.PATH}`;

  hub = await startHubServer({ port: 0, secret: "ta" });
  const seed = tmpDir("ta-seed");
  git(seed, "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(seed, ".gitignore"), ".loom/\n");
  // the repo's reviewed policy lets teammates' runners take its work
  fs.writeFileSync(path.join(seed, "loom.team.json"), JSON.stringify({ runners: { shared: true } }));
  git(seed, "add", "-A");
  git(seed, "-c", "user.name=s", "-c", "user.email=s@s", "commit", "-qm", "seed");
  origin = tmpDir("ta-origin");
  git(origin, "init", "-q", "--bare", "-b", "main");
  git(seed, "remote", "add", "origin", origin);
  git(seed, "push", "-q", "origin", "main");

  // alice's laptop: her orchestrator and her own writer
  const dir = tmpDir("ta-laptop");
  git(path.dirname(dir), "clone", "-q", origin, dir);
  git(dir, "config", "loom.repo", "acme/app");
  git(dir, "config", "user.email", "alice@t");
  git(dir, "config", "user.name", "alice");
  writeProjectConfig(dir, {
    name: "app",
    agents: [
      { id: "conductor", kind: "ta-conductor", role: "orchestrator" },
      { id: "writer", kind: "ta-writer", role: "worker" },
    ],
    brain: { extractor: "off" },
  });
  laptop = await ProjectRuntime.open(registerProject(dir, "app"));
  LA = new TeamLink({ runtimes: () => [laptop], broadcast: () => {}, statePath: path.join(tmpDir("ta-state-alice"), "team.json") });
  LA.attachRuntime(laptop);
  await LA.signIn(hub.url, { github: "alice", secret: "ta" });
  teamId = (await LA.createTeam("Acme")).id;
  await LA.share(laptop, teamId);

  // bob: joins from an invite and runs his daemon as a shared runner with his own agent
  LB = new TeamLink({
    runtimes: () => bobRts,
    broadcast: () => {},
    statePath: path.join(tmpDir("ta-state-bob"), "team.json"),
    openProject: async (d: string, name: string) => {
      const rt = await ProjectRuntime.open(registerProject(d, name));
      bobRts.push(rt);
      LB.attachRuntime(rt);
      return rt;
    },
    closeProject: async (rt: ProjectRuntime) => {
      bobRts = bobRts.filter((r) => r !== rt);
      await rt.close();
      unregisterProject(rt.info.id);
    },
    runnerCloneUrl: () => origin,
    runnerKinds: async () => ["ta-writer"],
    runnerConfig: () => bobRunner,
  });
  await LB.join((await LA.invite(teamId)).link, { github: "bob", secret: "ta" });
  await LB.startRunner();
  // the runner registers on its first tick; a goal started before that would simply stay solo
  await waitUntil(async () => { await LB.runner!.tick(); return (await LA.runnersView(laptop)).runners.some((r) => r.github === "bob" && r.online); }, { timeoutMs: 20_000 });
}, 60_000);

afterAll(async () => {
  process.env.PATH = oldPath;
  for (const l of [LA, LB]) await l?.stop();
  for (const rt of bobRts) await rt.close();
  await laptop?.close();
  await hub.close();
});

describe("team auto-orchestration", () => {
  it("loom team auto says it's ready, which teammate agents a goal gets, and what's still missing", async () => {
    const st = await LA.teamAutoStatus(laptop);
    expect(st).toMatchObject({ shared: true, policyShared: true, ready: true, workers: ["team:ta-writer"] });
    expect(st.teammates).toEqual([{ github: "bob", kinds: ["ta-writer"], online: true }]);
    // alice hasn't turned her own runner on, so bob's goals can't use her agents yet
    expect(st.myRunner.running).toBe(false);
    expect(st.missing.join(" ")).toMatch(/turn on your shared runner/);
  });

  it("one goal on alice's laptop runs a task on bob's machine with bob's agent, and both land in one branch", async () => {
    plan.push(() => loom([
      { type: "spawn", id: "t1", title: "alice's part", agent: "writer", prompt: "write:src/alice.ts:alice", touches: ["src/alice.ts"] },
      { type: "spawn", id: "t2", title: "bob's part", agent: "team:ta-writer", prompt: "write:src/bob.ts:bob", touches: ["src/bob.ts"] },
    ]));
    // after that: keep waiting while a task runs, finish once both are in
    let runId = "";
    const waitOrDone = () => laptop.orchestra.get(runId)!.tasks.some((t) => t.status === "running" || t.status === "pending")
      ? loom([]) : loom([{ type: "done", summary: "both parts in" }]);
    for (let i = 0; i < 6; i++) plan.push(waitOrDone);

    const run = await laptop.orchestra.start({ goal: "Add both parts" });
    runId = run.id;
    // bob's agent joined the run as a teammate worker, and the orchestrator was told so
    expect(run.workers).toContain("team:ta-writer");
    await waitUntil(() => orchestratorSaw.some((s) => /team:ta-writer.*teammate's machine/.test(s)), { timeoutMs: 10_000 });

    // nobody clicks: bob's runner claims the task on its own (the tick is its 15s poll, sooner)
    await waitUntil(async () => { await LB.runner!.tick(); return laptop.orchestra.get(run.id)!.status === "completed"; }, { timeoutMs: 40_000, intervalMs: 300 })
      .catch((e) => { throw new Error(JSON.stringify({ run: laptop.orchestra.get(run.id), runner: LB.runner?.lastError }), { cause: e }); });

    const done = laptop.orchestra.get(run.id)!;
    expect(done.tasks.map((t) => [t.id, t.status]), JSON.stringify(done.tasks.map((t) => ({ id: t.id, status: t.status, error: t.error, result: t.result })))).toEqual([["t1", "done"], ["t2", "done"]]);
    // bob's task really ran on bob's machine — in his runner's clone, not alice's worktree
    expect(wroteOn.some((d) => d.includes(path.join("runner", "work")))).toBe(true);
    const t2 = done.tasks.find((t) => t.id === "t2")!;
    expect(t2.result).toMatch(/bob's machine/);
    expect(t2.files).toEqual(["src/bob.ts"]);
    // one integration branch holds both machines' work
    expect(git(laptop.info.dir, "show", `${done.branch}:src/alice.ts`)).toBe("written by alice\n");
    expect(git(laptop.info.dir, "show", `${done.branch}:src/bob.ts`)).toBe("written by bob\n");
    // and the task's job is settled on the hub
    const jobs = await (LA as unknown as { hub(): { jobs(t: string): Promise<Array<{ kind: string; state: string; runnerGithub?: string }>> } }).hub().jobs(teamId);
    expect(jobs.find((j) => j.kind === "task")).toMatchObject({ state: "done", runnerGithub: "bob" });
  }, 60_000);

  it("a follow-up to a teammate's task runs on their machine on top of the first attempt", async () => {
    plan.length = 0;
    let runId = "", sent = false;
    plan.push(() => loom([{ type: "spawn", id: "t1", title: "bob's part", agent: "team:ta-writer", prompt: "write:docs/first.md:bob", touches: ["docs/**"] }]));
    const next = () => {
      const t = laptop.orchestra.get(runId)!.tasks[0]!;
      if (t.status === "running" || t.status === "pending") return loom([]);
      if (!sent) { sent = true; return loom([{ type: "send", task: "t1", message: "Also write:docs/second.md:bob" }]); }
      return loom([{ type: "done", summary: "both" }]);
    };
    for (let i = 0; i < 8; i++) plan.push(next);
    const run = await laptop.orchestra.start({ goal: "Bob's two files" });
    runId = run.id;
    await waitUntil(async () => { await LB.runner!.tick(); return laptop.orchestra.get(run.id)!.status === "completed"; }, { timeoutMs: 40_000, intervalMs: 300 })
      .catch((e) => { const r = laptop.orchestra.get(run.id)!; throw new Error(JSON.stringify({ status: r.status, error: r.error, question: r.question, tasks: r.tasks.map((t) => ({ s: t.status, a: t.attempts, q: t.queued, e: t.error, r: t.result })) }), { cause: e }); });
    const done = laptop.orchestra.get(run.id)!;
    expect(done.tasks[0]).toMatchObject({ status: "done", attempts: 2 });
    expect(git(laptop.info.dir, "show", `${done.branch}:docs/first.md`)).toBe("written by bob\n");
    expect(git(laptop.info.dir, "show", `${done.branch}:docs/second.md`)).toBe("written by bob\n");
  }, 60_000);

  it("a task no teammate's machine takes goes back to the orchestrator, and its job is cancelled", async () => {
    process.env.LOOM_TEAM_TASK_UNCLAIMED_MS = "1500";
    await LB.stopRunner(); // bob closes his laptop right after the goal starts
    plan.length = 0;
    plan.push(() => loom([{ type: "spawn", id: "t1", title: "bob's part", agent: "team:ta-writer", prompt: "write:src/late.ts:bob", touches: ["src/late.ts"] }]));
    for (let i = 0; i < 4; i++) plan.push(() => loom([]));
    const run = await laptop.orchestra.start({ goal: "A part for bob" });
    try {
    expect(run.workers).toContain("team:ta-writer");
    await waitUntil(() => laptop.orchestra.get(run.id)!.tasks[0]?.status === "failed", { timeoutMs: 20_000 })
      .catch(async (e) => { const js = await (LA as unknown as { hub(): { jobs(t: string): Promise<unknown[]> } }).hub().jobs(teamId); throw new Error(JSON.stringify({ run: laptop.orchestra.get(run.id), jobs: js }).slice(0, 3000), { cause: e }); });
    expect(laptop.orchestra.get(run.id)!.tasks[0]!.error).toMatch(/no teammate's machine took it/);
    const jobs = await (LA as unknown as { hub(): { jobs(t: string): Promise<Array<{ kind: string; state: string; createdAt: number }>> } }).hub().jobs(teamId);
    expect(jobs.filter((j) => j.kind === "task").sort((a, b) => b.createdAt - a.createdAt)[0]).toMatchObject({ state: "cancelled" });
    } finally {
      await laptop.orchestra.abort(run.id);
      delete process.env.LOOM_TEAM_TASK_UNCLAIMED_MS;
    }
  }, 30_000);

  it("a goal stays on this machine when the caller says team: false", async () => {
    plan.length = 0;
    plan.push(() => loom([{ type: "done", summary: "nothing to do" }]));
    const run = await laptop.orchestra.start({ goal: "Solo", team: false });
    expect(run.workers.some((w) => w.startsWith("team:"))).toBe(false);
    await waitUntil(() => laptop.orchestra.get(run.id)!.status === "completed", { timeoutMs: 10_000 });
  });
});
