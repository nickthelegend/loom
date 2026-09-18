/**
 * Loom Teams, Phase 2 — "stop colliding", end to end.
 *
 * Two members (alice, bob), each a real ProjectRuntime + Team Link with their
 * own clone of one repo, meeting on a real `loom hub`. Their orchestrators are
 * scripted; their workers are echo agents that write real files. Origin is a
 * real bare repo they push WIP refs to, with a reviewed `loom.team.json` on
 * main declaring `db/migrations/**` a hard zone.
 *
 * Proves, against the real git + hub stack: an overlap needs the orchestrator's
 * decision (D29); a hard zone queues and releases (D31, D36); merge-tree predicts
 * a conflict from BOTH sides (D34, D35); `wait:` holds until the teammate's PR
 * merges (D30); drift into someone's hard zone pauses the worker (D33).
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { registerAgentKind } from "../src/adapters/index.js";
import { AdapterBase } from "../src/adapters/base.js";
import type { OrchestraRun } from "../src/core/orchestra.js";
import { writeProjectConfig } from "../src/core/registry.js";
import { ProjectRuntime } from "../src/daemon/runtime.js";
import { TeamLink } from "../src/daemon/team.js";
import { startHubServer } from "../src/hub/server.js";
import type { SendInput } from "../src/types.js";
import { tmpDir, waitUntil } from "./helpers.js";

const git = (dir: string, ...a: string[]) => execFileSync("git", a, { cwd: dir, encoding: "utf8" });

// One script per member's orchestrator; each reply is a function of what it was told.
const scripts: Record<string, Array<(input: string) => string>> = { alice: [], bob: [] };
const told: Record<string, string[]> = { alice: [], bob: [] };
for (const who of ["alice", "bob"] as const) {
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
      told[who].push(input.text);
      await new Promise((r) => setTimeout(r, 10));
      const next = scripts[who].shift();
      this.emit({ kind: "message", payload: { text: next ? next(input.text) : "```loom\n{\"actions\":[]}\n```" } });
      this._busy = false;
    }
  }
  registerAgentKind(`conductor-${who}`, (cfg, dir) => new Conductor(cfg.id, `conductor-${who}`, dir));
}
/** A worker that edits first and keeps working — how real agents drift mid-turn. */
class EditsEarly extends AdapterBase {
  async available() {
    return true;
  }
  async start() {}
  async stop() {}
  async interrupt() {
    this.aborted = true;
  }
  private aborted = false;
  async diff() {
    return "";
  }
  async send(input: SendInput) {
    this._busy = true;
    this.aborted = false;
    const m = /write:(\S+)/.exec(input.text);
    if (m) {
      const f = path.join(this.projectDir, m[1]!);
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, "early\n");
      this.emit({ kind: "file_edit", payload: { path: m[1] } });
    }
    for (let i = 0; i < 80 && !this.aborted; i++) await new Promise((r) => setTimeout(r, 50));
    this.emit({ kind: "message", payload: { text: this.aborted ? "stopped" : "done" } });
    this._busy = false;
  }
}
registerAgentKind("edits-early", (cfg, dir) => new EditsEarly(cfg.id, "edits-early", dir));

const loom = (actions: unknown[]) => "```loom\n" + JSON.stringify({ actions }) + "\n```";

let hub: Awaited<ReturnType<typeof startHubServer>>;
let origin: string;
const M: Record<string, { rt: ProjectRuntime; link: TeamLink; dir: string }> = {};

async function member(who: "alice" | "bob", worker: string) {
  const dir = tmpDir(`p2-${who}`);
  git(path.dirname(dir), "clone", "-q", origin, dir);
  git(dir, "config", "loom.repo", "acme/app"); // origin is a local bare repo; the team repo is acme/app
  git(dir, "config", "user.email", `${who}@t`);
  git(dir, "config", "user.name", who);
  writeProjectConfig(dir, {
    name: `app-${who}`,
    agents: [
      { id: "conductor", kind: `conductor-${who}`, role: "orchestrator" },
      { id: worker, kind: "echo", role: "worker" },
      { id: `${worker}-early`, kind: "edits-early", role: "worker" },
    ],
    brain: { extractor: "off" },
  });
  const rt = await ProjectRuntime.open({ id: `p2-${who}`, name: `app-${who}`, dir });
  const link = new TeamLink({ runtimes: () => [rt], broadcast: () => {}, statePath: path.join(tmpDir(`p2state-${who}`), "team.json") });
  link.attachRuntime(rt);
  M[who] = { rt, link, dir };
}

