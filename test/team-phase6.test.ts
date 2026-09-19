/**
 * Loom Teams, Phase 6 — "land in turn, hear it now", end to end.
 *
 * Two members (alice, bob), each a real ProjectRuntime + Team Link with their
 * own clone, on a real `loom hub`, with a real bare origin. Orchestrators are
 * scripted and workers write real files. GitHub is a fake `gh` that keeps PR
 * state, serves checks computed from the real commits on origin, and merges a
 * PR the way GitHub's squash merge does: onto origin's main, for real. The
 * repo has NO merge queue, so Land goes through the landing train (D20, D80).
 *
 * Proves: two goals in the same lane land one after the other — exactly one
 * holds the lane, the other shows `queued` behind it, then takes its turn on
 * top of the first (D79, D82); goals in different lanes land at the same time
 * (D81); a red check on its turn gives the lane back, the lane moves on, and
 * the goal requeues itself once green (D82); a signed GitHub webhook reaches
 * the hub's feed and makes the owner's daemon poll that PR at once (D83, D84).
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { registerAgentKind } from "../src/adapters/index.js";
import { AdapterBase } from "../src/adapters/base.js";
import { signGithubBody } from "../src/core/github-events.js";
import type { LandingState, OrchestraRun } from "../src/core/orchestra.js";
import { writeProjectConfig } from "../src/core/registry.js";
import type { Exec } from "../src/daemon/landing.js";
import { ProjectRuntime } from "../src/daemon/runtime.js";
import { TeamLink } from "../src/daemon/team.js";
import { startHubServer } from "../src/hub/server.js";
import type { SendInput } from "../src/types.js";
import { tmpDir, waitUntil } from "./helpers.js";

const git = (dir: string, ...a: string[]) => execFileSync("git", a, { cwd: dir, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });

// ── scripted agents ──

const scripts: Record<string, Array<(input: string) => string>> = { alice: [], bob: [] };
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
  async send(_input: SendInput) {
    this._busy = true;
    await new Promise((r) => setTimeout(r, 5));
    const next = scripts[this.who]!.shift();
    this.emit({ kind: "message", payload: { text: next ? next(_input.text) : "```loom\n{\"actions\":[]}\n```" } });
    this._busy = false;
  }
}
for (const who of ["alice", "bob"]) registerAgentKind(`p6-conductor-${who}`, (cfg, dir) => new Scripted(cfg.id, `p6-conductor-${who}`, dir, who));

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
    this.emit({ kind: "message", payload: { text: "done" } });
    this._busy = false;
  }
}
registerAgentKind("p6-writer", (cfg, dir) => new Writer(cfg.id, "p6-writer", dir));

const loom = (actions: unknown[]) => "```loom\n" + JSON.stringify({ actions }) + "\n```";

// ── a fake GitHub: PR state, checks from real commits, and a real squash merge ──

interface FakePr {
  n: number;
  branch: string;
  state: "OPEN" | "MERGED" | "CLOSED";
  mergeSha?: string;
  /** The PR branch's head when it merged. */
  mergedHead?: string;
}
const prs = new Map<number, FakePr>();
const calls: string[][] = [];
const merges: number[] = [];
let checkAt: (pr: FakePr, sha: string, reruns: number) => "pass" | "fail" | "pending" = () => "pass";
const rerunCount = new Map<string, number>();
const hooks: Array<{ repo: string; body: Record<string, unknown> }> = [];

