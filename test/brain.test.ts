/**
 * The brain: units, the fold, and retrieval.
 *
 * Against a real EventLog, because the whole design claim is "a memory is three
 * events in the log, folded" — a mocked log would only prove this file agrees
 * with itself, and the thing most worth checking is that state and history
 * really are the same bytes.
 */

import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { EventLog } from "../src/core/eventlog.js";
import {
  Brain,
  CONFIDENCE_FLOOR,
  extractEntities,
  foldMemories,
  lemmatize,
  memoryHash,
  type MemoryProvenance,
} from "../src/core/brain.js";
import { queryEntities, retrieve, retrieveFrom } from "../src/core/brain-index.js";
import { tmpDir } from "./helpers.js";

async function brain(): Promise<{ brain: Brain; log: EventLog; dir: string }> {
  const dir = path.join(tmpDir("brain"), ".loom");
  fs.mkdirSync(dir, { recursive: true });
  const log = await EventLog.open(dir);
  return { brain: new Brain(log), log, dir };
}

const by = (agentId = "claude-code", eventId = 1): MemoryProvenance => ({
  agentId,
  eventId,
  ts: Date.now(),
});

// ---------------------------------------------------------------------------
// Phase 0 — the unit and the fold
// ---------------------------------------------------------------------------

describe("brain · learning", () => {
  it("stores a memory and reads it back", async () => {
    const { brain: b } = await brain();
    const { memory, created } = b.add({
      kind: "constraint",
      text: "A raw backtick in app-page.ts closes the template literal.",
      provenance: by(),
    });
    expect(created).toBe(true);
    expect(b.get(memory.id)?.text).toContain("raw backtick");
    expect(b.all()).toHaveLength(1);
  });

  it("derives entities from the text without being told", async () => {
    const { brain: b } = await brain();
    const { memory } = b.add({
      kind: "fact",
      text: "The daemon serves the app from src/daemon/app-page.ts via AgentBase.",
      provenance: by(),
    });
    expect(memory.entities).toContain("src/daemon/app-page.ts");
    expect(memory.entities).toContain("AgentBase");
  });

  it("keeps entities the caller names AND the ones it can see", async () => {
    const { brain: b } = await brain();
    // The extractor knows "the daemon" means server.ts; the regex can't. Both
    // channels contribute or we lose one of them.
    const { memory } = b.add({
      kind: "fact",
      text: "The daemon refuses to start twice on one port.",
      entities: ["src/daemon/server.ts"],
      provenance: by(),
    });
    expect(memory.entities).toContain("src/daemon/server.ts");
  });

  /**
   * The signal phase 2 needs: "already knew that" has to be distinguishable
   * from "learned that", or every turn pays for an extraction call to
   * re-discover the same fact.
   */
  it("does not learn the same fact twice", async () => {
    const { brain: b } = await brain();
    const text = "Tests live in test/ and run under vitest.";
    const first = b.add({ kind: "convention", text, provenance: by() });
    const second = b.add({ kind: "convention", text: "  TESTS LIVE IN test/ AND RUN UNDER VITEST.  ", provenance: by() });
    expect(first.created).toBe(true);
    expect(second.created, "same fact, different whitespace and case").toBe(false);
    expect(second.memory.id).toBe(first.memory.id);
    expect(b.all()).toHaveLength(1);
  });

  it("refuses empty text and unknown kinds", async () => {
    const { brain: b } = await brain();
    expect(() => b.add({ kind: "fact", text: "   ", provenance: by() })).toThrow(/needs text/);
    expect(() =>
      b.add({ kind: "nonsense" as never, text: "x", provenance: by() }),
    ).toThrow(/unknown memory kind/);
  });
});

describe("brain · correcting itself", () => {
  it("updates in place, keeping the id", async () => {
    const { brain: b } = await brain();
    const { memory } = b.add({ kind: "fact", text: "The port is 7000.", provenance: by() });
    const next = b.update(memory.id, { text: "The port is 7420." }, "user");
    expect(next.id).toBe(memory.id);
    expect(next.text).toBe("The port is 7420.");
    expect(b.all(), "a correction is not a second memory").toHaveLength(1);
  });

  it("re-derives entities and hash when the text moves", async () => {
    const { brain: b } = await brain();
    const { memory } = b.add({ kind: "fact", text: "Look at src/core/git.ts.", provenance: by() });
    const next = b.update(memory.id, { text: "Look at src/core/search.ts." }, "user");
    expect(next.entities).toContain("src/core/search.ts");
    expect(next.entities, "the old entity must not linger").not.toContain("src/core/git.ts");
    expect(next.hash).toBe(memoryHash("Look at src/core/search.ts."));
  });

  it("refuses to update something it doesn't know", async () => {
    const { brain: b } = await brain();
    expect(() => b.update("nope", { text: "x" }, "user")).toThrow(/no such memory/);
  });
});

