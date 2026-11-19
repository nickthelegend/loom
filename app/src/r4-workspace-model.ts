export interface ProjectNotes { text: string; revision: string }
export interface NotesDraft { text: string; saved: ProjectNotes | null; saving: boolean; error: string }
export const emptyNotes = (): NotesDraft => ({ text: '', saved: null, saving: false, error: '' });
export function notesLoaded(draft: NotesDraft, notes: ProjectNotes, replace = false): NotesDraft {
  if (!replace && draft.saved && draft.text !== draft.saved.text) return draft;
  return { text: notes.text, saved: notes, saving: false, error: '' };
}
export function notesWrite(draft: NotesDraft): ProjectNotes {
  if (!draft.saved) throw new Error('Load the notes before saving');
  return { text: draft.text, revision: draft.saved.revision };
}
export function notesSaved(draft: NotesDraft, saved: ProjectNotes): NotesDraft {
  return { ...draft, saved, saving: false, error: '' };
}
export function notesPath(project: string) { return '/api/projects/' + encodeURIComponent(project) + '/notes'; }
