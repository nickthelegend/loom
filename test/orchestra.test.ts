/**
 * Orchestra: one orchestrator, many parallel workers, one integration branch.
 *
 * The orchestrator here is a scripted adapter that replies with canned
 * ```loom blocks round by round; the workers are echo agents, which write real
 * files (write:<path>) in their worktrees. So every git step is real — the
 * worktrees, the commits, the merges, the conflicts — and only the model is
 * faked.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { registerAgentKind } from "../src/adapters/index.js";
import { AdapterBase } from "../src/adapters/base.js";
import { parseOrchestraActions, type OrchestraRun } from "../src/core/orchestra.js";
import { writeProjectConfig } from "../src/core/registry.js";
import { ProjectRuntime } from "../src/daemon/runtime.js";
import type { SendInput } from "../src/types.js";
import { tmpDir, waitUntil } from "./helpers.js";

const git = (dir: string, ...args: string[]): string => execFileSync("git", args, { cwd: dir, encoding: "utf8" });

/** Replies from a per-test script: one entry per orchestrator round. */
let script: string[] = [];
const seen: SendInput[] = [];

/** When set, the orchestrator's stop() stalls — holding finish() at its wrap-up step. */
let stall: { entered: boolean; release: () => void; gate: Promise<void> } | null = null;

class ScriptedOrchestrator extends AdapterBase {
  async available() {
    return true;
  }
  async start() {}
  async stop() {
    if (stall) {
      stall.entered = true;
      await stall.gate;
    }
  }
  async interrupt() {}
  async diff() {
    return "";
  }
  async send(input: SendInput): Promise<void> {
    this._busy = true;
    seen.push(input);
    await new Promise((r) => setTimeout(r, 10));
    const reply = script.shift() ?? "```loom\n{\"actions\": [{\"type\": \"done\", \"summary\": \"script ran out\"}]}\n```";
    this.emit({ kind: "message", payload: { text: reply } });
    this.emit({ kind: "run_complete", payload: { durationMs: 10 } });
    this._busy = false;
  }
}
registerAgentKind("scripted", (cfg, dir) => new ScriptedOrchestrator(cfg.id, "scripted", dir));

/** A worker that stops mid-turn to ask (like opencode's question tool) and waits until interrupted. */
class Asker extends AdapterBase {
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
  async send(input: SendInput): Promise<void> {
    this._busy = true;
    this.stopped = false;
    if (/answer: use (\S+)/.test(input.text)) {
      fs.writeFileSync(path.join(this.projectDir, /answer: use (\S+)/.exec(input.text)![1]!), "ok\n");
      this.emit({ kind: "message", payload: { text: "created it" } });
    } else {
      this.emit({ kind: "needs_input", payload: { question: "Which file name?" } });
      for (let i = 0; i < 2000 && !this.stopped; i++) await new Promise((r) => setTimeout(r, 25));
    }
    this.emit({ kind: "run_complete", payload: {} });
    this._busy = false;
  }
}
registerAgentKind("asker", (cfg, dir) => new Asker(cfg.id, "asker", dir));

const loom = (actions: unknown[]) => "Here's the plan.\n```loom\n" + JSON.stringify({ actions }) + "\n```";

let rt: ProjectRuntime;
let dir: string;

async function openProject(): Promise<void> {
  dir = tmpDir("orch");
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "t@t");
  git(dir, "config", "user.name", "t");
  fs.writeFileSync(path.join(dir, "seed.txt"), "seed\n");
  fs.writeFileSync(path.join(dir, ".gitignore"), ".loom/\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "seed");
  writeProjectConfig(dir, {
    name: "orch",
    agents: [
      { id: "conductor", kind: "scripted", role: "orchestrator" },
      { id: "alpha", kind: "echo", role: "worker" },
      { id: "beta", kind: "echo", role: "worker" },
    ],
    brain: { extractor: "off" },
  });
  rt = await ProjectRuntime.open({ id: `orch-${path.basename(dir)}`, name: "orch", dir });
}

const settle = (id: string) =>
  waitUntil(() => ["completed", "failed", "aborted", "waiting_human"].includes(rt.orchestra.get(id)!.status), {
    timeoutMs: 30_000,
  });

