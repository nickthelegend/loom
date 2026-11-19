import { useEffect, useState } from "react";
import { ScrollView, Switch, Text, TextInput, TouchableOpacity, View } from "react-native";
import * as Clipboard from "expo-clipboard";
import { api, type Creds, type OrchestraRun, type OrchestraRecipe } from "./api";
import { field, TAP } from "./components";
import { T } from "./theme";

function Action(props: { title: string; disabled?: boolean; onPress: () => void }) {
  return <TouchableOpacity accessibilityRole="button" disabled={props.disabled} onPress={props.onPress} style={{ minHeight: TAP, justifyContent: "center", opacity: props.disabled ? 0.5 : 1 }}><Text style={{ color: T.primary }}>{props.title}</Text></TouchableOpacity>;
}

export function OrchestraRecipes(props: { creds: Creds; projectId: string; onRun: (run: OrchestraRun) => void }) {
  const [recipes, setRecipes] = useState<OrchestraRecipe[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    void api<{ recipes: OrchestraRecipe[] }>(props.creds, "/api/orchestra-recipes").then(r => { if (live) setRecipes(r.recipes); }).catch(() => {});
    return () => { live = false; };
  }, [props.creds]);
  return <View>{recipes.map(recipe => <Action key={recipe.name} title={`Run ${recipe.name}`} disabled={busy} onPress={() => {
    setBusy(true); setError("");
    void api<{ run: OrchestraRun }>(props.creds, `/api/projects/${props.projectId}/orchestra-recipes/${encodeURIComponent(recipe.name)}/run`, { method: "POST", body: "{}" })
      .then(r => props.onRun(r.run)).catch(e => setError(String(e.message))).finally(() => setBusy(false));
  }} />)}{error ? <Text style={{ color: T.err }}>{error}</Text> : null}</View>;
}

export function OrchestraOptionFields(props: {
  budget: string; setBudget: (s: string) => void; stall: string; setStall: (s: string) => void;
  limits: string; setLimits: (s: string) => void; webhook: string; setWebhook: (s: string) => void;
  check: string; setCheck: (s: string) => void; checkRounds: string; setCheckRounds: (s: string) => void; taskMinutes: string; setTaskMinutes: (s: string) => void;
  planOnly: boolean; setPlanOnly: (b: boolean) => void;
}) {
  return <View style={{ gap: 8 }}>
    {[["Done check command", props.check, props.setCheck], ["Check repair rounds", props.checkRounds, props.setCheckRounds], ["Task time limit (minutes)", props.taskMinutes, props.setTaskMinutes], ["Budget (USD)", props.budget, props.setBudget], ["Stalled after (minutes)", props.stall, props.setStall],
      ["Per-kind limits (e.g. echo=2)", props.limits, props.setLimits], ["Completion webhook URL", props.webhook, props.setWebhook]].map(([label, value, setter]) =>
      <View key={String(label)}><Text style={{ color: T.dim }}>{String(label)}</Text><TextInput accessibilityLabel={String(label)} style={field} value={value as string} onChangeText={setter as (s: string) => void} autoCapitalize="none" /></View>)}
    <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}><Switch value={props.planOnly} onValueChange={props.setPlanOnly} /><Text style={{ color: T.text }}>Approve plan before starting workers</Text></View>
  </View>;
}

export function OrchestraRunExtras(props: { creds: Creds; projectId: string; run: OrchestraRun; onRun: (r: OrchestraRun) => void }) {
  const { run } = props;
  const [agent, setAgent] = useState("");
  const [name, setName] = useState("");
  const [budget, setBudget] = useState(String(run.budgetUsd ?? ""));
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const base = `/api/projects/${props.projectId}/orchestra/${encodeURIComponent(run.id)}`;
  const action = async (route: string, body: object) => {
    setBusy(true); setMessage("");
    try {
      const result = await api<{ run?: OrchestraRun }>(props.creds, base + route, { method: "POST", body: JSON.stringify(body) });
      if (result.run) props.onRun(result.run);
      else setMessage("Recipe saved");
    } catch (e) { setMessage((e as Error).message); }
    finally { setBusy(false); }
  };
  const retry = run.tasks.filter(t => !run.applied && run.status !== "moved" && (t.stalledAt || ["failed", "cancelled", "conflict", "needs_input"].includes(t.status)));
  return <View style={{ gap: 8 }}>
    <Text style={{ color: T.dim }}>Spent ${run.costUsd.toFixed(3)} · budget {run.budgetUsd == null ? "uncapped" : `$${run.budgetUsd}`}</Text>
    {!["completed", "failed", "aborted", "moved"].includes(run.status) ? <View><TextInput accessibilityLabel="Run budget in USD" placeholder="Budget in USD" placeholderTextColor={T.faint} style={field} value={budget} onChangeText={setBudget} keyboardType="decimal-pad" />
      <Action title="Set budget" disabled={busy || !budget} onPress={() => void action("/budget", { maxUsd: Number(budget) })} /></View> : null}
    <Action title="Copy Mermaid graph" disabled={busy} onPress={() => {
      setBusy(true);
      void api<{ mermaid: string }>(props.creds, base + "/graph").then(r => Clipboard.setStringAsync(r.mermaid)).then(() => setMessage("Mermaid copied"))
        .catch(e => setMessage(e.message)).finally(() => setBusy(false));
    }} />
    <TextInput accessibilityLabel="Recipe name" placeholder="Recipe name" placeholderTextColor={T.faint} style={field} value={name} onChangeText={setName} />
    <Action title="Save Orchestra recipe" disabled={busy || !name.trim()} onPress={() => void action("/recipe", { name: name.trim() })} />
    {retry.length ? <View><TextInput accessibilityLabel="Retry agent and model" placeholder="agent@model:effort" placeholderTextColor={T.faint} autoCapitalize="none" style={field} value={agent} onChangeText={setAgent} />
      {retry.map(t => <Action key={t.id} title={`${t.stalledAt ? "Stalled · reassign" : "Retry"} ${t.id}`} disabled={busy || !agent.trim()} onPress={() => void action(`/tasks/${encodeURIComponent(t.id)}/retry`, { agent: agent.trim() })} />)}</View> : null}
    {(run.timeline || []).length ? <View><Text style={{ color: T.text }}>Task timeline</Text><ScrollView horizontal>{run.timeline!.map((e, i) => <View key={i} style={{ padding: 8, borderWidth: 1, borderColor: T.line, marginRight: 6 }}><Text style={{ color: T.text }}>{e.taskId} · {e.phase.replace("task_", "")}</Text><Text style={{ color: T.dim }}>{new Date(e.at).toLocaleTimeString()} · attempt {e.attempt}</Text>{e.text ? <Text style={{ color: T.dim }}>{e.text}</Text> : null}</View>)}</ScrollView></View> : null}
    {run.webhookDelivery ? <Text style={{ color: run.webhookDelivery.error ? T.err : T.dim }}>{run.webhookDelivery.error || (run.webhookDelivery.state === "pending" ? "Sending completion webhook…" : "Completion webhook delivered")}</Text> : null}
    {message ? <Text accessibilityRole="alert" style={{ color: T.dim }}>{message}</Text> : null}
  </View>;
}
