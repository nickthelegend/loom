import type { LoomEvent } from "../../types.js";

const number = (v: unknown): number | null => typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;
const key = (e: LoomEvent) => JSON.stringify([e.agentId ?? "", e.chat ?? "main", e.branch ?? "0"]);
const sorted = (events: LoomEvent[]) => [...events].sort((a, b) => a.ts - b.ts || a.id - b.id);
export const mean = (values: number[]) => values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
export function percentiles(values: number[]) {
  const xs = [...values].sort((a, b) => a - b);
  const at = (p: number) => xs.length ? xs[Math.max(0, Math.ceil(xs.length * p) - 1)]! : null;
  return { samples: xs.length, p50: at(.5), p95: at(.95) };
}
export interface Turn {
  id: number; agent: string; chat: string; model: string; start: number; end: number;
  ok: boolean; error: string; durationMs: number | null; firstOutputMs: number | null; costUsd: number;
  waits: Array<[number, number]>;
}

/** Pair boundaries before filtering windows, so a turn crossing midnight keeps its timing. */
export function turns(events: LoomEvent[], workingUntil?: number, liveAgents?: Set<string>): Turn[] {
  const out: Turn[] = [], active = new Map<string, { start: number; first?: number; waits: Array<[number, number]>; wait?: number; pendingWaits?: Set<string>; failed?: Turn; implicit?: boolean; echoed?: boolean; agent: string; chat: string }>();
  for (const e of sorted(events)) {
    if (!e.agentId) {
      if (e.kind === "message") for (const [k, a] of active) if (a.failed && a.chat === (e.chat ?? "main")) active.delete(k);
      continue;
    }
    const p = e.payload, k = key(e);
    let a = active.get(k);
    if (e.kind === "status" && p.state === "turn_started") {
      // Adapters re-announce the dispatcher's start once (their payload carries `session`); that is the same turn even when
      // output already arrived between the two, and however slowly the adapter started. Any other start after output is a new turn.
      const echo = a && !a.failed && !a.echoed && "session" in p;
      if (echo) { a!.echoed = true; continue; }
      if (!a || a.failed || a.first !== undefined || e.ts - a.start > 5000) active.set(k, { start: e.ts, waits: [], agent: e.agentId, chat: e.chat ?? "main" });
      continue;
    }
    if (a && ((e.kind === "status" && p.state === "r4_first_output") || e.kind === "tool_call" || e.kind === "message")) a.first ??= e.ts;
    if (a && (e.kind === "needs_input" || (e.kind === "approval" && p.phase === "requested"))) {
      a.wait ??= e.ts;
      (a.pendingWaits ??= new Set()).add(e.kind === "approval" ? `approval:${p.approvalId}` : `question:${p.requestId ?? ""}`);
    }
    if (a && ((e.kind === "approval" && p.phase === "decided") || (e.kind === "status" && p.state === "question_answered"))) {
      a.pendingWaits?.delete(e.kind === "approval" ? `approval:${p.approvalId}` : `question:${p.requestId ?? ""}`);
      if (!a.pendingWaits?.size) {
        if (a.wait !== undefined) a.waits.push([a.wait, e.ts]);
        delete a.wait;
      }
    }
    if (e.kind === "status" && p.state === "interrupted") {
      if (workingUntil !== undefined && a && !a.failed) out.push({ id: e.id, agent: e.agentId, chat: e.chat ?? "main", model: "unknown", start: a.start, end: e.ts, ok: false, error: "interrupted", durationMs: e.ts - a.start, firstOutputMs: null, costUsd: 0, waits: [...a.waits, ...(a.wait !== undefined ? [[a.wait, e.ts] as [number, number]] : [])] });
      active.delete(k); continue;
    }
    if (e.kind !== "error" && e.kind !== "run_complete") continue;
    const started = a && !a.implicit ? a : undefined;
    const reportedDuration = number(p.durationMs);
    const duration = reportedDuration ?? (started ? Math.max(0, e.ts - started.start) : null);
    const start = started ? (reportedDuration === null ? started.start : Math.max(started.start, e.ts - reportedDuration)) : e.ts - (duration ?? 0);
    const failed = e.kind === "error" || Boolean(p.error);
    const row: Turn = { id: e.id, agent: e.agentId, chat: e.chat ?? "main", model: String(p.model ?? "unknown"),
      start, end: e.ts, ok: !failed, error: failed ? String(p.message ?? p.error ?? "error") : "",
      durationMs: duration, firstOutputMs: number(p.firstOutputMs) ?? (a?.first !== undefined && a.first >= start ? a.first - start : null),
      costUsd: number(p.costUsd) ?? 0, waits: [...(a?.waits ?? []), ...(a?.wait !== undefined ? [[a.wait, e.ts] as [number, number]] : [])] };
    // An error followed by run_complete describes one failed turn, not two turns.
    let retained = row;
    if (a?.failed && !(a.implicit && e.kind === "error")) {
      retained = a.failed;
      if (e.kind === "run_complete") Object.assign(a.failed, { start: row.start, firstOutputMs: row.firstOutputMs, end: row.end, durationMs: row.durationMs, costUsd: row.costUsd, model: row.model, waits: row.waits });
      else { if (!a.failed.error.includes(row.error)) a.failed.error += `\n${row.error}`; a.failed.end = row.end; a.failed.durationMs = row.durationMs; }
    } else out.push(row);
    if (e.kind === "run_complete") active.delete(k);
    else { a ??= { start: row.start, waits: [], implicit: true, agent: e.agentId, chat: e.chat ?? "main" }; a.failed = retained; active.set(k, a); }
  }
  if (workingUntil !== undefined) for (const a of active.values()) if (!a.failed && a.start < workingUntil && (!liveAgents || liveAgents.has(a.agent))) out.push({ id: 0, agent: a.agent, chat: a.chat, model: "unknown", start: a.start, end: workingUntil, ok: true, error: "", durationMs: workingUntil - a.start, firstOutputMs: null, costUsd: 0, waits: [...a.waits, ...(a.wait !== undefined ? [[a.wait, workingUntil] as [number, number]] : [])] });
  return out.sort((a, b) => a.end - b.end || a.id - b.id);
}

