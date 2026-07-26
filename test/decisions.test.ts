/**
 * Decision capture: LLM extraction (stubbed), the CLI extractor (driven with an
 * injected fake, so no CLI is spawned and no tokens are spent), the regex
 * fallback, and the stats rollup — all asserted without a live model.
 *
 * The load-bearing assertions here are the honesty ones: a heuristic decision
 * carries NO confidence, `source` says which extractor produced it, and the
 * turn's tokens/cost are named as the turn's rather than each decision's.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { decisionStats, extractDecisions, extractDecisionsRegex, normalizeStoredDecision, parseDecisionsJson, unwrapCliOutput, type AgentDecision } from "../src/observability/decisions.js";

beforeEach(() => {
  // vitest.config.ts disables the CLI extractor suite-wide so nothing spawns a
  // real agent. These tests want that code path — with an injected fake CLI —
  // so they opt back in and never reach a binary either way.
  vi.stubEnv("LOOM_DECISIONS_NO_CLI", "");
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const baseOpts = {
  agentId: "codex", agentRole: "builder", projectId: "p", chatId: "main",
  turnIndex: 3, traceId: "t", turnTokensUsed: 1200, turnCostUsd: 0.02, durationMs: 4000, filesChanged: [] as string[],
  // No shell-outs from the unit tests unless a case asks for one explicitly.
  cliExtractor: async () => null,
};

const DOC = (decisions: unknown[]): string => JSON.stringify({ decisions });

describe("parseDecisionsJson", () => {
  it("parses a fenced JSON reply and normalizes fields", () => {
    const raw = "```json\n" + DOC([{ category: "architecture", title: "Event-sourced log", reasoning: "durable + auditable", confidence: 95, alternatives: ["PostgreSQL"], filesCreated: ["src/log.ts"], filesModified: [], artifactNames: ["EventLog"] }]) + "\n```";
    const out = parseDecisionsJson(raw);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ category: "architecture", title: "Event-sourced log", confidence: 95, alternatives: ["PostgreSQL"] });
  });
  it("clamps confidence and defaults an unknown category to other", () => {
    const out = parseDecisionsJson(DOC([{ category: "wat", title: "x", reasoning: "y", confidence: 250 }]));
    expect(out[0]).toMatchObject({ category: "other", confidence: 100 });
  });
  /**
   * The model was told to omit `confidence` when the turn gives it nothing to
   * judge. Omitted must stay omitted: substituting a default here is exactly
   * the fabrication this module is supposed to have stopped doing.
   */
  it("leaves confidence absent when the model didn't report one", () => {
    const out = parseDecisionsJson(DOC([{ category: "fix", title: "x", reasoning: "y" }]));
    expect(out[0]!.confidence).toBeUndefined();
  });
  it("returns [] on junk", () => {
    expect(parseDecisionsJson("not json")).toEqual([]);
    expect(parseDecisionsJson("")).toEqual([]);
  });
});

describe("unwrapCliOutput", () => {
  it("pulls the completion out of the claude CLI's JSON wrapper", () => {
    expect(unwrapCliOutput(JSON.stringify({ result: '{"decisions":[]}' }))).toBe('{"decisions":[]}');
  });
  it("passes agy's bare JSON straight through", () => {
    const doc = DOC([{ category: "fix", title: "t", reasoning: "r" }]);
    expect(unwrapCliOutput(doc)).toBe(doc);
  });
  it("returns nothing for an errored run or an empty one", () => {
    expect(unwrapCliOutput(JSON.stringify({ is_error: true, result: "boom" }))).toBe("");
    expect(unwrapCliOutput(null)).toBe("");
    expect(unwrapCliOutput("  ")).toBe("");
  });
});

describe("extractDecisionsRegex", () => {
  it("extracts an 'instead of X, I'll Y' decision with the alternative", () => {
    const out = extractDecisionsRegex("Instead of useState, I'll use React Query because it handles caching.");
    const withAlt = out.find((d) => d.alternatives.length);
    expect(withAlt?.alternatives).toContain("useState");
  });
  it("extracts an 'I'll use X because Y' decision", () => {
    const out = extractDecisionsRegex("I'll use SQLite because it ships with Node.");
    expect(out.some((d) => d.title.toLowerCase().includes("sqlite"))).toBe(true);
  });
  /**
   * A regex can see that a decision was stated. It cannot see how sure the
   * agent was, and the 75/78/80 it used to stamp were rendered to users as a
   * measured percentage with a progress bar.
   */
  it("reports no confidence at all — a matched sentence shape is not a measurement", () => {
    const out = extractDecisionsRegex("I'll use SQLite because it ships with Node. Instead of Redux, I'll use Zustand.");
    expect(out.length).toBeGreaterThan(0);
    expect(out.every((d) => d.confidence === undefined)).toBe(true);
  });
});

