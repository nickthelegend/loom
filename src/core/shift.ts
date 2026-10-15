/**
 * Night Shift: line up work, go to sleep, wake up to a report you can trust.
 *
 * Each task runs in its own chat, one after another, through the queue. While
 * the shift runs, Proof checks every "done" against what ran and a clean
 * re-run, the loop watch nudges an agent going in circles, and Quota Relay
 * hands work on when an agent runs out. This file is the part that reads a
 * task's chat afterwards and says, plainly, how it went. Pure.
 */

import type { LoomEvent } from "../types.js";

export type ShiftTaskStatus = "verified" | "done" | "didnt_hold" | "failed" | "needs_you" | "not_started" | "running";

export interface ShiftTask {
  text: string;
  chat: string;
  /** The queue item it went out as, until it's dispatched. */
  queueId?: string;
  /** Set once the shift knows it won't run (stopped by the clock or the budget). */
  skipped?: boolean;
}

export interface ShiftConfig {
  id: string;
  startedAt: number;
  /** Who takes the tasks; absent → whoever the queue would pick (auto). */
  to?: string;
  /** Stop starting new tasks after this moment (epoch ms). */
  until?: number;
  /** Stop starting new tasks once the shift has spent this much. */
  maxUsd?: number;
  tasks: ShiftTask[];
  /** Set when it stops early, with why. */
  stopped?: string;
  /** Set once the report has gone out. */
  reportedAt?: number;
}

export interface TaskOutcome {
  text: string;
  chat: string;
  status: ShiftTaskStatus;
  agent?: string;
  /** Proof's one-line verdict, when it checked. */
  headline?: string;
  /** Times the loop watch caught it going in circles. */
  loops: number;
  files: string[];
  costUsd: number;
  ms: number;
  error?: string;
  question?: string;
}

export interface ShiftReport {
  shiftId: string;
  startedAt: number;
  endedAt: number;
  tasks: TaskOutcome[];
  counts: Record<ShiftTaskStatus, number>;
  costUsd: number;
  stopped?: string;
  /** "4 tasks: 3 verified, 1 needs you" */
  summary: string;
}

/** How one task went, from its chat's events. */
export function outcomeOf(task: ShiftTask, events: LoomEvent[], opts: { queued?: boolean } = {}): TaskOutcome {
  const base: TaskOutcome = { text: task.text, chat: task.chat, status: "not_started", loops: 0, files: [], costUsd: 0, ms: 0 };
  if (opts.queued || task.skipped) return base;
  const files = new Set<string>();
  let lastDone: LoomEvent | undefined, lastProof: LoomEvent | undefined, lastAsk: LoomEvent | undefined, lastSay: LoomEvent | undefined, lastAnswer: LoomEvent | undefined, lastError: LoomEvent | undefined;
  for (const e of events) {
    const p = e.payload ?? {};
    if (e.kind === "run_complete" && e.agentId) { lastDone = e; base.ms += Number(p.durationMs ?? 0) || 0; base.agent = e.agentId; }
    else if (e.kind === "proof") lastProof = e;
    else if (e.kind === "needs_input") lastAsk = e;
    else if (e.kind === "message" && !e.agentId) lastSay = e;
    else if (e.kind === "error" && e.agentId) lastError = e;
    else if (e.kind === "turn_diff") for (const f of (p.files as Array<{ path: string }> | undefined) ?? []) files.add(f.path);
    else if (e.kind === "status" && p.state === "question_answered") lastAnswer = e;
    else if (e.kind === "status" && p.state === "loop_detected") base.loops++;
    else if (e.kind === "status" && p.state === "turn_cost") base.costUsd += Number(p.costUsd ?? 0) || 0;
  }
  base.files = [...files];
  base.costUsd = Math.round(base.costUsd * 10_000) / 10_000;
  if (lastDone?.payload.error) return { ...base, status: "failed", error: String(lastDone.payload.error).slice(0, 300) };
  // a turn that died with an error (no clean end after it, nothing said since)
  if (lastError && (!lastDone || lastError.id > lastDone.id) && (!lastSay || lastError.id > lastSay.id)) {
    return { ...base, status: "failed", agent: lastError.agentId ?? base.agent, error: String(lastError.payload.message ?? "it stopped with an error").slice(0, 300) };
  }
  // an open question: asked after the last thing you (or the queue) said, and not answered — whether the
  // agent's turn is parked on it or ended on it, it's waiting for you
  if (lastAsk && (!lastSay || lastAsk.id > lastSay.id) && (!lastAnswer || lastAsk.id > lastAnswer.id)) {
    return { ...base, status: "needs_you", agent: lastAsk.agentId ?? base.agent, question: String(lastAsk.payload.question ?? "") };
  }
  if (!lastDone) return { ...base, status: lastSay ? "running" : "not_started" };
  // Proof only counts when it checked the last turn (a nudge can come after it)
  if (lastProof && lastProof.id > lastDone.id) {
    const v = String(lastProof.payload.verdict ?? "");
    const headline = String(lastProof.payload.headline ?? "");
    if (v === "contradicted") return { ...base, status: "didnt_hold", headline };
    if (v === "verified") return { ...base, status: "verified", headline };
    return { ...base, status: "done", headline };
  }
  return { ...base, status: "done" };
}