export function toolAnalytics(events: LoomEvent[], filter: { since?: number; agent?: string } = {}) {
  const calls: Array<{ agent: string; tool: string; failed: boolean | null; ms: number | null; ts: number }> = [];
  const pending = new Map<string, typeof calls[number]>();
  const outcome = (p: Record<string, unknown>) => p.ok === false || p.is_error === true || p.error || (typeof p.exitCode === "number" && p.exitCode !== 0) ? true : p.ok === true || p.is_error === false || p.exitCode === 0 ? false : null;
  const measured = new Map(events.filter(e => e.payload.state === "r4_tool_duration").map(e => [e.payload.toolEventId, number(e.payload.durationMs)]));
  for (const e of sorted(events)) {
    const p = e.payload, id = p.id ?? p.toolCallId ?? p.tool_use_id;
    const k = `${key(e)}:${String(id)}`;
    if (e.kind === "tool_call") {
      const row = { agent: e.agentId ?? "unknown", tool: (p.server ? `${String(p.server)}.` : "") + String(p.tool ?? p.name ?? "unknown"), failed: outcome(p), ms: number(p.durationMs) ?? measured.get(e.id) ?? null, ts: e.ts };
      calls.push(row);
      if (id !== undefined) pending.set(k, row);
    } else if (e.kind === "tool_result" && id !== undefined) {
      const row = pending.get(k);
      if (row) { row.failed = outcome(p) ?? false; row.ms = number(p.durationMs) ?? Math.max(0, e.ts - row.ts); pending.delete(k); }
    }
  }
  const group = (by: (r: typeof calls[number]) => string) => {
    const groups = new Map<string, typeof calls>();
    for (const row of calls.filter(r => r.ts >= (filter.since ?? 0) && (!filter.agent || r.agent === filter.agent))) { const k = by(row); const rows = groups.get(k) ?? []; rows.push(row); groups.set(k, rows); }
    return [...groups].map(([name, rows]) => {
      const failures = rows.filter(r => r.failed === true).length, completed = rows.filter(r => r.failed !== null).length;
      const durations = rows.flatMap(r => r.ms === null ? [] : [r.ms]);
      return { name, calls: rows.length, completed, failures, failureRate: completed ? failures / completed * 100 : null, averageMs: mean(durations), timed: durations.length };
    }).sort((a, b) => b.calls - a.calls || a.name.localeCompare(b.name));
  };
  return { byTool: group(r => r.tool), byAgent: group(r => r.agent), byAgentTool: group(r => JSON.stringify([r.agent, r.tool])) };
}

