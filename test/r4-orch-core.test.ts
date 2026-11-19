import fs from 'node:fs';
import path from 'node:path';
import { afterEach, it, expect } from 'vitest';
import { OrchestraEngine, type OrchestraHost, type OrchestraRun } from '../src/core/orchestra.js';
import { validatePlan, validateControls, runReport } from '../src/core/orchestra-r4/model.js';
import { doneCheck } from '../src/core/orchestra-r4/check.js';
import { ProjectRuntime } from '../src/daemon/runtime.js';
import { open, deferred } from './r3-fix-helpers.js';
import { tmpDir, waitUntil } from './helpers.js';
let rt: ProjectRuntime;
const releases: Array<() => void> = [];
afterEach(async () => { releases.splice(0).forEach(f => f()); await rt?.close(); });
const host = () => (rt.orchestra as unknown as { host: OrchestraHost }).host;
it('validates edited plans and limits without accepting duplicate ids, cycles or nonfinite options', () => {
  const task = { id: 'a', title: 'A', prompt: 'do it', agent: 'echo', dependsOn: [] };
  expect(validatePlan({ tasks: [task] })).toEqual([{ ...task, model: undefined, effort: undefined, touches: undefined }]);
  for (const plan of [null, [], [task, task], [{ ...task, dependsOn: ['missing'] }], [{ ...task, dependsOn: ['a'] }], [{ ...task, id: '../bad' }], [{ ...task, prompt: 3 }]]) expect(() => validatePlan(plan)).toThrow();
  for (const options of [{ check: '' }, { checkRounds: -1 }, { checkRounds: 1.5 }, { taskMinutes: NaN }, { taskMinutes: Infinity }, { taskMinutes: 0 }]) expect(() => validateControls(options)).toThrow();
});
it('kills an interrupted check process group and keeps only bounded output', async () => {
  const dir = path.join(tmpDir('r4-check'), 'path with spaces'), ctl = new AbortController();
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'child.cjs'), `const fs = require('node:fs');
    fs.writeFileSync('child.pid', String(process.pid));
    setTimeout(() => fs.writeFileSync('late.txt', 'late'), 10000);`);
  fs.writeFileSync(path.join(dir, 'check.cjs'), `require('node:child_process').spawn(process.execPath, ['child.cjs'], { stdio: 'ignore' });
    setInterval(() => {}, 1000);`);
  const check = doneCheck(`"${process.execPath}" "${path.join(dir, 'check.cjs')}"`, dir, ctl.signal);
  try {
    // Abort only once a real descendant exists, including on slow Windows CI.
    await waitUntil(() => fs.existsSync(path.join(dir, 'child.pid')));
  } finally { ctl.abort(); }
  expect((await check).ok).toBe(false);
  const pid = Number(fs.readFileSync(path.join(dir, 'child.pid'), 'utf8'));
  await waitUntil(() => { try { process.kill(pid, 0); return false; } catch { return true; } });
  expect(fs.existsSync(path.join(dir, 'late.txt'))).toBe(false);
  const output = await doneCheck(`"${process.execPath}" -e "process.stdout.write('x'.repeat(20000))"`, dir, new AbortController().signal);
  expect(output.ok).toBe(true); expect(output.output.length).toBe(16000);
});
it('skip waits for startup and keeps its slot occupied until cleanup settles', async () => {
  rt = await open(); const gate = deferred(); releases.push(gate.release);
  let entered = false; const make = host().makeAgent;
  host().makeAgent = (cfg, dir) => { const agent = make(cfg, dir), start = agent.start.bind(agent); agent.start = async () => { entered = true; await gate.promise; await start(); }; return agent; };
  const run = await rt.orchestra.compare({ prompt: 'write:forbidden.txt', entrants: ['a', 'b'] }); await waitUntil(() => entered);
  let settled = false; const skip = rt.orchestra.control(run.id, 'skip', { task: run.tasks[0]!.id }).then(() => { settled = true; });
  await new Promise(r => setTimeout(r, 50)); expect(settled).toBe(false);
  gate.release(); await skip;
  expect(run.tasks[0]!.status).toBe('cancelled'); expect(fs.existsSync(path.join(run.tasks[0]!.dir!, 'forbidden.txt'))).toBe(false);
});
it('hold during team admission prevents a worker starting when admission resolves', async () => {
  rt = await open(); const gate = deferred(); releases.push(gate.release); let admitted = false;
  host().coordinator = () => ({ admit: async () => { admitted = true; await gate.promise; return { go: true }; } });
  const run = await rt.orchestra.compare({ prompt: 'write:held.txt', entrants: ['a', 'b'] }); await waitUntil(() => admitted);
  await rt.orchestra.control(run.id, 'hold'); gate.release(); await new Promise(r => setTimeout(r, 100));
  expect(run.tasks.every(t => t.attempts === 0)).toBe(true);
  await rt.orchestra.control(run.id, 'release'); await waitUntil(() => run.status === 'completed'); expect(run.tasks.every(t => t.status === 'done')).toBe(true);
});
it('notes reach later worker briefings and fallback workers get a follow-up before merging', async () => {
  rt = await open(); const briefings: string[] = [], make = host().makeAgent;
  host().makeAgent = (cfg, dir) => { const a = make(cfg, dir), send = a.send.bind(a); a.steer = undefined; a.send = async input => { briefings.push(input.briefing ?? ''); await send(input); }; return a; };
  const run = await rt.orchestra.start({ goal: 'sleep:500', workers: ['a', 'b'], race: true, maxParallel: 1 });
  await waitUntil(() => !!run.tasks[0]!.dir); await rt.orchestra.control(run.id, 'say', { text: 'Keep API compatibility' });
  await waitUntil(() => run.status === 'completed');
  expect(run.tasks[0]!.attempts).toBe(2); expect(briefings.filter(b => b.includes('Keep API compatibility')).length).toBeGreaterThanOrEqual(2);
});
it('loads and resumes a 2.1 run with no new fields and preserves held state across restart', async () => {
  rt = await open(); const run = await rt.orchestra.start({ goal: 'sleep:2000', workers: ['a', 'b'], race: true, maxParallel: 1 });
  await waitUntil(() => !!run.tasks[0]!.dir); await rt.orchestra.control(run.id, 'hold'); await rt.orchestra.shutdown();
  const oldHost = host(); const restored = new OrchestraEngine(oldHost);
  try { const loaded = restored.get(run.id)!; expect(loaded.held).toBe(true); expect(runReport(loaded).status).toBe('aborted'); await restored.resume(run.id); await new Promise(r => setTimeout(r, 50)); expect(loaded.tasks.every(t => t.status === 'pending')).toBe(true); await restored.control(run.id, 'release'); await waitUntil(() => loaded.status === 'completed'); }
  finally { await restored.shutdown(); }
  const file = path.join(rt.info.dir, '.loom', 'orchestra', `${run.id}.json`); const legacy = JSON.parse(fs.readFileSync(file, 'utf8')) as OrchestraRun;
  delete legacy.held; delete legacy.workerNotes; delete legacy.taskMinutes; delete legacy.check; delete legacy.checkRounds;
  legacy.status = 'aborted'; legacy.interrupted = { at: Date.now(), tasks: legacy.tasks.map(t => t.id), phase: 'running' }; legacy.tasks.forEach(t => { t.status = 'cancelled'; }); fs.writeFileSync(file, JSON.stringify(legacy));
  const engine = new OrchestraEngine(oldHost);
  try { const loaded = await engine.resume(run.id); await waitUntil(() => loaded.status === 'completed'); expect(runReport(loaded).tasks).toHaveLength(2); } finally { await engine.shutdown(); }
});

