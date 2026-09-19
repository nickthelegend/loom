/**
 * Phase 3 building blocks: canon in AGENTS.md (D44, D46), tiered retrieval and
 * aging (D42, D16), untrusted detection (D43), the dedupe HMAC (D41), and the
 * hub's team-memory rules (D40, D41, D47, D50).
 */

import { describe, expect, it } from "vitest";

import type { Memory } from "../src/core/brain.js";
import { memoryHash } from "../src/core/brain.js";
import { readExternalContent } from "../src/core/brain-extract.js";
import { findSection, handEntryId, parseCanon, upsertCanon, withClaudeImport, withoutCanon } from "../src/core/team-canon.js";
import { memoryHmac, newTeamKey, sealForTeam } from "../src/core/team-crypto.js";
import { MemoryHub } from "../src/core/team-hub.js";
import { AGE_OUT_MS, compileTieredBrief, retrieveTiered, type TieredMemory } from "../src/core/team-memory.js";

describe("canon in AGENTS.md (D44, D46)", () => {
  const human = "# Agents guide\n\nRun `npm test` before pushing.\n";

  it("appends a managed section without touching what humans wrote, and round-trips", () => {
    const doc = upsertCanon(human, [
      { id: "m1", kind: "constraint", text: "Session cookies must be SameSite=Lax because of the OAuth redirect." },
      { id: "m2", kind: "decision", text: "We use zod for validation." },
    ]);
    expect(doc.startsWith(human.trimEnd())).toBe(true);
    expect(parseCanon(doc)).toEqual([
      { id: "m1", kind: "constraint", text: "Session cookies must be SameSite=Lax because of the OAuth redirect." },
      { id: "m2", kind: "decision", text: "We use zod for validation." },
    ]);
    // replacing keeps one section
    const again = upsertCanon(doc, [{ id: "m2", kind: "decision", text: "We use zod for validation." }]);
    expect(again.match(/loom:canon —/g)).toHaveLength(1);
    expect(parseCanon(again).map((e) => e.id)).toEqual(["m2"]);
  });

  it("honours hand edits: a line without a marker is canon with a stable id", () => {
    const doc = upsertCanon(human, [{ id: "m1", kind: "decision", text: "A" }]).replace(
      "- A <!-- loom:m:m1 -->",
      "- A <!-- loom:m:m1 -->\n- Deploys happen on Tuesdays.",
    );
    const entries = parseCanon(doc);
    expect(entries[1]).toEqual({ id: handEntryId("Deploys happen on Tuesdays."), kind: "decision", text: "Deploys happen on Tuesdays." });
  });

  it("the native import never sees the section (no feedback loop)", () => {
    const doc = upsertCanon(human, [{ id: "m1", kind: "fact", text: "X" }]);
    expect(findSection(doc)).toBeTruthy();
    expect(withoutCanon(doc)).toBe(human.trim());
  });

  it("adds @AGENTS.md to CLAUDE.md once", () => {
    const next = withClaudeImport("# Claude\n\nBe terse.\n")!;
    expect(next).toMatch(/\n@AGENTS\.md\n$/);
    expect(withClaudeImport(next)).toBeNull();
  });
});

function mem(id: string, text: string, tier: TieredMemory["tier"], extra: Partial<TieredMemory> = {}): TieredMemory {
  const now = Date.now();
  return {
    id, text, tier, kind: "decision", entities: [], scope: {}, provenance: { agentId: "a", eventId: 0, ts: now },
    confidence: 1, lemmas: text.toLowerCase(), hash: memoryHash(text), createdAt: now, updatedAt: now, ...extra,
  } as TieredMemory;
}

describe("tiered retrieval (D42, D16)", () => {
  it("ranks canon first and labels every tier in the brief", () => {
    const pool = [
      mem("p", "validation uses valibot for schemas", "proposed", { author: "bob" }),
      mem("o", "validation errors are shown inline", "own"),
      mem("c", "validation uses zod everywhere", "canon"),
      mem("f", "validation must run on the server too", "confirmed", { confirmedBy: ["alice", "bob", "carol"] }),
    ];
    const hits = retrieveTiered(pool, { query: "validation", limit: 4 });
    expect(hits[0]!.memory.id).toBe("c");
    const brief = compileTieredBrief(hits);
    expect(brief).toContain("validation uses zod everywhere  _(team canon)_");
    expect(brief).toContain("_(confirmed by 3 teammates)_");
    expect(brief).toContain("_(proposed by bob — not yet confirmed)_");
  });

  it("ages out failures and facts after ~90 days, never decisions or canon", () => {
    const old = Date.now() - AGE_OUT_MS - 1000;
    const pool = [
      mem("f1", "the build failed on node 20", "own", { kind: "failure", updatedAt: old }),
      mem("d1", "the build targets node 22", "own", { kind: "decision", updatedAt: old }),
      mem("c1", "the build uses node 22 in CI", "canon", { kind: "fact", updatedAt: old }),
    ];
    expect(retrieveTiered(pool, { query: "build node", limit: 5 }).map((h) => h.memory.id).sort()).toEqual(["c1", "d1"]);
  });
});

