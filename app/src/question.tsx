/**
 * An agent's structured question (Claude's AskUserQuestion, Codex's
 * request_user_input, OpenCode's question tool), answered from the phone:
 * the options as buttons, pick-any questions with a Submit, your own words
 * when the agent allows them. The answer goes back to the very request the
 * turn is waiting on — the same route the desktop card uses.
 */

import { useState } from "react";
import { ActivityIndicator, Text, TextInput, TouchableOpacity, View } from "react-native";

import { answerQuestion, type Creds, type LoomEvent } from "./api";
import { T, radii, spacing } from "./theme";

interface Q {
  id: string;
  header?: string;
  question: string;
  options?: Array<{ label: string; description?: string }>;
  multiSelect?: boolean;
  allowCustomAnswer?: boolean;
  secret?: boolean;
}

/** requestId → what was answered (from question_answered events in the thread). */
export function answeredQuestions(events: LoomEvent[]): Map<string, Record<string, unknown>> {
  const out = new Map<string, Record<string, unknown>>();
  for (const e of events) {
    const p = e.payload ?? {};
    if (e.kind === "status" && p.state === "question_answered" && typeof p.requestId === "string") {
      out.set(p.requestId, (p.answers as Record<string, unknown>) ?? {});
    }
  }
  return out;
}

export function QuestionEvent(props: { creds: Creds; projectId: string; e: LoomEvent; answered?: Record<string, unknown> }) {
  const p = props.e.payload ?? {};
  const qs = (Array.isArray(p.questions) ? p.questions : []) as Q[];
  const who = String(p.askAgent ?? props.e.agentId ?? "agent");
  const [picks, setPicks] = useState<Record<string, string[]>>({});
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [mine, setMine] = useState<Record<string, unknown> | null>(null);
  const done = mine ?? props.answered;
  const multi = qs.some((q) => q.multiSelect);
  const custom = qs.some((q) => q.allowCustomAnswer !== false || !(q.options ?? []).length);
  const secret = qs.some((q) => q.secret);

  const submit = async (next: Record<string, string[]>) => {
    const answers: Record<string, string | string[]> = {};
    for (const q of qs) {
      const list = [...(next[q.id] ?? [])];
      if (!list.length && typed.trim()) list.push(typed.trim());
      if (!list.length) { setErr("answer every question first"); return; }
      answers[q.id] = q.multiSelect ? list : list[0]!;
    }
    setBusy(true); setErr(null);
    try {
      await answerQuestion(props.creds, props.projectId, who, props.e.chat, String(p.requestId), answers);
      setMine(answers);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const tap = (q: Q, label: string) => {
    const cur = picks[q.id] ?? [];
    const next = { ...picks, [q.id]: q.multiSelect ? (cur.includes(label) ? cur.filter((l) => l !== label) : [...cur, label]) : [label] };
    setPicks(next);
    // a single-choice card with nothing else to answer goes as soon as you pick
    if (!multi && qs.every((x) => (next[x.id] ?? []).length)) void submit(next);
  };

  const summary = done ? Object.values(done).map((v) => (Array.isArray(v) ? v.join(", ") : String(v ?? ""))).filter(Boolean) : [];
  return (
    <View style={{ marginVertical: spacing.sm, padding: spacing.md, borderRadius: radii.card, borderWidth: 1,
      borderColor: done ? T.line : T.warn, backgroundColor: T.panel, opacity: done ? 0.85 : 1 }}>
      <Text style={{ color: T.warn, fontSize: 11, fontWeight: "700", marginBottom: 6 }}>{done ? "ANSWERED" : "NEEDS YOU"} · {String(props.e.agentId ?? who)}</Text>
      {qs.map((q) => (
        <View key={q.id} style={{ marginBottom: spacing.sm }}>
          {q.header ? <Text style={{ color: T.dim, fontSize: 11, marginBottom: 2 }}>{q.header}{q.multiSelect ? " · pick any" : ""}</Text> : null}
          <Text style={{ color: T.text, fontSize: 15, lineHeight: 21, marginBottom: 8 }}>{q.question}</Text>
          {!done && (q.options ?? []).map((o) => {
            const on = (picks[q.id] ?? []).includes(o.label);
            return (
              <TouchableOpacity key={o.label} disabled={busy} onPress={() => tap(q, o.label)} accessibilityRole="button"
                accessibilityState={{ selected: on }} activeOpacity={0.7}
                style={{ paddingVertical: 10, paddingHorizontal: 12, borderRadius: radii.input, borderWidth: 1, marginBottom: 6,
                  borderColor: on ? T.thread : T.line, backgroundColor: on ? T.threadDim : T.bg }}>
                <Text style={{ color: T.text, fontSize: 14, fontWeight: "600" }}>{q.multiSelect ? (on ? "☑ " : "☐ ") : ""}{o.label}</Text>
                {o.description ? <Text style={{ color: T.dim, fontSize: 12, marginTop: 2 }}>{o.description}</Text> : null}
              </TouchableOpacity>
            );
          })}
        </View>
      ))}
      {done ? (
        <Text style={{ color: T.dim, fontSize: 13 }}>↳ {secret ? "answered (hidden)" : summary.length ? summary.join(" · ") : "dismissed"}</Text>
      ) : (
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          {custom ? (
            <TextInput value={typed} onChangeText={setTyped} placeholder="or answer in your words…" placeholderTextColor={T.faint}
              secureTextEntry={secret} editable={!busy} onSubmitEditing={() => void submit(picks)}
              style={{ flex: 1, color: T.text, borderWidth: 1, borderColor: T.line, borderRadius: radii.input, paddingHorizontal: 10, height: 38 }} />
          ) : <View style={{ flex: 1 }} />}
          {(multi || custom) && (
            <TouchableOpacity disabled={busy} onPress={() => void submit(picks)} accessibilityRole="button"
              style={{ backgroundColor: T.thread, borderRadius: radii.input, paddingHorizontal: 14, height: 38, justifyContent: "center" }}>
              {busy ? <ActivityIndicator color={T.bg} /> : <Text style={{ color: T.bg, fontWeight: "700" }}>{multi ? "Submit" : "Send"}</Text>}
            </TouchableOpacity>
          )}
        </View>
      )}
      {err ? <Text style={{ color: T.err, fontSize: 12, marginTop: 6 }}>{err}</Text> : null}
    </View>
  );
}
