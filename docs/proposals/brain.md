# The Brain — an ADE memory layer for Loom

**Status:** proposal
**Reference:** `references/mem0` @ `739534c` (mem0ai/mem0, Apache-2.0), read at depth
**Note:** that checkout is a **v3 "additive" fork**. The classic ADD/UPDATE/DELETE memory-manager loop and the Neo4j graph layer are both *gone* from the code — `mem0/graphs/` and `graph_memory.py` do not exist, and `grep -n graph mem0/memory/main.py` returns zero hits. mem0's own `CLAUDE.md` still documents the graph; it is stale. Read the code, not the docs.

---

## 1. What mem0 actually does

Four ideas. The vector database is the least interesting one.

**Idea 1 — memory is an addressable unit, not a document.** One short self-contained statement, with an id, an embedding, an md5 hash, scoping ids, and a payload. Not a transcript.

**Idea 2 — the write path reconciles; it does not append.** `main.py:872-1160`:

| Phase | What | Line |
|---|---|---|
| 0 | Last 10 messages of session context | `:876` |
| 1 | **Vector-search the store with the raw new conversation as the query** — pull the top 10 memories that might collide | `:882` |
| 2 | **One** LLM call seeing new messages *and* those candidates → facts already deduped | `:912` |
| 3 | Batch-embed | `:950` |
| 4-5 | md5 dedup vs existing hashes and within the batch | `:976` |
| 6 | Batch persist | `:1007` |
| 7 | Batch entity linking | `:1042` |
| 8 | Save raw messages regardless | `:1148` |

The older explicit form (`prompts.py:176`) states the intent plainly: per fact, return **ADD / UPDATE / DELETE / NONE** against the existing set. Memory that *self-corrects*. "Likes cheese pizza" + "loves chicken pizza" → one UPDATE, not two rows contradicting each other forever.

**Idea 3 — never let the LLM touch a real id.** `main.py:889-894` maps UUIDs to `"0"`, `"1"`, `"2"` before showing candidates, and maps back after. The comment is literally `# Map UUIDs to integers (anti-hallucination)`. A hallucinated `"7"` is detectable; a hallucinated UUID is silent corruption.

**Idea 4 — every change is append-only and auditable.** `storage.py` — a `history` table whose only writes are INSERT. Delete appends a tombstone (`is_deleted=1`); prior rows survive. You can always ask *why does it think that*.

### The read path, and the trap in it

`_search_vector_store` (`:1584`): lemmatize + extract query entities → embed → dense search over-fetching `max(limit*4, 60)` → BM25 (`keyword_search`, real, via a `Qdrant/bm25` sparse vector) → entity boosts → combine → shape.

**The trap, and the single most valuable thing in this whole reference:** at `:1622-1633` the candidate set is built **from the dense results only**. BM25 and entity boosts can only *re-rank what vector search already returned*. A memory that BM25 matches perfectly but dense search misses **cannot be retrieved, at any score**. It is not RRF, not a union — it is "dense recall, hybrid precision," and it is a recall bug wearing a hybrid-search costume. Do not copy this.

Scoring (`utils/scoring.py`) is additive with a **query-dependent divisor**: `min((semantic + bm25 + entity) / max_possible, 1.0)`, where `max_possible` is 1.0/1.5/2.0/2.5 depending on which signals fired *anywhere in the query*. So a doc scoring `semantic=0.9, bm25=0` gets 0.45 if some *other* doc matched keywords, and 0.9 if none did. Scores are not comparable across queries. And `threshold` gates the **raw semantic score before combining** (`:110-112`) — so it's a pure dense-recall gate that silently overrides the hybrid signals. Also don't copy.

Worth stealing outright: `memory_count_weight = 1/(1 + 0.001*(n-1)²)` (`:1758`) — a cheap inverse-quadratic IDF surrogate. An entity linked to 1 memory weighs 1.0; to 32 memories, 0.5; to 100, 0.09. Common entities self-suppress. Ten lines, no corpus statistics.

### The entity store is not a graph

`main.py:544-692`. It is a **bipartite inverted index wearing a vector-store costume**: a second collection where each row is `{data, entity_type, linked_memory_ids[]}`, vector = embedding of the entity text. There are **no entity↔entity edges and no traversal**. Lookup is fuzzy (≥0.5 similarity to boost, ≥0.95 to merge as an alias); the price is `list(top_k=10000)` full scans on every upsert (`:550`).

