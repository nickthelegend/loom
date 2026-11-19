import { useEffect, useState } from "react";
import { Share, Text, TextInput, TouchableOpacity, View } from "react-native";
import { api, type Creds } from "./api";
import { Sheet } from "./observatory";
import { T, radii } from "./theme";
import { costMoney, costBudgetLabel, cacheSavingsLabel } from "./model-routing-model";
import type { FleetRow } from "./orchestra-fleet";

type Props = { creds: Creds; projectId: string; chat?: string };
type Budget = { capUsd: number; spentUsd: number; fraction: number; stopped: boolean; warning: boolean; projectedUsd?: number };
type Snapshot = { monthly: Budget; daily: Budget; chats: Record<string, Budget>; saver: { active: boolean; alias: string } | null; settings: { monthlyUsd: number; dailyUsd: number; alerts: string[]; saver: { alias: string; share: number; period: string } | null } };
const root = (p: Props) => `/api/projects/${encodeURIComponent(p.projectId)}`;
function Button(p: { label: string; run: () => void }) { return <TouchableOpacity accessibilityRole="button" onPress={p.run} style={{ padding: 9, borderWidth: 1, borderColor: T.line, borderRadius: radii.key }}><Text style={{ color: T.text }}>{p.label}</Text></TouchableOpacity>; }
function Field(p: { label: string; value: string; set: (s: string) => void }) { return <View><Text style={{ color: T.dim }}>{p.label}</Text><TextInput accessibilityLabel={p.label} value={p.value} onChangeText={p.set} autoCapitalize="none" autoCorrect={false} style={{ color: T.text, padding: 8, borderWidth: 1, borderColor: T.line, borderRadius: radii.key }} /></View>; }
export function CostProgress({ budget }: { budget: Budget }) { return <View style={{ gap: 5 }}><Text style={{ color: budget.warning ? T.warn : T.dim }}>{costBudgetLabel(budget)}</Text>{budget.capUsd > 0 && <View accessibilityRole="progressbar" accessibilityValue={{ min: 0, max: 100, now: Math.min(100, Math.round(budget.fraction * 100)) }} style={{ height: 8, backgroundColor: T.raised, borderRadius: 4 }}><View style={{ height: 8, width: `${Math.max(0, Math.min(100, budget.fraction * 100))}%`, backgroundColor: budget.warning ? T.warn : T.primary, borderRadius: 4 }} /></View>}</View>; }

