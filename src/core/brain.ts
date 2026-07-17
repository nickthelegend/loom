/**
 * The brain — memory as units instead of a sliding window.
 *
 * What was here before (and still is, next door in memory.ts) concatenates:
 * every ADE's CLAUDE.md, truncated at 8k, plus the last 40 decisions, plus the
 * last 30 messages, glued together and handed to whoever takes the baton. That
 * is a recency window, not a memory. Nothing is learned from a turn, nothing is
 * reconciled when two facts disagree, nothing is retrieved because it's
 * relevant, and nothing is ever forgotten — growth is bounded by truncation,
 * which throws away the durable architectural facts first and keeps the last
 * thirty lines of chatter.
 *
 * This module is the other thing: addressable units that can be added, updated,
 * forgotten, and looked up by what they're about.
 *
 * There is no new store. A memory IS three event kinds in the log that already
 * exists — memory_add / memory_update / memory_forget. Current state is a fold
 * over them; history is a filter over the same bytes; and the two cannot drift
 * apart, because they are the same bytes. mem0 needs a second SQLite database
 * to get the history that falls out of this for free. types.ts has said from
 * the beginning that the log is the source of truth and everything else is a
 * projection of it — this is that, taken literally.
 *
 * Phase 0 (this file) and phase 1 (retrieval, brain-index.ts) are deterministic
 * and LLM-free by design: prove the store and the recall before spending a
 * token on extraction. See docs/proposals/brain.md.
 */

import crypto from "node:crypto";
import type { EventLog } from "./eventlog.js";
import type { LoomEvent } from "../types.js";

/**
 * The taxonomy is where this has to diverge hardest from mem0, whose categories
 * are personal — preferences, relationships, health. These are engineering.
 *
 * `failure` is the one nobody builds and the one that pays for the rest.
 * Negative knowledge is the most expensive kind to re-derive and the least
 * likely to get written down: every hour lost to "we already tried that" is a
 * failure memory that didn't exist. This repo's own history is full of them.
 */
export type MemoryKind =
  | "constraint" // a rule reality imposes on you
  | "decision" // a choice, and why
  | "convention" // how this project does things
  | "fact" // how something is
  | "failure" // what didn't work, and why
  | "task"; // ephemeral, scoped to a run

export const MEMORY_KINDS: MemoryKind[] = [
  "constraint",
  "decision",
  "convention",
  "fact",
  "failure",
  "task",
];

/** Injected memories are load-bearing, so they have to clear a bar. */
export const CONFIDENCE_FLOOR = 0.6;

export interface MemoryProvenance {
  /** Who learned it. "user" when a human typed it. */
  agentId: string;
  /** The event it came from — one click back to the turn that produced it. */
  eventId: number;
  ts: number;
}

export interface Memory {
  id: string;
  kind: MemoryKind;
  /** One self-contained sentence. Must read true with no surrounding context. */
  text: string;
  /**
   * Literal strings this is about: file paths, symbols, agent ids, error codes.
   * mem0 has to run spaCy NER over prose and then fuzzy-match embeddings at 0.95
   * to decide two restaurant names are the same place. Ours are exact strings
   * that appear verbatim in the repo, so an index is a Map and a lookup is a
   * `get`. That is the whole reason lexical retrieval is enough here.
   */
  entities: string[];
  scope: { chat?: string; agent?: string; task?: string };
  provenance: MemoryProvenance;
  /** Below CONFIDENCE_FLOOR: visible in the Brain tab, never injected. */
  confidence: number;
  /**
   * The verbatim span this was extracted from. Phase 2 verifies it appears in
   * the source turn and drops the memory if it doesn't — the cheapest
   * hallucination guard there is, and it costs one `includes`.
   */
  evidence?: string;
  /** Lemmatised copy for BM25. Never shown to anyone. */
  lemmas: string;
  /** md5(text) — lets us skip an LLM call for something we already know. */
  hash: string;
  createdAt: number;
  updatedAt: number;
  /** `task` memories die with their run; constraints and failures never do. */
  expiresAt?: number;
}

