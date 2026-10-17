/**
 * Cost estimates for agents that report tokens but no price (Codex on a
 * ChatGPT sign-in, Grok): their tokens at the model's API price, labelled
 * est. and kept apart from the money that was actually reported.
 */

import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { estimateUsd, modelKey, priceBook, priceBookFrom, refreshPrices, setPriceBook } from "../src/core/prices.js";
import { writeProjectConfig } from "../src/core/registry.js";
import { usageReport } from "../src/core/usage.js";
import { ProjectRuntime } from "../src/daemon/runtime.js";
import type { LoomEvent } from "../src/types.js";
import { tmpDir } from "./helpers.js";

const LIST = [
  { id: "openai/gpt-6.1-sol", pricing: { prompt: "0.000002", completion: "0.00001", input_cache_read: "0.0000002" } },
  { id: "x-ai/grok-code-fast-2", pricing: { prompt: "0.0000002", completion: "0.0000015" } },
  { id: "x-ai/grok-code-fast-2:free", pricing: { prompt: "0", completion: "0" } },
  { id: "openrouter/auto", pricing: { prompt: "-1", completion: "-1" } },
];

let id = 0;
const ev = (kind: string, payload: Record<string, unknown>, agentId?: string): LoomEvent =>
  ({ id: ++id, ts: Date.now(), kind, payload, chat: "main", ...(agentId ? { agentId } : {}) }) as LoomEvent;

beforeAll(() => { process.env.LOOM_HOME = tmpDir("home-prices"); });
afterEach(() => setPriceBook(undefined));

describe("the price book", () => {
  it("knows a model however it's spelled", () => {
    expect(modelKey("openai/gpt-6.1-sol")).toBe("gpt-6-1-sol");
    expect(modelKey("gpt-6.1-sol")).toBe("gpt-6-1-sol");
    expect(modelKey("anthropic/claude-opus-4.5")).toBe(modelKey("claude-opus-4-5-20251101"));
    expect(modelKey("x-ai/grok-code-fast-2:free")).toBe("grok-code-fast-2");
  });

  it("a free variant doesn't hide the paid price; 'varies' isn't a price", () => {
    const book = priceBookFrom(LIST);
    expect(book.models["grok-code-fast-2"]).toEqual({ in: 0.0000002, out: 0.0000015 });
    expect(book.models["auto"]).toBeUndefined();
  });

  it("prices cached input at the cache price, and says nothing for a model it doesn't know", () => {
    const book = priceBookFrom(LIST);
    // codex's real turn: 240,130 in (198,144 of it cached), 3,613 out
    const est = estimateUsd({ model: "gpt-6.1-sol", tokensIn: 240_130, cachedIn: 198_144, tokensOut: 3_613 }, book)!;
    expect(est).toBeCloseTo(41_986 * 0.000002 + 198_144 * 0.0000002 + 3_613 * 0.00001, 9);
    expect(estimateUsd({ model: "gemini-9", tokensIn: 10, tokensOut: 10 }, book)).toBeUndefined();
    expect(estimateUsd({ model: "gpt-6.1-sol", tokensIn: 10, tokensOut: 10 }, null)).toBeUndefined();
  });

  it("fetches the public list, saves it, and keeps the old book when the fetch fails", async () => {
    const ok = (async () => new Response(JSON.stringify({ data: LIST }))) as unknown as typeof fetch;
    const book = await refreshPrices(ok);
    expect(book!.models["gpt-6-1-sol"]).toBeTruthy();
    expect(fs.existsSync(path.join(process.env.LOOM_HOME!, "prices.json"))).toBe(true);
    const down = (async () => { throw new Error("offline"); }) as unknown as typeof fetch;
    expect(await refreshPrices(down)).toBe(book);
    setPriceBook(undefined); // a fresh process reads it from disk, without fetching (LOOM_NO_PRICE_FETCH)
    expect(priceBook()!.models["gpt-6-1-sol"]).toEqual(book!.models["gpt-6-1-sol"]);
  });
});

describe("estimates in the usage report", () => {
  it("unpriced turns get est., priced ones don't, and usd stays what was reported", () => {
    const r = usageReport([
      ev("status", { state: "turn_cost", costUsd: 0.4 }, "claude"),
      ev("run_complete", { costUsd: 0.4, model: "claude-opus-5-5", inputTokens: 1000, outputTokens: 200 }, "claude"),
      ev("run_complete", { model: "gpt-6.1-sol", inputTokens: 1_000_000, outputTokens: 10_000 }, "codex"),
      ev("run_complete", { model: "gemini-9", inputTokens: 500, outputTokens: 50 }, "agy"),
    ], { prices: priceBookFrom(LIST) });
    expect(r.totals.usd).toBeCloseTo(0.4);
    expect(r.totals.estUsd).toBeCloseTo(2.1);
    expect(r.byAgent.find((a) => a.agentId === "codex")).toMatchObject({ usd: 0, unpriced: 1 });
    expect(r.byAgent.find((a) => a.agentId === "codex")!.estUsd).toBeCloseTo(2.1);
    expect(r.byAgent.find((a) => a.agentId === "claude")!.estUsd).toBe(0);
    expect(r.byAgent.find((a) => a.agentId === "agy")).toMatchObject({ unpriced: 1, estUsd: 0 }); // no price for it: no figure
  });
});

describe("loom costs", () => {
  let rt: ProjectRuntime | undefined;
  afterEach(async () => { await rt?.close(); rt = undefined; });

  it("shows an estimate beside an agent that reported tokens and no cost — kept out of the total and the budget", async () => {
    const dir = tmpDir("prices-rt");
    writeProjectConfig(dir, { name: "p", agents: [{ id: "echo", kind: "echo" }], brain: { extractor: "off" } });
    rt = await ProjectRuntime.open({ id: `prices-${path.basename(dir)}`, name: "p", dir });
    rt.log.append({ kind: "run_complete", agentId: "codex", payload: { model: "gpt-6.1-sol", inputTokens: 1_000_000, outputTokens: 10_000 } });
    rt.log.append({ kind: "status", agentId: "claude", payload: { state: "turn_cost", costUsd: 0.25 } });
    rt.log.append({ kind: "run_complete", agentId: "claude", payload: { model: "claude-opus-5-5", costUsd: 0.25, inputTokens: 900, outputTokens: 90 } });
    await rt.close();
    rt = await ProjectRuntime.open({ id: `prices-${path.basename(dir)}`, name: "p", dir }); // from the log, as after a restart

    setPriceBook(null);
    expect(rt.costSummary().estUsd).toBeUndefined(); // no price list: no guess
    setPriceBook(priceBookFrom(LIST));
    const c = rt.costSummary();
    expect(c.totalUsd).toBeCloseTo(0.25);
    expect(c.estUsd).toBeCloseTo(2.1);
    expect(c.byAgent.find((a) => a.agentId === "codex")!.estUsd).toBeCloseTo(2.1);
    expect(c.byAgent.find((a) => a.agentId === "claude")!.estUsd).toBeUndefined();
  });
});
