import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { JSDOM, VirtualConsole } from 'jsdom';
import WebSocket from 'ws';
import { beforeAll, afterAll, afterEach, it, expect } from 'vitest';
import { LoomDaemon } from '../src/daemon/server.js';
import { DaemonClient } from '../src/daemon/client.js';
import { readDaemonConfig } from '../src/core/registry.js';
import { APP_HTML } from '../src/daemon/app-page.js';
import type { OrchestraRun } from '../src/core/orchestra.js';
import { makeProjectDir, tmpDir, waitUntil } from './helpers.js';

let daemon: LoomDaemon, client: DaemonClient, project: string, token: string;
const mounted: Array<ReturnType<typeof mount>> = [];
beforeAll(async () => {
  process.env.LOOM_HOME = tmpDir('r4-dom-home'); process.env.LOOM_NO_NOTIFY = '1';
  daemon = new LoomDaemon({ host: '127.0.0.1', port: 0 }); await daemon.listen();
  client = new DaemonClient(readDaemonConfig()!); token = readDaemonConfig()!.adminToken;
  const dir = makeProjectDir({ agents: [{ id: 'lead', kind: 'echo' }, { id: 'worker', kind: 'echo' }] });
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir });
  git('init', '-q'); fs.writeFileSync(path.join(dir, '.gitignore'), '.loom/\n'); git('add', '-A'); git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'seed');
  project = (await client.addProject(dir)).project.id;
}, 30000);
afterEach(async () => {
  mounted.splice(0).forEach(m => m.close());
  for (const run of (await client.orchestraRuns(project)).runs) if (!['completed', 'aborted', 'failed'].includes(run.status)) await client.orchestraAction(project, run.id, 'abort');
});
afterAll(async () => { await daemon.close(); });

