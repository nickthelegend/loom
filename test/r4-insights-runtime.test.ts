import fs from 'node:fs';
import { EventEmitter } from 'node:events';
import type { Server } from 'node:http';
import type { Express } from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectRuntime } from '../src/daemon/runtime.js';
import type { WithRuntime } from '../src/daemon/routes/context.js';
import { registerInsightsR4 } from '../src/daemon/routes/insights-r4.js';
import { addRule, readRules, writeRules } from '../src/observability/r4/alerts.js';
import { checkRules } from '../src/observability/r4/runtime.js';
import { tmpDir } from './helpers.js';

function fixture() {
  const events = new EventEmitter(), queue = new EventEmitter();
  const listen = (bus: EventEmitter) => (fn: (...args: any[]) => void) => { bus.on('event', fn); return () => bus.off('event', fn); };
  const rt = {
    info: { id: 'p' }, log: { list: vi.fn(() => []), onEvent: listen(events), append: vi.fn() },
    queue: { snapshot: () => ({ items: [] }) }, onQueueChange: listen(queue),
    onStream: () => vi.fn(), onLiveDelta: () => vi.fn(),
  } as unknown as ProjectRuntime;
  return { rt, events, queue };
}

beforeEach(() => { vi.stubEnv('LOOM_HOME', tmpDir('r4-runtime')); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe('R4 bounded alert checks', () => {
  it('caches rule reads, isolates callers, and invalidates on writes', () => {
    addRule('p', 'queue_depth > 3');
    const read = vi.spyOn(fs, 'readFileSync');
    const first = readRules('p'); first[0]!.paused = true;
    expect(readRules('p')[0]!.paused).toBe(false);
    expect(read).toHaveBeenCalledTimes(1);
    writeRules('p', first);
    expect(readRules('p')[0]!.paused).toBe(true);
    expect(read).toHaveBeenCalledTimes(2);
    readRules('empty'); readRules('empty');
    expect(read).toHaveBeenCalledTimes(3);
  });
  it('skips event reads for queue-only and paused rules', () => {
    const { rt } = fixture();
    addRule('p', 'queue_depth > 3');
    const rule = addRule('p', 'errors_per_hour > 3'); rule.paused = true;
    writeRules('p', [readRules('p')[0]!, rule]);
    checkRules(rt);
    expect(rt.log.list).not.toHaveBeenCalled();
  });
  it('uses an hour cutoff and the largest turn window, capped at 20,000 events', () => {
    const { rt } = fixture(), now = 10_000_000;
    addRule('p', 'errors_per_hour > 3');
    checkRules(rt, now);
    expect(rt.log.list).toHaveBeenCalledExactlyOnceWith({ sinceTs: now - 3_600_000 });
    vi.mocked(rt.log.list).mockClear();
    addRule('p', 'finish_rate < 70% over 20 turns'); addRule('p', 'turn_minutes > 5 over 30 turns');
    checkRules(rt, now);
    expect(rt.log.list).toHaveBeenCalledTimes(2);
    expect(rt.log.list).toHaveBeenCalledWith({ limit: 6000 });
    expect(rt.log.list).toHaveBeenCalledWith({ sinceTs: now - 3_600_000 });
    vi.mocked(rt.log.list).mockClear();
    addRule('p', 'finish_rate < 70% over 10000 turns'); checkRules(rt, now);
    expect(rt.log.list).toHaveBeenCalledWith({ limit: 20000 });
  });
  it('recovers errors-per-hour firing state when the hour expires without new events', () => {
    const { rt } = fixture(), now = 10_000_000;
    const rule = addRule('p', 'errors_per_hour > 0'); rule.firing = true; writeRules('p', [rule]);
    checkRules(rt, now);
    expect(readRules('p')[0]!.firing).toBe(false);
    expect(rt.log.list).toHaveBeenCalledWith({ sinceTs: now - 3_600_000 });
    expect(rt.log.append).not.toHaveBeenCalled();
  });
  it('checks only dirty runtimes or once per minute and removes listeners on close', () => {
    vi.useFakeTimers();
    const { rt, events, queue } = fixture();
    addRule('p', 'errors_per_hour > 3');
    const server = Object.assign(new EventEmitter(), { listening: true });
    const app = { use: vi.fn(), get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() } as unknown as Express;
    const runtimes = new Map([['p', rt]]);
    registerInsightsR4(app, (h => h) as unknown as WithRuntime, { runtimes, runtime: vi.fn() }, () => server as Server);
    vi.advanceTimersByTime(1000); expect(rt.log.list).toHaveBeenCalledTimes(1);
    events.emit('event', { kind: 'status', payload: { state: 'r4_alert' } });
    events.emit('event', { kind: 'tool_call', payload: {} });
    vi.advanceTimersByTime(59_000); expect(rt.log.list).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1000); expect(rt.log.list).toHaveBeenCalledTimes(2);
    for (const event of [{ kind: 'run_complete', payload: {} }, { kind: 'error', payload: {} }, { kind: 'status', payload: { state: 'interrupted' } }]) {
      events.emit('event', event); vi.advanceTimersByTime(1000);
    }
    expect(rt.log.list).toHaveBeenCalledTimes(5);
    queue.emit('event'); vi.advanceTimersByTime(1000); expect(rt.log.list).toHaveBeenCalledTimes(6);
    runtimes.clear(); vi.advanceTimersByTime(1000);
    expect(events.listenerCount('event')).toBe(0); expect(queue.listenerCount('event')).toBe(0);
    runtimes.set('p', rt); vi.advanceTimersByTime(1000);
    server.emit('close');
    expect(events.listenerCount('event')).toBe(0); expect(queue.listenerCount('event')).toBe(0);
    const calls = vi.mocked(rt.log.list).mock.calls.length;
    vi.advanceTimersByTime(60_000); expect(rt.log.list).toHaveBeenCalledTimes(calls);
  });
  it('registers only send and digest hooks, attaching before the first send', async () => {
    vi.useFakeTimers();
    const { rt, events } = fixture();
    const app = { use: vi.fn(), get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() } as unknown as Express;
    const runtime = vi.fn(async () => rt);
    registerInsightsR4(app, (h => h) as unknown as WithRuntime, { runtimes: new Map(), runtime }, () => undefined);
    expect(app.use).toHaveBeenCalledTimes(1);
    const [path, send] = vi.mocked(app.use).mock.calls[0]!;
    expect(path).toBe('/api/projects/:id/messages');
    const next = vi.fn();
    send({ method: 'GET', params: { id: 'p' } }, {}, next);
    expect(runtime).not.toHaveBeenCalled(); expect(next).toHaveBeenCalledOnce();
    const attachedNext = vi.fn(() => expect(events.listenerCount('event')).toBe(2));
    send({ method: 'POST', params: { id: 'p' } }, {}, attachedNext);
    await Promise.resolve();
    expect(runtime).toHaveBeenCalledExactlyOnceWith('p'); expect(attachedNext).toHaveBeenCalledOnce();
    expect(vi.mocked(app.get).mock.calls[0]![0]).toBe('/api/projects/:id/digest');
  });
});
