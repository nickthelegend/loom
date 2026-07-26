/**
 * Ask — a question about this fleet, answered from the fleet's own evidence.
 *
 * The daemon assembles the context out of the same sources the Observatory
 * renders (status, metrics, health, spans, decisions) and hands the project's
 * real MCP servers to a headless CLI for the turn — a telemetry MCP server
 * among them when the project has one configured — so the model can query the
 * evidence rather than trust a summary. Two consequences shape this screen:
 *
 *   It is slow. A real answer takes 30–60s, so the pending state has to be a
 *   state and not a spinner that looks hung — it counts, and it says what is
 *   happening.
 *
 *   It is not authoritative on its own. Every answer carries which model
 *   actually spoke, whether the evidence came from the telemetry backend or the
 *   local event log, and which MCP servers were in the room. That line is not
 *   decoration: "local-log" means the backend was empty or down, which is a
 *   different claim about the same sentence.
 */

import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, ScrollView, Text, TextInput, TouchableOpacity, View } from "react-native";
import { askObservatory, type AskResult, type Creds, type Project } from "./api";
import { Badge, Panel, SectionLabel, TAP, field } from "./components";
import { T, radii, spacing } from "./theme";

/**
 * The empty state's starters. Each one is answerable from the evidence the
 * daemon actually assembles — nothing here asks for a fact the fleet doesn't
 * hold, because a suggested question that can't be answered teaches the user
 * the feature is broken.
 */
const SUGGESTIONS = [
  "Which agent is burning the most money?",
  "Why did the last turn fail?",
  "Which agent is the least healthy, and what is dragging its score down?",
  "What has the baton's route been, and does it look wasteful?",
  "Summarise the decisions made so far.",
  "Is anything about this run unusual?",
];

interface Exchange {
  id: number;
  question: string;
  /** null while in flight. */
  result: AskResult | null;
  error: string | null;
  askedAt: number;
}