beforeAll(() => {
  process.env.LOOM_HOME = tmpDir("home-orch");
  process.env.LOOM_NO_NOTIFY = "1";
});

afterEach(async () => {
  await rt?.close();
  script = [];
  seen.length = 0;
});

describe("orchestra protocol", () => {
  it("reads the last loom block, and tolerates json fences and aliases", () => {
    expect(
      parseOrchestraActions(
        'thinking…\n```loom\n{"actions":[{"type":"done","summary":"old"}]}\n```\nthen\n```loom\n{"actions":[{"type":"spawn","title":"A","agent":"codex","prompt":"do a"}]}\n```',
      ),
    ).toEqual([{ type: "spawn", title: "A", agent: "codex", prompt: "do a", dependsOn: [] }]);
    expect(
      parseOrchestraActions('```json\n{"actions":[{"action":"assign","name":"B","worker":"claude","instructions":"do b","after":["t1"]}]}\n```'),
    ).toEqual([{ type: "spawn", title: "B", agent: "claude", prompt: "do b", dependsOn: ["t1"] }]);
    expect(parseOrchestraActions('ok {"actions":[{"type":"finish","summary":"all good"}]} bye')).toEqual([
      { type: "done", summary: "all good" },
    ]);
    expect(parseOrchestraActions("```loom\n{\"actions\": []}\n```")).toEqual([]);
    expect(parseOrchestraActions("no plan here")).toBeNull();
  });
});

