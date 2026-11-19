import { useEffect, useState } from "react";
import { Text, TextInput, TouchableOpacity, View, ScrollView } from "react-native";
import { api, type Creds, type Project, type LoomEvent } from "./api";
import { Sheet } from "./observatory";
import { T } from "./theme";
import { environmentEntry, filterSessionChats, policyInput, retryNotice, sessionState, type SessionChat } from "./r4-agents-model";

type Policy = { maxTurnMinutes?: number; idleSleepMinutes?: number; retries?: { count: number; waitSeconds: number } };
type Settings = Policy & { autoArchiveDays?: number; agents: Record<string, Policy> };
type Profile = { name: string; kind: string; model?: string };
const button = (title: string, press: () => void, selected = false) => <TouchableOpacity accessibilityRole="button" onPress={press} style={{ padding: 10, borderRadius: 8, backgroundColor: selected ? T.raised : T.panel, borderWidth: 1, borderColor: T.line }}><Text style={{ color: T.text }}>{title}</Text></TouchableOpacity>;
const field = (title: string, value: string, change: (s: string) => void, secret = false) => <View style={{ gap: 4 }}><Text style={{ color: T.dim }}>{title}</Text><TextInput accessibilityLabel={title} value={value} onChangeText={change} secureTextEntry={secret} autoCapitalize="none" autoCorrect={false} style={{ color: T.text, backgroundColor: T.raised, padding: 10, borderRadius: 8 }} /></View>;

