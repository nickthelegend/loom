import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { setImmediate } from 'node:timers/promises';
import { execFileSync } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { LoomDaemon } from '../src/daemon/server.js';
import { DaemonClient } from '../src/daemon/client.js';
import type { LiveDeltaThrottle } from '../src/providers/live.js';
import type { ProjectRuntime } from '../src/daemon/runtime.js';
import { readDaemonConfig } from '../src/core/registry.js';
import { checkRules } from '../src/observability/r4/runtime.js';
import { readRules } from '../src/observability/r4/alerts.js';
import { insightsRequest, formatInsight, registerR4Insights } from '../src/cli/r4-insights.js';
import { Command } from 'commander';
import { makeProjectDir, tmpDir, waitUntil } from './helpers.js';

let daemon: LoomDaemon, client: DaemonClient, rt: ProjectRuntime, base: string, id: string, other: string, token: string, phone: string, scoped: string, guest: string, dir: string, pushServer: http.Server;
const pushes: Array<Record<string, any>> = [];
const headers = (t = token) => ({ authorization: `Bearer ${t}`, 'content-type': 'application/json' });
async function raw(route: string, method = 'GET', body?: unknown, t = token) { return fetch(base + route, { method, headers: headers(t), ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); }
async function req(route: string, method = 'GET', body?: unknown, t = token): Promise<any> { const r = await raw(`/api/projects/${id}${route}`, method, body, t); const j = await r.json(); if (!r.ok) throw new Error(JSON.stringify(j)); return j; }
async function pair(body: unknown, name: string) {
  const minted = await (await raw('/api/pair/new', 'POST', body)).json() as { token: string };
  const claimed = await (await raw('/api/pair/claim', 'POST', { token: minted.token, name })).json() as { clientToken: string };
  return claimed.clientToken;
}
beforeAll(async () => {
  process.env.LOOM_HOME = tmpDir('r4-home'); process.env.LOOM_NO_NOTIFY = '1';
  pushServer = http.createServer((request, response) => { let body = ''; request.on('data', chunk => body += chunk); request.on('end', () => { const messages = JSON.parse(body); pushes.push(...(Array.isArray(messages) ? messages : [messages])); response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ data: [{ status: 'ok', id: 'push-1' }] })); }); });
  await new Promise<void>(r => pushServer.listen(0, '127.0.0.1', r));
  process.env.LOOM_EXPO_PUSH_URL = `http://127.0.0.1:${(pushServer.address() as AddressInfo).port}`;
  daemon = new LoomDaemon({ host: '127.0.0.1', port: 0 }); const address = await daemon.listen(); base = `http://${address.host}:${address.port}`;
  token = readDaemonConfig()!.adminToken; client = new DaemonClient(readDaemonConfig()!);
  dir = makeProjectDir({ name: 'insights', agents: [{ id: 'echo', kind: 'echo', role: 'test' }] });
  execFileSync('git', ['init', '-q'], { cwd: dir }); fs.writeFileSync(path.join(dir, '.gitignore'), '.loom/\n'); fs.writeFileSync(path.join(dir, 'a.txt'), 'before\n');
  execFileSync('git', ['add', '.'], { cwd: dir }); execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@test', 'commit', '-qm', 'seed'], { cwd: dir });
  id = (await client.addProject(dir)).project.id; other = (await client.addProject(makeProjectDir())).project.id;
  rt = await (daemon as unknown as { runtime(id: string): Promise<ProjectRuntime> }).runtime(id);
  phone = await pair({}, 'owner-phone'); scoped = await pair({ projects: [id] }, 'scoped-phone'); guest = await pair({ guest: { project: id, chat: 'main', role: 'view', name: 'guest', hours: 1 } }, 'guest');
  for (const [device, push] of [[phone, 'ExponentPushToken[owner]'], [scoped, 'ExponentPushToken[scoped]'], [guest, 'ExponentPushToken[guest]']]) {
    expect((await raw('/api/push/register', 'POST', { token: push, kinds: ['goals'] }, device)).status).toBe(device === guest ? 403 : 200);
  }
}, 30000);
afterAll(async () => { await daemon?.close(); await new Promise<void>(r => pushServer.close(() => r())); delete process.env.LOOM_EXPO_PUSH_URL; });

