import { useCallback, useEffect, useState } from "react";
import { Modal, ScrollView, Text, TextInput, TouchableOpacity, View } from "react-native";
import { api, type Creds } from "./api";
import { field, TAP } from "./components";
import { T, spacing } from "./theme";
import { automationInput, automationKinds, automationStatus, emptyAutomation, quietDefaults, type AutomationDraft } from "./r4-auto-model";

interface Trigger { id: string; kind: AutomationDraft["kind"] | "intake"; name: string; prompt: string; enabled: boolean; when?: string; onChange?: string; on?: string; onCommit?: string; watchUrl?: string; condition?: string; recipe?: string; route?: string; orchestrate?: boolean; everyMin?: number; select?: string; failureLimit?: number }
interface AutomationView {
  owner: boolean; canEditTriggers: boolean; held: number; hold: string | null;
  control: { paused?: boolean; resumeAt?: number; quiet?: boolean | { range: string; days: number[] } };
  triggers: Trigger[]; runs: Array<{ trigger: string; at: number; note: string }>;
  webhooks: Array<{ id: string; url: string; events: string[] }>;
  deliveries: Array<{ id: string; event: string; status: string; attempts: number; error?: string }>;
}
function Action(props: { title: string; onPress: () => void; disabled?: boolean }) {
  return <TouchableOpacity accessibilityRole="button" disabled={props.disabled} onPress={props.onPress} style={{ minHeight: TAP, justifyContent: "center", opacity: props.disabled ? 0.5 : 1 }}><Text style={{ color: T.primary }}>{props.title}</Text></TouchableOpacity>;
}
export function AutomationPanel({ creds, projectId }: { creds: Creds; projectId: string }) {
  const base = `/api/projects/${encodeURIComponent(projectId)}/automation`;
  const [data, setData] = useState<AutomationView | null>(null), [open, setOpen] = useState(false), [busy, setBusy] = useState(false), [message, setMessage] = useState("");
  const [draft, setDraft] = useState(emptyAutomation), [editing, setEditing] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ when: string; cron: string; next: number[] } | null>(null);
  const [quiet, setQuiet] = useState("22:00-07:00"), [days, setDays] = useState("mon-fri"), [duration, setDuration] = useState("2h");
  const [url, setUrl] = useState(""), [events, setEvents] = useState("turn_finished,needs_you,pr_opened");
  const load = useCallback(async () => { setData(await api<AutomationView>(creds, base)); }, [creds, base]);
  useEffect(() => { let live = true; const refresh = () => { if (live) void load().catch(e => { if (live) setMessage(e.message); }); }; refresh(); const timer = setInterval(refresh, 15_000); return () => { live = false; clearInterval(timer); }; }, [load]);
  async function action(route: string, method = "POST", body: object = {}): Promise<void> {
    setBusy(true); setMessage("");
    try {
      const r = await api<{ secret?: string; path?: string; run?: { note: string } }>(creds, route, { method, body: JSON.stringify(body) });
      setMessage(r.secret ? `Webhook path: ${r.path}\nSecret (shown once): ${r.secret}` : r.run?.note || "Saved"); await load();
    } catch (e) { setMessage((e as Error).message); }
    finally { setBusy(false); }
  }
  const edit = <K extends keyof AutomationDraft>(key: K, value: AutomationDraft[K]) => { setDraft(d => ({ ...d, [key]: value })); if (key === "when" || key === "kind") setPreview(null); };
  const input = (label: string, value: string, change: (s: string) => void) => <View><Text style={{ color: T.dim }}>{label}</Text><TextInput accessibilityLabel={label} style={field} value={value} onChangeText={change} autoCapitalize="none" /></View>;
  const paused = Boolean(data?.control.paused && (!data.control.resumeAt || data.control.resumeAt > Date.now()));
  function selectTrigger(t: Trigger) {
    if (t.kind === "intake") return;
    setEditing(t.id); setPreview(null);
    setDraft({ kind: t.kind, name: t.name, when: t.when || t.onChange || t.on || t.onCommit || t.watchUrl || "", prompt: t.prompt, condition: t.condition || "", action: t.recipe ? "recipe" : t.route ? "route" : t.orchestrate ? "orchestrate" : "prompt", target: t.recipe || t.route || "", every: `${t.everyMin || 15}m`, select: t.select || "", failureLimit: String(t.failureLimit || 3) });
  }
  return <View style={{ paddingHorizontal: spacing.md }}>
    <Action title={data ? automationStatus(data) + " · Manage" : "Manage automation"} onPress={() => { const q = quietDefaults(data?.control.quiet); setQuiet(q.range); setDays(q.days); setOpen(true); }} />
    <Modal visible={open} onRequestClose={() => setOpen(false)} animationType="slide">
      <ScrollView contentContainerStyle={{ padding: spacing.lg, paddingTop: 60, gap: 12, backgroundColor: T.panel }}>
        <Action title="Close automation" onPress={() => setOpen(false)} />
        <Text style={{ color: T.text, fontSize: 20 }}>Automation</Text>
        {data && <Text accessibilityLiveRegion="polite" style={{ color: T.dim }}>{automationStatus(data)}</Text>}
        {message ? <Text selectable accessibilityLiveRegion="polite" style={{ color: T.text }}>{message}</Text> : null}
        {data?.owner && <View>
          {input("Quiet hours (local time)", quiet, setQuiet)}{input("Days quiet hours start", days, setDays)}
          <Action title="Set quiet hours" disabled={busy} onPress={() => void action("/api/automation", "PUT", { quiet, days })} />
          <Action title="Quiet hours off" disabled={busy} onPress={() => void action("/api/automation", "PUT", { quiet: "off" })} />
          {input("Pause for (blank means until resumed)", duration, setDuration)}
          <Action title={paused ? "Resume all automation" : "Pause all automation"} disabled={busy} onPress={() => void action("/api/automation", "PUT", { paused: !paused, ...(duration ? { for: duration } : {}) })} />
        </View>}
        <Text style={{ color: T.text, fontSize: 18 }}>Triggers and run history</Text>
        {data?.triggers.filter(t => t.kind !== "intake").map(t => <View key={t.id} style={{ borderWidth: 1, borderColor: T.line, padding: 10 }}>
          <Text style={{ color: T.text }}>{t.name} · {t.kind} · {t.enabled ? "on" : "paused"}</Text>
          {data.runs.filter(r => r.trigger === t.id).slice(-3).reverse().map((r, i) => <Text key={i} style={{ color: T.dim }}>{new Date(r.at).toLocaleString()} · {r.note}</Text>)}
          <Action title="Run now" disabled={busy || !data.owner} onPress={() => void action(`${base}/triggers/${t.id}/fire`)} />
          <Action title={t.enabled ? "Pause trigger" : "Resume trigger"} disabled={busy || !data.owner} onPress={() => void action(`${base}/triggers/${t.id}`, "PATCH", { enabled: !t.enabled })} />
          <Action title="Edit automation" disabled={!data.canEditTriggers} onPress={() => selectTrigger(t)} />
          <Action title="Remove automation" disabled={busy || !data.canEditTriggers} onPress={() => void action(`${base}/triggers/${t.id}`, "DELETE")} />
        </View>)}
        <Text style={{ color: T.text, fontSize: 18 }}>{editing ? "Edit automation" : "New automation"}</Text>
        {editing && <Action title="New trigger" onPress={() => { setEditing(null); setDraft(emptyAutomation()); setPreview(null); }} />}
        {!editing && <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 12 }}>{automationKinds.filter(k => data?.owner || k !== "file").map(k => <Action key={k} title={(draft.kind === k ? "✓ " : "") + k} onPress={() => edit("kind", k)} />)}</View>}
        {input("Name", draft.name, s => edit("name", s))}
        {draft.kind !== "webhook" && input("When", draft.when, s => edit("when", s))}
        <Text style={{ color: T.dim }}>{ { schedule: "Example: every weekday at 9am. Times are local to the daemon. When editing, leave blank to keep the existing schedule.", file: "Project glob, e.g. docs/**. Prompt: {{files}}", event: "turn_failed | pr_merged | ci_failed | run_completed | approval_expired. Prompt: {{event.type}}", branch: "Branch name. Prompt: {{commits}} and {{range}}", url: "Public URL. Prompt: {{old}} and {{new}}", webhook: "A signed incoming webhook starts this trigger." }[draft.kind]}</Text>
        {draft.kind === "schedule" && <Action title="Preview next five runs" disabled={busy} onPress={() => {
          setBusy(true); const when = draft.when.trim();
          void api<{ cron: string; next: number[] }>(creds, base + "/preview", { method: "POST", body: JSON.stringify({ when }) }).then(r => setPreview({ when, ...r })).catch(e => setMessage(e.message)).finally(() => setBusy(false));
        }} />}
        {preview && <Text selectable style={{ color: T.dim }}>{preview.cron}{"\n"}{preview.next.map(at => new Date(at).toLocaleString()).join("\n")}</Text>}
        {draft.kind === "url" && <>{input("URL polling interval", draft.every, s => edit("every", s))}{input("JSON path (optional)", draft.select, s => edit("select", s))}</>}
        {input("Prompt", draft.prompt, s => edit("prompt", s))}{input("Condition (clean, dirty, file:glob, hours:9-18, cmd:command)", draft.condition, s => edit("condition", s))}
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 12 }}>{(["prompt", "recipe", "orchestrate", "route"] as const).map(k => <Action key={k} title={(draft.action === k ? "✓ " : "") + k} onPress={() => edit("action", k)} />)}</View>
        {(draft.action === "recipe" || draft.action === "route") && input("Recipe or route name", draft.target, s => edit("target", s))}
        {input("Pause after consecutive failures", draft.failureLimit, s => edit("failureLimit", s))}
        <Action title="Save automation" disabled={busy || !data?.canEditTriggers} onPress={() => {
          try { const body = automationInput(draft, preview?.when || "", Boolean(editing)); void action(base + "/triggers" + (editing ? "/" + editing : ""), editing ? "PATCH" : "POST", body); }
          catch (e) { setMessage((e as Error).message); }
        }} />
        <Text style={{ color: T.text, fontSize: 18 }}>Outgoing webhooks</Text>
        {input("Destination URL", url, setUrl)}{input("Events (comma-separated)", events, setEvents)}
        <Action title="Add outgoing webhook" disabled={busy || !data?.owner} onPress={() => void action(base + "/webhooks", "POST", { url, events: events.split(",").map(e => e.trim()) })} />
        {data?.webhooks.map(w => <View key={w.id}><Text style={{ color: T.text }}>{w.url} · {w.events.join(", ")}</Text><Action title="Remove webhook" disabled={busy || !data?.owner} onPress={() => void action(base + "/webhooks/" + w.id, "DELETE")} /></View>)}
        {data?.deliveries.slice(-20).reverse().map(d => <View key={d.id}><Text style={{ color: T.dim }}>{d.event} · {d.status} · {d.attempts} attempts {d.error}</Text><Action title="Send again" disabled={busy || !data?.owner} onPress={() => void action(base + "/deliveries/" + encodeURIComponent(d.id) + "/resend")} /></View>)}
      </ScrollView>
    </Modal>
  </View>;
}
