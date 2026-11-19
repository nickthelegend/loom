import { R4ProjectSharing } from "./r4-teams";
import { useEffect, useState } from "react";
import { ScrollView, Share, Text, TextInput, TouchableOpacity, View } from "react-native";
import * as Clipboard from "expo-clipboard";
import * as FileSystem from "expo-file-system";
import { api, type Creds } from "./api";
import { T, spacing } from "./theme";
import { expiryPresets, shareCountdown, mentionQuery, insertMention, shareOpenLabel } from "./sharing-model";

type Link = { views?: number; lastOpenedAt?: number; passcodeProtected?: boolean; id: string; url?: string; title?: string; expiresAt: number };
type Fleet = { name: string; spec: string };
type Roles = { mode: "everyone" | "selected"; approvers: string[]; canApprove: boolean; devices: Array<{ id: string; name: string; owner: boolean }> };
function Action({ label, onPress, disabled = false }: { label: string; onPress: () => void; disabled?: boolean }) {
  return <TouchableOpacity accessibilityRole="button" disabled={disabled} onPress={onPress} style={{ padding: 12, borderWidth: 1, borderColor: T.line, borderRadius: 8, opacity: disabled ? 0.5 : 1 }}><Text style={{ color: T.text }}>{label}</Text></TouchableOpacity>;
}
const inputStyle = { color: T.text, padding: 12, borderWidth: 1, borderColor: T.line, borderRadius: 8 };
function useClock() {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);
  return now;
}
async function exportAudit(creds: Creds) {
  const { csv } = await api<{ csv: string }>(creds, "/api/audit.csv?format=json&since=0");
  const uri = `${FileSystem.cacheDirectory}loom-audit.csv`;
  await FileSystem.writeAsStringAsync(uri, csv);
  await Share.share({ title: "Loom audit CSV", url: uri, message: csv });
}

