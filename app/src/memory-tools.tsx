import { useEffect, useState } from "react";
import { Text, TextInput, TouchableOpacity, View } from "react-native";
import { api, updateMemory, type Creds, type Memory } from "./api";
import { memoryPriority } from "./memory-model";
import { T, radii } from "./theme";

function Button({ label, onPress }: { label: string; onPress: () => void }) {
  return <TouchableOpacity accessibilityRole="button" onPress={onPress} style={{ padding: 9, borderWidth: 1, borderColor: T.line, borderRadius: radii.key }}><Text style={{ color: T.text }}>{label}</Text></TouchableOpacity>;
}
function Input({ value, onChange, placeholder }: { value: string; onChange: (value: string) => void; placeholder: string }) {
  return <TextInput accessibilityLabel={placeholder} value={value} onChangeText={onChange} placeholder={placeholder} placeholderTextColor={T.faint} autoCapitalize="none" multiline style={{ padding: 9, color: T.text, backgroundColor: T.raised, borderRadius: radii.key }} />;
}
interface History { eventId: number; by: string; ts: number; op: string; text?: string; patch?: object; after?: object }
interface Duplicate { a: Memory; b: Memory; similarity: number; suggestedText: string }
interface Injection { id: number; agentId: string; payload: { turn: number; memories: Array<{ id: string; text: string; score: number; reason: string; detail?: object }> } }

export function MemoryActions({ creds, projectId, memory, onChanged }: { creds: Creds; projectId: string; memory: Memory; onChanged: () => void }) {
  const [history, setHistory] = useState<History[] | null>(null);
  const [chat, setChat] = useState(memory.scope?.chat ?? "");
  const [priority, setPriority] = useState(String(memory.priority ?? 0));
  useEffect(() => { setChat(memory.scope?.chat ?? ""); setPriority(String(memory.priority ?? 0)); }, [memory.scope?.chat, memory.priority]);
  const [error, setError] = useState("");
  const base = `/api/projects/${encodeURIComponent(projectId)}/brain/${encodeURIComponent(memory.id)}`;
  const run = async (fn: () => Promise<unknown>) => { try { await fn(); setError(""); onChanged(); } catch (e) { setError(String(e)); } };
  return <View style={{ gap: 8 }}>
    <Text style={{ color: T.dim }}>{memory.stale ? "Unused for 30 days · " : ""}{memory.scope?.chat ? `Only chat ${memory.scope.chat}` : "Project-wide"}</Text>
    <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap" }}>
      <Button label={memory.pinned ? "Unpin" : "Pin"} onPress={() => void run(() => updateMemory(creds, projectId, memory.id, { pinned: !memory.pinned }))} />
      <Button label={memory.archived ? "Restore" : "Archive"} onPress={() => void run(() => updateMemory(creds, projectId, memory.id, { archived: !memory.archived }))} />
      <Button label="History" onPress={() => void run(async () => setHistory((await api<{ history: History[] }>(creds, base + "/history")).history))} />
    </View>
    <Input value={priority} onChange={setPriority} placeholder="Injection priority" />
    <Input value={chat} onChange={setChat} placeholder="Chat ID (blank means project-wide)" />
    <Button label="Save priority and scope" onPress={() => void run(() => updateMemory(creds, projectId, memory.id, { priority: memoryPriority(priority), scope: { ...memory.scope, chat: chat.trim() || undefined } }))} />
    {history?.map(h => <View key={h.eventId} style={{ gap: 6 }}>
      <Text style={{ color: T.dim }}>{h.by} · {new Date(h.ts).toLocaleString()} · {h.op}</Text>
      <Text style={{ color: T.text }}>{JSON.stringify(h.patch ?? { text: h.text }, null, 2)}</Text>
      {h.after ? <Button label="Revert to this revision" onPress={() => void run(async () => { await api(creds, base + "/revert", { method: "POST", body: JSON.stringify({ eventId: h.eventId }) }); setHistory(null); })} /> : null}
    </View>)}
    {error ? <Text style={{ color: T.err }}>{error}</Text> : null}
  </View>;
}

export function MemoryTools({ creds, projectId, onChanged }: { creds: Creds; projectId: string; onChanged: () => void }) {
  const [source, setSource] = useState("");
  const [file, setFile] = useState("docs/BRAIN.md");
  const [duplicates, setDuplicates] = useState<Duplicate[]>([]);
  const [selected, setSelected] = useState<Duplicate | null>(null);
  const [merged, setMerged] = useState("");
  const [injections, setInjections] = useState<Injection[] | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const base = `/api/projects/${encodeURIComponent(projectId)}/brain`;
  const run = async (fn: () => Promise<unknown>) => { try { await fn(); setError(""); } catch (e) { setError(String(e)); } };
  const post = (route: string, body: object) => api(creds, base + route, { method: "POST", body: JSON.stringify(body) });
  return <View style={{ gap: 8 }}>
    <Input value={source} onChange={setSource} placeholder="Paste Markdown or a public Markdown URL" />
    <Button label="Import memories" onPress={() => void run(async () => { const result = await post("/import", /^https?:\/\//i.test(source.trim()) ? { url: source.trim() } : { markdown: source }); setNotice(JSON.stringify(result)); setSource(""); onChanged(); })} />
    <Input value={file} onChange={setFile} placeholder="New Markdown file in repo" />
    <Button label="Export Markdown to repo" onPress={() => void run(async () => { await post("/export", { md: file }); setNotice(`Exported to ${file}`); })} />
    <Button label="Review possible duplicates" onPress={() => void run(async () => { const result = await api<{ duplicates: Duplicate[] }>(creds, base + "/duplicates"); setDuplicates(result.duplicates); setNotice(result.duplicates.length ? "Review wording before merging." : "No possible duplicates."); })} />
    {duplicates.map(d => <View key={d.a.id + d.b.id} style={{ gap: 6 }}>
      <Text style={{ color: T.text }}>{d.a.text}{"\n"}{d.b.text}</Text>
      <Button label={`Review merge (${Math.round(d.similarity * 100)}% similar)`} onPress={() => { setSelected(d); setMerged(d.suggestedText); }} />
    </View>)}
    {selected ? <View style={{ gap: 6 }}><Input value={merged} onChange={setMerged} placeholder="Merged wording" /><Button label="Merge and archive other memory" onPress={() => void run(async () => { await post("/merge", { keep: selected.a.id, other: selected.b.id, text: merged }); setSelected(null); setDuplicates([]); onChanged(); })} /></View> : null}
    <Button label="Why was this injected?" onPress={() => void run(async () => setInjections((await api<{ injections: Injection[] }>(creds, base + "/injections")).injections))} />
    {injections?.slice().reverse().map(i => <View key={i.id} style={{ gap: 6 }}><Text style={{ color: T.dim }}>Turn {i.payload.turn} · {i.agentId}</Text>{i.payload.memories.length ? i.payload.memories.map(m => <Text key={m.id} style={{ color: T.text }}>{m.text} · score {m.score.toFixed(3)} · {m.reason}{"\n"}{JSON.stringify(m.detail ?? {})}</Text>) : <Text style={{ color: T.dim }}>No memories injected.</Text>}</View>)}
    {injections?.length === 0 ? <Text style={{ color: T.dim }}>No recorded turns. Native continuity uses its packet inspector.</Text> : null}
    {notice ? <Text style={{ color: T.dim }}>{notice}</Text> : null}
    {error ? <Text style={{ color: T.err }}>{error}</Text> : null}
  </View>;
}
