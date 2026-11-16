/**
 * My issues on the phone (#382): what's assigned to you on GitHub or Linear; tick and Start — a chat
 * each (or an Orchestra goal), linked back to the issue when its PR opens. Started ones open their chat.
 */

import { useEffect, useState } from "react";
import { ActivityIndicator, ScrollView, Text, TouchableOpacity, View } from "react-native";
import { getIntake, startIntake, type Creds, type IntakeIssue } from "./api";
import { TAP } from "./components";
import { Sheet } from "./observatory";
import { T, radii, spacing } from "./theme";

export function IntakeSheet(props: { visible: boolean; creds: Creds; projectId: string; onClose: () => void; onOpenChat: (chat: string, title: string) => void }) {
  const [source, setSource] = useState<"github" | "linear">("github");
  const [mode, setMode] = useState<"chat" | "orchestra">("chat");
  const [issues, setIssues] = useState<IntakeIssue[] | null>(null);
  const [picked, setPicked] = useState<Record<string, boolean>>({});
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = () => {
    setIssues(null); setErr(null); setPicked({});
    getIntake(props.creds, props.projectId, source).then((r) => setIssues(r.issues)).catch((e: Error) => setErr(e.message));
  };
  useEffect(() => { if (props.visible) load(); }, [props.visible, source]);

  const ids = Object.keys(picked).filter((k) => picked[k]);
  const start = async () => {
    if (!ids.length) return;
    setBusy(true);
    try { await startIntake(props.creds, props.projectId, { source, ids, mode }); load(); }
    catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };
  const pill = (label: string, on: boolean, onPress: () => void) => (
    <TouchableOpacity key={label} onPress={onPress} accessibilityRole="radio" accessibilityState={{ selected: on }}
      style={{ paddingVertical: 6, paddingHorizontal: 12, borderRadius: 999, borderWidth: 1, borderColor: on ? T.line2 : T.line, backgroundColor: on ? T.raised : "transparent" }}>
      <Text style={{ color: on ? T.text : T.dim, fontSize: 12.5, fontWeight: "600" }}>{label}</Text>
    </TouchableOpacity>
  );

  return (
    <Sheet title="My issues" visible={props.visible} onClose={props.onClose}>
      <View style={{ flexDirection: "row", gap: 6, paddingHorizontal: spacing.md, paddingBottom: 8 }}>
        {pill("GitHub", source === "github", () => setSource("github"))}
        {pill("Linear", source === "linear", () => setSource("linear"))}
      </View>
      <ScrollView style={{ maxHeight: 380 }} contentContainerStyle={{ paddingHorizontal: spacing.md, gap: 6 }}>
        {err ? <Text style={{ color: T.err, fontSize: 13 }}>{err}</Text> : issues === null ? <ActivityIndicator color={T.dim} /> :
          !issues.length ? <Text style={{ color: T.dim, fontSize: 13 }}>Nothing open is assigned to you.</Text> :
          issues.map((it) => {
            const started = it.started?.chat;
            const on = !!picked[it.id];
            return (
              <TouchableOpacity key={it.id} activeOpacity={0.7}
                onPress={() => started ? props.onOpenChat(started, it.title) : setPicked((p) => ({ ...p, [it.id]: !p[it.id] }))}
                accessibilityRole={started ? "button" : "checkbox"} accessibilityState={started ? undefined : { checked: on }}
                style={{ flexDirection: "row", alignItems: "center", gap: 10, minHeight: TAP, paddingHorizontal: 10, borderRadius: radii.key, borderWidth: 1,
                  borderColor: on ? T.line2 : T.line, backgroundColor: on ? T.raised : "transparent", opacity: started ? 0.75 : 1 }}>
                <Text style={{ width: 18, color: started ? T.ok : on ? T.text : T.faint, fontSize: 15, fontWeight: "800" }}>{started ? "✓" : on ? "■" : "□"}</Text>
                <Text style={{ color: T.faint, fontSize: 11.5, fontFamily: T.mono }}>{it.identifier ?? (it.number ? `#${it.number}` : "")}</Text>
                <Text style={{ color: T.text, fontSize: 14, flex: 1 }} numberOfLines={2}>{it.title}</Text>
                {started ? <Text style={{ color: T.dim, fontSize: 12 }}>open ›</Text> : null}
              </TouchableOpacity>
            );
          })}
      </ScrollView>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 6, padding: spacing.md }}>
        {pill("a chat each", mode === "chat", () => setMode("chat"))}
        {pill("Orchestra", mode === "orchestra", () => setMode("orchestra"))}
        <TouchableOpacity onPress={() => void start()} disabled={!ids.length || busy} accessibilityRole="button"
          style={{ marginLeft: "auto", minHeight: 40, paddingHorizontal: 16, borderRadius: radii.key, backgroundColor: ids.length ? T.bright : T.raised, justifyContent: "center", opacity: busy ? 0.6 : 1 }}>
          {busy ? <ActivityIndicator color={T.onBright} /> : <Text style={{ color: ids.length ? T.onBright : T.dim, fontWeight: "700" }}>{ids.length ? `Start ${ids.length}` : "Start"}</Text>}
        </TouchableOpacity>
      </View>
    </Sheet>
  );
}
