import { afterEach, expect, it, vi } from 'vitest';
import { Command } from 'commander';
import type { OrchestraRun, OrchestraTask } from '../src/core/orchestra.js';
import { control, type ControlHost } from '../src/core/orchestra-r4/control.js';
import { runReport, skipDependents } from '../src/core/orchestra-r4/model.js';
import { runEvents } from '../src/cli/run-progress.js';
import { registerR4Orchestra } from '../src/cli/r4-orch.js';
import type { DaemonClient } from '../src/daemon/client.js';
import { deferred } from './r3-fix-helpers.js';

afterEach(() => vi.restoreAllMocks());
function fixture() {
  const task = { id: 't1', title: 'One', agent: 'echo', status: 'needs_input', timedOutAt: Date.now(), dependsOn: [], queued: [] } as unknown as OrchestraTask;
  const run = { id: 'r1', status: 'waiting_human', tasks: [task], taskMinutes: 1, question: 't1: Task time limit reached', createdAt: 1, updatedAt: 2, costUsd: 0 } as OrchestraRun;
  const unused = () => { throw new Error('unexpected host call'); };
  const host: ControlHost = {
    get: () => run, save: vi.fn(), schedule: vi.fn(), add: unused, include: unused, assignment: unused,
    stop: vi.fn(async () => {}), skip: vi.fn(async (r, t, reason) => skipDependents(r, t, reason)),
    note: unused, approve: unused, start: unused, retry: vi.fn(async () => run), busy: () => false,
  };
  return { run, task, host };
}
for (const action of ['extend', 'skip']) {
  for (const change of ['aborted', 'moved'] as const) it(`${action} cannot revive or save a run ${change} while its stop is pending`, async () => {
    const { run, task, host } = fixture(), gate = deferred();
    let entered = false;
    if (action === 'extend') host.stop = async () => { entered = true; await gate.promise; };
    else host.skip = async () => { entered = true; await gate.promise; return [task]; };
    const pending = control(host, run.id, action, { task: task.id, minutes: 5 });
    expect(entered).toBe(true);
    if (change === 'moved') run.moving = true; else run.status = 'aborted';
    const rejected = expect(pending).rejects.toThrow('run is not active');
    gate.release(); await rejected;
    expect(host.retry).not.toHaveBeenCalled(); expect(host.schedule).not.toHaveBeenCalled(); expect(host.save).not.toHaveBeenCalled();
    expect(run.status).toBe(change === 'aborted' ? 'aborted' : 'waiting_human');
  });
}
it('Extend passes minutes to retry, so idle time does not consume the extension', async () => {
  const { run, task, host } = fixture();
  await control(host, run.id, 'extend', { task: task.id, minutes: 5 });
  expect(host.retry).toHaveBeenCalledWith(run.id, task.id, 'echo', 5);
});
for (const failures of [undefined, 2, 3]) it(`skip resumes review for a worker question unless check repairs are exhausted (${failures})`, async () => {
  const { run, task, host } = fixture();
  run.tasks.push({ ...task, id: 't2', timedOutAt: undefined, checkFailures: failures, result: 'Which approach?' });
  await control(host, run.id, 'skip', { task: task.id });
  expect(task.status).toBe('cancelled');
  expect(run.status).toBe(failures === 3 ? 'waiting_human' : 'running');
  if (failures !== 3) expect(run.question).toBeUndefined();
  expect(host.schedule).toHaveBeenCalledWith(run);
});
it('skip retains a human wait when another task has timed out', async () => {
  const { run, task, host } = fixture(); run.tasks.push({ ...task, id: 't2' });
  await control(host, run.id, 'skip', { task: task.id });
  expect(run.status).toBe('waiting_human');
});
for (const status of ['completed', 'failed', 'aborted', 'moved', 'running'] as const) {
  it(`reports and CLI display ${status} honestly when the saved held flag is set`, async () => {
    const { run } = fixture(); Object.assign(run, { status, held: true });
    const expected = status === 'running' ? 'held' : status;
    expect(runReport(run).status).toBe(expected);
    expect(runEvents(null, run)[0]).toMatchObject({ kind: 'run', status: expected });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const program = new Command();
    registerR4Orchestra(program, async () => ({ r4Orchestra: async () => ({ run }) }) as unknown as DaemonClient, async () => ({ id: 'project' }));
    await program.parseAsync(['node', 'loom', 'orchestra:hold', run.id]);
    expect(log).toHaveBeenCalledWith(`${run.id} · ${expected}`);
    expect(run.held).toBe(true);
  });
}