let origin = "";
let merger = "";
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
  if (a === "pr" && b === "view") {
    if (!pr) return { code: 1, out: "", err: "no pr" };
    return ok({ state: pr.state, headRefOid: headOf(pr.branch), url: `https://github.com/acme/app/pull/${n}`, reviewDecision: "APPROVED", ...(pr.mergeSha ? { mergeCommit: { oid: pr.mergeSha } } : {}) });
  }
  if (a === "pr" && b === "checks") {
    if (!pr) return { code: 1, out: "", err: "no pr" };
    const sha = headOf(pr.branch);
    const state = checkAt(pr, sha, rerunCount.get(`${n}:${sha}`) ?? 0);
    const rows = [{ name: "test", bucket: state, state: state.toUpperCase(), link: `https://github.com/acme/app/actions/runs/${n}000/job/1` }];
    return { code: state === "fail" ? 1 : state === "pending" ? 8 : 0, out: JSON.stringify(rows), err: "" };
  }
  if (a === "run" && b === "rerun") {
    const p = prs.get(Number(String(args[2]).replace(/000$/, "")));
    if (p) {
      const k = `${p.n}:${headOf(p.branch)}`;
      rerunCount.set(k, (rerunCount.get(k) ?? 0) + 1);
    }
    return ok("");
  }
  if (a === "pr" && b === "diff") return pr ? ok(git(origin, "diff", "--name-only", `main...${pr.branch}`)) : { code: 1, out: "", err: "no pr" };
  if (a === "pr" && (b === "comment" || b === "edit" || b === "review")) return ok("");
  if (a === "label") return ok("");
  if (a === "pr" && b === "merge") {
    if (!pr) return { code: 1, out: "", err: "no pr" };
    if (args.includes("--auto")) return { code: 1, out: "", err: "fake gh: the train never asks for auto-merge" };
    // GitHub's squash merge: the PR's changes as one commit on top of main
    git(merger, "fetch", "-q", "origin");
    git(merger, "checkout", "-q", "-B", "main", "origin/main");
    try {
      git(merger, "merge", "--squash", `origin/${pr.branch}`);
    } catch {
      git(merger, "reset", "-q", "--hard");
      return { code: 1, out: "", err: "Pull request is not mergeable: the merge commit cannot be cleanly created" };
    }
    git(merger, "-c", "user.name=GitHub", "-c", "user.email=noreply@github.com", "commit", "-qm", `Goal (#${n})`);
    git(merger, "push", "-q", "origin", "main");
    Object.assign(pr, { state: "MERGED", mergeSha: git(merger, "rev-parse", "HEAD").trim(), mergedHead: headOf(pr.branch) });
    merges.push(n);
    return ok("");
  }
  const apiPath = a === "api" ? (args.find((x) => x.startsWith("repos/")) ?? "") : "";
  // required checks, but no merge queue: the train's repo
  if (/\/rules\/branches\//.test(apiPath)) return ok([{ type: "required_status_checks", parameters: { required_status_checks: [{ context: "test" }] } }]);
  if (/\/actions\/runs/.test(apiPath)) return ok({ workflow_runs: [] });
  if (/\/hooks$/.test(apiPath)) {
    hooks.push({ repo: apiPath.split("/").slice(1, 3).join("/"), body: JSON.parse(opts?.input ?? "{}") });
    return ok({ id: 4242 });
  }
  return { code: 1, out: "", err: `fake gh: unhandled ${args.join(" ")}` };
};

// ── the team ──

let hub: Awaited<ReturnType<typeof startHubServer>>;
let seed = "";
let oldPath: string | undefined;
let teamId = "";
const M: Record<string, { rt: ProjectRuntime; link: TeamLink; dir: string }> = {};
const L = (who: string) => M[who]!.link.landingFor(M[who]!.rt);
const run = (who: string, id: string) => M[who]!.rt.orchestra.get(id)!;

async function member(who: "alice" | "bob") {
  const dir = tmpDir(`p6-${who}`);
  git(path.dirname(dir), "clone", "-q", origin, dir);
  git(dir, "config", "loom.repo", "acme/app");
  git(dir, "config", "user.email", `${who}@t`);
  git(dir, "config", "user.name", who);
  writeProjectConfig(dir, {
    name: `app-${who}`,
    agents: [
      { id: "conductor", kind: `p6-conductor-${who}`, role: "orchestrator" },
      { id: "writer", kind: "p6-writer", role: "worker" },
    ],
    brain: { extractor: "off" },
    git: { delivery: "pr" },
  });
  const rt = await ProjectRuntime.open({ id: `p6-${who}`, name: `app-${who}`, dir });
  const link = new TeamLink({
    runtimes: () => [rt],
    broadcast: () => {},
    statePath: path.join(tmpDir(`p6state-${who}`), "team.json"),
    landingExec: fakeGh,
    landingRerunSettleMs: 0,
    landingTrainSettleMs: 0,
  });
  link.attachRuntime(rt);
  M[who] = { rt, link, dir };
}