describe("brain · forgetting", () => {
  it("forgets, and stops returning it", async () => {
    const { brain: b } = await brain();
    const { memory } = b.add({ kind: "fact", text: "Antigravity ships an API.", provenance: by() });
    expect(b.forget(memory.id, "it doesn't — that's why we use CDP", "user")).toBe(true);
    expect(b.get(memory.id)).toBeUndefined();
    expect(b.all()).toHaveLength(0);
  });

  it("requires a reason — a tombstone with no reason re-teaches the mistake", async () => {
    const { brain: b } = await brain();
    const { memory } = b.add({ kind: "fact", text: "x", provenance: by() });
    expect(() => b.forget(memory.id, "  ", "user")).toThrow(/needs a reason/);
  });

  it("returns false for something it never knew, rather than throwing", async () => {
    const { brain: b } = await brain();
    expect(b.forget("ghost", "reason", "user")).toBe(false);
  });

  /**
   * The asymmetry that makes the whole design work: the memory leaves the fold,
   * the log keeps every byte. "Why did it ever think that" stays answerable
   * after the answer becomes "it doesn't any more".
   */
  it("keeps the history of a memory it has forgotten", async () => {
    const { brain: b } = await brain();
    const { memory } = b.add({ kind: "fact", text: "The IDE is Antigravity.app.", provenance: by() });
    b.update(memory.id, { text: "The IDE is Antigravity IDE.app." }, "user");
    b.forget(memory.id, "superseded", "user");

    expect(b.get(memory.id), "gone from state").toBeUndefined();
    const h = b.history(memory.id);
    expect(h.map((e) => e.op)).toEqual(["add", "update", "forget"]);
    expect(h[0].text).toContain("Antigravity.app");
    expect(h[2].reason).toBe("superseded");
  });
});

describe("brain · state and history are the same bytes", () => {
  /**
   * The claim the whole design rests on. If a fresh fold over the log doesn't
   * reproduce the live cache, then the cache is the source of truth and the
   * doc is lying.
   */
  it("rebuilds identical state from the log alone", async () => {
    const { brain: b, log, dir } = await brain();
    b.add({ kind: "constraint", text: "Double every backslash in app-page.ts.", provenance: by() });
    const { memory: m2 } = b.add({ kind: "fact", text: "The daemon listens on 7420.", provenance: by() });
    b.update(m2.id, { text: "The daemon listens on port 7420 by default." }, "user");
    const { memory: m3 } = b.add({ kind: "task", text: "Ship the brain.", provenance: by() });
    b.forget(m3.id, "done", "user");

    const live = b.all();
    log.close();

    // A brand-new log over the same directory: nothing in memory survives.
    const reopened = await EventLog.open(dir);
    const rebuilt = new Brain(reopened);
    expect(rebuilt.all()).toEqual(live);
    expect(rebuilt.all()).toHaveLength(2);
    reopened.close();
  });

  it("ignores an update to a memory that was forgotten", async () => {
    const { brain: b, log } = await brain();
    const { memory } = b.add({ kind: "fact", text: "gone soon", provenance: by() });
    b.forget(memory.id, "reason", "user");
    // Append by hand — a replay or another writer could produce this order.
    log.append({ kind: "memory_update", payload: { id: memory.id, patch: { text: "zombie" }, by: "x" } });
    expect(b.all(), "an update must not resurrect it").toHaveLength(0);
  });

  it("survives a malformed memory event rather than throwing", () => {
    const events = [
      { id: 1, ts: 1, kind: "memory_add" as const, payload: { memory: { id: "a", kind: "bogus", text: "x" } } },
      { id: 2, ts: 2, kind: "memory_add" as const, payload: {} },
      { id: 3, ts: 3, kind: "memory_update" as const, payload: { id: "missing", patch: { text: "y" } } },
      { id: 4, ts: 4, kind: "memory_forget" as const, payload: {} },
    ];
    expect(foldMemories(events)).toHaveLength(0);
  });
});

