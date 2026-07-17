/**
 * Phase 2 — learning from a turn.
 *
 * Phases 0 and 1 gave the brain units and retrieval, both deterministic. This is
 * where memories start arriving on their own: when an agent finishes a turn, an
 * ADE reads the transcript and proposes what to remember, reconciled against
 * what's already known.
 *
 * The shape is mem0's, adapted (see docs/proposals/brain.md):
 *   - retrieve the candidates a new fact might collide with (phase 1);
 *   - show them to the extractor INTEGER-MAPPED, never by real id — a
 *     hallucinated "7" is detectable and droppable; a hallucinated uuid is
 *     silent corruption (mem0 main.py:889);
 *   - the extractor returns ADD / UPDATE / FORGET / NONE;
 *   - every ADD/UPDATE must quote the span it came from, and that span is
 *     verified IN CODE to appear in the turn — the cheapest hallucination guard
 *     there is, and the one mem0 doesn't have.
 *
 * The LLM is injected as an `engine` (a prompt → text function), so all of the
 * logic here — mapping, parsing, evidence-checking, applying — is pure and
 * tested without a model. The default engine is the logged-in Claude CLI, the
 * same no-API-key path distill.ts already uses.
 */

import type { Brain, Memory, MemoryKind } from "./brain.js";
import { MEMORY_KINDS } from "./brain.js";
import { retrieveFrom } from "./brain-index.js";

/** One thing the extractor decided to do. Ids here are the INTEGER map keys. */
export type ExtractOp =
  | { op: "ADD"; text: string; kind: MemoryKind; entities?: string[]; confidence?: number; evidence: string }
  | { op: "UPDATE"; id: string; text: string; confidence?: number; evidence: string }
  | { op: "FORGET"; id: string; reason: string }
  | { op: "NONE" };

/** A retrieved memory, presented to the extractor under a throwaway integer id. */
export interface Candidate {
  intId: string;
  memory: Memory;
}

export interface ExtractResult {
  added: Memory[];
  updated: Memory[];
  forgotten: string[];
  /** Ops thrown out, with why — surfaced so a bad extractor is visible, not silent. */
  dropped: Array<{ op: ExtractOp; reason: string }>;
}

const MEMORY_KIND_SET = new Set<string>(MEMORY_KINDS);

