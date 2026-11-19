import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { toolLine, hoursSummary, alertState, examplePath } from '../src/r4-insights-model.ts';
describe('phone insights', () => {
  it('opens a failure example through the scoped project query route', () => { assert.equal(examplePath('a/b', 42), '/api/projects/a%2Fb/events/query?id=42'); });
  it('distinguishes unknown measurements from measured zero', () => {
    assert.match(toolLine({ name: 'shell', calls: 2, failures: 0, failureRate: null, averageMs: null }), /outcomes unknown.*duration unmeasured/);
    assert.match(toolLine({ name: 'shell', calls: 2, failures: 0, failureRate: 0, averageMs: 0 }), /0.0% failed.*0.0 ms average/);
  });
  it('summarizes hours with the timesheet timezone', () => { assert.equal(hoursSummary({ timezone: 'UTC', totalMs: 5400000, entries: [] }), '1.50 active agent hours · UTC'); });
  it('renders paused, firing and watching alert states', () => {
    assert.equal(alertState({ id: 'a', expression: '', paused: true, firing: true }), 'paused');
    assert.equal(alertState({ id: 'a', expression: '', paused: false, firing: true }), 'firing');
    assert.equal(alertState({ id: 'a', expression: '', paused: false, firing: false }), 'watching');
  });
});
