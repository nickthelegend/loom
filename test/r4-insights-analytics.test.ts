import { describe, expect, it } from "vitest";
import { agentHours, approvalInsights, comparison, duration, failureGroups, fileHotspots, hoursCsv, latency, sinceTime, toolAnalytics, turns } from "../src/observability/r4/analytics.js";
import { evaluateRule, parseAlert } from "../src/observability/r4/alerts.js";
import { digest } from "../src/core/digest.js";
import type { LoomEvent } from "../src/types.js";
let id = 0;
const e = (kind: LoomEvent['kind'], ts: number, payload: Record<string, unknown> = {}, agentId = 'a', chat = 'main'): LoomEvent => ({ id: ++id, kind, ts, payload, agentId, chat });

describe('R4 analytics from recorded events', () => {
  it('keeps first output when the adapter re-announces the start after output arrived', () => {
    const rows = turns([e('status', 0, { state: 'turn_started', requestId: 'r1' }), e('tool_call', 4, { id: 't', tool: 'shell' }), e('status', 6, { state: 'turn_started', session: 's' }), e('run_complete', 20, {})]);
    expect(rows).toHaveLength(1); expect(rows[0]!.firstOutputMs).toBe(4); expect(rows[0]!.durationMs).toBe(20);
  });
  it('pairs tool IDs within agent and chat, counts failures and leaves unknown timings unknown', () => {
    const events = [e('tool_call', 0, { id: 'x', tool: 'shell' }), e('tool_call', 10, { id: 'x', tool: 'read' }, 'b'), e('tool_result', 50, { id: 'x', ok: false }), e('tool_result', 110, { id: 'x', ok: true }, 'b'), e('tool_call', 120, { name: 'shell', ok: true }), e('tool_call', 125, { tool: 'pending' })];
    const result = toolAnalytics(events);
    expect(result.byTool.find(r => r.name === 'shell')).toMatchObject({ calls: 2, failures: 1, failureRate: 50, averageMs: 50, timed: 1 });
    expect(result.byAgent.find(r => r.name === 'b')).toMatchObject({ calls: 1, averageMs: 100 });
    expect(result.byTool.find(r => r.name === 'pending')).toMatchObject({ completed: 0, failureRate: null, averageMs: null });
  });
  it('uses live tool timing without counting the measurement as another call', () => {
    const call = e('tool_call', 50, { tool: 'shell', ok: true });
    expect(toolAnalytics([call, e('status', 51, { state: 'r4_tool_duration', toolEventId: call.id, durationMs: 25 })]).byTool[0]).toMatchObject({ calls: 1, averageMs: 25 });
  });
  it('does not count an error and its completion as two turns', () => {
    const rows = turns([e('status', 100, { state: 'turn_started' }), e('status', 105, { state: 'turn_started' }), e('status', 120, { state: 'r4_first_output' }), e('error', 190, { message: 'HTTP 500 request 123 failed' }), e('run_complete', 200, { durationMs: 100, model: 'echo-1', costUsd: .1 })]);
    expect(rows).toHaveLength(1); expect(rows[0]).toMatchObject({ ok: false, durationMs: 100, firstOutputMs: 20, model: 'echo-1', costUsd: .1 });
    expect(latency(rows).byModel[0]).toMatchObject({ name: 'echo-1', firstOutputMs: { p50: 20, p95: 20 } });
  });
  it('keeps unrelated legacy errors separate and normalizes changing IDs', () => {
    const rows = turns([e('error', 10, { message: 'Request 123 failed' }), e('error', 20, { message: 'Request 456 failed' })]);
    expect(failureGroups(rows)[0]).toMatchObject({ error: 'request <n> failed', count: 2, lastSeen: 20 });
    expect(failureGroups(rows)[0]!.examples).toHaveLength(2);
  });
  it('computes p50 and p95 by agent and model without inventing first output', () => {
    const events = Array.from({ length: 20 }, (_, i) => e('run_complete', 1000 + i * 100, { durationMs: i + 1, model: i % 2 ? 'm1' : 'm2' }));
    const result = latency(turns(events));
    expect(result.byAgent[0]!.durationMs).toEqual({ samples: 20, p50: 10, p95: 19 });
    expect(result.byAgent[0]!.firstOutputMs).toEqual({ samples: 0, p50: null, p95: null });
    expect(result.byModel).toHaveLength(2);
  });
  it('joins approvals to responders and distinguishes still waiting from answered', () => {
    const events = [e('approval', 10, { phase: 'requested', approvalId: 'a', tool: 'shell', input: { command: 'npm test' } }), e('approval', 40, { phase: 'decided', approvalId: 'a', behavior: 'allow', by: 'phone' }), e('approval', 50, { phase: 'requested', approvalId: 'b', tool: 'shell', input: { command: 'npm test' } })];
    const result = approvalInsights(events, 100);
    expect(result.rows[0]).toMatchObject({ by: 'phone', waitMs: 30 }); expect(result.rows[1]).toMatchObject({ by: null, waitMs: 50 });
    expect(result.commands[0]).toMatchObject({ count: 2, totalWaitMs: 80 }); expect(result.waitMs.samples).toBe(1);
  });
  it('compares adjacent half-open periods, with no infinity when the previous value is zero', () => {
    const events = [e('run_complete', 100, { costUsd: 1 }), e('run_complete', 200, { costUsd: 2 }), e('error', 250, { message: 'failed' }, 'b'), e('turn_diff', 240, { added: 5, removed: 3 })];
    const c = comparison(events, 100, 300);
    expect(c.previous).toEqual({ turns: 1, finishRate: 100, spend: 1, lines: 0 });
    expect(c.current).toEqual({ turns: 2, finishRate: 50, spend: 2, lines: 8 });
    expect(c.changes.lines).toMatchObject({ direction: 'up', percent: null }); expect(c.changes.finishRate!.direction).toBe('down');
  });
  it('adds period markers to the existing digest total', () => {
    const now = Date.now(); const d = digest([e('run_complete', now - 10, { costUsd: 1 })], now - 100);
    expect(d.lines[0]!.text).toContain('turns ↑'); expect(d.comparison?.current.turns).toBe(1);
  });
  it('unions overlapping work, excludes human waits and splits UTC midnight', () => {
    const midnight = Date.parse('2026-11-19T00:00:00Z');
    const events = [e('status', midnight - 1000, { state: 'turn_started' }), e('approval', midnight - 500, { phase: 'requested', approvalId: 'x' }), e('approval', midnight + 500, { phase: 'decided', approvalId: 'x' }), e('run_complete', midnight + 1000, {}), e('run_complete', midnight + 1000, { durationMs: 500 }, 'a', 'other')];
    const hours = agentHours(turns(events), 'project'); expect(hours.totalMs).toBe(1000); expect(hours.entries.map(r => r.activeMs)).toEqual([500, 500]);
    expect(hoursCsv({ ...hours, entries: [{ ...hours.entries[0]!, agent: '=evil,"' }] })).toContain('"\'=evil,"""');
  });
  it('includes interrupted and ongoing work only for the timesheet', () => {
    const events = [e('status', 100, { state: 'turn_started' }), e('status', 200, { state: 'interrupted' }), e('status', 300, { state: 'turn_started' })];
    expect(turns(events)).toHaveLength(0); expect(agentHours(turns(events, 400), 'p').totalMs).toBe(200);
  });
  it('counts edit operations once when a turn diff reports the same files', () => {
    const result = fileHotspots([e('file_edit', 1, { path: 'a.ts' }), e('file_edit', 2, { path: 'a.ts' }), e('turn_diff', 3, { files: [{ path: 'a.ts' }, { path: 'b.ts' }] }), e('checkpoint', 4, { reason: 'rewound', path: 'a.ts' })]);
    expect(result[0]).toMatchObject({ path: 'a.ts', edits: 2, reEdits: 1, rewinds: 1 }); expect(result[1]).toMatchObject({ path: 'b.ts', edits: 1 });
  });
  it('retains multiple errors in one turn and sorts updated completion times', () => {
    const rows = turns([e('status', 1, { state: 'turn_started' }), e('error', 2, { message: 'first' }), e('error', 3, { message: 'second' }), e('run_complete', 4, { model: 'other', durationMs: 1 }, 'b'), e('run_complete', 5, { model: 'm', costUsd: 2 })]);
    expect(rows).toHaveLength(2); expect(rows[1]).toMatchObject({ agent: 'a', error: 'first\nsecond', costUsd: 2, end: 5 });
  });
  it('does not count overlapping approval waits as active work', () => {
    const events = [e('status', 0, { state: 'turn_started' }), e('approval', 10, { phase: 'requested', approvalId: 'a' }), e('approval', 20, { phase: 'requested', approvalId: 'b' }), e('approval', 30, { phase: 'decided', approvalId: 'a' }), e('approval', 40, { phase: 'decided', approvalId: 'b' }), e('run_complete', 50)];
    expect(agentHours(turns(events), 'p').totalMs).toBe(20);
  });
  it('does not count downtime after a crash as live agent work', () => {
    const events = [e('status', 100, { state: 'turn_started' })];
    expect(agentHours(turns(events, 10000, new Set()), 'p').totalMs).toBe(0);
  });
  it('counts repeated orchestra task diffs once, in their completion period', () => {
    const task = { id: 't', agent: 'a', chat: 'task-chat', finishedAt: 150, files: ['task.ts'], diffStat: { insertions: 4, deletions: 2 } };
    const events = [e('orchestra', 150, { phase: 'task', runId: 'r', task }), e('orchestra', 250, { phase: 'task', runId: 'r', task })];
    const c = comparison(events, 100, 300); expect(c.previous.lines).toBe(6); expect(c.current.lines).toBe(0);
    expect(fileHotspots(events)[0]).toMatchObject({ path: 'task.ts', edits: 1, reEdits: 0 });
  });
  it('keeps cross-window tool and approval correlation when filtering', () => {
    const events = [e('tool_call', 50, { tool: 'shell', id: 't' }), e('tool_result', 100, { id: 't', ok: false }), e('approval', 60, { phase: 'requested', approvalId: 'a', tool: 'shell' }), e('approval', 110, { phase: 'decided', approvalId: 'a', by: 'phone' })];
    expect(toolAnalytics(events, { since: 40 }).byTool[0]).toMatchObject({ failureRate: 100, averageMs: 50 });
    expect(toolAnalytics(events, { since: 70 }).byTool).toEqual([]);
    expect(approvalInsights(events, 200, { since: 40 }).rows[0]).toMatchObject({ waitMs: 50, by: 'phone' });
  });
  it('validates windows and since values' , () => {
    expect(duration('7d')).toBe(604800000); expect(sinceTime('1h', 4000000)).toBe(400000);
    expect(() => duration('0d')).toThrow(); expect(() => sinceTime('garbage')).toThrow(); expect(() => duration('999d')).toThrow();
  });
});

