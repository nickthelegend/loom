/**
 * Retrieval — finding the memories a turn is actually about.
 *
 * Two channels, unioned:
 *
 *   entities — exact matches on the literal strings a codebase is made of:
 *              src/core/git.ts, AgentBase, EADDRINUSE, #42. High precision,
 *              zero cost, and available because our domain's entities are
 *              strings that appear verbatim rather than noun phrases someone
 *              has to infer.
 *   BM25     — ordinary lexical scoring over the lemmatised text, for the
 *              memories nobody thought to tag.
 *
 * The union is the whole point, and it's where this consciously parts company
 * with the reference. mem0 builds its candidate set from the dense results only
 * (`main.py:1622`) and then lets BM25 and entity boosts re-rank *within* it —
 * so a memory BM25 matches perfectly but vector search missed is unreachable at
 * any score. That isn't hybrid retrieval, it's dense recall wearing a hybrid
 * costume. With no dense channel at all, our recall IS entities ∪ BM25; if
 * either finds something, it's a candidate.
 *
 * Two more things worth taking from mem0, and two worth refusing:
 *
 *   take:   memory_count_weight (`main.py:1758`) — an inverse-quadratic IDF
 *           surrogate. An entity linked to one memory weighs 1.0; to a hundred,
 *           0.09. Common entities suppress themselves. Ten lines, no corpus
 *           statistics, no tuning.
 *   take:   over-fetch before the cut, so scoring has room to reorder.
 *   refuse: its query-dependent divisor (`scoring.py:97`), which makes a score
 *           mean different things in different queries — a memory scoring 0.9 on
 *           semantics alone drops to 0.45 the moment some *other* memory in the
 *           same query happens to match a keyword. Ours is fixed.
 *   refuse: filtering expiry after the top-k cut (`main.py:1626`), where dead
 *           rows silently eat the recall budget. Ours are gone before we rank.
 */

import type { Brain, Memory, MemoryKind } from "./brain.js";
import { isExpired, lemmatize } from "./brain.js";

/** BM25 constants. The literature's defaults; we have no corpus to tune on. */
const K1 = 1.2;
const B = 0.75;

/** How much a matched entity can contribute, before IDF weighting. */
const ENTITY_WEIGHT = 0.5;
/** Fixed, so scores mean the same thing across queries. */
const MAX_SCORE = 1 + ENTITY_WEIGHT;

/**
 * Constraints and failures outrank facts at equal score. Getting burned by the
 * same footgun twice is worse than not knowing a detail, so when the ranking is
 * a coin flip, break it toward the memory that prevents damage.
 */
const KIND_BIAS: Record<MemoryKind, number> = {
  constraint: 0.06,
  failure: 0.06,
  decision: 0.03,
  convention: 0.02,
  fact: 0,
  task: 0,
};

export interface RetrieveOpts {
  /** Free text — a task description, a prompt, a turn. */
  query?: string;
  /** Files in play. From turn_diff, the file tree, or whatever the task names. */
  files?: string[];
  /** Only memories scoped to this agent (or to nobody). */
  agent?: string;
  /** Only memories scoped to this chat (or to nobody). */
  chat?: string;
  limit?: number;
  /** Drop anything the extractor wasn't sure about. */
  minConfidence?: number;
  /** Show the arithmetic. For tests and for the Brain tab. */
  explain?: boolean;
}

export interface ScoreDetail {
  bm25: number;
  entity: number;
  kindBias: number;
  matchedEntities: string[];
  final: number;
}

export interface Hit {
  memory: Memory;
  score: number;
  detail?: ScoreDetail;
}

function tokens(text: string): string[] {
  return lemmatize(text).split(" ").filter(Boolean);
}

/** Entities are matched case-insensitively; everything else is exact. */
function entKey(s: string): string {
  return s.trim().toLowerCase();
}

/**
 * The keys one entity is findable under.
 *
 * A path gets its basename too, because people say "the backtick thing in
 * app-page.ts" and mean src/daemon/app-page.ts. Without this the precision
 * channel only fires when someone types the whole path, which is exactly when
 * they least need help finding it.
 *
 * The basename is a separate key with its own posting list, so its IDF weight
 * is computed on its own merits: if four files are named index.ts, "index.ts"
 * suppresses itself and the full paths stay sharp.
 */
