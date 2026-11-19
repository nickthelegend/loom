import fs from "node:fs";
import path from "node:path";
import { loomHome } from "../registry.js";
import { modelKey, type Price } from "../prices.js";
import { readModelRouting, resolveModel } from "../model-routing-settings.js";

export function readJson<T>(file: string, fallback: T): T {
  try { return JSON.parse(fs.readFileSync(file, "utf8")) as T; }
  catch { return fallback; }
}
export function saveJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file + ".tmp", JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(file + ".tmp", file);
}
export function amount(value: unknown, name = "USD"): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new Error(`${name} must be a finite nonnegative number`);
  return value;
}
const pricesFile = () => path.join(loomHome(), "price-overrides.json");
/** Stored and exposed in USD per million; converted only at the pricing boundary. */
const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;
const validAmount = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;
export function priceOverrides(): Record<string, Price> {
  const raw = readJson<unknown>(pricesFile(), {});
  if (!object(raw)) return {};
  return Object.fromEntries(Object.entries(raw).flatMap(([id, p]) => object(p) && validAmount(p.in) && validAmount(p.out)
    ? [[id, { in: p.in, out: p.out, ...(validAmount(p.cacheRead) ? { cacheRead: p.cacheRead } : {}) }]] : []));
}
export function writePriceOverrides(value: unknown): Record<string, Price> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("expected a model to price map");
  const next: Record<string, Price> = Object.create(null);
  for (const [model, raw] of Object.entries(value)) {
    if (!model.trim() || model.length > 200 || /[\s\x00-\x1f]/.test(model) || !raw || typeof raw !== "object") throw new Error("invalid model price");
    const p = raw as Price, key = modelKey(model);
    if (Object.hasOwn(next, key)) throw new Error(`duplicate model ${key}`);
    next[key] = { in: amount(p.in, "input price"), out: amount(p.out, "output price"), ...(p.cacheRead === undefined ? {} : { cacheRead: amount(p.cacheRead, "cache price") }) };
  }
  saveJson(pricesFile(), next); return next;
}
export interface CostSettings {
  chats: Record<string, number>;
  monthlyUsd: number;
  dailyUsd: number;
  alerts: Array<"slack" | "discord" | "email" | "push">;
  saver: { alias: string; share: number; period: "day" | "month" } | null;
}
const revisions = new Map<string, number>();
export const costSettingsRevision = (dir: string): number => revisions.get(dir) ?? 0;
const settingsFile = (dir: string) => path.join(dir, ".loom", "cost-settings.json");
export function costSettings(dir: string): CostSettings {
  const raw = readJson<unknown>(settingsFile(dir), {}), p = object(raw) ? raw : {};
  const s = p.saver;
  return {
    chats: object(p.chats) && Object.values(p.chats).every(validAmount) ? p.chats as Record<string, number> : {},
    monthlyUsd: validAmount(p.monthlyUsd) ? p.monthlyUsd : 0,
    dailyUsd: validAmount(p.dailyUsd) ? p.dailyUsd : 0,
    alerts: Array.isArray(p.alerts) ? [...new Set(p.alerts.filter((v): v is CostSettings["alerts"][number] => ["slack", "discord", "email", "push"].includes(v)))] : [],
    saver: object(s) && typeof s.alias === "string" && typeof s.share === "number" && s.share > 0 && s.share <= 1 && (s.period === "day" || s.period === "month")
      ? { alias: s.alias, share: s.share, period: s.period } : null,
  };
}
export function updateCostSettings(dir: string, patch: unknown): CostSettings {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw new Error("expected cost settings");
  const p = patch as Partial<CostSettings>;
  if (Object.keys(p).some(k => !["chats", "monthlyUsd", "dailyUsd", "alerts", "saver"].includes(k))) throw new Error("unknown cost setting");
  const next = { ...costSettings(dir), ...p };
  amount(next.monthlyUsd); amount(next.dailyUsd);
  if (!next.chats || typeof next.chats !== "object" || Array.isArray(next.chats)) throw new Error("expected chat budgets");
  for (const [chat, usd] of Object.entries(next.chats)) { if (!chat || /[\x00-\x1f]/.test(chat)) throw new Error("invalid chat"); amount(usd); }
  if (!Array.isArray(next.alerts) || next.alerts.some(c => !["slack", "discord", "email", "push"].includes(c))) throw new Error("unknown alert channel");
  next.alerts = [...new Set(next.alerts)];
  if (next.saver !== null) {
    const s = next.saver;
    if (!s || !["day", "month"].includes(s.period) || typeof s.share !== "number" || !Number.isFinite(s.share) || s.share <= 0 || s.share > 1 || !Object.hasOwn(readModelRouting().aliases, s.alias)) throw new Error("Saver needs an existing alias, share in (0, 1], and day or month period");
    resolveModel(s.alias);
    if (!(s.period === "day" ? next.dailyUsd : next.monthlyUsd)) throw new Error("Set the selected daily or monthly cap before enabling Saver");
  }
  saveJson(settingsFile(dir), next);
  revisions.set(dir, costSettingsRevision(dir) + 1);
  return next;
}