describe("brain · scope, expiry, listing", () => {
  it("expires task memories but never constraints", async () => {
    const { brain: b } = await brain();
    b.add({ kind: "task", text: "A dead task.", provenance: by(), expiresAt: Date.now() - 1000 });
    b.add({ kind: "constraint", text: "A live constraint.", provenance: by() });
    expect(b.list()).toHaveLength(1);
    expect(b.list()[0].kind).toBe("constraint");
    expect(b.list({ includeExpired: true })).toHaveLength(2);
  });

  it("filters by kind, chat and confidence", async () => {
    const { brain: b } = await brain();
    b.add({ kind: "fact", text: "Project-wide fact.", provenance: by() });
    b.add({ kind: "fact", text: "Something about chat one.", provenance: by(), scope: { chat: "c1" } });
    b.add({ kind: "failure", text: "A shaky guess.", provenance: by(), confidence: 0.2 });

    expect(b.list({ kind: "failure" })).toHaveLength(1);
    // Unscoped memories belong to every chat; scoped ones only to theirs.
    expect(b.list({ chat: "c1" }).map((m) => m.text).sort()).toEqual([
      "A shaky guess.",
      "Project-wide fact.",
      "Something about chat one.",
    ]);
    expect(b.list({ chat: "c2" })).toHaveLength(2);
    expect(b.list({ minConfidence: CONFIDENCE_FLOOR })).toHaveLength(2);
  });

  it("counts what it knows", async () => {
    const { brain: b } = await brain();
    b.add({ kind: "constraint", text: "one", provenance: by() });
    b.add({ kind: "constraint", text: "two", provenance: by() });
    b.add({ kind: "fact", text: "three", provenance: by() });
    const s = b.stats();
    expect(s.total).toBe(3);
    expect(s.byKind).toEqual({ constraint: 2, fact: 1 });
  });
});

// ---------------------------------------------------------------------------
// Phase 1 — retrieval
// ---------------------------------------------------------------------------

describe("lemmatize", () => {
  it("stems ordinary words and keeps the raw token too", () => {
    // Both, because we can't know whether the query will say "run" or "running".
    expect(lemmatize("running tests").split(" ")).toEqual(expect.arrayContaining(["running", "run", "tests", "test"]));
  });

  it("leaves identifiers alone", () => {
    // Stemming useState into useStat, or git.ts into git.t, is how a lexical
    // index stops finding the thing you named exactly.
    const out = lemmatize("useState in src/core/git.ts");
    expect(out).toContain("usestate");
    expect(out).toContain("src/core/git.ts");
    expect(out).not.toContain("git.t ");
  });

  it("drops stopwords", () => {
    expect(lemmatize("the and of a")).toBe("");
  });
});

describe("extractEntities", () => {
  it("finds the literal strings a codebase is made of", () => {
    const e = extractEntities(
      "AgentBase in src/adapters/base.ts threw EADDRINUSE — see #42 and `npm run build`.",
    );
    expect(e).toContain("AgentBase");
    expect(e).toContain("src/adapters/base.ts");
    expect(e).toContain("EADDRINUSE");
    expect(e).toContain("#42");
    expect(e).toContain("npm run build");
  });

  it("does not invent entities out of prose", () => {
    // The precision channel has to stay precise: junk here poisons retrieval.
    expect(extractEntities("we should probably fix that soon")).toEqual([]);
  });

  it("strips trailing punctuation off a path", () => {
    expect(extractEntities("look at src/core/git.ts.")).toContain("src/core/git.ts");
  });
});

describe("queryEntities", () => {
  it("adds a file's basename so a bare filename still matches", () => {
    expect(queryEntities("", ["src/core/git.ts"])).toContain("git.ts");
  });
});

