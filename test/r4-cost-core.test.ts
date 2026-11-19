import fs from "node:fs";
import path from "node:path";
import { writeProjectState } from "../src/core/registry.js";
import { observeCostBudgets } from "../src/core/cost-r4/alerts.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { tmpDir, makeProjectDir } from "./helpers.js";
import { priceBook, setPriceBook, estimateUsd, priceBookFrom } from "../src/core/prices.js";
import { priceOverrides, writePriceOverrides, costSettings, updateCostSettings } from "../src/core/cost-r4/settings.js";
import { costReport, costsCsv, exportCosts, sinceDate, whatIf } from "../src/core/cost-r4/report.js";
import { compareModels, suggestFleet } from "../src/core/cost-r4/models.js";
import { modelScoreboard } from "../src/core/scoreboard.js";
import { writeModelRouting } from "../src/core/model-routing.js";
import { budgetSnapshot, budgetNotices, periodBounds } from "../src/core/cost-r4/budgets.js";
import { EventLog } from "../src/core/eventlog.js";
import type { LoomEvent } from "../src/types.js";
let id = 0;
const event = (kind: LoomEvent["kind"], payload: Record<string, unknown>, chat = "main", ts = Date.now()): LoomEvent => ({ id: ++id, kind, payload, ts, chat, agentId: "echo" });
beforeEach(() => { process.env.LOOM_HOME = tmpDir("r4-core"); process.env.LOOM_NO_PRICE_FETCH = "1"; setPriceBook(null); });

describe("r4 pricing and reports", () => {
  it("persists normalized overrides, refreshes estimates immediately, removes to unknown, and validates atomically", () => {
    expect(estimateUsd({ model: "new", tokensIn: 100, tokensOut: 20 }, priceBook())).toBeUndefined();
    writePriceOverrides({ "vendor/New": { in: 2, out: 4, cacheRead: 0.5 } });
    expect(estimateUsd({ model: "new", tokensIn: 1000000, tokensOut: 1000000, cachedIn: 500000 }, priceBook())).toBe(5.25);
    expect(() => writePriceOverrides({ new: { in: -1, out: 4 } })).toThrow();
    expect(priceOverrides().new?.in).toBe(2);
    setPriceBook(priceBookFrom([{ id: "new", context_length: 100000, pricing: { prompt: "0.00001", completion: "0.00002" } }]));
    expect(priceBook()?.models.new?.in).toBe(0.000002);
    writePriceOverrides({}); expect(priceBook()?.models.new?.in).toBe(0.00001);
    setPriceBook(null); expect(priceBook()).toBeNull();
  });
  it("counts statuses once, includes unfinished spend in every export group and exports more than 20 chats", () => {
    const events = [event("status", { state: "turn_cost", costUsd: 2, model: "a" }), event("run_complete", { costUsd: 2, model: "a", inputTokens: 100, cachedInputTokens: 150 }), ...Array.from({ length: 25 }, (_, i) => event("run_complete", { costUsd: 1, model: "a" }, `chat-${i}`)), event("status", { state: "turn_cost", costUsd: 3, model: "a" }, "unfinished")];
    const r = costReport(events);
    expect(r.totals.usd).toBe(30); expect(r.totals.cachedIn).toBe(100); expect(r.byChat).toHaveLength(27);
    for (const group of ["agent", "model", "chat", "day"]) expect(exportCosts(r, group).rows.reduce((n, v) => n + v.usd, 0)).toBe(30);
    expect(() => exportCosts(r, "bad")).toThrow();
    const csv = costsCsv(exportCosts(costReport([event("run_complete", { costUsd: 1, model: '=HYPERLINK("x")' })]), "model"));
    expect(csv).toContain("'=HYPERLINK"); expect(csv).toContain('""x""');
  });
  it("re-prices tokens including caches, keeps unavailable cache discount unknown, and filters inclusively", () => {
    writePriceOverrides({ a: { in: 2, out: 4, cacheRead: 0.5 }, b: { in: 1, out: 2 } });
    const ts = sinceDate("2026-01-01"), events = [event("run_complete", { model: "a", inputTokens: 1000000, outputTokens: 100000, cachedInputTokens: 500000, costUsd: 8 }, "x", ts), event("run_complete", { model: "b", inputTokens: 100, cachedInputTokens: 20 }, "y", ts - 1)];
    expect(costReport(events).byModel.find(m => m.model === "a")).toMatchObject({ cacheShare: 0.5, cacheSavedUsd: 0.75 });
    expect(costReport(events).byModel.find(m => m.model === "b")?.cacheSavedUsd).toBeNull();
    expect(whatIf(events, "b", { chat: "x", since: ts })).toMatchObject({ turns: 1, estimatedUsd: 1.2, actualUsd: 8 });
    expect(whatIf(events, "unknown").estimatedUsd).toBeNull();
    expect(() => sinceDate("2026-02-30")).toThrow();
  });
  it("compares observed evidence, preserves unknowns, and suggests only affordable recorded picks", () => {
    writePriceOverrides({ a: { in: 1, out: 2 } });
    const board = modelScoreboard([{ id: "p", agents: [{ id: "echo", kind: "echo", role: "general" }], runs: [], events: [event("run_complete", { model: "a", costUsd: 0.2, inputTokens: 100 }), event("error", { model: "b" })] }]);
    expect(compareModels(["a", "b"], board.byModel)[0]).toMatchObject({ inputUsdPerMillion: 1, finishRate: 1, averageCostUsd: 0.2, context: null, latencyMs: null });
    expect(compareModels(["a", "b"], board.byModel)[1]?.inputUsdPerMillion).toBeNull();
    const s = suggestFleet("review", board.byKindModel, { size: 2, budget: 0.4 });
    expect(s.picks).toHaveLength(2); expect(s.estimatedUsd).toBeCloseTo(0.4); expect(s.picks[0]?.reason).toContain("recorded");
    expect(suggestFleet("review", board.byKindModel, { size: 2, budget: 0.1 }).picks).toEqual([]);
    expect(() => suggestFleet("", board.byKindModel)).toThrow();
  });
  it("uses calendar months, projects the run rate, warns once and resets without deleting settings", async () => {
    const dir = makeProjectDir(), log = await EventLog.open(dir + "/.loom"), host = { info: { dir, id: "p", name: "p" }, log };
    try {
      const now = new Date(2026, 1, 15).getTime(), bounds = periodBounds(now);
      updateCostSettings(dir, { monthlyUsd: 10, chats: { main: 10 } });
      log.append({ kind: "run_complete", ts: bounds.month + 1, chat: "main", payload: { costUsd: 8 } });
      const s = budgetSnapshot(host, now); expect(s.monthly.warning).toBe(true); expect(s.monthly.projectedUsd).toBe(16); expect(s.monthly.stopped).toBe(false);
      budgetNotices(host, "main", now); budgetNotices(host, "main", now);
      expect(log.list({ kinds: ["status"] })).toHaveLength(2);
      expect(budgetSnapshot(host, bounds.end + 1).monthly.spentUsd).toBe(0);
      writeModelRouting({ aliases: { cheap: "a" }, caps: {}, mondayDigest: false });
      updateCostSettings(dir, { saver: { alias: "cheap", share: 0.8, period: "month" } });
      expect(budgetSnapshot(host, now).saver?.active).toBe(true);
      expect(() => updateCostSettings(dir, { saver: { alias: "nope", share: 1, period: "day" } })).toThrow();
      expect(costSettings(dir).saver?.alias).toBe("cheap");
      writeModelRouting({ aliases: {}, caps: {}, mondayDigest: false });
      expect(budgetSnapshot(host, now).saver?.active).toBe(false);
    } finally { log.close(); }
  });
});

