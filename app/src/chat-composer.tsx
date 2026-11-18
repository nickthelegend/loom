import { useEffect, useRef, useState } from "react";
import { Alert, Modal, Pressable, ScrollView, Share, Text, TextInput, TouchableOpacity, View } from "react-native";
import type { ComponentProps } from "react";
import * as Clipboard from "expo-clipboard";
import { api, type Creds, type LoomEvent } from "./api";
import { DraftSession, variables, fillVariables, type Draft } from "./chat-composer-model";
import { T } from "./theme";

export function useDaemonDraft(creds: Creds, project: string, chat: string) {
  const [text, change] = useState("");
  const [error, setError] = useState<string | null>(null);
  const current = useRef("");
  const key = `${creds.url}:${project}:${chat}`;
  const active = useRef(key);
  const session = useRef<DraftSession | null>(null);
  useEffect(() => {
    let live = true;
    active.current = key; current.current = ""; change(""); setError(null);
    const base = `/api/projects/${project}/chats/${encodeURIComponent(chat)}/draft`;
    session.current = new DraftSession(() => api<Draft>(creds, base), d => api<Draft>(creds, base, { method: "PUT", body: JSON.stringify(d) }),
      value => { if (live) { current.current = value; change(value); } }, e => { if (live) setError(`Draft sync: ${e instanceof Error ? e.message : String(e)}`); });
    return () => { live = false; };
  }, [creds, project, chat]);
  const setText = (value: string | ((previous: string) => string)) => {
    if (active.current !== key) return;
    const next = typeof value === "function" ? value(current.current) : value;
    current.current = next; change(next);
    void session.current?.save(next);
  };
  return { text, setText, error };
}

export interface ChatPresentation { expanded: Record<string, boolean>; costUsd: number; tokens: number; turns: number }
export interface ChatActions {
  pins: LoomEvent[];
  bookmarks: number[];
  quote: (id: number) => void;
  pin: (id: number) => void;
  bookmark: (id: number) => void;
  copyChat: () => void;
  expanded: Record<string, boolean>;
  expand: (id: number, open: boolean) => void;
}

export function MessagePressable(props: ComponentProps<typeof Pressable> & { text: string; actions: Array<{ text: string; onPress: () => void }> }) {
  const [open, setOpen] = useState(false);
  const { text, actions, children, ...rest } = props;
  return <>
    <Pressable {...rest} delayLongPress={350} onLongPress={() => setOpen(true)}>{children}</Pressable>
    <Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)}>
      <Pressable onPress={() => setOpen(false)} style={{ flex: 1, justifyContent: "flex-end", backgroundColor: "#0006" }}>
        <View style={{ backgroundColor: T.panel, borderTopLeftRadius: 16, borderTopRightRadius: 16, padding: 20, maxHeight: "80%" }}>
          <ScrollView>
            {[...actions, { text: "Copy as Markdown", onPress: () => void Clipboard.setStringAsync(text) }, { text: "Share…", onPress: () => void Share.share({ message: text }) }, { text: "Cancel", onPress: () => {} }].map((a, i) =>
              <TouchableOpacity key={i} accessibilityRole="button" onPress={() => { setOpen(false); a.onPress(); }} style={{ paddingVertical: 14 }}>
                <Text style={{ color: T.text, fontSize: 16 }}>{a.text}</Text>
              </TouchableOpacity>)}
          </ScrollView>
        </View>
      </Pressable>
    </Modal>
  </>;
}

export function copyChat(creds: Creds, project: string, chat: string) {
  void api<{ markdown: string }>(creds, `/api/projects/${project}/chats/${encodeURIComponent(chat)}/markdown`)
    .then(r => Clipboard.setStringAsync(r.markdown)).catch(e => Alert.alert("Couldn't copy chat", String(e)));
}

export function TemplateForm(props: { text: string | null; onClose: () => void; onUse: (text: string) => void }) {
  const [values, setValues] = useState<Record<string, string>>({});
  useEffect(() => setValues({}), [props.text]);
  const names = variables(props.text ?? "");
  return <Modal visible={props.text !== null} transparent animationType="fade" onRequestClose={props.onClose}>
    <View style={{ flex: 1, justifyContent: "center", padding: 24, backgroundColor: "#0006" }}>
      <View style={{ padding: 20, backgroundColor: T.panel, borderRadius: 12, maxHeight: "80%" }}>
        <Text style={{ color: T.text, fontSize: 18, marginBottom: 12 }}>Template variables</Text>
        <ScrollView>{names.map(name => <View key={name} style={{ marginBottom: 12 }}>
          <Text style={{ color: T.dim }}>{name}</Text>
          <TextInput accessibilityLabel={name} value={Object.hasOwn(values, name) ? values[name] : ""} onChangeText={value => setValues(v => ({ ...v, [name]: value }))} style={{ color: T.text, borderWidth: 1, borderColor: T.line, borderRadius: 8, padding: 12 }} />
        </View>)}</ScrollView>
        <TouchableOpacity accessibilityRole="button" disabled={names.some(n => !Object.hasOwn(values, n))} onPress={() => props.onUse(fillVariables(props.text ?? "", values))} style={{ paddingVertical: 12 }}><Text style={{ color: T.thread }}>Use template</Text></TouchableOpacity>
        <TouchableOpacity accessibilityRole="button" onPress={props.onClose} style={{ paddingVertical: 12 }}><Text style={{ color: T.dim }}>Cancel</Text></TouchableOpacity>
      </View>
    </View>
  </Modal>;
}
