import { useEffect, useState } from "react";
import { Modal, ScrollView, Text, TextInput, TouchableOpacity, View } from "react-native";
import { api, type Creds } from "./api";
import { field, TAP } from "./components";
import { Markdown } from "./markdown";
import { T } from "./theme";
import { emptyNotes, notesLoaded, notesPath, notesSaved, notesWrite, type ProjectNotes } from "./r4-workspace-model";

function Action({ title, onPress, disabled = false }: { title: string; onPress: () => void; disabled?: boolean }) {
  return <TouchableOpacity accessibilityRole="button" disabled={disabled} onPress={onPress} style={{ minHeight: TAP, paddingHorizontal: 10, justifyContent: "center", opacity: disabled ? 0.5 : 1 }}><Text style={{ color: T.primary }}>{title}</Text></TouchableOpacity>;
}
export function ProjectNotesButton({ creds, projectId }: { creds: Creds; projectId: string }) {
  const [open, setOpen] = useState(false);
  return <><Action title="Notes" onPress={() => setOpen(true)} />{open && <Modal visible animationType="slide" onRequestClose={() => setOpen(false)}><NotesEditor key={creds.url + projectId} creds={creds} projectId={projectId} onClose={() => setOpen(false)} /></Modal>}</>;
}
function NotesEditor({ creds, projectId, onClose }: { creds: Creds; projectId: string; onClose: () => void }) {
  const [draft, setDraft] = useState(emptyNotes), [edit, setEdit] = useState(false), [loading, setLoading] = useState(true);
  useEffect(() => {
    let live = true;
    void api<ProjectNotes>(creds, notesPath(projectId)).then(n => { if (live) setDraft(d => notesLoaded(d, n)); }).catch(e => { if (live) setDraft(d => ({ ...d, error: e.message })); }).finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [creds, projectId]);
  const save = async () => {
    const body = notesWrite(draft); setDraft(d => ({ ...d, saving: true, error: '' }));
    try { const saved = await api<ProjectNotes>(creds, notesPath(projectId), { method: 'PUT', body: JSON.stringify(body) }); setDraft(d => notesSaved(d, saved)); }
    catch (e) { setDraft(d => ({ ...d, saving: false, error: (e as Error).message })); }
  };
  return <View style={{ flex: 1, paddingTop: 50, paddingHorizontal: 16, backgroundColor: T.bg }}>
    <View style={{ flexDirection: 'row', alignItems: 'center' }}><Text style={{ flex: 1, color: T.text, fontSize: 20 }}>Project notes</Text><Action title="Close" onPress={onClose} /></View>
    <View style={{ flexDirection: 'row' }}><Action title={edit ? 'Read' : 'Edit Markdown'} onPress={() => setEdit(!edit)} /><Action title={draft.saving ? 'Saving…' : 'Save'} disabled={loading || !draft.saved || draft.saving} onPress={() => { void save(); }} />
      <Action title="Reload" disabled={draft.saving} onPress={() => { setLoading(true); void api<ProjectNotes>(creds, notesPath(projectId)).then(n => setDraft(d => notesLoaded(d, n, true))).catch(e => setDraft(d => ({ ...d, error: e.message }))).finally(() => setLoading(false)); }} /></View>
    {draft.error ? <Text accessibilityRole="alert" style={{ color: T.err }}>{draft.error}</Text> : null}
    {loading ? <Text style={{ color: T.dim }}>Loading notes…</Text> : <ScrollView keyboardShouldPersistTaps="handled">{edit ? <TextInput accessibilityLabel="Project notes" multiline textAlignVertical="top" style={{ ...field, minHeight: 400 }} value={draft.text} onChangeText={text => setDraft(d => ({ ...d, text }))} /> : <Markdown text={draft.text || 'No notes yet. Tap Edit Markdown to start.'} />}</ScrollView>}
  </View>;
}
