/**
 * The dense channel's machinery, without the model.
 *
 * The model is a 470MB optional runtime that CI doesn't have, so everything
 * around it is built to be checkable without one: the vector cache, what gets
 * re-embedded and what doesn't, and — the property that matters most — that a
 * project with no model behaves exactly like a project from before this
 * existed. A retrieval channel that can fail must fail into the old answer,
 * not into an error.
 */

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { lemmatize, type Memory, type MemoryKind } from "../src/core/brain.js";
import { DENSE_FLOOR, DENSE_WEIGHT, retrieveFrom } from "../src/core/brain-index.js";
import { MODEL_ID, SemanticIndex, type SemanticModel } from "../src/core/semantic.js";
import { tmpDir } from "./helpers.js";

let n = 0;
function mem(text: string, hash?: string, kind: MemoryKind = "fact"): Memory {
  const at = Date.now();
  return {
    id: `m${++n}`,
    kind,
    text,
    entities: [],
    scope: {},
    confidence: 0.9,
    provenance: { agentId: "t", eventId: 1, ts: at },
    createdAt: at,
    updatedAt: at,
    lemmas: lemmatize(text),
    hash: hash ?? `h-${text.length}-${text.slice(0, 6)}`,
    version: 1,
  };
}

/** A model that counts what it was asked to embed. Deterministic, tiny. */
function fakeModel(): SemanticModel & { calls: string[][] } {
  const calls: string[][] = [];
  return {
    cached: true,
    calls,
    async embed(texts: string[]) {
      calls.push(texts);
      return texts.map((t) => {
        // A unit vector that depends on the text: same text, same vector.
        const v = new Float32Array(4);
        for (let i = 0; i < t.length; i++) v[i % 4]! += t.charCodeAt(i) % 7;
        const len = Math.hypot(...v) || 1;
        return v.map((x) => x / len) as Float32Array;
      });
    },
  };
}

/** SemanticIndex with a fake model in place of the real one. */
function index(dir: string) {
  const idx = new SemanticIndex(dir);
  const model = fakeModel();
  (idx as unknown as { model: SemanticModel }).model = model;
  return { idx, model };
}

describe("the vector cache", () => {
  it("embeds each memory once, and remembers across restarts", async () => {
    const dir = tmpDir("vec");
    const memories = [mem("the daemon binds loopback"), mem("agents work in worktrees")];

    const first = index(dir);
    expect(await first.idx.sync(memories)).toBe(2);
    expect(await first.idx.sync(memories)).toBe(0); // nothing new to do
    expect(first.model.calls).toHaveLength(1);
    expect(fs.existsSync(path.join(dir, "vectors.json"))).toBe(true);

    // A new daemon, same project: the vectors are read back, not remade.
    const second = index(dir);
    expect(await second.idx.sync(memories)).toBe(0);
    expect(second.model.calls).toHaveLength(0);
    expect(second.idx.byId(memories).size).toBe(2);
  });

  it("re-embeds a memory whose text changed, and only that one", async () => {
    const dir = tmpDir("vec-edit");
    const a = mem("the daemon binds loopback", "hash-a");
    const b = mem("agents work in worktrees", "hash-b");
    const { idx, model } = index(dir);
    await idx.sync([a, b]);

    const edited = { ...a, text: "the daemon binds loopback only", hash: "hash-a2" };
    expect(await idx.sync([edited, b])).toBe(1);
    expect(model.calls[1]).toEqual(["the daemon binds loopback only"]);
  });

  it("forgets the vectors of memories that are gone", async () => {
    const dir = tmpDir("vec-drop");
    const a = mem("one");
    const b = mem("two");
    const { idx } = index(dir);
    await idx.sync([a, b]);
    await idx.sync([a]);
    expect(idx.byId([a, b]).size).toBe(1);
    const saved = JSON.parse(fs.readFileSync(path.join(dir, "vectors.json"), "utf8"));
    expect(Object.keys(saved.vectors)).toHaveLength(1);
  });

  it("ignores a cache written by a different model", async () => {
    const dir = tmpDir("vec-other");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "vectors.json"),
      JSON.stringify({ model: "some/other-model", vectors: { "hash-a": "AAAA" } }),
    );
    const a = mem("one", "hash-a");
    const { idx } = index(dir);
    expect(await idx.sync([a])).toBe(1); // embedded again, not trusted
    const saved = JSON.parse(fs.readFileSync(path.join(dir, "vectors.json"), "utf8"));
    expect(saved.model).toBe(MODEL_ID);
  });

  it("does nothing at all without a model", async () => {
    const dir = tmpDir("vec-nomodel");
    const idx = new SemanticIndex(dir);
    expect(idx.ready()).toBe(false);
    expect(await idx.sync([mem("anything")])).toBe(0);
    expect(await idx.query("anything")).toBeNull();
    expect(fs.existsSync(path.join(dir, "vectors.json"))).toBe(false); // nothing written
  });
});

