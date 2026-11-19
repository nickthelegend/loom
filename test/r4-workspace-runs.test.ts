import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { beforeAll, afterAll, expect, it } from 'vitest';
import { LoomDaemon } from '../src/daemon/server.js';
import { DaemonClient } from '../src/daemon/client.js';
import { readDaemonConfig } from '../src/core/registry.js';
import { tmpDir, makeProjectDir, waitUntil } from './helpers.js';
let daemon: LoomDaemon, client: DaemonClient, pid: string, base: string, token: string;
const post = async (suffix: string, body = {}) => { const r = await fetch(base + `/api/projects/${pid}` + suffix, { method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json() }; };
async function start(){ daemon = new LoomDaemon({ host: '127.0.0.1', port: 0 }); await daemon.listen(); const cfg = readDaemonConfig()!; client = new DaemonClient(cfg); base = client.baseUrl; token = cfg.adminToken; }
beforeAll(async () => {
  process.env.LOOM_HOME = tmpDir('r4-runs'); process.env.LOOM_NO_NOTIFY = '1'; await start();
  const dir = makeProjectDir(); const git = (...a: string[]) => execFileSync('git', a, { cwd: dir }); git('init', '-q');
  fs.writeFileSync(path.join(dir, '.gitignore'), '.loom/\n'); fs.writeFileSync(path.join(dir, 'seed.txt'), 'seed'); git('add', '-A'); git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'seed');
  pid = (await client.addProject(dir)).project.id;
}, 60000);
afterAll(async () => { await daemon?.close(); });
it('mission includes separate orchestra worker instances and steers them without dispatching a roster agent', async () => {
  const { run } = await client.compare(pid, { prompt: 'run:echo worker sleep:10000 stream:20 compare work', entrants: ['plannerbot', 'execbot'] });
  await waitUntil(async () => (await client.workspace.mission()).chats.filter(c => run.tasks.some(t => t.chat === c.chat)).length === 2);
  const chat = run.tasks[0]!.chat;
  await waitUntil(async () => (await client.events(pid)).events.some(e => e.chat === chat && e.kind === 'tool_call')); 
  const steer = await post(`/chats/${chat}/workspace/steer`, { text: 'new task direction' }); expect(steer.status).toBe(200); expect(steer.body.steered).toBe(true);
  const stopped = await post(`/chats/${chat}/workspace/stop`); expect(stopped.status).toBe(200); expect(stopped.body.scope).toBe('run');
  await waitUntil(async () => !(await client.workspace.mission()).chats.some(c => run.tasks.some(t => t.chat === c.chat)));
  const detail = await client.orchestraRun(pid, run.id); expect(detail.run.status).toBe('aborted');
}, 60000);
it('paused Orchestra survives restart in the inbox without loading its runtime and can be answered', async () => {
  const { run } = await client.startOrchestra(pid, { goal: 'plan a small change', orchestrator: 'plannerbot', workers: ['execbot'] });
  await waitUntil(async () => (await client.workspace.inbox()).items.some(i => i.runId === run.id));
  await daemon.close(); await start();
  const item = (await client.workspace.inbox()).items.find(i => i.runId === run.id);
  expect(item).toMatchObject({ kind: 'paused', action: 'resume', project: pid });
  expect((await post(`/orchestra/${run.id}/resume`)).status).toBe(200);
  await client.orchestraAction(pid, run.id, 'abort');
});
it('mission includes an active crew seat and the inbox owns its paused goal', async () => {
  const { crew } = await client.createCrew(pid, { name: 'R4 crew', template: 'ship', seats: { lead: 'plannerbot', builder: 'execbot', reviewer: 'plannerbot' } });
  await client.crewAction(pid, crew.id, 'goal', { text: 'sleep:5000 ask: choose an approach' });
  await waitUntil(async () => (await client.workspace.mission()).chats.some(c => c.stopScope === 'crew'));
  const chat = (await client.workspace.mission()).chats.find(c => c.stopScope === 'crew')!;
  expect((await post(`/chats/${chat.chat}/workspace/steer`, { text: 'use a small plan' })).status).toBe(200);
  await waitUntil(async () => (await client.workspace.inbox()).items.some(i => i.crewId === crew.id), 15000);
  expect((await client.workspace.inbox()).items.find(i => i.crewId === crew.id)?.action).toBe('say');
  await client.crewAction(pid, crew.id, 'stop');
}, 30000);
