/**
 * loom council: one planner and several reviewers take a goal through plan →
 * backtest → decide → build → prove → forward-test → fix. Only the planner
 * writes; every finding it accepts or rejects is recorded; Proof says whether
 * the tests pass.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { backtestText, buildPrompt, decidePrompt, parseVerdicts, PLAN_ROOM, STAGES } from "../src/core/council.js";
import type { Finding, ReviewTarget } from "../src/core/review.js";
import { writeProjectConfig } from "../src/core/registry.js";
import { CouncilRunner, type CouncilHost } from "../src/daemon/council.js";
import type { ReviewState } from "../src/daemon/review.js";
import { pushCategory } from "../src/daemon/push.js";
import { ProjectRuntime } from "../src/daemon/runtime.js";
import type { LoomEvent, NewEvent } from "../src/types.js";
import { tmpDir, waitUntil } from "./helpers.js";

const f = (id: string, extra: Partial<Finding> = {}): Finding => ({ id, agent: "codex", severity: "high", file: "src/a.ts", line: 3, text: "races", ...extra });

describe("what the planner is asked, and how its verdicts are read", () => {
  it("reads ACCEPT / REJECT / FIXED lines for findings it knows, however they're dressed", () => {
    const v = parseVerdicts([
      "ACCEPT r1.1 — will add a lock",
      "- **REJECT** r1.2: not reachable from the API",
      "2. FIXED r1.3 moved the check up",
      "ACCEPT r9.9 — not one of ours",
      "I'll think about r1.4",
    ].join("\n"), ["r1.1", "r1.2", "r1.3", "r1.4"]);
    expect([...v.entries()]).toEqual([
      ["r1.1", { decision: "accepted", note: "will add a lock" }],
      ["r1.2", { decision: "rejected", note: "not reachable from the API" }],
      ["r1.3", { decision: "accepted", note: "moved the check up" }],
    ]);
  });

  it("the prompts carry the findings, and a long plan is cut to fit a review brief", () => {
    expect(decidePrompt([f("r1.1", { agreed: [{ agent: "grok", text: "x" }] })])).toContain("r1.1 [high] codex + grok: src/a.ts:3 — races");
    expect(buildPrompt("ship it", [f("r1.1")], [f("r1.2")])).toMatch(/Fold in the findings you accepted:\nr1\.1[\s\S]*leave them:\nr1\.2/);
    expect(backtestText("g", "x".repeat(PLAN_ROOM + 500))).toContain(`(plan cut at ${PLAN_ROOM} characters)`);
    expect(STAGES.map((s) => s.key)).toEqual(["plan", "backtest", "decide", "build", "prove", "forward", "fix"]);
  });
});

/** A host with scripted replies: the planner's turn n gets replies[n]; reviews return the given findings. */
function fakeHost(script: { replies: string[]; backtest: Finding[]; forward: Finding[]; proofs: Array<{ verdict: string; headline: string }>; diff?: boolean; failTurn?: number }) {
  const events: LoomEvent[] = [];
  let id = 0, turnNo = 0, reviewNo = 0;
  const reviews = new Map<string, ReviewState>();
  const sent: Array<{ text: string; plan: boolean }> = [];
  const decided: Array<[string, string, string | undefined]> = [];
  const handoffs: string[] = [];
  const append = (e: NewEvent) => { const ev = { ...e, id: ++id, ts: Date.now() } as LoomEvent; events.push(ev); return ev; };
  const host: CouncilHost = {
    hasAgent: (a) => ["lead", "codex", "grok"].includes(a),
    canWrite: (a) => a === "lead",
    createChat: () => ({ id: "c1" }),
    holder: () => undefined,
    handoff: async (to) => { handoffs.push(to); },
    send: async (agentId, text, opts) => {
      sent.push({ text, plan: opts.plan });
      const n = turnNo++;
      setTimeout(() => {
        if (script.failTurn === n) { append({ kind: "error", agentId, chat: "c1", payload: { message: "agent crashed" } }); return; }
        append({ kind: "message", agentId, chat: "c1", payload: { text: script.replies[n] ?? "ok" } });
        append({ kind: "run_complete", agentId, chat: "c1", payload: {} });
      }, 5);
    },
    interrupt: async () => {},
    checkReviewers: (ids) => ids,
    startReview: async (input) => {
      const reviewId = `r${++reviewNo}`;
      const findings = (reviewNo === 1 ? script.backtest : script.forward).map((x, i) => ({ ...x, id: `${reviewId}.${i + 1}` }));
      reviews.set(reviewId, { reviewId, chat: input.chat, target: { kind: input.target.kind }, agents: input.agents, status: "done", findings, results: [], summary: `${findings.length} findings` });
      return { ...reviews.get(reviewId)!, status: "running" };
    },
    reviewStatus: (rid) => reviews.get(rid) ?? null,
    diffTarget: (): ReviewTarget => { if (!script.diff) throw new Error("no changes"); return { kind: "diff", diff: "+x" }; },
    decide: (fid, d, note) => { decided.push([fid, d, note]); },
    prove: async () => script.proofs.shift() ?? null,
    list: (opts) => events.filter((e) => (!opts.kinds || opts.kinds.includes(e.kind)) && (!opts.chat || e.chat === opts.chat) && (!opts.agentId || e.agentId === opts.agentId)),
    append,
    lastId: () => id,
    warn: () => {},
  };
  return { host, events, sent, decided, handoffs };
}

