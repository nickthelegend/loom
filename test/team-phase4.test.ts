/**
 * Loom Teams, Phase 4 — "land safely", end to end.
 *
 * Two members (alice, bob), each a real ProjectRuntime + Team Link with their
 * own clone, on a real `loom hub`, with a real bare origin. Orchestrators are
 * scripted, workers write real files, and the reviewer is a scripted agent of
 * another "vendor". GitHub is a fake `gh` that keeps PR state and serves checks
 * computed from the real commits on origin.
 *
 * Proves: a failing required check is rerun once before an agent touches it,
 * a real failure's log tail reopens the goal and the fix is pushed to the same
 * PR (D52–D55); a flake is labelled, not fixed (D53); the cross-vendor review
 * posts `loom/review`, and a high finding sends the goal back (D60, D61); Land
 * brings fresh main in and asks GitHub to merge; merged goals post their cost
 * (D56, D64); out of attempts, a goal needs someone, a teammate adopts it,
 * pushes to the owner's branch, and hands it back (D63); the doctor finds a
 * workflow the merge queue would stall on and opens the fix (D62).
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { registerAgentKind } from "../src/adapters/index.js";
import { AdapterBase } from "../src/adapters/base.js";
import type { OrchestraRun } from "../src/core/orchestra.js";
import { writeProjectConfig } from "../src/core/registry.js";
import type { Exec } from "../src/daemon/landing.js";
import { ProjectRuntime } from "../src/daemon/runtime.js";
import { TeamLink } from "../src/daemon/team.js";
import { startHubServer } from "../src/hub/server.js";
import type { SendInput } from "../src/types.js";
import { tmpDir, waitUntil } from "./helpers.js";

const git = (dir: string, ...a: string[]) => execFileSync("git", a, { cwd: dir, encoding: "utf8" });

// ── scripted agents ──

const scripts: Record<string, Array<(input: string) => string>> = { alice: [], bob: [] };
const told: Record<string, string[]> = { alice: [], bob: [] };
class Scripted extends AdapterBase {
  constructor(id: string, kind: string, dir: string, private who: string) {
    super(id, kind, dir);
  }
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
    told[this.who]!.push(input.text);
    await new Promise((r) => setTimeout(r, 5));
    const next = scripts[this.who]!.shift();
    this.emit({ kind: "message", payload: { text: next ? next(input.text) : "```loom\n{\"actions\":[]}\n```" } });
    this._busy = false;
  }
}
for (const who of ["alice", "bob"]) registerAgentKind(`p4-conductor-${who}`, (cfg, dir) => new Scripted(cfg.id, `p4-conductor-${who}`, dir, who));

/** A worker that writes a file of N lines: "write:<path>:<n>". */
class Writer extends AdapterBase {
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
    for (const m of input.text.matchAll(/write:([\w./-]+):(\d+)/g)) {
      const f = path.join(this.projectDir, m[1]!);
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, Array.from({ length: Number(m[2]) }, (_, i) => `line ${i} of ${m[1]}`).join("\n") + "\n");
      this.emit({ kind: "file_edit", payload: { path: m[1] } });
    }
    this.emit({ kind: "status", payload: { state: "turn_cost", costUsd: 0.5 } });
    this.emit({ kind: "message", payload: { text: "done" } });
    this._busy = false;
  }
}
registerAgentKind("p4-writer", (cfg, dir) => new Writer(cfg.id, "p4-writer", dir));