const settleHold = (who: string, runId: string, taskId: string, kind: string) =>
  waitUntil(() => M[who]!.rt.orchestra.get(runId)?.tasks.find((t) => t.id === taskId)?.hold?.kind === kind, { timeoutMs: 20_000 });
const taskOf = (who: string, runId: string, taskId: string) => M[who]!.rt.orchestra.get(runId)!.tasks.find((t) => t.id === taskId)!;
/**
 * End a test's goal the way a team would: land it if it completed (its leases
 * stay "landing" until then — D36 — and would rightly block the next test's
 * hard zone), abort it otherwise.
 */
async function finish(who: string, run: OrchestraRun) {
  const o = M[who]!.rt.orchestra;
  // let an orchestrator turn that's finishing up land first
  await waitUntil(() => ["completed", "failed", "aborted", "waiting_human"].includes(o.get(run.id)!.status), { timeoutMs: 10_000 }).catch(() => {});
  const r = o.get(run.id)!;
  if (r.status === "completed" && !r.applied) await o.apply(run.id);
  else if (!["completed", "failed", "aborted"].includes(r.status)) await o.abort(run.id);
  await waitUntil(async () => {
    const teamId = (M[who]!.link.status() as { teams: Array<{ id: string }> }).teams[0]!.id;
    const leases = await hub.hub.client(hub.hub.signIn(who).token).leases(teamId);
    return !leases.some((l) => l.runId === run.id);
  });
}

beforeAll(async () => {
  process.env.LOOM_HOME = tmpDir("home-p2");
  process.env.LOOM_NO_NOTIFY = "1";
  hub = await startHubServer({ port: 0, secret: "p2" });
  // origin: a bare repo whose main carries the reviewed team policy
  const seed = tmpDir("p2-seed");
  git(seed, "init", "-q", "-b", "main");
  fs.mkdirSync(path.join(seed, "src/auth"), { recursive: true });
  fs.mkdirSync(path.join(seed, "db/migrations"), { recursive: true });
  fs.writeFileSync(path.join(seed, "src/auth/login.ts"), "export {};\n");
  fs.writeFileSync(path.join(seed, "db/migrations/001_init.sql"), "-- init\n");
  fs.writeFileSync(path.join(seed, ".gitignore"), ".loom/\n");
  fs.writeFileSync(path.join(seed, "loom.team.json"), JSON.stringify({ hardZones: ["db/migrations/**"] }));
  git(seed, "add", "-A");
  git(seed, "-c", "user.name=s", "-c", "user.email=s@s", "commit", "-qm", "seed");
  origin = tmpDir("p2-origin");
  git(origin, "init", "-q", "--bare", "-b", "main");
  git(seed, "push", "-q", origin, "main");
  git(origin, "symbolic-ref", "HEAD", "refs/heads/main");

  await member("alice", "alpha");
  await member("bob", "beta");
  await M.alice!.link.signIn(hub.url, { github: "alice", secret: "p2" });
  const team = await M.alice!.link.createTeam("Acme");
  await M.alice!.link.share(M.alice!.rt, team.id);
  await M.bob!.link.join((await M.alice!.link.invite(team.id)).link, { github: "bob", secret: "p2" });
  for (const who of ["alice", "bob"]) git(M[who]!.dir, "remote", "set-head", "origin", "main");
}, 60_000);

afterAll(async () => {
  for (const m of Object.values(M)) {
    await m.link.stop();
    await m.rt.close();
  }
  await hub.close();
});