export function AskView(props: { creds: Creds; project: Project }) {
  const [text, setText] = useState("");
  const [log, setLog] = useState<Exchange[]>([]);
  const [busy, setBusy] = useState(false);
  const nextId = useRef(1);
  const listRef = useRef<ScrollView>(null);

  const ask = (question: string) => {
    const q = question.trim();
    if (!q || busy) return;
    const id = nextId.current++;
    setText("");
    setBusy(true);
    setLog((prev) => [...prev, { id, question: q, result: null, error: null, askedAt: Date.now() }]);
    void askObservatory(props.creds, props.project.id, q)
      .then((result) => setLog((prev) => prev.map((e) => (e.id === id ? { ...e, result } : e))))
      .catch((err: unknown) =>
        setLog((prev) =>
          prev.map((e) => (e.id === id ? { ...e, error: err instanceof Error ? err.message : String(err) } : e)),
        ),
      )
      .finally(() => setBusy(false));
  };

  return (
    <View style={{ flex: 1 }}>
      <ScrollView
        ref={listRef}
        style={{ flex: 1 }}
        contentContainerStyle={{ padding: spacing.md, gap: spacing.md, paddingBottom: 24 }}
        onContentSizeChange={() => listRef.current?.scrollToEnd({ animated: true })}
      >
        {!log.length ? (
          <>
            <Panel tint={T.primaryDim}>
              <Text style={{ color: T.text, fontSize: 15, fontWeight: "700" }}>Ask</Text>
              <Text style={{ color: T.dim, fontSize: 12.5, lineHeight: 19 }}>
                A question about this fleet, answered from its own telemetry — the same status, metrics, health,
                spans and decisions the Observatory shows you. Answers take 30–60 seconds because the model
                queries the evidence rather than guessing at it.
              </Text>
            </Panel>
            <SectionLabel text="Try one of these" />
            {SUGGESTIONS.map((s) => (
              <TouchableOpacity
                key={s}
                onPress={() => ask(s)}
                disabled={busy}
                activeOpacity={0.7}
                accessibilityRole="button"
                accessibilityLabel={`Ask: ${s}`}
                style={{
                  minHeight: TAP,
                  justifyContent: "center",
                  backgroundColor: T.panel,
                  borderWidth: 1,
                  borderColor: T.line,
                  borderRadius: radii.card,
                  paddingVertical: 12,
                  paddingHorizontal: 14,
                }}
              >
                <Text style={{ color: T.text, fontSize: 13.5, lineHeight: 19 }}>{s}</Text>
              </TouchableOpacity>
            ))}
          </>
        ) : (
          log.map((e) => <ExchangeCard key={e.id} exchange={e} onRetry={() => ask(e.question)} />)
        )}
      </ScrollView>

      <View
        style={{
          flexDirection: "row",
          gap: spacing.sm,
          alignItems: "center",
          padding: spacing.sm + 2,
          backgroundColor: T.panel,
          borderTopWidth: 1,
          borderTopColor: T.line,
        }}
      >
        <TextInput
          style={{ ...field, flex: 1, paddingVertical: 10, fontSize: 14 }}
          value={text}
          onChangeText={setText}
          editable={!busy}
          placeholder={busy ? "Thinking…" : "Ask about this fleet…"}
          placeholderTextColor={T.faint}
          selectionColor={T.accentBlue}
          onSubmitEditing={() => ask(text)}
          returnKeyType="send"
          multiline
        />
        <TouchableOpacity
          onPress={() => ask(text)}
          disabled={busy || !text.trim()}
          activeOpacity={0.7}
          accessibilityRole="button"
          accessibilityLabel="Ask about this fleet"
          style={{
            width: TAP,
            height: TAP,
            borderRadius: radii.key,
            alignItems: "center",
            justifyContent: "center",
            backgroundColor: !busy && text.trim() ? T.bright : T.raised,
            borderWidth: 1,
            borderColor: !busy && text.trim() ? T.bright : T.line,
          }}
        >
          {busy ? (
            <ActivityIndicator color={T.dim} size="small" />
          ) : (
            <Text style={{ color: text.trim() ? T.onBright : T.dim, fontSize: 16, fontWeight: "700" }}>↑</Text>
          )}
        </TouchableOpacity>
      </View>
    </View>
  );
}

function ExchangeCard(props: { exchange: Exchange; onRetry: () => void }) {
  const { exchange: e } = props;
  return (
    <View style={{ gap: 8 }}>
      <View style={{ alignSelf: "flex-end", maxWidth: "90%" }}>
        <View
          style={{
            backgroundColor: T.raised,
            borderWidth: 1,
            borderColor: T.line,
            borderRadius: radii.card,
            borderBottomRightRadius: 4,
            paddingVertical: 9,
            paddingHorizontal: 13,
          }}
        >
          <Text style={{ color: T.text, fontSize: 14, lineHeight: 21 }}>{e.question}</Text>
        </View>
      </View>

      {e.error ? (
        <View
          style={{
            backgroundColor: T.panel,
            borderWidth: 1,
            borderColor: T.line,
            borderLeftWidth: 2,
            borderLeftColor: T.err,
            borderRadius: radii.card,
            padding: 12,
            gap: 8,
          }}
        >
          <Text style={{ color: T.text, fontSize: 13, fontWeight: "600" }}>Couldn&apos;t answer</Text>
          <Text style={{ color: T.dim, fontSize: 12, fontFamily: T.mono, lineHeight: 18 }}>{e.error}</Text>
          <TouchableOpacity
            onPress={props.onRetry}
            activeOpacity={0.7}
            accessibilityRole="button"
            accessibilityLabel="Ask that question again"
            style={{
              alignSelf: "flex-start",
              minHeight: TAP,
              justifyContent: "center",
              paddingHorizontal: 18,
              backgroundColor: T.raised,
              borderWidth: 1,
              borderColor: T.line2,
              borderRadius: radii.key,
            }}
          >
            <Text style={{ color: T.text, fontSize: 13, fontWeight: "600" }}>Ask again</Text>
          </TouchableOpacity>
        </View>
      ) : !e.result ? (
        <Pending since={e.askedAt} />
      ) : e.result.unavailable ? (
        // `unavailable` is the daemon saying no CLI could answer at all. That is
        // not an answer with low confidence, it is the absence of one.
        <View
          style={{
            backgroundColor: T.panel,
            borderWidth: 1,
            borderColor: T.line,
            borderLeftWidth: 2,
            borderLeftColor: T.warn,
            borderRadius: radii.card,
            padding: 12,
            gap: 6,
          }}
        >
          <Text style={{ color: T.warn, fontSize: 13, fontWeight: "600" }}>No model was available to answer</Text>
          <Text style={{ color: T.dim, fontSize: 13, lineHeight: 20 }}>{e.result.answer}</Text>
        </View>
      ) : (
        <View
          style={{
            backgroundColor: T.panel,
            borderWidth: 1,
            borderColor: T.primaryDim,
            borderRadius: radii.card,
            borderBottomLeftRadius: 4,
            padding: 13,
            gap: 10,
          }}
        >
          <Text style={{ color: T.text, fontSize: 14, lineHeight: 21 }}>{e.result.answer}</Text>
          <Provenance result={e.result} />
        </View>
      )}
    </View>
  );
}

