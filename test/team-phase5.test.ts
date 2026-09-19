/**
 * Loom Teams, Phase 5 — runners, end to end.
 *
 * Alice has a laptop (a ProjectRuntime + Team Link) and a runner (a second Team
 * Link on its own device, opening each goal's fresh clone as its own project).
 * Bob is a teammate. They meet on a real `loom hub`; origin is a real bare repo;
 * GitHub is a `gh` stub on PATH for the orchestra and a fake for landing.
 *
 * Proves: pairing makes a device of the same member a runner (D74); "Start on
 * runner" runs a goal there in a fresh clone that's removed when the goal lands
 * (D67, D70, D76); Land reaches a goal on the runner (D56); "Continue on
 * runner" moves a running goal at a safe point with its tasks' work (D75), and
 * "Bring back" returns it (D76); a teammate can't use a runner that isn't
 * shared, nor a shared one the repo's policy doesn't allow (D68); the runner
 * takes its owner's stuck goal while they're away (D69).
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { registerAgentKind } from "../src/adapters/index.js";
import { AdapterBase } from "../src/adapters/base.js";
import { registerProject, unregisterProject, writeProjectConfig } from "../src/core/registry.js";
import type { Exec } from "../src/daemon/landing.js";
import type { RunnerConfig } from "../src/daemon/runner.js";
import { ProjectRuntime } from "../src/daemon/runtime.js";
import { TeamLink } from "../src/daemon/team.js";
import { startHubServer } from "../src/hub/server.js";
import type { SendInput } from "../src/types.js";
import { tmpDir, waitUntil } from "./helpers.js";

const git = (dir: string, ...a: string[]) => execFileSync("git", a, { cwd: dir, encoding: "utf8" });
const loom = (actions: unknown[]) => "```loom\n" + JSON.stringify({ actions }) + "\n```";

const scripts: Record<string, Array<(input: string) => string>> = { laptop: [], runner: [] };
const told: Record<string, string[]> = { laptop: [], runner: [] };
for (const where of ["laptop", "runner"]) {
  class Conductor extends AdapterBase {
    async available() {
      return true;
    }
    async start() {}
    async stop() {}
    async interrupt() {}
    async diff() {
      return "";
    }
    async send(input: SendInput) {
      this._busy = true;
      told[where]!.push(input.text);
      await new Promise((r) => setTimeout(r, 5));
      const next = scripts[where]!.shift();
      this.emit({ kind: "message", payload: { text: next ? next(input.text) : loom([{ type: "done", summary: "done" }]) } });
      this._busy = false;
    }
  }
  registerAgentKind(`p5-conductor-${where}`, (cfg, dir) => new Conductor(cfg.id, `p5-conductor-${where}`, dir));
}

/** Writes "write:<path>:<n>" files; "slow:<ms>" keeps working (so a move can catch it mid-task). */
class Writer extends AdapterBase {
  private stopped = false;
  async available() {
    return true;
  }
  async start() {}
  async stop() {}
  async interrupt() {
    this.stopped = true;
  }
  async diff() {
    return "";
  }
  async send(input: SendInput) {
    this._busy = true;
    this.stopped = false;
    for (const m of input.text.matchAll(/write:([\w./-]+):(\d+)/g)) {
      const f = path.join(this.projectDir, m[1]!);
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, Array.from({ length: Number(m[2]) }, (_, i) => `line ${i}`).join("\n") + "\n");
      this.emit({ kind: "file_edit", payload: { path: m[1] } });
    }
    const slow = /slow:(\d+)/.exec(input.text);
    if (slow) for (let t = 0; t < Number(slow[1]) && !this.stopped; t += 50) await new Promise((r) => setTimeout(r, 50));
    this.emit({ kind: "message", payload: { text: this.stopped ? "interrupted" : "done" } });
    this._busy = false;
  }
}
registerAgentKind("p5-writer", (cfg, dir) => new Writer(cfg.id, "p5-writer", dir));

// ── a fake GitHub for landing (the orchestra's `pr create` uses the stub on PATH) ──