**And entities are extracted by spaCy, not an LLM** (`utils/entity_extraction.py:751`) — NER plus proper-noun/quoted/topic/identifier heuristics, resolved by span-overlap rejection against heavy stoplists. This matters for §3.

One more tell: the extraction prompt carefully elicits `linked_memory_ids` — memory→memory relations (`prompts.py:854`) — and `_add_to_vector_store` reads only `text` and `attributed_to` off each object (`:971-995`). **The memory graph is elicited and then thrown away.** If you don't store it, don't ask for it.

**What mem0 requires to exist:** Qdrant, an OpenAI key, SQLAlchemy, an embedding model, spaCy. Three services, a credential, and a 500MB model.

---

## 2. What Loom's Brain actually is today

Honest inventory. A proposal aimed at an imaginary starting point is worthless.

**It is a read-only tab over a document that is recomputed from scratch on every GET. There is no brain store. There is no memory unit anywhere in the codebase.**

- `GET /api/projects/:id/memory` → `rt.unifiedMemory()` (`server.ts:721`). Every field is derived on the spot from (a) `decision` events in the log and (b) a **live filesystem read** of each ADE's native memory file.
- `src/core/memory.ts` — `NATIVE_MEMORY` (`:35`) maps every ADE to its real memory paths (`CLAUDE.md`, `AGENTS.md`, `.kiro/steering/*.md`, `.antigravity/memory.md`, `.windsurfrules`). `readNativeMemory()` reads and truncates each at 8k chars; `buildUnifiedMemory()` concatenates them with `slice(-40)` decisions into one markdown string. **This cross-ADE import is Loom's real insight and the thing no isolation-first tool can structurally own.** But merging is all it does.
- `importMemories()` (`runtime.ts:446`) is a **dedup ledger, not a store**: it appends a `memory_import` event carrying `{file, kind, chars, hash}`. The content is never stored — only its sha1 and length. Re-reading is always from disk.
- `src/core/projection.ts` — `buildProjection()` is a **recency window**: `slice(-30)` messages @300 chars, `slice(-20)` files, `slice(-5)` handoffs, all decisions @300 chars. `buildBriefing()` is the same at `slice(-8)` / `slice(-6)` @200 chars.
- `src/core/distill.ts` — optionally sends that window to Claude Haiku for prose, falling back to the template on any failure. **The precedent that matters: Loom already uses a logged-in CLI as an LLM** (`claudeText()`, `claude-cli.ts:17`). No API key involved.
- The event log (`eventlog.ts`) is append-only over **`node:sqlite` at `.loom/log.db`** (verified available — Node 25.8.2), JSONL only as fallback. 22 event kinds. `decision`, `turn_diff` (`{files, added, removed, patch}` per agent turn, from a real git snapshot), `file_edit`, and `memory_import` already exist. `types.ts` opens with the stated philosophy: *"The event log is the source of truth; everything else is a projection of it."*

### What's broken today, found while reading

These aren't hypotheticals; they're in the code right now.

1. **Nothing reads `.loom/memory/<id>.md`.** Zero readers in `src/`. `injectMemory()` has exactly one implementation (`base.ts:46`) — write the file — and **no adapter overrides it**. The mechanism is a pointer sentence in the briefing (`projection.ts:112`) plus a hope the agent runs Read. `injectMemory: true` in the capabilities means "writes a file," not "reaches the model."
2. **Only claude-code has guaranteed injection.** It gets `--append-system-prompt` (`claude-code.ts:86`). codex, grok, and opencode prepend the briefing to the user text because none of them has a system-prompt flag. **Bridges get nothing injected at all** — `send: false`, they never hold the baton, so the briefing never reaches Antigravity or Kiro; they only get the file written.
3. **`pendingBriefings` is an in-memory `Map`** (`runtime.ts:641`). A daemon restart between handoff and first message **silently drops the briefing**. The durability of the only guaranteed-injection path is "the process is still alive."
4. **The projection is chat-blind.** `handoff()` calls `log.list({limit: 400})` with no `chat` filter (`:680`) while `sendMessage` scopes per-chat (`:603`). Memory crosses conversation boundaries the thread UI keeps separate.
5. **Decisions are the only human-authored memory**, unstructured strings, append-only — no dedup, no edit, no delete path.
6. **Tokens are never recorded.** Only claude-code emits cost, and only as `{state:"turn_cost", costUsd}` into an in-memory map that resets on restart. There is no budget signal to size an injection against.

