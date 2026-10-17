/**
 * Council: one planner, several reviewers, one goal — planned, backtested,
 * decided, built, proved, forward-tested and fixed, in that order. The
 * planner is the only agent that writes; the reviewers only read. This file
 * is the pure part: the stages, what each turn is asked, and the reading of
 * the planner's verdicts. daemon/council.ts runs it.
 */

import type { Finding } from "./review.js";

export const STAGES = [
  { key: "plan", name: "Plan", what: "the planner plans — no edits" },
  { key: "backtest", name: "Backtest", what: "reviewers test the plan, read-only, in parallel" },
  { key: "decide", name: "Decide", what: "the planner accepts or rejects each finding — recorded as decisions" },
  { key: "build", name: "Build", what: "only the planner implements" },
  { key: "prove", name: "Prove", what: "Proof re-runs the tests in a clean checkout" },
  { key: "forward", name: "Forward-test", what: "reviewers read the diff, read-only, in parallel" },
  { key: "fix", name: "Fix", what: "the planner fixes what it agrees with, then Proof again" },
] as const;

export type StageKey = (typeof STAGES)[number]["key"];
export type StageStatus = "waiting" | "running" | "done" | "skipped" | "failed";

/** A plan a reviewer brief can carry: the subtask limit is 10k, and the review's own instructions need room. */
export const PLAN_ROOM = 6_500;

export function planPrompt(goal: string): string {
  return [
    `[Loom council] Goal: ${goal}`,
    "Plan it — do not edit anything yet. Reviewers will test this plan before any code is written, so make it checkable:",
    "numbered steps; the files each step touches; the risky parts; and how you will test that it works (the exact command).",
  ].join("\n");
}

export function backtestText(goal: string, plan: string): string {
  const p = plan.length > PLAN_ROOM ? `${plan.slice(0, PLAN_ROOM)}\n… (plan cut at ${PLAN_ROOM} characters)` : plan;
  return `this plan, before any code is written, for the goal "${goal}":\n\n${p}`;
}

export const BACKTEST_FOCUS = "backtest the plan: what it misses, what breaks, wrong assumptions about the code (read the files it names), and a test it should add";
export const FORWARD_FOCUS = "forward-test the change against the goal and the plan: bugs, missed cases, broken tests, anything the plan promised that isn't there";

const line = (f: Finding) => `${f.id} [${f.severity ?? "note"}] ${f.agent}${f.agreed?.length ? ` + ${f.agreed.map((a) => a.agent).join(" + ")}` : ""}: ${f.file ? `${f.file}${f.line ? `:${f.line}` : ""} — ` : ""}${f.text}`;

export function decidePrompt(findings: Finding[]): string {
  return [
    "[Loom council] The reviewers backtested your plan. Their findings:",
    findings.map(line).join("\n"),
    "Decide each one — still no edits. Answer with one line per finding, exactly:\nACCEPT <id> — what you'll change in the plan\nREJECT <id> — why it doesn't apply",
  ].join("\n\n");
}

export function buildPrompt(goal: string, accepted: Finding[], rejected: Finding[]): string {
  return [
    `[Loom council] Build it now: ${goal}`,
    "Implement your plan. You are the only agent changing files in this council.",
    accepted.length ? `Fold in the findings you accepted:\n${accepted.map(line).join("\n")}` : "",
    rejected.length ? `You rejected these — leave them:\n${rejected.map((f) => f.id).join(", ")}` : "",
    "Run the tests before you finish, and say what you ran and what it printed.",
  ].filter(Boolean).join("\n\n");
}

export function fixPrompt(findings: Finding[], proofHeadline?: string): string {
  return [
    "[Loom council] Fix round. The reviewers read your diff" + (proofHeadline ? `, and Proof said: ${proofHeadline}` : "") + ".",
    findings.length ? `Their findings:\n${findings.map(line).join("\n")}` : "",
    "Fix what you agree with. Then answer with one line per finding: FIXED <id> — what you changed, or REJECT <id> — why. Run the tests again before you finish.",
  ].filter(Boolean).join("\n\n");
}

/** The planner's verdicts: `ACCEPT r1.2 — …`, `REJECT r1.3: …`, `FIXED r1.4 …` (FIXED is an accept). */
export function parseVerdicts(reply: string, ids: string[]): Map<string, { decision: "accepted" | "rejected"; note?: string }> {
  const known = new Set(ids);
  const out = new Map<string, { decision: "accepted" | "rejected"; note?: string }>();
  for (const raw of reply.split("\n")) {
    const m = raw.replace(/[*_`]/g, "").match(/^\s*(?:[-*•]|\d+[.)])?\s*(ACCEPT(?:ED)?|REJECT(?:ED)?|FIXED)\s*:?\s*([\w-]+\.\d+)\b\s*[:—–-]*\s*(.*)$/i);
    if (!m || !known.has(m[2]!)) continue;
    const note = m[3]!.trim();
    out.set(m[2]!, { decision: /^reject/i.test(m[1]!) ? "rejected" : "accepted", ...(note ? { note: note.slice(0, 300) } : {}) });
  }
  return out;
}

/** Findings worth a fix round: high or medium, or unrated. */
export const worthFixing = (f: Finding) => f.severity !== "low";
