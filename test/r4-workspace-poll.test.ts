import fs from 'node:fs';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import { expect, it, vi } from 'vitest';

it('windows, pane panels and badge consumers share one read per credential per ten seconds', async () => {
  const source = fs.readFileSync(new URL('../src/web/workspace-r4/poll.js', import.meta.url), 'utf8').replace(/^import .*;$/gm, '').replace(/export /g, '');
  const storage = new Map<string, string>(), queues = new Map<string, Promise<unknown>>();
  let now = 1000;
  const locks = { request(key: string, read: () => Promise<unknown>) { const next = (queues.get(key) ?? Promise.resolve()).then(read); queues.set(key, next.catch(() => {})); return next; } };
  let version = 0;
  const api = vi.fn(async (endpoint: string) => ({ endpoint, version: ++version }));
  function page(token: string) {
    const ctx = vm.createContext({ api, state: { token }, navigator: { locks }, window: { crypto: webcrypto }, TextEncoder, Uint8Array, Date: { now: () => now },
      localStorage: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) } });
    vm.runInContext(source, ctx);
    return ctx.workspaceRead as (path: string, fresh?: boolean) => Promise<unknown>;
  }
  const main = page('owner'), pane = page('owner'), popout = page('owner');
  const first = await Promise.all([main('/api/inbox'), main('/api/inbox'), pane('/api/inbox'), popout('/api/inbox')]);
  expect(api).toHaveBeenCalledTimes(1); expect(first.every(v => JSON.stringify(v) === JSON.stringify(first[0]))).toBe(true);
  now += 9999; await pane('/api/inbox'); expect(api).toHaveBeenCalledTimes(1);
  now += 1; await Promise.all([main('/api/inbox'), pane('/api/inbox'), popout('/api/inbox')]); expect(api).toHaveBeenCalledTimes(2);
  await Promise.all([main('/api/mission'), pane('/api/mission')]); expect(api).toHaveBeenCalledTimes(3);
  await page('scoped')('/api/inbox'); expect(api).toHaveBeenCalledTimes(4);
  await main('/api/inbox', true); expect(api).toHaveBeenCalledTimes(5);
  expect([...storage.keys()].some(k => k.includes('owner') || k.includes('scoped'))).toBe(false);
});

it('same-page panes share the in-flight projection even without Web Locks', async () => {
  const source = fs.readFileSync(new URL('../src/web/workspace-r4/poll.js', import.meta.url), 'utf8').replace(/^import .*;$/gm, '').replace(/export /g, '');
  const top = {}, api = vi.fn(async () => ({ count: 1 }));
  function pane() {
    const ctx = vm.createContext({ api, state: { token: 'owner' }, navigator: {}, window: { top }, Date, Map });
    vm.runInContext(source, ctx); return ctx.workspaceRead as (path: string) => Promise<unknown>;
  }
  expect(await Promise.all([pane()('/api/inbox'), pane()('/api/inbox')])).toEqual([{ count: 1 }, { count: 1 }]);
  expect(api).toHaveBeenCalledTimes(1);
});