describe("Phase 2: stop colliding", () => {
  it("an overlap waits for the orchestrator's decision, then runs with it recorded (D29)", async () => {
    scripts.alice.push(() => loom([{ type: "spawn", id: "t1", title: "login form", agent: "alpha", prompt: "sleep:4000 write:src/auth/form.ts", touches: ["src/auth/**"] }]));
    const a = await M.alice!.rt.orchestra.start({ goal: "Add login form", orchestrator: "conductor" });
    await waitUntil(() => taskOf("alice", a.id, "t1")?.status === "running");

    scripts.bob.push(() => loom([{ type: "spawn", id: "t1", title: "session tweak", agent: "beta", prompt: "write:src/auth/session.ts", touches: ["src/auth/**"] }]));
    scripts.bob.push((input) => {
      // the review names alice, her goal (decrypted), and the paths
      expect(input).toContain("alice's goal 'Add login form'");
      expect(input).toContain("src/auth/");
      return loom([{ type: "spawn", id: "t1", title: "session tweak", agent: "beta", prompt: "write:src/auth/session.ts", touches: ["src/auth/session.ts"], overlap: "proceed:one-line change, no shared lines" }]);
    });
    scripts.bob.push(() => loom([{ type: "done", summary: "ok" }]));
    const b = await M.bob!.rt.orchestra.start({ goal: "Tweak sessions", orchestrator: "conductor" });
    await waitUntil(() => M.bob!.rt.orchestra.get(b.id)!.status === "completed", { timeoutMs: 30_000 });
    expect(taskOf("bob", b.id, "t1").status).toBe("done");
    expect(taskOf("bob", b.id, "t1").overlap).toMatch(/^proceed:/);
    // the decision reached the team feed, and alice's orchestrator will hear about it
    await waitUntil(() => (M.alice!.link.status() as { teams: Array<{ feed: Array<{ type: string }> }> }).teams[0]!.feed.some((e) => e.type === "overlap_decided"));
    await waitUntil(() => (M.alice!.rt.orchestra.get(a.id)!.notes ?? []).some((n) => n.includes("chose to proceed alongside your work")));
    await finish("alice", a);
    await finish("bob", b);
  });

  it("a held hard zone queues the task; it starts on its own once released (D31, D36)", async () => {
    scripts.alice.push(() => loom([{ type: "spawn", id: "m1", title: "migration", agent: "alpha", prompt: "sleep:2500 write:db/migrations/002_a.sql", touches: ["db/migrations/**"] }]));
    const a = await M.alice!.rt.orchestra.start({ goal: "Add users table", orchestrator: "conductor" });
    await waitUntil(() => taskOf("alice", a.id, "m1")?.status === "running");

    scripts.bob.push(() => loom([{ type: "spawn", id: "m1", title: "migration", agent: "beta", prompt: "write:db/migrations/002_b.sql", touches: ["db/migrations/**"], overlap: "proceed:needed" }]));
    const b = await M.bob!.rt.orchestra.start({ goal: "Add orders table", orchestrator: "conductor" });
    await settleHold("bob", b.id, "m1", "zone");
    expect(taskOf("bob", b.id, "m1").hold!.reason).toMatch(/db\/migrations\/\*\* is a hard zone held by alice's goal 'Add users table'/);
    expect(taskOf("bob", b.id, "m1").status).toBe("pending");

    // alice's goal lands (applied here; a merged PR does the same) → her leases go → bob's task starts
    scripts.alice.push(() => loom([{ type: "done", summary: "users" }]));
    await waitUntil(() => M.alice!.rt.orchestra.get(a.id)!.status === "completed", { timeoutMs: 30_000 });
    await M.alice!.rt.orchestra.apply(a.id);
    scripts.bob.push(() => loom([{ type: "done", summary: "orders" }]));
    await waitUntil(() => taskOf("bob", b.id, "m1").status === "done", { timeoutMs: 40_000 });
    await finish("bob", b);
  });

  it("merge-tree predicts a conflict, and BOTH owners' orchestrators hear it (D34, D35)", async () => {
    scripts.alice.push(() => loom([{ type: "spawn", id: "c1", title: "readme", agent: "alpha", prompt: "write:docs/shared.md", touches: ["docs/**"] }]));
    const a = await M.alice!.rt.orchestra.start({ goal: "Docs A", orchestrator: "conductor" });
    await waitUntil(() => taskOf("alice", a.id, "c1")?.status === "done");
    scripts.bob.push(() => loom([{ type: "spawn", id: "c1", title: "readme", agent: "beta", prompt: "write:docs/shared.md", touches: ["docs/**"], overlap: "proceed:we'll reconcile" }]));
    const b = await M.bob!.rt.orchestra.start({ goal: "Docs B", orchestrator: "conductor" });
    await waitUntil(() => taskOf("bob", b.id, "c1")?.status === "done", { timeoutMs: 30_000 });

    // both publish WIP; bob's daemon runs merge-tree against alice's ref
    await M.alice!.link.coordinatorFor(M.alice!.rt).wipAndPredict();
    const found = await M.bob!.link.coordinatorFor(M.bob!.rt).wipAndPredict();
    expect(found).toEqual(expect.arrayContaining([expect.objectContaining({ mine: b.id, theirs: a.id, files: ["docs/shared.md"] })]));
    // the WIP refs really are on origin, hidden from branches
    expect(git(origin, "for-each-ref", "--format=%(refname)", "refs/loom/wip")).toContain(`refs/loom/wip/alice/${a.id}`);
    expect(git(origin, "branch", "--list")).not.toContain("wip");
    // bob's orchestrator has it as a note; alice's too, through the feed
    expect((M.bob!.rt.orchestra.get(b.id)!.notes ?? []).join("\n")).toContain("docs/shared.md");
    await waitUntil(() => (M.alice!.rt.orchestra.get(a.id)!.notes ?? []).some((n) => n.includes("predicts a merge conflict") && n.includes("docs/shared.md")));
    await finish("alice", a);
    await finish("bob", b);
  });

  it("wait:<goal> holds until that goal's PR merges, then starts on fresh main (D30)", async () => {
    scripts.alice.push(() => loom([{ type: "spawn", id: "w1", title: "api", agent: "alpha", prompt: "sleep:500 write:src/api/users.ts", touches: ["src/api/**"] }]));
    scripts.alice.push(() => loom([{ type: "done", summary: "api" }]));
    const a = await M.alice!.rt.orchestra.start({ goal: "Users API", orchestrator: "conductor" });
    await waitUntil(() => M.alice!.rt.orchestra.get(a.id)!.status === "completed", { timeoutMs: 30_000 });

    scripts.bob.push(() => loom([{ type: "spawn", id: "w1", title: "client", agent: "beta", prompt: "write:src/api/client.ts", touches: ["src/api/**"], overlap: `wait:${a.id}` }]));
    const b = await M.bob!.rt.orchestra.start({ goal: "API client", orchestrator: "conductor" });
    await settleHold("bob", b.id, "w1", "wait");
    expect(taskOf("bob", b.id, "w1").hold!.reason).toContain("PR to merge");
    // "Stop waiting" is refused on a task that isn't waiting
    expect(() => M.bob!.rt.orchestra.stopWaiting(b.id, "nope")).toThrow(/no task/);

    // GitHub reports alice's goal PR merged (what the gh poll or App would post)
    const hubAlice = hub.hub.client(hub.hub.signIn("alice").token);
    const teamId = (await hubAlice.teams())[0]!.id;
    await hubAlice.appendFeed(teamId, { type: "pr_merged", repo: "acme/app", meta: { number: 9, branch: `loom/orchestra/${a.id}/main` } });
    scripts.bob.push(() => loom([{ type: "done", summary: "client" }]));
    await waitUntil(() => taskOf("bob", b.id, "w1").status === "done", { timeoutMs: 30_000 });
    // and alice's goal, having landed, released its leases (D36)
    await waitUntil(async () => !(await hubAlice.leases(teamId)).some((l) => l.runId === a.id));
    await finish("bob", b);
  });

  it("'Stop waiting' releases a task waiting on a goal that will never merge (D32)", async () => {
    scripts.bob.push(() => loom([{ type: "spawn", id: "s1", title: "stuck", agent: "beta", prompt: "write:src/misc/s.ts", touches: ["src/misc/**"], overlap: "wait:o-never" }]));
    scripts.bob.push(() => loom([{ type: "done", summary: "unstuck" }]));
    const b = await M.bob!.rt.orchestra.start({ goal: "Stuck goal", orchestrator: "conductor" });
    await settleHold("bob", b.id, "s1", "wait");
    const t = M.bob!.rt.orchestra.stopWaiting(b.id, "s1");
    expect(t.overlap).toMatch(/^proceed:the owner stopped waiting on o-never/);
    await waitUntil(() => taskOf("bob", b.id, "s1").status === "done", { timeoutMs: 30_000 });
    await finish("bob", b);
  });

  it("drift into a teammate's hard zone pauses the worker (D33)", async () => {
    scripts.alice.push(() => loom([{ type: "spawn", id: "z1", title: "hold zone", agent: "alpha", prompt: "sleep:6000 write:db/migrations/003_a.sql", touches: ["db/migrations/**"] }]));
    const a = await M.alice!.rt.orchestra.start({ goal: "Zone holder", orchestrator: "conductor" });
    await waitUntil(() => taskOf("alice", a.id, "z1")?.status === "running");

    // bob's task declares src/ui/** but its worker writes into the migrations zone
    scripts.bob.push(() => loom([{ type: "spawn", id: "d1", title: "ui", agent: "beta-early", prompt: "write:db/migrations/003_b.sql", touches: ["src/ui/**"] }]));
    const b = await M.bob!.rt.orchestra.start({ goal: "UI polish", orchestrator: "conductor" });
    await settleHold("bob", b.id, "d1", "zone");
    const t = taskOf("bob", b.id, "d1");
    expect(t.status).toBe("pending");
    expect(t.hold!.reason).toMatch(/edited db\/migrations\/003_b\.sql inside db\/migrations\/\*\*/);
    expect(t.queued[0]).toMatch(/You were paused/);
    await finish("alice", a);
    await finish("bob", b);
  });
});
