/**
 * How a turn ended, read from the events after it was sent — for
 * `loom send --wait`, so a script doesn't have to poll .loom/log.db (#254).
 * Pure.
 */

import type { LoomEvent } from "../types.js";

export type TurnStatus = "ok" | "error" | "needs_input";

export interface TurnOutcome {
  status: TurnStatus;
  agent: string;
  reply: string;
  /**
   * What the turn cost, or null when the agent didn't say. A subscription CLI (codex on a
   * ChatGPT plan, …) reports nothing or $0 — and "$0" read as "free" (field feedback).
   */
  costUsd: number | null;
  durationMs?: number;
  error?: string;
  question?: string;
}

/** The turn `agentId` ran after event `sinceId`, once it has ended; null while it's still going. */
export function turnOutcome(events: LoomEvent[], agentId: string, sinceId: number, chat?: string): TurnOutcome | null {
  let reply = "", costUsd = 0;
  for (const e of events) {
    if (e.id <= sinceId || e.agentId !== agentId) continue;
    if (chat !== undefined && (e.chat ?? "main") !== chat) continue;
    const p = e.payload ?? {};
    if (p.retrying === true) continue;
    if (e.kind === "message" && !p.reasoning && typeof p.text === "string") reply = p.text;
    else if (e.kind === "status" && p.state === "turn_cost") costUsd += Number(p.costUsd ?? 0) || 0;
    else if (e.kind === "needs_input") return { status: "needs_input", agent: agentId, reply, costUsd: costUsd || null, question: String(p.question ?? "") };
    else if (e.kind === "error") return { status: "error", agent: agentId, reply, costUsd: costUsd || null, error: String(p.message ?? "the turn failed") };
    else if (e.kind === "run_complete") {
      const out: TurnOutcome = { status: p.error ? "error" : "ok", agent: agentId, reply, costUsd: costUsd || Number(p.costUsd ?? 0) || null,
        ...(typeof p.durationMs === "number" ? { durationMs: p.durationMs } : {}) };
      if (p.error) out.error = String(p.error);
      return out;
    }
  }
  return null;
}

/** What `send` answered: a busy agent queues the message and names the request that will run it. */
export interface SentTurn {
  agentId: string;
  requestId?: string;
  queueId?: string;
  answered?: boolean;
}

/**
 * The outcome of the turn this send started. A queued send's turn begins at the `turn_started`
 * carrying its requestId (an edited queue item runs as `<requestId>:edit:<ts>`), in the chat it
 * was queued for — the turn already running when it was sent ends first, and its result is not
 * this one's. Anything else (it ran at once, or it answered a question) reads from the send on.
 */
export function sentTurnOutcome(events: LoomEvent[], sent: SentTurn, sinceId: number): TurnOutcome | null {
  if (!sent.queueId || !sent.requestId || sent.answered) return turnOutcome(events, sent.agentId, sinceId);
  const rid = sent.requestId;
  const start = events.find((e) => {
    if (e.id <= sinceId || e.agentId !== sent.agentId || e.kind !== "status" || e.payload?.state !== "turn_started") return false;
    const r = e.payload?.requestId;
    return typeof r === "string" && (r === rid || r.startsWith(`${rid}:`));
  });
  if (!start) return null;
  return turnOutcome(events, sent.agentId, start.id - 1, start.chat ?? "main");
}

/** The exit code a script reads: 0 done, 1 failed, 2 waiting on a question, 124 timed out. */
export function exitCodeFor(o: TurnOutcome | null): number {
  if (!o) return 124;
  return o.status === "ok" ? 0 : o.status === "needs_input" ? 2 : 1;
}
