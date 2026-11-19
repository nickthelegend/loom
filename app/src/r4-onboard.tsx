import { useEffect, useState } from "react";
import { ScrollView, Text, TextInput, TouchableOpacity, View } from "react-native";
import { api, kv, listMachines, tryDemo, type Creds } from "./api";
import { Sheet } from "./observatory";
import { Markdown } from "./markdown";
import { scopeOf } from "./cache-model";
import { T, spacing } from "./theme";
import { exampleInstallRoute, scenarioLocation, searchGuides, shouldShowRelease, tourPosition, type Example, type Guide, type Readiness, type Release, type Tour } from "./r4-onboard-model";

const post = (body: object = {}) => ({ method: "POST", body: JSON.stringify(body) });
const keyStyle = { minHeight: 44, padding: 12, borderRadius: 10, backgroundColor: T.raised, justifyContent: "center" as const };
function Button({ title, onPress, disabled = false }: { title: string; onPress: () => void; disabled?: boolean }) {
  return <TouchableOpacity accessibilityRole="button" disabled={disabled} onPress={onPress} style={[keyStyle, { opacity: disabled ? 0.5 : 1 }]}><Text style={{ color: T.text, fontWeight: "600" }}>{title}</Text></TouchableOpacity>;
}
const field = { minHeight: 44, color: T.text, backgroundColor: T.raised, padding: 12, borderRadius: 8 };

export function HelpScreen({ creds, onProjectCreated, initialTopic = "" }: { creds: Creds; onProjectCreated: (id: string) => void; initialTopic?: string }) {
  const [guides, setGuides] = useState<Guide[]>([]), [tours, setTours] = useState<Tour[]>([]);
  const [query, setQuery] = useState(""), [topic, setTopic] = useState<string | null>(initialTopic || null);
  const [release, setRelease] = useState<Release | null>(null), [err, setErr] = useState("");
  const [tour, setTour] = useState<Tour | null>(null), [position, setPosition] = useState(0);
  const [progress, setProgress] = useState<Record<string, number>>({});
  const [busy, setBusy] = useState(false);
  useEffect(() => { let live = true; void api<{ guides: Guide[]; tours: Tour[] }>(creds, "/api/help").then(async r => {
    const entries = await Promise.all(r.tours.map(async t => [t.id, tourPosition(await kv.get(`loom-feature-tour-${t.id}`), t.steps.length)] as const));
    if (live) { setGuides(r.guides); setTours(r.tours); setProgress(Object.fromEntries(entries)); }
  }).catch(e => { if (live) setErr(e.message); }); return () => { live = false; }; }, [creds.url, creds.token]);
  useEffect(() => { if (initialTopic) { setTopic(initialTopic); setQuery(""); } }, [initialTopic]);
  function beginTour(next: Tour, restart: boolean) {
    const at = restart || (progress[next.id] ?? 0) >= next.steps.length ? 0 : progress[next.id] ?? 0;
    void kv.set(`loom-feature-tour-${next.id}`, String(at)).then(() => {
      setProgress(p => ({ ...p, [next.id]: at })); setTour(next); setPosition(at);
    }).catch(e => setErr(e.message));
  }
  async function nextTour() {
    if (!tour) return;
    const next = position + 1;
    await kv.set(`loom-feature-tour-${tour.id}`, String(next)); setProgress(p => ({ ...p, [tour.id]: next }));
    if (next >= tour.steps.length) setTour(null); else setPosition(next);
  }
  async function scenario(name: string) {
    setBusy(true); setErr("");
    try { const { project } = await tryDemo(creds); const result = await api<{ chat?: string; run?: { chat: string }; review?: { chat: string } }>(creds, `/api/projects/${encodeURIComponent(project.id)}/demo-scenarios/${name}`, post()); await kv.set("loom.location." + scopeOf(creds.url), JSON.stringify(scenarioLocation(project.id, result))); onProjectCreated(project.id); }
    catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }
  return <View style={{ gap: 12 }}>
    <TextInput accessibilityLabel="Search help" placeholder="Search help" placeholderTextColor={T.dim} value={query} onChangeText={setQuery} style={field} />
    <Button title="What’s new" onPress={() => { void api<Release>(creds, "/api/help/whatsnew").then(setRelease).catch(e => setErr(e.message)); }} />
    {release && <View style={{ gap: 10 }}><Text style={{ color: T.text, fontWeight: "700" }}>Loom {release.version}</Text>{release.highlights.map((h, i) => <View key={i}><Text style={{ color: T.text }}>{h.text}</Text><Button title="Show me" onPress={() => { setTopic(h.topic); setQuery(""); setRelease(null); }} /></View>)}</View>}
    {searchGuides(guides, query).map(g => <View key={g.id}><Button title={g.title} onPress={() => setTopic(topic === g.id ? null : g.id)} />{topic === g.id && <Markdown text={g.body} />}</View>)}
    {!!guides.length && !searchGuides(guides, query).length && <Text style={{ color: T.dim }}>No matching guides.</Text>}
    <Text accessibilityRole="header" style={{ color: T.text, fontWeight: "700" }}>Feature tours</Text>
    {tours.map(t => <View key={t.id} style={{ gap: 6 }}><Button title={`${t.title} · ${(progress[t.id] ?? 0) >= t.steps.length ? "Replay" : progress[t.id] ? "Resume" : "Start"}`} onPress={() => beginTour(t, false)} /><Button title={`Restart ${t.title}`} onPress={() => beginTour(t, true)} /></View>)}
    {tour && <View style={{ padding: 12, gap: 10, borderWidth: 1, borderColor: T.line, borderRadius: 10 }}><Text style={{ color: T.text, fontWeight: "700" }}>{tour.title} · {position + 1}/{tour.steps.length}</Text><Text style={{ color: T.text }}>{tour.steps[position]?.title}</Text><Text style={{ color: T.dim }}>{tour.steps[position]?.body}</Text><Button title={position + 1 === tour.steps.length ? "Finish" : "Next"} onPress={() => { void nextTour().catch(e => setErr(e.message)); }} /><Button title="Close tour" onPress={() => setTour(null)} /></View>}
    <Text accessibilityRole="header" style={{ color: T.text, fontWeight: "700" }}>Offline demo scenarios</Text>
    {["fleet", "review", "memory"].map(s => <Button key={s} title={`Try ${s}`} disabled={busy} onPress={() => { void scenario(s); }} />)}
    {err ? <Text accessibilityRole="alert" style={{ color: T.err }}>{err}</Text> : null}
  </View>;
}

