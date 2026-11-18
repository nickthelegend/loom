import assert from 'node:assert/strict';
import { test } from 'node:test';
import { permissionIndicator, safetyPatterns, safetyPreset } from '../src/safety-model.ts';

test('safety presets are fresh and strict protects credential and policy paths', () => {
  const strict = safetyPreset('strict');
  assert.equal(strict.approvalTimeoutMin, 5); assert.ok(strict.protectedPaths.includes('.env'));
  strict.protectedPaths.push('test'); assert.ok(!safetyPreset('strict').protectedPaths.includes('test'));
  assert.equal(safetyPreset('normal').approvalTimeoutMin, 30); assert.equal(safetyPreset('trusting').approvalTimeoutMin, 60);
});
test('phone permission labels distinguish sandboxing from tool permissions', () => {
  assert.equal(permissionIndicator('codex', 'auto'), 'Auto · workspace sandbox');
  assert.equal(permissionIndicator('codex', 'bypass'), 'Bypass · no sandbox');
  assert.equal(permissionIndicator('claude-code', 'ask'), 'Ask · tool permissions');
  assert.equal(permissionIndicator('codex', 'ask'), 'Ask · read-only sandbox');
});
test('policy form retains globs and trims blank lines', () => {
  assert.deepEqual(safetyPatterns('  mcp__*\n\n Write? \n'), ['mcp__*', 'Write?']);
});
