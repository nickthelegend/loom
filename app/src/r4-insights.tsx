import React, { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Text, TextInput, TouchableOpacity, View } from "react-native";
import { api, type Creds } from "./api";
import { T } from "./theme";
import { toolLine, hoursSummary, alertState, examplePath, type PhoneInsights, type Rule } from "./r4-insights-model";

export function R4Insights(props: { creds: Creds; projectId: string }) {
  const { creds, projectId } = props;
  const base = `/api/projects/${encodeURIComponent(projectId)}`;
  const [data, setData] = useState<PhoneInsights | null>(null), [rules, setRules] = useState<Rule[]>([]);
  const [error, setError] = useState(""), [message, setMessage] = useState(""), [expression, setExpression] = useState("finish_rate < 70% over 20 turns");
  const [example, setExample] = useState<{ id: number; payload: unknown } | null>(null);
  const [nonce, setNonce] = useState(0), [busy, setBusy] = useState(false);
  const reload = useCallback(() => setNonce(n => n + 1), []);
  useEffect(() => {
    let live = true; setData(null); setRules([]); setError(""); setExample(null);
    void Promise.all([api<PhoneInsights>(creds, base + "/insights/r4"), api<{ rules: Rule[] }>(creds, base + "/alerts")])
      .then(([insights, alerts]) => { if (live) { setData(insights); setRules(alerts.rules); } })
      .catch((e: Error) => { if (live) setError(e.message); });
    return () => { live = false; };
  }, [creds, base, nonce]);
  async function action(route: string, method: string, body?: unknown) {
    setBusy(true); setError("");
    try {
      const result = await api<{ test?: boolean; value?: number | null }>(creds, base + route, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      setMessage(result.test ? `Test notification sent · observed ${result.value ?? 'insufficient data'}` : "Saved"); reload();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  }
  async function openExample(eventId: number) {
    try { const result = await api<{ events: Array<{ id: number; payload: unknown }> }>(creds, examplePath(projectId, eventId)); if (!result.events[0]) throw new Error("This event is no longer available."); setExample(result.events[0]); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }
  const button = (label: string, onPress: () => void) => <TouchableOpacity accessibilityRole="button" accessibilityLabel={label} disabled={busy} onPress={onPress} style={{ padding: 12, minHeight: 44, borderWidth: 1, borderColor: T.line, borderRadius: 8 }}><Text style={{ color: T.primary }}>{label}</Text></TouchableOpacity>;
  const text = (value: string, key?: string) => <Text key={key} style={{ color: T.text, fontSize: 12, lineHeight: 19 }}>{value}</Text>;
  const title = (value: string) => <Text style={{ color: T.text, fontSize: 15, fontWeight: "700", marginTop: 12 }}>{value}</Text>;
  return <View style={{ gap: 9, borderWidth: 1, borderColor: T.line, borderRadius: 12, padding: 14 }}>
    {title("Reliability & working time")}
    {button("Refresh insights", reload)}
    {error ? <Text accessibilityRole="alert" style={{ color: T.err }}>{error}</Text> : null}
    {!data && !error ? <ActivityIndicator color={T.primary} /> : null}
    {data ? <>
      {title("Tools")}
      {data.tools.byTool.length ? data.tools.byTool.map(r => text(toolLine(r), r.name)) : text("No tool calls recorded yet.")}
      {title("Tools by agent")}{data.tools.byAgent.map(r => text(toolLine(r), r.name))}
      {title("Failure groups")}
      {data.errors.length ? data.errors.map(g => <View key={g.error} style={{ gap: 4 }}>{text(`${g.count} × ${g.error}`)}{text(`Last seen ${new Date(g.lastSeen).toLocaleString()}`)}{g.examples.map(e => <View key={e.eventId}>{button(`View ${e.agent} · event #${e.eventId}`, () => void openExample(e.eventId))}</View>)}</View>) : text("No failed turns recorded.")}
      {example ? <View style={{ gap: 6 }}>{text(`Recorded event #${example.id}`)}{text(JSON.stringify(example.payload, null, 2))}{button("Close example", () => setExample(null))}</View> : null}
      {title("Agent hours")}{text(hoursSummary(data.hours))}
      {text("Measured work, including active and interrupted turns; human waits excluded.")}
      {data.hours.entries.map(r => text(`${r.day} · ${r.agent} · ${(r.activeMs / 3_600_000).toFixed(2)} h`, r.day + r.agent))}
    </> : null}
    {title("Reliability alerts")}
    <TextInput accessibilityLabel="Alert rule" value={expression} onChangeText={setExpression} autoCapitalize="none" style={{ color: T.text, borderWidth: 1, borderColor: T.line, padding: 12, borderRadius: 8 }} />
    {text("Also: turn_minutes > 5 over 10 turns, errors_per_hour > 3, queue_depth > 5")}
    {button("Add alert", () => void action("/alerts", "POST", { expression }))}
    {rules.map(rule => <View key={rule.id} style={{ gap: 8 }}>{text(`${rule.expression} · ${alertState(rule)}`)}<View style={{ flexDirection: "row", gap: 8 }}>{button(rule.paused ? "Resume" : "Pause", () => void action(`/alerts/${encodeURIComponent(rule.id)}`, "PATCH", { paused: !rule.paused }))}{button("Test", () => void action(`/alerts/${encodeURIComponent(rule.id)}/test`, "POST"))}</View></View>)}
    {message ? text(message) : null}
  </View>;
}