describe("the channel inside retrieval", () => {
  const corpus = [mem("the daemon binds loopback"), mem("agents work in worktrees")];
  const unit = (...xs: number[]) => {
    const v = Float32Array.from(xs);
    const len = Math.hypot(...xs) || 1;
    return v.map((x) => x / len) as Float32Array;
  };

  it("changes nothing when no vectors are passed", () => {
    const without = retrieveFrom(corpus, { query: "daemon loopback" });
    const withEmpty = retrieveFrom(corpus, {
      query: "daemon loopback",
      dense: { query: unit(1, 0), byId: new Map() },
    });
    expect(withEmpty.map((h) => h.memory.id)).toEqual(without.map((h) => h.memory.id));
    // The same number — to six places, because the two calls read the clock a
    // millisecond apart and recency decay is a function of now.
    expect(withEmpty[0]!.score).toBeCloseTo(without[0]!.score, 6);
  });

  it("makes a candidate of something no lexical channel matched", () => {
    // A query sharing no word with either memory finds nothing today…
    expect(retrieveFrom(corpus, { query: "zzz qqq" })).toEqual([]);
    // …and finds the one it points at when the vectors say so.
    const byId = new Map([
      [corpus[0]!.id, unit(1, 0)],
      [corpus[1]!.id, unit(0, 1)],
    ]);
    const hits = retrieveFrom(corpus, { query: "zzz qqq", dense: { query: unit(1, 0), byId } });
    expect(hits[0]!.memory.id).toBe(corpus[0]!.id);
    expect(hits[0]!.detail).toBeUndefined();
  });

  it("scores relative to the best hit in the query, which is why the floor is low", () => {
    // Two memories, one a much better match than the other, both above the
    // absolute floor: the better one gets the full weight.
    const byId = new Map([
      [corpus[0]!.id, unit(1, 0)],
      [corpus[1]!.id, unit(0.8, 0.6)],
    ]);
    const hits = retrieveFrom(corpus, {
      query: "zzz",
      dense: { query: unit(1, 0), byId },
      explain: true,
    });
    const top = hits.find((h) => h.memory.id === corpus[0]!.id)!;
    const second = hits.find((h) => h.memory.id === corpus[1]!.id)!;
    expect(top.detail!.dense).toBeCloseTo(DENSE_WEIGHT, 2); // best in query = full weight
    expect(second.detail!.dense).toBeCloseTo(0.8 * DENSE_WEIGHT, 2);
    expect(top.score).toBeGreaterThan(second.score);
  });

  it("leaves out what's below the floor entirely", () => {
    const byId = new Map([[corpus[0]!.id, unit(1, 0)]]);
    const barely = Math.max(0, DENSE_FLOOR - 0.05);
    const q = unit(barely, Math.sqrt(Math.max(0, 1 - barely * barely)));
    expect(retrieveFrom(corpus, { query: "zzz qqq", dense: { query: q, byId } })).toEqual([]);
  });
});