export function HelpEntry(props: { creds: Creds; onProjectCreated: (id: string) => void }) {
  const [open, setOpen] = useState(false), [release, setRelease] = useState<Release | null>(null), [topic, setTopic] = useState("");
  useEffect(() => { let live = true; void api<Release>(props.creds, "/api/help/whatsnew").then(async r => {
    const previous = await kv.get("loom-release-seen");
    const machines = previous ? [] : (await listMachines()).machines;
    const locations = await Promise.all([props.creds.url, ...machines.map(m => m.url)].map(url => kv.get("loom.location." + scopeOf(url))));
    if (!live) return;
    if (shouldShowRelease(previous, r.version, locations.some(location => location !== null))) setRelease(r);
    else if (!previous) await kv.set("loom-release-seen", r.version);
  }).catch(() => {}); return () => { live = false; }; }, [props.creds.url, props.creds.token]);
  const closeRelease = () => { if (release) void kv.set("loom-release-seen", release.version); setRelease(null); };
  return <View style={{ gap: 8 }}>
    <Button title="Help, tours and what’s new" onPress={() => setOpen(true)} />
    <Sheet title="Help" visible={open} onClose={() => setOpen(false)}><HelpScreen creds={props.creds} initialTopic={topic} onProjectCreated={id => { setOpen(false); props.onProjectCreated(id); }} /></Sheet>
    <Sheet title={`What’s new · ${release?.version ?? ""}`} visible={!!release} onClose={closeRelease}>
      <View style={{ gap: 12 }}>{release?.highlights.map((h, i) => <View key={i}><Text style={{ color: T.text }}>{h.text}</Text><Button title="Show me" onPress={() => { setTopic(h.topic); closeRelease(); setOpen(true); }} /></View>)}</View>
    </Sheet>
  </View>;
}

