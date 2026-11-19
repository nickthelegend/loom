import { useCallback, useEffect, useState } from "react";
import { Text, TextInput, TouchableOpacity, View, Switch, Share } from "react-native";
import { api, type Creds, type Memory } from "./api";
import { feedbackBody, interviewAnswers, memoryLabels, memoryPaths, type KnowledgeMemory } from "./memory-model";
import { T, radii } from "./theme";

interface Props { creds: Creds; projectId: string; onChanged: () => void }
function Button({ label, onPress, disabled }: { label: string; onPress: () => void; disabled?: boolean }) {
  return <TouchableOpacity accessibilityRole="button" onPress={onPress} disabled={disabled} style={{ padding: 9, borderWidth: 1, borderColor: T.line, borderRadius: radii.key, opacity: disabled ? 0.5 : 1 }}><Text style={{ color: T.text }}>{label}</Text></TouchableOpacity>;
}
function Input({ value, onChange, label }: { value: string; onChange: (value: string) => void; label: string }) {
  return <View><Text style={{ color: T.dim }}>{label}</Text><TextInput accessibilityLabel={label} value={value} onChangeText={onChange} placeholder={label} placeholderTextColor={T.faint} autoCapitalize="none" multiline style={{ padding: 9, color: T.text, backgroundColor: T.raised, borderRadius: radii.key }} /></View>;
}
function base(projectId: string) { return `/api/projects/${encodeURIComponent(projectId)}/brain`; }

export function MemoryKnowledgeFields({ creds, projectId, memory, onChanged }: Props & { memory: Memory & KnowledgeMemory }) {
  const [tags, setTags] = useState((memory.tags ?? []).join(", "));
  const [paths, setPaths] = useState((memory.paths ?? []).join(", "));
  const [error, setError] = useState("");
  useEffect(() => { setTags((memory.tags ?? []).join(", ")); setPaths((memory.paths ?? []).join(", ")); }, [memory.tags, memory.paths]);
  if (memory.source) return <Text style={{ color: T.dim }}>Read-only source: {memory.source.file}:{memory.source.line}. Edit the document and refresh its source.</Text>;
  return <View style={{ gap: 8 }}>
    {memory.pack ? <Text style={{ color: T.dim }}>Pack: {memory.pack}</Text> : null}
    <Input label="Tags (comma-separated)" value={tags} onChange={setTags} />
    <Input label="Path globs (blank means all files)" value={paths} onChange={setPaths} />
    <Button label="Save tags and paths" onPress={() => { void (async () => {
      try { await api(creds, base(projectId) + '/' + encodeURIComponent(memory.id), { method: 'PATCH', body: JSON.stringify({ tags: memoryLabels(tags), paths: memoryPaths(paths) }) }); setError(""); onChanged(); }
      catch (e) { setError(String(e)); }
    })(); }} />
    {error ? <Text style={{ color: T.err }}>{error}</Text> : null}
  </View>;
}

export function MemoryFeedback({ creds, projectId, memory, injection, onChanged }: Props & { memory: { id: string } & KnowledgeMemory; injection: number }) {
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  if (memory.source) return <Text style={{ color: T.dim }}>Source: {memory.source.file}:{memory.source.line} · edit the document to correct it.</Text>;
  return <View style={{ gap: 6 }}>
    <View style={{ flexDirection: "row", gap: 8 }}>
      {(["helpful", "wrong"] as const).map(value => <Button key={value} label={value === "helpful" ? "Helpful" : "Wrong · review"} onPress={() => void (async () => {
        try { await api(creds, base(projectId) + '/' + encodeURIComponent(memory.id) + '/feedback', { method: 'POST', body: JSON.stringify(feedbackBody(value, injection)) }); setNotice(value === "wrong" ? "Held for review" : "Feedback saved"); setError(""); onChanged(); }
        catch (e) { setError(String(e)); }
      })()} />)}
    </View>
    {notice ? <Text style={{ color: T.dim }}>{notice}</Text> : null}{error ? <Text style={{ color: T.err }}>{error}</Text> : null}
  </View>;
}
interface Proposal { id: string; input: { text: string; untrusted?: boolean }; reason?: string }
interface Citation { id: string; text: string; source?: { file: string; line: number } }
interface Change { eventId: number; action: string; text: string; id: string }
interface Pack { name: string; installed: number; saved?: object }
interface Source { pattern: string; chunks: number }