/** The reviewer, another "vendor": a high finding while the code has no guard, clean after. */
const reviews: string[] = [];
/** Set to hold the reviewer mid-review and force a high finding (the override race). */
let reviewGate: { wait: Promise<void>; high: boolean } | null = null;
class Reviewer extends AdapterBase {
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
    reviews.push(input.text);
    if (reviewGate) await reviewGate.wait;
    const guarded = input.text.includes("guard.ts") && !reviewGate?.high;
    const block = guarded
      ? { summary: "Looks right.", findings: [{ severity: "low", title: "naming nit" }] }
      : { summary: "Missing input check.", findings: [{ severity: "high", title: "No guard on user input", file: "src/app.ts", line: 1, detail: "add src/guard.ts" }] };
    this.emit({ kind: "message", payload: { text: "Reviewed.\n```loom-review\n" + JSON.stringify(block) + "\n```" } });
    this._busy = false;
  }
}
registerAgentKind("p4-reviewer", (cfg, dir) => new Reviewer(cfg.id, "p4-reviewer", dir));

const loom = (actions: unknown[]) => "```loom\n" + JSON.stringify({ actions }) + "\n```";

// ── a fake GitHub ──

interface FakePr {
  n: number;
  branch: string;
  state: "OPEN" | "MERGED" | "CLOSED";
  labels: string[];
  base: string;
}
const prs = new Map<number, FakePr>();
const calls: string[][] = [];
const statuses: Array<{ sha: string; state: string; description: string }> = [];
/** What a check says at a commit, and after how many reruns. */
let checkAt: (pr: FakePr, sha: string, reruns: number) => "pass" | "fail" | "pending" = () => "pass";
const rerunCount = new Map<string, number>();
let rules: unknown = [];

let origin = "";
const headOf = (branch: string) => git(origin, "rev-parse", `refs/heads/${branch}`).trim();

const fakeGh: Exec = async (cmd, args, cwd, opts) => {
  if (cmd !== "gh") {
    try {
      const out = execFileSync(cmd, args, { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], timeout: opts?.timeoutMs ?? 60_000 });
      return { code: 0, out, err: "" };
    } catch (e) {
      const x = e as { status?: number; stdout?: string; stderr?: string };
      return { code: x.status ?? 1, out: String(x.stdout ?? ""), err: String(x.stderr ?? "") };
    }
  }
  calls.push(args);
  const ok = (out: unknown) => ({ code: 0, out: typeof out === "string" ? out : JSON.stringify(out), err: "" });
  const [a, b] = args;
  const n = Number(args[2]);
  const pr = prs.get(n);
  if (a === "pr" && b === "view") return pr ? ok({ state: pr.state, headRefOid: headOf(pr.branch), url: `https://github.com/acme/app/pull/${n}` }) : { code: 1, out: "", err: "no pr" };
  if (a === "pr" && b === "checks") {
    if (!pr) return { code: 1, out: "", err: "no pr" };
    const sha = headOf(pr.branch);
    const state = checkAt(pr, sha, rerunCount.get(`${n}:${sha}`) ?? 0);
    const rows = [{ name: "test", bucket: state, state: state.toUpperCase(), link: `https://github.com/acme/app/actions/runs/${n}${sha.slice(0, 6).replace(/\D/g, "1")}/job/1` }];
    return { code: state === "fail" ? 1 : state === "pending" ? 8 : 0, out: JSON.stringify(rows), err: "" };
  }
  if (a === "run" && b === "rerun") {
    for (const p of prs.values()) {
      const sha = headOf(p.branch);
      if (String(args[2]).startsWith(String(p.n))) rerunCount.set(`${p.n}:${sha}`, (rerunCount.get(`${p.n}:${sha}`) ?? 0) + 1);
    }
    return ok("");
  }
  if (a === "run" && b === "view") return ok("test\tRun tests\t2026-09-19T10:00:00.0000000Z FAIL src/app.test.ts\ntest\tRun tests\t2026-09-19T10:00:01.0000000Z   expected guard\n");
  if (a === "pr" && b === "diff") return pr ? ok(git(origin, "diff", `main...${pr.branch}`)) : { code: 1, out: "", err: "no pr" };
  if (a === "pr" && b === "review") return ok("");
  if (a === "pr" && b === "comment") return ok("");
  if (a === "label") return ok("");
  if (a === "pr" && b === "edit") {
    if (pr && args.includes("--add-label")) pr.labels.push(args[args.indexOf("--add-label") + 1]!);
    if (pr && args.includes("--base")) pr.base = args[args.indexOf("--base") + 1]!;
    return ok("");
  }
  if (a === "pr" && b === "merge") return pr ? ok("") : { code: 1, out: "", err: "no pr" };
  if (a === "pr" && b === "create") {
    const head = args[args.indexOf("--head") + 1]!;
    const num = 100 + prs.size;
    prs.set(num, { n: num, branch: head, state: "OPEN", labels: [], base: args[args.indexOf("--base") + 1] ?? "main" });
    return ok(`https://github.com/acme/app/pull/${num}\n`);
  }
  const apiPath = a === "api" ? (args.find((x) => x.startsWith("repos/")) ?? "") : "";
  if (/\/statuses\//.test(apiPath)) {
    const f = (k: string) => args.find((x) => x.startsWith(`${k}=`))?.slice(k.length + 1) ?? "";
    statuses.push({ sha: apiPath.split("/").pop()!, state: f("state"), description: f("description") });
    return ok("{}");
  }
  if (/\/rules\/branches\//.test(apiPath)) return ok(rules);
  return { code: 1, out: "", err: `fake gh: unhandled ${args.join(" ")}` };
};