export function ProjectSharing({ creds, projectId, chat }: { creds: Creds; projectId: string; chat: string }) {
  const [passcode, setPasscode] = useState(""), [notifyFirstOpen, setNotifyFirstOpen] = useState(false);
  const [preset, setPreset] = useState("1d"), [link, setLink] = useState<Link | null>(null);
  const [links, setLinks] = useState<Link[]>([]), [runs, setRuns] = useState<Array<{ id: string; goal: string }>>([]);
  const [roles, setRoles] = useState<Roles | null>(null), [err, setErr] = useState(""), [busy, setBusy] = useState(false);
  const now = useClock(), base = `/api/projects/${encodeURIComponent(projectId)}`;
  const loadLinks = async () => setLinks((await api<{ shares: Link[] }>(creds, base + "/shares")).shares);
  useEffect(() => {
    let gone = false;
    void Promise.all([api<{ shares: Link[] }>(creds, base + "/shares"), api<{ runs: Array<{ id: string; goal: string }> }>(creds, base + "/orchestra"), api<Roles>(creds, base + "/approval-roles")])
      .then(([s, r, a]) => { if (!gone) { setLinks(s.shares); setRuns(r.runs); setRoles(a); } }).catch(e => { if (!gone) setErr(e.message); });
    return () => { gone = true; };
  }, [creds, projectId]);
  const act = async (fn: () => Promise<unknown>) => { setBusy(true); setErr(""); try { await fn(); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); } };
  const create = (path: string) => void act(async () => {
    setLink(await api<Link>(creds, base + "/teams-r4/shares", { method: "POST", body: JSON.stringify({ preset, passcode, notifyFirstOpen, chat, ...(path.startsWith("/orchestra/") ? { run: decodeURIComponent(path.slice(11)) } : {}) }) })); await loadLinks();
  });
  return <ScrollView contentContainerStyle={{ padding: spacing.md, gap: 12 }}>
    <Text style={{ color: T.text, fontWeight: "700", fontSize: 18 }}>Read-only sharing</Text>
    <View style={{ flexDirection: "row", gap: 8 }}>{expiryPresets.map(p => <Action key={p.value} label={`${preset === p.value ? "✓ " : ""}${p.label}`} onPress={() => setPreset(p.value)} />)}</View>
    <TextInput accessibilityLabel="Passcode (optional)" placeholder="Passcode (optional)" placeholderTextColor={T.faint} style={inputStyle} secureTextEntry value={passcode} onChangeText={setPasscode} />
    <Action label={`${notifyFirstOpen ? "✓ " : ""}Notify on first open`} onPress={() => setNotifyFirstOpen(!notifyFirstOpen)} />
    <R4ProjectSharing creds={creds} projectId={projectId} chat={chat} />
    <Action label="Share this chat" disabled={busy} onPress={() => create(`/chats/${encodeURIComponent(chat)}`)} />
    {runs.map(r => <Action key={r.id} disabled={busy} label={`Share run: ${r.goal}`} onPress={() => create(`/orchestra/${encodeURIComponent(r.id)}`)} />)}
    {link?.url && <View style={{ gap: 8 }}><Text selectable style={{ color: T.text }}>{link.url}</Text><Text accessibilityRole="timer" style={{ color: T.dim }}>{shareCountdown(link.expiresAt, now)}</Text>
      <Action label="Copy link" onPress={() => void act(() => Clipboard.setStringAsync(link.url!))} /><Action label="Send link" onPress={() => void act(() => Share.share({ message: link.url! }))} /></View>}
    {links.map(s => <View key={s.id} style={{ gap: 6 }}><Text style={{ color: T.dim }}>{s.title} · {shareCountdown(s.expiresAt, now)} · {shareOpenLabel(s)}</Text><Action label="Revoke link" disabled={busy} onPress={() => void act(async () => { await api(creds, base + `/shares/${s.id}`, { method: "DELETE" }); if (link?.id === s.id) setLink(null); await loadLinks(); })} /></View>)}
    {roles && <View style={{ gap: 8 }}><Text style={{ color: T.text, fontWeight: "700" }}>Who may approve tool calls</Text><Text style={{ color: T.dim }}>Owner devices always may approve.</Text>
      <Action label={roles.mode === "everyone" ? "Everyone with existing approval access ✓" : "Selected approvers ✓"} onPress={() => setRoles({ ...roles, mode: roles.mode === "everyone" ? "selected" : "everyone" })} />
      {roles.mode === "selected" && roles.devices.map(d => <Action key={d.id} disabled={d.owner} label={`${d.owner || roles.approvers.includes(d.id) ? "✓ " : ""}${d.name}${d.owner ? " · owner device" : ""}`} onPress={() => setRoles({ ...roles, approvers: roles.approvers.includes(d.id) ? roles.approvers.filter(id => id !== d.id) : [...roles.approvers, d.id] })} />)}
      <Action label="Save approval roles" disabled={busy || !roles.canApprove} onPress={() => void act(async () => { await api(creds, base + "/approval-roles", { method: "PUT", body: JSON.stringify({ mode: roles.mode, approvers: roles.approvers }) }); setRoles(await api<Roles>(creds, base + "/approval-roles")); })} /></View>}
    <Action label="Export audit CSV" disabled={busy} onPress={() => void act(() => exportAudit(creds))} />
    {!!err && <Text accessibilityRole="alert" style={{ color: T.err }}>{err}</Text>}
  </ScrollView>;
}