export function latency(rows: Turn[]) {
  const group = (field: "agent" | "model") => [...new Set(rows.map(r => r[field]))].sort().map(name => {
    const rs = rows.filter(r => r[field] === name);
    return { name, firstOutputMs: percentiles(rs.flatMap(r => r.firstOutputMs === null ? [] : [r.firstOutputMs])), durationMs: percentiles(rs.flatMap(r => r.durationMs === null ? [] : [r.durationMs])) };
  });
  return { byAgent: group("agent"), byModel: group("model") };
}

export const isShellTool = (tool: string): boolean => /^(Bash|shell|run|run_command|exec_command|execute|terminal)$/i.test(tool);

export function approvalInsights(events: LoomEvent[], now = Date.now(), filter: { since?: number; agent?: string } = {}) {
  const requests = new Map<string, LoomEvent>(), rows: Array<{ id: number; approvalId: string; tool: string; command: string; agent: string; waitMs: number; by: string | null; behavior: string | null }> = [];
  for (const e of sorted(events)) {
    if (e.kind !== "approval" || typeof e.payload.approvalId !== "string") continue;
    if (e.payload.phase === "requested") requests.set(e.payload.approvalId, e);
  }
  const answers = new Map(events.filter(e => e.kind === "approval" && e.payload.phase === "decided").map(e => [String(e.payload.approvalId), e]));
  for (const [id, e] of requests) {
    if (e.ts < (filter.since ?? 0) || (filter.agent && e.agentId !== filter.agent)) continue;
    const p = e.payload, answer = answers.get(id), input = p.input as Record<string, unknown> | undefined;
    rows.push({ id: e.id, approvalId: id, tool: String(p.tool ?? "unknown"), command: String(input?.command ?? input?.cmd ?? (typeof p.input === "string" ? p.input : p.tool ?? "unknown")),
      agent: e.agentId ?? "unknown", waitMs: Math.max(0, (answer?.ts ?? now) - e.ts), by: answer ? String(answer.payload.by ?? "unrecorded") : null, behavior: answer ? String(answer.payload.behavior ?? "unknown") : null });
  }
  const commands = new Map<string, { tool: string; command: string; count: number; totalWaitMs: number; exampleId: number; allowable: boolean }>();
  for (const row of rows) {
    const k = JSON.stringify([row.tool, row.command]), group = commands.get(k) ?? { tool: row.tool, command: row.command, count: 0, totalWaitMs: 0, exampleId: row.id, allowable: !isShellTool(row.tool) };
    group.count++; group.totalWaitMs += row.waitMs; commands.set(k, group);
  }
  return { rows, waitMs: percentiles(rows.filter(r => r.by !== null).map(r => r.waitMs)), commands: [...commands.values()].sort((a, b) => b.count - a.count) };
}

