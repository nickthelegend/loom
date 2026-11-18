/** The same cross-project conversation search as the desktop palette. */
import { useEffect, useState } from "react";
import { ActivityIndicator, Text, TextInput, TouchableOpacity, View } from "react-native";
import { api, getProject, type Creds, type Project } from "./api";
import type { ChatSearchHit } from "./shell-model";
import { T, radii } from "./theme";

export function ShellSearch(props: { creds: Creds; onOpen: (p: Project, chat: { id: string; title: string }) => void }) {
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<ChatSearchHit[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [truncated, setTruncated] = useState(false);
  useEffect(() => {
    let gone = false;
    setHits([]); setError(""); setTruncated(false); setBusy(!!query.trim());
    const timer = setTimeout(() => {
      if (!query.trim()) return;
      void api<{ hits: ChatSearchHit[]; truncated: boolean }>(props.creds, `/api/search?q=${encodeURIComponent(query.trim())}`)
        .then(r => { if (!gone) { setHits(r.hits); setTruncated(r.truncated); } })
        .catch(e => { if (!gone) setError(String(e.message ?? e)); })
        .finally(() => { if (!gone) setBusy(false); });
    }, 180);
    return () => { gone = true; clearTimeout(timer); };
  }, [query, props.creds]);
  return <View style={{ gap: 8 }}>
    <TextInput value={query} onChangeText={setQuery} placeholder="Search chats across projects" placeholderTextColor={T.faint}
      accessibilityLabel="Search chats across projects" style={{ color: T.text, backgroundColor: T.panel, padding: 12, borderRadius: radii.input, borderWidth: 1, borderColor: T.line }} />
    {busy && <ActivityIndicator color={T.thread} />}
    {!!error && <Text accessibilityRole="alert" style={{ color: T.err }}>{error}</Text>}
    {!busy && query.trim() && !error && !hits.length ? <Text style={{ color: T.dim }}>No matching chats. Try another phrase.</Text> : null}
    {hits.map(h => <TouchableOpacity key={`${h.project}:${h.eventId}`} accessibilityRole="button" style={{ padding: 12, backgroundColor: T.panel, borderRadius: radii.row }}
      onPress={() => void getProject(props.creds, h.project).then(({ project }) => props.onOpen(project, { id: h.chat, title: h.chatTitle })).catch(e => setError(String(e.message ?? e)))}>
      <Text style={{ color: T.thread, fontSize: 12 }}>{h.projectName} · {h.chatTitle}</Text>
      <Text style={{ color: T.text, marginTop: 4 }} numberOfLines={3}>{h.snippet}</Text>
    </TouchableOpacity>)}
    {truncated && <Text style={{ color: T.dim }}>More matches available — narrow your search.</Text>}
  </View>;
}