/** What a caller hands us. The derived fields are ours to compute. */
export interface NewMemory {
  kind: MemoryKind;
  text: string;
  entities?: string[];
  scope?: { chat?: string; agent?: string; task?: string };
  provenance: MemoryProvenance;
  confidence?: number;
  evidence?: string;
  expiresAt?: number;
}

export interface MemoryPatch {
  text?: string;
  kind?: MemoryKind;
  entities?: string[];
  confidence?: number;
  evidence?: string;
  expiresAt?: number;
}

/** One line of a memory's life, straight out of the log. */
export interface MemoryHistoryEntry {
  op: "add" | "update" | "forget";
  eventId: number;
  ts: number;
  by: string;
  text?: string;
  reason?: string;
}

export interface ListOpts {
  kind?: MemoryKind;
  chat?: string;
  agent?: string;
  /** Include expired memories. Off by default — they're dead to retrieval. */
  includeExpired?: boolean;
  minConfidence?: number;
  limit?: number;
}

export function memoryHash(text: string): string {
  return crypto.createHash("md5").update(text.trim().toLowerCase()).digest("hex");
}

export function newMemoryId(): string {
  return crypto.randomBytes(8).toString("hex");
}

const STOPWORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "been", "but", "by", "can", "did", "do", "does",
  "for", "from", "had", "has", "have", "how", "i", "if", "in", "is", "it", "its", "of", "on",
  "or", "our", "out", "so", "than", "that", "the", "their", "them", "then", "there", "these",
  "they", "this", "to", "was", "we", "were", "what", "when", "which", "who", "will", "with",
  "you", "your",
]);

/**
 * Poor man's lemmatiser. mem0 runs spaCy for this; we are not shipping a 500MB
 * model to stem a hundred sentences, and for identifier-heavy text the crude
 * rules do nearly as well.
 *
 * Deliberately keeps the raw token alongside the stem when they differ, which
 * is the same trick mem0 plays for -ing forms (`lemmatization.py:47`): "running"
 * should match both a query for "run" and a query for "running", and we can't
 * tell which the user meant. Keeping both costs one token in the index.
 */