/** The PRs the orchestra's own `gh pr create` opened (it runs the stub on PATH). */
function trackPrs() {
  for (const m of Object.values(M)) {
    for (const r of m.rt.orchestra.list()) {
      const l = r.landing;
      if (l && !prs.has(l.pr) && !r.from) prs.set(l.pr, { n: l.pr, branch: m.rt.orchestra.prBranch(r), state: "OPEN" });
    }
  }
}

/** A goal that writes one file, delivered as a PR. */
async function goal(who: "alice" | "bob", file: string): Promise<OrchestraRun> {
  scripts[who]!.push(() => loom([{ type: "spawn", id: "t1", title: `write ${file}`, agent: "writer", prompt: `write:${file}:5`, touches: [file] }]));
  scripts[who]!.push(() => loom([{ type: "done", summary: `wrote ${file}` }]));
  const g = await M[who]!.rt.orchestra.start({ goal: `Write ${file}`, orchestrator: "conductor" });
  await waitUntil(() => ["completed", "failed", "waiting_human"].includes(run(who, g.id).status), { timeoutMs: 20_000 });
  expect(run(who, g.id).status).toBe("completed");
  await waitUntil(() => Boolean(run(who, g.id).landing));
  trackPrs();
  return run(who, g.id);
}

const feedTypes = (who: string) =>
  ((M[who]!.link.status() as { teams: Array<{ feed: Array<{ type: string; meta: Record<string, unknown> }> }> }).teams[0]?.feed ?? []);
const landLeases = (who: string) =>
  ((M[who]!.link.status() as { teams: Array<{ leases: Array<{ runId: string; taskId: string; github: string }> }> }).teams[0]?.leases ?? []).filter((l) =>
    l.runId.endsWith(":land"),
  );
const isAncestor = (a: string, b: string) => {
  try {
    git(origin, "merge-base", "--is-ancestor", a, b);
    return true;
  } catch {
    return false;
  }
};

