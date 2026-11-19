import { beforeEach, expect, it } from 'vitest';
import { eventInbox, chatFiles, safeRelative } from '../src/core/workspace-r4/projections.js';
import { changePreferences, preferences, notes, saveNotes, workspaceSchema } from '../src/core/workspace-r4/store.js';
import type { LoomEvent } from '../src/types.js';
import { tmpDir } from './helpers.js';
const e = (id: number, kind: LoomEvent['kind'], payload: Record<string, unknown>, agentId: string | undefined = 'echo', chat = 'main') => ({ id, ts: id * 1000, kind, payload, agentId, chat }) as LoomEvent;
beforeEach(() => { process.env.LOOM_HOME = tmpDir('r4-model-home'); });
it('retains message-mode questions across completion and clears only the answered chat', () => {
  const events = [e(1, 'needs_input', { question: 'One?' }), e(2, 'run_complete', {}), e(3, 'needs_input', { question: 'Two?' }, 'echo', 'second')];
  expect(eventInbox(events).map(i => i.chat)).toEqual(['main', 'second']);
  expect(eventInbox([...events, { ...e(4, 'message', { text: 'yes' }), agentId: undefined }]).map(i => i.chat)).toEqual(['second']);
  expect(eventInbox(events, [1]).map(i => i.chat)).toEqual(['second']);
});
it('structured answers clear the matching question and successful turns clear failures', () => {
  const events = [e(1, 'needs_input', { requestId: 'r', questions: [{ id: 'q', question: 'Choose?' }] }), e(2, 'error', { message: 'failed' }), e(3, 'run_complete', {})];
  expect(eventInbox(events.slice(0, 2))).toMatchObject([{ kind: 'failed', title: 'failed', eventId: 2 }]);
  expect(eventInbox(events)).toEqual([]);
  expect(eventInbox(events, [2])).toEqual([]);
  expect(eventInbox([events[0]!, e(2, 'status', { state: 'question_answered', requestId: 'r' })])).toEqual([]);
});
it('file references preserve origin messages, ignore remote/traversal paths and retain same-file message jumps', () => {
  const files = chatFiles([e(1, 'message', { text: '[file] .loom/attachments/a.pdf\n![shot](shot.png)\n[x](https://example.test)' }), e(2, 'tool_result', { images: [{ path: 'shot.png' }, { path: '../escape' }, { path: 'C:\\escape' }] }), e(3, 'file_edit', { path: 'output.svg' })]);
  expect(files.map(f => [f.path, f.eventId])).toEqual([['output.svg', 3], ['shot.png', 2], ['.loom/attachments/a.pdf', 1], ['shot.png', 1]]);
  expect(safeRelative('//evil/a')).toBe(false); expect(safeRelative('a/../b')).toBe(false); expect(safeRelative('javascript:alert(1)')).toBe(false);
});
it('layouts reject duplicate, missing, extra panes and external navigation', () => {
  const valid = { layout: { id: 'one' }, panes: { one: { hash: '#p/a/c/main' } }, focus: 'one' };
  expect(workspaceSchema.parse(valid)).toEqual(valid);
  for (const w of [{ ...valid, focus: 'two' }, { ...valid, panes: { one: { hash: 'https://evil.test' } } }, { ...valid, layout: { direction: 'row', children: [{ id: 'one' }, { id: 'one' }] } }]) expect(() => workspaceSchema.parse(w)).toThrow();
});
it('notes and owner preferences survive reads and reject lost updates', () => {
  const dir = tmpDir('r4-notes'), n = notes(dir); const saved = saveNotes(dir, { text: 'hello', revision: n.revision });
  expect(notes(dir)).toEqual(saved); expect(() => saveNotes(dir, { text: 'lost', revision: n.revision })).toThrow('changed');
  const next = changePreferences({ revision: 0, sidebar: { sections: [], projects: [{ id: 'a', pinned: true, section: null }] } });
  expect(preferences()).toEqual(next); expect(() => changePreferences({ revision: 0, sidebar: { sections: [], projects: [] } })).toThrow('changed');
});
it('worker plain questions belong to the engine inbox while structured crew questions retain the adapter identity', () => {
  expect(eventInbox([e(1, 'needs_input', { question: 'help', crew: { crewId: 'c' } })])).toEqual([]);
  expect(eventInbox([e(2, 'needs_input', { question: 'help', orchestra: { runId: 'o' } })])).toEqual([]);
  const question = e(3, 'needs_input', { question: 'which?', requestId: 'r', askAgent: 'crew-c-worker.echo', questions: [{ id: 'q', question: 'Which?' }], crew: { crewId: 'c' } });
  expect(eventInbox([question])[0]).toMatchObject({ agent: 'crew-c-worker.echo', requestId: 'r' });
  expect(eventInbox([question, e(4, 'status', { state: 'question_answered', requestId: 'old' })])).toHaveLength(1);
});

it('failures are superseded per agent and chat and cleared by retry or a user reply', () => {
  const failures = [e(1, 'error', { message: 'old' }), e(2, 'error', { message: 'latest' }), e(3, 'error', {}, 'other'), e(4, 'error', {}, 'echo', 'second')];
  expect(eventInbox(failures).map(i => i.eventId)).toEqual([2, 3, 4]);
  expect(eventInbox([...failures, e(5, 'status', { state: 'turn_started' })]).map(i => i.eventId)).toEqual([3, 4]);
  expect(eventInbox([...failures, { ...e(6, 'message', { text: 'try again' }), agentId: undefined }]).map(i => i.eventId)).toEqual([4]);
  expect(eventInbox(failures, new Set([2, 3, 4]))).toEqual([]);
});
it('file references strip code locations and ignore anchors and extensionless links', () => {
  const files = chatFiles([e(1, 'message', { text: '[section](#usage) [site](example.com/docs) [a](src/a.ts#L10) [b](src/b.ts:12:3) [c](src/c.ts:12) [x](https://site.test/a.png#x)' })]);
  expect(files.map(f => f.path)).toEqual(['src/a.ts', 'src/b.ts', 'src/c.ts']);
});
it('layouts accept empty, Home and project-only panes', () => {
  for (const hash of ['', '#home', '#p/alpha']) expect(workspaceSchema.parse({ layout: { id: 'one' }, panes: { one: { hash } }, focus: 'one' }).panes.one!.hash).toBe(hash);
});
