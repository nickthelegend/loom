/**
 * The team brain's view model, kept free of React Native so it can be tested
 * with plain node (`npm test` in app/): which section a memory sits in, and
 * what a person can do about each inbox item.
 *
 * Only type imports from ./api, so running this file under node strips them
 * and never loads the app's network layer.
 */

import type { BrainAction, BrainInboxItem, BrainMemory, BrainTier } from "./api";

export const TIER_ORDER: readonly BrainTier[] = ["canon", "confirmed", "own", "proposed"];

export const TIER_LABEL: Record<BrainTier, string> = {
  canon: "Canon",
  confirmed: "Confirmed",
  own: "Yours",
  proposed: "Proposed",
};

/** What the tier means, one line, for the section header. */
export const TIER_HINT: Record<BrainTier, string> = {
  canon: "reviewed and merged into the repo",
  confirmed: "two or more teammates learned it",
  own: "your agents learned it and shared it",
  proposed: "a teammate's, not confirmed by anyone else yet",
};

export interface MemorySection {
  tier: BrainTier;
  label: string;
  items: BrainMemory[];
}

/**
 * Live memories grouped Canon / Confirmed / Yours / Proposed, in that order,
 * empty sections dropped. Within a section, the most confirmed first, then by
 * text so a refresh doesn't shuffle the list under a thumb.
 */
export function groupMemories(memories: readonly BrainMemory[]): MemorySection[] {
  const live = memories.filter((m) => (m.state ?? "live") === "live");
  const seen = new Set<string>();
  const by = new Map<BrainTier, BrainMemory[]>();
  for (const m of live) {
    if (seen.has(m.id)) continue;
    seen.add(m.id);
    const tier = TIER_ORDER.includes(m.tier) ? m.tier : "proposed";
    by.set(tier, [...(by.get(tier) ?? []), m]);
  }
  return TIER_ORDER.filter((t) => by.get(t)?.length).map((tier) => ({
    tier,
    label: TIER_LABEL[tier],
    items: [...by.get(tier)!].sort(
      (a, b) => b.confirmedBy.length - a.confirmedBy.length || a.text.localeCompare(b.text),
    ),
  }));
}

/** Memories that were resolved against or withdrawn (only with history=1). */
export function historyOf(memories: readonly BrainMemory[]): BrainMemory[] {
  return memories.filter((m) => m.state && m.state !== "live");
}

/** "by @alice · confirmed by 3", "reviewed canon", "yours". */
export function attribution(m: BrainMemory): string {
  if (m.tier === "canon") return "canon · merged by PR";
  const parts: string[] = [];
  if (m.mine) parts.push("yours");
  else if (m.author) parts.push(`by @${m.author}`);
  const others = m.confirmedBy.filter((g) => g !== m.author);
  if (m.tier === "confirmed" || others.length) parts.push(`confirmed by ${m.confirmedBy.length}`);
  return parts.join(" · ");
}

export interface InboxAction {
  label: string;
  action: BrainAction;
  body: Record<string, unknown>;
  /** The one action the card leads with. */
  primary?: boolean;
  /** Asks first: it changes what the whole team reads. */
  confirm?: string;
}

const RANK: Record<BrainTier, number> = { canon: 0, confirmed: 1, own: 2, proposed: 3 };

/** The copy of a duplicate pair to keep: the more settled tier, then the more confirmed, then A. */
export function mergeKeeper(a: BrainMemory, b: BrainMemory): { keep: BrainMemory; drop: BrainMemory } {
  const d = RANK[a.tier] - RANK[b.tier] || b.confirmedBy.length - a.confirmedBy.length;
  return d <= 0 ? { keep: a, drop: b } : { keep: b, drop: a };
}

/** What a person can do about one inbox item, as daemon calls. */
export function inboxActions(item: BrainInboxItem): InboxAction[] {
  const { a, b } = item;
  switch (item.type) {
    case "correction":
    case "contradiction": {
      if (!b) return [];
      const reason = item.type;
      return [
        { label: "Keep A", action: "resolve", body: { winner: a.id, loser: b.id, reason } },
        { label: "Keep B", action: "resolve", body: { winner: b.id, loser: a.id, reason } },
      ];
    }
    case "duplicate": {
      if (!b) return [];
      const { keep, drop } = mergeKeeper(a, b);
      return [
        {
          label: keep.id === a.id ? "Merge · keep A" : "Merge · keep B",
          action: "merge",
          body: { keep: keep.id, drop: drop.id },
          primary: true,
        },
      ];
    }
    case "untrusted":
      return [
        {
          label: "Trust & share",
          action: "trust",
          body: { id: a.id },
          primary: true,
          confirm: "It was learned while reading outside content. Trusting it shares it with your team.",
        },
        { label: "Keep private", action: "private", body: { id: a.id } },
      ];
    case "promote":
      return [
        {
          label: "Propose as canon",
          action: "promote",
          body: { ids: [a.id] },
          primary: true,
          confirm: "Loom opens a pull request that adds it to the repo's canon. It becomes canon once that PR merges.",
        },
      ];
    default:
      return [];
  }
}

/** Short tag for the card's header. */
export const INBOX_LABEL: Record<BrainInboxItem["type"], string> = {
  correction: "correction",
  contradiction: "contradiction",
  duplicate: "duplicate",
  untrusted: "untrusted",
  promote: "ready for canon",
};

/** Only web links leave the app: a PR URL still comes from a git host's output. */
export function openableUrl(url: unknown): string | null {
  return typeof url === "string" && /^https?:\/\//i.test(url) ? url : null;
}
