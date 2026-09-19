/**
 * Loom Teams, Phase 3 — one brain: how a briefing ranks what the team knows.
 *
 *   D42  canon > confirmed by 2+ members > your own > a teammate's proposal,
 *        and every briefed line says which (so the model knows how sure to be)
 *   D16  failures and facts fade out of briefings after ~90 days unless they're
 *        re-confirmed; decisions, conventions and constraints persist until
 *        superseded
 *   D43  untrusted memories (learned from outside content) are yours alone and
 *        say so
 *
 * Built on the solo brain's retrieval (BM25 + entities + trigram), re-weighted
 * by tier. Pure — the daemon hands it the pools.
 */

import type { Memory } from "./brain.js";
import { retrieveFrom, type RetrieveOpts } from "./brain-index.js";

export type Tier = "canon" | "confirmed" | "own" | "proposed";

export interface TieredMemory extends Memory {
  tier: Tier;
  /** GitHub login of whoever's agent learned it (teammates' memories). */
  author?: string;
  /** Members whose agents learned exactly this (D41). */
  confirmedBy?: string[];
}

export const TIER_WEIGHT: Record<Tier, number> = { canon: 1.6, confirmed: 1.25, own: 1, proposed: 0.8 };
export const AGE_OUT_MS = 90 * 24 * 60 * 60_000;

/** D16: a failure or fact nobody has re-confirmed in ~90 days is out of briefings (canon never ages). */
export function agedOut(m: TieredMemory, now = Date.now()): boolean {
  if (m.tier === "canon") return false;
  if (m.kind !== "failure" && m.kind !== "fact") return false;
  return now - m.updatedAt > AGE_OUT_MS;
}

export interface TieredHit {
  memory: TieredMemory;
  score: number;
}

/**
 * Rank every pool together, then weight by tier. Canon that's relevant at all
 * always makes the cut — a briefing that drops the team's settled rules for a
 * better keyword match has its priorities backwards.
 */
export function retrieveTiered(pool: TieredMemory[], opts: RetrieveOpts & { now?: number }): TieredHit[] {
  const now = opts.now ?? Date.now();
  const live = pool.filter((m) => !agedOut(m, now));
  const byId = new Map(live.map((m) => [m.id, m]));
  const limit = opts.limit ?? 12;
  const raw = retrieveFrom(live, { ...opts, limit: Math.max(limit * 3, 30) });
  const hits = raw
    .map((h) => {
      const m = byId.get(h.memory.id)!;
      return { memory: m, score: h.score * TIER_WEIGHT[m.tier] };
    })
    .sort((a, b) => b.score - a.score || b.memory.updatedAt - a.memory.updatedAt);
  const canon = hits.filter((h) => h.memory.tier === "canon");
  const rest = hits.filter((h) => h.memory.tier !== "canon");
  return [...canon, ...rest].slice(0, limit);
}

function label(m: TieredMemory): string {
  if (m.tier === "canon") return "team canon";
  if (m.tier === "confirmed") return `confirmed by ${m.confirmedBy?.length ?? 2} teammates`;
  if (m.tier === "proposed") return `proposed by ${m.author ?? "a teammate"} — not yet confirmed`;
  return m.untrusted ? "yours · learned from external content, unverified" : "";
}

const KIND_TITLE: Record<string, string> = {
  constraint: "Constraints reality imposes",
  failure: "Known failures — do not repeat these",
  decision: "Decisions made, and why",
  convention: "How this project does things",
  fact: "Facts",
  task: "Current work",
};

/** The briefing block: grouped by kind, each line labelled with its tier. */
export function compileTieredBrief(hits: TieredHit[]): string {
  if (!hits.length) return "";
  const lines = [
    "## What your team has learned (relevant to the work at hand)",
    "Team canon is settled — follow it. Confirmed memories are reliable; a single teammate's proposal is useful but unverified.",
  ];
  for (const kind of ["constraint", "failure", "decision", "convention", "fact", "task"]) {
    const items = hits.filter((h) => h.memory.kind === kind);
    if (!items.length) continue;
    lines.push("", `### ${KIND_TITLE[kind]}`);
    for (const h of items) {
      const l = label(h.memory);
      lines.push(`- ${h.memory.text}${l ? `  _(${l})_` : ""}`);
    }
  }
  return lines.join("\n");
}