export function lemmatize(text: string): string {
  const out: string[] = [];
  for (const raw of text.toLowerCase().split(/[^a-z0-9_/.@#-]+/)) {
    const tok = raw.replace(/^[-.]+|[-.]+$/g, "");
    if (!tok || tok.length < 2 || STOPWORDS.has(tok)) continue;
    out.push(tok);
    const stem = stemOf(tok);
    if (stem !== tok) out.push(stem);
  }
  return out.join(" ");
}

function stemOf(tok: string): string {
  // Only touch plain words. Identifiers (paths, dotted names, snake_case) are
  // exact strings and stemming them turns `useState` into garbage.
  if (!/^[a-z]+$/.test(tok)) return tok;
  for (const [suffix, min] of [
    ["ingly", 6], ["edly", 6], ["ing", 5], ["ies", 4], ["ied", 4], ["es", 4], ["ed", 4], ["ly", 5], ["s", 3],
  ] as Array<[string, number]>) {
    if (tok.length >= min && tok.endsWith(suffix)) {
      const base = tok.slice(0, -suffix.length);
      if (suffix === "ies" || suffix === "ied") return base + "y";
      if (suffix === "ing" || suffix === "ed") return undouble(base);
      return base;
    }
  }
  return tok;
}

/**
 * Porter's step-1b tail: dropping -ing off "running" leaves "runn", which
 * matches nothing. Undouble the consonant — but not l, s or z, or "calling"
 * stems to "cal" and stops matching "call".
 */
function undouble(base: string): string {
  const n = base.length;
  if (n < 3) return base;
  const last = base[n - 1];
  if (last !== base[n - 2]) return base;
  if (last === "l" || last === "s" || last === "z") return base;
  return base.slice(0, -1);
}

/**
 * Entities we can find without a model, because in a codebase they're literal.
 *
 * Paths, dotted/slashed identifiers, CamelCase symbols, SCREAMING_CASE error
 * codes, #123 issue refs. Deliberately conservative: a wrong entity is worse
 * than a missing one, because entities are the high-precision retrieval channel
 * and polluting them poisons it.
 */
export function extractEntities(text: string): string[] {
  const found = new Set<string>();
  const add = (s: string) => {
    const t = s.trim().replace(/[.,;:)\]}"']+$/, "");
    if (t.length >= 2 && t.length <= 120) found.add(t);
  };

  // file paths and dotted module names: src/core/git.ts, package.json, a.b.c
  for (const m of text.matchAll(/\b[\w@.-]+(?:\/[\w@.-]+)+\b/g)) add(m[0]);
  for (const m of text.matchAll(/\b[\w-]+\.(?:ts|tsx|js|jsx|json|md|py|rs|go|sh|yml|yaml|toml|lock)\b/g)) add(m[0]);
  // CamelCase / PascalCase symbols: AgentBase, useState
  for (const m of text.matchAll(/\b[A-Za-z][a-z0-9]+(?:[A-Z][a-z0-9]+)+\b/g)) add(m[0]);
  // SCREAMING_SNAKE: EADDRINUSE, MAX_IMPORT_CHARS
  for (const m of text.matchAll(/\b[A-Z][A-Z0-9]{2,}(?:_[A-Z0-9]+)*\b/g)) add(m[0]);
  // issue / PR refs
  for (const m of text.matchAll(/#\d+\b/g)) add(m[0]);
  // backticked spans — someone marked it as code, believe them
  for (const m of text.matchAll(/`([^`\n]{2,60})`/g)) if (m[1]) add(m[1]);

  return [...found];
}

// ---------------------------------------------------------------------------
// The fold
// ---------------------------------------------------------------------------

const MEMORY_KINDS_SET = new Set<string>(MEMORY_KINDS);

function isMemoryKind(v: unknown): v is MemoryKind {
  return typeof v === "string" && MEMORY_KINDS_SET.has(v);
}

/**
 * Rebuild current state from the log.
 *
 * Order matters and is the log's, not ours: an update to a forgotten memory is
 * a no-op, and a memory added twice keeps the first id. Both fall out of
 * replaying in id order, which is why this reads the log rather than keeping a
 * parallel Map that could disagree with it.
 */
export function foldMemories(events: LoomEvent[]): Map<string, Memory> {
  const byId = new Map<string, Memory>();
  for (const e of events) {
    if (e.kind === "memory_add") {
      const m = e.payload.memory as Memory | undefined;
      if (m?.id && isMemoryKind(m.kind) && typeof m.text === "string") {
        // Last writer wins on a re-add of the same id — an idempotent replay
        // shouldn't fork.
        byId.set(m.id, { ...m });
      }
      continue;
    }
    if (e.kind === "memory_update") {
      const id = e.payload.id as string | undefined;
      const cur = id ? byId.get(id) : undefined;
      if (!cur) continue; // update to something forgotten or never added
      const patch = e.payload.patch as MemoryPatch | undefined;
      if (!patch) continue;
      const next: Memory = { ...cur, updatedAt: e.ts };
      if (typeof patch.text === "string" && patch.text.trim()) {
        next.text = patch.text;
        next.lemmas = lemmatize(patch.text);
        next.hash = memoryHash(patch.text);
      }
      if (isMemoryKind(patch.kind)) next.kind = patch.kind;
      if (Array.isArray(patch.entities)) next.entities = patch.entities;
      if (typeof patch.confidence === "number") next.confidence = clamp01(patch.confidence);
      if (typeof patch.evidence === "string") next.evidence = patch.evidence;
      if (patch.expiresAt !== undefined) next.expiresAt = patch.expiresAt;
      byId.set(cur.id, next);
      continue;
    }
    if (e.kind === "memory_forget") {
      const id = e.payload.id as string | undefined;
      if (id) byId.delete(id);
    }
  }
  return byId;
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

export function isExpired(m: Memory, now = Date.now()): boolean {
  return m.expiresAt !== undefined && m.expiresAt <= now;
}

// ---------------------------------------------------------------------------
// Brain
// ---------------------------------------------------------------------------

/**
 * A project's memory. Reads and writes through the event log; holds a folded
 * cache so `list`/`retrieve` don't replay history on every call, and keeps the
 * cache honest by subscribing to the log rather than by trusting its own writes.
 */
export class Brain {
  private cache: Map<string, Memory> | null = null;
  private unsubscribe: (() => void) | null = null;

  constructor(private log: EventLog) {
    // The cache is invalidated by the log, not by our own methods, so a write
    // from anywhere — another Brain, a replay, the CLI — is seen too.
    this.unsubscribe = this.log.onEvent((e) => {
      if (e.kind === "memory_add" || e.kind === "memory_update" || e.kind === "memory_forget") {
        this.cache = null;
      }
    });
  }

  close(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  private state(): Map<string, Memory> {
    if (!this.cache) {
      this.cache = foldMemories(
        this.log.list({ kinds: ["memory_add", "memory_update", "memory_forget"] }),
      );
    }
    return this.cache;
  }

  /** Every live memory, newest first. */
  all(): Memory[] {
    return [...this.state().values()].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  get(id: string): Memory | undefined {
    return this.state().get(id);
  }

  /** Is this already known? Cheap enough to call before spending an LLM turn. */
  findByHash(hash: string): Memory | undefined {
    for (const m of this.state().values()) if (m.hash === hash) return m;
    return undefined;
  }

  list(opts: ListOpts = {}): Memory[] {
    const now = Date.now();
    let out = this.all();
    if (opts.kind) out = out.filter((m) => m.kind === opts.kind);
    if (opts.chat) out = out.filter((m) => !m.scope.chat || m.scope.chat === opts.chat);
    if (opts.agent) out = out.filter((m) => !m.scope.agent || m.scope.agent === opts.agent);
    if (!opts.includeExpired) out = out.filter((m) => !isExpired(m, now));
    if (opts.minConfidence !== undefined) {
      out = out.filter((m) => m.confidence >= (opts.minConfidence as number));
    }
    return opts.limit ? out.slice(0, opts.limit) : out;
  }

  /**
   * Learn something.
   *
   * Deduplicates on hash before writing: the same fact arriving twice is not
   * two memories. Returns the existing one when that happens, so a caller can
   * tell "already knew that" from "learned that" — which is exactly the signal
   * phase 2 needs to skip an extraction call.
   */
  add(input: NewMemory): { memory: Memory; created: boolean } {
    const text = input.text.trim();
    if (!text) throw new Error("a memory needs text");
    if (!MEMORY_KINDS_SET.has(input.kind)) throw new Error(`unknown memory kind: ${input.kind}`);

    const hash = memoryHash(text);
    const existing = this.findByHash(hash);
    if (existing) return { memory: existing, created: false };

    const ts = Date.now();
    const memory: Memory = {
      id: newMemoryId(),
      kind: input.kind,
      text,
      // Entities the caller names are additive to the ones we can see, because
      // an extractor knows things the regex can't (that "the daemon" means
      // src/daemon/server.ts) and the regex sees things it forgot to mention.
      entities: [...new Set([...(input.entities ?? []), ...extractEntities(text)])],
      scope: input.scope ?? {},
      provenance: input.provenance,
      confidence: clamp01(input.confidence ?? 1),
      ...(input.evidence ? { evidence: input.evidence } : {}),
      lemmas: lemmatize(text),
      hash,
      createdAt: ts,
      updatedAt: ts,
      ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
    };

    this.log.append({
      kind: "memory_add",
      agentId: input.provenance.agentId,
      ...(input.scope?.chat ? { chat: input.scope.chat } : {}),
      payload: { memory },
    });
    return { memory, created: true };
  }

  /** Correct something we already believe. */
  update(id: string, patch: MemoryPatch, by: string): Memory {
    const cur = this.state().get(id);
    if (!cur) throw new Error(`no such memory: ${id}`);
    if (patch.text !== undefined && !patch.text.trim()) {
      throw new Error("a memory needs text");
    }
    if (patch.kind !== undefined && !MEMORY_KINDS_SET.has(patch.kind)) {
      throw new Error(`unknown memory kind: ${patch.kind}`);
    }
    // Re-derive entities when the text moves, or they describe the old text.
    const full: MemoryPatch =
      patch.text !== undefined && patch.entities === undefined
        ? { ...patch, entities: [...new Set(extractEntities(patch.text))] }
        : patch;

    this.log.append({
      kind: "memory_update",
      agentId: by,
      ...(cur.scope.chat ? { chat: cur.scope.chat } : {}),
      payload: { id, patch: full, by },
    });
    const next = this.state().get(id);
    if (!next) throw new Error(`no such memory: ${id}`); // unreachable: we just appended
    return next;
  }

  /**
   * Forget something.
   *
   * The memory leaves the fold; the log keeps every byte. That asymmetry is the
   * point — "why did it ever think that" stays answerable after the answer is
   * "it doesn't any more". A reason is required, because a tombstone with no
   * reason is how you end up re-learning the same wrong thing next week.
   */
  forget(id: string, reason: string, by: string): boolean {
    const cur = this.state().get(id);
    if (!cur) return false;
    if (!reason.trim()) throw new Error("forgetting needs a reason");
    this.log.append({
      kind: "memory_forget",
      agentId: by,
      ...(cur.scope.chat ? { chat: cur.scope.chat } : {}),
      payload: { id, reason: reason.trim(), by, text: cur.text },
    });
    return true;
  }

  /**
   * Everything that ever happened to one memory, including its death.
   *
   * This is a filter over the same events the fold reads. mem0 keeps a whole
   * second SQLite database for it (`storage.py`), and pays for the two to
   * disagree — its batch path drops actor_id and role that its single path
   * records.
   */
  history(id: string): MemoryHistoryEntry[] {
    const out: MemoryHistoryEntry[] = [];
    for (const e of this.log.list({ kinds: ["memory_add", "memory_update", "memory_forget"] })) {
      if (e.kind === "memory_add") {
        const m = e.payload.memory as Memory | undefined;
        if (m?.id !== id) continue;
        out.push({ op: "add", eventId: e.id, ts: e.ts, by: m.provenance.agentId, text: m.text });
      } else if (e.kind === "memory_update") {
        if (e.payload.id !== id) continue;
        const patch = e.payload.patch as MemoryPatch | undefined;
        out.push({
          op: "update",
          eventId: e.id,
          ts: e.ts,
          by: String(e.payload.by ?? e.agentId ?? "unknown"),
          ...(patch?.text ? { text: patch.text } : {}),
        });
      } else if (e.kind === "memory_forget") {
        if (e.payload.id !== id) continue;
        out.push({
          op: "forget",
          eventId: e.id,
          ts: e.ts,
          by: String(e.payload.by ?? e.agentId ?? "unknown"),
          reason: String(e.payload.reason ?? ""),
        });
      }
    }
    return out;
  }

  stats(): { total: number; byKind: Record<string, number>; expired: number } {
    const now = Date.now();
    const byKind: Record<string, number> = {};
    let expired = 0;
    for (const m of this.state().values()) {
      byKind[m.kind] = (byKind[m.kind] ?? 0) + 1;
      if (isExpired(m, now)) expired++;
    }
    return { total: this.state().size, byKind, expired };
  }
}