**The gap, in one sentence:**

> Loom's brain is a sliding window over recent chat plus a pile of hand-typed decisions; nothing is ever *learned* from a turn, nothing is ever *reconciled*, nothing is ever *retrieved by relevance*, and nothing is ever *forgotten* — and growth is bounded by truncation, which discards the durable architectural facts first and keeps the last 30 lines of chatter.

---

## 3. The three constraints that force a different design

Loom is not mem0 with different nouns.

**A. No API key, no vector DB, no embedder.** Loom's deps: `express`, `ws`, `commander`, `ink`, `xterm`, `react`. Requiring an OpenAI key to have a memory would break the product's central promise — *your agents are already logged in; Loom just connects them*. **But Loom has what mem0 doesn't: six logged-in frontier models reachable headlessly.** `codex exec --json`, `claude -p`, `opencode run`. The extractor is already installed and already paid for, and `distill.ts` proves the pattern in production.

**B. The domain has literal, verifiable entities.** mem0 must run spaCy NER over prose and then fuzzy-match embeddings at 0.95 to decide "Osteria Francescana" is the same restaurant it saw last week. Loom's entities are `src/core/git.ts`, `AgentBase`, `PR #42`, `claude-code`, `EADDRINUSE` — exact strings that appear verbatim in both the conversation and the repo, and that can be **validated against `git ls-files`**. No NER model, no fuzzy alias matching, no 10k-row scans. A regex and a set. This is why lexical retrieval is viable here and isn't for mem0.

**C. Six consumers, not one.** mem0 hands memories to one app. Loom must reach six ADEs through four different mechanisms, two of which currently receive nothing at all. The read path has to *render per ADE*.

---

## 4. The design

Keep `memory.ts`'s cross-ADE import — it's the good idea. Keep `projection.ts` as the **renderer**. Put a real memory layer underneath.

```
  run_complete (turn boundary)
          │
          ▼
   ┌─────────────┐   candidates    ┌──────────────┐
   │  Extractor  │◄────────────────│  Retriever   │
   │  (an ADE,   │                 │  entities ∪  │
   │   headless) │                 │  BM25        │
   └──────┬──────┘                 └──────▲───────┘
          │ ADD / UPDATE / FORGET / NONE  │
          ▼                               │
   ┌──────────────────────────────────────┴──────┐
   │  The event log — memory ops ARE events      │
   │  fold → state.  filter → history.  (exists) │
   └──────┬──────────────────────────────────────┘
          │ retrieve(task, files, agent)
          ▼
   ┌─────────────┐
   │  Compiler   │ → per-ADE brief → the four injection mechanisms
   └─────────────┘
```

### 4.1 The store: memories are events

**Do not build `brain.jsonl`. Do not add SQLite.** Add three event kinds to the log that already exists:

```ts
| "memory_add"     // payload: Memory
| "memory_update"  // payload: { id, text?, confidence?, by, evidence }
| "memory_forget"  // payload: { id, reason, by }
```

The Brain is then a **fold over the log**, cached in memory and kept live by `EventLog.onEvent` (`eventlog.ts:266`), which already exists. History is a filter over the same log — mem0 needs a whole second SQLite store for what Loom gets free. Ordering, durability, the sqlite/JSONL fallback, chat scoping, and the `since`/`kinds` query API are all already built and tested.

This is not a clever trick; it is what `types.ts:1-6` already says the architecture is. Everything else is a projection of the log. The Brain should be too.

Put `retrieve`/`add`/`forget` behind a `Brain` interface anyway, so a vector store can slot in later without touching callers. Don't build that now.

### 4.2 The unit

