import fs from 'node:fs';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { EventLog } from '../src/core/eventlog.js';
import { liveWorkspace } from '../src/core/workspace-r4/live.js';
import { dormantState } from '../src/core/workspace-r4/paused.js';
import { dismiss } from '../src/core/workspace-r4/store.js';
import { inbox, mission } from '../src/daemon/routes/workspace-r4.js';
import type { ProjectRuntime } from '../src/daemon/runtime.js';
import { tmpDir } from './helpers.js';

afterEach(() => vi.restoreAllMocks());
it('bounds the initial projection and updates inbox/mission from events without further log queries', async () => {
  process.env.LOOM_HOME = tmpDir('r4-cache-home');
  const dir = tmpDir('r4-cache'), log = await EventLog.open(path.join(dir, '.loom'));
  try {
    log.append({ kind: 'error', ts: Date.now() - 15 * 86400000, agentId: 'old', payload: { message: 'historic' } });
    for (let i = 0; i < 2100; i++) log.append({ kind: 'message', agentId: 'echo', payload: { text: 'history' } });
    const query = vi.spyOn(log, 'list');
    const roster = vi.fn(() => { throw new Error('Must not enumerate 400 historical chats'); });
    const liveAgent = vi.fn(() => ({ id: 'isolated', busy: () => true }));
    const rt = { info: { id: 'p', dir, name: 'Project' }, log, chats: roster, activity: () => ({ agents: [] }),
      orchestra: { list: () => [{ id: 'old', status: 'completed', chat: 'past', tasks: [] }, { id: 'run', status: 'running', chat: 'control', tasks: [{ chat: 'worker', status: 'pending' }] }], liveAgent },
      crews: { list: () => [], liveAgent: () => null }, liveNow: () => [], routes: { state: () => null }, queue: { snapshot: () => ({ items: [], paused: false }) },
    } as unknown as ProjectRuntime;
    fs.writeFileSync(path.join(process.env.LOOM_HOME!, 'registry.json'), JSON.stringify({ projects: [rt.info] }));
    const ctx = { runtimes: new Map([['p', rt]]), approvals: new Map() };
    const projection = liveWorkspace(log);
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0]![0]).toMatchObject({ limit: 2000, kinds: ['needs_input', 'status', 'run_complete', 'error', 'message'], sinceTs: expect.any(Number) });
    expect(projection.items(dir)).toEqual([]);
    expect(mission(ctx).chats).toEqual([]);
    const failed = log.append({ kind: 'error', agentId: 'echo', payload: { message: 'new failure' } });
    expect(projection.items(dir)[0]?.eventId).toBe(failed.id);
    dismiss(dir, failed.id); expect(projection.items(dir)).toEqual([]);
    log.append({ kind: 'status', chat: 'worker', agentId: 'isolated', payload: { state: 'turn_started', orchestra: { runId: 'run' } } });
    log.append({ kind: 'message', chat: 'worker', agentId: 'isolated', payload: { text: 'latest line', orchestra: { runId: 'run' } } });
    log.append({ kind: 'status', chat: 'worker', payload: { state: 'turn_cost', costUsd: 0.12 } });
    const current = mission(ctx);
    expect(current.chats).toHaveLength(1);
    expect(current.chats[0]).toMatchObject({ chat: 'worker', lastLine: 'latest line', costUsd: 0.12, stopScope: 'run' });
    for (let i = 0; i < 10; i++) { mission(ctx); await inbox(ctx); }
    expect(query).toHaveBeenCalledTimes(1); expect(roster).not.toHaveBeenCalled();
    log.append({ kind: 'run_complete', chat: 'worker', agentId: 'isolated', payload: { orchestra: { runId: 'run' } } });
    expect(mission(ctx).chats).toEqual([]);
    expect(query).toHaveBeenCalledTimes(1);
  } finally { log.close(); }
});
it('does not open dormant logs and reuses paused state until directory or file metadata changes', async () => {
  process.env.LOOM_HOME = tmpDir('r4-dormant-home');
  const dir = tmpDir('r4-dormant'), runDir = path.join(dir, '.loom/orchestra');
  fs.mkdirSync(runDir, { recursive: true });
  const file = path.join(runDir, 'run.json'); fs.writeFileSync(file, JSON.stringify({ id: 'run', status: 'waiting_human' }));
  const first = dormantState(dir), reads = vi.spyOn(fs, 'readFileSync');
  expect(dormantState(dir).runs).toBe(first.runs); expect(reads).not.toHaveBeenCalled();
  fs.writeFileSync(file, JSON.stringify({ id: 'run', status: 'completed' }));
  expect(dormantState(dir).runs[0]?.status).toBe('completed');
  fs.writeFileSync(path.join(process.env.LOOM_HOME!, 'registry.json'), JSON.stringify({ projects: [{ id: 'p', name: 'Dormant', dir }] }));
  const open = vi.spyOn(EventLog, 'open');
  await inbox({ runtimes: new Map(), approvals: new Map() }); expect(open).not.toHaveBeenCalled();
});
it('ages out cached unresolved failures without a new event or history scan', async () => {
  const dir = tmpDir('r4-expiry'), log = await EventLog.open(path.join(dir, '.loom'));
  try {
    const at = Date.now(); log.append({ kind: 'error', ts: at, agentId: 'echo', payload: { message: 'failed' } });
    const view = liveWorkspace(log), query = vi.spyOn(log, 'list'); expect(view.items(dir)).toHaveLength(1);
    vi.spyOn(Date, 'now').mockReturnValue(at + 15 * 86400000);
    expect(view.items(dir)).toEqual([]); expect(query).not.toHaveBeenCalled();
  } finally { log.close(); }
});
