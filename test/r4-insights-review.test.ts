import { afterEach, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import type { Express } from 'express';
import type { ProjectRuntime } from '../src/daemon/runtime.js';
import type { WithRuntime } from '../src/daemon/routes/context.js';
import { registerInsightsR4 } from '../src/daemon/routes/insights-r4.js';
import { approvalInsights, comparison, latency, turns } from '../src/observability/r4/analytics.js';
import { formatInsight } from '../src/cli/r4-insights.js';
import type { LoomEvent } from '../src/types.js';
import { mountR4Insights } from '../src/web/project/insights-r4.js';
import { api } from '../src/web/connection.js';

vi.mock('../src/web/connection.js', () => ({ api: vi.fn() }));
vi.mock('../src/web/state.js', () => ({ state: {} }));
vi.mock('../src/web/format.js', () => ({ esc: (s: unknown) => String(s ?? '').replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`) }));
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.clearAllMocks(); });
const requests: LoomEvent[] = ['Bash', 'SHELL', 'run', 'run_command', 'exec_command', 'execute', 'terminal', 'Read'].map((tool, i) => ({
  id: i + 1, ts: 100, kind: 'approval', agentId: 'a', payload: { phase: 'requested', approvalId: String(i), tool, input: { command: tool === 'Read' ? 'a.txt' : 'git status' } },
}));

it('rejects every shell class at the actual route handler and preserves owner-only non-shell writes', async () => {
  vi.useFakeTimers();
  const app = { use: vi.fn(), get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() } as unknown as Express;
  const rt = { log: { list: () => requests }, safetyPolicy: () => ({ allow: [] }), setSafetyPolicy: vi.fn(p => p) } as unknown as ProjectRuntime;
  const withRuntime = ((handler: any) => (req: any, res: any) => handler(rt, req, res)) as WithRuntime;
  registerInsightsR4(app, withRuntime, { runtimes: new Map(), runtime: vi.fn() }, () => undefined);
  const handler = vi.mocked(app.post).mock.calls.find(c => c[0] === '/api/projects/:id/insights/approvals/allow')![1] as any;
  const res = { status: vi.fn(), json: vi.fn() }; res.status.mockReturnValue(res);
  for (const event of requests.slice(0, -1)) {
    await handler({ body: { eventId: event.id } }, res);
    expect(res.status).toHaveBeenLastCalledWith(400);
    expect(res.json).toHaveBeenLastCalledWith({ error: 'Shell tools cannot be allow-listed by command; use Safety settings.' });
  }
  expect(rt.setSafetyPolicy).not.toHaveBeenCalled();
  await handler({ body: { eventId: 8 }, projectScope: ['p'] }, res);
  expect(res.status).toHaveBeenLastCalledWith(403); expect(rt.setSafetyPolicy).not.toHaveBeenCalled();
  await handler({ body: { eventId: 8 } }, res);
  expect(rt.setSafetyPolicy).toHaveBeenCalledExactlyOnceWith({ allow: ['Read'] });
});

it('hides shell suggestions and requires confirmation before posting a non-shell allow rule', async () => {
  const dom = new JSDOM('<main></main>', { url: 'https://loom.test/' });
  vi.stubGlobal('document', dom.window.document); vi.stubGlobal('localStorage', dom.window.localStorage);
  const confirm = vi.fn(() => false); vi.stubGlobal('confirm', confirm);
  const report = { approvals: { ...approvalInsights(requests, 200), canAddAllowRule: true }, compare: comparison([], 100, 200),
    tools: { byTool: [], byAgent: [] }, latency: latency([]), errors: [], files: { rows: [] }, hours: { entries: [] } };
  vi.mocked(api).mockImplementation(async (url: string) => url.includes('/insights/r4') ? report : url.includes('/events/query') ? { events: [] } : { rules: [] });
  try {
    mountR4Insights(dom.window.document.querySelector('main'), { id: 'p' });
    await vi.waitFor(() => expect(dom.window.document.querySelectorAll('[data-allow]')).toHaveLength(1));
    expect(dom.window.document.body.textContent?.match(/Shell: review each command/g)).toHaveLength(7);
    const button = dom.window.document.querySelector('[data-allow]') as HTMLButtonElement;
    button.click();
    expect(confirm).toHaveBeenCalledWith('Allow every Read call in this project without asking?');
    expect(vi.mocked(api).mock.calls.filter(c => c[1]?.method === 'POST')).toHaveLength(0);
    expect(button.disabled).toBe(false);
    confirm.mockReturnValue(true); button.click();
    await vi.waitFor(() => expect(button.textContent).toBe('Allow rule added'));
    expect(api).toHaveBeenCalledWith('/api/projects/p/insights/approvals/allow', { method: 'POST', body: '{"eventId":8}' });
  } finally { dom.window.close(); }
});

it('formats CLI metrics, example links, unavailable measurements, and empty results as text', () => {
  const rows = turns([{ id: 1, ts: 100, kind: 'run_complete', agentId: 'a', payload: { model: 'm', durationMs: 50 } }]);
  const output = formatInsight('latency', { latency: latency(rows) });
  expect(output).toContain('Per agent\na: first output p50/p95 unmeasured/unmeasured ms · turn p50/p95 50.0/50.0 ms');
  expect(output).toContain('Per model\nm:');
  expect(formatInsight('approvals', { approvals: approvalInsights(requests, 200) })).toContain('1 × git status (Bash) · 100.0 ms total wait');
  expect(formatInsight('errors', { errors: [{ count: 2, error: 'failed', lastSeen: 100, examples: [{ href: '/app#p/p/c/main/m/1' }] }] })).toBe('2 × failed · last seen 1970-01-01T00:00:00.100Z\n  /app#p/p/c/main/m/1');
  expect(formatInsight('files', { files: { rows: [{ path: 'a.txt', edits: 3, reEdits: 2, rewinds: 1 }], unavailableRewinds: 2 } })).toBe('a.txt: 3 edits · 2 re-edits · 1 rewinds\n2 older rewinds no longer have checkpoint trees.');
  for (const [name, value] of Object.entries({ latency: latency([]), approvals: approvalInsights([]), errors: [], files: { rows: [] } })) {
    expect(formatInsight(name, { [name]: value })).toBe('Nothing recorded yet.');
  }
});