beforeAll(async () => {
  process.env.LOOM_HOME = tmpDir("home-p6");
  process.env.LOOM_NO_NOTIFY = "1";
  process.env.LOOM_NO_PUSH = "1";
  const bin = tmpDir("p6-bin");
  fs.writeFileSync(
    path.join(bin, "gh"),
    `#!/bin/sh\ncase "$*" in\n  *"pr create"*) n=$(cat "${bin}/n" 2>/dev/null || echo 20); n=$((n+1)); echo $n > "${bin}/n"; echo "https://github.com/acme/app/pull/$n" ;;\n  *) echo "[]" ;;\nesac\n`,
    { mode: 0o755 },
  );
  oldPath = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${process.env.PATH}`;

  hub = await startHubServer({ port: 0, secret: "p6" });
  seed = tmpDir("p6-seed");
  git(seed, "init", "-q", "-b", "main");
  fs.mkdirSync(path.join(seed, "src"), { recursive: true });
  fs.writeFileSync(path.join(seed, "src/app.ts"), "export {};\n");
  fs.writeFileSync(path.join(seed, ".gitignore"), ".loom/\n");
  fs.writeFileSync(
    path.join(seed, "loom.team.json"),
    JSON.stringify({ landing: { lanes: { web: ["web/**"], api: ["api/**"] } }, review: { enabled: false } }),
  );
  git(seed, "add", "-A");
  git(seed, "-c", "user.name=s", "-c", "user.email=s@s", "commit", "-qm", "seed");
  origin = tmpDir("p6-origin");
  git(origin, "init", "-q", "--bare", "-b", "main");
  git(seed, "remote", "add", "origin", origin);
  git(seed, "push", "-q", "origin", "main");
  git(origin, "symbolic-ref", "HEAD", "refs/heads/main");
  merger = tmpDir("p6-merger");
  git(path.dirname(merger), "clone", "-q", origin, merger);

  await member("alice");
  await member("bob");
  await M.alice!.link.signIn(hub.url, { github: "alice", secret: "p6" });
  teamId = (await M.alice!.link.createTeam("Acme")).id;
  await M.alice!.link.share(M.alice!.rt, teamId);
  await M.bob!.link.join((await M.alice!.link.invite(teamId)).link, { github: "bob", secret: "p6" });
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

describe("Phase 6: the landing train (no merge queue)", () => {
  it("two goals in one lane: one lands, the other is queued behind it, then lands on top of it (D79, D82)", async () => {
    const g1 = await goal("alice", "src/one.ts");
    const g2 = await goal("bob", "src/two.ts");
    checkAt = () => "pending";

    const [s1, s2] = await Promise.all([L("alice").land(g1.id), L("bob").land(g2.id)]);
    expect([s1.state, s2.state].sort()).toEqual(["landing", "queued"]);
    const [first, second] = s1.state === "landing"
      ? [{ who: "alice", g: g1, s: s1 }, { who: "bob", g: g2, s: s2 }]
      : [{ who: "bob", g: g2, s: s2 }, { who: "alice", g: g1, s: s1 }];
    expect(second.s.reason).toBe(`waiting behind ${first.who}'s goal in lane main`);
    expect(first.s).toMatchObject({ train: true, slot: true, lanes: ["main"] });
    expect(calls.some((c) => c[0] === "pr" && c[1] === "merge")).toBe(false); // nothing merges on red-or-running checks
    await waitUntil(() => feedTypes("alice").some((e) => e.type === "land_queued") && feedTypes("bob").some((e) => e.type === "land_turn"));

    // the holder's checks go green: it merges, and hands the lane on by itself
    checkAt = () => "pass";
    await L(first.who).tick();
    await waitUntil(() => run(second.who, second.g.id).landing!.state === "merged", { timeoutMs: 20_000 });
    expect(run(first.who, first.g.id).landing!.state).toBe("merged");
    expect(merges).toEqual([first.s.pr, second.s.pr]);
    expect(git(origin, "show", "main:src/one.ts")).toContain("line 0");
    expect(git(origin, "show", "main:src/two.ts")).toContain("line 0");
    // its turn brought fresh main in first: the second PR was built on the first's merge
    expect(isAncestor(prs.get(first.s.pr)!.mergeSha!, prs.get(second.s.pr)!.mergedHead!)).toBe(true);
    expect(calls.filter((c) => c[0] === "pr" && c[1] === "merge").every((c) => c.includes("--squash") && !c.includes("--auto"))).toBe(true);
    // the lanes are free again; the goals' task leases are the landing machinery's (D36), untouched
    await waitUntil(() => landLeases("alice").length === 0);
  });

  it("goals in different lanes land at the same time (D81)", async () => {
    const g3 = await goal("alice", "web/page.ts");
    const g4 = await goal("bob", "api/route.ts");
    checkAt = () => "pending";
    const [s3, s4] = await Promise.all([L("alice").land(g3.id), L("bob").land(g4.id)]);
    expect([s3.state, s4.state]).toEqual(["landing", "landing"]);
    expect(s3.lanes).toEqual(["web"]);
    expect(s4.lanes).toEqual(["api"]);
    await waitUntil(() => landLeases("alice").map((l) => l.taskId).sort().join() === "land:api,land:web");

    checkAt = () => "pass";
    // a turn is several steps (fresh base, push, green, merge); the product ticks
    // every 30s, so keep ticking while waiting rather than trusting one tick —
    // on a slow CI machine one wasn't enough (the goals merged a tick later)
    await waitUntil(
      async () => {
        await Promise.all([L("alice").tick(), L("bob").tick()]);
        return run("alice", g3.id).landing!.state === "merged" && run("bob", g4.id).landing!.state === "merged";
      },
      { timeoutMs: 30_000 },
    ).catch((e) => {
      // say where each goal got stuck, so a CI-only failure explains itself
      const show = (w: "alice" | "bob", id: string) => {
        const l = run(w, id).landing!;
        return `${w}: state=${l.state} reason=${l.reason ?? "-"} lanes=${JSON.stringify(l.lanes)} checks=${JSON.stringify(l.checks)}`;
      };
      throw new Error(`${(e as Error).message}\n${show("alice", g3.id)}\n${show("bob", g4.id)}\ngh calls: ${JSON.stringify(calls.slice(-12))}`);
    });
    expect(git(origin, "show", "main:web/page.ts")).toContain("line 0");
    expect(git(origin, "show", "main:api/route.ts")).toContain("line 0");
  });

  it("a red check on its turn gives the lane back; the lane moves on, and the goal requeues once green (D82)", async () => {
    const g5 = await goal("alice", "src/five.ts");
    const g6 = await goal("bob", "src/six.ts");
    checkAt = () => "pending";
    expect((await L("alice").land(g5.id)).state).toBe("landing");
    expect((await L("bob").land(g6.id)).state).toBe("queued");

    // alice's turn head fails "test" once (it passes on rerun: a flake)
    const red = headOf(prs.get(run("alice", g5.id).landing!.pr)!.branch);
    checkAt = (_p, sha, reruns) => (sha === red && reruns === 0 ? "fail" : "pass");
    const st: LandingState = await L("alice").pollNow(run("alice", g5.id));
    expect(st).toMatchObject({ state: "failing", slot: false, landRequested: true });
    expect(calls.some((c) => c[0] === "run" && c[1] === "rerun")).toBe(true);

    // bob was waiting on the lane: he hears it's free and lands, without a tick
    await waitUntil(() => run("bob", g6.id).landing!.state === "merged", { timeoutMs: 20_000 });
    expect(run("alice", g5.id).landing!.state).not.toBe("merged");

    // alice's check passes on rerun: labelled flaky, back in the train, landed on top of bob's
    await L("alice").pollNow(run("alice", g5.id));
    await waitUntil(() => run("alice", g5.id).landing!.state === "merged", { timeoutMs: 20_000 });
    expect(run("alice", g5.id).landing!.flaky).toContain(`${red}:test`);
    expect(merges.slice(-2)).toEqual([run("bob", g6.id).landing!.pr, run("alice", g5.id).landing!.pr]);
    expect(isAncestor(prs.get(run("bob", g6.id).landing!.pr)!.mergeSha!, prs.get(run("alice", g5.id).landing!.pr)!.mergedHead!)).toBe(true);
  });
});

