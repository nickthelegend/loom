import fs from 'node:fs';
import path from 'node:path';
import { tmpDir } from './helpers.js';
import { expect, it } from 'vitest';
// @ts-expect-error desktop modules ship directly as ESM
import { trayMenu, popoutUrl, allowedWorkspaceSender } from '../desktop/tray.js';
it('tray shows counts, needs-you and running chats, and routes quick-send and chat actions', () => {
  const calls: unknown[] = [], item = { projectName: 'Alpha', title: 'Approve shell', project: 'a', chat: 'c' };
  const menu = trayMenu({ runningTurns: 2, chats: [item] }, { count: 1, items: [item] }, { mission: () => calls.push('mission'), quick: () => calls.push('quick'), chat: (c: unknown) => calls.push(c) });
  expect(menu[0].label).toBe('2 running turns'); expect(menu[2].label).toBe('Needs you (1)');
  menu[1].click(); menu[2].submenu[0].click(); menu[3].submenu[0].click(); menu[5].click();
  expect(calls).toEqual(['mission', item, item, 'quick']);
});
it('popouts admit only same-origin chat windows, never preview pages or subframe IPC', () => {
  const origin = 'http://127.0.0.1:7420', route = '/app?pane=popout-123&popout=1#p/a/c/main';
  expect(popoutUrl(route, origin)).toBe(origin + route);
  for (const value of ['https://evil.test' + route, '/preview?popout=1', '/app?popout=1#p/a/c/main', '/app?pane=popout-1&popout=1#home', 'javascript:alert(1)']) expect(popoutUrl(value, origin)).toBeNull();
  const frame = { url: origin + '/app' };
  expect(allowedWorkspaceSender({ senderFrame: frame, sender: { mainFrame: frame } }, origin)).toBe(true);
  expect(allowedWorkspaceSender({ senderFrame: frame, sender: { mainFrame: {} } }, origin)).toBe(false);
  const preview = { url: origin + '/preview/untrusted' };
  expect(allowedWorkspaceSender({ senderFrame: preview, sender: { mainFrame: preview } }, origin)).toBe(false);
});

it('tray defaults preserve platform close behavior, persists opt-in and falls back without a host', async () => {
  // @ts-expect-error desktop modules ship directly as ESM
  const { createTray } = await import('../desktop/tray.js');
  for (const platform of ['linux', 'win32', 'darwin']) {
    const dir = tmpDir('r4-tray'); let quit = () => {}, host = true, noWindows = false, quitCount = 0;
    const app = { getPath: () => dir, once: (_event: string, fn: () => void) => { quit = fn; }, quit: () => { quitCount++; } };
    const options = { app, platform, hostAvailable: async () => host, hasWindows: () => !noWindows,
      Tray: class { setToolTip() {} on() {} destroy() {} }, Menu: {}, nativeImage: { createFromPath: () => ({ resize: () => ({}) }) }, icon: '', daemon: () => null, actions: {} };
    const tray = createTray(options); await new Promise(resolve => setTimeout(resolve, 0));
    expect(tray.state().enabled).toBe(platform === 'darwin');
    await tray.setEnabled(true); expect(tray.state().enabled).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'tray-preference.json'), 'utf8')).enabled).toBe(true);
    host = false; noWindows = true; await tray.refresh();
    expect(tray.state()).toMatchObject({ enabled: false, requestedEnabled: true, available: false });
    expect(quitCount).toBe(platform === 'darwin' ? 0 : 1); quit();
    host = true;
    const restarted = createTray(options); await new Promise(resolve => setTimeout(resolve, 0)); expect(restarted.state().enabled).toBe(true);
    await restarted.setEnabled(false); expect(restarted.state().enabled).toBe(false); quit();
  }
});
it('Linux host detection checks the notifier property and safely handles unavailable sessions', async () => {
  // @ts-expect-error desktop modules ship directly as ESM
  const { trayHostAvailable } = await import('../desktop/tray-host.js');
  expect(await trayHostAvailable('linux', (_cmd: string, args: string[], _opts: unknown, cb: Function) => { expect(args).toContain('IsStatusNotifierHostRegistered'); cb(null, '(<true>,)'); })).toBe(true);
  expect(await trayHostAvailable('linux', (_cmd: string, _args: string[], _opts: unknown, cb: Function) => cb(null, '(<false>,)'))).toBe(false);
  expect(await trayHostAvailable('linux', (_cmd: string, _args: string[], _opts: unknown, cb: Function) => cb(new Error('missing gdbus'), ''))).toBe(false);
});
