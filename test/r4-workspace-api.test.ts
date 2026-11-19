import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { LoomDaemon } from '../src/daemon/server.js';
import { DaemonClient } from '../src/daemon/client.js';
import { readDaemonConfig } from '../src/core/registry.js';
import { requestApproval } from '../src/core/approvals.js';
import { makeProjectDir, tmpDir, waitUntil } from './helpers.js';

let daemon: LoomDaemon, client: DaemonClient, base: string, admin: string, phone: string, scoped: string, guest: string;
let a: string, b: string, dir: string;
const call = (p: string, method = 'GET', body?: unknown, token = admin) => fetch(base + p, { method, headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
async function pair(body: unknown) {
  const p = await (await call('/api/pair/new', 'POST', body)).json();
  const token = p.token || new URLSearchParams(p.link.split('#')[1]).get('pair');
  return (await (await fetch(base + '/api/pair/claim', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token, name: 'r4-test' }) })).json()).clientToken as string;
}
beforeAll(async () => {
  process.env.LOOM_HOME = tmpDir('r4-home'); process.env.LOOM_NO_NOTIFY = '1';
  daemon = new LoomDaemon({ host: '127.0.0.1', port: 0 }); await daemon.listen();
  const cfg = readDaemonConfig()!; client = new DaemonClient(cfg); base = client.baseUrl; admin = cfg.adminToken;
  dir = makeProjectDir({ name: 'alpha' }); a = (await client.addProject(dir)).project.id;
  b = (await client.addProject(makeProjectDir({ name: 'beta' }))).project.id;
  phone = await pair({}); scoped = await pair({ projects: [a] }); guest = await pair({ guest: { project: a, chat: 'main', role: 'reply', name: 'Guest' } });
}, 60000);
afterAll(async () => { await daemon?.close(); });
it('notes are project scoped, writable by the phone, durable, and reject stale edits', async () => {
  const empty = await (await call(`/api/projects/${a}/notes`, 'GET', undefined, scoped)).json();
  const saved = await (await call(`/api/projects/${a}/notes`, 'PUT', { text: '# Plan\nShip it', revision: empty.revision }, phone)).json();
  expect(saved.text).toBe('# Plan\nShip it');
  expect((await call(`/api/projects/${a}/notes`, 'PUT', { text: 'stale', revision: empty.revision })).status).toBe(409);
  expect((await call(`/api/projects/${b}/notes`, 'GET', undefined, scoped)).status).toBe(403);
  expect((await call(`/api/projects/${a}/notes`, 'GET', undefined, guest)).status).toBe(403);
  expect((await client.workspace.notes(a)).text).toBe(saved.text);
  expect(JSON.parse(fs.readFileSync(path.join(dir, '.loom/workspace-r4-notes.json'), 'utf8')).text).toBe(saved.text);
  expect((await call(`/api/projects/${a}/notes`, 'PUT', { text: 4 })).status).toBe(400);
});
it('owner layouts and organisation share one version across devices; scoped devices cannot read machine state', async () => {
  const p = await (await call('/api/workspace')).json();
  const workspace = { layout: { direction: 'row', children: [{ id: 'one' }, { id: 'two' }] }, panes: { one: { hash: `#p/${a}/c/main` }, two: { hash: `#p/${b}/c/main` } }, focus: 'two' };
  const next = await (await call('/api/workspace', 'PUT', { revision: p.revision, save: { name: 'Morning', workspace }, sidebar: { sections: [{ id: 'work', name: 'Work', collapsed: true }], projects: [{ id: a, pinned: true, section: 'work' }, { id: b, pinned: false, section: 'work' }] } }, phone)).json();
  expect(next.layouts[0].workspace).toEqual(workspace);
  expect((await call('/api/workspace', 'PUT', { revision: p.revision, remove: 'Morning' })).status).toBe(409);
  expect((await call('/api/workspace', 'GET', undefined, scoped)).status).toBe(403);
  expect((await call('/api/workspace', 'GET', undefined, guest)).status).toBe(403);
  expect((await call('/api/workspace', 'PUT', { revision: next.revision, save: { name: 'bad', workspace: { ...workspace, focus: 'missing' } } })).status).toBe(400);
});
it('mission lists live echo chats, streams last line, filters scope, and uses real steer and stop', async () => {
  await client.send(a, 'alpha stream:100 sleep:2000'); await client.send(b, 'beta sleep:6000');
  await waitUntil(async () => (await client.workspace.mission()).chats.length === 2);
  const all = await client.workspace.mission(); expect(all.runningTurns).toBe(2); expect(all.chats[0]!.elapsedMs).toBeGreaterThanOrEqual(0);
  const only = await (await call('/api/mission', 'GET', undefined, scoped)).json(); expect(only.chats.map((c: { project: string }) => c.project)).toEqual([a]);
  expect((await call('/api/mission', 'GET', undefined, guest)).status).toBe(403);
  expect((await (await call(`/api/projects/${a}/steer`, 'POST', { chat: 'main', text: 'r4 steering' }, scoped)).json()).steered).toBe(true);
  await call(`/api/projects/${b}/interrupt`, 'POST', { chat: 'main' });
  await waitUntil(async () => !(await client.workspace.mission()).chats.some(c => c.project === b));
  await waitUntil(async () => (await client.events(a)).events.some(e => e.agentId && String(e.payload.text).includes('r4 steering')));
});
it('inbox retains plain questions after run_complete and failures until acknowledged', async () => {
  await client.send(a, 'ask: which colour?'); await client.send(b, 'fail: deterministic failure');
  await waitUntil(async () => { const { items } = await client.workspace.inbox(); return items.some(i => i.kind === 'question') && items.some(i => i.kind === 'failed'); });
  const only = await (await call('/api/inbox', 'GET', undefined, scoped)).json(); expect(only.items.every((i: { project: string }) => i.project === a)).toBe(true);
  expect((await call('/api/inbox', 'GET', undefined, guest)).status).toBe(403);
  await client.send(a, 'green');
  await waitUntil(async () => !(await client.workspace.inbox()).items.some(i => i.kind === 'question'));
  const failed = (await client.workspace.inbox()).items.find(i => i.kind === 'failed')!;
  expect((await call(`/api/projects/${a}/inbox/dismiss`, 'POST', { eventId: failed.eventId }, scoped)).status).toBe(404);
  await call(`/api/projects/${b}/inbox/dismiss`, 'POST', { eventId: failed.eventId }, phone);
  expect((await client.workspace.inbox()).items.some(i => i.id === failed.id)).toBe(false);
});
it('pending approvals appear and disappear when the phone decides through the existing route', async () => {
  const pending = requestApproval({ project: a, agent: 'plannerbot', tool: 'shell', input: { command: 'echo ok' } });
  await waitUntil(async () => (await client.workspace.inbox()).items.some(i => i.kind === 'approval'));
  const item = (await client.workspace.inbox()).items.find(i => i.kind === 'approval')!;
  expect(item.project).toBe(a);
  expect((await call(`/api/projects/${a}/approvals/${item.approvalId}`, 'POST', { decision: 'deny' }, phone)).status).toBe(200);
  expect((await pending).behavior).toBe('deny');
  expect((await client.workspace.inbox()).items.some(i => i.id === item.id)).toBe(false);
});
it('paused prompt queues appear and resume through the existing endpoint', async () => {
  await call(`/api/projects/${a}/queue/pause`, 'POST', { paused: true });
  await call(`/api/projects/${a}/queue`, 'POST', { text: 'after pause', chat: 'main' });
  expect((await client.workspace.inbox()).items.some(i => i.id === a + ':queue')).toBe(true);
  await call(`/api/projects/${a}/queue/pause`, 'POST', { paused: false }, phone);
  await waitUntil(async () => !(await client.workspace.inbox()).items.some(i => i.id === a + ':queue'));
});
it('chat files index attachments and outputs, open safely, and refuse another project or an escaping link', async () => {
  fs.mkdirSync(path.join(dir, '.loom/attachments'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.loom/attachments/note.txt'), 'attachment body');
  fs.symlinkSync(path.join(process.env.LOOM_HOME!, 'daemon.json'), path.join(dir, 'escape.txt'));
  await client.send(a, '[file] .loom/attachments/note.txt\n[artifact](escape.txt)\n![shot](shot.png)\nwrite:shot.png');
  await waitUntil(async () => (await client.workspace.files(a, 'main')).files.some(f => f.path === 'shot.png' && f.direction === 'produced'));
  const files = (await client.workspace.files(a, 'main')).files;
  expect(files.find(f => f.path.endsWith('note.txt'))).toMatchObject({ direction: 'received', kind: 'file', eventId: expect.any(Number) });
  const opened = await call(`/api/projects/${a}/chats/main/files/open?path=.loom%2Fattachments%2Fnote.txt`, 'GET', undefined, scoped);
  expect(await opened.text()).toBe('attachment body'); expect(opened.headers.get('content-disposition')).toContain('attachment');
  expect((await call(`/api/projects/${a}/chats/main/files/open?path=escape.txt`)).status).toBe(403);
  expect((await call(`/api/projects/${a}/chats/main/files/open?path=..%2Fdaemon.json`)).status).toBe(404);
  expect((await call(`/api/projects/${b}/chats/main/files`, 'GET', undefined, scoped)).status).toBe(403);
  expect((await call(`/api/projects/${a}/chats/main/files`, 'GET', undefined, guest)).status).toBe(403);
});

it('saves a split with an empty pane and returns readable validation errors', async () => {
  const prefs = await (await call('/api/workspace')).json();
  const workspace = { layout: { direction: 'row', children: [{ id: 'one' }, { id: 'two' }] }, panes: { one: { hash: `#p/${a}/c/main` }, two: { hash: '' } }, focus: 'two' };
  const response = await call('/api/workspace', 'PUT', { revision: prefs.revision, save: { name: 'With Home', workspace } });
  expect(response.status).toBe(200);
  const saved = await response.json(); expect(saved.layouts.find((l: { name: string }) => l.name === 'With Home').workspace).toEqual(workspace);
  const invalid = await (await call('/api/workspace', 'PUT', { revision: saved.revision, save: { name: 'Invalid', workspace: { ...workspace, panes: { ...workspace.panes, two: { hash: 'https://example.test' } } } } })).json();
  expect(invalid.error).toBe('Choose Home, a project, or a chat for each pane');
});
it('lists only real contained files, normalizing code locations before open', async () => {
  fs.writeFileSync(path.join(dir, 'reference.ts'), 'export const value = 1;');
  fs.mkdirSync(path.join(dir, 'directory.txt'), { recursive: true });
  await client.send(a, '[real](reference.ts#L10) [same](reference.ts:12:3) [missing](missing.png) [escaped](escape.txt) [dir](directory.txt) [anchor](#usage) [site](example.com/docs)');
  await waitUntil(async () => (await client.workspace.files(a, 'main')).files.some(f => f.path === 'reference.ts'));
  const files = (await client.workspace.files(a, 'main')).files;
  expect(files.some(f => ['missing.png', 'escape.txt', 'directory.txt', '#usage', 'example.com/docs'].includes(f.path))).toBe(false);
  expect(await (await call(`/api/projects/${a}/chats/main/files/open?path=reference.ts`)).text()).toBe('export const value = 1;');
});
