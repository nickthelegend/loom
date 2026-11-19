import { usageReport, type UsageReport } from "../usage.js";
import { estimateUsd, modelKey, priceBook, type PriceBook } from "../prices.js";
import type { LoomEvent } from "../../types.js";

export function sinceDate(value: unknown): number {
  if (value === undefined || value === "") return 0;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}(?:T.*)?$/.test(value)) throw new Error("since must be an ISO date");
  const ts = Date.parse(value);
  if (!Number.isFinite(ts) || new Date(ts).toISOString().slice(0, 10) !== value.slice(0, 10)) throw new Error("invalid since date");
  return ts;
}
export function costReport(events: readonly LoomEvent[], since = 0, prices = priceBook()) {
  return usageReport(events, { since, prices, allChats: true });
}
export function exportCosts(report: UsageReport, by: string = "agent") {
  if (!["agent", "model", "chat", "day"].includes(by)) throw new Error("by must be agent, model, chat or day");
  const rows = { agent: report.byAgent, model: report.byModel, chat: report.byChat, day: report.byDay }[by as "agent"]!;
  return { by, since: report.since, totals: report.totals, rows };
}
export function costsCsv(report: ReturnType<typeof exportCosts>): string {
  const key = report.by === "agent" ? "agentId" : report.by;
  const keys = [key, "usd", "estUsd", "turns", "tokensIn", "tokensOut", "cachedIn", "cacheShare", "cacheSavedUsd"];
  const cell = (v: unknown) => '"' + (typeof v === "string" && /^[\s]*[=+@-]/.test(v) ? "'" : "") + String(v ?? "").replace(/"/g, '""') + '"';
  return [keys.map(cell).join(","), ...report.rows.map(r => keys.map(k => cell((r as unknown as Record<string, unknown>)[k])).join(","))].join("\r\n") + "\r\n";
}
export function whatIf(events: readonly LoomEvent[], model: string, opts: { chat?: string; since?: number } = {}, prices: PriceBook | null = priceBook()) {
  const report = costReport(events.filter(e => !opts.chat || (e.chat ?? "main") === opts.chat), opts.since ?? 0, prices);
  const t = report.totals;
  return { model, chat: opts.chat ?? null, since: opts.since ?? 0, turns: t.turns, tokensIn: t.tokensIn, tokensOut: t.tokensOut, cachedIn: t.cachedIn,
    actualUsd: t.usd, originalEstUsd: t.estUsd, estimatedUsd: estimateUsd({ ...t, model }, prices) ?? null,
    priceKnown: Boolean(prices?.models[modelKey(model)]) };
}