it("existing accounting reprices unknown tokens on demand and never adds a copied completion price twice", async () => {
  const { RuntimeAccounting } = await import("../src/daemon/runtime/accounting.js");
  const dir = makeProjectDir(), log = await EventLog.open(dir + "/.loom");
  try {
    const accounting = new RuntimeAccounting({ info: { dir, id: "p", name: "p" }, log, appendIfOpen: e => { log.append(e); } });
    const track = (e: Omit<LoomEvent, "id" | "ts">) => { const saved = log.append(e); accounting.trackCost(saved); };
    track({ kind: "run_complete", agentId: "a", payload: { model: "unknown", inputTokens: 1e6, outputTokens: 0, cachedInputTokens: 500000 } });
    expect(accounting.costSummary().estUsd).toBeUndefined();
    writePriceOverrides({ unknown: { in: 2, out: 4, cacheRead: 0.5 } });
    expect(accounting.costSummary().estUsd).toBe(1.25);
    track({ kind: "status", agentId: "a", payload: { state: "turn_cost", costUsd: 2 } });
    track({ kind: "run_complete", agentId: "a", payload: { costUsd: 2 } });
    track({ kind: "run_complete", agentId: "a", payload: { costUsd: 3 } });
    expect(accounting.costSummary().totalUsd).toBe(5);
    expect(accounting.spendTodayFor("a")).toBe(5);
    expect(accounting.costSeries()[0]?.usd).toBe(5);
    expect(accounting.costSeries()[0]?.byAgent.a?.usd).toBe(5);
    writePriceOverrides({}); expect(accounting.costSummary().estUsd).toBeUndefined();
  } finally { log.close(); }
});


it("recovers partial, malformed and invalid settings and price files without blocking turns", () => {
  const dir = makeProjectDir(), file = path.join(dir, ".loom", "cost-settings.json");
  fs.writeFileSync(file, JSON.stringify({ monthlyUsd: 5 }));
  expect(costSettings(dir)).toEqual({ monthlyUsd: 5, dailyUsd: 0, chats: {}, alerts: [], saver: null });
  fs.writeFileSync(file, JSON.stringify({ monthlyUsd: -1, dailyUsd: "2", chats: { main: -1 }, alerts: ["push", "bad", null], saver: { alias: "cheap", share: 2, period: "day" } }));
  expect(costSettings(dir)).toEqual({ monthlyUsd: 0, dailyUsd: 0, chats: {}, alerts: ["push"], saver: null });
  for (const raw of ['{', 'null', '[]']) {
    fs.writeFileSync(file, raw);
    expect(costSettings(dir)).toEqual({ monthlyUsd: 0, dailyUsd: 0, chats: {}, alerts: [], saver: null });
  }
  const prices = path.join(process.env.LOOM_HOME!, "price-overrides.json");
  fs.writeFileSync(prices, '{'); expect(priceOverrides()).toEqual({}); expect(priceBook()).toBeNull();
  fs.writeFileSync(prices, JSON.stringify({ good: { in: 0, out: 2 }, bad: { in: -1, out: 2 }, text: { in: "1", out: 2 }, missing: {} }));
  expect(priceOverrides()).toEqual({ good: { in: 0, out: 2 } });
});