describe("untrusted detection (D43)", () => {
  it("flags turns that read the web or GitHub issue/PR text, not local work", () => {
    expect(readExternalContent([{ kind: "tool_call", payload: { tool: "WebFetch", input: { url: "https://evil.example" } } }])).toBe(true);
    expect(readExternalContent([{ kind: "tool_call", payload: { tool: "Bash", command: "gh issue view 12" } }])).toBe(true);
    expect(readExternalContent([{ kind: "tool_call", payload: { tool: "Bash", command: "npm test" } }])).toBe(false);
    expect(readExternalContent([{ kind: "tool_call", payload: { tool: "Bash", command: "curl http://localhost:3000/health" } }])).toBe(true);
    expect(readExternalContent([{ kind: "message", payload: { text: "see https://x.y" } }])).toBe(false);
  });
});

describe("memory HMAC (D41)", () => {
  it("matches on normalized text under one key, differs across keys", () => {
    const k = newTeamKey(1);
    expect(memoryHmac(k, "Use  Zod ")).toBe(memoryHmac(k, "use zod"));
    expect(memoryHmac(k, "use zod")).not.toBe(memoryHmac(newTeamKey(1), "use zod"));
    expect(memoryHmac(k, "x").startsWith("v1:")).toBe(true);
  });
});

describe("hub team memories (D40, D41, D47, D50)", () => {
  async function setup() {
    const hub = new MemoryHub();
    const a = hub.client(hub.signIn("alice").token);
    const b = hub.client(hub.signIn("bob").token);
    const team = await a.createTeam("acme");
    await b.redeemInvite((await a.createInvite(team.id)).invite);
    await a.shareRepo(team.id, "acme/app");
    const da = await a.registerDevice({ label: "a", sealPub: "s", signPub: "pa" });
    const db = await b.registerDevice({ label: "b", sealPub: "s", signPub: "pb" });
    const key = newTeamKey(1);
    const m = (id: string, text: string, dev: string, extra: Record<string, string> = {}) => ({
      id, repo: "acme/app", hmac: memoryHmac(key, text), sealed: sealForTeam(key, { text }), deviceId: dev, ...extra,
    });
    return { a, b, team, da, db, m };
  }

  it("an identical memory from a teammate becomes a confirmation", async () => {
    const { a, b, team, da, db, m } = await setup();
    await a.publishMemory(team.id, m("mem1", "Use zod for validation.", da.id));
    const again = await b.publishMemory(team.id, m("mem9", "use  zod for validation.", db.id));
    expect(again.merged).toBe(true);
    expect(again.memory.id).toBe("mem1");
    expect(again.memory.confirmedBy).toEqual(["alice", "bob"]);
    expect(await a.teamMemories(team.id, "acme/app")).toHaveLength(1);
  });

  it("only the author edits or forgets; a teammate supersedes, and resolution keeps the loser", async () => {
    const { a, b, team, da, db, m } = await setup();
    await a.publishMemory(team.id, m("mem1", "Use zod.", da.id));
    await expect(b.updateTeamMemory(team.id, "mem1", { hmac: "x", sealed: { v: 1, c: "y" } })).rejects.toThrow(/only its author/);
    await expect(b.forgetTeamMemory(team.id, "mem1", "no")).rejects.toThrow(/only its author/);
    await b.publishMemory(team.id, m("mem2", "Use valibot, not zod.", db.id, { supersedes: "mem1" }));
    expect((await a.teamMemories(team.id, "acme/app")).map((x) => x.id).sort()).toEqual(["mem1", "mem2"]); // both live until resolved
    await a.resolveMemories(team.id, "mem2", "mem1", "we moved to valibot");
    const live = await a.teamMemories(team.id, "acme/app");
    expect(live.map((x) => x.id)).toEqual(["mem2"]);
    expect(live[0]!.confirmedBy.sort()).toEqual(["alice", "bob"]); // the winner inherits the loser's confirmations
    const hist = await a.teamMemories(team.id, "acme/app", { history: true });
    expect(hist.find((x) => x.id === "mem1")).toMatchObject({ state: "superseded", supersededBy: "mem2", resolvedBy: "alice" });
    expect((await a.feed(team.id)).at(-1)).toMatchObject({ type: "memory_resolved", meta: { winner: "mem2", loser: "mem1" } });
  });

  it("refuses unshared repos, foreign ids, and superseding what doesn't exist", async () => {
    const { a, b, team, da, db, m } = await setup();
    await expect(a.publishMemory(team.id, { ...m("mem1", "x", da.id), repo: "acme/other" })).rejects.toThrow(/isn't shared/);
    await a.publishMemory(team.id, m("mem1", "x", da.id));
    await expect(b.publishMemory(team.id, m("mem1", "y", db.id))).rejects.toThrow(/belongs to someone else/);
    await expect(b.publishMemory(team.id, m("mem3", "z", db.id, { supersedes: "nope" }))).rejects.toThrow(/to supersede/);
  });
});

// keep the Memory import used for type-checking the helper above
export type _M = Memory;
