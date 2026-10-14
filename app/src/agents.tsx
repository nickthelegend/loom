/**
 * Agent naming and the composer's agent picker.
 *
 * The daemon speaks in adapter kinds ("codex", "grok-code", "antigravity-cli");
 * people speak in products. This is the one place that maps between them, so
 * the thread, the picker and the Orchestra cards all say the same thing.
 */

import { SvgXml } from "react-native-svg";
import { BRAND_MARK_ALIAS, BRAND_MARKS } from "./brand-marks";
import { useEffect, useState } from "react";
import { ActivityIndicator, Text, TextInput, TouchableOpacity, View } from "react-native";
import { getAgentModels, setAgentModel, type AgentStatus, type Creds } from "./api";
import { TAP } from "./components";
import { Sheet } from "./observatory";
import { T, hue, radii } from "./theme";

interface CatalogEntry {
  label: string;
  kinds: string[];
  soon?: boolean;
}

/** The products Loom drives, in the order the picker shows them. */
export const AGENT_CATALOG: ReadonlyArray<CatalogEntry> = [
  { label: "Codex (ChatGPT)", kinds: ["codex"] },
  { label: "Antigravity", kinds: ["antigravity-cli", "antigravity"] },
  { label: "Claude Code", kinds: ["claude-code"] },
  { label: "Grok", kinds: ["grok-code", "grok"] },
  { label: "OpenCode", kinds: ["opencode"] },
  { label: "Cursor", kinds: ["cursor"], soon: true },
];

export function agentLabel(kind: string): string {
  return AGENT_CATALOG.find((c) => c.kinds.includes(kind))?.label ?? kind;
}

/** A small tile with the product's initial in its own thread hue. */
/** The agent's own logo when it has one, as on the desktop. */
function markFor(kind: string): string | undefined {
  const k = kind === "grok" ? "grok-code" : BRAND_MARK_ALIAS[kind] ?? kind;
  return BRAND_MARKS[k];
}

export function AgentIcon(props: { kind: string; size?: number }) {
  const size = props.size ?? 26;
  const label = agentLabel(props.kind);
  const c = hue(label);
  const mark = markFor(props.kind);
  if (mark)
    return (
      <View
        style={{
          width: size,
          height: size,
          borderRadius: size * 0.3,
          backgroundColor: T.raised,
          borderWidth: 1,
          borderColor: T.line2,
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        {/* mono marks (opencode, Grok) take the text colour: white on dark */}
        <SvgXml xml={mark} width={size * 0.62} height={size * 0.62} color={T.text} />
      </View>
    );
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: size * 0.3,
        backgroundColor: T.raised,
        borderWidth: 1,
        borderColor: T.line2,
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <Text style={{ color: c, fontSize: size * 0.46, fontWeight: "800", fontFamily: T.mono }}>
        {(label[0] ?? "?").toUpperCase()}
      </Text>
    </View>
  );
}

function stateOf(a: AgentStatus, holder: string | null): { text: string; color: string } {
  if (a.enabled === false) return { text: "off", color: T.faint };
  if (!a.available) return { text: "not installed", color: T.faint };
  if (a.busy) return { text: "working", color: T.ok };
  if (a.id === holder) return { text: "holds the baton", color: T.shuttle };
  return { text: "ready", color: T.dim };
}

function Row(props: {
  kind: string;
  title: string;
  sub?: string;
  state?: { text: string; color: string };
  selected?: boolean;
  disabled?: boolean;
  onPress?: () => void;
}) {
  return (
    <TouchableOpacity
      onPress={props.onPress}
      disabled={props.disabled}
      activeOpacity={0.7}
      accessibilityRole="menuitem"
      accessibilityState={{ selected: !!props.selected, disabled: !!props.disabled }}
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 12,
        minHeight: TAP + 8,
        paddingHorizontal: 12,
        borderRadius: radii.card,
        borderWidth: 1,
        borderColor: props.selected ? T.line2 : T.line,
        backgroundColor: props.selected ? T.raised : T.panel,
        opacity: props.disabled ? 0.45 : 1,
      }}
    >
      <AgentIcon kind={props.kind} />
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={{ color: T.text, fontSize: 14.5, fontWeight: "600" }} numberOfLines={1}>
          {props.title}
        </Text>
        {props.sub ? (
          <Text style={{ color: T.faint, fontSize: 11, fontFamily: T.mono, marginTop: 1 }} numberOfLines={1}>
            {props.sub}
          </Text>
        ) : null}
      </View>
      {props.state && (
        <Text style={{ color: props.state.color, fontSize: 11, fontFamily: T.mono }}>{props.state.text}</Text>
      )}
      {props.selected && <Text style={{ color: T.text, fontSize: 15, fontWeight: "700" }}>✓</Text>}
    </TouchableOpacity>
  );
}

