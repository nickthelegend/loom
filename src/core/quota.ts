/**
 * Quota Relay — recognising "this agent is out of quota", and until when.
 *
 * A subscription CLI that hits its 5-hour or weekly cap mid-task either parks
 * the turn until the reset (Claude Code: no result arrives for hours) or ends
 * it with an error (Codex: "You've hit your usage limit… try again at 3:04
 * PM"). Either way the work stops. Loom sees both: Claude and Codex report
 * their windows as a `usage_limits` status with `reached` set, and every CLI
 * says it in words. This file turns either into { resetAt }; the runtime
 * (daemon/runtime/relay.ts) hands the work to the next agent.
 */

import type { LoomEvent } from "../types.js";

export interface QuotaHit {
  /** When the limit lifts (epoch ms), when the agent said; otherwise a guess an hour out. */
  resetAt: number;
  /** Whether resetAt came from the agent rather than the default. */
  known: boolean;
  /** Which window: "five_hour", "seven_day", "primary"… or "limit". */
  window: string;
  /** The words, for the thread. */
  reason: string;
}

const LIMIT_TEXT = /\b(?:usage limit|hit (?:your|the) (?:usage |rate )?limit|rate[- ]limit(?:ed)?|quota (?:exceeded|exhausted|reached)|exceeded (?:your |the )?(?:current )?quota|limit reached|too many requests|out of (?:credits|quota)|credits? (?:exhausted|exceeded)|insufficient (?:quota|credits|balance)|weekly limit|5-hour limit)\b/i;
/** Words that mean it's *not* a quota: a context window, a file-size or a request-size limit. */
const NOT_QUOTA = /\b(?:context (?:window|length)|token limit for (?:this|the) (?:request|prompt)|max(?:imum)? (?:tokens|context)|too large|file size|payload)\b/i;

/** The default when the agent doesn't say when: an hour, the shortest common window. */
export const UNKNOWN_RESET_MS = 60 * 60_000;

/**
 * "try again at 3:04 PM", "resets at 19:00", "resets in 2 hours",
 * "in 45 minutes", "resets Oct 16, 9:00 AM" → epoch ms (the next such moment).
 */
export function parseReset(text: string, now = Date.now()): number | null {
  const t = text.replace(/\s+/g, " ");
  let m = /\b(?:in|after)\s+(\d+(?:\.\d+)?)\s*(minutes?|mins?|m|hours?|hrs?|h|days?|d)\b/i.exec(t);
  if (m) {
    const n = Number(m[1]), unit = m[2]!.toLowerCase();
    const ms = unit.startsWith("d") ? 86_400_000 : unit.startsWith("h") ? 3_600_000 : 60_000;
    return now + Math.round(n * ms);
  }
  m = /\b(?:at|after|until|resets?(?: at)?|try again at)\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/i.exec(t);
  if (m && (m[2] !== undefined || m[3] !== undefined)) {
    let h = Number(m[1]);
    const min = Number(m[2] ?? 0), ap = m[3]?.toLowerCase();
    if (ap === "pm" && h < 12) h += 12;
    if (ap === "am" && h === 12) h = 0;
    if (h > 23 || min > 59) return null;
    const d = new Date(now);
    d.setHours(h, min, 0, 0);
    if (d.getTime() <= now) d.setDate(d.getDate() + 1);
    return d.getTime();
  }
  return null;
}

/** Did this event say the agent is out of quota? */
export function quotaHit(event: LoomEvent, now = Date.now()): QuotaHit | null {
  const p = event.payload as Record<string, unknown>;
  if (event.kind === "status" && p.state === "usage_limits" && typeof p.reached === "string" && p.reached) {
    const windows = Array.isArray(p.windows) ? (p.windows as Array<{ id?: string; resetsAt?: number }>) : [];
    const hit = windows.find((w) => w.id === p.reached) ?? windows.find((w) => typeof w.resetsAt === "number");
    const resetAt = typeof hit?.resetsAt === "number" && hit.resetsAt > now ? hit.resetsAt : null;
    return { resetAt: resetAt ?? now + UNKNOWN_RESET_MS, known: resetAt !== null, window: p.reached,
      reason: `usage limit reached (${p.reached})` };
  }
  const text = event.kind === "error" ? String(p.message ?? "")
    : event.kind === "run_complete" && typeof p.error === "string" ? p.error
      : event.kind === "status" && (p.state === "notice" || p.state === "warning") ? String(p.message ?? "") : "";
  // a CLI retrying a brief rate limit by itself hasn't stopped: no relay for that
  if (p.retrying === true) return null;
  if (!text || !LIMIT_TEXT.test(text) || NOT_QUOTA.test(text)) return null;
  const resetAt = parseReset(text, now);
  return { resetAt: resetAt ?? now + UNKNOWN_RESET_MS, known: resetAt !== null, window: "limit", reason: text.trim().slice(0, 240) };
}

/** "19:00" / "tomorrow 09:00" — when it's back, for a person reading the thread. */
export function backAt(resetAt: number, now = Date.now()): string {
  const d = new Date(resetAt), today = new Date(now);
  const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return d.toDateString() === today.toDateString() ? time : `${d.toLocaleDateString([], { weekday: "short" })} ${time}`;
}
