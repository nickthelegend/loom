import { useEffect, useState } from "react";
import { Platform, ScrollView, Share, Text, TouchableOpacity, View } from "react-native";
import * as FileSystem from "expo-file-system";
import { api, validateProjectConfig, type Creds } from "./api";
import { Btn, Empty, Segmented } from "./components";
import { Sheet } from "./observatory";
import { configValidationText, standingDetail, type ModelStanding } from "./cli-tools-model";
import { T, spacing } from "./theme";

export function ProjectTools(props: { creds: Creds; projectId: string; chat: string }) {
  const [visible, setVisible] = useState(false);
  const [window, setWindow] = useState<"7d" | "30d" | "all">("30d");
  const [rows, setRows] = useState<ModelStanding[] | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!visible) return;
    let alive = true;
    const load = () => api<{ byKindModel: ModelStanding[] }>(props.creds, `/api/scoreboard?project=${encodeURIComponent(props.projectId)}&window=${window}`)
      .then(r => { if (alive) setRows(r.byKindModel); }).catch(e => { if (alive) setMessage(e.message); });
    setRows(null); void load();
    const timer = setInterval(() => void load(), 5000);
    return () => { alive = false; clearInterval(timer); };
  }, [visible, window, props.projectId, props.creds]);
  const run = async (work: () => Promise<void>) => {
    if (busy) return;
    setBusy(true); setMessage("");
    try { await work(); } catch (e) { setMessage(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };
  const exportHtml = async () => {
    const result = await api<{ filename: string; content: string }>(props.creds, `/api/projects/${encodeURIComponent(props.projectId)}/chats/${encodeURIComponent(props.chat)}/replay?format=json`);
    if (Platform.OS === "web") {
      const url = URL.createObjectURL(new Blob([result.content], { type: "text/html" }));
      const link = document.createElement("a"); link.href = url; link.download = result.filename; link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } else if (Platform.OS === "android") {
      const permission = await FileSystem.StorageAccessFramework.requestDirectoryPermissionsAsync();
      if (!permission.granted) return;
      const file = await FileSystem.StorageAccessFramework.createFileAsync(permission.directoryUri, result.filename, "text/html");
      await FileSystem.writeAsStringAsync(file, result.content);
      setMessage("HTML exported.");
    } else {
      const file = `${FileSystem.cacheDirectory}${result.filename}`;
      await FileSystem.writeAsStringAsync(file, result.content);
      await Share.share({ url: file });
    }
  };
  return <>
    <Btn small label="Tools" onPress={() => setVisible(true)} />
    <Sheet title="Project tools" visible={visible} onClose={() => setVisible(false)}>
      <ScrollView contentContainerStyle={{ padding: spacing.md, gap: spacing.md }}>
        {[
          { label: "Validate config", work: async () => setMessage(configValidationText(await validateProjectConfig(props.creds, props.projectId))) },
          { label: "Export chat as HTML", work: exportHtml },
        ].map(action => <TouchableOpacity key={action.label} accessibilityRole="button" accessibilityState={{ disabled: busy }} disabled={busy}
          onPress={() => void run(action.work)} style={{ padding: 12, minHeight: 44, borderWidth: 1, borderColor: T.line, borderRadius: 8, backgroundColor: T.raised, opacity: busy ? 0.5 : 1 }}>
          <Text style={{ color: T.text, textAlign: "center" }}>{action.label}</Text>
        </TouchableOpacity>)}
        {busy ? <Text style={{ color: T.dim }}>Working…</Text> : null}
        {message ? <Text accessibilityRole="alert" style={{ color: T.text }}>{message}</Text> : null}
        <Text style={{ color: T.text, fontWeight: "700" }}>Model scoreboard</Text>
        <Segmented value={window} onChange={setWindow} options={[{ key: "7d", label: "7 days" }, { key: "30d", label: "30 days" }, { key: "all", label: "All time" }]} />
        {rows === null ? <Empty text="Loading scoreboard…" /> : !rows.length ? <Empty text="Nothing recorded in this window yet." /> : rows.map((row, i) => <View key={row.key} style={{ borderBottomWidth: 1, borderColor: T.line, paddingBottom: 12, gap: 6 }}>
          <Text style={{ color: T.text, fontWeight: "600" }}>{i + 1}. {row.key}</Text>
          <Text style={{ color: T.dim }}>{standingDetail(row)}</Text>
        </View>)}
      </ScrollView>
    </Sheet>
  </>;
}