describe("extractDecisions", () => {
  it("uses the Anthropic API when a key is present and returns AgentDecisions", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      json: async () => ({ content: [{ text: DOC([
        { category: "design", title: "Purple-dark identity", reasoning: "brand", confidence: 91, alternatives: [], filesCreated: [], filesModified: [], artifactNames: [] },
        { category: "implementation", title: "React Query", reasoning: "caching", confidence: 86, alternatives: ["useState"], filesCreated: [], filesModified: [], artifactNames: [] },
      ]) }] }),
    }) as unknown as Response));
    const out = await extractDecisions({ ...baseOpts, turnText: "x".repeat(200), anthropicApiKey: "sk-ant-test" });
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ agentId: "codex", agentRole: "builder", turnIndex: 3, source: "llm", category: "design" });
    expect(out[0]!.id).toContain("p-main-t3");
  });

  /**
   * The turn's totals belong to the turn. Two decisions mined from one turn
   * each report what that ONE turn used — which is why the fields say `turn`.
   */
  it("carries the turn's tokens and cost as the turn's, on every decision it produced", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      json: async () => ({ content: [{ text: DOC([
        { category: "design", title: "A", reasoning: "r", confidence: 90 },
        { category: "fix", title: "B", reasoning: "r", confidence: 90 },
      ]) }] }),
    }) as unknown as Response));
    const out = await extractDecisions({ ...baseOpts, turnId: "4711", turnText: "x".repeat(200), anthropicApiKey: "k" });
    expect(out.map((d) => d.turnCostUsd)).toEqual([0.02, 0.02]);
    expect(out.map((d) => d.turnTokensUsed)).toEqual([1200, 1200]);
    // Same turn id on both, so a renderer can group them instead of summing.
    expect(out.map((d) => d.turnId)).toEqual(["4711", "4711"]);
    expect(out.reduce((s, d) => s + d.turnCostUsd, 0)).not.toBe(0.02); // the trap: summing these triples the turn
  });

  it("routes through a local CLI when there is no API key, and labels the source", async () => {
    const cli = vi.fn(async () => DOC([
      { category: "architecture", title: "Event log", reasoning: "auditable", confidence: 88, alternatives: ["Postgres"] },
    ]));
    const out = await extractDecisions({ ...baseOpts, cliExtractor: cli, turnText: "x".repeat(200) });
    expect(cli).toHaveBeenCalledOnce();
    expect(out[0]).toMatchObject({ source: "cli", confidence: 88, title: "Event log" });
  });

  it("falls back to regex — with NO confidence — when no extractor is available", async () => {
    const out = await extractDecisions({ ...baseOpts, turnText: "Instead of Redux, I'll use Zustand because it is lighter. " + "x".repeat(120) });
    expect(out.length).toBeGreaterThanOrEqual(1);
    expect(out.some((d) => d.alternatives.includes("Redux"))).toBe(true);
    expect(out.every((d) => d.source === "heuristic")).toBe(true);
    expect(out.every((d) => d.confidence === undefined)).toBe(true);
  });

  it("omits traceId entirely when the turn has no trace, rather than shipping an empty one", async () => {
    const { traceId: _drop, ...noTrace } = baseOpts;
    const out = await extractDecisions({ ...noTrace, turnText: "I'll use SQLite because it ships with Node. " + "x".repeat(120) });
    expect(out.length).toBeGreaterThan(0);
    expect("traceId" in out[0]!).toBe(false);
  });

  it("honours LOOM_DECISIONS_NO_CLI=1 and never shells out", async () => {
    vi.stubEnv("LOOM_DECISIONS_NO_CLI", "1");
    const cli = vi.fn(async () => DOC([{ category: "fix", title: "nope", reasoning: "r" }]));
    const out = await extractDecisions({ ...baseOpts, cliExtractor: cli, turnText: "I'll use SQLite because it ships with Node. " + "x".repeat(120) });
    expect(cli).not.toHaveBeenCalled();
    expect(out.every((d) => d.source === "heuristic")).toBe(true);
  });

  it("returns [] for a trivial turn", async () => {
    expect(await extractDecisions({ ...baseOpts, turnText: "ok, done." })).toEqual([]);
  });

  it("keeps only file claims the turn actually changed", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true, json: async () => ({ content: [{ text: DOC([
        { category: "fix", title: "Fix env", reasoning: "r", confidence: 80, alternatives: [], filesCreated: ["a.ts", "ghost.ts"], filesModified: [], artifactNames: [] },
      ]) }] }),
    }) as unknown as Response));
    const out = await extractDecisions({ ...baseOpts, turnText: "x".repeat(200), filesChanged: ["a.ts"], anthropicApiKey: "k" });
    expect(out[0]!.filesCreated).toEqual(["a.ts"]);
  });
});