/** Whitespace-insensitive containment — the extractor may reflow what it quotes. */
function normalizeForMatch(s: string): string {
  return s.replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * Does the quoted span actually appear in the turn?
 *
 * The whole anti-hallucination guarantee rests on this one check. Whitespace is
 * normalised (the model reflows), but the words have to be there. A short quote
 * is too easy to satisfy by accident, so anything under a few characters is
 * rejected outright.
 */
export function evidenceInTurn(evidence: string, turn: string): boolean {
  const e = normalizeForMatch(evidence);
  if (e.length < 8) return false;
  return normalizeForMatch(turn).includes(e);
}

// ---------------------------------------------------------------------------
// The prompt
// ---------------------------------------------------------------------------

export const EXTRACT_SYSTEM = `You extract durable engineering memory from one agent turn in a software project.

Return ONLY facts that will still matter next week: constraints reality imposes, decisions and why, conventions this repo follows, plain facts about how things are, and — most valuable — failures (what was tried and did not work, so nobody burns the time again). Skip chit-chat, restated instructions, and anything true only for this minute.

You are given EXISTING memories, each under an integer id. Use them ONLY to avoid duplicates and to correct what's now wrong:
- ADD a new memory when the turn reveals something not already known.
- UPDATE an existing memory (by its integer id) when the turn shows it was incomplete or has changed. Keep the id.
- FORGET an existing memory (by its integer id) when the turn shows it is now false.
- Otherwise NONE.

Rules, strictly:
- Every ADD and UPDATE MUST include "evidence": a short verbatim quote FROM THE TURN that the memory is based on. If you can't quote it from the turn, don't write it.
- Each memory is ONE self-contained sentence that reads true with no surrounding context.
- Use ONLY the integer ids shown for UPDATE/FORGET. Never invent an id.
- kind is one of: constraint, decision, convention, fact, failure.

Respond with JSON only, no prose:
{"ops":[{"op":"ADD","text":"...","kind":"failure","evidence":"...","confidence":0.9},{"op":"UPDATE","id":"2","text":"...","evidence":"..."},{"op":"FORGET","id":"5","reason":"..."},{"op":"NONE"}]}`;

export function buildExtractionPrompt(turn: string, candidates: Candidate[]): string {
  const existing = candidates.length
    ? candidates
        .map((c) => `  ${JSON.stringify(c.intId)}: ${JSON.stringify(c.memory.text)}`)
        .join("\n")
    : "  (none)";
  return [
    "EXISTING memories (integer id: text):",
    existing,
    "",
    "THE TURN (an agent's work — the user's ask and the agent's actions/reply):",
    turn.length > 12_000 ? turn.slice(0, 12_000) + "\n…(truncated)" : turn,
    "",
    "Extract memory as JSON per the system instructions.",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Parsing the engine's reply
// ---------------------------------------------------------------------------

function stripFences(s: string): string {
  return s.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/,"").trim();
}

/** Pull the ops array out of the engine's reply, tolerantly. */
export function parseExtraction(response: string): ExtractOp[] {
  const text = stripFences(response || "").trim();
  if (!text) return [];
  let obj: unknown;
  try {
    obj = JSON.parse(text);
  } catch {
    // The model wrapped the JSON in prose — grab the first {...} block.
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) return [];
    try {
      obj = JSON.parse(m[0]);
    } catch {
      return [];
    }
  }
  const rawOps = Array.isArray(obj)
    ? obj
    : Array.isArray((obj as { ops?: unknown })?.ops)
      ? (obj as { ops: unknown[] }).ops
      : [];
  const ops: ExtractOp[] = [];
  for (const raw of rawOps) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    const op = String(r.op ?? "").toUpperCase();
    if (op === "ADD" && typeof r.text === "string" && typeof r.evidence === "string") {
      const kind = String(r.kind ?? "fact");
      ops.push({
        op: "ADD",
        text: r.text,
        kind: (MEMORY_KIND_SET.has(kind) ? kind : "fact") as MemoryKind,
        ...(Array.isArray(r.entities) ? { entities: r.entities.map(String) } : {}),
        ...(typeof r.confidence === "number" ? { confidence: r.confidence } : {}),
        evidence: r.evidence,
      });
    } else if (op === "UPDATE" && r.id != null && typeof r.text === "string" && typeof r.evidence === "string") {
      ops.push({
        op: "UPDATE",
        id: String(r.id),
        text: r.text,
        ...(typeof r.confidence === "number" ? { confidence: r.confidence } : {}),
        evidence: r.evidence,
      });
    } else if (op === "FORGET" && r.id != null) {
      ops.push({ op: "FORGET", id: String(r.id), reason: String(r.reason ?? "the turn showed it is no longer true") });
    }
    // NONE and anything malformed are simply ignored.
  }
  return ops;
}

// ---------------------------------------------------------------------------
// Applying — where the guards live
// ---------------------------------------------------------------------------

export interface ApplyOpts {
  /** Who's learning this — an agent id, or "brain" for the extractor itself. */
  by: string;
  eventId: number;
  chat?: string;
}

/**
 * Apply the extractor's ops to the brain, dropping anything that fails a guard.
 *
 * The guards, in order: an ADD/UPDATE with no verifiable evidence span is a
 * hallucination and is dropped; an UPDATE/FORGET whose integer id isn't in the
 * candidate set is a hallucinated reference and is dropped; a real id maps back
 * to its uuid before touching the store.
 */
