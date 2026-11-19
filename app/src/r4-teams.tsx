import { useEffect, useState } from "react";
import { Text, TextInput, TouchableOpacity, View, Share, ScrollView } from "react-native";
import * as Clipboard from "expo-clipboard";
import { api, type Creds } from "./api";
import { T } from "./theme";
import { annotationLabel, teamLibraryLabel, teamShareInput, type TeamShareMode } from "./sharing-model";
const base = (id: string) => `/api/projects/${encodeURIComponent(id)}/teams-r4`;
const inputStyle = { color: T.text, borderColor: T.line, borderWidth: 1, borderRadius: 8, padding: 10 };
function Button({ label, onPress, disabled }: { label: string; onPress: () => void; disabled?: boolean }) {
  return <TouchableOpacity accessibilityRole="button" disabled={disabled} onPress={onPress} style={{ padding: 10, borderWidth: 1, borderColor: T.line, borderRadius: 8, opacity: disabled ? 0.5 : 1 }}><Text style={{ color: T.text }}>{label}</Text></TouchableOpacity>;
}
function Field({ label, value, onChange, password = false }: { label: string; value: string; onChange: (v: string) => void; password?: boolean }) {
  return <View style={{ gap: 4 }}><Text style={{ color: T.dim }}>{label}</Text><TextInput accessibilityLabel={label} value={value} onChangeText={onChange} secureTextEntry={password} autoCapitalize="none" style={inputStyle} /></View>;
}
export function R4ProjectSharing({ creds, projectId, chat }: { creds: Creds; projectId: string; chat: string }) {
  const [mode, setMode] = useState<TeamShareMode>("changes"), [login, setLogin] = useState(""), [note, setNote] = useState("");
  const [passcode, setPasscode] = useState(""), [notify, setNotify] = useState(false), [preset, setPreset] = useState("1d");
  const [err, setErr] = useState(""), [url, setUrl] = useState(""), [warning, setWarning] = useState(""), [busy, setBusy] = useState(false);
  async function create(){
    setBusy(true); setErr("");
    try {
      const out = await api<{ url: string; warning?: string }>(creds, base(projectId) + "/shares", { method: "POST", body: JSON.stringify(teamShareInput(mode, chat, { login, note, preset, passcode, notifyFirstOpen: notify })) });
      setUrl(out.url); setWarning(out.warning || "");
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }
  return <View style={{ gap: 10 }}><Text style={{ color: T.text, fontWeight: "700" }}>Team sharing</Text>
    {([['changes', 'Share changes'], ['pass', 'Pass chat'], ['review', 'Request review']] as const).map(([m, label]) => <Button key={m} label={`${mode === m ? "✓ " : ""}${label}`} onPress={() => setMode(m)} />)}
    {(mode === "pass" || mode === "review") && <><Field label="Teammate @login" value={login} onChange={setLogin} /><Field label="Hand-off note" value={note} onChange={setNote} /></>}
    <Field label="Passcode (optional)" value={passcode} onChange={setPasscode} password />
    <View style={{ flexDirection: "row", gap: 8 }}>{["1h", "1d", "7d"].map(p => <Button key={p} label={`${preset === p ? "✓ " : ""}${p}`} onPress={() => setPreset(p)} />)}</View>
    <Button label={`${notify ? "✓ " : ""}Notify me on first open`} onPress={() => setNotify(!notify)} />
    <Button label={mode === "pass" ? "Pass" : mode === "review" ? "Request review" : "Create changes link"} disabled={busy} onPress={() => void create()} />
    {!!warning && <Text style={{ color: T.text }}>{warning}</Text>}
    {!!url && <><Text selectable style={{ color: T.text }}>{url}</Text><Button label="Send link" onPress={() => { void Share.share({ message: url }).catch(e => setErr(e.message)); }} /></>}
    {!!err && <Text accessibilityRole="alert" style={{ color: T.err }}>{err}</Text>}
    <R4Library creds={creds} projectId={projectId} />
    <R4ChatAnnotations creds={creds} projectId={projectId} chat={chat} />
  </View>;
}

type Entry = { name: string; source?: string; text?: string; variables?: string[]; options?: Record<string, unknown> };
export function R4Library({ creds, projectId }: { creds: Creds; projectId: string }) {
  const [open, setOpen] = useState(false), [kind, setKind] = useState("templates"), [entries, setEntries] = useState<Entry[]>([]);
  const [chosen, setChosen] = useState<Entry | null>(null), [values, setValues] = useState<Record<string, string>>({}), [err, setErr] = useState(""), [busy, setBusy] = useState(false), [result, setResult] = useState("");
  async function load(k = kind){
    setBusy(true); setErr("");
    try { const r = await api<{ entries: Entry[]; personal: Entry[]; errors: Array<{ name: string; error: string }> }>(creds, base(projectId) + "/library/" + k); setEntries([...r.entries, ...r.personal]); setErr(r.errors.map(e => `${e.name}: ${e.error}`).join("\n")); }
    catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }
  async function act(entry: Entry){
    setBusy(true); setErr(""); setResult("");
    try {
      const route = base(projectId) + "/library/" + kind + "/" + encodeURIComponent(entry.name);
      if (entry.source !== "team") { await api(creds, route + "/publish", { method: "POST", body: "{}" }); await load(); setResult("Published. Commit and push .loom/shared to share it with teammates."); }
      else if (kind === "recipes") { const r = await api<{ run: { id: string } }>(creds, route + "/run", { method: "POST", body: "{}" }); setResult(`Started ${entry.name}: ${r.run.id}`); }
      else { setChosen(entry); setValues({}); }
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }
  return <View style={{ gap: 8 }}><Button label={open ? "Hide Team library" : "Templates and recipes"} onPress={() => { setOpen(!open); if (!open) void load(); }} />
    {open && <><Text style={{ color: T.dim }}>Team entries travel through .loom/shared in git. If .loom is ignored, add the files with git add -f.</Text>
      <View style={{ flexDirection: "row", gap: 8 }}>{["templates", "recipes"].map(k => <Button key={k} label={k} onPress={() => { setKind(k); setChosen(null); void load(k); }} />)}</View>
      {entries.map(e => <Button key={`${e.source}/${e.name}`} disabled={busy} label={`${teamLibraryLabel(e)} · ${e.source !== "team" ? "Publish to repo" : kind === "recipes" ? "Run" : "Use"}`} onPress={() => void act(e)} />)}
      {chosen && <>{(chosen.variables || []).map(v => <Field key={v} label={v} value={values[v] || ""} onChange={text => setValues({ ...values, [v]: text })} />)}<Button disabled={busy} label="Copy rendered template" onPress={() => { setBusy(true); void api<{ text: string }>(creds, base(projectId) + "/library/templates/" + encodeURIComponent(chosen.name) + "/render", { method: "POST", body: JSON.stringify({ values }) }).then(async r => { await Clipboard.setStringAsync(r.text); setResult("Template copied. Paste it into your chat composer."); }).catch(e => setErr(e.message)).finally(() => setBusy(false)); }} /></>}
      {!!result && <Text style={{ color: T.text }}>{result}</Text>}{!!err && <Text accessibilityRole="alert" style={{ color: T.err }}>{err}</Text>}</>}
  </View>;
}

type Annotation = { id: string; shareId: string; name: string; text: string; messageId?: number; verdict?: string; reply?: string };
export function R4ChatAnnotations({ creds, projectId, chat }: { creds: Creds; projectId: string; chat: string }) {
  const [rows, setRows] = useState<Annotation[]>([]), [replyTo, setReplyTo] = useState(""), [reply, setReply] = useState(""), [err, setErr] = useState("");
  useEffect(() => {
    let gone = false, pending = false;
    const load = async () => { if (pending) return; pending = true; try { const r = await api<{ annotations: Annotation[] }>(creds, base(projectId) + "/annotations/" + encodeURIComponent(chat)); if (!gone) setRows(r.annotations); } catch (e) { if (!gone) setErr((e as Error).message); } finally { pending = false; } };
    void load(); const timer = setInterval(() => void load(), 5000);
    return () => { gone = true; clearInterval(timer); };
  }, [creds, projectId, chat]);
  async function moderate(a: Annotation, remove: boolean){
    try { await api(creds, base(projectId) + `/annotations/${a.shareId}/${a.id}`, { method: remove ? "DELETE" : "PUT", ...(remove ? {} : { body: JSON.stringify({ reply }) }) }); setRows(rows => remove ? rows.filter(r => r.id !== a.id) : rows.map(r => r.id === a.id ? { ...r, reply } : r)); setReplyTo(""); setReply(""); }
    catch (e) { setErr((e as Error).message); }
  }
  if (!rows.length && !err) return null;
  return <View style={{ gap: 8 }}><Text style={{ color: T.dim }}>Shared chat annotations · visitors' names are self-reported</Text><ScrollView style={{ maxHeight: 240 }} contentContainerStyle={{ gap: 8 }} keyboardShouldPersistTaps="handled">{rows.map(a => <View key={a.id} style={{ padding: 10, borderColor: T.line, borderWidth: 1, borderRadius: 8, gap: 6 }}>
    <Text style={{ color: T.text, fontWeight: "700" }}>{annotationLabel(a)}</Text><Text style={{ color: T.text }}>{a.text}</Text>{a.reply && <Text style={{ color: T.dim }}>Owner reply: {a.reply}</Text>}
    <View style={{ flexDirection: "row", gap: 8 }}><Button label="Reply" onPress={() => { setReplyTo(a.id); setReply(a.reply || ""); }} /><Button label="Remove" onPress={() => void moderate(a, true)} /></View>
    {replyTo === a.id && <><Field label="Reply to comment" value={reply} onChange={setReply} /><Button label="Save reply" onPress={() => void moderate(a, false)} /></>}
  </View>)}</ScrollView>{!!err && <Text accessibilityRole="alert" style={{ color: T.err }}>{err}</Text>}</View>;
}
export function R4Standup({ creds }: { creds: Creds }) {
  const [projects, setProjects] = useState<Array<{ id: string; name: string }>>([]), [project, setProject] = useState(""), [since, setSince] = useState("1d"), [text, setText] = useState(""), [err, setErr] = useState(""), [busy, setBusy] = useState(false);
  useEffect(() => { let gone = false; void api<{ projects: Array<{ id: string; name: string }> }>(creds, "/api/projects").then(r => { if (!gone) { setProjects(r.projects); setProject(r.projects[0]?.id || ""); } }).catch(e => { if (!gone) setErr(e.message); }); return () => { gone = true; }; }, [creds]);
  async function load(post?: string){
    if (!project) return;
    setBusy(true); setErr("");
    try { const r = await api<{ markdown: string; posted?: string }>(creds, base(project) + "/standup", { method: "POST", body: JSON.stringify({ since, post }) }); setText(r.markdown + (r.posted ? `\nPosted to ${r.posted}` : "")); }
    catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }
  useEffect(() => { void load(); }, [project]);
  return <View style={{ gap: 8, padding: 12, borderColor: T.line, borderWidth: 1, borderRadius: 8 }}><Text style={{ color: T.text, fontSize: 18, fontWeight: "700" }}>Standup</Text>
    {projects.map(p => <Button key={p.id} label={`${project === p.id ? "✓ " : ""}${p.name}`} onPress={() => setProject(p.id)} />)}<Field label="Since (e.g. 1d)" value={since} onChange={setSince} />
    <Button label="Refresh standup" disabled={busy || !project} onPress={() => void load()} />
    <Text selectable style={{ color: T.text }}>{text || "Open a project to build a standup."}</Text>
    <Button label="Post to Slack" disabled={busy || !project} onPress={() => void load("slack")} /><Button label="Post to Discord" disabled={busy || !project} onPress={() => void load("discord")} />
    {!!err && <Text accessibilityRole="alert" style={{ color: T.err }}>{err}</Text>}
  </View>;
}