/**
 * The composer's "send to" control: a compact dropdown showing who the next
 * message goes to, opening a sheet with every product Loom knows. Products the
 * project doesn't have are shown, dimmed, so the list reads the same on every
 * project; Cursor is listed as coming soon.
 */
export function AgentPicker(props: {
  agents: AgentStatus[];
  selected: string | null;
  holder: string | null;
  onSelect: (agentId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const adapters = props.agents.filter((a) => a.tier === "adapter");
  const current = adapters.find((a) => a.id === props.selected) ?? null;
  const known = new Set(AGENT_CATALOG.flatMap((c) => c.kinds));
  const others = adapters.filter((a) => !known.has(a.kind));
  const pick = (id: string) => {
    props.onSelect(id);
    setOpen(false);
  };

  return (
    <>
      <TouchableOpacity
        onPress={() => setOpen(true)}
        activeOpacity={0.7}
        accessibilityRole="button"
        accessibilityLabel={`Send to ${current ? agentLabel(current.kind) : "an agent"}. Change agent`}
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: 8,
          alignSelf: "flex-start",
          minHeight: 34,
          paddingLeft: 5,
          paddingRight: 11,
          borderRadius: radii.pill,
          borderWidth: 1,
          borderColor: T.line2,
          backgroundColor: T.raised,
        }}
      >
        {current ? <AgentIcon kind={current.kind} size={24} /> : null}
        <Text style={{ color: T.text, fontSize: 12.5, fontWeight: "600" }} numberOfLines={1}>
          {current ? agentLabel(current.kind) : "Choose agent"}
        </Text>
        {current && (current.id !== current.kind || current.id === props.holder) ? (
          <Text style={{ color: T.faint, fontSize: 11, fontFamily: T.mono }} numberOfLines={1}>
            {current.id !== current.kind ? current.id : ""}
            {current.id === props.holder ? " ⟵" : ""}
          </Text>
        ) : null}
        <Text style={{ color: T.dim, fontSize: 10 }}>▼</Text>
      </TouchableOpacity>

      <Sheet title="Send to" visible={open} onClose={() => setOpen(false)}>
        {AGENT_CATALOG.map((entry) => {
          if (entry.soon) {
            return (
              <Row key={entry.label} kind={entry.kinds[0]!} title={`${entry.label} — coming soon`} disabled />
            );
          }
          const matches = adapters.filter((a) => entry.kinds.includes(a.kind));
          if (!matches.length) {
            return (
              <Row key={entry.label} kind={entry.kinds[0]!} title={entry.label} sub="not in this project" disabled />
            );
          }
          return matches.map((a) => (
            <Row
              key={a.id}
              kind={a.kind}
              title={entry.label}
              sub={a.id + (a.model ? ` · ${a.model}` : "")}
              state={stateOf(a, props.holder)}
              selected={a.id === props.selected}
              disabled={a.enabled === false}
              onPress={() => pick(a.id)}
            />
          ));
        })}
        {others.map((a) => (
          <Row
            key={a.id}
            kind={a.kind}
            title={a.id}
            sub={a.kind}
            state={stateOf(a, props.holder)}
            selected={a.id === props.selected}
            disabled={a.enabled === false}
            onPress={() => pick(a.id)}
          />
        ))}
        {props.selected && props.selected !== props.holder ? (
          <Text style={{ color: T.faint, fontSize: 11.5, lineHeight: 17 }}>
            Sending hands the baton to {props.selected}.
          </Text>
        ) : null}
      </Sheet>
    </>
  );
}

