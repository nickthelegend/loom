/**
 * Phase 2 — the extractor.
 *
 * The LLM is the one part we can't make deterministic, so it's injected as a
 * stub engine and everything else is tested for real against a live Brain over
 * a real event log. The guard that matters most is evidence verification: a
 * memory the extractor couldn't quote from the turn must never reach the store.
 */

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { EventLog } from "../src/core/eventlog.js";
import { Brain, type MemoryProvenance } from "../src/core/brain.js";
import {
  applyExtraction,
  buildExtractionPrompt,
  evidenceInTurn,
  extractFromTurn,
  parseExtraction,
  type Candidate,
  type ExtractEngine,
} from "../src/core/brain-extract.js";
import { tmpDir } from "./helpers.js";

async function brain(): Promise<Brain> {
  const dir = path.join(tmpDir("brain-x"), ".loom");
  fs.mkdirSync(dir, { recursive: true });
  return new Brain(await EventLog.open(dir));
}
const by = (agentId = "claude-code"): MemoryProvenance => ({ agentId, eventId: 1, ts: Date.now() });

describe("evidenceInTurn", () => {
  it("matches whitespace-insensitively", () => {
    expect(evidenceInTurn("a raw backtick closes it", "note: a raw   backtick\ncloses it here")).toBe(true);
  });
  it("rejects a span that isn't in the turn — the whole hallucination guard", () => {
    expect(evidenceInTurn("antigravity ships a public API", "we drove antigravity over CDP")).toBe(false);
  });
  it("rejects a too-short span that would match by accident", () => {
    expect(evidenceInTurn("the", "the the the")).toBe(false);
  });
});

describe("buildExtractionPrompt", () => {
  it("presents candidates under integer ids, never their real uuids", async () => {
    const b = await brain();
    const { memory } = b.add({ kind: "fact", text: "The daemon listens on 7420.", provenance: by() });
    const cands: Candidate[] = [{ intId: "0", memory }];
    const prompt = buildExtractionPrompt("some turn", cands);
    expect(prompt).toContain('"0": "The daemon listens on 7420."');
    expect(prompt, "the real uuid must not leak to the model").not.toContain(memory.id);
  });
});

describe("parseExtraction", () => {
  it("reads an {ops:[...]} object", () => {
    const ops = parseExtraction('{"ops":[{"op":"ADD","text":"x","kind":"failure","evidence":"quote"}]}');
    expect(ops).toEqual([{ op: "ADD", text: "x", kind: "failure", evidence: "quote" }]);
  });
  it("reads a bare array too", () => {
    expect(parseExtraction('[{"op":"NONE"}]')).toEqual([]);
  });
  it("survives code fences and surrounding prose", () => {
    const ops = parseExtraction('Here you go:\n```json\n{"ops":[{"op":"FORGET","id":"3","reason":"stale"}]}\n```');
    expect(ops).toEqual([{ op: "FORGET", id: "3", reason: "stale" }]);
  });
  it("defaults an unknown kind to fact, and coerces the id to a string", () => {
    const ops = parseExtraction('{"ops":[{"op":"ADD","text":"y","kind":"bogus","evidence":"z"},{"op":"UPDATE","id":2,"text":"q","evidence":"e"}]}');
    expect(ops[0]).toMatchObject({ op: "ADD", kind: "fact" });
    expect(ops[1]).toMatchObject({ op: "UPDATE", id: "2" });
  });
  it("drops an ADD with no evidence — it can't clear the guard anyway", () => {
    expect(parseExtraction('{"ops":[{"op":"ADD","text":"no proof","kind":"fact"}]}')).toEqual([]);
  });
  it("returns nothing for junk rather than throwing", () => {
    expect(parseExtraction("not json at all")).toEqual([]);
    expect(parseExtraction("")).toEqual([]);
  });
});

