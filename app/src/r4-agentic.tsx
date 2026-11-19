import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, ScrollView, Switch, Text, TextInput, TouchableOpacity, View } from "react-native";
import { api, type Creds } from "./api";
import { Panel, SectionLabel, field } from "./components";
import { T, spacing } from "./theme";

export interface ToolSetting { name: string; description: string; enabled: boolean }
export function disabledAfterToggle(tools: ToolSetting[], name: string, enabled: boolean) {
  return tools.filter(t => t.name === name ? !enabled : !t.enabled).map(t => t.name);
}
export function validSkillName(name: string) { return name.length <= 64 && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name); }
interface ToolCall { id: number; at: number; tool: string; actor: string; ok: boolean; durationMs: number; error?: string }
interface HookState { enabled: boolean; canEnable: boolean; hooks: Array<{ event: string; executable: boolean }> }

export function AgenticToolsPanel({ creds, projectId }: { creds: Creds; projectId: string }) {
  const [tools, setTools] = useState<ToolSetting[] | null>(null);
  const [loomTools, setLoomTools] = useState(false);
  const [calls, setCalls] = useState<ToolCall[]>([]);
  const [hooks, setHooks] = useState<HookState | null>(null);
  const [chats, setChats] = useState<Array<{ id: string; title: string }>>([]);
  const [chat, setChat] = useState("main"), [name, setName] = useState("");
  const [message, setMessage] = useState(""), [busy, setBusy] = useState(false);
  const base = `/api/projects/${encodeURIComponent(projectId)}`;
  const load = useCallback(async () => {
    const [settings, log, hookState, threads] = await Promise.all([
      api<{ tools: ToolSetting[]; loomTools: boolean }>(creds, base + "/r4/tools"), api<{ calls: ToolCall[] }>(creds, base + "/r4/log"),
      api<HookState>(creds, base + "/r4/hooks"), api<{ chats: Array<{ id: string; title: string }> }>(creds, base + "/chats"),
    ]);
    setTools(settings.tools); setLoomTools(settings.loomTools); setCalls(log.calls); setHooks(hookState); setChats(threads.chats);
  }, [creds, base]);
  useEffect(() => { void load().catch(e => setMessage(String(e.message))); }, [load]);
  async function act(work: () => Promise<unknown>) {
    if (busy) return;
    setBusy(true); setMessage("");
    try { await work(); await load(); } catch (e) { setMessage(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }
  const put = (route: string, body: unknown) => api(creds, base + route, { method: "PUT", body: JSON.stringify(body) });
  return <ScrollView contentContainerStyle={{ padding: spacing.md, gap: spacing.md }}>
    {!!message && <Text accessibilityRole="alert" style={{ color: T.text }}>{message}</Text>}
    <TouchableOpacity accessibilityRole="button" style={{ minHeight: 44, justifyContent: "center" }} disabled={busy} onPress={() => void act(load)}><Text style={{ color: T.text }}>Refresh</Text></TouchableOpacity>
    <SectionLabel text="Loom tools for agents" />
    <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
      <Text style={{ color: T.text }}>Enable for agent turns</Text>
      <Switch accessibilityLabel="Enable Loom tools for agent turns" disabled={busy} value={loomTools} onValueChange={enabled => void act(() => api(creds, base + "/config", { method: "PATCH", body: JSON.stringify({ loomTools: enabled }) }))} />
    </View>
    <Text style={{ color: T.dim }}>Choose which tools agents receive in this project.</Text>
    {!tools ? <ActivityIndicator /> : tools.map(tool => <Panel key={tool.name}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm }}>
        <View style={{ flex: 1 }}><Text style={{ color: T.text }}>{tool.name}</Text><Text style={{ color: T.dim }}>{tool.description}</Text></View>
        <Switch accessibilityLabel={tool.name} disabled={busy} value={tool.enabled} onValueChange={enabled => void act(() => put("/r4/tools", { disabledTools: disabledAfterToggle(tools, tool.name, enabled) }))} />
      </View>
    </Panel>)}
    <SectionLabel text="Tool call log" />
    {calls.length ? calls.slice().reverse().map(call => <Panel key={call.id}><Text style={{ color: T.text }}>{call.tool} · {call.actor}</Text><Text style={{ color: T.dim }}>{new Date(call.at).toLocaleString()} · {call.durationMs} ms · {call.ok ? "Succeeded" : call.error ?? "Failed"}</Text></Panel>) : <Text style={{ color: T.dim }}>No tool calls yet.</Text>}
    <SectionLabel text="Project hooks" />
    <Text style={{ color: T.dim }}>Repository scripts execute on your computer. Enable only for a repository you trust.</Text>
    {hooks && <><Switch accessibilityLabel="Run project hooks" disabled={busy || !hooks.canEnable} value={hooks.enabled} onValueChange={enabled => void act(() => put("/r4/hooks", { enabled }))} />
      {hooks.hooks.map(h => <TouchableOpacity key={h.event} accessibilityRole="button" style={{ minHeight: 44, justifyContent: "center" }} disabled={busy || !hooks.enabled || !hooks.canEnable || !h.executable} onPress={() => void act(async () => {
        const r = await api<{ code: number | null; output: string; timedOut: boolean }>(creds, base + "/r4/hooks/test", { method: "POST", body: JSON.stringify({ event: h.event }) });
        setMessage(r.timedOut ? "Hook timed out" : `Hook exit ${r.code}: ${r.output}`);
      })}><Text style={{ color: T.text }}>{h.event} · {h.executable ? "Test" : "Missing or not executable"}</Text></TouchableOpacity>)}</>}
    <SectionLabel text="Save chat as skill" />
    {chats.map(c => <TouchableOpacity key={c.id} accessibilityRole="radio" style={{ minHeight: 44, justifyContent: "center" }} accessibilityState={{ checked: chat === c.id }} onPress={() => setChat(c.id)}><Text style={{ color: T.text }}>{chat === c.id ? "● " : "○ "}{c.title}</Text></TouchableOpacity>)}
    <TextInput accessibilityLabel="Skill name" style={field} value={name} onChangeText={setName} autoCapitalize="none" placeholder="skill-name" placeholderTextColor={T.dim} />
    <TouchableOpacity accessibilityRole="button" style={{ minHeight: 44, justifyContent: "center" }} disabled={busy || !validSkillName(name)} onPress={() => void act(async () => {
      const r = await api<{ file: string }>(creds, base + "/r4/skills/from-chat", { method: "POST", body: JSON.stringify({ chat, name }) });
      setMessage(`Draft saved, disabled. Edit ${r.file}`);
    })}><Text style={{ color: T.text }}>Save as skill</Text></TouchableOpacity>
  </ScrollView>;
}
