import { cachedChatHits } from "./phone-batch-model";
import { useEffect, useState } from "react";
import { Text, TextInput, TouchableOpacity, View, ScrollView } from "react-native";
import { api, type Creds, type LoomEvent } from "./api";
import { T } from "./theme";
interface Hit { eventId: number; snippet: string }
export function ChatSearch(props: { creds: Creds; project: string; chat: string; events: LoomEvent[]; onJump: (id: number) => void }) {
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<Hit[]>([]);
  const [note, setNote] = useState("");
  useEffect(() => {
    let live = true;
    setHits([]); setNote(query.trim() ? "Searching…" : "");
    const timer = setTimeout(() => {
      if (!query.trim()) return;
      void api<{ hits: Hit[]; truncated: boolean }>(props.creds, `/api/projects/${props.project}/chats/search?chat=${encodeURIComponent(props.chat)}&q=${encodeURIComponent(query)}`)
        .then(r => { if (live) { setHits(r.hits); setNote(r.truncated ? "First 100 matches · narrow your search" : `${r.hits.length} matches`); } })
        .catch(() => {
          if (!live) return;
          setHits(cachedChatHits(props.events, props.chat, query));
          setNote("Offline · searching loaded messages only");
        });
    }, 250);
    return () => { live = false; clearTimeout(timer); };
  }, [props.creds, props.project, props.chat, query]);
  return <View style={{ padding: 10, gap: 8 }}>
    <TextInput accessibilityLabel="Search this chat" placeholder="Find a message" placeholderTextColor={T.dim} value={query} onChangeText={setQuery} style={{ color: T.text, padding: 10, borderWidth: 1, borderColor: T.line }} />
    <Text style={{ color: T.dim }}>{note}</Text>
    <ScrollView style={{ maxHeight: 220 }}>{hits.map(hit => <TouchableOpacity key={hit.eventId} onPress={() => props.onJump(hit.eventId)} accessibilityRole="button" style={{ paddingVertical: 10 }}><Text style={{ color: T.text }}>{hit.snippet}</Text></TouchableOpacity>)}</ScrollView>
  </View>;
}
