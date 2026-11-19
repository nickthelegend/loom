import { useState } from "react";
import { Modal, ScrollView, TextInput, TouchableOpacity, View } from "react-native";
import { T } from "../theme";
import { moveReply } from "./model";
import { Text, savePreferences, usePhonePreferences } from "./preferences";
export function QuickReplies({ onUse }: { onUse: (text: string) => void }) {
  const p = usePhonePreferences(), [edit, setEdit] = useState(false), [error, setError] = useState(""), [draft, setDraft] = useState<string[]>([]);
  const open = () => { setDraft([...p.replies]); setError(""); setEdit(true); };
  const save = async () => { try { await savePreferences({ replies: draft.map(r => r.trim()).filter(Boolean) }); setEdit(false); } catch (e) { setError(String(e)); } };
  return <View>
    <ScrollView horizontal keyboardShouldPersistTaps="always" contentContainerStyle={{ gap: 8, paddingHorizontal: 12 }}>
      {p.replies.map((r, i) => <TouchableOpacity key={i} onPress={() => onUse(r)} onLongPress={open} accessibilityRole="button" style={{ padding: 12 }}><Text style={{ color: T.thread }}>{r}</Text></TouchableOpacity>)}
      <TouchableOpacity onPress={open} style={{ padding: 12 }}><Text style={{ color: T.dim }}>Edit replies</Text></TouchableOpacity>
    </ScrollView>
    <Modal visible={edit} onRequestClose={() => setEdit(false)} animationType="slide"><ScrollView contentContainerStyle={{ padding: 24, backgroundColor: T.bg, flexGrow: 1 }} keyboardShouldPersistTaps="handled">
      <Text style={{ color: T.text, fontSize: 20 }}>Quick replies</Text>
      {draft.map((r, i) => <View key={i} style={{ marginTop: 12 }}>
        <TextInput accessibilityLabel={`Reply ${i + 1}`} value={r} onChangeText={text => setDraft(draft.map((v, j) => i === j ? text.slice(0, 200) : v))} style={{ color: T.text, padding: 12, borderColor: T.line, borderWidth: 1 }} />
        <View style={{ flexDirection: "row", gap: 20 }}>{[-1, 1].map(d => <TouchableOpacity key={d} onPress={() => setDraft(moveReply(draft, i, d))} style={{ padding: 12 }}><Text style={{ color: T.thread }}>{d < 0 ? "Move up" : "Move down"}</Text></TouchableOpacity>)}<TouchableOpacity onPress={() => setDraft(draft.filter((_, j) => i !== j))} style={{ padding: 12 }}><Text style={{ color: T.err }}>Remove</Text></TouchableOpacity></View>
      </View>)}
      {draft.length < 12 && <TouchableOpacity onPress={() => setDraft([...draft, "New reply"])} style={{ padding: 12 }}><Text style={{ color: T.thread }}>Add reply</Text></TouchableOpacity>}
      <Text style={{ color: T.err }}>{error}</Text><TouchableOpacity onPress={() => void save()} style={{ padding: 12 }}><Text style={{ color: T.text }}>Save replies</Text></TouchableOpacity>
    </ScrollView></Modal>
  </View>;
}