export function TeamSharing({ creds, teamId }: { creds: Creds; teamId: string }) {
  const [open, setOpen] = useState(false), [fleets, setFleets] = useState<Fleet[]>([]), [invites, setInvites] = useState<Link[]>([]);
  const [name, setName] = useState(""), [spec, setSpec] = useState(""), [err, setErr] = useState(""), [busy, setBusy] = useState(false);
  const now = useClock(), q = `?teamId=${encodeURIComponent(teamId)}`;
  const load = async () => {
    const f = await api<{ fleets: Fleet[] }>(creds, "/api/team/fleets" + q); setFleets(f.fleets);
    const i = await api<{ invites: Link[] }>(creds, "/api/team/invites" + q); setInvites(i.invites);
  };
  const act = async (fn: () => Promise<unknown>) => { setBusy(true); setErr(""); try { await fn(); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); } };
  return <View style={{ gap: 10 }}><Action label={open ? "Hide fleets and invites" : "Team fleets and invites"} onPress={() => { setOpen(!open); if (!open) void act(load); }} />
    {open && <><Text style={{ color: T.text, fontWeight: "700" }}>Shared fleets</Text>
      {!fleets.length && <Text style={{ color: T.dim }}>No shared fleets yet.</Text>}
      {fleets.map(f => <View key={f.name} style={{ gap: 6 }}><Text style={{ color: T.text }}>{f.name}: {f.spec}</Text>
        <Action label={`Save @${f.name} locally`} disabled={busy} onPress={() => void act(() => api(creds, "/api/fleets", { method: "PUT", body: JSON.stringify(f) }))} />
        <Action label="Unshare fleet" disabled={busy} onPress={() => void act(async () => { await api(creds, `/api/team/fleets/${encodeURIComponent(f.name)}` + q, { method: "DELETE" }); await load(); })} /></View>)}
      <TextInput accessibilityLabel="Shared fleet name" placeholder="Fleet name" placeholderTextColor={T.faint} style={inputStyle} autoCapitalize="none" value={name} onChangeText={setName} />
      <TextInput accessibilityLabel="Shared fleet agent specs" placeholder="agent@modelx2,agent" placeholderTextColor={T.faint} style={inputStyle} autoCapitalize="none" value={spec} onChangeText={setSpec} />
      <Action label="Share fleet" disabled={busy} onPress={() => void act(async () => { await api(creds, "/api/team/fleets", { method: "PUT", body: JSON.stringify({ teamId, name, spec }) }); await load(); })} />
      <Text style={{ color: T.text, fontWeight: "700" }}>Active invites</Text>
      {!invites.length && <Text style={{ color: T.dim }}>No active invites.</Text>}
      {invites.map(i => <View key={i.id} style={{ gap: 6 }}><Text style={{ color: T.dim }}>{i.id.slice(0, 10)} · {shareCountdown(i.expiresAt, now)}</Text><Action label="Revoke invite" disabled={busy} onPress={() => void act(async () => { await api(creds, `/api/team/invites/${i.id}` + q, { method: "DELETE" }); await load(); })} /></View>)}
      <Action label="Export audit CSV" disabled={busy} onPress={() => void act(() => exportAudit(creds))} />
      {!!err && <Text accessibilityRole="alert" style={{ color: T.err }}>{err}</Text>}
    </>}
  </View>;
}

export function TeammateMentions({ creds, projectId, text, onChange }: { creds: Creds; projectId: string; text: string; onChange: (text: string) => void }) {
  const [people, setPeople] = useState<Array<{ github: string; name: string }>>([]);
  const query = mentionQuery(text);
  useEffect(() => {
    if (query === null) return;
    let gone = false;
    void api<{ teammates: Array<{ github: string; name: string }> }>(creds, `/api/projects/${encodeURIComponent(projectId)}/teammates`)
      .then(r => { if (!gone) setPeople(r.teammates); }).catch(() => { if (!gone) setPeople([]); });
    return () => { gone = true; };
  }, [creds, projectId, query !== null]);
  if (query === null) return null;
  return <View style={{ gap: 6 }}>{people.filter(p => p.github.toLowerCase().includes(query)).slice(0, 5).map(p =>
    <Action key={p.github} label={`@${p.github} · notify teammate`} onPress={() => onChange(insertMention(text, p.github))} />)}</View>;
}
