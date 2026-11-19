import { useEffect, useState } from "react";
import { Share, Switch, Text, TextInput, TouchableOpacity, View, ScrollView } from "react-native";
import { api, type Creds, type OrchestraRun } from "./api";
import { field, TAP } from "./components";
import { T } from "./theme";
import { heldActive, editPlan, type EditableTask } from "./r4-orch-model";

type Run = Omit<OrchestraRun, "tasks"> & { held?: boolean; taskMinutes?: number; tasks: Array<OrchestraRun['tasks'][number] & { timedOutAt?: number; skippedReason?: string }> };
interface Outcome { id: string; status: string; durationMs: number; costUsd: number | null; result: string; files: string[] }
interface Comparison { a: Outcome; b: Outcome; tasks: Array<{ id: string; a: Outcome | null; b: Outcome | null }> }
function Action(p: { title: string; onPress: () => void; disabled?: boolean }) {
  return <TouchableOpacity accessibilityRole="button" disabled={p.disabled} onPress={p.onPress} style={{ minHeight: TAP, justifyContent: 'center', opacity: p.disabled ? 0.5 : 1 }}><Text style={{ color: T.primary }}>{p.title}</Text></TouchableOpacity>;
}
function Input(p: { label: string; value: string; onChangeText: (s: string) => void; multiline?: boolean }) {
  return <View><Text style={{ color: T.dim }}>{p.label}</Text><TextInput {...p} accessibilityLabel={p.label} autoCapitalize="none" style={field} /></View>;
}

