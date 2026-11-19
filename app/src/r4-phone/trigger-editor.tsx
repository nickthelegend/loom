import { useEffect, useState } from "react";
import { Modal, ScrollView, TextInput, View } from "react-native";
import { api, getProject, type Creds, type Trigger } from "../api";
import { T } from "../theme";
import { Text } from "./preferences";
import { Button } from "./settings";
export function TriggerEditor({ creds, project, trigger, onSaved }: { creds: Creds; project: string; trigger?: Trigger; onSaved: () => void }) {
  const [owner, setOwner] = useState(false), [open, setOpen] = useState(false), [name, setName] = useState(trigger?.name ?? ""), [prompt, setPrompt] = useState(trigger?.prompt ?? "");
  const [kind, setKind] = useState(trigger?.kind ?? "schedule"), [schedule, setSchedule] = useState(trigger?.cron ?? (trigger?.everyMin ? `${trigger.everyMin}m` : "0 9 * * 1-5")), [agent, setAgent] = useState(trigger?.agent ?? "");
  const [agents, setAgents] = useState<string[]>([]), [preview, setPreview] = useState(""), [error, setError] = useState(""), [secret, setSecret] = useState(""), [busy, setBusy] = useState(false);
  const scheduleBody = () => /\s/.test(schedule.trim()) || schedule.startsWith("@") ? { cron: schedule.trim() } : { every: schedule.trim() };
  useEffect(() => { let live = true; void api<{ owner: boolean }>(creds, "/api/phone/capabilities").then(r => { if (live) setOwner(r.owner); }).catch(() => {}); return () => { live = false; }; }, [creds]);
  useEffect(() => { if (open) void getProject(creds, project).then(r => setAgents(r.project.agents.map(a => a.id))).catch(e => setError(String(e))); }, [open, creds, project]);
  useEffect(() => {
    if (!open || kind !== "schedule") return;
    let live = true;
    const timer = setTimeout(() => { void api<{ runs: number[]; timeZone: string }>(creds, `/api/projects/${project}/phone/trigger-preview`, { method: "POST", body: JSON.stringify(scheduleBody()) }).then(r => { if (live) setPreview(`${r.timeZone}: ${r.runs.map(n => new Date(n).toLocaleString(undefined, { timeZone: r.timeZone })).join(" · ")}`); }).catch(e => { if (live) setPreview(String(e)); }); }, 300);
    return () => { live = false; clearTimeout(timer); };
  }, [open, schedule, kind, creds, project]);
  const save = async () => {
    if (busy) return;
    setBusy(true); setError("");
    try {
      const result = await api<{ secret?: string; path?: string }>(creds, `/api/projects/${project}/triggers${trigger ? `/${trigger.id}` : ""}`, { method: trigger ? "PATCH" : "POST", body: JSON.stringify({ phoneEditor: true, name, prompt, agent, ...(!trigger ? { kind } : {}), ...(kind === "schedule" ? scheduleBody() : {}) }) });
      if (result.secret) setSecret(`Webhook: ${creds.url}${result.path}\nSecret (shown once): ${result.secret}`);
      else { setOpen(false); onSaved(); }
    } catch (e) { setError(String(e)); } finally { setBusy(false); }
  };
  if (!owner) return null;
  return <><Button title={trigger ? "Edit trigger" : "Create trigger"} onPress={() => { setSecret(""); setOpen(true); }} />
    <Modal visible={open} onRequestClose={() => { setOpen(false); onSaved(); }} animationType="slide"><ScrollView contentContainerStyle={{ padding: 24, paddingTop: 50, backgroundColor: T.bg, flexGrow: 1, gap: 12 }} keyboardShouldPersistTaps="handled">
      <Text style={{ color: T.text, fontSize: 20 }}>{trigger ? "Edit trigger" : "Create trigger"}</Text><Text style={{ color: T.err }}>{error}</Text>
      {secret ? <Text selectable style={{ color: T.text }}>{secret}</Text> : <>
        {!trigger && <View style={{ flexDirection: "row" }}>{(["schedule", "webhook"] as const).map(k => <Button key={k} title={`${k}${kind === k ? " ✓" : ""}`} onPress={() => setKind(k)} />)}</View>}
        {[{ label: "Name", value: name, change: setName }, { label: "Prompt", value: prompt, change: setPrompt }].map(f => <TextInput key={f.label} accessibilityLabel={f.label} placeholder={f.label} placeholderTextColor={T.dim} value={f.value} onChangeText={f.change} multiline={f.label === "Prompt"} style={{ padding: 12, color: T.text, borderWidth: 1, borderColor: T.line }} />)}
        <Text style={{ color: T.text }}>Agent</Text><Button title={`Automatic${!agent ? " ✓" : ""}`} onPress={() => setAgent("")} />{agents.map(a => <Button key={a} title={`${a}${agent === a ? " ✓" : ""}`} onPress={() => setAgent(a)} />)}
        {kind === "schedule" && <><TextInput accessibilityLabel="Cron or interval" value={schedule} onChangeText={setSchedule} style={{ padding: 12, color: T.text, borderWidth: 1, borderColor: T.line }} /><Text style={{ color: T.dim }}>Next runs (computer timezone): {preview}</Text></>}
        <Button title={busy ? "Saving…" : "Save trigger"} onPress={() => void save()} />
      </>}<Button title="Done" onPress={() => { setOpen(false); onSaved(); }} />
    </ScrollView></Modal>
  </>;
}
