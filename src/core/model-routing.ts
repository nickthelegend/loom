import fs from "node:fs";
import path from "node:path";
import { loomHome, listProjects, readProjectConfig } from "./registry.js";
import { EventLog } from "./eventlog.js";
import { estimateUsd, priceBook } from "./prices.js";
import { chatUrl, explainStatus, requestHeaders, resolveProvider } from "./providers.js";

import { readModelRouting, resolveModel } from "./model-routing-settings.js";
export * from "./model-routing-settings.js";

export function promptEstimate(model: string, text: string, contextTokens = 0, outputTokens = 1024) {
  model = resolveModel(model);
  const inputTokens = Math.ceil(Buffer.byteLength(text, "utf8") / 4) + contextTokens;
  return { model, inputTokens, outputTokens, approximate: true,
    usd: estimateUsd({ model, tokensIn: inputTokens, tokensOut: outputTokens }, priceBook()) ?? null };
}

interface AuxiliaryUsage { day: number; models: Record<string, { tokens: number; usd: number }> }
function auxiliaryUsage(): AuxiliaryUsage {
  try { return JSON.parse(fs.readFileSync(path.join(loomHome(), "model-auxiliary-usage.json"), "utf8")) as AuxiliaryUsage; }
  catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    return { day: 0, models: {} };
  }
}

/** Health probes and helper completions have no project turn event to account for them. */
export function recordModelUsage(model: string, usage?: { prompt_tokens?: number; completion_tokens?: number }, costUsd?: number): void {
  const tokensIn = Math.max(0, Number(usage?.prompt_tokens) || 0), tokensOut = Math.max(0, Number(usage?.completion_tokens) || 0);
  if (!tokensIn && !tokensOut && !costUsd) return;
  model = resolveModel(model);
  const day = Math.floor(Date.now() / 86_400_000), old = auxiliaryUsage();
  const ledger: AuxiliaryUsage = old.day === day ? old : { day, models: {} };
  const had = Object.hasOwn(ledger.models, model) ? ledger.models[model]! : { tokens: 0, usd: 0 };
  Object.defineProperty(ledger.models, model, { enumerable: true, configurable: true, writable: true,
    value: { tokens: had.tokens + tokensIn + tokensOut, usd: had.usd + (costUsd ?? estimateUsd({ model, tokensIn, tokensOut }, priceBook()) ?? 0) } });
  fs.mkdirSync(loomHome(), { recursive: true });
  const file = path.join(loomHome(), "model-auxiliary-usage.json");
  fs.writeFileSync(file + ".tmp", JSON.stringify(ledger));
  fs.renameSync(file + ".tmp", file);
}

export async function modelUsage(model: string, now = Date.now()) {
  model = resolveModel(model);
  const since = Math.floor(now / 86_400_000) * 86_400_000;
  const auxiliary = auxiliaryUsage();
  const extra = auxiliary.day === Math.floor(now / 86_400_000) && Object.hasOwn(auxiliary.models, model) ? auxiliary.models[model] : undefined;
  let tokens = extra?.tokens ?? 0, usd = extra?.usd ?? 0;
  for (const project of listProjects()) {
    const log = await EventLog.open(path.join(project.dir, ".loom"));
    try {
      for (const e of log.list({ sinceTs: since, allBranches: true })) {
        if (e.ts > now || !(e.kind === "run_complete" || e.kind === "error" || (e.kind === "status" && e.payload.state === "interrupted"))) continue;
        const p = e.payload;
        if (typeof p.model !== "string") continue;
        const reported = resolveModel(p.model);
        if (reported !== model && (typeof p.provider !== "string" || `${p.provider}/${reported}` !== model)) continue;
        const num = (n: unknown) => typeof n === "number" && Number.isFinite(n) && n > 0 ? n : 0;
        const tokensIn = num(p.inputTokens), tokensOut = num(p.outputTokens);
        tokens += tokensIn + tokensOut;
        usd += typeof p.costUsd === "number" ? num(p.costUsd) : estimateUsd({ model, tokensIn, tokensOut, cachedIn: num(p.cachedInputTokens) }, priceBook()) ?? 0;
      }
    } finally { log.close(); }
  }
  const caps = readModelRouting().caps;
  const cap = Object.hasOwn(caps, model) ? caps[model] : undefined;
  const fraction = Math.max(cap?.tokens ? tokens / cap.tokens : 0, cap?.usd ? usd / cap.usd : 0);
  return { model, tokens, usd, cap: cap ?? null, warning: fraction >= 0.8, stopped: fraction >= 1, resetsAt: since + 86_400_000 };
}
/** Uncapped models must not insert an asynchronous gap before dispatch takes ownership. */
export function enforceModelCap(model?: string | null): Promise<void> | undefined {
  if (!model || !readModelRouting().caps[resolveModel(model)]) return;
  return modelUsage(model).then(usage => {
    if (usage.stopped) throw new Error(`daily model cap reached for ${usage.model}; resets at ${new Date(usage.resetsAt).toISOString()}`);
  });
}

export interface ModelHealth { model: string; latencyMs: number; checkedAt: number; ok: boolean; lastError: string | null }
export async function probeModel(model: string): Promise<ModelHealth> {
  model = resolveModel(model);
  const started = Date.now();
  try {
    const slash = model.indexOf("/");
    const provider = slash > 0 ? resolveProvider(model.slice(0, slash)) : null;
    const p = provider ?? resolveProvider("openrouter");
    if (!p) throw new Error("no configured provider for this model");
    if (!p.key && p.id !== "ollama") throw new Error(`no API key configured for ${p.id}`);
    await enforceModelCap(model);
    const id = provider ? model.slice(slash + 1) : model;
    const result = await fetch(chatUrl(p), { method: "POST", headers: requestHeaders(p),
      body: JSON.stringify({ model: id, messages: [{ role: "user", content: "Reply OK" }], max_tokens: 1, stream: false }),
      signal: AbortSignal.timeout(10_000) });
    if (!result.ok) throw new Error(explainStatus(result.status, await result.text(), p));
    const body = await result.json() as { usage?: { prompt_tokens?: number; completion_tokens?: number } };
    recordModelUsage(model, body.usage);
    return { model, latencyMs: Date.now() - started, checkedAt: Date.now(), ok: true, lastError: null };
  } catch (err) { return { model, latencyMs: Date.now() - started, checkedAt: Date.now(), ok: false, lastError: (err as Error).message }; }
}
export function configuredModels(): string[] {
  const settings = readModelRouting();
  const models = [...Object.values(settings.aliases), ...Object.keys(settings.caps)];
  for (const p of listProjects()) for (const a of readProjectConfig(p.dir)?.agents ?? []) {
    if (typeof a.options?.model === "string") models.push(a.options.model);
    if (Array.isArray(a.options?.fallbacks)) models.push(...a.options.fallbacks.filter((m): m is string => typeof m === "string"));
  }
  return [...new Set(models.map(m => resolveModel(m)))].sort();
}
export async function modelHealth(): Promise<ModelHealth[]> {
  const models = configuredModels(), rows: ModelHealth[] = [];
  for (let i = 0; i < models.length; i += 4) rows.push(...await Promise.all(models.slice(i, i + 4).map(probeModel)));
  fs.mkdirSync(loomHome(), { recursive: true });
  fs.writeFileSync(path.join(loomHome(), "model-health.json"), JSON.stringify(rows));
  return rows;
}
export function savedModelHealth(): ModelHealth[] {
  try { return JSON.parse(fs.readFileSync(path.join(loomHome(), "model-health.json"), "utf8")) as ModelHealth[]; }
  catch { return []; }
}
