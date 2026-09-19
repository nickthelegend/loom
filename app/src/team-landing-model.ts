/**
 * Landing's view model (Loom Teams Phase 4), kept free of React Native so it
 * can be tested with plain node (`npm test` in app/): what a goal PR's state
 * looks like, which buttons its card offers, and what counts toward the badge.
 *
 * Only type imports from ./api, so running this file under node strips them
 * and never loads the app's network layer. Colours are named as tones here;
 * the view maps a tone onto the theme.
 */

import type { AdoptablePr, LandingGoal, LandingState, LandingStateName, TeamCosts } from "./api";

export type Tone = "ok" | "warn" | "err" | "live" | "merged" | "dim";

export interface StateChip {
  label: string;
  tone: Tone;
  /** Needs a person: the card is edged and it counts toward the badge. */
  attention: boolean;
}

export const STATE_CHIP: Record<LandingStateName, StateChip> = {
  open: { label: "open", tone: "dim", attention: false },
  pending: { label: "checks running", tone: "live", attention: false },
  green: { label: "green", tone: "ok", attention: false },
  failing: { label: "failing", tone: "err", attention: false },
  fixing: { label: "fixing", tone: "warn", attention: false },
  needs_human: { label: "needs you", tone: "err", attention: true },
  // Phase 6: Land was clicked; another goal holds a lane it needs (the landing train)
  queued: { label: "queued", tone: "dim", attention: false },
  landing: { label: "landing", tone: "live", attention: false },
  merged: { label: "merged", tone: "merged", attention: false },
  closed: { label: "closed", tone: "dim", attention: false },
};

/** A state a newer daemon invents still gets a quiet chip rather than a crash. */
export function stateChip(state: string): StateChip {
  return (STATE_CHIP as Record<string, StateChip | undefined>)[state] ?? { label: state || "unknown", tone: "dim", attention: false };
}

const DONE = new Set(["merged", "closed"]);
// "moved" (Phase 5): the daemon hands Land on a moved goal to the runner holding it.
const RUN_TERMINAL = new Set(["completed", "failed", "aborted", "moved"]);

/** Mirrors the daemon's own guard on Land: an adopted goal belongs to its owner, a live one isn't done. */
export function isRunDone(status: string): boolean {
  return RUN_TERMINAL.has(status);
}

export type LandingButton = "land" | "override" | "review";

/** Which buttons a goal's card shows, in order. */
export function landingButtons(g: Pick<LandingGoal, "status" | "adopted" | "landing">): LandingButton[] {
  const l = g.landing;
  if (DONE.has(l.state)) return [];
  const out: LandingButton[] = [];
  const landingNow = l.state === "landing" || (l.landRequested && l.state !== "needs_human");
  if (!g.adopted && isRunDone(g.status) && !landingNow) out.push("land");
  if (l.review?.state === "failure" && !l.review.overridden) out.push("override");
  if (l.headSha && l.state !== "landing") out.push("review");
  return out;
}

/** Why Land isn't offered, when that's not obvious from the chip. */
export function landBlockedNote(g: Pick<LandingGoal, "status" | "adopted" | "landing">): string | null {
  const l = g.landing;
  if (DONE.has(l.state)) return null;
  if (l.state === "queued") return l.reason ? `Queued to land — ${l.reason}.` : "Queued to land behind another goal.";
  if (l.state === "landing" || (l.landRequested && l.state !== "needs_human")) return "Land requested — Loom merges it once GitHub's rules pass.";
  if (g.adopted) return `Adopted from ${g.adopted.owner ? `@${g.adopted.owner}` : "a teammate"} — they land it.`;
  if (!isRunDone(g.status)) return `The goal is still ${g.status.replace(/_/g, " ")} — land it once it's done.`;
  return null;
}

/** "review passed · @bot", "review failed · 2 high of 5", "overridden: flaky rule". */
export function reviewLine(r: LandingState["review"]): string | null {
  if (!r) return null;
  const who = r.reviewer ? ` · ${r.reviewer}` : "";
  if (r.overridden) return `review overridden: ${r.overridden}`;
  if (r.state === "skipped") return `review skipped${who}`;
  if (r.state === "success") return `review passed${r.findings ? ` · ${r.findings} finding${r.findings === 1 ? "" : "s"}` : ""}${who}`;
  return `review failed · ${r.high} high of ${r.findings}${who}`;
}

/** Goals waiting on a person first, then the rest by most recently changed; done ones last. */
export function sortGoals(goals: readonly LandingGoal[]): LandingGoal[] {
  const rank = (g: LandingGoal) => (stateChip(g.landing.state).attention ? 0 : DONE.has(g.landing.state) ? 2 : 1);
  return [...goals].sort((a, b) => rank(a) - rank(b) || (b.landing.updatedAt ?? 0) - (a.landing.updatedAt ?? 0));
}

/** The badge: goal PRs that need you, plus teammates' goals that need someone. */
export function landingBadge(t: { goals?: readonly LandingGoal[]; adoptable?: readonly AdoptablePr[] } | null | undefined): number {
  if (!t) return 0;
  const needs = (t.goals ?? []).filter((g) => g.landing?.state === "needs_human").length;
  return needs + (t.adoptable?.length ?? 0);
}

export function adoptConfirm(p: AdoptablePr): string {
  const who = p.owner ? `${p.owner}'s` : "a teammate's";
  return `Your agents will work on ${who} branch (${p.branch}) to get PR #${p.pr} green, then hand it back.`;
}

export interface CostSummary {
  today: Array<{ member: string; usd: number; goals: number }>;
  todayUsd: number;
  totalUsd: number;
  landed: number;
  perLandedPrUsd: number | null;
  ciMinutes: number;
}

/** Today's spend per member (the daemon buckets by UTC day), plus the running totals. */
export function costSummary(c: TeamCosts | null | undefined, now = Date.now()): CostSummary | null {
  if (!c) return null;
  const day = new Date(now).toISOString().slice(0, 10);
  const today = (c.byMemberDay ?? [])
    .filter((r) => r.day === day)
    .map(({ member, usd, goals }) => ({ member, usd, goals }))
    .sort((a, b) => b.usd - a.usd || a.member.localeCompare(b.member));
  return {
    today,
    todayUsd: Math.round(today.reduce((a, r) => a + r.usd, 0) * 100) / 100,
    totalUsd: c.totalUsd ?? 0,
    landed: c.landed ?? 0,
    perLandedPrUsd: c.perLandedPrUsd ?? null,
    ciMinutes: c.ciMinutes ?? 0,
  };
}

/** Dollars that read the same at $0 as at $12.40 (theme's usd() blanks zero). */
export function dollars(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return n > 0 && n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`;
}
