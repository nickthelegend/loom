/**
 * Fleets on the phone (#369): N workers of one agent on one model — "execbot on gpt‑5.6‑sol ×2",
 * "claude on Opus 5.5 ×2" — added to an orchestra run next to the agents ticked above. Each row goes
 * out as an `agent@model×N` spec and the daemon expands it into separately named instances.
 */

import { useEffect, useState } from "react";
import { ActivityIndicator, ScrollView, Text, TextInput, TouchableOpacity, View } from "react-native";
import { getAgentModels, getFleets, type AgentStatus, type Creds } from "./api";
import { agentLabel } from "./agents";
import { TAP } from "./components";
import { T, radii } from "./theme";

/** A row is either agent/model/count, or a saved fleet by name (#406), which the daemon expands. */
export interface FleetRow { agent: string; model: string; count: number; saved?: string; spec?: string }

/** What the daemon reads: agent[@model][xN], or @name for a saved fleet. */
export const fleetSpec = (f: FleetRow) => f.saved ? `@${f.saved}` : f.agent + (f.model ? `@${f.model}` : "") + (f.count > 1 ? `x${f.count}` : "");

export function FleetEditor(props: {
  creds: Creds;
  projectId: string;
  agents: AgentStatus[];
  rows: FleetRow[];
  onChange: (rows: FleetRow[]) => void;
}) {
  const [adding, setAdding] = useState(false);
  const [agent, setAgent] = useState<string | null>(null);
  const [model, setModel] = useState("");
  const [count, setCount] = useState(2);
  const [models, setModels] = useState<string[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [saved, setSaved] = useState<Array<{ name: string; spec: string }>>([]);

  useEffect(() => {
    if (!adding) return;
    let gone = false;
    void getFleets(props.creds).then((r) => { if (!gone) setSaved(r.fleets); }).catch(() => { /* older computer, or a scoped device */ });
    return () => { gone = true; };
  }, [adding]);

  useEffect(() => {
    if (!adding || !agent) return;
    let gone = false;
    setModels(null);
    void getAgentModels(props.creds, props.projectId, agent)
      .then((r) => { if (!gone) setModels(r.models.slice(0, 10)); })
      .catch(() => { if (!gone) setModels([]); });
    return () => { gone = true; };
  }, [adding, agent]);

  const open = () => { setAdding(true); setAgent(props.agents[0]?.id ?? null); setModel(""); setCount(2); setErr(null); };
  const add = () => {
    if (!agent) return;
    if (/[\s×]/.test(model)) return setErr("a model id has no spaces");
    props.onChange([...props.rows, { agent, model: model.trim(), count }]);
    setAdding(false);
  };
  const kind = (id: string) => props.agents.find((a) => a.id === id)?.kind ?? id;
  const chip = (label: string, on: boolean, onPress: () => void, key: string) => (
    <TouchableOpacity key={key} onPress={onPress} activeOpacity={0.7} accessibilityRole="radio" accessibilityState={{ selected: on }}
      style={{ minHeight: 34, paddingHorizontal: 11, borderRadius: 999, borderWidth: 1, borderColor: on ? T.line2 : T.line,
        backgroundColor: on ? T.raised : "transparent", justifyContent: "center" }}>
      <Text style={{ color: on ? T.text : T.dim, fontSize: 12.5, fontWeight: "600" }} numberOfLines={1}>{label}</Text>
    </TouchableOpacity>
  );

  return (
    <View style={{ gap: 8 }}>
      {props.rows.length > 0 && (
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
          {props.rows.map((f, i) => (
            <TouchableOpacity key={`${fleetSpec(f)}:${i}`} onPress={() => props.onChange(props.rows.filter((_, j) => j !== i))}
              activeOpacity={0.7} accessibilityRole="button" accessibilityLabel={f.saved ? `saved fleet ${f.saved} — tap to remove` : `${f.count} ${f.agent} on ${f.model || "its default model"} — tap to remove`}
              style={{ flexDirection: "row", alignItems: "center", gap: 6, minHeight: 34, paddingHorizontal: 11, borderRadius: 999,
                borderWidth: 1, borderColor: T.line2, backgroundColor: T.raised }}>
              <Text style={{ color: T.text, fontSize: 12.5, fontWeight: "700" }}>{f.saved ? f.saved : agentLabel(kind(f.agent))}</Text>
              <Text style={{ color: T.dim, fontSize: 12, fontFamily: T.mono }} numberOfLines={1}>{f.saved ? "saved fleet" : f.model ? f.model.split("/").pop() : "default"}</Text>
              {f.count > 1 && <Text style={{ color: T.text, fontSize: 12.5, fontWeight: "800" }}>×{f.count}</Text>}
              <Text style={{ color: T.faint, fontSize: 13 }}>✕</Text>
            </TouchableOpacity>
          ))}
        </View>
      )}

      {!adding ? (
        <TouchableOpacity onPress={open} disabled={!props.agents.length} activeOpacity={0.7} accessibilityRole="button"
          accessibilityLabel="Add a fleet: several workers of one agent on one model"
          style={{ alignSelf: "flex-start", minHeight: 34, paddingHorizontal: 12, borderRadius: 999, borderWidth: 1, borderStyle: "dashed",
            borderColor: T.line2, justifyContent: "center", opacity: props.agents.length ? 1 : 0.5 }}>
          <Text style={{ color: T.dim, fontSize: 12.5, fontWeight: "700" }}>+ Fleet — N of one agent on a model</Text>
        </TouchableOpacity>
      ) : (
        <View style={{ gap: 8, padding: 12, borderRadius: radii.key, borderWidth: 1, borderColor: T.line2, backgroundColor: T.panel }}>
          {saved.length > 0 && (
            <View style={{ gap: 6 }}>
              <Text style={{ color: T.dim, fontSize: 11.5, fontWeight: "700", letterSpacing: 0.4 }}>SAVED FLEETS</Text>
              <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
                {saved.map((f) => chip(`${f.name} · ${f.spec}`, false, () => {
                  props.onChange([...props.rows, { agent: "", model: "", count: 1, saved: f.name, spec: f.spec }]);
                  setAdding(false);
                }, `saved:${f.name}`))}
              </View>
              <Text style={{ color: T.dim, fontSize: 11.5, fontWeight: "700", letterSpacing: 0.4, marginTop: 4 }}>OR BUILD ONE</Text>
            </View>
          )}
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 6 }}>
            {props.agents.map((a) => chip(agentLabel(a.kind) + (a.id !== a.kind ? ` · ${a.id}` : ""), a.id === agent, () => { setAgent(a.id); setModel(""); }, a.id))}
          </ScrollView>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
            {chip("default model", !model, () => setModel(""), "__default")}
            {models === null ? <ActivityIndicator color={T.dim} /> : models.map((m) => chip(m.split("/").pop() ?? m, model === m, () => setModel(m), m))}
          </View>
          <TextInput value={model} onChangeText={setModel} placeholder="or type a model id, e.g. claude-opus-5-5" placeholderTextColor={T.faint}
            autoCapitalize="none" autoCorrect={false} accessibilityLabel="Fleet model id"
            style={{ color: T.text, backgroundColor: T.raised, borderRadius: radii.input, paddingHorizontal: 10, height: 38, fontSize: 13.5 }} />
          <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
            <Text style={{ color: T.dim, fontSize: 13, flex: 1 }}>How many</Text>
            {(["−", "+"] as const).map((sym, i) => {
              const next = count + (i ? 1 : -1);
              return (
                <TouchableOpacity key={sym} onPress={() => next >= 1 && next <= 8 && setCount(next)} accessibilityLabel={i ? "one more" : "one fewer"}
                  style={{ width: 36, height: 36, borderRadius: 18, borderWidth: 1, borderColor: T.line2, alignItems: "center", justifyContent: "center", opacity: next >= 1 && next <= 8 ? 1 : 0.35 }}>
                  <Text style={{ color: T.text, fontSize: 17 }}>{sym}</Text>
                </TouchableOpacity>
              );
            }).reduce<React.ReactNode[]>((acc, el, i) => (i === 0 ? [el, <Text key="n" style={{ color: T.text, fontSize: 15, fontWeight: "800", minWidth: 26, textAlign: "center" }}>×{count}</Text>] : [...acc, el]), [])}
          </View>
          {err && <Text style={{ color: T.err, fontSize: 12.5 }}>{err}</Text>}
          <View style={{ flexDirection: "row", gap: 8 }}>
            <TouchableOpacity onPress={() => setAdding(false)} style={{ flex: 1, minHeight: TAP - 6, borderRadius: radii.key, borderWidth: 1, borderColor: T.line, alignItems: "center", justifyContent: "center" }}>
              <Text style={{ color: T.dim, fontSize: 14, fontWeight: "600" }}>Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={add} disabled={!agent} style={{ flex: 1, minHeight: TAP - 6, borderRadius: radii.key, backgroundColor: T.bright, alignItems: "center", justifyContent: "center" }}>
              <Text style={{ color: T.onBright, fontSize: 14, fontWeight: "700" }}>Add {count} {agent ? agentLabel(kind(agent)) : ""}</Text>
            </TouchableOpacity>
          </View>
        </View>
      )}
    </View>
  );
}