/** Where the answer came from. Shown under every answer, never folded away. */
function Provenance(props: { result: AskResult }) {
  const r = props.result;
  const fromBackend = r.spanSource === "backend";
  return (
    <View style={{ gap: 6, borderTopWidth: 1, borderTopColor: T.line, paddingTop: 9 }}>
      <View style={{ flexDirection: "row", gap: 6, flexWrap: "wrap" }}>
        <Badge text={r.via || "unknown model"} tint={T.primary} />
        <Badge
          text={fromBackend ? "evidence: backend spans" : "evidence: local event log"}
          tint={fromBackend ? T.thread : T.dim}
        />
        {r.mcpServers.length ? (
          <Badge text={`MCP: ${r.mcpServers.join(", ")}`} tint={T.thread} />
        ) : (
          <Badge text="no MCP servers attached" />
        )}
      </View>
      {r.evidenceSpans != null || r.evidenceAgents != null ? (
        <Text style={{ color: T.faint, fontSize: 10, fontFamily: T.mono }}>
          read {r.evidenceSpans ?? 0} spans across {r.evidenceAgents ?? 0} agents
          {fromBackend ? "" : " — the backend had nothing, so this came from the local log"}
        </Text>
      ) : null}
    </View>
  );
}

/**
 * The wait, made legible. A bare spinner for a minute is indistinguishable from
 * a hang, so this counts up and names the phase it is plausibly in.
 */
function Pending(props: { since: number }) {
  const [secs, setSecs] = useState(0);
  const since = props.since;
  useEffect(() => {
    const t = setInterval(() => setSecs(Math.round((Date.now() - since) / 1000)), 1000);
    return () => clearInterval(t);
  }, [since]);

  const phase =
    secs < 6
      ? "assembling the evidence"
      : secs < 20
        ? "asking the model"
        : secs < 45
          ? "the model is querying telemetry"
          : "still working — this one is taking a while";

  return (
    <View
      style={{
        backgroundColor: T.panel,
        borderWidth: 1,
        borderColor: T.line,
        borderRadius: radii.card,
        borderBottomLeftRadius: 4,
        padding: 13,
        gap: 9,
        flexDirection: "row",
        alignItems: "center",
      }}
    >
      <ActivityIndicator color={T.primary} size="small" />
      <Text style={{ color: T.dim, fontSize: 12.5, flex: 1 }}>{phase}</Text>
      <Text style={{ color: T.faint, fontSize: 11, fontFamily: T.mono }}>{secs}s</Text>
    </View>
  );
}
