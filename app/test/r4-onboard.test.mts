import { test } from 'node:test';
import assert from 'node:assert/strict';
import { searchGuides, shouldShowRelease, tourPosition, exampleInstallRoute, scenarioLocation } from '../src/r4-onboard-model.ts';

test('phone help searches every word across titles and guide text', () => {
  const guides = [{ id: 'brain', title: 'Brain', body: 'Shared memory across agents' }, { id: 'review', title: 'Review', body: 'Inspect a diff' }];
  assert.deepEqual(searchGuides(guides, ' BRAIN memory '), [guides[0]]);
  assert.deepEqual(searchGuides(guides, 'missing'), []); assert.deepEqual(searchGuides(guides, ''), guides);
});
test('fresh phones record the version silently; saved locations and older markers show upgrades', () => {
  assert.equal(shouldShowRelease(null, '2.2.0'), false); assert.equal(shouldShowRelease(null, '2.2.0', true), true); assert.equal(shouldShowRelease(null, '2.1.0'), false); assert.equal(shouldShowRelease('2.1.0', '2.2.0'), true); assert.equal(shouldShowRelease('2.2.0', '2.2.0'), false);
});
test('tour progress resumes, clamps stale state and preserves completion', () => {
  assert.equal(tourPosition(null, 2), 0); assert.equal(tourPosition('1', 2), 1); assert.equal(tourPosition('2', 2), 2); assert.equal(tourPosition('100', 2), 2); assert.equal(tourPosition('bad', 2), 0); assert.equal(tourPosition('-4', 2), 0);
});
test('phone installs project triggers and machine-wide examples through the correct access boundary', () => {
  const e = { name: 'daily-review', kind: 'trigger', title: 'Daily', description: '' };
  assert.throws(() => exampleInstallRoute(e), /Choose a project/);
  assert.equal(exampleInstallRoute(e, 'project/one'), '/api/projects/project%2Fone/examples/daily-review/install');
  assert.equal(exampleInstallRoute({ ...e, name: 'small-change', kind: 'recipe' }, 'p'), '/api/help/examples/small-change/install');
});

test('demo scenarios open their result chat and fleet view instead of an empty main chat', () => {
  assert.deepEqual(scenarioLocation('p', { chat: 'memory-chat' }), { project: 'p', chat: 'memory-chat', tab: 'thread' });
  assert.deepEqual(scenarioLocation('p', { review: { chat: 'review-chat' } }), { project: 'p', chat: 'review-chat', tab: 'thread' });
  assert.deepEqual(scenarioLocation('p', { run: { chat: 'fleet-chat' } }), { project: 'p', chat: 'fleet-chat', tab: 'orchestra' });
});
