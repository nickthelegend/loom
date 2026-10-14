/**
 * The project's memory on the phone — the desktop's Memory tab: what the
 * agents have learned (decisions, constraints, conventions, facts, failures,
 * tasks), searchable, with a way to add one, correct one, or forget one.
 * Every agent reads this before a turn, so a wrong memory is worth fixing
 * from wherever you are.
 */

import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Alert, RefreshControl, ScrollView, Text, TextInput, TouchableOpacity, View } from "react-native";
import { addMemory, forgetMemory, getMemories, updateMemory, type Creds, type Memory, type Project } from "./api";
import { Empty, Panel, Unreachable, ago } from "./components";
import { T, radii, spacing } from "./theme";

const KINDS = ["decision", "constraint", "convention", "fact", "failure", "task"] as const;
const KIND_COLOR: Record<string, () => string> = {
  decision: () => T.primary,
  constraint: () => T.warn,
  convention: () => T.thread,
  fact: () => T.dim,
  failure: () => T.err,
  task: () => T.ok,
};

export function MemoryView(props: { creds: Creds; project: Project }) {
  const { creds, project } = props;
  const [list, setList] = useState<Memory[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [kind, setKind] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [draft, setDraft] = useState("");
  const [draftKind, setDraftKind] = useState<(typeof KINDS)[number]>("fact");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await getMemories(creds, project.id);
      setList(r.memories);
      setErr(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setRefreshing(false);
    }
  }, [creds, project.id]);
  useEffect(() => void load(), [load]);

  const remember = async () => {
    if (!draft.trim() || busy) return;
    setBusy(true);
    try {
      await addMemory(creds, project.id, draft.trim(), draftKind);
      setDraft("");
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const needle = q.trim().toLowerCase();
  const shown = (list ?? [])
    .filter((m) => (!kind || m.kind === kind) && (!needle || m.text.toLowerCase().includes(needle) || (m.entities ?? []).some((e) => e.toLowerCase().includes(needle))))
    .sort((a, b) => (b.updatedAt ?? b.createdAt) - (a.updatedAt ?? a.createdAt));
  const counts = (list ?? []).reduce<Record<string, number>>((n, m) => ((n[m.kind] = (n[m.kind] ?? 0) + 1), n), {});

  return (
    <ScrollView
      style={{ flex: 1 }}
      contentContainerStyle={{ padding: spacing.md, gap: spacing.md, paddingBottom: 40 }}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); void load(); }} tintColor={T.dim} />}
      keyboardShouldPersistTaps="handled"
    >
      <View style={{ gap: 4 }}>
        <Text style={{ color: T.text, fontSize: 20, fontWeight: "800", letterSpacing: -0.3 }}>Memory</Text>
        <Text style={{ color: T.dim, fontSize: 12.5, lineHeight: 18 }}>
          What the agents learned here. Every agent reads it before a turn, so fix what&apos;s wrong.
        </Text>
      </View>

      {/* remember something */}
      <Panel>
        <TextInput value={draft} onChangeText={setDraft} placeholder="Remember something for every agent…" placeholderTextColor={T.faint}
          multiline style={{ color: T.text, fontSize: 14, minHeight: 44, lineHeight: 20, textAlignVertical: "top" }} />
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
          {KINDS.map((k) => (
            <TouchableOpacity key={k} onPress={() => setDraftKind(k)} activeOpacity={0.7} accessibilityRole="radio" accessibilityState={{ selected: draftKind === k }}
              style={{ paddingHorizontal: 9, paddingVertical: 4, borderRadius: radii.pill, borderWidth: 1, borderColor: draftKind === k ? KIND_COLOR[k]!() : T.line }}>
              <Text style={{ color: draftKind === k ? KIND_COLOR[k]!() : T.faint, fontSize: 11.5, fontWeight: "600" }}>{k}</Text>
            </TouchableOpacity>
          ))}
          <TouchableOpacity onPress={() => void remember()} disabled={!draft.trim() || busy} activeOpacity={0.75} accessibilityRole="button"
            style={{ marginLeft: "auto", paddingHorizontal: 14, height: 34, borderRadius: radii.key, backgroundColor: T.bright, justifyContent: "center", opacity: !draft.trim() ? 0.4 : 1 }}>
            {busy ? <ActivityIndicator color={T.onBright} /> : <Text style={{ color: T.onBright, fontWeight: "700" }}>Remember</Text>}
          </TouchableOpacity>
        </View>
      </Panel>

      {err && !list ? <Unreachable what="Memory" detail={err} onRetry={() => void load()} /> : null}
      {err && list ? <Text style={{ color: T.err, fontSize: 12.5 }}>{err}</Text> : null}

      {list ? (
        <>
          <TextInput value={q} onChangeText={setQ} placeholder={`Search ${list.length} memories…`} placeholderTextColor={T.faint} autoCapitalize="none"
            style={{ color: T.text, backgroundColor: T.raised, borderRadius: radii.key, paddingHorizontal: 12, height: 40, fontSize: 14 }} />
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ flexGrow: 0 }} contentContainerStyle={{ gap: 6 }}>
            {[null, ...KINDS.filter((k) => counts[k])].map((k) => {
              const on = kind === k;
              return (
                <TouchableOpacity key={k ?? "all"} onPress={() => setKind(k)} activeOpacity={0.7} accessibilityRole="tab" accessibilityState={{ selected: on }}
                  style={{ paddingHorizontal: 11, paddingVertical: 5, borderRadius: radii.pill, borderWidth: 1, borderColor: on ? T.line2 : T.line, backgroundColor: on ? T.raised : "transparent" }}>
                  <Text style={{ color: on ? T.text : T.dim, fontSize: 12, fontWeight: "600" }}>{k ? `${k} · ${counts[k]}` : `all · ${list.length}`}</Text>
                </TouchableOpacity>
              );
            })}
          </ScrollView>
          {shown.length ? (
            shown.map((m) => (
              <MemoryCard key={m.id} m={m} open={open === m.id} onToggle={() => setOpen(open === m.id ? null : m.id)} creds={creds} projectId={project.id} onChanged={load} />
            ))
          ) : (
            <Empty text={list.length ? "Nothing matches." : "No memories yet. Agents add them as they work, or remember something above."} />
          )}
        </>
      ) : !err ? (
        <ActivityIndicator color={T.dim} style={{ marginTop: 24 }} />
      ) : null}
    </ScrollView>
  );
}