function entAliases(e: string): string[] {
  const k = entKey(e);
  if (!k) return [];
  if (!k.includes("/")) return [k];
  const base = k.split("/").pop();
  return base && base !== k ? [k, base] : [k];
}

/**
 * An inverted index over a set of memories.
 *
 * Rebuilt from the fold rather than maintained incrementally. At project scale —
 * hundreds to low thousands of memories — building it is well under a
 * millisecond, and an index that can't drift from its source is worth more than
 * one that's marginally faster to update. If that stops being true the shape
 * here doesn't change; only when we rebuild does.
 */
export class MemoryIndex {
  /** term → memory id → term frequency */
  private postings = new Map<string, Map<string, number>>();
  /** entity (lowercased) → memory ids */
  private entities = new Map<string, Set<string>>();
  private lengths = new Map<string, number>();
  private avgLen = 0;
  private docs: Memory[] = [];

  constructor(memories: Memory[]) {
    let total = 0;
    for (const m of memories) {
      this.docs.push(m);
      const toks = m.lemmas ? m.lemmas.split(" ").filter(Boolean) : tokens(m.text);
      this.lengths.set(m.id, toks.length);
      total += toks.length;
      for (const t of toks) {
        let p = this.postings.get(t);
        if (!p) this.postings.set(t, (p = new Map()));
        p.set(m.id, (p.get(m.id) ?? 0) + 1);
      }
      for (const e of m.entities) {
        for (const k of entAliases(e)) {
          let s = this.entities.get(k);
          if (!s) this.entities.set(k, (s = new Set()));
          s.add(m.id);
        }
      }
    }
    this.avgLen = memories.length ? total / memories.length : 0;
    this.byId = new Map(memories.map((m) => [m.id, m]));
  }

  private byId: Map<string, Memory>;

  get size(): number {
    return this.docs.length;
  }

  /** Standard BM25. Returns id → score for every doc matching any term. */
  bm25(query: string): Map<string, number> {
    const scores = new Map<string, number>();
    const N = this.docs.length;
    if (!N) return scores;
    for (const term of new Set(tokens(query))) {
      const posting = this.postings.get(term);
      if (!posting) continue;
      const df = posting.size;
      // +0.5/+1 smoothing keeps idf positive for a term in every document,
      // which would otherwise go negative and *penalise* a match.
      const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
      for (const [id, tf] of posting) {
        const len = this.lengths.get(id) ?? 0;
        const norm = this.avgLen > 0 ? 1 - B + B * (len / this.avgLen) : 1;
        const score = idf * ((tf * (K1 + 1)) / (tf + K1 * norm));
        scores.set(id, (scores.get(id) ?? 0) + score);
      }
    }
    return scores;
  }

  /**
   * Entity postings, IDF-weighted the way mem0 does it (`main.py:1758`): an
   * entity linked to n memories contributes 1/(1+0.001·(n-1)²). One memory →
   * full weight; a hundred → nearly nothing. So `src/types.ts`, which half the
   * memories will mention, stops drowning out the one that matters, without
   * anyone maintaining a stoplist.
   *
   * Per-memory contributions take the max rather than the sum — matching two
   * entities shouldn't outrank matching one that's far more specific.
   */
  entityHits(terms: string[]): Map<string, { score: number; matched: string[] }> {
    const out = new Map<string, { score: number; matched: string[] }>();
    for (const term of new Set(terms.map(entKey).filter(Boolean))) {
      const ids = this.entities.get(term);
      if (!ids) continue;
      const n = ids.size;
      const weight = 1 / (1 + 0.001 * (n - 1) ** 2);
      const score = ENTITY_WEIGHT * weight;
      for (const id of ids) {
        const cur = out.get(id);
        if (!cur) out.set(id, { score, matched: [term] });
        else {
          cur.matched.push(term);
          cur.score = Math.max(cur.score, score);
        }
      }
    }
    return out;
  }

  memory(id: string): Memory | undefined {
    return this.byId.get(id);
  }
}

/**
 * Pull the entity-ish strings out of a query.
 *
 * Looser than brain.ts's extractEntities, and deliberately so: that one guards
 * what gets *stored*, where a wrong entity poisons the index forever. This one
 * only guards what gets *looked up*, where a wrong guess costs one failed Map
 * lookup. Asymmetric stakes, asymmetric strictness.
 */