// ── the team ──

let hub: Awaited<ReturnType<typeof startHubServer>>;
let seed = "";
let oldPath: string | undefined;
const M: Record<string, { rt: ProjectRuntime; link: TeamLink; dir: string }> = {};
const L = (who: string) => M[who]!.link.landingFor(M[who]!.rt);

async function member(who: "alice" | "bob") {
  const dir = tmpDir(`p4-${who}`);
  git(path.dirname(dir), "clone", "-q", origin, dir);
  git(dir, "config", "loom.repo", "acme/app");
  git(dir, "config", "user.email", `${who}@t`);
  git(dir, "config", "user.name", who);
  writeProjectConfig(dir, {
    name: `app-${who}`,
    agents: [
      { id: "conductor", kind: `p4-conductor-${who}`, role: "orchestrator" },
      { id: "writer", kind: "p4-writer", role: "worker" },
      { id: "reviewer", kind: "p4-reviewer", role: "reviewer" },
    ],
    brain: { extractor: "off" },
    git: { delivery: "pr" },
  });
  const rt = await ProjectRuntime.open({ id: `p4-${who}`, name: `app-${who}`, dir });
  const link = new TeamLink({
    runtimes: () => [rt],
    broadcast: () => {},
    statePath: path.join(tmpDir(`p4state-${who}`), "team.json"),
    landingExec: fakeGh,
    landingRerunSettleMs: 0,
  });
  link.attachRuntime(rt);
  M[who] = { rt, link, dir };
}

/** The PR the orchestra's own `gh pr create` opened (it runs the stub on PATH). */
function trackPrs() {
  for (const m of Object.values(M)) {
    for (const r of m.rt.orchestra.list()) {
      const l = r.landing;
      if (l && !prs.has(l.pr) && !r.from) prs.set(l.pr, { n: l.pr, branch: r.branch, state: "OPEN", labels: [], base: "main" });
    }
  }
}

const done = (who: string, id: string) =>
  waitUntil(() => ["completed", "failed", "waiting_human"].includes(M[who]!.rt.orchestra.get(id)!.status), { timeoutMs: 20_000 });

