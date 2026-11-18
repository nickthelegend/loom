import { useState } from "react";
import { Share, Switch, Text, TextInput, TouchableOpacity, View } from "react-native";
import { api, type Creds } from "./api";
import { T, radii } from "./theme";
import { integrationPatch } from "./integrations-model";

export function IntegrationsPanel({ creds, projectId }: { creds: Creds; projectId: string }) {
  const [section, setSection] = useState("");
  const [values, setValues] = useState<Record<string, string>>({});
  const [enabled, setEnabled] = useState(false);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [templates, setTemplates] = useState<Array<{ id: string; name: string; prompt: string; payload: unknown; event: string }>>([]);
  const base = `/api/projects/${projectId}/triggers`;
  const run = async (fn: () => Promise<void>) => { setBusy(true); try { await fn(); } catch (e) { setNote((e as Error).message); } finally { setBusy(false); } };
  const button = (label: string, action: () => void) => <TouchableOpacity key={label} accessibilityRole="button" disabled={busy} onPress={action}
    style={{ padding: 10, borderRadius: radii.key, borderWidth: 1, borderColor: T.line, opacity: busy ? 0.5 : 1 }}><Text style={{ color: T.text }}>{label}</Text></TouchableOpacity>;
  const open = (s: string) => void run(async () => {
    setSection(s); setNote(""); setValues({});
    if (s === "webhook") { setValues({ name: "Webhook", prompt: "{{body}}", payload: "{}", event: "" }); setEnabled(false); setTemplates((await api<{ templates: typeof templates }>(creds, base + "/templates")).templates); }
    else if (s === "email") {
      const c = await api<Record<string, unknown>>(creds, "/api/integrations/email");
      setEnabled(Boolean(c.enabled)); setValues(Object.fromEntries(["host", "port", "security", "username", "from", "to", "everyHours"].map(k => [k, String(c[k] ?? "")])));
    } else if (s === "slack" || s === "discord") {
      const c = (await api<Record<string, Record<string, unknown>>>(creds, "/api/bridges"))[s] ?? {};
      setEnabled(Boolean(c.enabled)); setValues({ users: (c.users as string[] ?? []).join(","), channels: (c.channels as string[] ?? []).join(","), project: String(c.project ?? projectId), orchestraChannel: String(c.orchestraChannel ?? "") });
    } else {
      const p = (await api<{ providers: Array<{ id: string; baseUrl: string }> }>(creds, "/api/providers")).providers.find(p => p.id === s);
      setValues({ baseUrl: p?.baseUrl ?? "", key: "" });
    }
  });
  const fields: Array<[string, string]> = section === "webhook" ? [["name", "Name"], ["prompt", "Prompt template"], ["payload", "Sample JSON"], ["event", "Event"]]
    : section === "email" ? [["host", "SMTP host"], ["port", "Port"], ["security", "Security: tls or starttls"], ["username", "Username"], ["password", "Password (blank keeps saved)"], ["from", "Sender email"], ["to", "Recipient email"], ["everyHours", "Every 1–168 hours"]]
    : section === "slack" || section === "discord" ? [["botToken", "Bot token (blank keeps saved)"], ...(section === "slack" ? [["appToken", "Socket Mode app token"] as [string, string]] : [["orchestraChannel", "Orchestra progress channel ID"] as [string, string]]), ["users", "Allowed user IDs, comma separated"], ["channels", "Allowed channel IDs, comma separated"], ["project", "Project ID or name"]]
    : section ? [["baseUrl", "Provider URL"], ["key", section === "jira" ? "Jira email:API-token (blank keeps saved)" : "API key (blank keeps saved)"]] : [];
  const save = () => void run(async () => {
    const url = section === "email" ? "/api/integrations/email" : ["slack", "discord"].includes(section) ? "/api/bridges/" + section : "/api/providers/" + section;
    const fieldsToSave = { ...values };
    if (section === "slack") delete fieldsToSave.orchestraChannel;
    const body = integrationPatch(fieldsToSave, section === "email" ? ["port", "everyHours"] : [], ["password", "key", "botToken", "appToken"]);
    await api(creds, url, { method: url.includes("providers") ? "POST" : "PUT", body: JSON.stringify({ ...body, ...(["email", "slack", "discord"].includes(section) ? { enabled } : {}) }) });
    setValues(v => ({ ...v, password: "", key: "", botToken: "", appToken: "" })); setNote("Saved.");
  });
  return <View style={{ padding: 14, gap: 8, borderWidth: 1, borderColor: T.line, borderRadius: radii.card }}>
    <Text style={{ color: T.text, fontWeight: "700", fontSize: 15 }}>Integrations</Text>
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
      {Object.entries({ webhook: "Webhook preview", jira: "Jira", linear: "Linear", gitlab: "GitLab", slack: "Slack", discord: "Discord", email: "Email" }).map(([s, label]) => button(label, () => open(s)))}
      {button("Share calendar feed", () => void run(async () => { const r = await api<{ path: string }>(creds, base + "/calendar-link", { method: "POST", body: "{}" }); await Share.share({ message: creds.url.replace(/\/$/, "") + r.path }); }))}
      {button("Revoke calendar feed", () => void run(async () => { await api(creds, base + "/calendar-link", { method: "DELETE" }); setNote("Calendar feed revoked."); }))}
      {button("Export calendar", () => void run(async () => { const r = await api<{ calendar: string }>(creds, base + "/calendar?format=json"); await Share.share({ title: "loom-schedules.ics", message: r.calendar }); }))}
    </View>
    {section === "slack" && <Text style={{ color: T.dim }}>Enable /loom and commands scope in your Slack app. /loom &lt;goal&gt; starts Orchestra via Socket Mode for allowed users.</Text>}
    {section === "discord" && <Text style={{ color: T.dim }}>Give the bot Create Public Threads and Send Messages in Threads permissions. Each Orchestra run gets a progress thread.</Text>}
    {section === "linear" && <Text style={{ color: T.dim }}>Linked issues move to Done when their PR merges.</Text>}
    {section === "gitlab" && <Text style={{ color: T.dim }}>Use a read_api token. Attach an MR URL from the computer’s chat menu; its feedback mode controls CI and trusted reviews.</Text>}
    {section === "webhook" && <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 4 }}>{templates.map(t => button(t.name, () => setValues(v => ({ ...v, prompt: t.prompt, payload: JSON.stringify(t.payload, null, 2), event: t.event }))))}</View>}
    {fields.map(([key, label]) => <View key={key} style={{ gap: 4 }}><Text style={{ color: T.dim }}>{label}</Text><TextInput accessibilityLabel={label} value={values[key] ?? ""} onChangeText={text => setValues(v => ({ ...v, [key]: text }))}
      autoCapitalize="none" autoCorrect={false} secureTextEntry={["password", "key", "botToken", "appToken"].includes(key)} multiline={["prompt", "payload"].includes(key)}
      style={{ color: T.text, borderColor: T.line, borderWidth: 1, borderRadius: radii.input, padding: 10 }} /></View>)}
    {["email", "slack", "discord"].includes(section) && <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}><Switch value={enabled} onValueChange={setEnabled} accessibilityLabel="Enabled" /><Text style={{ color: T.dim, flex: 1 }}>Enabled</Text></View>}
    {section && section !== "webhook" && button("Save settings", save)}
    {section === "webhook" && button("Preview prompt", () => void run(async () => { const r = await api<{ prompt: string }>(creds, base + "/preview", { method: "POST", body: JSON.stringify({ name: values.name, prompt: values.prompt, payload: JSON.parse(values.payload ?? "{}"), event: values.event }) }); setNote(r.prompt); }))}
    {section === "email" && <>{button("Preview digest", () => void run(async () => { setNote((await api<{ text: string }>(creds, "/api/integrations/email/preview")).text); }))}{button("Send digest now", () => void run(async () => { await api(creds, "/api/integrations/email/send", { method: "POST", body: "{}" }); setNote("Digest sent."); }))}</>}
    {note ? <Text selectable accessibilityLiveRegion="polite" style={{ color: T.dim }}>{note}</Text> : null}
  </View>;
}
