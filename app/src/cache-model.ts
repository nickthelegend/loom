/**
 * What the phone keeps for when the daemon can't be reached: the project list
 * and the last few threads you read, so opening Loom on a train shows where
 * things stood instead of a spinner. Pure — which threads to keep, how much of
 * each, and how old a copy is — so it's testable in plain node; cache.ts does
 * the reading and writing.
 */

/** Threads kept on the device, most recently opened first. */
export const THREADS_KEPT = 8;
/** Events kept per thread: the tail you'd scroll back through on a phone. */
export const EVENTS_KEPT = 80;

export interface Cached<T> {
  at: number;
  data: T;
}

export const threadKey = (projectId: string, chatId: string): string =>
  `thread-${projectId}-${chatId}`.replace(/[^\w-]+/g, "_");

/**
 * A short, stable name for the daemon a copy came from, so pairing with a
 * different machine never shows the last one's projects.
 */
export function scopeOf(daemonUrl: string): string {
  let h = 2166136261;
  for (let i = 0; i < daemonUrl.length; i++) h = Math.imul(h ^ daemonUrl.charCodeAt(i), 16777619);
  return (h >>> 0).toString(36);
}

/** Put `key` first in the recently-opened list; returns the list and the keys to delete. */
export function touch(index: string[], key: string, max = THREADS_KEPT): { index: string[]; evict: string[] } {
  const next = [key, ...index.filter((k) => k !== key)];
  return { index: next.slice(0, max), evict: next.slice(max) };
}

/** The tail of a thread worth keeping. Live-only frames never reach here. */
export function trimEvents<E>(events: E[], max = EVENTS_KEPT): E[] {
  return events.length > max ? events.slice(events.length - max) : events;
}

/** "saved 3 min ago" — how old the copy on screen is. */
export function savedAgo(at: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 60) return "saved just now";
  const m = Math.round(s / 60);
  if (m < 60) return `saved ${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `saved ${h} h ago`;
  const d = Math.round(h / 24);
  return `saved ${d} day${d === 1 ? "" : "s"} ago`;
}

export function parseCached<T>(raw: string | null): Cached<T> | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Cached<T>;
    return v && typeof v.at === "number" && "data" in v ? v : null;
  } catch {
    return null;
  }
}