describe('reliability rule semantics', () => {
  const rule = (s: string) => ({ ...parseAlert(s), id: 'r', paused: false, firing: false });
  const rows = turns([e('run_complete', 10, { durationMs: 120000 }), e('error', 20, { message: 'bad', durationMs: 240000 })]);
  it('requires the complete turn window', () => { expect(evaluateRule(rule('finish_rate < 70% over 20 turns'), rows, 0).value).toBeNull(); expect(evaluateRule(rule('finish_rate < 70% over 2 turns'), rows, 0).breached).toBe(true); });
  it('evaluates all reliability metrics and strict thresholds', () => {
    expect(evaluateRule(rule('turn_minutes > 2 over 2 turns'), rows, 0).value).toBe(3);
    expect(evaluateRule(rule('errors_per_hour > 0'), rows, 0, 100).breached).toBe(true);
    expect(evaluateRule(rule('errors_per_hour > 0'), rows, 0, 3600021).breached).toBe(false);
    expect(evaluateRule(rule('queue_depth > 3'), rows, 3).breached).toBe(false);
    expect(evaluateRule(rule('queue_depth > 3'), rows, 4).breached).toBe(true);
  });
  it('rejects spend metrics, invalid units and unbounded windows', () => {
    for (const text of ['spend > 5', 'finish_rate < 101% over 20 turns', 'turn_minutes > 5%', 'queue_depth > 5 over 3 turns', 'finish_rate < 70%', 'finish_rate < 70% over 0 turns']) expect(() => parseAlert(text)).toThrow();
  });
});

