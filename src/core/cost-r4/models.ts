import { estimateUsd, modelKey, priceBook, type PriceBook } from "../prices.js";
import { savedModelHealth, resolveModel } from "../model-routing.js";
import type { ModelStanding } from "../scoreboard.js";

export function compareModels(models: string[], standings: ModelStanding[], prices: PriceBook | null = priceBook()) {
  if (models.length < 2 || models.length > 20 || models.some(m => typeof m !== "string" || !m.trim())) throw new Error("compare needs 2–20 model IDs");
  const health = savedModelHealth();
  return models.map(id => {
    const model = resolveModel(id), price = prices?.models[modelKey(model)], row = standings.find(s => s.model === model);
    const probe = health.find(h => h.model === model);
    return { id, model, inputUsdPerMillion: price ? price.in * 1e6 : null, outputUsdPerMillion: price ? price.out * 1e6 : null,
      context: price?.context ?? null, latencyMs: probe?.latencyMs ?? null, checkedAt: probe?.checkedAt ?? null, healthy: probe?.ok ?? null,
      finishRate: row?.finishedRate ?? null, averageCostUsd: row?.avgCostUsd ?? null, turns: row?.turns ?? 0 };
  });
}
export function suggestFleet(goal: string, standings: ModelStanding[], opts: { size?: number; budget?: number } = {}, prices: PriceBook | null = priceBook()) {
  const size = opts.size ?? 3;
  if (typeof goal !== "string" || !goal.trim() || goal.length > 10_000) throw new Error("goal is required (at most 10000 characters)");
  if (!Number.isInteger(size) || size < 1 || size > 20) throw new Error("size must be an integer from 1 to 20");
  if (opts.budget !== undefined && (typeof opts.budget !== "number" || !Number.isFinite(opts.budget) || opts.budget < 0)) throw new Error("budget must be nonnegative USD");
  const candidates = standings.filter(s => s.kind && s.model !== "unknown" && s.turns > 0).map(s => {
    const listed = estimateUsd({ model: s.model, tokensIn: s.inputTokens / s.turns, tokensOut: s.outputTokens / s.turns }, prices);
    return { s, cost: s.avgCostUsd ?? listed ?? null, source: s.avgCostUsd === null ? "estimated" : "recorded" };
  }).sort((a, b) => (b.s.finishedRate ?? 0) - (a.s.finishedRate ?? 0) || (a.cost ?? Infinity) - (b.cost ?? Infinity) || a.s.key.localeCompare(b.s.key));
  let remaining = opts.budget ?? Infinity;
  const picks = [];
  for (let i = 0; i < size; i++) {
    const affordable = candidates.filter(c => opts.budget === undefined || (c.cost !== null && c.cost <= remaining / (size - i)));
    const pick = affordable[i % Math.max(1, affordable.length)];
    if (!pick) break;
    if (pick.cost !== null) remaining -= pick.cost;
    picks.push({ kind: pick.s.kind!, model: pick.s.model, spec: `${pick.s.kind}@${pick.s.model}`, estimatedUsd: pick.cost,
      reason: `${Math.round((pick.s.finishedRate ?? 0) * 100)}% finished across ${pick.s.turns} recorded turns; ${pick.cost === null ? "price unknown" : `$${pick.cost.toFixed(4)} ${pick.source} per turn`}.` });
  }
  return { goal: goal.trim(), size, budgetUsd: opts.budget ?? null, picks, spec: picks.map(p => p.spec).join(","),
    estimatedUsd: picks.some(p => p.estimatedUsd === null) ? null : picks.reduce((n, p) => n + (p.estimatedUsd ?? 0), 0),
    note: picks.length < size ? "Insufficient recorded evidence within this budget; no unobserved models were invented." : "Based on recorded finish rate and per-turn cost; a task may require multiple turns." };
}
