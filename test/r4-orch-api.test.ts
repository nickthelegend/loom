import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, execFile } from 'node:child_process';
import { beforeAll, afterAll, afterEach, it, expect } from 'vitest';
import { LoomDaemon } from '../src/daemon/server.js';
import { DaemonClient } from '../src/daemon/client.js';
import { readDaemonConfig } from '../src/core/registry.js';
import type { OrchestraRun, OrchestraStartOptions } from '../src/core/orchestra.js';
import { runRecipeOptions } from '../src/core/orchestra-options.js';
import { savedPlan } from '../src/core/orchestra-r4/model.js';
import { makeProjectDir, tmpDir, waitUntil } from './helpers.js';

let daemon: LoomDaemon, client: DaemonClient, project: string, dir: string, admin: string, phone: string, scoped: string;
const root = process.cwd();
const base = () => `/api/projects/${project}/orchestra`;
async function api(route: string, body?: unknown, token = admin) {
  const res = await fetch(client.baseUrl + route, { method: body === undefined ? 'GET' : 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: res.status, body: await res.json() };
}
const post = (run: OrchestraRun, action: string, body: unknown = {}, token = admin) => api(`${base()}/${run.id}/${action}`, body, token);
const get = async (run: OrchestraRun) => (await client.orchestraRun(project, run.id)).run;
const cli = (args: string[]) => new Promise<{ code: number; out: string }>(resolve => execFile(process.execPath, [path.join(root, 'node_modules/tsx/dist/cli.mjs'), path.join(root, 'src/cli/index.ts'), ...args], { cwd: dir, env: { ...process.env, NO_COLOR: '1' }, timeout: 30000 }, (err, stdout, stderr) => resolve({ code: err ? 1 : 0, out: stdout + stderr })));
async function preview(prompt = 'sleep:600', options: Partial<OrchestraStartOptions> = {}) {
  const run = (await client.startOrchestra(project, { goal: 'Plan work', orchestrator: 'lead', workers: ['worker'], planOnly: true, ...options })).run;
  await waitUntil(async () => (await get(run)).status === 'waiting_human');
  const actions = [{ type: 'spawn', id: 'first', title: 'First', prompt, agent: 'worker' }, { type: 'spawn', id: 'second', title: 'Second', prompt: 'write:second.txt', agent: 'worker', dependsOn: ['first'], touches: ['src/auth/**'] }];
  const text = '```loom\n' + JSON.stringify({ actions }).replaceAll('sleep:', '\\u0073leep:').replaceAll('write:', '\\u0077rite:').replaceAll('fail:', '\\u0066ail:') + '\n```';
  expect((await post(run, 'reply', { text })).status).toBe(200);
  await waitUntil(async () => (await get(run)).tasks.length === 2);
  return get(run);
}
async function pair(body = {}) {
  const invitation = await api('/api/pair/new', body);
  const claim = await fetch(client.baseUrl + '/api/pair/claim', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: invitation.body.token, name: 'test phone' }) });
  return (await claim.json()).clientToken as string;
}
beforeAll(async () => {
  process.env.LOOM_HOME = tmpDir('r4-orch-home'); process.env.LOOM_NO_NOTIFY = '1';
  daemon = new LoomDaemon({ host: '127.0.0.1', port: 0 }); await daemon.listen();
  client = new DaemonClient(readDaemonConfig()!); admin = readDaemonConfig()!.adminToken;
  dir = makeProjectDir({ agents: [{ id: 'lead', kind: 'echo', role: 'planner' }, { id: 'worker', kind: 'echo', role: 'worker' }] });
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir });
  git('init', '-q'); fs.writeFileSync(path.join(dir, '.gitignore'), '.loom/\n'); git('add', '-A'); git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'seed');
  project = (await client.addProject(dir)).project.id;
  phone = await pair(); scoped = await pair({ owner: false, host: '127.0.0.1', projects: [project] });
}, 30000);
afterEach(async () => { for (const run of (await client.orchestraRuns(project)).runs) if (!['completed', 'aborted', 'failed', 'moved'].includes(run.status)) await post(run, 'abort'); });
afterAll(async () => { await daemon.close(); });