describe("applyExtraction", () => {
  const turn = "We chose CDP over an extension because Antigravity ships no API. The daemon now listens on port 7420.";

  it("adds a memory whose evidence is really in the turn", async () => {
    const b = await brain();
    const res = applyExtraction(
      b,
      [{ op: "ADD", text: "Loom drives Antigravity over CDP because it ships no API.", kind: "decision", evidence: "Antigravity ships no API" }],
      turn,
      [],
      { by: "claude-code", eventId: 5 },
    );
    expect(res.added).toHaveLength(1);
    expect(b.all()[0].text).toContain("over CDP");
  });

  it("DROPS an add whose evidence is not in the turn", async () => {
    const b = await brain();
    const res = applyExtraction(
      b,
      [{ op: "ADD", text: "Antigravity exposes a REST API.", kind: "fact", evidence: "Antigravity exposes a REST API" }],
      turn,
      [],
      { by: "claude-code", eventId: 5 },
    );
    expect(res.added).toHaveLength(0);
    expect(res.dropped[0].reason).toMatch(/evidence not found/);
    expect(b.all(), "the hallucination never reached the store").toHaveLength(0);
  });

  it("maps an UPDATE's integer id back to the real memory", async () => {
    const b = await brain();
    const { memory } = b.add({ kind: "fact", text: "The daemon listens on 7000.", provenance: by() });
    const res = applyExtraction(
      b,
      [{ op: "UPDATE", id: "0", text: "The daemon listens on port 7420.", evidence: "listens on port 7420" }],
      turn,
      [{ intId: "0", memory }],
      { by: "user", eventId: 6 },
    );
    expect(res.updated).toHaveLength(1);
    expect(b.get(memory.id)?.text).toContain("7420");
  });

  it("drops an UPDATE/FORGET whose integer id was never a candidate", async () => {
    const b = await brain();
    const res = applyExtraction(
      b,
      [
        { op: "UPDATE", id: "9", text: "x", evidence: "the daemon now listens" },
        { op: "FORGET", id: "8", reason: "stale" },
      ],
      turn,
      [],
      { by: "x", eventId: 7 },
    );
    expect(res.updated).toHaveLength(0);
    expect(res.forgotten).toHaveLength(0);
    expect(res.dropped).toHaveLength(2);
  });

  it("forgets a candidate, and keeps its history", async () => {
    const b = await brain();
    const { memory } = b.add({ kind: "fact", text: "Antigravity ships an API.", provenance: by() });
    const res = applyExtraction(
      b,
      [{ op: "FORGET", id: "0", reason: "the turn shows it ships no API" }],
      turn,
      [{ intId: "0", memory }],
      { by: "claude-code", eventId: 8 },
    );
    expect(res.forgotten).toEqual([memory.id]);
    expect(b.get(memory.id)).toBeUndefined();
    expect(b.history(memory.id).some((h) => h.op === "forget")).toBe(true);
  });
});

describe("extractFromTurn (end to end, stub engine)", () => {
  const turn = "User: why CDP? Agent: Antigravity ships no API, so we drive it over the DevTools protocol. Also I set the daemon port to 7420 in src/daemon/server.ts.";

  it("retrieves candidates, calls the engine, and applies verified ops", async () => {
    const b = await brain();
    let sawPrompt = "";
    const engine: ExtractEngine = async (p) => {
      sawPrompt = p.user;
      return JSON.stringify({
        ops: [
          { op: "ADD", text: "Loom drives Antigravity over the DevTools protocol because it ships no API.", kind: "decision", evidence: "Antigravity ships no API" },
          { op: "ADD", text: "This one is a lie.", kind: "fact", evidence: "a span that is absent" },
        ],
      });
    };
    const res = await extractFromTurn(b, turn, { engine, agentId: "claude-code", files: ["src/daemon/server.ts"] });
    expect(res.added).toHaveLength(1); // the lie was dropped by the evidence guard
    expect(res.dropped.some((d) => /evidence not found/.test(d.reason))).toBe(true);
    expect(sawPrompt).toContain("THE TURN");
    expect(b.all()[0].text).toContain("DevTools protocol");
  });

  it("shows the extractor its own prior memory as an integer candidate to update", async () => {
    const b = await brain();
    b.add({ kind: "fact", text: "The daemon port is 7000.", provenance: by() });
    let promptSeen = "";
    const engine: ExtractEngine = async (p) => {
      promptSeen = p.user;
      return JSON.stringify({ ops: [{ op: "UPDATE", id: "0", text: "The daemon port is 7420.", evidence: "daemon port to 7420" }] });
    };
    const res = await extractFromTurn(b, turn, { engine, agentId: "claude-code" });
    expect(promptSeen).toContain('"0":'); // the candidate was offered under an int id
    expect(res.updated).toHaveLength(1);
    expect(b.all()[0].text).toContain("7420");
  });

  it("never throws when the engine dies — the turn is untouched", async () => {
    const b = await brain();
    const engine: ExtractEngine = async () => {
      throw new Error("claude not logged in");
    };
    await expect(extractFromTurn(b, turn, { engine, agentId: "x" })).resolves.toEqual({
      added: [],
      updated: [],
      forgotten: [],
      dropped: [],
    });
  });

  it("does nothing for an empty turn", async () => {
    const b = await brain();
    const engine: ExtractEngine = async () => {
      throw new Error("should not be called");
    };
    const res = await extractFromTurn(b, "   ", { engine, agentId: "x" });
    expect(res.added).toHaveLength(0);
  });
});