describe("reading the persisted store", () => {
  /**
   * The decisions.json already on a user's disk was written by the regex on a
   * machine with no API key, so every 70/75/78/80 in it is a constant. It is
   * indistinguishable from a measured number, so it isn't shown as one.
   */
  it("drops the confidence on a record written before decisions said where they came from", () => {
    const legacy = {
      id: "i", projectId: "p", chatId: "main", agentId: "a", agentRole: "r", timestamp: 1, turnIndex: 0,
      traceId: "", category: "implementation", title: "t", reasoning: "", confidence: 78, alternatives: [],
      filesCreated: [], filesModified: [], artifactNames: [], memoryKeys: [], upstreamDecisionIds: [],
      tokensUsed: 900, costUsd: 0.05, durationMs: 10,
    } as unknown as AgentDecision;
    const out = normalizeStoredDecision(legacy);
    expect(out.confidence).toBeUndefined();
    expect(out.source).toBe("heuristic");
    // the turn totals survive under the names that say whose they are
    expect(out.turnTokensUsed).toBe(900);
    expect(out.turnCostUsd).toBe(0.05);
    // and an empty trace id was never a trace
    expect("traceId" in out).toBe(false);
  });

  it("passes a record that states its source straight through", () => {
    const modern = {
      id: "i", projectId: "p", chatId: "main", agentId: "a", agentRole: "r", timestamp: 1, turnIndex: 0,
      traceId: "abc", category: "fix", title: "t", reasoning: "", confidence: 91, source: "llm", alternatives: [],
      filesCreated: [], filesModified: [], artifactNames: [], memoryKeys: [], upstreamDecisionIds: [],
      turnTokensUsed: 5, turnCostUsd: 0.5, durationMs: 10,
    } as AgentDecision;
    expect(normalizeStoredDecision(modern)).toMatchObject({ confidence: 91, source: "llm", traceId: "abc" });
  });
});

describe("decisionStats", () => {
  const d = (o: Partial<AgentDecision>): AgentDecision => ({
    id: "i", projectId: "p", chatId: "main", agentId: "a", agentRole: "r", timestamp: 0, turnIndex: 0,
    category: "other", title: "t", reasoning: "", confidence: 80, source: "llm", alternatives: [], filesCreated: [],
    filesModified: [], artifactNames: [], memoryKeys: [], upstreamDecisionIds: [], turnTokensUsed: 0, turnCostUsd: 0,
    durationMs: 0, ...o,
  });

  it("rolls up totals, avg confidence, and the critical path", () => {
    const stats = decisionStats([
      d({ agentId: "planner", timestamp: 1, confidence: 90, category: "architecture", alternatives: ["X"] }),
      d({ agentId: "builder", timestamp: 2, confidence: 80, alternatives: ["X"] }),
      d({ agentId: "builder", timestamp: 3, confidence: 70 }),
    ]);
    expect(stats.total).toBe(3);
    expect(stats.avgConfidence).toBe(80);
    expect(stats.confidenceSamples).toBe(3);
    expect(stats.byAgent).toEqual({ planner: 1, builder: 2 });
    expect(stats.criticalPath).toEqual(["planner", "builder"]);
    expect(stats.topAlternatives).toContain("X");
  });

  /**
   * The fleet "Avg confidence" tile is the loudest consumer of this number.
   * Averaging a missing confidence as 0 would show a confident-looking 40% for
   * a fleet where half the decisions were never scored at all.
   */
  it("averages only the decisions that carry a confidence", () => {
    const stats = decisionStats([
      d({ confidence: 90 }),
      d({ confidence: undefined, source: "heuristic" }),
    ]);
    expect(stats.avgConfidence).toBe(90);
    expect(stats.confidenceSamples).toBe(1);
    expect(stats.bySource).toMatchObject({ llm: 1, heuristic: 1 });
  });

  it("reports null — not 0 — when nothing was ever scored", () => {
    const stats = decisionStats([d({ confidence: undefined, source: "heuristic" })]);
    expect(stats.avgConfidence).toBeNull();
    expect(stats.confidenceSamples).toBe(0);
  });
});