describe("brain · retrieval", () => {
  const corpus = [
    { kind: "constraint" as const, text: "A raw backtick in src/daemon/app-page.ts closes the template literal." },
    { kind: "failure" as const, text: "Probing the Antigravity Manager wasted hours — the IDE is a different app." },
    { kind: "convention" as const, text: "Tests live in test/ and run under vitest." },
    { kind: "fact" as const, text: "The daemon listens on port 7420." },
    { kind: "fact" as const, text: "src/core/git.ts refuses paths outside the project." },
    { kind: "decision" as const, text: "Chose CDP over an extension because Antigravity ships no API." },
  ];

  async function seeded(): Promise<Brain> {
    const { brain: b } = await brain();
    for (const c of corpus) b.add({ ...c, provenance: by() });
    return b;
  }

  it("finds a memory by a word in it", async () => {
    const hits = retrieve(await seeded(), { query: "what port does the daemon use?" });
    expect(hits[0].memory.text).toContain("7420");
  });

  it("finds a memory by an exact file path, with no overlapping words", async () => {
    // The entity channel doing work BM25 can't: the query shares no ordinary
    // vocabulary with the memory at all.
    const hits = retrieve(await seeded(), { query: "", files: ["src/core/git.ts"] });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].memory.text).toContain("refuses paths outside");
  });

  /**
   * The reason this isn't mem0's design.
   *
   * mem0 builds candidates from the dense hits only, so a perfect keyword match
   * that the other channel missed is unreachable at any score. Here the two
   * channels union: a memory found by BM25 alone and a memory found by entities
   * alone must BOTH come back.
   */
  it("unions the two channels instead of letting one gate the other", async () => {
    const hits = retrieve(await seeded(), {
      query: "vitest", // lexical only — no entity in the query
      files: ["src/core/git.ts"], // entity only — the word never appears
    });
    const texts = hits.map((h) => h.memory.text);
    expect(texts.some((t) => t.includes("vitest")), "the BM25-only hit").toBe(true);
    expect(texts.some((t) => t.includes("refuses paths outside")), "the entity-only hit").toBe(true);
  });

  it("returns nothing rather than everything when nothing matches", async () => {
    expect(retrieve(await seeded(), { query: "kubernetes helm chart" })).toEqual([]);
  });

  it("breaks a tie toward the memory that prevents damage", async () => {
    const { brain: b } = await brain();
    b.add({ kind: "fact", text: "The widget uses a template literal.", provenance: by() });
    b.add({ kind: "constraint", text: "The widget uses a template literal.".replace("uses", "requires"), provenance: by() });
    const hits = retrieve(b, { query: "template literal widget", explain: true });
    // Near-identical text, so the kind bias is what's left to separate them.
    expect(hits[0].memory.kind).toBe("constraint");
  });

  it("never returns an expired memory", async () => {
    const { brain: b } = await brain();
    b.add({ kind: "task", text: "Ship the daemon on port 7420.", provenance: by(), expiresAt: Date.now() - 1 });
    expect(retrieve(b, { query: "7420 daemon" })).toEqual([]);
  });

  it("honours the confidence floor", async () => {
    const { brain: b } = await brain();
    b.add({ kind: "fact", text: "The daemon listens on 7420.", provenance: by(), confidence: 0.3 });
    expect(retrieve(b, { query: "daemon 7420" })).toHaveLength(1);
    expect(retrieve(b, { query: "daemon 7420", minConfidence: CONFIDENCE_FLOOR })).toHaveLength(0);
  });

  it("keeps a scoped memory out of another chat", async () => {
    const { brain: b } = await brain();
    b.add({ kind: "fact", text: "The daemon listens on 7420.", provenance: by(), scope: { chat: "c1" } });
    expect(retrieve(b, { query: "daemon", chat: "c1" })).toHaveLength(1);
    expect(retrieve(b, { query: "daemon", chat: "c2" })).toHaveLength(0);
  });

  it("respects the limit", async () => {
    expect(retrieve(await seeded(), { query: "the daemon app antigravity test", limit: 2 })).toHaveLength(2);
  });

  it("scores are comparable across queries, unlike the reference's", async () => {
    // mem0's divisor changes with which channels fired anywhere in the query,
    // so the same match scores 0.9 or 0.45 depending on its neighbours. Ours is
    // fixed: an entity-only match scores the same either way.
    const b = await seeded();
    const alone = retrieve(b, { files: ["src/core/git.ts"], explain: true })[0];
    const crowded = retrieve(b, { query: "vitest tests", files: ["src/core/git.ts"], explain: true }).find(
      (h) => h.memory.text.includes("refuses paths"),
    );
    expect(crowded?.detail?.entity).toBe(alone.detail?.entity);
  });

  it("suppresses an entity that everything mentions", async () => {
    const { brain: b } = await brain();
    // 30 memories all naming the same file: it carries almost no signal, and
    // memory_count_weight should say so without anyone writing a stoplist.
    for (let i = 0; i < 30; i++) {
      b.add({ kind: "fact", text: `Fact number ${i} about src/types.ts and thing${i}.`, provenance: by() });
    }
    b.add({ kind: "fact", text: "Only this one is about src/core/rare-file.ts.", provenance: by() });
    const common = retrieve(b, { files: ["src/types.ts"], explain: true })[0];
    const rare = retrieve(b, { files: ["src/core/rare-file.ts"], explain: true })[0];
    // 1/(1+0.001·29²) = 0.54, so the crowded entity keeps about half its pull
    // while the unique one keeps all of it. The curve is gentle by design —
    // it's a nudge against common terms, not a stoplist that deletes them.
    expect(rare.detail!.entity).toBeGreaterThan(common.detail!.entity);
    expect(common.detail!.entity).toBeLessThan(rare.detail!.entity * 0.6);
  });

  it("finds a memory from a bare filename, not just the full path", async () => {
    // People say "the backtick thing in app-page.ts". They almost never type
    // src/daemon/app-page.ts — and that's exactly when they need the help.
    const hits = retrieve(await seeded(), { query: "what was the app-page.ts gotcha?" });
    expect(hits[0]?.memory.text).toContain("template literal");
  });

  it("explains itself when asked", async () => {
    const hits = retrieve(await seeded(), { query: "backtick in app-page.ts", explain: true });
    const d = hits[0].detail!;
    expect(d.bm25).toBeGreaterThan(0);
    expect(d.matchedEntities).toContain("app-page.ts");
    expect(d.final).toBeLessThanOrEqual(1);
  });

  it("is pure over a plain array — no Brain required", () => {
    expect(retrieveFrom([], { query: "anything" })).toEqual([]);
  });
});