let origin = "";
const merged = new Set<number>();
const ghCalls: string[][] = [];
let runnerRts: ProjectRuntime[] = [];
function prBranch(n: number): string | null {
  for (const rt of [...runnerRts, M.laptop!]) for (const r of rt.orchestra.list()) if (r.landing?.pr === n) return rt.orchestra.prBranch(r);
  return null;
}
const fakeGh: Exec = async (cmd, args, cwd, opts) => {
  if (cmd !== "gh") {
    try {
      return { code: 0, out: execFileSync(cmd, args, { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], timeout: opts?.timeoutMs ?? 60_000 }), err: "" };
    } catch (e) {
      const x = e as { status?: number; stdout?: string; stderr?: string };
      return { code: x.status ?? 1, out: String(x.stdout ?? ""), err: String(x.stderr ?? "") };
    }
  }
  ghCalls.push(args);
  const ok = (o: unknown) => ({ code: 0, out: typeof o === "string" ? o : JSON.stringify(o), err: "" });
  const n = Number(args[2]);
  if (args[0] === "pr" && args[1] === "view") {
    const b = prBranch(n);
    if (!b) return { code: 1, out: "", err: "no pr" };
    return ok({ state: merged.has(n) ? "MERGED" : "OPEN", headRefOid: git(origin, "rev-parse", `refs/heads/${b}`).trim() });
  }
  if (args[0] === "pr" && args[1] === "checks") return ok([{ name: "test", bucket: "pass" }]);
  if (args[0] === "pr" && args[1] === "diff") return ok("");
  // the repo has a merge queue, so Land takes the auto-merge path these tests watch for (the train is Phase 6's)
  if (args[0] === "api" && args.some((a) => /\/rules\/branches\//.test(a))) return ok([{ type: "merge_queue" }]);
  if (args[0] === "api") return ok("[]");
  return ok("");
};

// ── the team ──

let hub: Awaited<ReturnType<typeof startHubServer>>;
let seed = "";
let oldPath: string | undefined;
let teamId = "";
const M: { laptop?: ProjectRuntime } = {};
let LA: TeamLink; // alice's laptop
let LR: TeamLink; // alice's runner
let LB: TeamLink; // bob
const runnerCfg: RunnerConfig = { enabled: true, shared: false, capacity: 2, isolation: "inline", kinds: [] };

async function openProject(dir: string, name: string): Promise<ProjectRuntime> {
  const info = registerProject(dir, name);
  const rt = await ProjectRuntime.open(info);
  runnerRts.push(rt);
  LR.attachRuntime(rt);
  return rt;
}

async function closeProject(rt: ProjectRuntime): Promise<void> {
  runnerRts = runnerRts.filter((r) => r !== rt);
  await rt.close();
  unregisterProject(rt.info.id);
}

const jobs = async () => (await LA.runnersView(M.laptop!)).jobs;

beforeAll(async () => {
  process.env.LOOM_HOME = tmpDir("home-p5");
  process.env.LOOM_NO_NOTIFY = "1";
  process.env.LOOM_NO_PUSH = "1";
  const bin = tmpDir("p5-bin");
  fs.writeFileSync(
    path.join(bin, "gh"),
    `#!/bin/sh\ncase "$*" in\n  *"pr create"*) n=$(cat "${bin}/n" 2>/dev/null || echo 50); n=$((n+1)); echo $n > "${bin}/n"; echo "https://github.com/acme/app/pull/$n" ;;\n  *) echo "[]" ;;\nesac\n`,
    { mode: 0o755 },
  );
  oldPath = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${process.env.PATH}`;

  hub = await startHubServer({ port: 0, secret: "p5" });
  seed = tmpDir("p5-seed");
  git(seed, "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(seed, ".gitignore"), ".loom/\n");
  fs.writeFileSync(path.join(seed, "loom.team.json"), JSON.stringify({ runners: { shared: false } }));
  git(seed, "add", "-A");
  git(seed, "-c", "user.name=s", "-c", "user.email=s@s", "commit", "-qm", "seed");
  origin = tmpDir("p5-origin");
  git(origin, "init", "-q", "--bare", "-b", "main");
  git(seed, "remote", "add", "origin", origin);
  git(seed, "push", "-q", "origin", "main");
  git(origin, "symbolic-ref", "HEAD", "refs/heads/main");

  // alice's laptop
  const dir = tmpDir("p5-laptop");
  git(path.dirname(dir), "clone", "-q", origin, dir);
  git(dir, "config", "loom.repo", "acme/app");
  git(dir, "config", "user.email", "alice@t");
  git(dir, "config", "user.name", "alice");
  git(dir, "remote", "set-head", "origin", "main");
  writeProjectConfig(dir, {
    name: "app",
    agents: [
      { id: "conductor", kind: "p5-conductor-laptop", role: "orchestrator" },
      { id: "writer", kind: "p5-writer", role: "worker" },
    ],
    brain: { extractor: "off" },
    git: { delivery: "pr" },
  });
  M.laptop = await ProjectRuntime.open(registerProject(dir, "app"));
  LA = new TeamLink({ runtimes: () => [M.laptop!], broadcast: () => {}, statePath: path.join(tmpDir("p5state-laptop"), "team.json"), landingExec: fakeGh });
  LA.attachRuntime(M.laptop);
  await LA.signIn(hub.url, { github: "alice", secret: "p5" });
  teamId = (await LA.createTeam("Acme")).id;
  await LA.share(M.laptop, teamId);

  // alice's runner, paired from the laptop (D74)
  LR = new TeamLink({
    runtimes: () => runnerRts,
    broadcast: () => {},
    statePath: path.join(tmpDir("p5state-runner"), "team.json"),
    landingExec: fakeGh,
    openProject,
    closeProject,
    runnerCloneUrl: () => origin,
    runnerKinds: async () => ["p5-conductor-runner", "p5-writer"],
    runnerConfig: () => runnerCfg,
    runnerAwayMs: 0,
  });
  await LR.joinAsRunner(LA.pairRunnerLink(), { secret: "p5" });

  // bob
  LB = new TeamLink({ runtimes: () => [], broadcast: () => {}, statePath: path.join(tmpDir("p5state-bob"), "team.json") });
  await LB.join((await LA.invite(teamId)).link, { github: "bob", secret: "p5" });
}, 60_000);

afterAll(async () => {
  process.env.PATH = oldPath;
  for (const l of [LA, LR, LB]) await l?.stop();
  for (const rt of runnerRts) await rt.close();
  await M.laptop?.close();
  await hub.close();
});

describe("Phase 5: runners", () => {
  it("pairing makes one of alice's devices a runner, visible to her laptop (D74)", async () => {
    const v = await LA.runnersView(M.laptop!);
    expect(v.runners).toHaveLength(1);
    expect(v.runners[0]).toMatchObject({ github: "alice", mine: true, shared: false, kinds: ["p5-conductor-runner", "p5-writer"] });
    expect(LR.runner?.running).toBe(true);
  });

  let startedRun = "";
  it("Start on runner: the goal runs in a fresh clone there, Land reaches it, and the clone goes when it lands (D67, D70, D76)", async () => {
    scripts.runner.push(() => loom([{ type: "spawn", id: "t1", title: "feature", agent: "p5-writer", prompt: "write:src/feature.ts:5", touches: ["src/feature.ts"] }]));
    scripts.runner.push(() => loom([{ type: "done", summary: "feature on the runner" }]));
    const { jobId } = await LA.startOnRunner(M.laptop!, { goal: "Add the feature" });
    await LR.runner!.tick();
    await waitUntil(async () => (await jobs()).find((j) => j.id === jobId)?.progress?.landing?.pr !== undefined, { timeoutMs: 20_000 });
    const j = (await jobs()).find((x) => x.id === jobId)!;
    expect(j).toMatchObject({ state: "claimed", kind: "start", runnerGithub: "alice", goal: "Add the feature" });
    expect(j.progress).toMatchObject({ status: "completed" });
    startedRun = String(j.progress!.runId);
    const rt = runnerRts[0]!;
    expect(rt.info.dir).toContain(path.join("runner", "work", jobId));
    expect(rt.runnerMode).toBe(true);
    const pr = Number((j.progress as { landing: { pr: number } }).landing.pr);
    const branch = rt.orchestra.get(startedRun)!.branch;
    expect(git(origin, "show", `${branch}:src/feature.ts`).split("\n").filter(Boolean)).toHaveLength(5);

    // the owner clicks Land on the laptop: it goes to the runner as a job
    const land = await LA.landOnRunner(M.laptop!, startedRun);
    await LR.runner!.tick();
    await waitUntil(async () => (await jobs()).find((x) => x.id === land.jobId)?.state === "done");
    expect(ghCalls.some((c) => c[0] === "pr" && c[1] === "merge" && c.includes("--auto"))).toBe(true);

    // GitHub merges it; the runner sees it land, finishes the job, and removes the clone
    merged.add(pr);
    await LR.landingFor(rt).tick();
    await LR.runner!.tick();
    await waitUntil(async () => (await jobs()).find((x) => x.id === jobId)?.state === "done");
    expect(fs.existsSync(path.join(process.env.LOOM_HOME!, "runner", "work", jobId))).toBe(false);
    expect(runnerRts).toHaveLength(0);
  });

  let movedRun = "";
  it("Continue on runner moves a running goal at a safe point, its task's work included (D75)", async () => {
    scripts.laptop.push(() => loom([{ type: "spawn", id: "t1", title: "slow work", agent: "writer", prompt: "write:src/slow.ts:7 slow:20000", touches: ["src/slow.ts"] }]));
    const run = await M.laptop!.orchestra.start({ goal: "Slow goal", orchestrator: "conductor" });
    movedRun = run.id;
    await waitUntil(() => fs.existsSync(path.join(M.laptop!.orchestra.get(run.id)!.tasks[0]?.dir ?? "/nope", "src/slow.ts")), { timeoutMs: 10_000 });

    scripts.runner.push((input) => {
      expect(input).toContain("moved here from");
      return loom([]); // t1 resumes on its own; nothing new to plan
    });
    scripts.runner.push(() => loom([{ type: "done", summary: "finished on the runner" }]));
    const { jobId } = await LA.continueOnRunner(M.laptop!, run.id, { graceMs: 300 });
    const here = M.laptop!.orchestra.get(run.id)!;
    expect(here.status).toBe("moved");
    expect(git(origin, "show", `refs/loom/run/${run.id}/t1:src/slow.ts`).split("\n").filter(Boolean)).toHaveLength(7);

    await LR.runner!.tick();
    // "completed" flips before delivery pushes: wait for the PR, so the branch is on origin
    await waitUntil(async () => (await jobs()).find((j) => j.id === jobId)?.progress?.landing?.pr !== undefined, { timeoutMs: 20_000 });
    const there = runnerRts[0]!.orchestra.get(run.id)!;
    expect(there.tasks[0]).toMatchObject({ id: "t1", status: "done" });
    expect(told.runner.some((t) => t.includes("moved to another machine mid-task"))).toBe(false); // that went to the worker, not the orchestrator
    expect(told.runner.some((t) => t.includes("moved here from"))).toBe(true);
    expect(scripts.runner).toHaveLength(0);
    expect(git(origin, "show", `${there.branch}:src/slow.ts`).split("\n").filter(Boolean)).toHaveLength(7); // the laptop's work reached the PR
  });

  it("Bring back returns the goal to the laptop (D76)", async () => {
    const { jobId } = await LA.bringBack(M.laptop!, movedRun);
    await LR.runner!.tick();
    await waitUntil(async () => (await jobs()).find((j) => j.id === jobId)?.state === "done");
    await waitUntil(() => M.laptop!.orchestra.get(movedRun)?.status === "completed");
    const home = M.laptop!.orchestra.get(movedRun)!;
    expect(home.landing?.pr).toBeGreaterThan(0);
    expect(fs.readFileSync(path.join(home.dir, "src/slow.ts"), "utf8").split("\n").filter(Boolean)).toHaveLength(7);
    // the runner let go of it
    await waitUntil(async () => !(await jobs()).some((j) => j.kind === "continue" && j.state === "claimed"));
    expect(runnerRts).toHaveLength(0);
  });

  it("a teammate can't use a runner that isn't shared, nor one the repo's policy doesn't allow (D68)", async () => {
    const hubBob = hub.hub.client(hub.hub.signIn("bob").token);
    const bobDevice = (await hubBob.registerDevice({ label: "bob", sealPub: "s", signPub: "bob-sign" })).id;
    const runnerId = String((await LA.runnersView(M.laptop!)).runners[0]!.deviceId);
    const sealed = { v: 1, c: "x" };
    await expect(hubBob.createJob(teamId, { repo: "acme/app", kind: "start", target: runnerId, sealed, deviceId: bobDevice })).rejects.toThrow(/isn't shared/);

    runnerCfg.shared = true;
    await LR.runner!.register();
    const job = await hubBob.createJob(teamId, { repo: "acme/app", kind: "start", target: runnerId, sealed, deviceId: bobDevice });
    await LR.runner!.tick();
    await waitUntil(async () => (await hubBob.jobs(teamId)).find((j) => j.id === job.id)?.state === "failed");
    expect((await hubBob.jobs(teamId)).find((j) => j.id === job.id)!.error).toMatch(/doesn't allow shared runners/);
    runnerCfg.shared = false;
    await LR.runner!.register();
  });

  it("the runner takes its owner's stuck goal while they're away (D69)", async () => {
    const home = M.laptop!.orchestra.get(movedRun)!;
    const laptopHub = hub.hub.client(hub.hub.signIn("alice").token);
    const laptopDevice = (LA.status() as { device: string }).device;
    scripts.runner.push(() => loom([{ type: "spawn", id: "t1", title: "fix", agent: "p5-writer", prompt: "write:src/fix.ts:2", touches: ["src/fix.ts"] }]));
    scripts.runner.push(() => loom([{ type: "done", summary: "fixed while alice was away" }]));
    await laptopHub.appendFeed(teamId, {
      repo: "acme/app",
      type: "goal_needs_someone",
      meta: { pr: home.landing!.pr, url: home.landing!.url, runId: home.id, branch: home.branch, reason: "checks still failing" },
      deviceId: laptopDevice,
    });
    await waitUntil(() => ((LR.status() as { teams: Array<{ feed: Array<{ type: string }> }> }).teams[0]?.feed ?? []).some((e) => e.type === "goal_needs_someone"));
    await LR.runner!.tick(); // sees it, asks for a fix job for itself
    await LR.runner!.tick(); // claims and runs it
    await waitUntil(async () => (await jobs()).some((j) => j.kind === "fix" && j.progress?.status === "completed"), { timeoutMs: 20_000 });
    // pushed to alice's own PR branch (the push lands just after "completed")
    await waitUntil(() => {
      try {
        return git(origin, "show", `${home.branch}:src/fix.ts`).split("\n").filter(Boolean).length === 2;
      } catch {
        return false;
      }
    });
  });
});