beforeAll(async () => {
  process.env.LOOM_HOME = tmpDir("home-p4");
  process.env.LOOM_NO_NOTIFY = "1";
  process.env.LOOM_NO_PUSH = "1";
  // The orchestra opens PRs with the real `gh` binary; this stub answers for GitHub.
  const bin = tmpDir("p4-bin");
  fs.writeFileSync(
    path.join(bin, "gh"),
    `#!/bin/sh\ncase "$*" in\n  *"pr create"*) n=$(cat "${bin}/n" 2>/dev/null || echo 6); n=$((n+1)); echo $n > "${bin}/n"; echo "https://github.com/acme/app/pull/$n" ;;\n  *) echo "[]" ;;\nesac\n`,
    { mode: 0o755 },
  );
  oldPath = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${process.env.PATH}`;

  hub = await startHubServer({ port: 0, secret: "p4" });
  seed = tmpDir("p4-seed");
  git(seed, "init", "-q", "-b", "main");
  fs.mkdirSync(path.join(seed, "src"), { recursive: true });
  fs.mkdirSync(path.join(seed, ".github/workflows"), { recursive: true });
  fs.mkdirSync(path.join(seed, "db"), { recursive: true });
  fs.writeFileSync(path.join(seed, "src/app.ts"), "export {};\n");
  fs.writeFileSync(path.join(seed, "db/schema.sql"), "-- v1\n");
  fs.writeFileSync(path.join(seed, ".gitignore"), ".loom/\n");
  fs.writeFileSync(path.join(seed, ".github/workflows/ci.yml"), "name: ci\non:\n  push:\n    branches: [main]\n  pull_request:\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps: []\n");
  fs.writeFileSync(path.join(seed, "loom.team.json"), JSON.stringify({ hardZones: ["db/**"], landing: { autoFixAttempts: 2 }, budgets: { perGoalUsd: 50 } }));
  git(seed, "add", "-A");
  git(seed, "-c", "user.name=s", "-c", "user.email=s@s", "commit", "-qm", "seed");
  origin = tmpDir("p4-origin");
  git(origin, "init", "-q", "--bare", "-b", "main");
  git(seed, "remote", "add", "origin", origin);
  git(seed, "push", "-q", "origin", "main");
  git(origin, "symbolic-ref", "HEAD", "refs/heads/main");

  await member("alice");
  await member("bob");
  await M.alice!.link.signIn(hub.url, { github: "alice", secret: "p4" });
  const team = await M.alice!.link.createTeam("Acme");
  await M.alice!.link.share(M.alice!.rt, team.id);
  await M.bob!.link.join((await M.alice!.link.invite(team.id)).link, { github: "bob", secret: "p4" });
  for (const who of ["alice", "bob"]) git(M[who]!.dir, "remote", "set-head", "origin", "main");
}, 60_000);

afterAll(async () => {
  process.env.PATH = oldPath;
  for (const m of Object.values(M)) {
    await m.link.stop();
    await m.rt.close();
  }
  await hub.close();
});

describe("Phase 4: land safely", () => {
  let goal: OrchestraRun;

  it("a goal delivered as a PR is tracked; a failing check is rerun once, then the log reopens the goal (D52–D55)", async () => {
    scripts.alice.push(() => loom([{ type: "spawn", id: "t1", title: "feature", agent: "writer", prompt: "write:src/feature.ts:20", touches: ["src/feature.ts"] }]));
    scripts.alice.push(() => loom([{ type: "done", summary: "feature added" }]));
    goal = await M.alice!.rt.orchestra.start({ goal: "Add the feature", orchestrator: "conductor" });
    await done("alice", goal.id);
    await waitUntil(() => Boolean(M.alice!.rt.orchestra.get(goal.id)!.landing));
    trackPrs();
    const pr = M.alice!.rt.orchestra.get(goal.id)!.landing!.pr;
    expect(prs.get(pr)!.branch).toBe(goal.branch);

    // the first commit fails "test" every time: a real failure
    const first = headOf(goal.branch);
    checkAt = (_p, sha) => (sha === first ? "fail" : "pass");
    let l = await L("alice").poll(M.alice!.rt.orchestra.get(goal.id)!);
    expect(l.state).toBe("failing");
    expect(calls.some((c) => c[0] === "run" && c[1] === "rerun")).toBe(true);

    // still failing after the rerun: the orchestrator gets the log, fixes, and the fix goes to the same PR
    scripts.alice.push((input) => {
      expect(input).toContain('required check "test" failed twice');
      expect(input).toContain("expected guard");
      expect(input).toContain("untrusted output");
      return loom([{ type: "spawn", id: "t2", title: "fix", agent: "writer", prompt: "write:src/feature.ts:21", touches: ["src/feature.ts"] }]);
    });
    scripts.alice.push(() => loom([{ type: "done", summary: "fixed the test" }]));
    l = await L("alice").poll(M.alice!.rt.orchestra.get(goal.id)!);
    expect(l).toMatchObject({ fixAttempts: 1, state: "fixing" });
    await waitUntil(() => M.alice!.rt.orchestra.get(goal.id)!.status === "completed" && headOf(goal.branch) !== first, { timeoutMs: 20_000 });
    expect(prs.size).toBe(1); // no second PR: the fix was pushed to the first
    expect(M.alice!.rt.orchestra.get(goal.id)!.landing!.pr).toBe(pr);
  });

  it("a check that passes on rerun is labelled flaky, not fixed (D53)", async () => {
    const run = M.alice!.rt.orchestra.get(goal.id)!;
    const sha = headOf(goal.branch);
    checkAt = (_p, s, reruns) => (s === sha && reruns === 0 ? "fail" : "pass");
    // once green, the review starts on its own (next test): its high finding reopens the goal
    scripts.alice.push((input) => {
      expect(input).toContain("No guard on user input");
      return loom([{ type: "spawn", id: "t3", title: "guard", agent: "writer", prompt: "write:src/guard.ts:5", touches: ["src/guard.ts"] }]);
    });
    scripts.alice.push(() => loom([{ type: "done", summary: "added the guard" }]));

    await L("alice").poll(run);
    const before = run.landing!.fixAttempts;
    await L("alice").poll(run);
    expect(run.landing!.flaky).toContain(`${sha}:test`);
    expect(prs.get(run.landing!.pr)!.labels).toContain("loom:flaky");
    expect(run.landing!.fixAttempts).toBe(before);
  });

  it("the cross-vendor review blocks on a high finding, the goal is fixed, and the next review passes (D60, D61)", async () => {
    const run = M.alice!.rt.orchestra.get(goal.id)!;
    checkAt = () => "pass";
    await L("alice").poll(run);
    await waitUntil(() => run.landing!.reviews === 1);
    expect(run.landing!.review).toMatchObject({ state: "failure", reviewer: "p4-reviewer", high: 1 });
    expect(statuses.at(-1)).toMatchObject({ state: "failure" });
    expect(calls.some((c) => c[0] === "pr" && c[1] === "review" && c.includes("--comment"))).toBe(true);
    expect(calls.some((c) => c[0] === "pr" && c[1] === "review" && c.includes("--approve"))).toBe(false);
    // completed flips before the fix is pushed: wait for the new commit on the PR branch
    const reviewed = run.landing!.reviewedSha;
    await waitUntil(() => run.status === "completed" && run.landing!.fixAttempts === 2 && headOf(goal.branch) !== reviewed, { timeoutMs: 20_000 });
    await L("alice").poll(run);
    await waitUntil(() => run.landing!.reviews === 2);
    expect(run.landing!.review!.state).toBe("success");
    expect(statuses.at(-1)).toMatchObject({ state: "success" });
    expect(reviews[0]).toContain("Do not modify any files");
    expect((await L("alice").poll(run)).state).toBe("green");
  });

  it("an override stands when the review that was running finishes (D61)", async () => {
    const run = M.alice!.rt.orchestra.get(goal.id)!;
    const before = { review: run.landing!.review, fixAttempts: run.landing!.fixAttempts, status: run.status };
    const sha = run.landing!.headSha!;

    // Only this commit's statuses: the landing loop is live, and another goal's
    // poll can post between two lines of this test.
    const forSha = () => statuses.filter((x) => x.sha === sha);

    // The owner overrode this commit; a review of it is still on its way back.
    await L("alice").overrideReview(goal.id, "checked by hand");
    expect(forSha().at(-1)).toMatchObject({ state: "success" });
    expect(run.landing!.review).toMatchObject({ overridden: "checked by hand", overriddenSha: sha });

    // It lands with a high finding — and the owner's decision stands.
    // One review per goal at a time: a call made while another is in flight
    // returns without asking anyone, so keep asking until this one really runs.
    reviewGate = { wait: Promise.resolve(), high: true };
    const asked = reviews.length;
    for (let i = 0; i < 40 && reviews.length === asked; i++) {
      await L("alice").review(run, sha);
      if (reviews.length > asked) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    reviewGate = null;
    expect(reviews.length).toBeGreaterThan(asked); // this test's review, not someone else's
    expect(run.landing!.review).toMatchObject({ state: "failure", high: 1, overridden: "checked by hand", overriddenSha: sha });
    // the status ends where the owner put it, not at the review's "reviewing…"
    expect(forSha().at(-1)).toMatchObject({ state: "success" });
    expect(String(forSha().at(-1)!.description)).toContain("checked by hand");
    expect(forSha().filter((x) => x.state === "failure")).toEqual([]);
    expect(run.landing!.fixAttempts).toBe(before.fixAttempts); // and the goal isn't sent back
    expect(run.status).toBe(before.status);
    run.landing!.review = before.review;
  }, 60_000);

  it("Land brings fresh main in and asks GitHub to merge; merged goals post their cost (D56, D64)", async () => {
    const run = M.alice!.rt.orchestra.get(goal.id)!;
    // a repo with a merge queue: Land asks GitHub to merge (without one, Phase 6's train lands it — team-phase6)
    rules = [{ type: "merge_queue" }];
    // main moved on meanwhile
    fs.writeFileSync(path.join(seed, "README.md"), "hello\n");
    git(seed, "add", "-A");
    git(seed, "-c", "user.name=s", "-c", "user.email=s@s", "commit", "-qm", "readme");
    git(seed, "push", "-q", "origin", "main");

    const l = await L("alice").land(goal.id);
    expect(l.state).toBe("landing");
    expect(git(origin, "show", `${goal.branch}:README.md`)).toBe("hello\n"); // fresh main is in the pushed branch
    expect(calls.some((c) => c[0] === "pr" && c[1] === "merge" && c.includes("--auto") && c.includes("--squash"))).toBe(true);

    prs.get(run.landing!.pr)!.state = "MERGED";
    expect((await L("alice").poll(run)).state).toBe("merged");
    await waitUntil(() => {
      const t = (M.bob!.link.status() as { teams: Array<{ costs: { landed: number } | null; feed: Array<{ type: string }> }> }).teams[0]!;
      return t.feed.some((e) => e.type === "goal_landed");
    });
    const costs = (M.alice!.link.status() as { teams: Array<{ costs: { landed: number; totalUsd: number } }> }).teams[0]!.costs;
    expect(costs.landed).toBe(1);
    expect(costs.totalUsd).toBeGreaterThan(0);
  });

  it("out of attempts, a goal needs someone; a teammate adopts it, pushes to its branch, and hands it back (D63)", async () => {
    scripts.alice.push(() => loom([{ type: "spawn", id: "t1", title: "api", agent: "writer", prompt: "write:src/api.ts:10", touches: ["src/api.ts"] }]));
    scripts.alice.push(() => loom([{ type: "done", summary: "api" }]));
    const g2 = await M.alice!.rt.orchestra.start({ goal: "Add the API", orchestrator: "conductor" });
    await done("alice", g2.id);
    await waitUntil(() => Boolean(M.alice!.rt.orchestra.get(g2.id)!.landing));
    trackPrs();
    const run = M.alice!.rt.orchestra.get(g2.id)!;
    const pr = run.landing!.pr;
    const stuck = headOf(g2.branch);
    checkAt = (p, sha) => (p.n === pr && sha === stuck ? "fail" : "pass");
    M.alice!.rt.orchestra.setLanding(g2.id, { fixAttempts: 2, reruns: [`${stuck}:test`] });
    const l = await L("alice").poll(run);
    expect(l).toMatchObject({ state: "needs_human" });
    expect(l.reason).toContain("after 2 fix attempts");

    await waitUntil(async () => (await L("bob").adoptable()).some((p) => p.pr === pr));
    scripts.bob.push(() => {
      return loom([{ type: "spawn", id: "t1", title: "fix api", agent: "writer", prompt: "write:src/api.ts:12", touches: ["src/api.ts"] }]);
    });
    scripts.bob.push(() => loom([{ type: "done", summary: "fixed alice's api" }]));
    const adopted = await L("bob").adopt(pr);
    expect(adopted.from).toMatchObject({ branch: g2.branch, pr, owner: "alice" });
    expect(adopted.goal).toContain(`Make alice's PR #${pr} green`);
    await waitUntil(() => run.landing!.adoptedBy === "bob"); // alice's daemon backs off
    await waitUntil(() => M.bob!.rt.orchestra.get(adopted.id)!.status === "completed" && headOf(g2.branch) !== stuck, { timeoutMs: 20_000 });
    expect(git(origin, "log", "-1", "--format=%an", g2.branch).trim()).not.toBe("");
    expect(git(origin, "show", `${g2.branch}:src/api.ts`).split("\n").filter(Boolean)).toHaveLength(12);
    expect(prs.size).toBe(2); // bob pushed to alice's PR, didn't open another

    // green on bob's side: handed back, and alice's daemon takes over again
    const b = M.bob!.rt.orchestra.get(adopted.id)!;
    expect((await L("bob").poll(b)).state).toBe("green");
    await waitUntil(() => run.landing!.adoptedBy === undefined);
    // bob's fix is pulled into alice's goal, so her next fix builds on it
    await waitUntil(() => fs.readFileSync(path.join(run.dir, "src/api.ts"), "utf8").split("\n").filter(Boolean).length === 12);
  });

  it("a conflict with fresh main in a hard zone waits on a human (D58)", async () => {
    scripts.alice.push(() => loom([{ type: "spawn", id: "t1", title: "schema", agent: "writer", prompt: "write:db/schema.sql:3", touches: ["db/schema.sql"] }]));
    scripts.alice.push(() => loom([{ type: "done", summary: "schema" }]));
    const g3 = await M.alice!.rt.orchestra.start({ goal: "Change the schema", orchestrator: "conductor" });
    await done("alice", g3.id);
    await waitUntil(() => Boolean(M.alice!.rt.orchestra.get(g3.id)!.landing));
    trackPrs();
    fs.writeFileSync(path.join(seed, "db/schema.sql"), "-- v2 from main\n");
    git(seed, "add", "-A");
    git(seed, "-c", "user.name=s", "-c", "user.email=s@s", "commit", "-qm", "schema on main");
    git(seed, "push", "-q", "origin", "main");
    const l = await L("alice").land(g3.id);
    expect(l.state).toBe("needs_human");
    expect(l.reason).toContain("hard zone db/**");
  });

  it("the doctor finds a workflow the merge queue would stall on, and opens the fix (D62)", async () => {
    rules = [{ type: "merge_queue" }, { type: "required_status_checks", parameters: { required_status_checks: [{ context: "test" }] } }];
    const d = await L("alice").doctor();
    expect(d.findings.find((f) => f.level === "error")?.what).toContain(".github/workflows/ci.yml");
    expect(d.fixable).toEqual([".github/workflows/ci.yml"]);
    const fix = await L("alice").doctorFix();
    expect(fix.prUrl).toMatch(/\/pull\/\d+$/);
    expect(git(origin, "show", "loom/doctor-merge-group:.github/workflows/ci.yml")).toContain("  merge_group:\n");
    expect(git(origin, "show", "main:.github/workflows/ci.yml")).not.toContain("merge_group"); // settings and main untouched
  });
});