it("floors month projection at one day, bounds scans, caches until spend/settings/day changes", async () => {
  const dir = makeProjectDir(), log = await EventLog.open(dir + "/.loom"), host = { info: { dir, id: "p", name: "p" }, log };
  observeCostBudgets(host);
  try {
    const now = new Date(2026, 10, 1, 0, 10).getTime(), bounds = periodBounds(now);
    log.append({ kind: "run_complete", ts: bounds.month + 1, payload: { costUsd: 0.5 } });
    const list = vi.spyOn(log, "list");
    expect(budgetSnapshot(host, now).monthly.projectedUsd).toBe(15);
    expect(list).toHaveBeenLastCalledWith({ kinds: ["status", "run_complete"], sinceTs: bounds.month, allBranches: true });
    budgetSnapshot(host, now + 1); expect(list).toHaveBeenCalledTimes(1);
    log.append({ kind: "message", payload: { text: "no cost" } });
    budgetSnapshot(host, now + 2); expect(list).toHaveBeenCalledTimes(1);
    log.append({ kind: "status", ts: now, payload: { state: "turn_cost", costUsd: 0.25 } });
    expect(budgetSnapshot(host, now + 3).monthly.spentUsd).toBe(0.75); expect(list).toHaveBeenCalledTimes(2);
    updateCostSettings(dir, { monthlyUsd: 10 }); budgetSnapshot(host, now + 4); expect(list).toHaveBeenCalledTimes(3);
    budgetSnapshot(host, bounds.end + 1); expect(list).toHaveBeenCalledTimes(4);
    updateCostSettings(dir, { chats: { main: 2 } }); budgetSnapshot(host, bounds.end + 2);
    expect(list).toHaveBeenCalledTimes(6); // all-time chat scan only with a positive cap
    list.mockClear(); budgetNotices(host, "main", now); list.mockClear(); budgetNotices(host, "main", now);
    expect(list).not.toHaveBeenCalled();
  } finally { log.close(); }
});

it("replays budgeted history linearly and queries only the requested spend period", async () => {
  const { RuntimeAccounting } = await import("../src/daemon/runtime/accounting.js");
  const dir = makeProjectDir(), log = await EventLog.open(dir + "/.loom"), now = Date.now();
  try {
    writeProjectState(dir, { budgets: { a: 100, b: 100 } });
    for (let i = 0; i < 100; i++) {
      log.append({ kind: "status", ts: now - 40 * 86400000, agentId: "a", payload: { state: "turn_cost", costUsd: 1 } });
      log.append({ kind: "run_complete", ts: now - 40 * 86400000, agentId: "a", payload: { costUsd: 1 } });
    }
    log.append({ kind: "status", agentId: "a", payload: { state: "turn_cost", costUsd: 2 } });
    log.append({ kind: "run_complete", agentId: "a", payload: { costUsd: 2, inputTokens: 50 } });
    log.append({ kind: "run_complete", agentId: "b", payload: { costUsd: 3, inputTokens: 20 } });
    const accounting = new RuntimeAccounting({ info: { dir, id: "p", name: "p" }, log, appendIfOpen: e => { log.append(e); } });
    const list = vi.spyOn(log, "list");
    accounting.rehydrateCosts(); expect(list).toHaveBeenCalledTimes(3); // replay + once per budgeted agent
    list.mockClear(); expect(accounting.spendTodayFor("a")).toBe(2);
    expect(list.mock.calls[0]?.[0]?.sinceTs).toBe(periodBounds().day);
    list.mockClear(); const series = accounting.costSeries(7);
    expect(list).toHaveBeenCalledTimes(1); expect(list.mock.calls[0]?.[0]?.sinceTs).toBe(periodBounds().day - 6 * 86400000);
    expect(series).toHaveLength(1); expect(series[0]).toMatchObject({ usd: 5, turns: 2, byAgent: { a: { usd: 2, turns: 1, tokensIn: 50 }, b: { usd: 3, turns: 1, tokensIn: 20 } } });
  } finally { log.close(); }
});


it("can construct accounting with a read-only journal test double without subscribing", async () => {
  const { RuntimeAccounting } = await import("../src/daemon/runtime/accounting.js");
  const dir = makeProjectDir();
  expect(() => new RuntimeAccounting({ info: { dir, id: "p", name: "p" }, log: { list: () => [] } as any, appendIfOpen: () => {} })).not.toThrow();
});