/**
 * The model chip beside the agent: what it runs on, and a searchable list to
 * change it — the desktop composer's model picker. "Default" unpins it.
 */
export function ModelPicker(props: { creds: Creds; projectId: string; agent: AgentStatus | null; onChanged: () => void }) {
  const [open, setOpen] = useState(false);
  const [models, setModels] = useState<string[] | null>(null);
  const [q, setQ] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const a = props.agent;
  useEffect(() => {
    if (!open || !a) return;
    setModels(null);
    setErr(null);
    getAgentModels(props.creds, props.projectId, a.id)
      .then((r) => setModels(r.models))
      .catch((e) => setErr(e instanceof Error ? e.message : String(e)));
  }, [open, a?.id]);
  if (!a || a.tier !== "adapter") return null;
  const pick = async (model: string) => {
    setBusy(model || "default");
    try {
      await setAgentModel(props.creds, props.projectId, a.id, model);
      setOpen(false);
      props.onChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };
  const needle = q.trim().toLowerCase();
  const shown = (models ?? []).filter((m) => !needle || m.toLowerCase().includes(needle)).slice(0, 80);
  const row = (label: string, value: string, on: boolean) => (
    <TouchableOpacity key={value || "default"} onPress={() => void pick(value)} disabled={!!busy} activeOpacity={0.7} accessibilityRole="button" accessibilityState={{ selected: on }}
      style={{ flexDirection: "row", alignItems: "center", minHeight: 42, borderBottomWidth: 1, borderBottomColor: T.line, gap: 8 }}>
      <Text style={{ color: on ? T.text : T.dim, fontSize: 13.5, fontFamily: value ? T.mono : undefined, flex: 1, fontWeight: on ? "700" : "400" }} numberOfLines={1}>{label}</Text>
      {busy === (value || "default") ? <ActivityIndicator color={T.dim} /> : on ? <Text style={{ color: T.ok, fontSize: 14 }}>✓</Text> : null}
    </TouchableOpacity>
  );
  return (
    <>
      <TouchableOpacity onPress={() => setOpen(true)} activeOpacity={0.7} accessibilityRole="button" accessibilityLabel={`Model: ${a.model ?? "default"}. Change model`}
        style={{ flexDirection: "row", alignItems: "center", gap: 6, minHeight: 34, paddingHorizontal: 11, borderRadius: radii.pill, borderWidth: 1, borderColor: T.line2, backgroundColor: T.raised, maxWidth: 170 }}>
        <Text style={{ color: T.dim, fontSize: 12, fontFamily: T.mono }} numberOfLines={1}>{a.model ? a.model.split("/").pop() : "Default"}</Text>
        <Text style={{ color: T.faint, fontSize: 10 }}>▼</Text>
      </TouchableOpacity>
      <Sheet title={`${agentLabel(a.kind)} · model`} visible={open} onClose={() => setOpen(false)}>
        {models && !models.length ? null : <TextInput value={q} onChangeText={setQ} placeholder={`Filter ${models ? models.length : ""} models…`} placeholderTextColor={T.faint} autoCapitalize="none" autoCorrect={false}
          style={{ color: T.text, backgroundColor: T.raised, borderRadius: radii.key, paddingHorizontal: 12, height: 40, fontSize: 14, marginBottom: 6 }} />}
        {err ? <Text style={{ color: T.err, fontSize: 12.5, marginBottom: 6 }}>{err}</Text> : null}
        {!needle ? row("Default — the agent's own choice", "", !a.model) : null}
        {models == null && !err ? <ActivityIndicator color={T.dim} style={{ marginTop: 12 }} /> : shown.map((m) => row(m, m, a.model === m))}
        {models && shown.length === 80 ? <Text style={{ color: T.faint, fontSize: 11.5, marginTop: 6 }}>Showing 80 — type to narrow.</Text> : null}
        {models && !models.length ? <Text style={{ color: T.faint, fontSize: 12, marginTop: 8, lineHeight: 17 }}>{agentLabel(a.kind)} doesn&apos;t list its models, so it runs on its own default.</Text> : null}
      </Sheet>
    </>
  );
}
