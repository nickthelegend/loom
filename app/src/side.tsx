/**
 * Side chat on the phone (#376): `/btw <question>` asks the agent something about the work without
 * touching the thread or a turn that's running. Same agent and model, read-only, private; nothing
 * here enters the project's log or memory. "Bring back" quotes an answer into the composer.
 */

import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, ScrollView, Text, TextInput, TouchableOpacity, View } from "react-native";
import { askSide, closeSide, getSide, type Creds, type SideMessage } from "./api";
import { Markdown } from "./markdown";
import { Sheet } from "./observatory";
import { T, radii, spacing } from "./theme";

export function SideSheet(props: {
  creds: Creds;
  projectId: string;
  chat: string;
  /** The first question, from `/btw …`; "" opens it empty. */
  question: string | null;
  who?: string;
  onClose: () => void;
  onBringBack: (quote: string) => void;
}) {
  const [sideId, setSideId] = useState<string | null>(null);
  const [messages, setMessages] = useState<SideMessage[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [text, setText] = useState("");
  const live = useRef(true);
  const scroll = useRef<ScrollView>(null);
  const visible = props.question !== null;

  const ask = async (q: string, id: string | null) => {
    setErr(null);
    setBusy(true);
    setMessages((m) => [...m, { role: "user", text: q, at: Date.now() }]);
    try {
      // a side chat that failed can't take more; carry on in a fresh one
      if (id && err) { void closeSide(props.creds, props.projectId, props.chat, id).catch(() => {}); id = null; }
      const r = await askSide(props.creds, props.projectId, props.chat, q, id ?? undefined);
      setSideId(r.sideId);
      for (;;) {
        await new Promise((res) => setTimeout(res, 1200));
        if (!live.current) return;
        const s = await getSide(props.creds, props.projectId, props.chat, r.sideId);
        setMessages(s.messages);
        if (!s.busy) { if (s.error) setErr(s.error); break; }
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      if (live.current) setBusy(false);
    }
  };

  useEffect(() => {
    if (!visible) return;
    live.current = true;
    setSideId(null); setMessages([]); setErr(null); setText("");
    if (props.question?.trim()) void ask(props.question.trim(), null);
    return () => { live.current = false; };
  }, [visible]);

  const close = () => {
    live.current = false;
    if (sideId) void closeSide(props.creds, props.projectId, props.chat, sideId).catch(() => {});
    props.onClose();
  };
  const send = () => {
    const q = text.trim();
    if (!q || busy) return;
    setText("");
    void ask(q, sideId);
  };

  return (
    <Sheet title={`Side chat${props.who ? ` · ${props.who}` : ""}`} visible={visible} onClose={close}>
      <Text style={{ color: T.faint, fontSize: 12, paddingHorizontal: spacing.md, paddingBottom: 6 }}>
        Read-only and private — none of this goes into the thread.
      </Text>
      <ScrollView ref={scroll} style={{ maxHeight: 420 }} contentContainerStyle={{ padding: spacing.md, gap: 10 }}
        onContentSizeChange={() => scroll.current?.scrollToEnd({ animated: true })}>
        {messages.map((m, i) => m.role === "user" ? (
          <View key={i} style={{ alignSelf: "flex-end", maxWidth: "88%", backgroundColor: T.raised, borderRadius: 14, paddingVertical: 8, paddingHorizontal: 12 }}>
            <Text style={{ color: T.text, fontSize: 14 }}>{m.text}</Text>
          </View>
        ) : (
          <View key={i} style={{ gap: 4 }}>
            <Markdown text={m.text} />
            <TouchableOpacity onPress={() => props.onBringBack(m.text.trim().split("\n").map((l) => `> ${l}`).join("\n") + "\n\n")}
              accessibilityRole="button" accessibilityLabel="Bring this answer back into your message" style={{ alignSelf: "flex-start", paddingVertical: 4 }}>
              <Text style={{ color: T.dim, fontSize: 12.5, fontWeight: "600" }}>↩ Bring back</Text>
            </TouchableOpacity>
          </View>
        ))}
        {busy && <ActivityIndicator color={T.dim} style={{ alignSelf: "flex-start" }} />}
        {err && <Text style={{ color: T.err, fontSize: 13 }}>{err}</Text>}
      </ScrollView>
      <View style={{ flexDirection: "row", alignItems: "flex-end", gap: 8, padding: spacing.md, paddingTop: 4 }}>
        <TextInput value={text} onChangeText={setText} placeholder="Ask on the side…" placeholderTextColor={T.faint} multiline
          accessibilityLabel="Side question" onSubmitEditing={send}
          style={{ flex: 1, color: T.text, backgroundColor: T.raised, borderRadius: radii.input, paddingHorizontal: 12, paddingVertical: 9, fontSize: 15, maxHeight: 110 }} />
        <TouchableOpacity onPress={send} disabled={busy || !text.trim()} accessibilityRole="button" accessibilityLabel="Ask"
          style={{ width: 38, height: 38, borderRadius: 19, backgroundColor: text.trim() && !busy ? T.bright : T.raised, alignItems: "center", justifyContent: "center" }}>
          <Text style={{ color: text.trim() && !busy ? T.onBright : T.dim, fontSize: 16, fontWeight: "700" }}>↑</Text>
        </TouchableOpacity>
      </View>
    </Sheet>
  );
}