function MemoryCard(props: { m: Memory; open: boolean; onToggle: () => void; creds: Creds; projectId: string; onChanged: () => void }) {
  const { m } = props;
  const [text, setText] = useState(m.text);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => setText(m.text), [m.text]);
  const save = async () => {
    setBusy(true);
    try {
      await updateMemory(props.creds, props.projectId, m.id, { text: text.trim() });
      props.onChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const forget = () =>
    Alert.alert("Forget this?", "Agents stop reading it. Loom keeps a record that you forgot it.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Forget",
        style: "destructive",
        onPress: () =>
          void forgetMemory(props.creds, props.projectId, m.id, "forgotten from the phone")
            .then(props.onChanged)
            .catch((e) => setErr(e instanceof Error ? e.message : String(e))),
      },
    ]);
  const who = m.provenance?.agentId ?? "";
  // only the header (and the folded text) toggles: taps inside the open editor stay in it
  return (
    <View style={{ backgroundColor: T.panel, borderWidth: 1, borderColor: T.line, borderLeftWidth: 2, borderLeftColor: (KIND_COLOR[m.kind] ?? KIND_COLOR.fact)!(), borderRadius: radii.card, padding: spacing.md, gap: 6 }}>
      <TouchableOpacity onPress={props.onToggle} activeOpacity={0.7} accessibilityRole="button" accessibilityState={{ expanded: props.open }} style={{ flexDirection: "row", alignItems: "center", gap: 6, minHeight: 22 }}>
        <Text style={{ color: (KIND_COLOR[m.kind] ?? KIND_COLOR.fact)!(), fontSize: 10.5, fontWeight: "700", letterSpacing: 0.5 }}>{m.kind.toUpperCase()}</Text>
        <Text style={{ color: T.faint, fontSize: 11, flex: 1 }} numberOfLines={1}>
          {who ? (who === "user" ? "you" : who) : ""}{m.updatedAt || m.createdAt ? ` · ${ago(new Date(m.updatedAt ?? m.createdAt).toISOString())}` : ""}
        </Text>
        {m.confidence != null && m.confidence < 1 ? <Text style={{ color: T.faint, fontSize: 11, fontFamily: T.mono }}>{Math.round(m.confidence * 100)}%</Text> : null}
        <Text style={{ color: T.faint, fontSize: 11 }}>{props.open ? "▾" : "›"}</Text>
      </TouchableOpacity>
      {props.open ? (
        <>
          <TextInput value={text} onChangeText={setText} multiline style={{ color: T.text, fontSize: 14, lineHeight: 20, backgroundColor: T.raised, borderRadius: radii.key, padding: 10 }} />
          {m.evidence ? <Text style={{ color: T.faint, fontSize: 12, lineHeight: 17 }}>why: {m.evidence}</Text> : null}
          {m.entities?.length ? <Text style={{ color: T.faint, fontSize: 11.5, fontFamily: T.mono }}>{m.entities.join(" · ")}</Text> : null}
          {err ? <Text style={{ color: T.err, fontSize: 12 }}>{err}</Text> : null}
          <View style={{ flexDirection: "row", gap: 8 }}>
            <TouchableOpacity onPress={forget} activeOpacity={0.7} accessibilityRole="button" style={{ flex: 1, minHeight: 38, borderRadius: radii.key, borderWidth: 1, borderColor: T.line2, alignItems: "center", justifyContent: "center" }}>
              <Text style={{ color: T.err, fontWeight: "600" }}>Forget</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={() => void save()} disabled={busy || !text.trim() || text.trim() === m.text} activeOpacity={0.75} accessibilityRole="button"
              style={{ flex: 1, minHeight: 38, borderRadius: radii.key, backgroundColor: T.bright, alignItems: "center", justifyContent: "center", opacity: busy || !text.trim() || text.trim() === m.text ? 0.4 : 1 }}>
              {busy ? <ActivityIndicator color={T.onBright} /> : <Text style={{ color: T.onBright, fontWeight: "700" }}>Save</Text>}
            </TouchableOpacity>
          </View>
        </>
      ) : (
        <TouchableOpacity onPress={props.onToggle} activeOpacity={0.7} accessibilityHint="opens it to edit or forget">
          <Text style={{ color: T.text, fontSize: 14, lineHeight: 20 }} numberOfLines={4}>{m.text}</Text>
        </TouchableOpacity>
      )}
    </View>
  );
}