export function BrainKnowledge({ creds, projectId, onChanged, revision }: Props & { revision?: unknown }) {
  const [question, setQuestion] = useState("");
  const [helper, setHelper] = useState(false);
  const [answer, setAnswer] = useState<{ answer: string; citations: Citation[] } | null>(null);
  const [review, setReview] = useState(false);
  const [inbox, setInbox] = useState<Proposal[]>([]);
  const [editing, setEditing] = useState<Proposal | null>(null);
  const [edited, setEdited] = useState("");
  const [changes, setChanges] = useState<Change[]>([]);
  const [since, setSince] = useState("7d");
  const [tests, setTests] = useState("");
  const [conventions, setConventions] = useState("");
  const [avoid, setAvoid] = useState("");
  const [packs, setPacks] = useState<Pack[]>([]);
  const [pack, setPack] = useState("");
  const [tag, setTag] = useState("");
  const [install, setInstall] = useState("");
  const [pattern, setPattern] = useState("docs/**/*.md");
  const [sources, setSources] = useState<Source[]>([]);
  const [section, setSection] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const url = base(projectId);
  const refresh = useCallback(async () => {
    const [settings, pending, changed, saved, documents] = await Promise.all([
      api<{ reviewBeforeSaving: boolean }>(creds, url + '/settings'), api<{ proposals: Proposal[] }>(creds, url + '/inbox'),
      api<{ changes: Change[] }>(creds, url + '/changes?since=' + encodeURIComponent(since)), api<{ packs: Pack[] }>(creds, url + '/packs'), api<{ sources: Source[] }>(creds, url + '/sources'),
    ]);
    setReview(settings.reviewBeforeSaving); setInbox(pending.proposals); setChanges(changed.changes); setPacks(saved.packs); setSources(documents.sources);
  }, [creds, url, since]);
  useEffect(() => { void refresh().catch(e => setError(String(e))); }, [refresh, revision]);
  const run = async (fn: () => Promise<unknown>, changed = false) => {
    if (busy) return; setBusy(true);
    try { await fn(); setError(""); if (changed) { await refresh(); onChanged(); } }
    catch (e) { setError(String(e)); } finally { setBusy(false); }
  };
  const post = <T,>(route: string, body: object, method = 'POST') => api<T>(creds, url + route, { method, body: JSON.stringify(body) });
  return <View style={{ gap: 10 }}>
    <Input label="Ask the brain" value={question} onChange={setQuestion} />
    <View style={{ flexDirection: 'row', alignItems: 'center' }}><Text style={{ color: T.dim }}>Use helper model (optional)</Text><Switch accessibilityLabel="Use helper model" value={helper} onValueChange={setHelper} /></View>
    <Button label="Ask" disabled={busy || !question.trim()} onPress={() => void run(async () => setAnswer(await post('/ask', { question, helper })))} />
    {answer ? <View style={{ gap: 8 }}><Text selectable style={{ color: T.text }}>{answer.answer}</Text>{answer.citations.map(c => <Text key={c.id} selectable style={{ color: T.dim }}>[{c.id}] {c.source ? `${c.source.file}:${c.source.line} · ` : ''}{c.text}</Text>)}</View> : null}
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>{[['inbox', `Inbox (${inbox.length})`], ['changes', 'What changed'], ['teach', 'Teach the brain'], ['packs', 'Brain packs'], ['sources', 'Docs as knowledge']].map(([key, label]) => <Button key={key} label={label} onPress={() => { setSection(section === key ? '' : key); void refresh().catch(e => setError(String(e))); }} />)}</View>
    {section === 'inbox' ? <View style={{ gap: 8 }}>
      <Text style={{ color: T.dim }}>Review extracted memories before saving</Text><Switch accessibilityLabel="Review before saving" value={review} onValueChange={value => void run(() => post('/settings', { reviewBeforeSaving: value }, 'PATCH'), true)} />
      {!inbox.length ? <Text style={{ color: T.dim }}>No proposals waiting for review.</Text> : null}
      {inbox.map(p => <View key={p.id} style={{ gap: 6 }}><Text style={{ color: T.text }}>{p.input.text}</Text><Text style={{ color: T.dim }}>{p.reason}{p.input.untrusted ? ' · Outside content · untrusted' : ''}</Text><View style={{ flexDirection: 'row', gap: 6 }}>
        <Button label="Approve" onPress={() => void run(() => post('/inbox/' + encodeURIComponent(p.id), { action: 'approve' }), true)} />
        <Button label="Edit" onPress={() => { setEditing(p); setEdited(p.input.text); }} />
        <Button label="Reject" onPress={() => void run(() => post('/inbox/' + encodeURIComponent(p.id), { action: 'reject' }), true)} />
      </View></View>)}
      {editing ? <><Input label="Edited proposal" value={edited} onChange={setEdited} /><Button label="Save proposal for review" onPress={() => void run(async () => { await post('/inbox/' + encodeURIComponent(editing.id), { action: 'edit', text: edited }); setEditing(null); }, true)} /></> : null}
    </View> : null}
    {section === 'changes' ? <><Input label="Since (7d or ISO date)" value={since} onChange={setSince} />{changes.slice(-30).reverse().map(c => <Text key={c.eventId} style={{ color: T.text }}>{c.action} · {c.text} [{c.id}]</Text>)}{!changes.length ? <Text style={{ color: T.dim }}>No changes in this period.</Text> : null}</> : null}
    {section === 'teach' ? <><Input label="How do you run tests?" value={tests} onChange={setTests} /><Input label="What conventions should agents follow?" value={conventions} onChange={setConventions} /><Input label="Which areas should agents leave alone?" value={avoid} onChange={setAvoid} /><Button label="Save answers" onPress={() => void run(async () => { await post('/teach', interviewAnswers(tests, conventions, avoid)); setNotice('Interview answers saved'); }, true)} /></> : null}
    {section === 'packs' ? <><Input label="Pack name" value={pack} onChange={setPack} /><Input label="Only tag (optional)" value={tag} onChange={setTag} /><Button label="Save pack" onPress={() => void run(() => post('/packs', { name: pack, ...(tag.trim() ? { tag: tag.trim() } : {}) }), true)} /><Input label="Public pack URL or JSON" value={install} onChange={setInstall} /><Button label="Install pack" onPress={() => void run(() => post('/packs/install', /^https?:\/\//i.test(install.trim()) ? { url: install.trim() } : { pack: JSON.parse(install) }), true)} />{packs.map(p => <View key={p.name} style={{ gap: 6 }}><Text style={{ color: T.text }}>{p.name} · {p.installed} installed</Text>{p.saved ? <Button label="Share saved pack" onPress={() => void run(() => Share.share({ message: JSON.stringify(p.saved, null, 2) }))} /> : null}<Button label="Remove pack" onPress={() => void run(() => post('/packs/' + encodeURIComponent(p.name), {}, 'DELETE'), true)} /></View>)}</> : null}
    {section === 'sources' ? <><Input label="Repo document glob" value={pattern} onChange={setPattern} /><Button label="Index documents" onPress={() => void run(() => post('/sources', { action: 'add', pattern }), true)} />{sources.map(s => <View key={s.pattern} style={{ gap: 6 }}><Text style={{ color: T.text }}>{s.pattern} · {s.chunks} read-only chunks</Text>{['refresh', 'rm'].map(action => <Button key={action} label={action === 'rm' ? 'Remove source' : 'Refresh source'} onPress={() => void run(() => post('/sources', { action, pattern: s.pattern }), true)} />)}</View>)}</> : null}
    {notice ? <Text style={{ color: T.dim }}>{notice}</Text> : null}{error ? <Text style={{ color: T.err }}>{error}</Text> : null}
  </View>;
}
