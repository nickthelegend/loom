/**
 * What happened while you were away.
 *
 * Come back after a few hours and the answer lives in a thread you have to
 * scroll, across however many chats an orchestra opened. Every fact is already
 * recorded — turns, goals, costs, landings, questions, crashes — so this reads
 * them back as sentences, newest first, each one pointing at the moment it
 * came from.
 *
 * It states what happened; it never guesses at why. A line without an event
 * behind it doesn't get written.
 */

import type { LoomEvent } from "../types.js";

export interface DigestLine {
  at: number;
  /** For the UI: which pill to paint, and what to jump to. */
  kind: "goal" | "question" | "landed" | "failed" | "cost" | "server" | "turn";
  text: string;
  /** The event this came from, so a click can go there. */
  eventId: number;
  chat?: string;
}

export interface Digest {
  since: number;
  lines: DigestLine[];
  /** Totals worth one line at the top, when there's anything to total. */
  turns: number;
  costUsd: number;
  /** What is still waiting on the person right now. */
  waiting: string[];
}

/** How many lines a digest may be before it stops being a digest. */
export const MAX_LINES = 40;

/**
 * Read events into sentences.
 *
 * `agentLabel` turns an id into whatever the UI calls it, so the digest reads
 * the way the rest of the app does.
 */
export function digest(events: LoomEvent[], since: number, agentLabel: (id: string) => string = (x) => x): Digest {
  const fresh = events.filter((e) => e.ts > since);
  const lines: DigestLine[] = [];
  const waiting = new Set<string>();
  let turns = 0;
  let costUsd = 0;

  for (const e of fresh) {
    const p = (e.payload ?? {}) as Record<string, unknown>;
    const who = e.agentId ? agentLabel(e.agentId) : "an agent";
    const line = (kind: DigestLine["kind"], text: string) =>
      lines.push({ at: e.ts, kind, text, eventId: e.id, ...(e.chat ? { chat: e.chat } : {}) });

    if (e.kind === "run_complete") {
      turns++;
      costUsd += Number(p.costUsd ?? 0);
      continue; // turns are a total, not forty lines
    }
    if (e.kind === "needs_input") {
      waiting.add(who);
      line("question", `${who} asked: ${String(p.question ?? "something").slice(0, 160)}`);
      continue;
    }
    if (e.kind === "error") {
      line("failed", `${who} hit an error: ${String(p.message ?? "").slice(0, 160)}`);
      continue;
    }
    if (e.kind === "status" && p.state === "server_crashed") {
      line("server", `the ${String(p.server)} server exited (code ${String(p.exitCode ?? "?")})`);
      continue;
    }
    if (e.kind === "orchestra") {
      const phase = String(p.phase ?? "");
      const goal = String(p.goal ?? "").slice(0, 80);
      if (phase === "started") line("goal", `a goal started: ${goal || String(p.runId ?? "")}`);
      else if (phase === "completed") line("goal", `a goal finished${p.summary ? `: ${String(p.summary).slice(0, 120)}` : ""}`);
      else if (phase === "failed") line("failed", `a goal failed${p.error ? `: ${String(p.error).slice(0, 120)}` : ""}`);
      else if (phase === "waiting") line("question", `a goal is waiting on you: ${String(p.question ?? "").slice(0, 160)}`);
      else if (phase === "landing" && (p.landing as { state?: string } | undefined)?.state === "merged") {
        line("landed", `a goal landed on the default branch`);
      }
      continue;
    }
  }

  // Newest first: the last thing that happened is the thing you want first.
  lines.sort((a, b) => b.at - a.at);
  if (costUsd > 0 || turns > 0) {
    lines.unshift({
      at: Date.now(),
      kind: "cost",
      text: `${turns} turn${turns === 1 ? "" : "s"}${costUsd > 0 ? ` · $${costUsd.toFixed(2)}` : ""}`,
      eventId: 0,
    });
  }
  return { since, lines: lines.slice(0, MAX_LINES), turns, costUsd, waiting: [...waiting] };
}