export function normalizeError(text: string): string {
  return text.toLowerCase().replace(/\b[0-9a-f]{8}-[0-9a-f-]{27,}\b/g, "<id>").replace(/\b0x[0-9a-f]+\b/g, "<hex>")
    .replace(/\b\d+(?:\.\d+)*\b/g, "<n>").replace(/\s+/g, " ").trim();
}
export function failureGroups(rows: Turn[]) {
  const groups = new Map<string, { error: string; count: number; lastSeen: number; examples: Array<{ eventId: number; chat: string; agent: string }> }>();
  for (const row of rows.filter(r => !r.ok)) {
    const error = normalizeError(row.error), group = groups.get(error) ?? { error, count: 0, lastSeen: 0, examples: [] };
    group.count++; group.lastSeen = Math.max(group.lastSeen, row.end);
    group.examples.unshift({ eventId: row.id, chat: row.chat, agent: row.agent }); group.examples = group.examples.slice(0, 5); groups.set(error, group);
  }
  return [...groups.values()].sort((a, b) => b.count - a.count || b.lastSeen - a.lastSeen);
}

export function duration(value: string): number {
  const m = /^(\d+(?:\.\d+)?)(m|h|d)$/.exec(value);
  const ms = m ? Number(m[1]) * ({ m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2]!] ?? 0) : 0;
  if (!ms || ms > 366 * 86_400_000) throw new Error("duration must be between 1ms and 366d, using m, h or d");
  return ms;
}
export function sinceTime(value: string | undefined, now = Date.now()): number {
  if (!value) return 0;
  if (/^\d+(?:\.\d+)?[mhd]$/.test(value)) return now - duration(value);
  const n = /^\d+$/.test(value) ? Number(value) : Date.parse(value);
  if (!Number.isFinite(n) || n < 0) throw new Error("since must be an ISO date, epoch milliseconds or duration such as 7d");
  return n;
}
/** Task snapshots repeat as an orchestra progresses. Attribute its final diff once. */
function withTaskDiffs(events: LoomEvent[]): LoomEvent[] {
  type TaskDiff = { id: string; agent: string; chat?: string; startedAt?: number; finishedAt?: number; files?: string[]; diffStat: { insertions?: number; deletions?: number } };
  const tasks = new Map<string, { event: LoomEvent; task: TaskDiff }>();
  for (const event of sorted(events)) {
    if (event.kind !== "orchestra" || event.payload.phase !== "task") continue;
    const task = event.payload.task as TaskDiff | undefined;
    if (task?.id && task.agent && task.diffStat) tasks.set(`${event.payload.runId}/${task.id}`, { event, task });
  }
  const diffs = events.filter(e => e.kind === "turn_diff");
  const result = [...events];
  for (const { event, task } of tasks.values()) {
    const ts = number(task.finishedAt) ?? event.ts;
    if (task.chat && diffs.some(e => e.agentId === task.agent && e.chat === task.chat && e.ts >= (task.startedAt ?? 0) && e.ts <= event.ts)) continue;
    result.push({ ...event, ts, kind: "turn_diff", agentId: task.agent, chat: task.chat, payload: { files: (task.files ?? []).map(path => ({ path })), added: task.diffStat.insertions, removed: task.diffStat.deletions } });
  }
  return result;
}

export function comparison(events: LoomEvent[], periodMs: number, now = Date.now()) {
  const rows = turns(events), changedFiles = withTaskDiffs(events);
  const totals = (start: number, end: number) => {
    const rs = rows.filter(r => r.end >= start && r.end < end);
    const lines = changedFiles.filter(e => e.kind === "turn_diff" && e.ts >= start && e.ts < end).reduce((n, e) => n + (number(e.payload.added) ?? 0) + (number(e.payload.removed) ?? 0), 0);
    return { turns: rs.length, finishRate: rs.length ? rs.filter(r => r.ok).length / rs.length * 100 : 0, spend: rs.reduce((n, r) => n + r.costUsd, 0), lines };
  };
  const current = totals(now - periodMs, now), previous = totals(now - 2 * periodMs, now - periodMs);
  const changes = Object.fromEntries((Object.keys(current) as Array<keyof typeof current>).map(k => {
    const delta = current[k] - previous[k];
    return [k, { delta, percent: previous[k] ? delta / previous[k] * 100 : null, direction: delta > 0 ? "up" : delta < 0 ? "down" : "flat" }];
  }));
  return { periodMs, start: now - periodMs, end: now, current, previous, changes };
}

