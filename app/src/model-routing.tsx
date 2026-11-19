import { useEffect, useState } from "react";
import { Share, Text, TextInput, TouchableOpacity, View } from "react-native";
import { api, type AgentStatus, type Creds } from "./api";
import { Sheet } from "./observatory";
import { T, radii } from "./theme";
import { estimateLabel, parseAgentRouting, type ModelEstimate } from "./model-routing-model";

export function ModelEstimateLine(props: { creds: Creds; projectId: string; agentId?: string; chat: string; text: string; model?: string }) {
  const [line, setLine] = useState("");
  useEffect(() => {
    let stale = false;
    setLine("");
    if (!props.text.trim()) return;
    const timer = setTimeout(() => {
      void api<ModelEstimate>(props.creds, `/api/projects/${props.projectId}/estimate`, { method: "POST", body: JSON.stringify({ text: props.text, chat: props.chat, agentId: props.agentId, model: props.model }) })
        .then(e => { if (!stale) setLine(estimateLabel(e)); }).catch(e => { if (!stale) setLine(e.message); });
    }, 250);
    return () => { stale = true; clearTimeout(timer); };
  }, [props.creds, props.projectId, props.agentId, props.chat, props.text, props.model]);
  return line ? <Text accessibilityLiveRegion="polite" style={{ color: T.dim, fontSize: 11.5, paddingHorizontal: 12 }}>{line}</Text> : null;
}

export function ModelRoutingSheet(props: { creds: Creds; projectId: string; agent: AgentStatus | null; onChanged: () => void }) {
  const [open, setOpen] = useState(false), [status, setStatus] = useState("");
  const [effort, setEffort] = useState(""), [agentEffort, setAgentEffort] = useState(""), [args, setArgs] = useState("[]"), [fallbacks, setFallbacks] = useState("[]");
  const [settings, setSettings] = useState(""), [owner, setOwner] = useState(false);
  const [health, setHealth] = useState("");
  const base = `/api/projects/${props.projectId}`;
  const agentPath = `${base}/agents/${encodeURIComponent(props.agent?.id ?? "")}/options`;
  const fail = (e: Error) => setStatus(e.message);
  useEffect(() => {
    if (!open) return;
    let stale = false;
    setStatus(""); setOwner(false); setSettings(""); setHealth("");
    void api<{ defaultEffort: string }>(props.creds, `${base}/config`).then(c => { if (!stale) setEffort(c.defaultEffort); }).catch(fail);
    if (props.agent) void api<{ extraArgs: string[]; fallbacks: string[]; effort: string }>(props.creds, agentPath).then(o => { if (!stale) { setArgs(JSON.stringify(o.extraArgs)); setFallbacks(JSON.stringify(o.fallbacks)); setAgentEffort(o.effort); } }).catch(fail);
    void api<{ aliases: Record<string, string>; caps: Record<string, unknown>; mondayDigest: boolean }>(props.creds, "/api/model-routing").then(s => {
      if (!stale) { setOwner(true); setSettings(JSON.stringify({ aliases: s.aliases, caps: s.caps, mondayDigest: s.mondayDigest }, null, 2)); }
    }).catch(() => { if (!stale) setOwner(false); });
    return () => { stale = true; };
  }, [open, props.creds, props.projectId, props.agent?.id]);
  const button = (label: string, run: () => void) => <TouchableOpacity accessibilityRole="button" onPress={run} style={{ padding: 10, marginVertical: 4, borderWidth: 1, borderColor: T.line, borderRadius: radii.key }}><Text style={{ color: T.text }}>{label}</Text></TouchableOpacity>;
  const field = (label: string, value: string, change: (s: string) => void, multiline = false) => <View style={{ marginVertical: 7 }}><Text style={{ color: T.dim, fontSize: 12 }}>{label}</Text><TextInput accessibilityLabel={label} value={value} onChangeText={change} autoCapitalize="none" autoCorrect={false} multiline={multiline} style={{ color: T.text, padding: 8, borderWidth: 1, borderColor: T.line, borderRadius: radii.key }} /></View>;
  return <>
    {button("Model settings", () => setOpen(true))}
    <Sheet title="Models and routing" visible={open} onClose={() => setOpen(false)}>
      {field("Project effort: low, medium, high, or blank", effort, setEffort)}
      {button("Save project effort", () => { void api(props.creds, `${base}/config`, { method: "PATCH", body: JSON.stringify({ defaultEffort: effort }) }).then(() => { setStatus("Project effort saved"); props.onChanged(); }).catch(fail); })}
      {props.agent && <>
        <Text style={{ color: T.text }}>{props.agent.id}</Text>
        {field("Extra arguments (JSON array)", args, setArgs, true)}
        {props.agent.kind === "model" && field("Fallback models (JSON array)", fallbacks, setFallbacks, true)}
        {field("Agent effort (blank inherits project)", agentEffort, setAgentEffort)}
        {button("Save agent options", () => { try { void api(props.creds, agentPath, { method: "PUT", body: JSON.stringify(parseAgentRouting(args, props.agent?.kind === "model" ? fallbacks : "[]", agentEffort)) }).then(() => { setStatus("Agent options saved"); props.onChanged(); }).catch(fail); } catch (e) { fail(e as Error); } })}
      </>}
      {owner ? <>
        {field("Machine aliases, daily caps and Monday notification (JSON)", settings, setSettings, true)}
        <Text style={{ color: T.dim }}>Caps reset at midnight UTC. mondayDigest enables the Monday desktop notification.</Text>
        {button("Save machine settings", () => { try { const value = JSON.parse(settings); void api(props.creds, "/api/model-routing", { method: "PUT", body: JSON.stringify(value) }).then(() => setStatus("Model settings saved")).catch(fail); } catch (e) { fail(e as Error); } })}
        {button("Probe model health", () => { void api<{ health: Array<{ model: string; latencyMs: number; lastError: string | null }> }>(props.creds, "/api/model-routing/health", { method: "POST" }).then(r => setHealth(r.health.map(h => `${h.model}: ${h.latencyMs} ms · ${h.lastError ?? "Available"}`).join("\n") || "No configured models")).catch(fail); })}
        <Text style={{ color: T.dim }}>{health}</Text>
      </> : <Text style={{ color: T.dim }}>Machine aliases, caps and Monday notifications are managed by the machine owner in desktop Settings → Models.</Text>}
      {button("Weekly scoreboard", () => { void api<{ text: string }>(props.creds, `/api/scoreboard?project=${encodeURIComponent(props.projectId)}&digest=1`).then(r => setStatus(r.text)).catch(fail); })}
      {button("Share scoreboard CSV", () => { void api<{ csv: string }>(props.creds, `/api/scoreboard?project=${encodeURIComponent(props.projectId)}&format=csv-json`).then(r => Share.share({ title: "Loom scoreboard CSV", message: r.csv })).catch(fail); })}
      <Text accessibilityLiveRegion="polite" style={{ color: T.dim, marginVertical: 10 }}>{status}</Text>
    </Sheet>
  </>;
}