```ts
export type MemoryKind =
  | "constraint"  // a rule reality imposes: "a raw backtick in app-page.ts closes the template literal"
  | "decision"    // a choice and its reason: "chose CDP over an extension because Antigravity ships no API"
  | "convention"  // how this repo does things: "tests live in test/, *.test.ts, vitest"
  | "fact"        // how it is: "the daemon serves the app from one template literal, no build step"
  | "failure"     // what did not work, and why: "probed the Antigravity Manager for hours — the IDE is a different app"
  | "task";       // ephemeral, run-scoped

export interface Memory {
  id: string;
  kind: MemoryKind;
  /** One self-contained sentence. Must read true with zero surrounding context. */
  text: string;
  /** Literal strings: file paths, symbols, agent ids, error codes. Validated against the repo. */
  entities: string[];
  scope: { chat?: string; agent?: string; task?: string };
  /** One click back to the turn that produced it. */
  provenance: { agentId: string; eventId: number; ts: number };
  /** The extractor's own confidence. Below the floor: shown in the UI, never injected. */
  confidence: number;
  /** The verbatim span it was extracted from. Verified to appear in the turn. */
  evidence: string;
  lemmas: string;   // for BM25; never displayed
  hash: string;     // md5(text) — dedup before spending an LLM call
  createdAt: number;
  updatedAt: number;
  expiresAt?: number;  // task memories expire; constraints and failures never do
}
```

The taxonomy is where this must diverge hardest from mem0, whose categories are personal (preferences, relationships, health). Loom's are engineering. **`failure` is the one nobody builds and the one that matters most** — negative knowledge is the most expensive to re-derive and the least likely to be written down. Every hour lost to "we already tried that" is a `failure` memory that didn't exist. This repo's own history is full of them: the Antigravity Manager, the empty DMG, `restore --staged` in a repo with no commits.

### 4.3 The write path — steal mem0's shape, fix its bug

