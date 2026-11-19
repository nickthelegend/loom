import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { loomHome } from "../../core/registry.js";
import type { Turn } from "./analytics.js";

export interface AlertRule {
  id: string; expression: string; metric: "finish_rate" | "turn_minutes" | "errors_per_hour" | "queue_depth";
  operator: "<" | ">"; threshold: number; window: number; paused: boolean; firing: boolean; lastFired?: number;
}
export function parseAlert(expression: string): Omit<AlertRule, "id" | "paused" | "firing"> {
  const match = /^(finish_rate|turn_minutes|errors_per_hour|queue_depth)\s*([<>])\s*(\d+(?:\.\d+)?)(%)?(?:\s+over\s+(\d+)\s+turns)?$/.exec(expression.trim());
  if (!match) throw new Error('use "finish_rate < 70% over 20 turns", "turn_minutes > 5 over 10 turns", "errors_per_hour > 3" or "queue_depth > 5"');
  const metric = match[1] as AlertRule["metric"], threshold = Number(match[3]), window = Number(match[5] ?? 1);
  if (!Number.isFinite(threshold) || threshold > 1e9 || window < 1 || window > 10000 || (metric === "finish_rate" && (!match[4] || threshold > 100 || !match[5])) || (metric !== "finish_rate" && match[4]) || ((metric === "errors_per_hour" || metric === "queue_depth") && match[5])) throw new Error("invalid threshold, unit or turn window");
  return { expression: expression.trim(), metric, operator: match[2] as "<" | ">", threshold, window };
}
const file = (project: string) => path.join(loomHome(), "insights-r4", `${encodeURIComponent(project)}.json`);
const ruleCache = new Map<string, AlertRule[]>();
export function readRules(project: string): AlertRule[] {
  const dest = file(project);
  let rules = ruleCache.get(dest);
  if (!rules) {
    try { rules = JSON.parse(fs.readFileSync(dest, "utf8")) as AlertRule[]; }
    catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") rules = []; else throw e; }
    ruleCache.set(dest, rules);
  }
  // Callers edit their own snapshot; only a successful write changes persisted state.
  return rules.map(rule => ({ ...rule }));
}
export function writeRules(project: string, rules: AlertRule[]): void {
  const dest = file(project); fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest + ".tmp", JSON.stringify(rules) + "\n", { mode: 0o600 }); fs.renameSync(dest + ".tmp", dest);
  ruleCache.delete(dest);
}
export function addRule(project: string, expression: string): AlertRule {
  const parsed = parseAlert(expression), rules = readRules(project);
  if (rules.length >= 100) throw new Error("a project can have at most 100 alert rules");
  const rule = { ...parsed, id: randomUUID(), paused: false, firing: false }; rules.push(rule); writeRules(project, rules); return rule;
}
export function evaluateRule(rule: AlertRule, turns: Turn[], queueDepth: number, now = Date.now()) {
  const recent = turns.slice(-rule.window);
  let value: number | null;
  if (rule.metric === "queue_depth") value = queueDepth;
  else if (rule.metric === "errors_per_hour") value = turns.filter(r => !r.ok && r.end >= now - 3_600_000 && r.end <= now).length;
  else if (recent.length < rule.window) value = null;
  else if (rule.metric === "finish_rate") value = recent.filter(r => r.ok).length / recent.length * 100;
  else value = recent.every(r => r.durationMs !== null) ? recent.reduce((n, r) => n + r.durationMs!, 0) / recent.length / 60_000 : null;
  return { value, breached: value !== null && (rule.operator === "<" ? value < rule.threshold : value > rule.threshold), enoughData: value !== null };
}