describe("orchestra runs", () => {
  it("fans out in parallel, honours dependsOn, merges everything, and finishes on done", async () => {
    await openProject();
    script = [
      loom([
        { type: "spawn", id: "t1", title: "file a", agent: "alpha", prompt: "sleep:400 write:a.txt" },
        { type: "spawn", id: "t2", title: "file b", agent: "beta", prompt: "sleep:400 write:b.txt" },
        { type: "spawn", id: "t3", title: "file c", agent: "alpha", prompt: "write:c.txt", dependsOn: ["t1"] },
      ]),
      loom([{ type: "done", summary: "three files" }]),
    ];
    const run = await rt.orchestra.start({ goal: "make three files", orchestrator: "conductor", workers: ["alpha", "beta"] });
    await settle(run.id);
    const done = rt.orchestra.get(run.id)!;

    expect(done.status).toBe("completed");
    expect(done.summary).toBe("three files");
    expect(done.tasks.map((t) => t.status)).toEqual(["done", "done", "done"]);
    // t1 and t2 overlapped in time: parallel, not a queue
    const [t1, t2, t3] = done.tasks as [OrchestraRun["tasks"][0], OrchestraRun["tasks"][0], OrchestraRun["tasks"][0]];
    expect(t2.startedAt!).toBeLessThan(t1.finishedAt!);
    // t3 waited for t1, and started from a branch that already had a.txt
    expect(t3.startedAt!).toBeGreaterThanOrEqual(t1.finishedAt!);
    expect(fs.existsSync(path.join(t3.dir!, "a.txt"))).toBe(true);
    // every task's work is on the integration branch; the user's tree is untouched
    const files = git(dir, "ls-tree", "-r", "--name-only", done.branch).split("\n");
    expect(files).toEqual(expect.arrayContaining(["a.txt", "b.txt", "c.txt", "seed.txt"]));
    expect(files.some((f) => f.startsWith(".loom"))).toBe(false);
    expect(fs.existsSync(path.join(dir, "a.txt"))).toBe(false);
    // each task streamed into its own thread
    expect(new Set(done.tasks.map((t) => t.chat)).size).toBe(3);
    expect(rt.chats().map((c) => c.id)).toEqual(expect.arrayContaining(done.tasks.map((t) => t.chat)));
    const t1Events = rt.log.list({}).filter((e) => e.chat === t1.chat && e.kind === "message" && e.agentId === "alpha");
    expect(t1Events.length).toBeGreaterThan(0);
    // the orchestrator was briefed once, then reviewed the results it was shown
    expect(seen[0]!.briefing).toContain("ORCHESTRATOR");
    expect(seen[1]!.text).toContain("t1 · file a — DONE");
    expect(seen[1]!.text).toContain("a.txt");

    // worker commits carry trailers that trace them to goal, task and agent
    const msg = git(dir, "log", "-1", "--format=%B", `${done.branch.replace(/\/main$/, "")}/t1`);
    expect(msg).toContain(`Loom-Goal: ${run.id}`);
    expect(msg).toContain("Loom-Task: t1");
    expect(msg).toContain("Co-Authored-By: alpha <alpha@loom.local>");

    // apply lands the integration branch in the project
    const applied = await rt.orchestra.apply(run.id);
    expect(applied.into).toBe("main");
    expect(fs.readFileSync(path.join(dir, "c.txt"), "utf8")).toContain("echo(alpha)");
  });

  it("sends a task's own prompt first, even when a follow-up is queued in the same reply", async () => {
    await openProject();
    script = [
      loom([
        { type: "spawn", id: "t1", title: "two steps", agent: "alpha", prompt: "write:first.txt" },
        { type: "send", task: "t1", message: "write:second.txt" },
      ]),
      loom([{ type: "done", summary: "ok" }]),
    ];
    const run = await rt.orchestra.start({ goal: "queue", orchestrator: "conductor" });
    await settle(run.id);
    const r = rt.orchestra.get(run.id)!;
    expect(r.tasks[0]!.attempts).toBe(2);
    const files = git(dir, "ls-tree", "-r", "--name-only", r.branch);
    expect(files).toContain("first.txt");
    expect(files).toContain("second.txt");
  });

  it("keeps a worker's .loom state out of commits, whether or not the project ignores it", async () => {
    await openProject();
    script = [
      loom([
        { type: "spawn", title: "state", agent: "alpha", prompt: "write:.loom/state.json" },
        { type: "spawn", title: "real", agent: "beta", prompt: "write:real.txt" },
      ]),
      loom([{ type: "done", summary: "ok" }]),
    ];
    const run = await rt.orchestra.start({ goal: "state files", orchestrator: "conductor" });
    await settle(run.id);
    const done = rt.orchestra.get(run.id)!;
    expect(done.tasks.map((t) => t.status)).toEqual(["done", "done"]);
    const files = git(dir, "ls-tree", "-r", "--name-only", done.branch);
    expect(files).toContain("real.txt");
    expect(files).not.toContain(".loom");

    // and with no .gitignore entry at all
    fs.writeFileSync(path.join(dir, ".gitignore"), "");
    git(dir, "commit", "-qam", "unignore");
    script = [loom([{ type: "spawn", title: "state2", agent: "alpha", prompt: "write:.loom/state.json" }]), loom([{ type: "done", summary: "ok" }])];
    const run2 = await rt.orchestra.start({ goal: "state files 2", orchestrator: "conductor" });
    await settle(run2.id);
    const r2 = rt.orchestra.get(run2.id)!;
    expect(r2.tasks[0]!.status).toBe("done");
    expect(git(dir, "ls-tree", "-r", "--name-only", r2.branch)).not.toContain(".loom");
  });

  it("runs several tasks on the same worker agent at once, as separate sessions", async () => {
    await openProject();
    script = [
      loom([
        { type: "spawn", title: "one", agent: "alpha", prompt: "sleep:400 write:one.txt" },
        { type: "spawn", title: "two", agent: "alpha", prompt: "sleep:400 write:two.txt" },
        { type: "spawn", title: "three", agent: "alpha", prompt: "sleep:400 write:three.txt" },
      ]),
      loom([{ type: "done", summary: "ok" }]),
    ];
    const run = await rt.orchestra.start({ goal: "same agent thrice", orchestrator: "conductor", workers: ["alpha"] });
    await settle(run.id);
    const done = rt.orchestra.get(run.id)!;
    expect(done.status).toBe("completed");
    const starts = done.tasks.map((t) => t.startedAt!);
    const firstEnd = Math.min(...done.tasks.map((t) => t.finishedAt!));
    expect(starts.every((s) => s < firstEnd)).toBe(true);
  });

  it("caps parallelism at maxParallel", async () => {
    await openProject();
    script = [
      loom(
        ["a", "b", "c", "d"].map((n) => ({ type: "spawn", title: n, agent: "beta", prompt: `sleep:250 write:${n}.txt` })),
      ),
      loom([{ type: "done", summary: "ok" }]),
    ];
    const run = await rt.orchestra.start({ goal: "four", orchestrator: "conductor", workers: ["beta"], maxParallel: 2 });
    let peak = 0;
    const timer = setInterval(() => {
      const r = rt.orchestra.get(run.id);
      if (r) peak = Math.max(peak, r.tasks.filter((t) => t.status === "running").length);
    }, 10);
    await settle(run.id);
    clearInterval(timer);
    expect(rt.orchestra.get(run.id)!.status).toBe("completed");
    expect(peak).toBe(2);
  });

  it("reports a merge conflict to the orchestrator, and a follow-up can fix it", async () => {
    await openProject();
    script = [
      loom([
        { type: "spawn", id: "t1", title: "alpha writes x", agent: "alpha", prompt: "write:x.txt" },
        { type: "spawn", id: "t2", title: "beta writes x", agent: "beta", prompt: "sleep:200 write:x.txt" },
      ]),
      // round 2: sees the conflict, asks beta to take a different file
      loom([{ type: "send", task: "t2", message: "write:y.txt" }]),
      loom([{ type: "done", summary: "resolved" }]),
    ];
    const run = await rt.orchestra.start({ goal: "collide", orchestrator: "conductor" });
    await settle(run.id);
    const done = rt.orchestra.get(run.id)!;
    expect(seen[1]!.text).toContain("CONFLICT");
    expect(seen[1]!.text).toContain("git merge");
    // the follow-up re-ran t2 in the same worktree; its commit still carries the
    // conflicting x.txt, so it conflicts again — reported, not silently dropped
    expect(done.tasks.find((t) => t.id === "t2")!.attempts).toBe(2);
    expect(done.status).toBe("completed");
  });

  it("a worker that stops mid-turn to ask doesn't hang the goal: the question goes to the orchestrator", async () => {
    await openProject();
    rt.addAgent("asker", { id: "asker", role: "worker" });
    script = [
      loom([{ type: "spawn", id: "t1", title: "name a file", agent: "asker", prompt: "create the file" }]),
      // the review shows the question; the orchestrator answers with a follow-up
      loom([{ type: "send", task: "t1", message: "answer: use named.txt" }]),
      loom([{ type: "done", summary: "answered and done" }]),
    ];
    const run = await rt.orchestra.start({ goal: "ask me", orchestrator: "conductor" });
    await waitUntil(() => rt.orchestra.get(run.id)!.status === "completed", { timeoutMs: 20_000 });
    const review = seen.find((i) => i.text.includes("stopped to ask"));
    expect(review?.text).toContain("Which file name?");
    expect(review?.text).toContain('`send` action (task "t1")');
    expect(fs.readFileSync(path.join(rt.orchestra.get(run.id)!.dir, "named.txt"), "utf8")).toBe("ok\n");
  });

  it("asks again when the orchestrator forgets the actions block, then waits for the human", async () => {
    await openProject();
    script = ["I think we should do stuff.", "Still no block, sorry."];
    const run = await rt.orchestra.start({ goal: "vague", orchestrator: "conductor" });
    await settle(run.id);
    let r = rt.orchestra.get(run.id)!;
    expect(r.status).toBe("waiting_human");
    expect(seen[1]!.text).toContain("no ```loom actions block");

    script = [loom([{ type: "done", summary: "after human" }])];
    const answered = await rt.orchestra.reply(run.id, "just finish");
    // answered means the orchestrator is on it — not still "waiting on you"
    expect(answered.status).toBe("reviewing");
    await waitUntil(() => rt.orchestra.get(run.id)!.status === "completed");
    r = rt.orchestra.get(run.id)!;
    expect(r.summary).toBe("after human");
    expect(seen.at(-1)!.text).toContain("The human says: just finish");
  });

  it("an empty reply with nothing running waits for a human instead of looping to maxRounds", async () => {
    await openProject();
    script = [loom([{ type: "spawn", title: "one", agent: "alpha", prompt: "write:e.txt" }]), loom([])];
    const run = await rt.orchestra.start({ goal: "quiet", orchestrator: "conductor" });
    await settle(run.id);
    const r = rt.orchestra.get(run.id)!;
    expect(r.status).toBe("waiting_human");
    expect(r.round).toBe(2);
    expect(r.question).toMatch(/Nothing is running/);
  });

  it("an abort during the final wrap-up stands — it isn't overwritten by completed", async () => {
    await openProject();
    script = [loom([{ type: "spawn", title: "one", agent: "alpha", prompt: "write:f.txt" }]), loom([{ type: "done", summary: "ok" }])];
    let release!: () => void;
    stall = { entered: false, release: () => release(), gate: new Promise<void>((r) => (release = r)) };
    const run = await rt.orchestra.start({ goal: "race", orchestrator: "conductor" });
    try {
      // finish() is now parked in its wrap-up (stopping the agents)…
      await waitUntil(() => stall!.entered);
      // …and the human aborts right then
      const aborting = rt.orchestra.abort(run.id);
      stall.release();
      await aborting;
      await new Promise((r) => setTimeout(r, 200));
      expect(rt.orchestra.get(run.id)!.status).toBe("aborted");
    } finally {
      stall.release();
      stall = null;
    }
  });

  it("rejects work for agents outside the run's workers, and tells the orchestrator", async () => {
    await openProject();
    script = [
      loom([{ type: "spawn", title: "nope", agent: "gamma", prompt: "x" }]),
      loom([{ type: "done", summary: "fine" }]),
    ];
    const run = await rt.orchestra.start({ goal: "bad agent", orchestrator: "conductor", workers: ["alpha"] });
    await settle(run.id);
    expect(seen[1]!.text).toContain('agent "gamma" is not one of this run');
    expect(rt.orchestra.get(run.id)!.status).toBe("completed");
  });

  it("fails a task whose dependency failed, and aborts cleanly", async () => {
    await openProject();
    script = [
      loom([
        { type: "spawn", id: "t1", title: "boom", agent: "alpha", prompt: "fail:kaboom" },
        { type: "spawn", id: "t2", title: "after boom", agent: "beta", prompt: "write:z.txt", dependsOn: ["t1"] },
      ]),
      loom([{ type: "ask", question: "t1 failed — what now?" }]),
    ];
    const run = await rt.orchestra.start({ goal: "chain", orchestrator: "conductor" });
    await settle(run.id);
    const r = rt.orchestra.get(run.id)!;
    expect(r.status).toBe("waiting_human");
    expect(r.question).toContain("what now");
    // echo's fail: emits an error event rather than throwing — the error rides the result
    expect(r.tasks[0]!.error).toContain("kaboom");
    // a turn that died is failed, not merged — and its dependant never started
    expect(r.tasks.map((t) => t.status)).toEqual(["failed", "failed"]);
    expect(r.tasks[1]!.error).toContain("dependency failed");
    expect(r.tasks[1]!.attempts).toBe(0);
    await rt.orchestra.abort(run.id);
    expect(rt.orchestra.get(run.id)!.status).toBe("aborted");
  });

  it("refuses a second concurrent run and a non-git project", async () => {
    await openProject();
    script = [loom([{ type: "spawn", title: "slow", agent: "alpha", prompt: "sleep:600 write:s.txt" }])];
    const run = await rt.orchestra.start({ goal: "first", orchestrator: "conductor" });
    await expect(rt.orchestra.start({ goal: "second" })).rejects.toThrow(/still/);
    await rt.orchestra.abort(run.id);

    const plain = tmpDir("orch-plain");
    writeProjectConfig(plain, { name: "plain", agents: [{ id: "alpha", kind: "echo", role: "w" }], brain: { extractor: "off" } });
    const rt2 = await ProjectRuntime.open({ id: "plain", name: "plain", dir: plain });
    await expect(rt2.orchestra.start({ goal: "x" })).rejects.toThrow(/git repository/);
    await rt2.close();
  });

  it("a goal typed while one is running waits in the queue, then starts itself", async () => {
    await openProject();
    script = [
      loom([{ type: "spawn", title: "slow", agent: "alpha", prompt: "sleep:500 write:first.txt" }]),
      loom([{ type: "done", summary: "first done" }]),
      loom([{ type: "spawn", title: "next", agent: "alpha", prompt: "write:second.txt" }]),
      loom([{ type: "done", summary: "second done" }]),
    ];
    const first = await rt.orchestra.start({ goal: "the first goal", orchestrator: "conductor", workers: ["alpha"] });
    const queued = rt.enqueue({ text: "the second goal", target: { kind: "orchestra", orchestrator: "conductor", workers: ["alpha"] } });
    // one goal at a time: it waits for the running one rather than being refused
    expect(rt.queueBlocker(queued)).toMatch(/the first goal/);
    await settle(first.id);
    await waitUntil(() => rt.orchestra.list().some((r) => r.goal === "the second goal"), { timeoutMs: 20_000 });
    const second = rt.orchestra.list().find((r) => r.goal === "the second goal")!;
    await settle(second.id);
    expect(rt.orchestra.get(second.id)!.summary).toBe("second done");
    expect(rt.queue.length).toBe(0);
    expect(rt.queue.paused).toBe(false);
  });

  it("runs two goals at once when their paths can't collide, and refuses when they can", async () => {
    await openProject();
    // the project opts in; one at a time is still the default everywhere else.
    // Three, so the third goal is refused by the OVERLAP rule rather than by
    // the cap — that's the rule being tested.
    rt.config.maxConcurrentGoals = 3;
    script = [
      loom([{ type: "spawn", id: "t1", title: "auth", agent: "alpha", prompt: "sleep:1500 write:auth.txt", touches: ["src/auth/**"] }]),
      loom([{ type: "spawn", id: "t2", title: "billing", agent: "beta", prompt: "sleep:1500 write:billing.txt", touches: ["src/billing/**"] }]),
      loom([{ type: "done", summary: "auth done" }]),
      loom([{ type: "done", summary: "billing done" }]),
    ];
    const first = await rt.orchestra.start({ goal: "rework auth", orchestrator: "conductor", workers: ["alpha", "beta"] });
    await waitUntil(() => (rt.orchestra.get(first.id)?.tasks.length ?? 0) > 0, { timeoutMs: 20_000 });

    // disjoint: it starts beside the first rather than queueing
    const second = await rt.orchestra.start({
      goal: "rework billing",
      orchestrator: "conductor",
      workers: ["alpha", "beta"],
      touches: ["src/billing/**"],
    });
    expect(rt.orchestra.runningScopes().map((r) => r.runId).sort()).toEqual([first.id, second.id].sort());

    // overlapping: refused, and says what it collides with
    await expect(
      rt.orchestra.start({ goal: "auth again", orchestrator: "conductor", touches: ["src/auth/login.ts"] }),
    ).rejects.toThrow(/both touch/);

    await settle(first.id);
    await settle(second.id);
  }, 120_000);

  it("emits orchestra events that clients can render from, and shows in status", async () => {
    await openProject();
    script = [loom([{ type: "spawn", title: "one", agent: "alpha", prompt: "write:o.txt" }]), loom([{ type: "done", summary: "ok" }])];
    const run = await rt.orchestra.start({ goal: "events", orchestrator: "conductor" });
    await settle(run.id);
    const phases = rt.log
      .list({ kinds: ["orchestra"] })
      .filter((e) => e.payload.runId === run.id)
      .map((e) => e.payload.phase);
    expect(phases).toEqual(expect.arrayContaining(["started", "plan", "task", "task_started", "task_finished", "reviewing", "completed"]));
    const status = await rt.status();
    expect(status.orchestra).toMatchObject({ id: run.id, status: "completed", tasks: 1, done: 1 });
  });
});

