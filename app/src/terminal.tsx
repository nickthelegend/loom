/**
 * Terminal on the phone (#380): a shell in the project — its own session ("phone"), so it doesn't
 * fight the desktop's tab — with the keys a phone keyboard lacks: Ctrl‑C, Tab, arrows, Esc.
 * Output arrives on the project's live stream (direct or through Loom Cloud), as on the desktop.
 */

import { useEffect, useRef, useState } from "react";
import { ScrollView, Text, TextInput, TouchableOpacity, View } from "react-native";
import { openLiveStream, openTerm, termInput, type Creds } from "./api";
import { applyTermChunk, TERM_KEYS } from "./term-model";
import { T, radii, spacing } from "./theme";

const TERM = "phone";

export function TerminalView(props: { creds: Creds; projectId: string }) {
  const [lines, setLines] = useState<string[]>([""]);
  const [cwd, setCwd] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [line, setLine] = useState("");
  const scroll = useRef<ScrollView>(null);

  useEffect(() => {
    let gone = false;
    const off = openLiveStream(props.creds, props.projectId, (frame) => {
      const f = frame as { type?: string; term?: string; chunk?: string; exit?: number; closed?: boolean };
      if (gone || f.type !== "term" || f.term !== TERM) return;
      if (f.chunk) setLines((l) => applyTermChunk(l, f.chunk!));
      if (f.exit !== undefined || f.closed) setLines((l) => applyTermChunk(l, "\n[the shell ended — pull down to start another]\n"));
    });
    openTerm(props.creds, props.projectId, TERM, 60, 30)
      .then((r) => { if (gone) return; setCwd(r.cwd); if (r.scrollback) setLines(applyTermChunk([], r.scrollback)); })
      .catch((e: Error) => !gone && setErr(e.message));
    return () => { gone = true; off(); };
  }, [props.projectId]);

  const send = (data: string) => void termInput(props.creds, props.projectId, TERM, data).catch((e: Error) => setErr(e.message));
  const submit = () => { send(line + "\r"); setLine(""); };

  return (
    <View style={{ flex: 1, backgroundColor: "#0b0b0b" }}>
      {cwd ? <Text style={{ color: "#8a8a8a", fontSize: 11, fontFamily: T.mono, paddingHorizontal: spacing.sm, paddingTop: 6 }} numberOfLines={1}>{cwd}</Text> : null}
      {err ? <Text style={{ color: T.err, fontSize: 12.5, padding: spacing.sm }}>{err}</Text> : null}
      <ScrollView ref={scroll} style={{ flex: 1 }} contentContainerStyle={{ padding: spacing.sm }}
        onContentSizeChange={() => scroll.current?.scrollToEnd({ animated: false })}>
        <ScrollView horizontal showsHorizontalScrollIndicator={false}>
          <Text selectable style={{ color: "#e6e6e6", fontFamily: T.mono, fontSize: 12, lineHeight: 16 }}>{lines.join("\n")}</Text>
        </ScrollView>
      </ScrollView>
      <ScrollView horizontal keyboardShouldPersistTaps="always" showsHorizontalScrollIndicator={false}
        contentContainerStyle={{ gap: 6, paddingHorizontal: spacing.sm, paddingVertical: 6 }} style={{ flexGrow: 0, borderTopWidth: 1, borderTopColor: "#222" }}>
        {Object.keys(TERM_KEYS).map((k) => (
          <TouchableOpacity key={k} onPress={() => send(TERM_KEYS[k]!)} accessibilityRole="button" accessibilityLabel={`send ${k}`}
            style={{ minWidth: 40, height: 34, paddingHorizontal: 10, borderRadius: radii.key - 4, backgroundColor: "#1c1c1c", borderWidth: 1, borderColor: "#2c2c2c", alignItems: "center", justifyContent: "center" }}>
            <Text style={{ color: "#d0d0d0", fontSize: 12.5, fontFamily: T.mono, fontWeight: "600" }}>{k}</Text>
          </TouchableOpacity>
        ))}
      </ScrollView>
      <View style={{ flexDirection: "row", gap: 6, padding: spacing.sm, paddingTop: 0 }}>
        <TextInput value={line} onChangeText={setLine} onSubmitEditing={submit} blurOnSubmit={false} returnKeyType="send"
          autoCapitalize="none" autoCorrect={false} spellCheck={false} placeholder="type a command…" placeholderTextColor="#666" accessibilityLabel="Terminal input"
          style={{ flex: 1, color: "#f0f0f0", backgroundColor: "#161616", borderRadius: radii.input, paddingHorizontal: 10, height: 40, fontFamily: T.mono, fontSize: 13.5 }} />
        <TouchableOpacity onPress={submit} accessibilityRole="button" accessibilityLabel="Run"
          style={{ height: 40, paddingHorizontal: 14, borderRadius: radii.input, backgroundColor: "#e5e5e5", justifyContent: "center" }}>
          <Text style={{ color: "#111", fontWeight: "700" }}>⏎</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}
