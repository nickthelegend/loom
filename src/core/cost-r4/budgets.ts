import { BudgetExceededError } from "../../daemon/runtime-support.js";
import { costSettings, costSettingsRevision } from "./settings.js";
import { costReport } from "./report.js";
import { readProjectState } from "../registry.js";
import { readModelRouting, resolveModel } from "../model-routing-settings.js";
import type { EventJournal } from "../eventlog.js";
import type { LoomEvent, ProjectInfo } from "../../types.js";

export interface CostHost { info: ProjectInfo; log: EventJournal }
export function periodBounds(now = Date.now()) {
  const d = new Date(now);
  return { day: new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(),
    month: new Date(d.getFullYear(), d.getMonth(), 1).getTime(), end: new Date(d.getFullYear(), d.getMonth() + 1, 1).getTime() };
}
const snapshots = new WeakMap<EventJournal, { key: string; at: number; month: ReturnType<typeof costReport>; day: ReturnType<typeof costReport>; all: ReturnType<typeof costReport> | null }>();
const noticeKeys = new WeakMap<EventJournal, Set<string>>();
export function invalidateCostSnapshot(host: CostHost): void { snapshots.delete(host.log); }
export function budgetSnapshot(host: CostHost, now = Date.now()) {
  const settings = costSettings(host.info.dir), bounds = periodBounds(now);
  // Settings are part of the key, including updates made outside this runtime.
  const key = JSON.stringify([bounds.day, costSettingsRevision(host.info.dir), settings]);
  let cached = snapshots.get(host.log);
  if (!cached || cached.key !== key || cached.at > now) {
    const events = host.log.list({ kinds: ["status", "run_complete"], sinceTs: bounds.month, allBranches: true }).filter(e => e.ts <= now);
    const all = Object.values(settings.chats).some(cap => cap > 0)
      ? costReport(host.log.list({ kinds: ["status", "run_complete"], allBranches: true }).filter(e => e.ts <= now)) : null;
    cached = { key, at: now, month: costReport(events, bounds.month), day: costReport(events, bounds.day), all };
    snapshots.set(host.log, cached);
  }
  const { all, month, day } = cached;
  const row = (capUsd: number, spentUsd: number) => ({ capUsd, spentUsd, fraction: capUsd ? spentUsd / capUsd : 0, warning: capUsd > 0 && spentUsd >= capUsd * 0.8, stopped: capUsd > 0 && spentUsd >= capUsd });
  const monthly = { ...row(settings.monthlyUsd, month.totals.usd), startsAt: bounds.month, resetsAt: bounds.end,
    projectedUsd: month.totals.usd * (bounds.end - bounds.month) / Math.max(24 * 60 * 60 * 1000, now - bounds.month) };
  const daily = row(settings.dailyUsd, day.totals.usd);
  const chats = Object.fromEntries(Object.entries(settings.chats).map(([id, cap]) => [id, row(cap, all?.byChat.find(c => c.chat === id)?.usd ?? 0)]));
  const agents = Object.fromEntries(Object.entries(readProjectState(host.info.dir).budgets ?? {}).map(([id, cap]) => [id, row(cap, day.byAgent.find(a => a.agentId === id)?.usd ?? 0)]));
  const s = settings.saver;
  const saver = s ? { ...s, active: Object.hasOwn(readModelRouting().aliases, s.alias) && (s.period === "day" ? daily : monthly).fraction >= s.share, model: resolveModel(s.alias) } : null;
  return { settings, monthly, daily, chats, agents, saver };
}
export function budgetNotices(host: CostHost, chat?: string, now = Date.now()): void {
  const snap = budgetSnapshot(host, now), bounds = periodBounds(now);
  const rows = [ { scope: "month", key: "project", period: bounds.month, ...snap.monthly }, { scope: "day", key: "project", period: bounds.day, ...snap.daily },
    ...Object.entries(snap.chats).filter(([id]) => chat === undefined || id === chat).map(([key, r]) => ({ scope: "chat", key, period: 0, ...r })),
    ...Object.entries(snap.agents).map(([key, r]) => ({ scope: "agent", key, period: bounds.day, ...r })) ];
  let seen = noticeKeys.get(host.log);
  if (!seen) {
    seen = new Set(host.log.list({ kinds: ["status"], allBranches: true }).filter(e => e.payload.state === "cost_budget_notice").map(e => String(e.payload.key)));
    noticeKeys.set(host.log, seen);
  }
  for (const row of rows) {
    if (!row.warning) continue;
    const key = `${row.scope}:${row.key}:${row.period}:${row.capUsd}:${row.stopped ? 100 : 80}`;
    if (seen.has(key)) continue;
    seen.add(key);
    host.log.append({ kind: "status", ...(row.scope === "chat" ? { chat: row.key } : chat ? { chat } : {}), ...(row.scope === "agent" ? { agentId: row.key } : {}),
      payload: { state: "cost_budget_notice", key, scope: row.scope, subject: row.key, stopped: row.stopped, capUsd: row.capUsd, spentUsd: row.spentUsd,
        text: `${row.scope} budget ${row.key}: $${row.spentUsd.toFixed(4)} of $${row.capUsd.toFixed(2)}. ${row.stopped ? "Paused; raise the cap to continue." : "80% used."}` } });
  }
}
export function enforceCostBudget(host: CostHost, chat?: string): void {
  const settings = costSettings(host.info.dir);
  if (!settings.monthlyUsd && !settings.dailyUsd && !(chat && settings.chats[chat])) return;
  const s = budgetSnapshot(host);
  const stopped = (chat ? s.chats[chat]?.stopped : false) || s.monthly.stopped || s.daily.stopped;
  if (!stopped) return;
  budgetNotices(host, chat);
  const row = chat && s.chats[chat]?.stopped ? s.chats[chat]! : s.monthly.stopped ? s.monthly : s.daily;
  const error = new BudgetExceededError(chat ?? "project", row.capUsd, row.spentUsd);
  error.message = `${chat && s.chats[chat]?.stopped ? "Chat" : s.monthly.stopped ? "Monthly project" : "Daily project"} budget reached; raise the cap to continue`;
  throw error;
}
export function budgetEvent(event: LoomEvent): boolean {
  return event.kind === "status" && ["cost_budget_notice", "model_cap_warning", "budget_exceeded"].includes(String(event.payload.state));
}

/** Guard before moving a chat baton as well as before accepting its prompt. */
export const assertChatBudget = enforceCostBudget;