// The app-orchestra-dom mount pattern, with real HTTP and WS and explicit teardown.
function mount(displayStatus?: OrchestraRun["status"]) {
  const sockets: WebSocket[] = [], errors: string[] = [], downloads: Blob[] = [];
  let closed = false;
  const never = new Promise<never>(() => {}), vc = new VirtualConsole();
  vc.on('jsdomError', e => errors.push(e.message)); vc.on('error', e => errors.push(String(e)));
  const dom = new JSDOM(APP_HTML, { url: `${client.baseUrl}/app#p/${project}`, runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole: vc,
    beforeParse(w) {
      w.scrollTo = () => {}; w.HTMLElement.prototype.scrollTo = () => {}; w.HTMLElement.prototype.scrollIntoView = () => {};
      w.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof w.ResizeObserver;
      w.matchMedia = ((q: string) => ({ matches: /min-width/.test(q), media: q, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false, onchange: null })) as typeof w.matchMedia;
      w.fetch = ((input: string, init?: RequestInit) => closed ? never : fetch(new URL(String(input), client.baseUrl), init).then(async r => {
        if (closed) return never;
        if (displayStatus && String(input).includes('/orchestra') && (!init?.method || init.method === 'GET') && r.ok) {
          const body = await r.json();
          for (const run of body.runs ?? (body.run ? [body.run] : [])) { run.status = displayStatus; run.held = true; }
          return new Response(JSON.stringify(body), { status: r.status, headers: { 'content-type': 'application/json' } });
        }
        return r;
      })) as typeof w.fetch;
      w.WebSocket = class extends WebSocket { constructor(url: string | URL, protocols?: string | string[]) { super(url, protocols); sockets.push(this); } } as unknown as typeof w.WebSocket;
      w.localStorage.setItem('loomClientToken', token); w.localStorage.setItem('loomDevMode', '1');
      w.confirm = () => true;
      w.URL.createObjectURL = blob => { downloads.push(blob as Blob); return 'blob:test'; }; w.URL.revokeObjectURL = () => {};
      w.HTMLAnchorElement.prototype.click = () => {};
    } });
  const result = { dom, errors, downloads, close() { closed = true; for (const socket of sockets) { socket.removeAllListeners(); socket.on('error', () => {}); socket.terminate(); } dom.window.close(); } };
  mounted.push(result); return result;
}
const $ = (m: ReturnType<typeof mount>, selector: string) => m.dom.window.document.querySelector(selector) as HTMLElement;
const ready = (m: ReturnType<typeof mount>, selector: string) => waitUntil(() => !!$(m, selector)?.onclick);
function input(m: ReturnType<typeof mount>, selector: string, value: string) {
  const node = $(m, selector) as HTMLInputElement; node.value = value; node.dispatchEvent(new m.dom.window.Event('input', { bubbles: true })); node.dispatchEvent(new m.dom.window.Event('change', { bubbles: true }));
}
async function openView(m: ReturnType<typeof mount>) { await ready(m, '.tab[data-tab="orchestra"]'); $(m, '.tab[data-tab="orchestra"]').click(); await ready(m, '[data-r4="hold"]'); }
async function preview() {
  const run = (await client.startOrchestra(project, { goal: 'Preview', workers: ['worker'], orchestrator: 'lead', planOnly: true })).run;
  await waitUntil(async () => (await client.orchestraRun(project, run.id)).run.status === 'waiting_human');
  const actions = ['first', 'second'].map(id => ({ type: 'spawn', id, title: id, prompt: 'hello', agent: 'worker' }));
  await client.orchestraAction(project, run.id, 'reply', { text: '```loom\n' + JSON.stringify({ actions }) + '\n```' });
  await waitUntil(async () => (await client.orchestraRun(project, run.id)).run.tasks.length === 2); return run;
}
it('web adds a task, holds/releases, broadcasts and skips with live server state', async () => {
  const run = await preview(), m = mount(); await openView(m);
  $(m, '[data-r4="hold"]').click(); await ready(m, '[data-r4="release"]'); expect($(m, '[data-r4panel]').textContent).toContain('Held');
  input(m, '[data-r4text]', '<script>danger</script>'); input(m, '[data-r4agent]', 'worker@chosen'); input(m, '[data-r4after]', 'first');
  $(m, '[data-r4="add"]').click();
  await waitUntil(async () => (await client.orchestraRun(project, run.id)).run.tasks.length === 3);
  await ready(m, '[data-r4="skip:t3"]'); expect($(m, '[data-r4panel] script')).toBeNull();
  input(m, '[data-r4note]', 'Use accessible labels'); $(m, '[data-r4="say"]').click();
  await waitUntil(async () => !!(await client.orchestraRun(project, run.id)).run.workerNotes?.length);
  $(m, '[data-r4="skip:t3"]').click(); await waitUntil(async () => !!(await client.orchestraRun(project, run.id)).run.tasks[2]!.skippedReason);
  await ready(m, '[data-r4="release"]'); $(m, '[data-r4="release"]').click(); await ready(m, '[data-r4="hold"]'); expect(m.errors).toEqual([]);
});
it('web renames, reorders, reassigns and removes preview tasks before approval', async () => {
  const run = await preview(), m = mount(); await openView(m);
  input(m, '[data-r4row="0"] [data-planfield="title"]', 'Renamed'); input(m, '[data-r4row="0"] [data-planfield="agent"]', 'worker@new');
  $(m, '[data-r4="down:0"]').click();
  expect(($(m, '[data-r4row="1"] [data-planfield="title"]') as HTMLInputElement).value).toBe('Renamed');
  $(m, '[data-r4="remove:0"]').click(); $(m, '[data-r4="approve"]').click();
  await waitUntil(async () => !!(await client.orchestraRun(project, run.id)).run.planApprovedAt);
  const edited = (await client.orchestraRun(project, run.id)).run; expect(edited.tasks).toHaveLength(1); expect(edited.tasks[0]).toMatchObject({ id: 'first', title: 'Renamed', model: 'new' }); expect(m.errors).toEqual([]);
});
it('web compares saved runs side by side, downloads a report and runs again', async () => {
  const run = await preview(); await client.orchestraAction(project, run.id, 'abort');
  const next = await preview(); await client.orchestraAction(project, next.id, 'abort');
  const m = mount(); await ready(m, '.tab[data-tab="orchestra"]'); $(m, '.tab[data-tab="orchestra"]').click(); await ready(m, '[data-r4="rerun"]');
  await waitUntil(() => !!$(m, `[data-r4compare] option[value="${run.id}"]`)); input(m, '[data-r4compare]', run.id); $(m, '[data-r4="compare"]').click();
  await waitUntil(() => !!$(m, '[data-r4comparison] table')); expect($(m, '[data-r4comparison]').textContent).toContain(run.id);
  $(m, '[data-r4="report"]').click(); await waitUntil(() => m.downloads.length === 1);
  $(m, '[data-r4="rerun"]').click(); await waitUntil(async () => (await client.orchestraRuns(project)).runs.some(r => r.rerunOf === next.id)); expect(m.errors).toEqual([]);
});
it('web run options persist checks and task limits into the start payload', async () => {
  const m = mount(); await ready(m, '#cmode [data-cmode="orch"]'); $(m, '#cmode [data-cmode="orch"]').click(); await ready(m, '#orchsend');
  input(m, '[data-r4option="check"]', 'exit 0'); input(m, '[data-r4option="checkRounds"]', '1'); input(m, '[data-r4option="taskMinutes"]', '5'); input(m, '#box', 'Options test');
  $(m, '#orchsend').click();
  await waitUntil(async () => (await client.orchestraRuns(project)).runs.some(r => r.goal === 'Options test'));
  const run = (await client.orchestraRuns(project)).runs.find(r => r.goal === 'Options test')!;
  expect(run).toMatchObject({ check: 'exit 0', checkRounds: 1, taskMinutes: 5 }); expect(m.errors).toEqual([]);
});

for (const status of ['completed', 'failed', 'aborted', 'moved'] as const) it(`web displays ${status} in list and detail despite a saved held flag`, async () => {
  const run = await preview(); await client.orchestraAction(project, run.id, 'abort');
  const m = mount(status); await ready(m, '.tab[data-tab="orchestra"]'); $(m, '.tab[data-tab="orchestra"]').click();
  await ready(m, '[data-r4="report"]');
  expect($(m, `[data-run="${run.id}"] .orm`).textContent?.toLowerCase()).toContain(status);
  expect($(m, '.odetail .ometa .opill').textContent?.toLowerCase()).toContain(status);
  expect($(m, '.odetail').textContent).not.toContain('Held');
  expect($(m, '[data-r4="release"]')).toBeNull(); expect(m.errors).toEqual([]);
});