it('adds a manually assigned task with a dependency and rejects missing dependencies', async () => {
  const run = await preview();
  expect((await post(run, 'tasks', { text: 'Extra', after: 'missing' })).status).toBe(400);
  const added = await post(run, 'tasks', { text: 'write:extra.txt', agent: 'worker@special', after: 'second' }, scoped);
  expect(added.status).toBe(200); expect(added.body.run.tasks[2]).toMatchObject({ model: 'special', dependsOn: ['second'], attempts: 0 });
  await post(run, 'approve-plan', {}, phone);
  await waitUntil(async () => (await get(run)).tasks.every(t => t.status === 'done'));
  expect(fs.existsSync(path.join(run.dir, 'extra.txt'))).toBe(true);
});
it('holds dispatch while workers finish and releases pending work without losing status', async () => {
  const run = await preview('sleep:800'); await post(run, 'approve-plan');
  await waitUntil(async () => (await get(run)).tasks[0]!.status === 'running');
  expect((await post(run, 'hold', {}, phone)).status).toBe(200);
  await waitUntil(async () => (await get(run)).tasks[0]!.status === 'done');
  expect((await get(run)).tasks[1]!.attempts).toBe(0); expect((await get(run)).held).toBe(true);
  expect((await post(run, 'release', {}, scoped)).status).toBe(200);
  await waitUntil(async () => (await get(run)).tasks[1]!.status === 'done');
});
it('skips a running task and transitively records why dependent tasks were skipped', async () => {
  const run = await preview('sleep:4000 write:must-not-exist.txt'); await post(run, 'approve-plan');
  await waitUntil(async () => !!(await get(run)).tasks[0]!.dir);
  const result = await post(run, 'tasks/first/skip', {}, phone);
  expect(result.status).toBe(200); expect(result.body.run.tasks.map((t: { status: string }) => t.status)).toEqual(['cancelled', 'cancelled']);
  expect(result.body.run.tasks[1].skippedReason).toContain('Dependency first');
  expect(fs.existsSync(path.join(run.dir, 'must-not-exist.txt'))).toBe(false);
  expect((await get(run)).status).not.toBe('aborted');
});
it('edits a preview atomically, rejects cycles and unknown agents, and approves the changed order', async () => {
  const run = await preview(); const plan = savedPlan(run).reverse();
  plan.forEach(t => { delete t.touches; });
  plan[0]!.dependsOn = []; plan[0]!.title = 'Renamed'; plan[0]!.agent = 'worker@edited';
  const cycle = plan.map(t => ({ ...t, dependsOn: [t.id === 'first' ? 'second' : 'first'] }));
  expect((await post(run, 'plan', { plan: cycle })).status).toBe(400);
  expect((await get(run)).tasks[0]!.title).toBe('First');
  expect((await post(run, 'plan', { plan: [{ ...plan[0], agent: 'unknown-no-agent' }] })).status).toBe(400);
  const edited = await post(run, 'plan', { plan: [plan[0]] }, phone);
  expect(edited.status).toBe(200); expect(edited.body.run.tasks[0]).toMatchObject({ id: 'second', title: 'Renamed', model: 'edited', touches: ['src/auth/**'] });
  expect((await post(run, 'approve', {}, phone)).status).toBe(200);
  await waitUntil(async () => (await get(run)).tasks[0]!.status === 'done');
});
it('replays a saved plan on another fleet with a new run id and no planner turn', async () => {
  const run = await preview('write:first.txt'); await post(run, 'approve-plan');
  await waitUntil(async () => (await get(run)).tasks.every(t => t.status === 'done')); await post(run, 'abort');
  const result = await post(run, 'rerun', { workers: ['lead@new'] }, phone);
  expect(result.status).toBe(200); const next = result.body.run as OrchestraRun;
  expect(next.id).not.toBe(run.id); expect(next.rerunOf).toBe(run.id); expect(next.round).toBe(0);
  expect(next.tasks.map(t => t.id)).toEqual(['first', 'second']); expect(next.tasks.every(t => t.model === 'new')).toBe(true);
  await waitUntil(async () => (await get(next)).tasks.every(t => t.status === 'done'));
});
it('reruns only unsuccessful tasks with their successful dependency files available', async () => {
  const run = await preview('write:first.txt');
  const plan = savedPlan(run); plan[1]!.prompt = 'fail:expected';
  await post(run, 'approve-plan', { plan });
  await waitUntil(async () => (await get(run)).tasks[1]!.status === 'failed'); await post(run, 'abort');
  const result = await post(run, 'rerun', { onlyFailed: true }); expect(result.status).toBe(200);
  const next = result.body.run as OrchestraRun; expect(next.tasks.map(t => t.id)).toEqual(['second']);
  expect(fs.existsSync(path.join(next.dir, 'first.txt'))).toBe(true);
});
it('compares two saved runs and exports a complete Markdown report', async () => {
  const run = await preview('write:one.txt'); await post(run, 'approve-plan');
  await waitUntil(async () => (await get(run)).tasks.every(t => t.status === 'done')); await post(run, 'abort');
  const next = (await post(run, 'rerun')).body.run as OrchestraRun;
  await waitUntil(async () => (await get(next)).tasks.every(t => t.status === 'done')); await post(next, 'abort');
  const comparison = await api(`${base()}/compare?a=${run.id}&b=${next.id}`, undefined, scoped);
  expect(comparison.status).toBe(200); expect(comparison.body.tasks).toHaveLength(2); expect(comparison.body.a.files).toContain('one.txt');
  const report = await api(`${base()}/${run.id}/report`, undefined, phone);
  expect(report.body.markdown).toContain('Open questions'); expect(report.body.tasks[0].durationMs).toBeGreaterThan(0); expect(report.body.costUsd).toBeGreaterThan(0);
  expect((await api(`${base()}/compare?a=missing&b=${next.id}`)).status).toBe(404);
});
it('runs checks in worker worktrees, feeds failure output back and integrates only after a passing check', async () => {
  const check = `"${process.execPath}" -e "const fs=require('node:fs');if(!fs.existsSync('.checked')){fs.writeFileSync('.checked','');console.log('repair me');process.exit(1)}"`;
  const run = await preview('write:checked.txt', { check, checkRounds: 1 }); await post(run, 'approve-plan');
  await waitUntil(async () => (await get(run)).tasks[0]!.status === 'done');
  const task = (await get(run)).tasks[0]!; expect(task.attempts).toBe(2); expect(task.checkFailures).toBe(1); expect(task.result).toContain('repair me');
  expect(fs.existsSync(path.join(run.dir, 'checked.txt'))).toBe(true);
  expect(runRecipeOptions(await get(run))).toMatchObject({ check, checkRounds: 1 });
});
it('exhausts check rounds into needs-you without merging failed work', async () => {
  const run = await preview('write:not-integrated.txt', { check: `"${process.execPath}" -e "console.log('still broken');process.exit(1)"`, checkRounds: 1 }); await post(run, 'approve-plan');
  await waitUntil(async () => (await get(run)).tasks[0]!.status === 'needs_input');
  const current = await get(run); expect(current.tasks[0]!.attempts).toBe(2); expect(current.status).toBe('waiting_human'); expect(current.tasks[1]!.attempts).toBe(0);
  expect(current.tasks[0]!.checkOutput).toContain('still broken'); expect(fs.existsSync(path.join(run.dir, 'not-integrated.txt'))).toBe(false);
});
it('times out into needs-you and extends the task in its original worktree', async () => {
  const run = await preview('sleep:2200', { taskMinutes: 0.001 }); await post(run, 'approve-plan');
  await waitUntil(async () => !!(await get(run)).tasks[0]!.timedOutAt);
  const timed = (await get(run)).tasks[0]!; expect(timed.status).toBe('needs_input');
  expect((await post(run, 'tasks/first/extend', { minutes: -1 })).status).toBe(400);
  expect((await post(run, 'tasks/first/extend', { minutes: 1 }, phone)).status).toBe(200);
  await waitUntil(async () => (await get(run)).tasks[0]!.status === 'done');
  expect((await get(run)).tasks[0]!.dir).toBe(timed.dir);
});
it('broadcasts to a running worker and saves notes for later briefings', async () => {
  const run = await preview('sleep:1000'); await post(run, 'approve-plan');
  await waitUntil(async () => !!(await get(run)).tasks[0]!.dir); await new Promise(r => setTimeout(r, 100));
  expect((await post(run, 'say', { text: 'Remember accessibility' }, scoped)).status).toBe(200);
  await waitUntil(async () => (await get(run)).tasks.every(t => t.status === 'done'));
  const current = await get(run); expect(current.workerNotes).toEqual(['Remember accessibility']); expect(current.tasks[0]!.result).toContain('Remember accessibility');
});
it('refuses share-live guests on every new route, while scoped tokens stay inside their project', async () => {
  const run = await preview(); const guest = await pair({ guest: { project, chat: run.chat, role: 'approve', name: 'guest' } });
  for (const action of ['hold', 'release', 'tasks', 'plan', 'approve', 'approve-plan', 'rerun', 'say', 'tasks/first/skip', 'tasks/first/extend']) expect((await post(run, action, {}, guest)).status, action).toBe(403);
  for (const route of [`${base()}/${run.id}/report`, `${base()}/compare?a=${run.id}&b=${run.id}`]) expect((await api(route, undefined, guest)).status).toBe(403);
  expect((await api('/api/projects/not-their-project/orchestra/compare?a=x&b=y', undefined, scoped)).status).toBe(403);
});
it('CLI adds, holds, skips, releases, broadcasts, approves edited JSON, reruns, diffs and writes Markdown', async () => {
  const run = await preview('sleep:800');
  for (const args of [['orchestra:add', run.id, 'Extra', '--after', 'second'], ['orchestra:hold', run.id], ['orchestra:say', run.id, 'Ship it'], ['orchestra:skip', run.id, 't3'], ['orchestra:release', run.id]]) {
    const result = await cli(args); expect(result.code, result.out).toBe(0);
  }
  const file = path.join(tmpDir('r4-plan'), 'plan.json'); fs.writeFileSync(file, JSON.stringify(savedPlan(await get(run)).filter(t => t.id !== 't3')));
  const approved = await cli(['orchestra:approve', run.id, '--plan', file]); expect(approved.code, approved.out).toBe(0); expect(approved.out).toContain('plan approved');
  await waitUntil(async () => (await get(run)).tasks.every(t => t.status === 'done')); await post(run, 'abort');
  for (const args of [['orchestra:diff', run.id, run.id], ['orchestra:report', run.id, '--md', file + '.md'], ['orchestra:rerun', run.id, '-w', 'worker']]) { const r = await cli(args); expect(r.code, r.out).toBe(0); }
  expect(fs.readFileSync(file + '.md', 'utf8')).toContain('## first');
}, 120000);
it('CLI passes checks, retry rounds and time limits through the existing start action', async () => {
  const result = await cli(['orchestrate', 'hello', '-o', 'lead', '-w', 'workerx2', '--race', '--no-watch', '--check', 'exit 0', '--check-rounds', '0', '--task-minutes', '2']);
  expect(result.code, result.out).toBe(0);
  const run = (await client.orchestraRuns(project)).runs[0]!; expect(run).toMatchObject({ check: 'exit 0', checkRounds: 0, taskMinutes: 2 });
});
it('reassignment resets the task deadline, and skip after a timeout leaves independent tasks resumable', async () => {
  const run = await preview('sleep:2200', { taskMinutes: 0.001 }); await post(run, 'approve-plan');
  await waitUntil(async () => !!(await get(run)).tasks[0]!.timedOutAt);
  const original = (await get(run)).tasks[0]!.deadlineAt!;
  const reassigned = await post(run, 'tasks/first/reassign', { agent: 'lead@second-model' }, phone);
  expect(reassigned.status).toBe(200); expect(reassigned.body.run.tasks[0].deadlineAt).toBeGreaterThan(original);
  await waitUntil(async () => !!(await get(run)).tasks[0]!.timedOutAt);
  expect((await post(run, 'tasks/first/skip', {}, phone)).status).toBe(200);
  expect((await get(run)).tasks[0]!.skippedReason).toBeTruthy();
  expect((await post(run, 'tasks/first/extend', { minutes: 1 })).status).toBe(400);
});
it('includes unmerged changed files and questions in a failed-check report', async () => {
  const run = await preview('write:unfinished.txt', { check: 'exit 1', checkRounds: 0 }); await post(run, 'approve-plan');
  await waitUntil(async () => (await get(run)).tasks[0]!.status === 'needs_input');
  const report = await api(`${base()}/${run.id}/report`);
  expect(report.body.files).toContain('unfinished.txt'); expect(report.body.openQuestions.length).toBeGreaterThan(0);
  expect(fs.existsSync(path.join(run.dir, 'unfinished.txt'))).toBe(false);
});
it('manual assignment can add another configured agent to the fleet', async () => {
  const run = await preview(); const added = await post(run, 'tasks', { text: 'hello', agent: 'lead@chosen' });
  expect(added.status).toBe(200); expect(added.body.run.tasks[2]).toMatchObject({ agent: 'lead@chosen', model: 'chosen' });
  expect(added.body.run.workers).toContain('lead@chosen');
});

it('scoped clients may start runs with timing options but cannot supply a shell check', async () => {
  const options = { goal: 'Scoped run', workers: ['worker'], orchestrator: 'lead', planOnly: true, checkRounds: 0, taskMinutes: 1 };
  expect((await api(base(), { ...options, check: 'exit 0' }, scoped)).status).toBe(403);
  expect((await api(base(), options, scoped)).status).toBe(200);
});
it('plan approval, editing, reassignment and extension retain the owner gate', async () => {
  const run = await preview();
  for (const [action, body] of [
    ['approve', {}], ['plan', { plan: savedPlan(run) }],
    ['tasks/first/reassign', { agent: 'worker' }], ['tasks/first/extend', { minutes: 1 }],
  ] as const) expect((await post(run, action, body, scoped)).status, action).toBe(403);
  expect((await post(run, 'hold', {}, scoped)).status).toBe(200);
  expect((await get(run)).planApprovedAt).toBeUndefined();
});