describe("the council's stages", () => {
  it("plans, backtests, records the planner's verdicts, builds, proves, forward-tests and fixes — in order", async () => {
    const h = fakeHost({
      replies: ["1. add a lock to src/a.ts\n2. test it with npm test", "ACCEPT r1.1 — lock it\nREJECT r1.2 — out of scope", "Built. 4 tests pass.", "FIXED r2.1 — handled null\nREJECT r2.2 — style"],
      backtest: [f("x"), f("y", { severity: "low" })],
      forward: [f("x", { severity: "medium" }), f("y", { severity: "medium" }), f("z", { severity: "low" })],
      proofs: [{ verdict: "verified", headline: "4 tests pass in a clean checkout" }, { verdict: "verified", headline: "4 tests pass" }],
      diff: true,
    });
    const runner = new CouncilRunner(h.host);
    runner.pollMs = 5;
    const c = runner.start({ goal: "make the cache safe", planner: "lead", reviewers: ["codex", "grok"] });
    await waitUntil(() => runner.status(c.councilId)!.status !== "running", { timeoutMs: 10_000 });
    const s = runner.status(c.councilId)!;
    expect(s.status).toBe("done");
    expect(s.stages.map((x) => [x.key, x.status])).toEqual(STAGES.map((x) => [x.key, "done"]));
    expect(h.handoffs).toEqual(["lead"]);
    // plan and decide are plan-mode turns; build and fix aren't
    expect(h.sent.map((x) => x.plan)).toEqual([true, true, false, false]);
    expect(h.sent[2]!.text).toContain("Fold in the findings you accepted:\nr1.1");
    // the fix round only gets the findings worth fixing (not the low one)
    expect(h.sent[3]!.text).toContain("r2.1");
    expect(h.sent[3]!.text).not.toContain("r2.3");
    expect(h.decided).toEqual([["r1.1", "accepted", "lock it"], ["r1.2", "rejected", "out of scope"], ["r2.1", "accepted", "handled null"], ["r2.2", "rejected", "style"]]);
    expect(s.stages.find((x) => x.key === "decide")!.detail).toBe("1 accepted · 1 rejected");
    expect(s.summary).toBe("built · Proof verified · plan: 1 accepted · 1 rejected · diff: 1 fixed · 1 rejected");
    const done = h.events.find((e) => e.kind === "council" && e.payload.phase === "done")!;
    expect(pushCategory(done)).toBe("goals");
  });

  it("skips what has nothing to do, and a failed turn stops the council where it failed", async () => {
    const quiet = fakeHost({ replies: ["the plan"], backtest: [], forward: [], proofs: [] });
    const r1 = new CouncilRunner(quiet.host); r1.pollMs = 5;
    const c1 = r1.start({ goal: "g", planner: "lead", reviewers: ["codex"] });
    await waitUntil(() => r1.status(c1.councilId)!.status !== "running", { timeoutMs: 10_000 });
    expect(r1.status(c1.councilId)!.stages.map((x) => x.status)).toEqual(["done", "done", "skipped", "done", "skipped", "skipped", "skipped"]);

    const broken = fakeHost({ replies: ["the plan"], backtest: [], forward: [], proofs: [], failTurn: 1 });
    const r2 = new CouncilRunner(broken.host); r2.pollMs = 5;
    const c2 = r2.start({ goal: "g", planner: "lead", reviewers: ["codex"] });
    await waitUntil(() => r2.status(c2.councilId)!.status !== "running", { timeoutMs: 10_000 });
    const s = r2.status(c2.councilId)!;
    expect(s.status).toBe("failed");
    expect(s.stages.find((x) => x.key === "build")).toMatchObject({ status: "failed", detail: "agent crashed" });
    expect(s.summary).toBe("failed at Build: agent crashed");
  });

  it("refuses what it can't run, one at a time, and closes a council a restart cut off", async () => {
    const h = fakeHost({ replies: [], backtest: [], forward: [], proofs: [] });
    const runner = new CouncilRunner(h.host);
    expect(() => runner.start({ goal: "", planner: "lead", reviewers: ["codex"] })).toThrow(/needs a goal/);
    expect(() => runner.start({ goal: "g", planner: "codex", reviewers: ["grok"] })).toThrow(/can't plan and build/);
    expect(() => runner.start({ goal: "g", planner: "lead", reviewers: ["lead"] })).toThrow(/at least one reviewer other than the planner/);
    h.host.append({ kind: "council", chat: "c9", payload: { phase: "started", councilId: "old", goal: "g", planner: "lead", reviewers: ["codex"], chat: "c9", stages: [] } });
    h.host.append({ kind: "council", chat: "c9", payload: { phase: "stage", councilId: "old", stage: "build", status: "running" } });
    const after = new CouncilRunner(h.host);
    expect(after.status("old")).toMatchObject({ status: "failed", summary: "stopped at Build: Loom restarted" });
  });
});

let rt: ProjectRuntime | undefined;
afterEach(async () => { await rt?.close(); rt = undefined; });
beforeAll(() => {
  process.env.LOOM_HOME = tmpDir("home-council");
  process.env.LOOM_NO_NOTIFY = "1";
});

describe("a council in a project", () => {
  it("runs end to end with real agents: the planner holds the baton, the reviewers read its plan and its diff", async () => {
    const dir = tmpDir("council");
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
    fs.writeFileSync(path.join(dir, ".gitignore"), ".loom/\n");
    execFileSync("git", ["add", "-A"], { cwd: dir });
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "seed"], { cwd: dir });
    writeProjectConfig(dir, { name: "council", agents: [{ id: "lead", kind: "echo" }, { id: "codex", kind: "echo" }, { id: "grok", kind: "echo" }], defaultAgent: "codex", brain: { extractor: "off" } });
    rt = await ProjectRuntime.open({ id: `council-${path.basename(dir)}`, name: "council", dir });
    rt.councils.pollMs = 50;
    // echo writes the file it's asked to (write:), so the build leaves a diff for the forward test
    const c = rt.councils.start({ goal: "greet people write:hello.txt", planner: "lead", reviewers: ["codex", "grok"] });
    await waitUntil(() => rt!.councils.status(c.councilId)!.status !== "running", { timeoutMs: 60_000 });
    const s = rt.councils.status(c.councilId)!;
    expect(s.status).toBe("done");
    expect(rt.baton.holder()).toBe("lead");
    expect(s.stages.find((x) => x.key === "backtest")!.status).toBe("done");
    expect(s.stages.find((x) => x.key === "forward")).toMatchObject({ status: "done" });
    // both reviews ran in the council's chat, and the forward one read the new file
    const reviews = rt.log.list({ kinds: ["review"], chat: c.chat }).filter((e) => e.payload.phase === "started");
    expect(reviews.map((e) => (e.payload.target as { kind: string }).kind)).toEqual(["text", "diff"]);
    expect(String(rt.log.list({ kinds: ["subtask_started"] }).at(-1)!.payload.task)).toContain("hello.txt");
    // echo has no plan mode and ignores "read-only" — the review says so, which is how you'd catch a real agent doing it
    const backtest = rt.log.list({ kinds: ["review"], chat: c.chat }).find((e) => e.payload.phase === "done")!;
    expect((backtest.payload.results as Array<{ agent: string; edited?: string[] }>).map((r) => r.edited)).toEqual([["hello.txt"], ["hello.txt"]]);
    expect(String(backtest.payload.summary)).toContain("⚠ 2 changed files in a read-only review");
    expect(() => rt!.councils.start({ goal: "again", planner: "lead", reviewers: ["codex"] })).not.toThrow();
    await waitUntil(() => !rt!.councils.active, { timeoutMs: 60_000 });
  }, 120_000);
});