describe('R4 orphaned turn regression', () => {
  it.each([false, true])('replaces a day-old start (old output: %s)', oldOutput => {
    const start = Date.parse('2026-01-01T00:00:00Z'), next = start + 86_400_000;
    const rows = turns([e('status', start, { state: 'turn_started' }),
      ...(oldOutput ? [e('status', start + 100, { state: 'r4_first_output' })] : []),
      e('status', next, { state: 'turn_started' }), e('status', next + 200, { state: 'r4_first_output' }),
      e('run_complete', next + 60_000, { durationMs: 60_000 })]);
    expect(rows[0]).toMatchObject({ start: next, firstOutputMs: 200, durationMs: 60_000 });
    expect(agentHours(rows, 'p').totalMs).toBe(60_000);
  });
  it('replaces a start after output even within the duplicate grace period', () => {
    const rows = turns([e('status', 0, { state: 'turn_started' }), e('message', 100),
      e('status', 1000, { state: 'turn_started' }), e('message', 1200), e('run_complete', 2000)]);
    expect(rows[0]).toMatchObject({ start: 1000, durationMs: 1000, firstOutputMs: 200 });
  });
  it.each([false, true])('bounds start by reported duration and discards stale first output (error: %s)', failed => {
    const rows = turns([e('status', 0, { state: 'turn_started' }), e('message', 100),
      ...(failed ? [e('error', 69_000, { message: 'failed' })] : []),
      e('run_complete', 70_000, { durationMs: 60_000 })]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ start: 10_000, firstOutputMs: null });
    expect(agentHours(rows, 'p').totalMs).toBe(60_000);
  });
});