export function queryEntities(query: string, files: string[] = []): string[] {
  const out = new Set<string>(files.map((f) => f.trim()).filter(Boolean));
  for (const m of query.matchAll(/\b[\w@.-]+(?:\/[\w@.-]+)+\b/g)) out.add(m[0]);
  for (const m of query.matchAll(/\b[\w-]+\.(?:ts|tsx|js|jsx|json|md|py|rs|go|sh|yml|yaml|toml)\b/g)) out.add(m[0]);
  for (const m of query.matchAll(/\b[A-Za-z][a-z0-9]+(?:[A-Z][a-z0-9]+)+\b/g)) out.add(m[0]);
  for (const m of query.matchAll(/\b[A-Z][A-Z0-9]{2,}(?:_[A-Z0-9]+)*\b/g)) out.add(m[0]);
  for (const m of query.matchAll(/#\d+\b/g)) out.add(m[0]);
  for (const m of query.matchAll(/`([^`\n]{2,60})`/g)) if (m[1]) out.add(m[1]);
  // A file's basename is worth trying too: "git.ts" should find memories about
  // src/core/git.ts even when the query never spells the path out.
  for (const f of files) {
    const base = f.split("/").pop();
    if (base && base !== f) out.add(base);
  }
  return [...out];
}

/**
 * Find the memories relevant to a piece of work.
 *
 * Pure over the memories handed in — the Brain owns the fold, this owns the
 * ranking, and neither needs the other to be a class.
 */
export function retrieveFrom(memories: Memory[], opts: RetrieveOpts): Hit[] {
  const now = Date.now();
  const limit = opts.limit ?? 12;

  // Filter FIRST — scope, confidence, expiry — so dead and out-of-scope rows
  // never consume the ranking budget. mem0 does this after its over-fetch and
  // silently loses recall to rows that were never eligible.
  const live = memories.filter((m) => {
    if (isExpired(m, now)) return false;
    if (opts.minConfidence !== undefined && m.confidence < opts.minConfidence) return false;
    if (opts.agent && m.scope.agent && m.scope.agent !== opts.agent) return false;
    if (opts.chat && m.scope.chat && m.scope.chat !== opts.chat) return false;
    return true;
  });
  if (!live.length) return [];

  const index = new MemoryIndex(live);
  const query = opts.query ?? "";
  const ents = queryEntities(query, opts.files ?? []);

  const bm = query.trim() ? index.bm25(query) : new Map<string, number>();
  const eh = ents.length ? index.entityHits(ents) : new Map<string, { score: number; matched: string[] }>();

  // The union. Either channel alone is enough to be a candidate.
  const ids = new Set<string>([...bm.keys(), ...eh.keys()]);
  if (!ids.size) return [];

  // BM25 is unbounded, so normalise against the best hit in this query to get
  // it onto the same 0..1 footing as the entity channel. Relative-to-best is
  // honest here in a way mem0's adaptive divisor isn't: it rescales the axis,
  // it doesn't change what the total can mean.
  let maxBm = 0;
  for (const s of bm.values()) if (s > maxBm) maxBm = s;

  const hits: Hit[] = [];
  for (const id of ids) {
    const memory = index.memory(id);
    if (!memory) continue;
    const bmNorm = maxBm > 0 ? (bm.get(id) ?? 0) / maxBm : 0;
    const ent = eh.get(id);
    const bias = KIND_BIAS[memory.kind] ?? 0;
    const raw = bmNorm + (ent?.score ?? 0);
    const final = Math.min(1, raw / MAX_SCORE + bias);
    hits.push({
      memory,
      score: final,
      ...(opts.explain
        ? {
            detail: {
              bm25: round(bmNorm),
              entity: round(ent?.score ?? 0),
              kindBias: bias,
              matchedEntities: ent?.matched ?? [],
              final: round(final),
            },
          }
        : {}),
    });
  }

  hits.sort((a, b) => b.score - a.score || b.memory.updatedAt - a.memory.updatedAt);
  return hits.slice(0, limit);
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/** The same, against a live Brain. */
export function retrieve(brain: Brain, opts: RetrieveOpts): Hit[] {
  return retrieveFrom(brain.all(), opts);
}
