import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyNotes, notesLoaded, notesSaved, notesWrite, notesPath } from '../src/r4-workspace-model.ts';
test('notes load/read/edit/save keep the conflict revision and preserve edits typed during a save', () => {
  const loaded = notesLoaded(emptyNotes(), { text: '# Notes', revision: 'one' });
  const edited = { ...loaded, text: 'My changes' };
  assert.deepEqual(notesWrite(edited), { text: 'My changes', revision: 'one' });
  assert.equal(notesLoaded(edited, { text: 'Remote changes', revision: 'two' }).text, 'My changes');
  const saved = notesSaved({ ...edited, text: 'Still typing' }, { text: 'My changes', revision: 'two' });
  assert.equal(saved.text, 'Still typing'); assert.equal(notesWrite(saved).revision, 'two');
  assert.equal(notesLoaded(saved, { text: 'Remote changes', revision: 'three' }, true).text, 'Remote changes');
});
test('notes cannot save before loading, and project paths are encoded', () => {
  assert.throws(() => notesWrite(emptyNotes()), /Load/);
  assert.equal(notesPath('a/b'), '/api/projects/a%2Fb/notes');
});
