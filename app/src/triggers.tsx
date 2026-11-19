import { TriggerEditor } from "./r4-phone/trigger-editor";
/**
 * Triggers, on the phone (#361): every schedule and webhook in the project, when each runs next,
 * how its last runs went, and the two things you'd want from a phone — Run now and Pause/Resume.
 * Owner phones can also create and edit schedules and webhooks.
 */

import { IntegrationsPanel } from "./integrations";
import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, RefreshControl, ScrollView, Switch, Text, TouchableOpacity, View } from "react-native";
import { fireTrigger, getTriggers, setTriggerEnabled, type Creds, type Trigger, type TriggerRun } from "./api";
import { TAP } from "./components";
import { T, radii, spacing } from "./theme";
import { scheduleText } from "./trigger-model";

function ago(ms: number): string {
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86_400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86_400)}d ago`;
}
function until(ms: number): string {
  const s = Math.round((ms - Date.now()) / 1000);
  if (s <= 60) return "in a minute";
  if (s < 3600) return `in ${Math.round(s / 60)}m`;
  if (s < 86_400) return `in ${Math.round(s / 3600)}h`;
  return new Date(ms).toLocaleDateString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" });
}
export function TriggersView(props: { creds: Creds; projectId: string; onOpenChat?: (chat: string, title: string) => void }) {
  const [data, setData] = useState<{ triggers: Trigger[]; runs: TriggerRun[] } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    try { setData(await getTriggers(props.creds, props.projectId)); setErr(null); }
    catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
  }, [props.creds, props.projectId]);
  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 15_000);
    return () => clearInterval(t);
  }, [load]);

  const run = async (t: Trigger) => {
    setBusy(t.id + ":run");
    try {
      const { run } = await fireTrigger(props.creds, props.projectId, t.id);
      setNote((n) => ({ ...n, [t.id]: run.ok ? "started — it answers in its thread" : run.note }));
      void load();
    } catch (e) { setNote((n) => ({ ...n, [t.id]: e instanceof Error ? e.message : String(e) })); }
    finally { setBusy(null); }
  };
  const toggle = async (t: Trigger, enabled: boolean) => {
    setBusy(t.id + ":switch");
    // flip it on screen now; the reload puts it right if the computer said no
    setData((d) => d && { ...d, triggers: d.triggers.map((x) => (x.id === t.id ? { ...x, enabled } : x)) });
    try { await setTriggerEnabled(props.creds, props.projectId, t.id, enabled); }
    catch (e) { setNote((n) => ({ ...n, [t.id]: e instanceof Error ? e.message : String(e) })); }
    finally { setBusy(null); void load(); }
  };

  return (
    <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: spacing.md, gap: spacing.sm }}
      refreshControl={<RefreshControl refreshing={false} onRefresh={() => void load()} tintColor={T.dim} />}>
      <TriggerEditor creds={props.creds} project={props.projectId} onSaved={() => void load()} />
      <IntegrationsPanel creds={props.creds} projectId={props.projectId} />
      {err && <Text style={{ color: T.err, fontSize: 13 }}>{err}</Text>}
      {data === null && !err ? <ActivityIndicator color={T.dim} style={{ marginTop: 24 }} /> : null}
      {data && data.triggers.length === 0 && (
        <View style={{ padding: spacing.md, borderRadius: radii.card, borderWidth: 1, borderColor: T.line, gap: 6 }}>
          <Text style={{ color: T.text, fontSize: 15, fontWeight: "700" }}>No triggers yet</Text>
          <Text style={{ color: T.dim, fontSize: 13, lineHeight: 19 }}>
            A trigger starts a turn on its own — every morning, or when CI fails. Create one here from an owner phone, or on your computer.
          </Text>
        </View>
      )}
      {data?.triggers.map((t) => {
        const runs = data.runs.filter((r) => r.trigger === t.id).slice(0, 3);
        return (
          <View key={t.id} style={{ borderRadius: radii.card, borderWidth: 1, borderColor: T.line, backgroundColor: T.panel, padding: 14, gap: 8, opacity: t.enabled ? 1 : 0.7 }}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={{ color: T.text, fontSize: 15, fontWeight: "700" }} numberOfLines={1}>{t.name}</Text>
                <Text style={{ color: T.dim, fontSize: 12.5, marginTop: 2 }} numberOfLines={1}>
                  {scheduleText(t)}{t.agent ? ` · ${t.agent}` : ""}
                  {t.enabled ? (t.nextAt ? ` · next ${until(t.nextAt)}` : "") : " · paused"}
                </Text>
              </View>
              <Switch value={t.enabled} disabled={busy === t.id + ":switch"} onValueChange={(v) => void toggle(t, v)}
                accessibilityLabel={t.enabled ? `Pause ${t.name}` : `Resume ${t.name}`} trackColor={{ true: T.ok, false: T.line2 }} />
            </View>
            <TriggerEditor creds={props.creds} project={props.projectId} trigger={t} onSaved={() => void load()} />
            <Text style={{ color: T.dim, fontSize: 13, lineHeight: 18 }} numberOfLines={2}>{t.prompt}</Text>
            {runs.length > 0 && (
              <View style={{ gap: 3 }}>
                {runs.map((r) => (
                  <View key={r.at} style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                    <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: r.ok ? T.ok : T.warn }} />
                    <Text style={{ color: T.faint, fontSize: 12 }} numberOfLines={1}>{ago(r.at)} · {r.note}</Text>
                  </View>
                ))}
              </View>
            )}
            {note[t.id] ? <Text style={{ color: T.dim, fontSize: 12.5 }}>{note[t.id]}</Text> : null}
            <View style={{ flexDirection: "row", gap: 8 }}>
              <TouchableOpacity onPress={() => void run(t)} disabled={!!busy} activeOpacity={0.75} accessibilityRole="button" accessibilityLabel={`Run ${t.name} now`}
                style={{ flex: 1, minHeight: TAP - 4, borderRadius: radii.key, backgroundColor: T.raised, borderWidth: 1, borderColor: T.line2, alignItems: "center", justifyContent: "center" }}>
                {busy === t.id + ":run" ? <ActivityIndicator color={T.dim} /> : <Text style={{ color: T.text, fontSize: 14, fontWeight: "700" }}>Run now</Text>}
              </TouchableOpacity>
              {t.chat && props.onOpenChat ? (
                <TouchableOpacity onPress={() => props.onOpenChat!(t.chat!, t.name)} activeOpacity={0.75} accessibilityRole="button" accessibilityLabel={`Open ${t.name}'s thread`}
                  style={{ flex: 1, minHeight: TAP - 4, borderRadius: radii.key, borderWidth: 1, borderColor: T.line, alignItems: "center", justifyContent: "center" }}>
                  <Text style={{ color: T.dim, fontSize: 14, fontWeight: "600" }}>Open thread</Text>
                </TouchableOpacity>
              ) : null}
            </View>
          </View>
        );
      })}
    </ScrollView>
  );
}
