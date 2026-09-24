/**
 * Turns, read straight off the event log: who ran how many, how often they
 * finished without an error, how long a turn takes, what one costs — and the
 * same turns day by day and row by row. Nothing estimated: every number is
 * a field an agent's own CLI reported on run_complete (or an error event).
 */

import type { LoomEvent } from "../types.js";

export interface TurnRow {
  id: number;
  ts: number;
  agentId: string;
  chat: string;
  ok: boolean;
  durationMs?: number;
  costUsd?: number;
  inputTokens?: number;
  outputTokens?: number;
  model?: string;
  error?: string;
}

export interface AgentStanding {
  agentId: string;
  turns: number;
  ok: number;
  errors: number;
  successRate: number;
  medianMs: number | null;
  avgCostUsd: number | null;
  totalCostUsd: number;
  tokens: number;
}

export interface DayCount {
  date: string; // YYYY-MM-DD, local time
  turns: number;
  errors: number;
  costUsd: number;
}

const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

export function turnRows(events: LoomEvent[]): TurnRow[] {
  const rows: TurnRow[] = [];
  for (const e of events) {
    if (!e.agentId || (e.kind !== "run_complete" && e.kind !== "error")) continue;
    const p = e.payload as Record<string, unknown>;
    const row: TurnRow = { id: e.id, ts: e.ts, agentId: e.agentId, chat: e.chat ?? "main", ok: e.kind === "run_complete" };
    const d = num(p.durationMs), c = num(p.costUsd), ti = num(p.inputTokens), to = num(p.outputTokens);
    if (d !== undefined) row.durationMs = d;
    if (c !== undefined) row.costUsd = c;
    if (ti !== undefined) row.inputTokens = ti;
    if (to !== undefined) row.outputTokens = to;
    if (typeof p.model === "string") row.model = p.model;
    if (!row.ok) row.error = String(p.message ?? p.error ?? "error").split("\n")[0]!.slice(0, 300);
    rows.push(row);
  }
  return rows;
}

function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : Math.round((s[mid - 1]! + s[mid]!) / 2);
}

/** Agents ranked by how reliably they finish, then by how many turns they've run. */
export function leaderboard(rows: TurnRow[]): AgentStanding[] {
  const by = new Map<string, TurnRow[]>();
  for (const r of rows) by.set(r.agentId, [...(by.get(r.agentId) ?? []), r]);
  const out: AgentStanding[] = [];
  for (const [agentId, rs] of by) {
    const ok = rs.filter((r) => r.ok);
    const costs = ok.map((r) => r.costUsd).filter((c): c is number => c !== undefined);
    const total = costs.reduce((a, b) => a + b, 0);
    out.push({
      agentId,
      turns: rs.length,
      ok: ok.length,
      errors: rs.length - ok.length,
      successRate: rs.length ? ok.length / rs.length : 0,
      medianMs: median(ok.map((r) => r.durationMs).filter((d): d is number => d !== undefined)),
      avgCostUsd: costs.length ? total / costs.length : null,
      totalCostUsd: total,
      tokens: rs.reduce((a, r) => a + (r.inputTokens ?? 0) + (r.outputTokens ?? 0), 0),
    });
  }
  return out.sort((a, b) => b.successRate - a.successRate || b.turns - a.turns || a.agentId.localeCompare(b.agentId));
}

function dayKey(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** The last `days` days, oldest first, every day present (zeros included). */
export function perDay(rows: TurnRow[], days: number, now = Date.now()): DayCount[] {
  const map = new Map<string, DayCount>();
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(start);
    d.setDate(d.getDate() - i);
    const k = dayKey(d.getTime());
    map.set(k, { date: k, turns: 0, errors: 0, costUsd: 0 });
  }
  for (const r of rows) {
    const c = map.get(dayKey(r.ts));
    if (!c) continue;
    c.turns++;
    if (!r.ok) c.errors++;
    c.costUsd += r.costUsd ?? 0;
  }
  return [...map.values()];
}

const csvCell = (v: unknown): string => {
  const s = v === undefined || v === null ? "" : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** One row per turn, for a spreadsheet. */
export function turnsCsv(rows: TurnRow[]): string {
  const head = ["time", "agent", "chat", "ok", "duration_ms", "cost_usd", "input_tokens", "output_tokens", "model", "error"];
  const lines = rows.map((r) =>
    [new Date(r.ts).toISOString(), r.agentId, r.chat, r.ok ? "yes" : "no", r.durationMs, r.costUsd, r.inputTokens, r.outputTokens, r.model, r.error]
      .map(csvCell)
      .join(","),
  );
  return [head.join(","), ...lines].join("\n") + "\n";
}