/**
 * The status payload used to carry a task COUNT and nothing else, so no
 * surface could answer questions the daemon knew the answer to: which agent
 * owns a thread, whether a thread is still running, where a task's work went.
 * Three features needed the same three fields.
 */
describe("what the status payload says about a run's threads", () => {
  it("names every task's thread, agent and state — not just how many there are", async () => {
    await openProject();
    script = [
      loom([
        { type: "spawn", id: "t1", title: "first", agent: "alpha", prompt: "do the first thing" },
        { type: "spawn", id: "t2", title: "second", agent: "beta", prompt: "do the second thing" },
      ]),
      loom([{ type: "finish", summary: "done" }]),
    ];
    const run = await rt.orchestra.start({ goal: "two tasks", orchestrator: "conductor" });
    await settle(run.id);

    const summary = rt.orchestraSummary()!;
    expect(summary.tasks).toBe(2); // the count is still there
    const threads = summary.threads as Array<Record<string, string>>;
    expect(threads).toHaveLength(2);

    // Each row carries what a thread needs to identify itself.
    const t1 = threads.find((t) => t.id === "t1")!;
    expect(t1.agent).toBe("alpha");
    expect(t1.title).toBe("first");
    expect(t1.status).toBe("done");
    // …and a chat that really exists, because a thread id nothing can open is
    // worse than no thread id.
    expect(t1.chat).toBeTruthy();
    expect(rt.chats().some((c) => c.id === t1.chat)).toBe(true);

    // Two tasks on two agents are two different threads — the thing that was
    // impossible to see when every task claimed the baton holder.
    const t2 = threads.find((t) => t.id === "t2")!;
    expect(t2.agent).toBe("beta");
    expect(t2.chat).not.toBe(t1.chat);
  }, 60_000);
});