export function applyExtraction(
  brain: Brain,
  ops: ExtractOp[],
  turn: string,
  candidates: Candidate[],
  opts: ApplyOpts,
): ExtractResult {
  const byInt = new Map(candidates.map((c) => [c.intId, c.memory]));
  const res: ExtractResult = { added: [], updated: [], forgotten: [], dropped: [] };
  const prov = { agentId: opts.by, eventId: opts.eventId, ts: Date.now() };

  for (const op of ops) {
    if (op.op === "ADD") {
      if (!evidenceInTurn(op.evidence, turn)) {
        res.dropped.push({ op, reason: "evidence not found in the turn" });
        continue;
      }
      const { memory, created } = brain.add({
        kind: op.kind,
        text: op.text,
        ...(op.entities ? { entities: op.entities } : {}),
        ...(op.confidence !== undefined ? { confidence: op.confidence } : {}),
        evidence: op.evidence,
        ...(opts.chat ? { scope: { chat: opts.chat } } : {}),
        provenance: prov,
      });
      if (created) res.added.push(memory);
      else res.dropped.push({ op, reason: "already known (hash match)" });
    } else if (op.op === "UPDATE") {
      const target = byInt.get(op.id);
      if (!target) {
        res.dropped.push({ op, reason: `no candidate with id ${op.id}` });
        continue;
      }
      if (!evidenceInTurn(op.evidence, turn)) {
        res.dropped.push({ op, reason: "evidence not found in the turn" });
        continue;
      }
      try {
        const updated = brain.update(
          target.id,
          { text: op.text, ...(op.confidence !== undefined ? { confidence: op.confidence } : {}), evidence: op.evidence },
          opts.by,
        );
        res.updated.push(updated);
      } catch (err) {
        res.dropped.push({ op, reason: err instanceof Error ? err.message : String(err) });
      }
    } else if (op.op === "FORGET") {
      const target = byInt.get(op.id);
      if (!target) {
        res.dropped.push({ op, reason: `no candidate with id ${op.id}` });
        continue;
      }
      if (brain.forget(target.id, op.reason, opts.by)) res.forgotten.push(target.id);
    }
  }
  return res;
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

export type ExtractEngine = (prompt: { system: string; user: string }) => Promise<string>;

export interface ExtractFromTurnOpts {
  engine: ExtractEngine;
  /** Who ran the turn — the memories are attributed to them. */
  agentId: string;
  chat?: string;
  /** Files the turn touched — sharpens candidate retrieval. */
  files?: string[];
  /** How many existing memories to show the extractor as collision candidates. */
  candidateLimit?: number;
  eventId?: number;
}

/**
 * Learn from one turn: retrieve candidates, ask the engine, apply the ops.
 *
 * Non-throwing by contract — a broken or slow extractor must never be able to
 * take down the turn that triggered it (the same rule distill.ts follows). Any
 * failure returns an empty result.
 */
export async function extractFromTurn(
  brain: Brain,
  turn: string,
  opts: ExtractFromTurnOpts,
): Promise<ExtractResult> {
  const empty: ExtractResult = { added: [], updated: [], forgotten: [], dropped: [] };
  if (!turn.trim()) return empty;

  // Candidates: what a new fact from this turn might collide with. Query is the
  // turn itself plus the files it touched — exactly what phase 1 ranks on.
  const hits = retrieveFrom(brain.all(), {
    query: turn.slice(0, 4000),
    ...(opts.files?.length ? { files: opts.files } : {}),
    ...(opts.chat ? { chat: opts.chat } : {}),
    limit: opts.candidateLimit ?? 10,
  });
  const candidates: Candidate[] = hits.map((h, i) => ({ intId: String(i), memory: h.memory }));

  let reply: string;
  try {
    reply = await opts.engine({
      system: EXTRACT_SYSTEM,
      user: buildExtractionPrompt(turn, candidates),
    });
  } catch {
    return empty; // extractor unavailable — the turn is unaffected
  }

  const ops = parseExtraction(reply);
  if (!ops.length) return empty;
  return applyExtraction(brain, ops, turn, candidates, {
    by: opts.agentId,
    eventId: opts.eventId ?? 0,
    ...(opts.chat ? { chat: opts.chat } : {}),
  });
}