it('a follow-up after idle time gets a fresh per-turn deadline', async () => {
  rt = await open();
  const gate = deferred(); releases.push(gate.release);
  const make = host().makeAgent;
  let secondStarted = false, firstDeadline = 0;
  host().makeAgent = (cfg, dir) => {
    const agent = make(cfg, dir), send = agent.send.bind(agent);
    agent.send = async input => {
      if (cfg.id === 'a' && input.text.includes('second turn')) { secondStarted = true; await gate.promise; }
      await send(input);
    };
    return agent;
  };
  const run = await rt.orchestra.start({ goal: 'Turn limit', workers: ['a'], orchestrator: 'b', taskMinutes: 0.02,
    savedTasks: [{ id: 't1', title: 'First', prompt: 'hello', agent: 'a', dependsOn: [] }] });
  await waitUntil(() => { firstDeadline ||= run.tasks[0]!.deadlineAt ?? 0; return run.tasks[0]!.status === 'done' && run.tasks[0]!.finishedAt !== undefined; });
  const task = run.tasks[0]!;
  firstDeadline ||= task.startedAt! + 1200;
  expect(task.deadlineAt).toBeUndefined();
  await waitUntil(() => run.status === 'waiting_human');
  await new Promise(r => setTimeout(r, Math.max(0, firstDeadline - Date.now() + 50)));
  await rt.orchestra.reply(run.id, '```loom\n' + JSON.stringify({ actions: [{ type: 'send', task: task.id, message: 'second turn' }] }) + '\n```');
  await waitUntil(() => secondStarted);
  expect(task.deadlineAt).toBeGreaterThan(firstDeadline);
  rt.orchestra.checkStalled();
  expect(task.timedOutAt).toBeUndefined(); expect(task.status).toBe('running');
  gate.release(); await waitUntil(() => task.status === 'done' && task.finishedAt !== undefined);
  expect(task.attempts).toBe(2); expect(task.deadlineAt).toBeUndefined();
});
it('an extension starts at dispatch and is consumed for only one turn', async () => {
  rt = await open();
  const run = await rt.orchestra.start({ goal: 'sleep:3000', workers: ['a', 'b'], race: true, maxParallel: 1, taskMinutes: 0.001 });
  await waitUntil(() => !!run.tasks[0]!.timedOutAt);
  await rt.orchestra.control(run.id, 'hold');
  await rt.orchestra.control(run.id, 'extend', { task: run.tasks[0]!.id, minutes: 1 });
  const task = run.tasks[0]!;
  expect(task.extendedMinutes).toBe(1); expect(task.deadlineAt).toBeUndefined();
  const releaseAt = Date.now(); await rt.orchestra.control(run.id, 'release');
  await waitUntil(() => task.status === 'running');
  expect(task.extendedMinutes).toBeUndefined(); expect(task.deadlineAt).toBeGreaterThanOrEqual(releaseAt + 60_000);
});
it('crash recovery clears Held on a failed run', async () => {
  rt = await open();
  const run = await rt.orchestra.start({ goal: 'sleep:3000', workers: ['a', 'b'], race: true });
  await rt.orchestra.control(run.id, 'hold'); await rt.orchestra.shutdown();
  const file = path.join(rt.info.dir, '.loom', 'orchestra', `${run.id}.json`);
  const crashed = JSON.parse(fs.readFileSync(file, 'utf8')) as OrchestraRun;
  crashed.status = 'running'; crashed.held = true; delete crashed.interrupted;
  fs.writeFileSync(file, JSON.stringify(crashed));
  const restored = new OrchestraEngine(host());
  try {
    expect(restored.get(run.id)).toMatchObject({ status: 'failed', held: false });
    expect(runReport(restored.get(run.id)!).status).toBe('failed');
  } finally { await restored.shutdown(); }
});
