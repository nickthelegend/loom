/**
 * How good the link to the daemon has been lately: a rolling window of health
 * pings (a round-trip time, or null for one that never came back) boiled down
 * to what a person reads at a glance. Pure, so it's testable in plain node;
 * the home screen keeps the window and draws it.
 */

export type LinkSample = number | null;

export type LinkGrade = "good" | "fair" | "poor" | "down" | "unknown";

export interface LinkQuality {
  grade: LinkGrade;
  /** Median round trip of the pings that came back, in ms. */
  medianMs: number | null;
  /** Typical wobble between consecutive answered pings, in ms. */
  jitterMs: number | null;
  /** Share of pings that never came back, 0–100. */
  lossPct: number;
  samples: number;
}

/** How many pings the window keeps: two minutes at the home screen's 5 s poll. */
export const LINK_WINDOW = 24;

export function pushSample(window: LinkSample[], s: LinkSample, max = LINK_WINDOW): LinkSample[] {
  const next = window.concat([s]);
  return next.length > max ? next.slice(next.length - max) : next;
}

export function linkQuality(window: LinkSample[]): LinkQuality {
  const ok = window.filter((s): s is number => typeof s === "number" && Number.isFinite(s));
  const lossPct = window.length ? Math.round(((window.length - ok.length) / window.length) * 100) : 0;
  if (!window.length) return { grade: "unknown", medianMs: null, jitterMs: null, lossPct: 0, samples: 0 };
  // the last three all failed: whatever the history says, it's down now
  if (window.slice(-3).every((s) => s === null) && window.length >= 3) {
    return { grade: "down", medianMs: median(ok), jitterMs: jitter(window), lossPct, samples: window.length };
  }
  const med = median(ok);
  const jit = jitter(window);
  let grade: LinkGrade;
  if (med === null) grade = "down";
  else if (lossPct >= 20 || med > 800 || (jit ?? 0) > 400) grade = "poor";
  else if (lossPct >= 5 || med > 250 || (jit ?? 0) > 120) grade = "fair";
  else grade = "good";
  return { grade, medianMs: med, jitterMs: jit, lossPct, samples: window.length };
}

function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = xs.slice().sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return Math.round(s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2);
}

/** Mean absolute difference between consecutive answered pings. */
function jitter(window: LinkSample[]): number | null {
  let prev: number | null = null;
  let sum = 0;
  let n = 0;
  for (const s of window) {
    if (s === null) continue;
    if (prev !== null) {
      sum += Math.abs(s - prev);
      n++;
    }
    prev = s;
  }
  return n ? Math.round(sum / n) : null;
}

/** Bar heights 0–1 for a sparkline; a lost ping is -1 (drawn as a red tick). */
export function sparkBars(window: LinkSample[]): number[] {
  const ok = window.filter((s): s is number => s !== null);
  const top = Math.max(100, ...ok);
  return window.map((s) => (s === null ? -1 : Math.max(0.08, s / top)));
}

export function describeLink(q: LinkQuality): string {
  if (q.grade === "unknown") return "measuring…";
  if (q.grade === "down") return "not answering";
  const parts = [`${q.medianMs} ms`];
  if (q.jitterMs !== null) parts.push(`±${q.jitterMs}`);
  if (q.lossPct) parts.push(`${q.lossPct}% lost`);
  return `${q.grade} · ${parts.join(" ")}`;
}