/**
 * Orchestrating from a thread used to abandon it: the run opened a thread of
 * its own, the UI walked you into it, and the thread you typed the goal in
 * said nothing about the goal ever again (#100).
 */
describe("which thread the orchestrator answers in", () => {
  it("answers in the thread the goal was given in, and does not open one of its own", async () => {
    await openProject();
    const before = rt.chats().length;
    script = [
      loom([{ type: "spawn", id: "t1", title: "first", agent: "alpha", prompt: "do it" }]),
      loom([{ type: "finish", summary: "done" }]),
    ];
    const run = await rt.orchestra.start({ goal: "stay here", orchestrator: "conductor", chat: "main" });

    expect(run.chat).toBe("main");
    expect(run.inPlace).toBe(true);
    // One new thread, and it is the task's — not a thread for the run.
    await settle(run.id);
    const made = rt.chats().filter((c) => c.id !== "main").map((c) => c.title);
    expect(rt.chats().length).toBe(before + 1);
    expect(made.some((t) => t.startsWith("t1 ·"))).toBe(true);
    expect(made.some((t) => t.includes("stay here"))).toBe(false);

    // The goal is not replayed: it is already in the thread you typed it in,
    // and saying it twice reads like the run misheard you.
    const said = rt.log
      .list({ limit: 500 })
      .filter((e) => e.kind === "message" && (e.chat ?? "main") === "main")
      .filter((e) => (e.payload as { author?: string }).author === "user");
    expect(said.filter((e) => (e.payload as { text?: string }).text === "stay here")).toHaveLength(0);
  }, 60_000);

  it("opens its own thread when no thread is named, and replays the goal into it", async () => {
    await openProject();
    script = [loom([{ type: "finish", summary: "done" }])];
    const run = await rt.orchestra.start({ goal: "somewhere new", orchestrator: "conductor" });

    expect(run.chat).not.toBe("main");
    expect(run.inPlace).toBeUndefined();
    expect(rt.chats().some((c) => c.id === run.chat && c.title.includes("somewhere new"))).toBe(true);
    // An empty thread has to be told what it is about.
    const opened = rt.log
      .list({ limit: 500 })
      .filter((e) => e.kind === "message" && e.chat === run.chat)
      .filter((e) => (e.payload as { author?: string }).author === "user");
    expect((opened[0]!.payload as { text: string }).text).toBe("somewhere new");
  }, 60_000);

  /**
   * A chat id is a claim about this machine's state. A run told to answer in a
   * thread that isn't there must not lose its output to an id nothing opens.
   */
  it("falls back to a thread of its own when the named one does not exist", async () => {
    await openProject();
    script = [loom([{ type: "finish", summary: "done" }])];
    const run = await rt.orchestra.start({ goal: "ghost thread", orchestrator: "conductor", chat: "nope" });
    expect(run.chat).not.toBe("nope");
    expect(rt.chats().some((c) => c.id === run.chat)).toBe(true);
    expect(run.inPlace).toBeUndefined();
  }, 60_000);

  /** The status poll has to carry it, because that is what the UI reads. */
  it("says on the status payload whether the thread is the run's own", async () => {
    await openProject();
    script = [loom([{ type: "finish", summary: "done" }])];
    const run = await rt.orchestra.start({ goal: "borrowed", orchestrator: "conductor", chat: "main" });
    await settle(run.id);
    const summary = rt.orchestraSummary()!;
    expect(summary.chat).toBe("main");
    expect(summary.inPlace).toBe(true);
  }, 60_000);
});
