import { test } from 'node:test';
import assert from 'node:assert/strict';
import { editPlan, taskOptions, heldActive } from '../src/r4-orch-model.ts';
const tasks = [{ id: 'a', title: 'A', prompt: 'A', agent: 'echo', dependsOn: [] }, { id: 'b', title: 'B', prompt: 'B', agent: 'echo', dependsOn: ['a'] }];
test('phone plan reorder preserves assignments and dependency ids without mutating its input', () => {
  const next = editPlan(tasks, 0, 'down'); assert.deepEqual(next.map(t => t.id), ['b', 'a']); assert.deepEqual(next[0]!.dependsOn, ['a']); assert.equal(tasks[0]!.id, 'a');
  assert.deepEqual(editPlan(next, 1, 'up'), tasks); assert.deepEqual(editPlan(tasks, 0, 'up'), tasks);
});
test('phone removal removes dangling dependencies', () => { const next = editPlan(tasks, 0, 'remove'); assert.equal(next.length, 1); assert.deepEqual(next[0]!.dependsOn, []); });
test('phone check and time limit options retain explicit zero rounds and reject invalid limits', () => {
  assert.deepEqual(taskOptions(' npm test ', '0', '2.5'), { check: 'npm test', checkRounds: 0, taskMinutes: 2.5 });
  assert.deepEqual(taskOptions('', '', ''), { check: undefined, checkRounds: undefined, taskMinutes: undefined });
  for (const value of ['0', '-1', 'Infinity', 'NaN', '10081']) assert.throws(() => taskOptions('', '', value));
  for (const value of ['-1', '1.5', '21', 'NaN']) assert.throws(() => taskOptions('', value, ''));
});

test('phone shows Held only for active runs, retaining resumable terminal flags', () => {
  for (const status of ['completed', 'failed', 'aborted', 'moved']) assert.equal(heldActive({ status, held: true }), false);
  for (const status of ['starting', 'planning', 'running', 'reviewing', 'waiting_human']) {
    assert.equal(heldActive({ status, held: true }), true);
    assert.equal(heldActive({ status }), false);
  }
});