describe('R4 full project API', () => {
  it('does not open a runtime for existing worktree or terminal routes', async () => {
    const idleDir = makeProjectDir(); execFileSync('git', ['init', '-q'], { cwd: idleDir });
    const idleId = (await client.addProject(idleDir)).project.id;
    const runtimes = (daemon as unknown as { runtimes: Map<string, ProjectRuntime> }).runtimes;
    expect(runtimes.has(idleId)).toBe(false);
    expect((await raw(`/api/projects/${idleId}/worktrees`)).status).toBe(200);
    expect((await raw(`/api/projects/${idleId}/term/signal`, 'POST', { term: 'absent' })).status).toBe(200);
    expect(runtimes.has(idleId)).toBe(false);
  });
  it('observes a real echo turn, tool call, stream latency, diff and timesheet', async () => {
    await client.send(id, 'run: npm test\nwrite:a.txt stream:5');
    await waitUntil(() => rt.log.list({ kinds: ['run_complete'] }).length > 0 && rt.log.list({ kinds: ['turn_diff'] }).length > 0);
    const data = await req('/insights/r4');
    expect(data.tools.byTool.find((r: any) => r.name === 'shell')).toMatchObject({ calls: 1, failureRate: 0 });
    expect(data.latency.byAgent[0].firstOutputMs.samples).toBe(1); expect(data.latency.byModel[0].name).toBe('echo-1');
    expect(data.hours.totalMs).toBeGreaterThan(0); expect(data.files.rows.find((r: any) => r.path === 'a.txt').edits).toBe(1);
    expect(data.compare.current.turns).toBe(1);
    const csv = await raw(`/api/projects/${id}/insights/hours?format=csv`); expect(csv.headers.get('content-type')).toContain('text/csv'); expect(await csv.text()).toContain('project,agent,day,active_hours');
  });
  it('records native tool progress timings without adding duplicate calls', async () => {
    const live = (rt as unknown as { live: LiveDeltaThrottle }).live;
    rt.log.append({ kind: 'status', agentId: 'native-fixture', payload: { state: 'turn_started' } });
    live.pushItem({ agentId: 'native-fixture', chat: 'main', itemId: 'item-1', phase: 'started', itemType: 'command_execution' });
    await new Promise(resolve => setTimeout(resolve, 15));
    live.pushItem({ agentId: 'native-fixture', chat: 'main', itemId: 'item-1', phase: 'completed', itemType: 'command_execution' });
    const tool = rt.log.append({ kind: 'tool_call', agentId: 'native-fixture', payload: { tool: 'native-shell', ok: true } });
    rt.log.append({ kind: 'run_complete', agentId: 'native-fixture', payload: { model: 'fixture' } });
    const measurement = rt.log.list({ kinds: ['status'] }).find(e => e.payload.toolEventId === tool.id);
    expect(measurement?.payload.durationMs).toBeGreaterThanOrEqual(10);
    const row = (await req('/insights/tools?agent=native-fixture')).tools.byAgent[0];
    expect(row.calls).toBe(1); expect(row.averageMs).toBeGreaterThanOrEqual(10);
  });
  it('reconstructs full rewind paths from saved checkpoint trees', async () => {
    const checkpoint = rt.log.list({ kinds: ['checkpoint'] }).find(e => e.payload.reason !== 'rewound')!;
    await req(`/checkpoints/${checkpoint.payload.id}/rewind`, 'POST');
    await waitUntil(() => rt.log.list({ kinds: ['status'] }).some(e => e.payload.state === 'r4_rewind_files'));
    const { files } = await req('/insights/files'); expect(files.rows.find((r: any) => r.path === 'a.txt').rewinds).toBe(1);
    expect(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8')).toBe('before\n');
  });
  it('returns filtered and paginated events without losing payloads', async () => {
    rt.log.append({ kind: 'tool_call', agentId: 'echo', payload: { tool: '<script>bad</script>', ok: false } });
    const first = await req('/events/query?type=tool_call&agent=echo&since=1h&limit=1'); expect(first.events).toHaveLength(1); expect(first.nextBefore).toBeTruthy();
    const second = await req(`/events/query?type=tool_call&agent=echo&limit=1&before=${first.nextBefore}`); expect(second.events[0].id).toBeLessThan(first.events[0].id);
    for (const query of ['limit=NaN', 'limit=999', 'since=nope', 'before=-1']) expect((await raw(`/api/projects/${id}/events/query?${query}`)).status).toBe(400);
    expect((await raw(`/api/projects/${id}/insights/compare?period=nope`)).status).toBe(400);
  });
  it('groups failures and exposes the answering phone and owner allow action', async () => {
    const start = Date.now() - 500;
    const asked = rt.log.append({ kind: 'approval', ts: start, agentId: 'echo', payload: { phase: 'requested', approvalId: 'approval-test', tool: 'shell', input: { command: 'npm test' } } });
    rt.log.append({ kind: 'approval', ts: start + 200, agentId: 'echo', payload: { phase: 'decided', approvalId: 'approval-test', behavior: 'allow', by: 'owner-phone' } });
    const approvals = (await req('/insights/approvals')).approvals;
    expect(approvals.rows[0]).toMatchObject({ by: 'owner-phone', waitMs: 200, command: 'npm test' });
    expect((await raw(`/api/projects/${id}/insights/approvals/allow`, 'POST', { eventId: asked.id }, scoped)).status).toBe(403);
    expect(approvals.commands.find((r: any) => r.tool === 'shell').allowable).toBe(false);
    const allowed = rt.log.append({ kind: 'approval', agentId: 'echo', payload: { phase: 'requested', approvalId: 'read-test', tool: 'Read' } });
    expect((await req('/insights/approvals/allow', 'POST', { eventId: allowed.id }, phone)).policy.allow).toContain('Read');
    for (const tool of ['Bash', 'SHELL', 'run', 'run_command', 'exec_command', 'execute', 'terminal']) {
      const event = rt.log.append({ kind: 'approval', payload: { phase: 'requested', approvalId: tool, tool, input: { command: 'git status' } } });
      const response = await raw(`/api/projects/${id}/insights/approvals/allow`, 'POST', { eventId: event.id }, phone);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: 'Shell tools cannot be allow-listed by command; use Safety settings.' });
      expect(rt.safetyPolicy().allow).not.toContain(tool);
    }
    expect((await req('/insights/approvals')).approvals.commands.find((r: any) => r.tool === 'Read').allowable).toBe(true);
    for (const n of [1, 2]) { rt.log.append({ kind: 'status', agentId: 'echo', payload: { state: 'turn_started' } }); rt.log.append({ kind: 'error', agentId: 'echo', payload: { message: `Request ${n} failed` } }); rt.log.append({ kind: 'run_complete', agentId: 'echo', payload: { durationMs: 10, model: 'echo-1' } }); }
    const errors = (await req('/insights/errors')).errors; expect(errors[0].count).toBe(2); expect(errors[0].examples[0].eventId).toBeGreaterThan(0); expect(errors[0].examples[0].href).toContain(`/app#p/${id}/c/main/m/`);
  });
  it('follows project scope and refuses guests on every new route', async () => {
    for (const path of ['/insights/tools', '/insights/latency', '/insights/approvals', '/insights/errors', '/insights/compare', '/insights/files', '/insights/hours', '/insights/r4', '/events/query', '/alerts']) {
      expect((await raw(`/api/projects/${id}${path}`, 'GET', undefined, scoped)).status).toBe(200);
      expect((await raw(`/api/projects/${other}${path}`, 'GET', undefined, scoped)).status).toBe(403);
      expect((await raw(`/api/projects/${id}${path}`, 'GET', undefined, guest)).status).toBe(403);
    }
    expect((await req('/insights/approvals', 'GET', undefined, scoped)).approvals.canAddAllowRule).toBe(false);
    expect((await req('/insights/approvals', 'GET', undefined, phone)).approvals.canAddAllowRule).toBe(true);
  });
  it('creates, evaluates, pauses and tests persistent rules through project-scoped and owner devices', async () => {
    const { rule } = await req('/alerts', 'POST', { expression: 'finish_rate < 90% over 2 turns' }, scoped);
    await waitUntil(() => rt.log.list({ kinds: ['status'] }).some(e => e.payload.state === 'r4_alert' && e.payload.ruleId === rule.id));
    await waitUntil(() => pushes.some(p => p.data?.ruleId === rule.id));
    expect(pushes.filter(p => p.data?.ruleId === rule.id).map(p => p.to).sort()).toEqual(['ExponentPushToken[owner]', 'ExponentPushToken[scoped]']);
    const before = rt.log.list({ kinds: ['status'] }).filter(e => e.payload.ruleId === rule.id).length;
    checkRules(rt); expect(rt.log.list({ kinds: ['status'] }).filter(e => e.payload.ruleId === rule.id)).toHaveLength(before);
    await req(`/alerts/${rule.id}`, 'PATCH', { paused: true }, phone); expect(readRules(id)[0]!.paused).toBe(true);
    expect((await req(`/alerts/${rule.id}/test`, 'POST', undefined, phone)).test).toBe(true);
    expect((await req('/alerts')).rules[0].paused).toBe(true);
    expect((await raw(`/api/projects/${id}/alerts`, 'POST', { expression: 'spend > 5' })).status).toBe(400);
    expect((await raw(`/api/projects/${id}/alerts/${rule.id}`, 'PATCH', { paused: 'false' })).status).toBe(400);
    expect((await raw(`/api/projects/${id}/alerts`, 'POST', { expression: 'queue_depth > 1' }, guest)).status).toBe(403);
    await req(`/alerts/${rule.id}`, 'DELETE'); expect((await req('/alerts')).rules).toEqual([]);
  });
  it('executes the CLI against only the isolated test daemon', async () => {
    const previous = process.cwd(); process.chdir(dir);
    const output: string[] = [];
    const write = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: any) => { output.push(String(chunk)); return true; });
    const log = vi.spyOn(console, 'log').mockImplementation((text: string) => { output.push(text + '\n'); });
    const invoke = async (args: string[]) => { output.length = 0; const command = new Command(); registerR4Insights(command); await command.parseAsync(args, { from: 'user' }); return output.join(''); };
    try {
      for (const name of ['tools', 'latency', 'approvals', 'errors', 'compare', 'files', 'hours']) expect(JSON.parse(await invoke(['insights', name, '--json']))).toHaveProperty(name);
      expect(await invoke(['insights', 'latency'])).toMatch(/Per agent\n.*first output p50\/p95.*turn p50\/p95[\s\S]*Per model/);
      expect(await invoke(['insights', 'approvals'])).toMatch(/Answered wait p50\/p95[\s\S]*× npm test \(shell\) · .* ms total wait/);
      expect(await invoke(['insights', 'errors'])).toMatch(/2 × request <n> failed · last seen .*Z\n  \/app#p\//);
      expect(await invoke(['insights', 'files'])).toMatch(/a.txt: \d+ edits · \d+ re-edits · \d+ rewinds/);
      expect(await invoke(['insights', 'hours', '--csv'])).toContain('project,agent,day,active_hours');
      expect(JSON.parse(await invoke(['events', '--type', 'tool_call', '--agent', 'echo', '--since', '1h', '--json'])).events.every((e: any) => e.kind === 'tool_call')).toBe(true);
      const created = JSON.parse(await invoke(['alerts', 'add', 'queue_depth > 100']));
      expect(JSON.parse(await invoke(['alerts', 'list'])).rules.some((r: any) => r.id === created.rule.id)).toBe(true);
      expect(JSON.parse(await invoke(['alerts', 'pause', created.rule.id])).rule.paused).toBe(true);
      expect(JSON.parse(await invoke(['alerts', 'test', created.rule.id])).test).toBe(true);
      await invoke(['alerts', 'remove', created.rule.id]);
    } finally { write.mockRestore(); log.mockRestore(); process.chdir(previous); }
  });
  it('uses the real daemon client transport for all insights and registers the CLI commands', async () => {
    for (const name of ['tools', 'latency', 'approvals', 'errors', 'compare', 'files', 'hours']) {
      const data = await insightsRequest(client, id, `/insights/${name}`); expect(data).toHaveProperty(name); expect(formatInsight(name, data)).toBeTruthy();
    }
    const command = new Command(); registerR4Insights(command);
    expect(command.commands.map(c => c.name())).toEqual(['insights', 'events', 'alerts']);
    expect(command.commands[0]!.commands.map(c => c.name())).toContain('hours');
    expect(command.commands[1]!.options.map(o => o.long)).toEqual(expect.arrayContaining(['--type', '--agent', '--since', '--json']));
  });
  it('compares full digest periods even when the narrative event limit is exceeded', async () => {
    const now = Date.now();
    rt.log.append({ kind: 'run_complete', ts: now - 90 * 60_000, agentId: 'historical', payload: { durationMs: 100, costUsd: 2 } });
    for (let i = 0; i < 4001; i++) {
      rt.log.append({ kind: 'status', payload: { state: 'fixture' } });
      // Thousands of synchronous disk writes starve the in-process HTTP server
      // on Windows. Let socket close/keep-alive timers run while seeding data.
      if (i % 25 === 0) await setImmediate();
    }
    await setImmediate();
    const result = await req(`/digest?since=${now - 60 * 60_000}`);
    expect(result.comparison.previous.turns).toBe(1); expect(result.lines[0].text).toContain('vs previous:');
  });
  it('restores persisted rules without requiring an insights page to open', async () => {
    const { rule } = await req('/alerts', 'POST', { expression: 'queue_depth > 100' });
    await daemon.close();
    daemon = new LoomDaemon({ host: '127.0.0.1', port: 0 }); const address = await daemon.listen(); base = `http://${address.host}:${address.port}`;
    token = readDaemonConfig()!.adminToken;
    await waitUntil(() => (daemon as unknown as { runtimes: Map<string, ProjectRuntime> }).runtimes.has(id));
    expect((await req('/alerts')).rules.find((r: any) => r.id === rule.id)).toMatchObject({ expression: 'queue_depth > 100', paused: false, firing: false });
  });
});

it('formats empty CLI insights and unavailable rewind history as text', () => {
  for (const [name, data] of Object.entries({ latency: { byAgent: [], byModel: [] }, approvals: { commands: [] }, errors: [], files: { rows: [], unavailableRewinds: 0 } })) {
    expect(formatInsight(name, { [name]: data })).toBe('Nothing recorded yet.');
  }
  expect(formatInsight('files', { files: { rows: [], unavailableRewinds: 2 } })).toContain('2 older rewinds no longer have checkpoint trees.');
});
