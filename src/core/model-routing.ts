import fs from "node:fs";
import path from "node:path";
import { loomHome, listProjects, readProjectConfig } from "./registry.js";
import { EventLog } from "./eventlog.js";
import { estimateUsd, priceBook } from "./prices.js";
import { chatUrl, explainStatus, requestHeaders, resolveProvider } from "./providers.js";

export interface ModelCap { usd?: number; tokens?: number }
export interface ModelRouting { aliases: Record<string, string>; caps: Record<string, ModelCap>; mondayDigest: boolean }
const file = () => path.join(loomHome(), "model-routing.json");
export function readModelRouting(): ModelRouting {
  try { return { aliases: {}, caps: {}, mondayDigest: false, ...JSON.parse(fs.readFileSync(file(), "utf8")) }; }
  catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw new Error(`cannot read model routing settings: ${(err as Error).message}`);
    return { aliases: {}, caps: {}, mondayDigest: false };
  }
}
export function resolveModel(model: string, aliases = readModelRouting().aliases): string {
  const seen = new Set<string>();
  while (Object.hasOwn(aliases, model)) {
    if (seen.has(model)) throw new Error(`model alias cycle at "${model}"`);
    seen.add(model); model = aliases[model]!;
  }
  return model;
}
export function writeModelRouting(value: unknown): ModelRouting {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("model settings must be an object");
  const v = value as ModelRouting;
  const object = (x: unknown) => x && typeof x === "object" && !Array.isArray(x);
  if (!object(v.aliases) || !object(v.caps) || typeof v.mondayDigest !== "boolean") throw new Error("expected aliases, caps and mondayDigest");
  for (const [alias, model] of Object.entries(v.aliases)) {
    if (!/^[a-z][a-z0-9_-]{0,63}$/.test(alias) || typeof model !== "string" || !model.trim() || /[\s\x00-\x1f]/.test(model) || model.length > 200)
      throw new Error(`invalid model alias "${alias}"`);
    resolveModel(alias, v.aliases);
  }
  const caps: Record<string, ModelCap> = Object.create(null);
  for (const [model, cap] of Object.entries(v.caps)) {
    if (!model.trim() || /[\x00-\x1f]/.test(model) || !object(cap) || Object.keys(cap).some(k => k !== "usd" && k !== "tokens")) throw new Error(`invalid cap for "${model}"`);
    for (const [key, n] of Object.entries(cap)) if (typeof n !== "number" || !Number.isFinite(n) || n <= 0 || (key === "tokens" && !Number.isInteger(n))) throw new Error(`${model}.${key} must be a positive ${key === "tokens" ? "integer" : "number"}`);
    const resolved = resolveModel(model, v.aliases);
    if (Object.hasOwn(caps, resolved)) throw new Error(`duplicate cap for "${resolved}"`);
    caps[resolved] = cap;
  }
  const next = { aliases: v.aliases, caps, mondayDigest: v.mondayDigest };
  fs.mkdirSync(loomHome(), { recursive: true });
  fs.writeFileSync(file() + ".tmp", JSON.stringify(next, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(file() + ".tmp", file());
  return next;
}

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
export async function enforceModelCap(model?: string | null): Promise<void> {
  if (!model || !readModelRouting().caps[resolveModel(model)]) return;
  const usage = await modelUsage(model);
  if (usage.stopped) throw new Error(`daily model cap reached for ${usage.model}; resets at ${new Date(usage.resetsAt).toISOString()}`);
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

export function validateAgentOptions(kind: string, options: unknown): asserts options is Record<string, unknown> {
  if (!options || typeof options !== "object" || Array.isArray(options)) throw new Error("options must be an object");
  const o = options as Record<string, unknown>;
  for (const key of ["extraArgs", "args", "fallbacks"]) if (o[key] !== undefined && (!Array.isArray(o[key]) || !(o[key] as unknown[]).every(v => typeof v === "string" && !/[\x00\r\n]/.test(v)))) throw new Error(`options.${key} must be an array of strings without NUL or newlines`);
  for (const key of ["model", "provider", "bin", "configDir", "system", "effort"]) if (o[key] !== undefined && typeof o[key] !== "string") throw new Error(`options.${key} must be a string`);
  if (o.temperature !== undefined && (typeof o.temperature !== "number" || !Number.isFinite(o.temperature) || o.temperature < 0 || o.temperature > 2)) throw new Error("options.temperature must be between 0 and 2");
  for (const key of ["maxTokens", "history", "timeoutMs", "startTimeoutMs"]) if (o[key] !== undefined && (typeof o[key] !== "number" || !Number.isSafeInteger(o[key]) || o[key] <= 0)) throw new Error(`options.${key} must be a positive integer`);
  if (o.env !== undefined && (!o.env || typeof o.env !== "object" || Array.isArray(o.env) || Object.values(o.env).some(v => typeof v !== "string" || v.includes("\0")))) throw new Error("options.env must map environment names to strings");
  for (const key of ["tools", "write", "readOnly"]) if (o[key] !== undefined && typeof o[key] !== "boolean") throw new Error(`options.${key} must be boolean`);
  if (typeof o.effort === "string" && o.effort && !["none", "minimal", "low", "medium", "high", "xhigh", "max"].includes(o.effort)) throw new Error("options.effort is not a supported reasoning effort");
  const efforts: Record<string, string[]> = { "claude-code": ["low", "medium", "high", "xhigh", "max"], codex: ["none", "minimal", "low", "medium", "high", "xhigh"], "antigravity-cli": ["low", "medium", "high"] };
  if (o.effort && efforts[kind] && !efforts[kind]!.includes(String(o.effort))) throw new Error(`options.effort for ${kind} must be ${efforts[kind]!.join(", ")}`);
  if (o.permissions !== undefined && !["ask", "auto", "bypass"].includes(String(o.permissions))) throw new Error("options.permissions must be ask, auto or bypass");
  if (o.fallbacks !== undefined && kind !== "model") throw new Error("options.fallbacks is supported by model agents; use quota relay for CLI agents");
  if (typeof o.model === "string") resolveModel(o.model);
}