On `run_complete` (turn boundary — *not* per message; that's the cost control):

1. **Retrieve candidates** — entity lookup over the turn's `turn_diff` files ∪ BM25 over its text → top ~10 that might collide. (mem0 phase 1, lexical.)
2. **Hash-dedup first.** mem0 dedups at phase 4, *after* the LLM call. Do it before: if the turn produces nothing whose hash is new, skip the call entirely. Free.
3. **One extractor call** — show it the turn, the candidates **integer-mapped, never real ids** (`main.py:889`), and the taxonomy. Returns ADD/UPDATE/FORGET/NONE with `text`, `kind`, `entities`, `confidence`, `evidence`.
4. **Verify in code, not in the prompt.** The `evidence` span must literally appear in the turn — `turn.includes(evidence)`. Drop the memory if not. One `includes()` call, and it's the cheapest hallucination guard available. Likewise every entity must appear in `git ls-files` or the turn text, or it's dropped.
5. **Append the ops** as events. The raw turn is already in the log — mem0's phase 8 is free.

Don't elicit what you won't store (mem0's discarded `linked_memory_ids`). If memory→memory links aren't in the schema, they aren't in the prompt.

The extractor is an ADE, chosen by `brain.extractor: "auto" | <agentId> | "off"`, defaulting to any available adapter **not currently holding the baton**. It runs **async and non-blocking** — a slow or broken extractor must never delay a handoff, exactly as `distill.ts` already refuses to let a broken Claude block one.

### 4.4 The read path — a union, not a re-rank

`retrieve({ query, files, agent, task, limit })`:

1. **Entity postings** — exact match on file paths and symbols from the task and `turn_diff`. High precision, zero cost.
2. **BM25** over `lemmas` (~150 lines of pure TS, no dependency).
3. **Union the two candidate sets.** This is the one place to consciously diverge from the reference: mem0's `:1622` restricts candidates to the dense hits, so a perfect keyword match that dense search missed is unreachable. With no dense channel at all, Loom's recall *is* entities ∪ BM25. Union them.
4. **Score with a fixed divisor**, not mem0's query-dependent one — scores should be comparable across queries. Apply `memory_count_weight` (`:1758`) to entity boosts; it's free IDF.
5. **Filter** — scope, confidence floor, expiry. And unlike mem0, expire *before* the top-k cut, not after: mem0 filters expired rows at `:1626` after over-fetching, so dead rows silently eat the recall budget.
6. **Rank by kind** at equal score: `constraint` and `failure` outrank `fact`. Getting burned again is worse than not knowing a detail.

No embeddings. If recall proves inadequate — **measure it against this repo's own log**, don't guess — the interface has room for a local embedder as an *optional* dependency, the way `node-pty` already is. Never a required key.

### 4.5 The injection — the part mem0 never had to solve

```ts
compile(memories, ade): string
```

| ADE | Mechanism | Today |
|---|---|---|
| claude-code | `--append-system-prompt` | ✅ guaranteed |
| codex / opencode / grok-code | prepend to user text (no system-prompt flag exists) | ✅ works |
| antigravity / kiro | no system prompt, never holds the baton | ❌ **nothing reaches the model** |

`memory.ts:35` already knows every native path. `injectMemory()` + `pendingBriefings` is already the seam. **What changes is only what goes in — retrieved, relevant, bounded memories instead of the last 30 lines of chat.** Three fixes ride along and should be scoped in:

- **Persist `pendingBriefings`** into `.loom/state.json` (it's a `Map` today; a restart drops it).
- **Give bridges a real path** — they can't take a system prompt, but their chat text can carry a compiled brief.
- **Scope the projection by chat**, matching `sendMessage`.

And it closes a loop that is currently open: Loom *reads* `CLAUDE.md` and never writes back. The Brain should offer to **write learned constraints into the repo's own `CLAUDE.md`/`AGENTS.md`** — user-gated, because it edits tracked files. That makes Loom's memory useful *even when Loom isn't running*, which is the strongest argument the product has.

---

## 5. Phasing, honestly

| Phase | What | LLM? | Effort |
|---|---|---|---|
| **0** | Types, three event kinds, the fold, `add/get/list/forget` | no | S |
| **1** | Entity index + BM25 + `retrieve()` — deterministic, pure functions | no | M |
| **2** | Extractor via an ADE, reconciliation, int-id mapping, evidence + entity verification | **yes** | L |
| **3** | `compile()` per ADE; replace the blob at the handoff; keep the template fallback; fix the three injection bugs | no | M |
| **4** | Brain tab: real memories, provenance links, forget button, confidence, filters | no | M |
| **5** | Write-back to `CLAUDE.md`/`AGENTS.md`, user-gated | no | S |
| **6** | *Only if measured:* embeddings behind the interface | no | — |

Phases 0-1 are pure functions over a log that already exists — trivially unit-testable, no risk, no tokens. **Phase 2 is where both the money and the danger are.** Phase 3 is where the user first feels it.

**Suggested first cut: 0 + 1 + 4**, with memories seeded only from existing `decision` events and `turn_diff` files. That yields a working, honest, LLM-free Brain tab — real units, real retrieval, real forgetting — and proves the store and the recall before spending a single token. Then add 2 and measure it against the log this repo already has.

---

## 6. Risks, stated plainly

**A wrong memory is worse than no memory.** This is the whole risk and everything else is a footnote. A hallucinated "constraint" gets injected into six agents, is believed by all of them, and compounds. mem0's blast radius is a bad restaurant recommendation; Loom's is every agent confidently building on a fiction. The mitigations are load-bearing, not nice-to-have: verified evidence spans (code, not prompt); entities validated against `git ls-files`; provenance on every memory with one click to the source turn; a confidence floor for injection; every memory visible and deletable in the Brain tab; and an append-only log, so `forget` is always available and always honest.

**Token cost per turn.** One extractor call per turn boundary. Mitigated by hash-dedup *before* the call, `run_complete`-only triggering, async execution, and shipping `brain.extractor: "off"` as a real supported mode. Note there's no token accounting today (§2.6) — if cost control matters, that gets fixed first or you're flying blind.

**Extractor variance.** Six ADEs will extract at six different qualities. Pin the extractor per project; never rotate silently.

**BM25 recall — the honest unknown.** Mitigated by the domain (literal entities) and by short extractor-written statements, but it must be *measured* against held-out turns from this repo's log before anyone declares victory. mem0 ships a benchmark suite for exactly this reason.

**Scope creep into a graph.** mem0's entity store is already a soft graph, and even mem0 deleted its real one. Resist. The entity index is enough until proven otherwise.

---

## 7. Why this is worth building

mem0 gives one assistant a memory of one user.

Loom's thesis is different and larger: **six ADEs, one brain.** `memory.ts` already imports every agent's native memory and merges it — a real insight, and one that no isolation-first tool (separate worktrees, separate contexts) can structurally own. What's missing is that the merged thing isn't a memory yet. It's a pile, truncated by recency.

The gap between "everyone's notes, concatenated and cut off at 8k" and "a reconciled, retrievable, self-correcting store that every agent inherits and contributes to" is exactly the gap mem0 closed for personal assistants. Nobody has closed it for coding agents. And the pieces are already in this repo: an append-only sqlite log, per-turn file attribution via `turn_diff`, six headless frontier models, native memory paths for every ADE, an injection seam, and a stated architecture that already says everything is a projection of the log.