/** Union intervals per agent: concurrent chats cannot turn an hour into two. UTC days are explicit. */
export function agentHours(rows: Turn[], project: string) {
  const intervals = new Map<string, Array<[number, number]>>();
  for (const row of rows) {
    if (row.durationMs === null) continue;
    let cursor = row.start;
    const parts: Array<[number, number]> = [];
    for (const [start, end] of [...row.waits].sort((a, b) => a[0] - b[0])) { if (start > cursor) parts.push([cursor, Math.min(start, row.end)]); cursor = Math.max(cursor, end); }
    if (cursor < row.end) parts.push([cursor, row.end]);
    const own = intervals.get(row.agent) ?? []; own.push(...parts); intervals.set(row.agent, own);
  }
  const days = new Map<string, { project: string; agent: string; day: string; activeMs: number }>();
  for (const [agent, parts] of intervals) {
    const merged: Array<[number, number]> = [];
    for (const [start, end] of parts.sort((a, b) => a[0] - b[0])) { const last = merged.at(-1); if (last && start <= last[1]) last[1] = Math.max(last[1], end); else merged.push([start, end]); }
    for (const [start, end] of merged) for (let t = start; t < end;) {
      const day = new Date(t).toISOString().slice(0, 10), next = Math.min(end, Date.parse(day) + 86_400_000), k = JSON.stringify([agent, day]);
      const row = days.get(k) ?? { project, agent, day, activeMs: 0 }; row.activeMs += next - t; days.set(k, row); t = next;
    }
  }
  const entries = [...days.values()].sort((a, b) => b.day.localeCompare(a.day) || a.agent.localeCompare(b.agent));
  return { timezone: "UTC", entries, totalMs: entries.reduce((n, r) => n + r.activeMs, 0) };
}
export function hoursCsv(hours: ReturnType<typeof agentHours>): string {
  const cell = (s: string) => `"${(/^[=+@\-\t\r]/.test(s) ? "'" : "") + s.replace(/"/g, '""')}"`;
  return "project,agent,day,active_hours\r\n" + hours.entries.map(r => [cell(r.project), cell(r.agent), r.day, (r.activeMs / 3_600_000).toFixed(6)].join(",")).join("\r\n") + "\r\n";
}

export function fileHotspots(events: LoomEvent[]) {
  const files = new Map<string, { path: string; edits: number; reEdits: number; rewinds: number; agents: Set<string> }>();
  const seen = new Set<string>();
  for (const e of sorted(withTaskDiffs(events))) {
    const p = e.payload, rewind = (e.kind === "checkpoint" && p.reason === "rewound") || (e.kind === "status" && p.state === "r4_rewind_files");
    // file_edit measures edit operations; turn_diff is used only when an adapter did not report them.
    const paths = e.kind === "file_edit" ? [p.path] : e.kind === "turn_diff" ? (Array.isArray(p.files) ? p.files.map(f => (f as { path?: unknown }).path) : []) : rewind ? (p.path ? [p.path] : Array.isArray(p.paths) ? p.paths : []) : [];
    for (const value of new Set(paths)) {
      if (typeof value !== "string" || !value) continue;
      const row = files.get(value) ?? { path: value, edits: 0, reEdits: 0, rewinds: 0, agents: new Set<string>() };
      const k = `${key(e)}:${value}`;
      if (rewind) row.rewinds++;
      else if (e.kind !== "turn_diff" || !seen.has(k)) { row.edits++; if (row.edits > 1) row.reEdits++; if (e.agentId) row.agents.add(e.agentId); }
      if (e.kind === "file_edit") seen.add(k);
      files.set(value, row);
    }
    if (e.kind === "turn_diff" || (e.kind === "status" && p.state === "turn_started")) for (const k of seen) if (k.startsWith(`${key(e)}:`)) seen.delete(k);
  }
  return [...files.values()].map(r => ({ ...r, agents: [...r.agents].sort() })).sort((a, b) => b.edits + b.rewinds - a.edits - a.rewinds || a.path.localeCompare(b.path));
}