const WORDS: Record<ShiftTaskStatus, string> = {
  verified: "verified", done: "done (not checked)", didnt_hold: "didn't hold", failed: "failed",
  needs_you: "need you", not_started: "not started", running: "still running",
};
const ORDER: ShiftTaskStatus[] = ["verified", "done", "didnt_hold", "failed", "needs_you", "running", "not_started"];

export function report(shift: ShiftConfig, outcomes: TaskOutcome[], endedAt = Date.now()): ShiftReport {
  const counts = Object.fromEntries(ORDER.map((s) => [s, 0])) as Record<ShiftTaskStatus, number>;
  for (const o of outcomes) counts[o.status]++;
  const parts = ORDER.filter((s) => counts[s]).map((s) => `${counts[s]} ${s === "needs_you" && counts[s] === 1 ? "needs you" : WORDS[s]}`);
  const n = outcomes.length;
  return {
    shiftId: shift.id, startedAt: shift.startedAt, endedAt, tasks: outcomes, counts,
    costUsd: Math.round(outcomes.reduce((x, o) => x + o.costUsd, 0) * 10_000) / 10_000,
    ...(shift.stopped ? { stopped: shift.stopped } : {}),
    summary: `${n} task${n === 1 ? "" : "s"}: ${parts.join(", ")}`,
  };
}

/** "7:00", "07:30", "7am", "6:45 pm", or an ISO time → the next such moment after `now`. */
export function parseUntil(raw: string | number | undefined, now = Date.now()): number | undefined {
  if (raw === undefined || raw === "") return undefined;
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : undefined;
  const m = /^\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*$/i.exec(raw);
  if (m) {
    let h = Number(m[1]); const min = Number(m[2] ?? 0); const ap = m[3]?.toLowerCase();
    if (ap === "pm" && h < 12) h += 12;
    if (ap === "am" && h === 12) h = 0;
    if (h > 23 || min > 59) throw new Error(`"${raw}" isn't a time of day`);
    const d = new Date(now); d.setHours(h, min, 0, 0);
    if (d.getTime() <= now) d.setDate(d.getDate() + 1);
    return d.getTime();
  }
  const t = Date.parse(raw);
  if (!Number.isFinite(t)) throw new Error(`"${raw}" isn't a time I can read — try 7:00, 6:30am or an ISO time`);
  return t;
}

/** One task per line; blank lines and "- " / "1. " list markers dropped. */
export function parseTasks(raw: string | string[]): string[] {
  const lines = Array.isArray(raw) ? raw : raw.split("\n");
  return lines.map((l) => String(l).replace(/^\s*(?:[-*•]|\d+[.)])\s+/, "").trim()).filter(Boolean).slice(0, 50);
}
