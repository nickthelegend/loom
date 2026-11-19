import fs from 'node:fs';
import path from 'node:path';
import { JSDOM, VirtualConsole } from 'jsdom';
import WebSocket from 'ws';
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';
import { APP_HTML } from '../src/daemon/app-page.js';
import { LoomDaemon } from '../src/daemon/server.js';
import { DaemonClient } from '../src/daemon/client.js';
import { readDaemonConfig } from '../src/core/registry.js';
import { tmpDir, makeProjectDir, waitUntil } from './helpers.js';

let daemon: LoomDaemon, client: DaemonClient, base: string, token: string, a: string, b: string, dir: string;
const mounted: Array<{ window: JSDOM['window']; errors: string[]; close: () => void }> = [];
beforeAll(async () => {
  process.env.LOOM_HOME = tmpDir('r4-dom-home'); process.env.LOOM_NO_NOTIFY = '1';
  daemon = new LoomDaemon({ host: '127.0.0.1', port: 0 }); await daemon.listen();
  const cfg = readDaemonConfig()!; client = new DaemonClient(cfg); base = client.baseUrl; token = cfg.adminToken;
  dir = makeProjectDir({ name: 'Alpha workspace' });
  a = (await client.addProject(dir)).project.id;
  b = (await client.addProject(makeProjectDir({ name: 'Beta workspace' }))).project.id;
}, 60000);
afterEach(async () => { while (mounted.length) mounted.pop()!.close(); await client.interrupt(a); await client.interrupt(b); });
afterAll(async () => { await daemon?.close(); });
function mount(hash = '#p/' + a, search = '', storage: Record<string, string> = {}, hidden = false) {
  const errors: string[] = [], sockets: WebSocket[] = [], requests: string[] = [], pollers: Array<() => void> = []; let closed = false;
  const console = new VirtualConsole(); console.on('jsdomError', e => errors.push(e.message));
  const never = new Promise<Response>(() => {});
  const dom = new JSDOM(APP_HTML, { url: base + '/app' + search + hash, runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole: console,
    beforeParse(w) {
      if (hidden) Object.defineProperty(w.document, 'hidden', { configurable: true, value: true });
      const interval = w.setInterval.bind(w);
      w.setInterval = ((fn: () => void, ms: number) => { if (ms === 10000) pollers.push(fn); return interval(fn, ms); }) as typeof w.setInterval;
      w.scrollTo = () => {}; w.HTMLElement.prototype.scrollTo = () => {}; w.HTMLElement.prototype.scrollIntoView = () => {};
      w.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof w.ResizeObserver;
      w.matchMedia = ((q: string) => ({ matches: /min-width/.test(q), media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false })) as typeof w.matchMedia;
      w.fetch = ((p: string, init: RequestInit) => { requests.push(String(p)); return closed ? never : fetch(new URL(p, base), init).then(r => closed ? never : r); }) as typeof w.fetch;
      w.WebSocket = class extends WebSocket { constructor(url: string, protocols?: string | string[]) { super(url, protocols); sockets.push(this); } } as unknown as typeof w.WebSocket;
      w.localStorage.setItem('loomClientToken', token); w.localStorage.setItem('loomDevMode', '1'); w.localStorage.setItem('loomSetupSeen', '1'); w.localStorage.setItem('loomTourDone', '1');
      Object.entries(storage).forEach(([k,v]) => w.localStorage.setItem(k,v));
      w.confirm = () => true; w.prompt = () => 'Daily work';
    },
  });
  const m = { window: dom.window, errors, requests, pollers, close(){ closed = true; for (const s of sockets) { s.removeAllListeners(); s.on('error', () => {}); s.terminate(); } dom.window.close(); } };
  mounted.push(m); return m;
}
function click(w: JSDOM['window'], selector: string) { const el = w.document.querySelector<HTMLElement>(selector); expect(el, selector).not.toBeNull(); el!.click(); }
async function palette(w: JSDOM['window'], name: string) {
  click(w, '#palettebtn'); const input = w.document.querySelector<HTMLInputElement>('#pq')!; input.value = name; input.dispatchEvent(new w.Event('input', { bubbles: true }));
  await waitUntil(() => [...w.document.querySelectorAll<HTMLElement>('.prow')].some(r => r.textContent?.includes(name)));
  [...w.document.querySelectorAll<HTMLElement>('.prow')].find(r => r.textContent?.includes(name))!.click();
}
it('mission opens from Home and palette, streams cards and steers/stops the real turn', async () => {
  await client.send(a, 'sleep:10000 stream:60 mission text');
  const m = mount('#home'), w = m.window;
  await waitUntil(() => !!w.document.querySelector('[data-mission]')); click(w, '[data-mission]');
  await waitUntil(() => !!w.document.querySelector('[data-row]'));
  expect(w.document.querySelector('.r4-home-mission')!.textContent).toContain('Alpha workspace');
  click(w, '[data-home]'); await palette(w, 'Mission control');
  await waitUntil(() => !!w.document.querySelector('#r4-panel [data-steer]'));
  const input = w.document.querySelector<HTMLInputElement>('#r4-panel input')!; input.value = 'new direction'; click(w, '#r4-panel [data-steer]');
  await waitUntil(async () => (await client.events(a)).events.some(e => e.payload.steer === true));
  click(w, '#r4-panel [data-stop]'); await waitUntil(async () => !(await client.workspace.mission()).chats.length);
  expect(m.errors).toEqual([]);
});
it('inbox keyboard triage dismisses a failed turn and shows a sidebar badge', async () => {
  await client.send(a, 'fail: triage this'); await waitUntil(async () => (await client.workspace.inbox()).items.some(i => i.title === 'triage this'));
  const m = mount(), w = m.window; await waitUntil(() => !!w.document.querySelector('#r4-inbox'));
  await waitUntil(() => w.document.querySelector('#r4-inbox')!.textContent!.includes('·'));
  click(w, '#r4-inbox'); await waitUntil(() => !!w.document.querySelector('[data-item]'));
  w.document.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'j', bubbles: true }));
  w.document.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'd', bubbles: true }));
  await waitUntil(async () => !(await client.workspace.inbox()).items.some(i => i.title === 'triage this'));
  expect(m.errors).toEqual([]);
});
it('project notes edit, render Markdown, detect conflicts, and send selection to the captured chat', async () => {
  const m = mount(), w = m.window; await waitUntil(() => !!w.document.querySelector('#box')); click(w, '#r4-notes');
  await waitUntil(() => !!w.document.querySelector('#r4-panel textarea'));
  await waitUntil(() => !w.document.querySelector<HTMLTextAreaElement>('#r4-panel textarea')!.disabled);
  const box = w.document.querySelector<HTMLTextAreaElement>('#r4-panel textarea')!; box.value = '# Notes\nselected text'; click(w, '[data-save]');
  await waitUntil(async () => (await client.workspace.notes(a)).text === '# Notes\nselected text');
  await waitUntil(() => !w.document.querySelector<HTMLButtonElement>('#r4-panel [data-save]')!.disabled);
  click(w, '[data-read]'); expect(w.document.querySelector('.r4-markdown .mdh1')!.textContent).toBe('Notes'); click(w, '[data-read]');
  box.selectionStart = 8; box.selectionEnd = box.value.length; click(w, '[data-send]');
  await waitUntil(async () => (await client.events(a)).events.some(e => !e.agentId && e.payload.text === 'selected text'));
  await client.workspace.saveNotes(a, 'Changed elsewhere'); box.value = 'My unsaved edit'; click(w, '[data-save]');
  await waitUntil(() => w.document.querySelector('#r4-panel [role=status]')!.textContent!.includes('changed'));
  expect(box.value).toBe('My unsaved edit'); expect(m.errors).toEqual([]);
});
it('named layouts persist both pane selections and appear in the palette', async () => {
  const m = mount(), w = m.window; await waitUntil(() => !!w.document.querySelector('#box'));
  await palette(w, 'Saved layouts'); await waitUntil(() => !!w.document.querySelector('#r4-panel [data-save]')); click(w, '#r4-panel [data-save]');
  await waitUntil(() => w.document.querySelector('#r4-panel')!.textContent!.includes('Daily work'));
  const prefs = await (await fetch(base + '/api/workspace', { headers: { Authorization: 'Bearer ' + token } })).json();
  expect(Object.values(prefs.layouts[0].workspace.panes)).toEqual([{ hash: '#p/' + a + '/c/main' }]);
  click(w, '[data-close]'); click(w, '#palettebtn');
  const input = w.document.querySelector<HTMLInputElement>('#pq')!; input.value = 'Open layout Daily'; input.dispatchEvent(new w.Event('input'));
  await waitUntil(() => w.document.querySelector('#pbody')!.textContent!.includes('Open layout Daily work'));
  expect(m.errors).toEqual([]);
});
it('custom themes preview, cancel and persist validated JSON without injecting CSS', async () => {
  const m = mount(), w = m.window; await waitUntil(() => !!w.document.querySelector('#setupbtn')); click(w, '#setupbtn');
  await waitUntil(() => !!w.document.querySelector('[data-sec="preferences"]'));
  click(w, '[data-sec="preferences"]'); await waitUntil(() => !!w.document.querySelector('.r4-appearance'));
  const select = w.document.querySelector<HTMLSelectElement>('.r4-appearance select')!; expect(select.options.length).toBe(5); select.value = '2'; select.dispatchEvent(new w.Event('change'));
  expect(w.document.documentElement.style.getPropertyValue('--background')).toBe('#111b17'); click(w, '[data-cancel]'); expect(w.localStorage.getItem('loomR4Theme')).toBeNull();
  select.value = '3'; select.dispatchEvent(new w.Event('change')); click(w, '[data-apply]'); expect(JSON.parse(w.localStorage.getItem('loomR4Theme')!).name).toBe('Midnight');
  const box = w.document.querySelector<HTMLTextAreaElement>('[aria-label="Theme JSON"]')!; box.value = JSON.stringify({ name: 'bad', tokens: { background: 'url(https://evil.test)' } }); box.dispatchEvent(new w.Event('input')); click(w, '[data-apply]');
  expect(JSON.parse(w.localStorage.getItem('loomR4Theme')!).name).toBe('Midnight'); expect(m.errors).toEqual([]);
});
it('sidebar organisation persists pinning and sections and follows a second window', async () => {
  const m = mount(), second = mount('#p/' + b), w = m.window; await waitUntil(() => !!w.document.querySelector('[data-r4-organise]')); click(w, '[data-r4-organise]');
  await waitUntil(() => !!w.document.querySelector('[data-add]')); click(w, '[data-add]');
  const name = w.document.querySelector<HTMLInputElement>('[data-section]')!; name.value = 'Work'; name.dispatchEvent(new w.Event('input'));
  const row = w.document.querySelector<HTMLElement>('[data-project="' + a + '"]')!; const pin = row.querySelector<HTMLInputElement>('input')!; pin.checked = true; pin.dispatchEvent(new w.Event('change'));
  click(w, '#r4-panel [data-save]');
  await waitUntil(() => second.window.document.querySelector('[data-r4-group="pinned"]')?.nextElementSibling?.querySelector('[data-id]')?.getAttribute('data-id') === a);
  expect(m.errors).toEqual([]); expect(second.errors).toEqual([]);
});
it('Ctrl+Tab previews MRU chats and changes only this pane; popout opens minimal chrome', async () => {
  const storage = { loomR4Recent: JSON.stringify([{ project: a, chat: 'main', title: 'Main A', projectName: 'Alpha' }, { project: b, chat: 'main', title: 'Main B', projectName: 'Beta' }]) };
  const m = mount('#p/' + a, '?pane=testpane&popout=1', storage), w = m.window;
  await waitUntil(() => !!w.document.querySelector('#box'));
  w.document.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Tab', ctrlKey: true, bubbles: true }));
  expect(w.document.querySelector('.r4-switcher')!.textContent).toContain('Beta');
  w.document.dispatchEvent(new w.KeyboardEvent('keyup', { key: 'Control', bubbles: true }));
  await waitUntil(() => w.location.hash.includes(b));
  expect(w.document.documentElement.classList.contains('r4-popout')).toBe(true);
  expect(w.localStorage.getItem('loomSelection:v1')).toBeNull();
  let popped = ''; w.open = ((url: string) => { popped = url; return {} as Window; }) as typeof w.open;
  click(w, '#r4-popout'); expect(popped).toContain('popout=1#p/' + b + '/c/main'); expect(m.errors).toEqual([]);
});
it('chat files show metadata, copy paths and jump to the originating message', async () => {
  fs.mkdirSync(path.join(dir, '.loom/attachments'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.loom/attachments/from-chat.txt'), 'real attachment');
  await client.send(a, '[file] .loom/attachments/from-chat.txt');
  await waitUntil(async () => (await client.workspace.files(a, 'main')).files.length > 0);
  const m = mount(), w = m.window; await waitUntil(() => !!w.document.querySelector('#box')); click(w, '#r4-files');
  await waitUntil(() => !!w.document.querySelector('[data-file]'));
  expect(w.document.querySelector('#r4-panel')!.textContent).toContain('from-chat.txt');
  expect(w.document.querySelector('[data-copy]')!.textContent).toBe('Copy path'); click(w, '[data-jump]');
  await waitUntil(() => !w.document.querySelector('#r4-panel')); expect(m.errors).toEqual([]);
});

it('project drag order and collapsible sections survive a second window refresh', async () => {
  const m = mount(), w = m.window;
  await waitUntil(() => !!w.document.querySelector('[data-r4-organise]'));
  const request = (method: string, body?: unknown) => fetch(base + '/api/workspace', { method, headers: { Authorization: 'Bearer ' + token, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) }).then(r => r.json());
  const current = await request('GET');
  await request('PUT', { revision: current.revision, sidebar: { sections: [{ id: 'team', name: 'Team', collapsed: false }], projects: [{ id: a, pinned: false, section: 'team' }, { id: b, pinned: false, section: 'team' }] } });
  await waitUntil(() => !!w.document.querySelector('[data-r4-group="team"]'));
  const target = w.document.querySelector<HTMLElement>('.srow[data-id="' + a + '"]')!;
  const ev = new w.Event('drop', { bubbles: true, cancelable: true }); Object.defineProperty(ev, 'dataTransfer', { value: { getData: () => b, types: ['application/x-loom-project'] } }); target.dispatchEvent(ev);
  await waitUntil(async () => (await request('GET')).sidebar.projects[0].id === b);
  click(w, '[data-r4-group="team"]'); await waitUntil(async () => (await request('GET')).sidebar.sections[0].collapsed);
  await waitUntil(() => !!w.document.querySelector('.srow[data-id="' + a + '"]')!.closest<HTMLElement>('.sgroup')!.hidden);
  expect(m.errors).toEqual([]);
});
it('a popout and the main window receive the same live chat while keeping independent navigation', async () => {
  const main = mount(), popup = mount('#p/' + a, '?pane=popout-test&popout=1');
  await waitUntil(() => !!main.window.document.querySelector('#box') && !!popup.window.document.querySelector('#box'));
  await client.send(a, 'sync across windows r4');
  await waitUntil(() => main.window.document.body.textContent!.includes('echo(plannerbot): sync across windows r4') && popup.window.document.body.textContent!.includes('echo(plannerbot): sync across windows r4'));
  main.window.location.hash = '#p/' + b;
  await waitUntil(() => main.window.location.hash.includes(b)); expect(popup.window.location.hash).toBe('#p/' + a);
  expect(main.errors).toEqual([]); expect(popup.errors).toEqual([]);
});
it('quick-send chooses the destination and sends through the real daemon', async () => {
  const m = mount('#home', '?pane=tray&quick=1'), w = m.window;
  await waitUntil(() => !!w.document.querySelector('#r4-panel [data-project] option'));
  const project = w.document.querySelector<HTMLSelectElement>('#r4-panel [data-project]')!; project.value = b; project.dispatchEvent(new w.Event('change'));
  await waitUntil(() => !!w.document.querySelector('#r4-panel [data-chat] option'));
  w.document.querySelector<HTMLTextAreaElement>('#r4-panel textarea')!.value = 'sent from tray quick-send'; click(w, '#r4-panel [data-send]');
  await waitUntil(async () => (await client.events(b)).events.some(e => e.payload.text === 'sent from tray quick-send'));
  expect((await client.events(a)).events.some(e => e.payload.text === 'sent from tray quick-send')).toBe(false); expect(m.errors).toEqual([]);
});
it('saved split arrangements restore each project/chat and keep changes local to the window', async () => {
  const split = { layout: { direction: 'row', children: [{ id: 'left' }, { id: 'right' }] }, panes: { left: { hash: '#p/' + a + '/c/main' }, right: { hash: '#p/' + b + '/c/main' } }, focus: 'right' };
  const m = mount('', '?split=1', { 'loomSplit:v1': JSON.stringify(split) }), w = m.window;
  await waitUntil(() => w.document.querySelectorAll('.wsframe').length === 2);
  expect([...w.document.querySelectorAll<HTMLIFrameElement>('.wsframe')].map(f => new URL(f.src).hash)).toEqual([split.panes.left.hash, split.panes.right.hash]);
  expect(w.document.querySelector('.wspane.focused')!.getAttribute('data-pane')).toBe('right');
  w.localStorage.setItem('loomSplit:v1', JSON.stringify({ layout: { id: 'other' }, panes: { other: { hash: '#p/' + a + '/c/other' } }, focus: 'other' }));
  expect(JSON.parse(w.sessionStorage.getItem('loomSplit:v1')!).panes).toEqual(split.panes); expect(m.errors).toEqual([]);
});
it('theme JSON import/export round-trips and the desktop preference calls the tray bridge', async () => {
  const m = mount(), w = m.window; await waitUntil(() => !!w.document.querySelector('#setupbtn'));
  let enabled = true;
  (w as unknown as { loomNative: unknown }).loomNative = { tray: async (value?: boolean) => { if (value !== undefined) enabled = value; return { enabled }; } };
  click(w, '#setupbtn'); await waitUntil(() => !!w.document.querySelector('[data-sec="preferences"]')); click(w, '[data-sec="preferences"]');
  const imported = { name: 'Round trip', tokens: { background: '#123456', foreground: '#ffffff' } };
  const file = w.document.querySelector<HTMLInputElement>('.r4-appearance input[type=file]')!;
  Object.defineProperty(file, 'files', { value: [{ size: 100, text: async () => JSON.stringify(imported) }] }); file.dispatchEvent(new w.Event('change'));
  await waitUntil(() => w.document.documentElement.style.getPropertyValue('--background') === '#123456'); click(w, '[data-apply]');
  let exported: Blob | null = null; w.URL.createObjectURL = ((blob: Blob) => { exported = blob; return 'blob:test'; }) as typeof w.URL.createObjectURL; w.URL.revokeObjectURL = () => {};
  w.HTMLAnchorElement.prototype.click = () => {};
  click(w, '[data-export]'); expect(exported).not.toBeNull();
  const reader = new w.FileReader(); const contents = new Promise<string>(resolve => { reader.onload = () => resolve(String(reader.result)); }); reader.readAsText(exported! as unknown as globalThis.Blob);
  expect(JSON.parse(await contents)).toEqual(imported);
  const toggle = w.document.querySelector<HTMLInputElement>('.r4-appearance input[type=checkbox]')!; toggle.checked = false; toggle.dispatchEvent(new w.Event('change'));
  await waitUntil(() => !enabled); expect(m.errors).toEqual([]);
});

it('partial custom themes preserve Rose through apply, reload, preview and cancel', async () => {
  const partial = { name: 'Partial', tokens: { background: '#123456', foreground: '#eeeeee' } };
  const m = mount(undefined, '', { 'loomPref:accent': 'rose', loomR4Theme: JSON.stringify(partial) }), w = m.window;
  await waitUntil(() => !!w.document.querySelector('#setupbtn'));
  const accent = () => ['--thread', '--thread-ink', '--accentBlue'].map(k => w.document.documentElement.style.getPropertyValue(k));
  expect(accent()).toEqual(['#fda4af', '#fda4af', '#fda4af']);
  click(w, '#setupbtn'); await waitUntil(() => !!w.document.querySelector('[data-sec="preferences"]')); click(w, '[data-sec="preferences"]');
  const box = w.document.querySelector<HTMLTextAreaElement>('[aria-label="Theme JSON"]')!;
  box.value = JSON.stringify({ name: 'Override', tokens: { thread: '#123456' } }); box.dispatchEvent(new w.Event('input'));
  expect(accent()).toEqual(['#123456', '#fda4af', '#fda4af']);
  click(w, '[data-cancel]'); expect(accent()).toEqual(['#fda4af', '#fda4af', '#fda4af']);
  click(w, '[data-apply]'); expect(w.localStorage.getItem('loomPref:accent')).toBe('rose');
  w.dispatchEvent(new w.StorageEvent('storage', { key: 'loomPref:accent' }));
  expect(accent()).toEqual(['#fda4af', '#fda4af', '#fda4af']); expect(m.errors).toEqual([]);
});

it('panes, popouts and hidden documents do not run background inbox badge polls', async () => {
  for (const [search, hidden] of [['?pane=one', false], ['?pane=popout-one&popout=1', false], ['', true]] as const) {
    const m = mount(undefined, search, {}, hidden);
    await waitUntil(() => !!m.window.document.querySelector('#box'));
    m.pollers.forEach(fn => fn());
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(m.requests.filter(p => p === '/api/inbox')).toEqual([]); expect(m.errors).toEqual([]);
  }
});
