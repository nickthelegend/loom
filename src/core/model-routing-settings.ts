import fs from "node:fs";
import path from "node:path";
import { loomHome } from "./registry.js";

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