export function ExamplesCard({ creds, projectId }: { creds: Creds; projectId?: string }) {
  const [items, setItems] = useState<Example[]>([]), [message, setMessage] = useState(""), [busy, setBusy] = useState(false);
  const [projects, setProjects] = useState<Array<{ id: string; name: string }>>([]), [selected, setSelected] = useState(projectId ?? "");
  useEffect(() => { let live = true; void api<{ examples: Example[] }>(creds, "/api/help/examples").then(r => { if (live) setItems(r.examples); }).catch(e => { if (live) setMessage(e.message); });
    if (!projectId) void api<{ projects: Array<{ id: string; name: string }> }>(creds, "/api/projects").then(r => { if (live) { setProjects(r.projects); setSelected(r.projects[0]?.id ?? ""); } }).catch(() => {});
    return () => { live = false; };
  }, [creds.url, projectId]);
  return <View style={{ gap: 10 }}><Text style={{ color: T.text, fontWeight: "700" }}>Examples library</Text>
    {!projectId && projects.map(p => <Button key={p.id} title={`${selected === p.id ? "✓ " : ""}${p.name}`} onPress={() => setSelected(p.id)} />)}
    {items.map(e => <View key={e.name} style={{ gap: 6 }}><Text style={{ color: T.text }}>{e.title}</Text><Text style={{ color: T.dim }}>{e.description}</Text><Button title="Install example" disabled={busy} onPress={() => { setBusy(true); setMessage(""); void Promise.resolve().then(() => api<{ installed: boolean }>(creds, exampleInstallRoute(e, selected), post())).then(r => setMessage(`${e.title}: ${r.installed ? "installed" : "already installed"}`)).catch(e => setMessage(e.message)).finally(() => setBusy(false)); }} /></View>)}
    {!!message && <Text accessibilityLiveRegion="polite" style={{ color: T.dim }}>{message}</Text>}
  </View>;
}

export function R4ProjectTools({ creds, projectId, tab, empty, onPrompt }: { creds: Creds; projectId: string; tab: string; empty: boolean; onPrompt: (text: string) => void }) {
  const [ready, setReady] = useState<Readiness | null>(null), [prompts, setPrompts] = useState<Array<{ id: string; text: string }>>([]), [err, setErr] = useState("");
  const [preview, setPreview] = useState(false), [busy, setBusy] = useState(false);
  useEffect(() => { let live = true; setErr(""); setReady(null); setPrompts([]);
    if (tab === "tools") void api<Readiness>(creds, `/api/projects/${encodeURIComponent(projectId)}/ready`).then(r => { if (live) setReady(r); }).catch(e => { if (live) setErr(e.message); });
    if (tab === "thread" && empty) void api<{ prompts: Array<{ id: string; text: string }> }>(creds, `/api/projects/${encodeURIComponent(projectId)}/starter-prompts`).then(r => { if (live) setPrompts(r.prompts); }).catch(() => {});
    return () => { live = false; };
  }, [creds.url, projectId, tab, empty]);
  if (tab === "thread" && empty && prompts.length) return <ScrollView style={{ maxHeight: 180 }} contentContainerStyle={{ padding: spacing.sm, gap: 6 }} horizontal>{prompts.map(p => <View key={p.id} style={{ width: 230 }}><Button title={p.text} onPress={() => onPrompt(p.text)} /></View>)}</ScrollView>;
  if (tab !== "tools") return null;
  return <View style={{ padding: spacing.sm, gap: 6 }}>
    <Button title={ready ? `Project readiness · ${ready.score}/100` : "Project readiness"} onPress={() => setPreview(true)} />
    <Sheet title="Project readiness" visible={preview} onClose={() => setPreview(false)}><View style={{ gap: 12 }}>
      {ready?.checks.map(c => <Text key={c.id} style={{ color: c.ok ? T.ok : T.text }}>{c.ok ? "✓" : "○"} {c.detail}</Text>)}
      {ready?.checks.some(c => c.fix && !c.ok) && <><Text style={{ color: T.dim }}>Preview: draft missing instructions and ignore .loom/.</Text><Text selectable style={{ color: T.text }}>{ready.draft}</Text><Button title="Apply fixes" disabled={busy} onPress={() => { setBusy(true); void api<Readiness>(creds, `/api/projects/${encodeURIComponent(projectId)}/ready`, post({ fix: true })).then(setReady).catch(e => setErr(e.message)).finally(() => setBusy(false)); }} /></>}
      {ready?.applied.map(s => <Text key={s} style={{ color: T.ok }}>{s}</Text>)}
      {!!err && <Text style={{ color: T.err }}>{err}</Text>}
    </View></Sheet>
  </View>;
}