export function R4AgentSessions(props: { creds: Creds; project: Project; chat: string; unread?: number | null; events: LoomEvent[]; onChat: (id: string) => void; onChanged: () => void }) {
  const [open, setOpen] = useState(false), [tab, setTab] = useState("chats"), [error, setError] = useState("");
  const [chats, setChats] = useState<SessionChat[]>([]), [archived, setArchived] = useState(false), [label, setLabel] = useState(""), [query, setQuery] = useState("");
  const [messageMatches, setMessageMatches] = useState<string[]>([]);
  const [editing, setEditing] = useState<string | null>(null), [labels, setLabels] = useState("");
  const [settings, setSettings] = useState<Settings>({ agents: {} }), [agent, setAgent] = useState("");
  const [turn, setTurn] = useState("0"), [sleep, setSleep] = useState("0"), [count, setCount] = useState("0"), [wait, setWait] = useState("5"), [days, setDays] = useState("0");
  const [names, setNames] = useState<string[]>([]), [entry, setEntry] = useState("");
  const [profiles, setProfiles] = useState<Profile[]>([]), [profile, setProfile] = useState(""), [kind, setKind] = useState(""), [model, setModel] = useState("");
  const [summary, setSummary] = useState<string | null>(null), [helper, setHelper] = useState("");
  const [busy, setBusy] = useState(false);
  const base = `/api/projects/${encodeURIComponent(props.project.id)}`;
  const request = <T,>(path: string, method = "GET", body?: unknown) => api<T>(props.creds, path, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const load = async () => {
    const [c, s] = await Promise.all([request<{ chats: SessionChat[] }>(base + "/chats?all=1"), request<Settings>(base + "/session-settings")]);
    setChats(c.chats); setSettings(s); setDays(String(s.autoArchiveDays ?? 0));
  };
  const act = async (fn: () => Promise<unknown>) => { if (busy) return; setBusy(true); setError(""); try { await fn(); props.onChanged(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); } };
  useEffect(() => { if (open) { void act(load); void request<{ profiles: Profile[] }>("/api/profiles").then(r => setProfiles(r.profiles)).catch(() => {}); } }, [open, props.project.id]);
  useEffect(() => {
    let gone = false; setMessageMatches([]);
    if (!open || !query.trim()) return;
    const timer = setTimeout(() => {
      void request<{ hits: Array<{ chat: string }> }>(base + `/chats/search?q=${encodeURIComponent(query)}&archived=${archived ? "1" : "0"}&label=${encodeURIComponent(label)}`)
        .then(r => { if (!gone) setMessageMatches(r.hits.map(h => h.chat)); }).catch(e => { if (!gone) setError(e.message); });
    }, 200);
    return () => { gone = true; clearTimeout(timer); };
  }, [open, query, archived, label, props.project.id]);
  useEffect(() => {
    const p = { ...settings, ...(settings.agents[agent] ?? {}) };
    setTurn(String(p.maxTurnMinutes ?? 0)); setSleep(String(p.idleSleepMinutes ?? 0)); setCount(String(p.retries?.count ?? 0)); setWait(String(p.retries?.waitSeconds ?? 5));
    setNames([]); setEntry("");
    if (open && agent) void request<{ names: string[] }>(base + `/agents/${encodeURIComponent(agent)}/env`).then(r => setNames(r.names)).catch(e => setError(e.message));
  }, [agent, settings, open]);
  const catchup = () => act(async () => {
    const r = await request<{ summary: string }>(base + `/chats/${encodeURIComponent(props.chat)}/catchup`, "POST", { since: props.unread ? props.unread - 1 : 0, markRead: false, ...(helper.trim() ? { model: helper.trim() } : {}) });
    setSummary(r.summary);
  });
  const lastNeed = [...props.events].reverse().find(e => e.kind === "needs_input" && e.payload.reason === "turn_time_limit");
  const needsContinue = lastNeed && !props.events.some(e => e.id > lastNeed.id && e.kind === "message" && !e.agentId);
  const labelNames = [...new Set(chats.flatMap(c => c.labels?.map(l => l.name) ?? []))];
  const retry = retryNotice(props.events);
  return <View>
    <ScrollView horizontal contentContainerStyle={{ gap: 8, paddingHorizontal: 12, paddingVertical: 6 }}>
      {button("Chats & agents", () => setOpen(true))}
      {props.unread ? button("Unread · Catch me up", () => void catchup()) : null}
      {needsContinue ? button("Needs you · Continue", () => void act(() => request(base + "/messages", "POST", { chat: props.chat, agentId: lastNeed.agentId, text: "Continue from where you stopped." }))) : null}
    </ScrollView>
    {retry ? <Text accessibilityLiveRegion="polite" style={{ color: T.dim, paddingHorizontal: 12 }}>{retry}</Text> : null}
    {error ? <Text accessibilityRole="alert" style={{ color: T.err, padding: 8 }}>{error}</Text> : null}
    <Sheet visible={open} onClose={() => setOpen(false)} title="Agents and sessions">
      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ padding: 16, gap: 12 }}>
        <View style={{ flexDirection: "row", gap: 8 }}>{["chats", "settings", "add agent"].map(t => <View key={t}>{button(t, () => setTab(t), tab === t)}</View>)}</View>
        {busy ? <Text style={{ color: T.dim }}>Saving…</Text> : null}
        {tab === "chats" ? <>
          {button(archived ? "Archived" : "Active chats", () => setArchived(!archived))}
          {field("Search chats", query, setQuery)}
          <ScrollView horizontal contentContainerStyle={{ gap: 8 }}>{["", ...labelNames].map(l => <View key={l}>{button(l || "All labels", () => setLabel(l), label === l)}</View>)}</ScrollView>
          {filterSessionChats(chats, archived, label, query, messageMatches).map(c => <View key={c.id} style={{ padding: 10, gap: 8, borderWidth: 1, borderColor: T.line, borderRadius: 8 }}>
            {button(c.title, () => { props.onChat(c.id); setOpen(false); })}
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>{c.labels?.map(l => <Text key={l.name} style={{ color: /^#[\da-f]{6}$/i.test(l.color) ? l.color : T.dim, borderWidth: 1, borderColor: T.line, borderRadius: 8, padding: 4 }}>{l.name}</Text>)}</View>
            {button("Labels", () => { setEditing(c.id); setLabels(c.labels?.map(l => l.name).join(", ") ?? ""); })}
            {c.id !== "main" ? button(c.archived ? "Restore" : "Archive", () => void act(async () => { await request(base + `/chats/${encodeURIComponent(c.id)}`, "PATCH", { archived: !c.archived }); await load(); })) : null}
            {editing === c.id ? <>{field("Labels (comma separated)", labels, setLabels)}{button("Save labels", () => void act(async () => { await request(base + `/chats/${encodeURIComponent(c.id)}/labels`, "PUT", { labels: labels.split(",").map(s => s.trim()).filter(Boolean) }); setEditing(null); await load(); }))}</> : null}
          </View>)}
        </> : tab === "settings" ? <>
          <ScrollView horizontal contentContainerStyle={{ gap: 8 }}>{["", ...props.project.agents.map(a => a.id)].map(id => <View key={id}>{button(id || "Project defaults", () => setAgent(id), agent === id)}</View>)}</ScrollView>
          {agent ? <Text style={{ color: T.thread }}>{sessionState(props.project.agents.find(a => a.id === agent) ?? {})}</Text> : null}
          {field("Turn limit in minutes (0 disables)", turn, setTurn)}{field("Idle sleep in minutes (0 disables)", sleep, setSleep)}{field("Retry count", count, setCount)}{field("Retry wait in seconds", wait, setWait)}
          {!agent ? field("Auto-archive idle days (0 disables)", days, setDays) : null}
          {button("Save settings", () => void act(async () => { await request(base + (agent ? `/agents/${encodeURIComponent(agent)}/limits` : "/session-settings"), "PUT", { ...policyInput(turn, sleep, count, wait), ...(!agent ? { autoArchiveDays: Number(days) } : {}) }); await load(); }))}
          {agent ? <>
            {button("Duplicate agent", () => void act(() => request(base + `/agents/${encodeURIComponent(agent)}/clone`, "POST", {})))}
            <Text style={{ color: T.dim }}>Environment · only names are returned</Text>
            {names.map(key => <View key={key}>{button(`Unset ${key}`, () => void act(async () => { const r = await request<{ names: string[] }>(base + `/agents/${encodeURIComponent(agent)}/env`, "DELETE", { key }); setNames(r.names); }))}</View>)}
            {field("KEY=VALUE", entry, setEntry, true)}
            {button("Set environment variable", () => void act(async () => { const value = environmentEntry(entry); setEntry(""); const r = await request<{ names: string[] }>(base + `/agents/${encodeURIComponent(agent)}/env`, "PUT", value); setNames(r.names); }))}
          </> : null}
        </> : <>
          <Text style={{ color: T.dim }}>Profile</Text>
          <ScrollView horizontal contentContainerStyle={{ gap: 8 }}><View>{button("Custom", () => setProfile(""), !profile)}</View>{profiles.map(p => <View key={p.name}>{button(p.name, () => { setProfile(p.name); setKind(p.kind); setModel(p.model ?? ""); }, profile === p.name)}</View>)}</ScrollView>
          {field("Agent kind", kind, setKind)}{field("Model (empty uses default)", model, setModel)}
          {button("Add agent", () => void act(async () => { await request(base + "/agents", "POST", { kind, ...(profile ? { profile } : {}), ...(model ? { model } : {}) }); setTab("settings"); }))}
        </>}
      </ScrollView>
    </Sheet>
    <Sheet visible={summary !== null} onClose={() => setSummary(null)} title="Catch me up">
      <ScrollView contentContainerStyle={{ padding: 16, gap: 12 }}><Text selectable style={{ color: T.text }}>{summary}</Text>{field("Optional helper provider/model", helper, setHelper)}<Text style={{ color: T.dim }}>Using a helper sends this unread activity to that model and may incur charges.</Text>{button("Summarize with helper", () => void catchup())}</ScrollView>
    </Sheet>
  </View>;
}