export function R4CostMenu(props: Props) {
  const [open, setOpen] = useState(false), [snapshot, setSnapshot] = useState<Snapshot | null>(null), [status, setStatus] = useState("");
  const [cap, setCap] = useState("0"), [month, setMonth] = useState("0"), [daily, setDaily] = useState("0");
  const [alerts, setAlerts] = useState(""), [alias, setAlias] = useState(""), [share, setShare] = useState("0.8"), [period, setPeriod] = useState("month");
  const [model, setModel] = useState(""), [what, setWhat] = useState("");
  const chat = props.chat ?? "main";
  const seedForm = (s: Snapshot) => {
    setCap(String(s.chats[chat]?.capUsd ?? 0)); setMonth(String(s.settings.monthlyUsd)); setDaily(String(s.settings.dailyUsd)); setAlerts(s.settings.alerts.join(","));
    setAlias(s.settings.saver?.alias ?? ""); setShare(String(s.settings.saver?.share ?? 0.8)); setPeriod(s.settings.saver?.period ?? "month");
  };
  const refresh = async () => {
    const s = await api<Snapshot>(props.creds, root(props) + "/costs/settings");
    setSnapshot(s); seedForm(s);
  };
  useEffect(() => {
    let live = true;
    const read = async (seed: boolean) => {
      try {
        const s = await api<Snapshot>(props.creds, root(props) + "/costs/settings");
        if (!live) return;
        setSnapshot(s);
        if (seed) seedForm(s);
      } catch (e) { if (live) setStatus((e as Error).message); }
    };
    void read(open);
    const timer = setInterval(() => { void read(false); }, 15000);
    return () => { live = false; clearInterval(timer); };
  }, [props.creds, props.projectId, chat, open]);
  const run = (f: () => Promise<unknown>) => { void f().then(() => setStatus("Saved")).catch(e => setStatus(e.message)); };
  const stopped = snapshot?.chats[chat]?.stopped || snapshot?.monthly.stopped || snapshot?.daily.stopped;
  return <View>
    <Button label={stopped ? "Needs you · Raise budget" : "Chat budget & costs"} run={() => setOpen(true)} />
    {!!what && <Text style={{ color: T.dim }}>On another model: {what}</Text>}
    {snapshot?.saver?.active && <Text style={{ color: T.warn }}>Saver · {snapshot.saver.alias} · explicit picks take priority</Text>}
    <Sheet title="Chat budget & costs" visible={open} onClose={() => setOpen(false)}>
      <View style={{ gap: 9 }}>
        {stopped && <Text accessibilityRole="alert" style={{ color: T.warn }}>This budget is reached. Raise the cap to continue.</Text>}
        <Field label="Chat budget USD (0 clears)" value={cap} set={setCap} />
        <Button label="Raise / save chat budget" run={() => run(async () => { await api(props.creds, root(props) + `/chats/${encodeURIComponent(chat)}/budget`, { method: "PUT", body: JSON.stringify({ usd: Number(cap) }) }); await refresh(); })} />
        <Field label="On another model" value={model} set={setModel} />
        <Button label="Re-price recorded tokens" run={() => { void api<{ estimatedUsd: number | null; actualUsd: number }>(props.creds, root(props) + "/costs/whatif?" + new URLSearchParams({ model, chat })).then(w => setWhat(`${costMoney(w.estimatedUsd)} estimated · ${costMoney(w.actualUsd)} recorded`)).catch(e => setStatus(e.message)); }} />
        <Text style={{ color: T.dim }}>{what}</Text>
        {snapshot && <CostProgress budget={snapshot.monthly} />}
        <Field label="Monthly budget USD (0 clears)" value={month} set={setMonth} /><Field label="Daily budget USD (0 clears)" value={daily} set={setDaily} />
        <Field label="Alert channels: slack,discord,email,push" value={alerts} set={setAlerts} />
        <Field label="Saver alias (blank disables)" value={alias} set={setAlias} /><Field label="Saver share (0–1)" value={share} set={setShare} /><Field label="Saver period: day or month" value={period} set={setPeriod} />
        <Button label="Save spend controls" run={() => run(async () => { await api(props.creds, root(props) + "/costs/settings", { method: "PUT", body: JSON.stringify({ monthlyUsd: Number(month), dailyUsd: Number(daily), alerts: alerts.split(",").map(v => v.trim()).filter(Boolean), saver: alias ? { alias, share: Number(share), period } : null }) }); await refresh(); })} />
        <R4Usage {...props} />
        <Text accessibilityLiveRegion="polite" style={{ color: T.dim }}>{status}</Text>
      </View>
    </Sheet>
  </View>;
}
export function R4Usage(props: Props) {
  const [data, setData] = useState<{ rows: Array<{ model: string; cachedIn: number; tokensIn: number; cacheSavedUsd: number | null }> } | null>(null), [budget, setBudget] = useState<Budget | null>(null);
  const [status, setStatus] = useState(""), [by, setBy] = useState("model"), [since, setSince] = useState("");
  useEffect(() => {
    let live = true;
    const load = () => void Promise.all([api<Snapshot>(props.creds, root(props) + "/costs/settings"), api<NonNullable<typeof data>>(props.creds, root(props) + "/costs/export?by=model")]).then(([s, r]) => { if (live) { setBudget(s.monthly); setData(r); } }).catch(e => { if (live) setStatus(e.message); });
    load(); const timer = setInterval(load, 20000); return () => { live = false; clearInterval(timer); };
  }, [props.creds, props.projectId]);
  return <View style={{ gap: 8 }}>{budget && <CostProgress budget={budget} />}<Text style={{ color: T.text }}>Cache savings</Text>{data?.rows.map(r => <View key={r.model}><Text style={{ color: T.dim }}>{r.model} · {cacheSavingsLabel(r)}</Text><View style={{ height: 5, backgroundColor: T.raised }}><View style={{ height: 5, backgroundColor: T.primary, width: `${r.tokensIn ? Math.min(100, r.cachedIn / r.tokensIn * 100) : 0}%` }} /></View></View>)}
    <Field label="Export by: agent, model, chat or day" value={by} set={setBy} /><Field label="Since date (optional YYYY-MM-DD)" value={since} set={setSince} />
    <Button label="Share cost CSV" run={() => { void api<{ csv: string }>(props.creds, root(props) + "/costs/export?" + new URLSearchParams({ by, since, format: "csv-json" })).then(r => Share.share({ title: "Loom costs", message: r.csv })).catch(e => setStatus(e.message)); }} /><Text style={{ color: T.dim }}>{status}</Text>
  </View>;
}
export function R4FleetSuggest(props: { creds: Creds; onUse?: (rows: FleetRow[]) => void }) {
  const [goal, setGoal] = useState(""), [budget, setBudget] = useState(""), [size, setSize] = useState("3"), [status, setStatus] = useState("");
  const [picks, setPicks] = useState<Array<{ kind: string; model: string; reason: string }>>([]);
  return <View style={{ gap: 8 }}><Field label="Fleet goal" value={goal} set={setGoal} /><Field label="Fleet budget USD (optional)" value={budget} set={setBudget} /><Field label="Fleet size" value={size} set={setSize} />
    <Button label="Suggest" run={() => { void api<{ picks: typeof picks; note: string }>(props.creds, "/api/fleets/suggest", { method: "POST", body: JSON.stringify({ goal, size: Number(size), ...(budget ? { budget: Number(budget) } : {}) }) }).then(r => { setPicks(r.picks); setStatus(r.note); }).catch(e => setStatus(e.message)); }} />
    {picks.map((p, i) => <Text key={i} style={{ color: T.dim }}>{p.kind}@{p.model} · {p.reason}</Text>)}
    {!!picks.length && props.onUse && <Button label="Use suggested fleet" run={() => props.onUse!(picks.map(p => ({ agent: p.kind, model: p.model, count: 1 })))} />}<Text style={{ color: T.dim }}>{status}</Text>
  </View>;
}

export function R4SaverChip(props: Props) {
  const [alias, setAlias] = useState("");
  useEffect(() => {
    let live = true;
    const load = () => void api<{ saver?: { alias: string } }>(props.creds, root(props) + "/estimate", { method: "POST", body: JSON.stringify({ text: "", chat: props.chat ?? "main" }) }).then(s => { if (live) setAlias(s.saver?.alias ?? ""); }).catch(() => { if (live) setAlias(""); });
    load(); const timer = setInterval(load, 10000); return () => { live = false; clearInterval(timer); };
  }, [props.creds, props.projectId, props.chat]);
  return alias ? <Text style={{ color: T.warn, backgroundColor: T.raised, padding: 5, borderRadius: radii.pill, alignSelf: "flex-start" }}>Saver · {alias} · explicit picks take priority</Text> : null;
}