export function R4Orchestra(props: { creds: Creds; projectId: string; run: OrchestraRun; onRun: (r: OrchestraRun) => void }) {
  const run = props.run as Run;
  const [text, setText] = useState(''), [agent, setAgent] = useState(''), [after, setAfter] = useState('');
  const [note, setNote] = useState(''), [fleet, setFleet] = useState(''), [onlyFailed, setOnlyFailed] = useState(false);
  const [other, setOther] = useState(''), [comparison, setComparison] = useState<Comparison | null>(null);
  const [minutes, setMinutes] = useState(String(run.taskMinutes ?? 10));
  const [plan, setPlan] = useState<EditableTask[]>([]), [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const base = `/api/projects/${encodeURIComponent(props.projectId)}/orchestra/`;
  useEffect(() => { setEditing(false); setComparison(null); setError(''); }, [run.id]);
  const work = async (fn: () => Promise<void>) => { setBusy(true); setError(''); try { await fn(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } };
  const action = (route: string, body = {}) => work(async () => {
    const r = await api<{ run: OrchestraRun }>(props.creds, base + encodeURIComponent(run.id) + '/' + route, { method: 'POST', body: JSON.stringify(body) });
    props.onRun(r.run); if (route === 'plan' || route === 'approve') setEditing(false);
  });
  const active = !['completed', 'failed', 'aborted', 'moved'].includes(run.status);
  const cell = (o: Outcome | null) => o ? `${o.status} · ${Math.round(o.durationMs / 1000)}s · $${o.costUsd ?? 'unknown'}\n${o.result ?? ''}\n${o.files.join(', ')}` : '—';
  return <View style={{ gap: 8 }}>
    {heldActive(run) ? <Text accessibilityRole="header" style={{ color: T.warn }}>Held · running workers may finish</Text> : null}
    {active ? <>
      <Action title={run.held ? 'Release run' : 'Hold run'} disabled={busy} onPress={() => void action(run.held ? 'release' : 'hold')} />
      <Input label="Add task" value={text} onChangeText={setText} multiline />
      <Input label="Agent@model (optional)" value={agent} onChangeText={setAgent} />
      <Input label="After task ID (optional)" value={after} onChangeText={setAfter} />
      <Action title="Add task" disabled={busy || !text.trim()} onPress={() => void action('tasks', { text, ...(agent ? { agent } : {}), ...(after ? { after } : {}) })} />
      <Input label="Note to all" value={note} onChangeText={setNote} multiline />
      <Action title="Send note to all" disabled={busy || !note.trim()} onPress={() => void action('say', { text: note })} />
    </> : run.status !== 'moved' ? <>
      <Input label="Replacement fleet (optional)" value={fleet} onChangeText={setFleet} />
      <View style={{ flexDirection: 'row', alignItems: 'center' }}><Switch value={onlyFailed} onValueChange={setOnlyFailed} /><Text style={{ color: T.text }}>Only failed tasks</Text></View>
      <Action title="Run again" disabled={busy} onPress={() => void action('rerun', { onlyFailed, ...(fleet ? { workers: fleet.split(',').map(s => s.trim()) } : {}) })} />
    </> : null}
    <Action title="Share run report" disabled={busy} onPress={() => void work(async () => { const r = await api<{ markdown: string }>(props.creds, base + encodeURIComponent(run.id) + '/report'); await Share.share({ message: r.markdown }); })} />
    <Input label="Compare with run ID" value={other} onChangeText={setOther} />
    <Action title="Compare runs" disabled={busy || !other} onPress={() => void work(async () => setComparison(await api<Comparison>(props.creds, base + `compare?a=${encodeURIComponent(run.id)}&b=${encodeURIComponent(other)}`)))} />
    {comparison ? <ScrollView horizontal><View><View style={{ flexDirection: 'row' }}>{[comparison.a, comparison.b].map(o => <Text key={o.id} style={{ color: T.text, width: 250, padding: 8 }}>{o.id}{'\n'}{cell(o)}</Text>)}</View>{comparison.tasks.map(row => <View key={row.id}><Text style={{ color: T.text }}>{row.id}</Text><View style={{ flexDirection: 'row' }}>{[row.a, row.b].map((o, i) => <Text key={i} style={{ color: T.dim, width: 250, padding: 8 }}>{cell(o)}</Text>)}</View></View>)}</View></ScrollView> : null}
    {run.planOnly && !run.planApprovedAt && run.status === 'waiting_human' ? <>
      {!editing ? <View><Text style={{ color: T.text }}>Plan preview</Text>{run.tasks.map(t => <Text selectable key={t.id} style={{ color: T.dim, marginVertical: 6 }}>{t.title}{"\n"}{t.prompt}{"\n"}After: {t.dependsOn.join(', ') || 'none'}</Text>)}<Action title="Approve plan" disabled={busy || !run.tasks.length} onPress={() => void action('approve')} /></View> : null}
      <Action title="Edit plan" disabled={busy} onPress={() => { setPlan(run.tasks.map(t => ({ id: t.id, title: t.title, prompt: t.prompt ?? t.title, agent: t.agent.includes('@') ? t.agent : t.agent + (t.model ? '@' + t.model : '') + (t.effort ? ':' + t.effort : ''), dependsOn: [...t.dependsOn] }))); setEditing(true); }} />
      {editing ? <>{plan.map((task, index) => <View key={task.id} style={{ borderWidth: 1, borderColor: T.line, padding: 8, gap: 6 }}><Text style={{ color: T.text }}>{task.id} · After: {task.dependsOn.join(', ') || 'none'}</Text>
        {(['title', 'prompt', 'agent'] as const).map(key => <Input key={key} label={`${task.id} ${key}`} value={task[key]} multiline={key === 'prompt'} onChangeText={value => setPlan(plan.map((t, i) => i === index ? { ...t, [key]: value } : t))} />)}
        {(['up', 'down', 'remove'] as const).map(op => <Action key={op} title={op === 'remove' ? 'Remove task' : `Move ${op}`} onPress={() => setPlan(editPlan(plan, index, op))} />)}
      </View>)}<Action title="Save plan" disabled={busy || !plan.length} onPress={() => void action('plan', { plan })} /><Action title="Approve edited plan" disabled={busy || !plan.length} onPress={() => void action('approve', { plan })} /></> : null}
    </> : null}
    {active ? run.tasks.filter(t => t.status !== 'done').map(task => <View key={task.id}><Text style={{ color: T.dim }}>{task.id}: {task.title}{task.skippedReason ? ` · Skipped: ${task.skippedReason}` : ''}</Text>
      {!task.skippedReason ? <Action title={`Skip ${task.id}`} disabled={busy} onPress={() => void action(`tasks/${encodeURIComponent(task.id)}/skip`)} /> : null}
      {task.timedOutAt ? <><Input label="Extra task minutes" value={minutes} onChangeText={setMinutes} /><Action title={`Extend ${task.id}`} disabled={busy} onPress={() => void action(`tasks/${encodeURIComponent(task.id)}/extend`, { minutes: Number(minutes) })} /><Input label="Reassign agent@model" value={agent} onChangeText={setAgent} /><Action title={`Reassign ${task.id}`} disabled={busy || !agent} onPress={() => void action(`tasks/${encodeURIComponent(task.id)}/reassign`, { agent })} /></> : null}
    </View>) : null}
    {error ? <Text accessibilityRole="alert" style={{ color: T.err }}>{error}</Text> : null}
  </View>;
}