describe("Phase 6: GitHub webhooks into the hub (D83, D84)", () => {
  it("the owner gets the payload URL and secret, and can install the webhook with gh", async () => {
    const w = await M.alice!.link.webhook({ install: true, repo: "acme/app" });
    expect(w.url).toBe(`${hub.url}/github/webhook/${teamId}`);
    expect(w.secret).toMatch(/^[0-9a-f]{64}$/);
    expect(w.warning).toMatch(/local address/);
    expect(w.installed).toEqual({ id: 4242, repo: "acme/app" });
    expect(hooks[0]).toMatchObject({
      repo: "acme/app",
      body: { name: "web", active: true, events: ["pull_request", "check_suite", "check_run", "pull_request_review", "deployment_status"], config: { url: w.url, content_type: "json", secret: w.secret } },
    });
    await expect(M.bob!.link.webhook({ teamId })).rejects.toThrow(/needs owner/);
  });

  it("a signed check_run failure reaches the feed and the owner's daemon polls that PR at once, not at its next tick", async () => {
    const g7 = await goal("alice", "src/seven.ts");
    const pr = g7.landing!.pr;
    const sha = headOf(prs.get(pr)!.branch);
    checkAt = (p) => (p.n === pr ? "fail" : "pass");
    const { secret } = await M.alice!.link.webhook({});
    const body = JSON.stringify({
      action: "completed",
      repository: { full_name: "acme/app" },
      check_run: { name: "test", conclusion: "failure", head_sha: sha, pull_requests: [{ number: pr, head: { ref: prs.get(pr)!.branch, sha } }] },
    });
    const before = calls.filter((c) => c[0] === "pr" && c[1] === "view" && c[2] === String(pr)).length;
    const res = await fetch(`${hub.url}/github/webhook/${teamId}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-github-event": "check_run", "x-hub-signature-256": await signGithubBody(secret, body) },
      body,
    });
    expect(res.status).toBe(202);
    await waitUntil(() => feedTypes("bob").some((e) => e.type === "check_failed" && e.meta.number === pr));
    await waitUntil(() => run("alice", g7.id).landing!.state === "failing");
    expect(calls.filter((c) => c[0] === "pr" && c[1] === "view" && c[2] === String(pr)).length).toBeGreaterThan(before);
  });
});
