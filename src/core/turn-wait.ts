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
  costUsd: number;
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
    if (e.kind === "message" && !p.reasoning && typeof p.text === "string") reply = p.text;
    else if (e.kind === "status" && p.state === "turn_cost") costUsd += Number(p.costUsd ?? 0) || 0;
    else if (e.kind === "needs_input") return { status: "needs_input", agent: agentId, reply, costUsd, question: String(p.question ?? "") };
    else if (e.kind === "error") return { status: "error", agent: agentId, reply, costUsd, error: String(p.message ?? "the turn failed") };
    else if (e.kind === "run_complete") {
      const out: TurnOutcome = { status: p.error ? "error" : "ok", agent: agentId, reply, costUsd: costUsd || Number(p.costUsd ?? 0) || 0,
        ...(typeof p.durationMs === "number" ? { durationMs: p.durationMs } : {}) };
      if (p.error) out.error = String(p.error);
      return out;
    }
  }
  return null;
}

/** The exit code a script reads: 0 done, 1 failed, 2 waiting on a question, 124 timed out. */
export function exitCodeFor(o: TurnOutcome | null): number {
  if (!o) return 124;
  return o.status === "ok" ? 0 : o.status === "needs_input" ? 2 : 1;
}
