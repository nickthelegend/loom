/** Shared UI atoms: event lines, diff viewer, buttons. */

import { useState } from "react";
import { ScrollView, Text, TouchableOpacity, View } from "react-native";
import type { LoomEvent } from "./api";
import { T, hue } from "./theme";

export function Btn(props: {
  label: string;
  onPress: () => void;
  primary?: boolean;
  small?: boolean;
}) {
  return (
    <TouchableOpacity
      onPress={props.onPress}
      style={{
        backgroundColor: props.primary ? T.accent : T.panel,
        borderColor: props.primary ? T.accent : T.line,
        borderWidth: 1,
        borderRadius: 10,
        paddingVertical: props.small ? 5 : 10,
        paddingHorizontal: props.small ? 10 : 14,
      }}
    >
      <Text
        style={{
          color: props.primary ? T.accentDark : T.text,
          fontWeight: props.primary ? "700" : "400",
          fontSize: props.small ? 12 : 15,
          textAlign: "center",
        }}
      >
        {props.label}
      </Text>
    </TouchableOpacity>
  );
}

export function Sys(props: { text: string; color?: string }) {
  return (
    <Text style={{ color: props.color ?? T.dim, fontSize: 12, textAlign: "center", marginVertical: 6 }}>
      {props.text}
    </Text>
  );
}

/** Unified diff with +/− coloring; used by turn cards and the Changes tab. */
export function DiffView(props: { patch: string; maxHeight?: number }) {
  const lines = props.patch.split("\n");
  return (
    <ScrollView
      style={{
        maxHeight: props.maxHeight ?? 320,
        backgroundColor: "#0e1420",
        borderRadius: 10,
        borderWidth: 1,
        borderColor: T.line,
      }}
      contentContainerStyle={{ padding: 8 }}
      nestedScrollEnabled
    >
      {lines.map((line, i) => {
        const c = line.startsWith("+")
          ? T.ok
          : line.startsWith("-")
            ? T.err
            : line.startsWith("@@")
              ? T.accent
              : line.startsWith("??")
                ? T.warn
                : T.dim;
        return (
          <Text key={i} style={{ color: c, fontFamily: T.mono, fontSize: 11 }}>
            {line || " "}
          </Text>
        );
      })}
    </ScrollView>
  );
}

/** One event in the thread. turn_diff renders as an expandable change card. */
export function EventLine(props: { e: LoomEvent }) {
  const { e } = props;
  const p = e.payload as Record<string, unknown>;
  const [open, setOpen] = useState(false);

  if (e.kind === "message") {
    const author = e.agentId ?? String(p.author ?? "user");
    if (!e.agentId && author === "loom") {
      return <Sys text={`➤ ${String(p.text).split("\n")[0]}`} />;
    }
    const mine = !e.agentId;
    return (
      <View style={{ alignItems: mine ? "flex-end" : "flex-start", marginVertical: 4 }}>
        {!mine && (
          <Text style={{ color: hue(author), fontSize: 11, marginBottom: 2, marginHorizontal: 6 }}>
            {author}
          </Text>
        )}
        <View
          style={{
            maxWidth: "86%",
            backgroundColor: mine ? "#1b2a3a" : T.panel,
            borderColor: mine ? "#24405c" : T.line,
            borderWidth: 1,
            borderRadius: 14,
            padding: 10,
          }}
        >
          <Text style={{ color: T.text, fontSize: 14 }}>{String(p.text ?? "")}</Text>
        </View>
      </View>
    );
  }

  if (e.kind === "turn_diff") {
    const files = (p.files as Array<{ path: string }> | undefined) ?? [];
    return (
      <TouchableOpacity
        onPress={() => setOpen(!open)}
        style={{
          backgroundColor: "#122032",
          borderColor: "#1d3a55",
          borderWidth: 1,
          borderRadius: 12,
          padding: 10,
          marginVertical: 6,
        }}
      >
        <Text style={{ color: T.accent, fontSize: 12 }}>
          ✎ this prompt changed {files.length} file{files.length === 1 ? "" : "s"} (+
          {Number(p.added ?? 0)} −{Number(p.removed ?? 0)}) {open ? "▾" : "▸"}
        </Text>
        <Text style={{ color: T.dim, fontSize: 11, marginTop: 2 }}>
          {files.slice(0, 4).map((f) => f.path).join(", ")}
          {files.length > 4 ? " …" : ""}
        </Text>
        {open && <DiffView patch={String(p.patch ?? "")} maxHeight={280} />}
      </TouchableOpacity>
    );
  }

  if (e.kind === "tool_call") return <Sys text={`⚙ ${String(p.summary ?? p.tool ?? "tool")}`} />;
  if (e.kind === "file_edit") return <Sys text={`✎ ${String(p.path ?? "")}`} />;
  if (e.kind === "handoff")
    return <Sys color={T.mag} text={`⟶ baton: ${String(p.from ?? "—")} → ${String(p.to ?? "—")}`} />;
  if (e.kind === "needs_input")
    return <Sys color={T.warn} text={`⏸ ${e.agentId} asks: ${String(p.question ?? "")}`} />;
  if (e.kind === "suggestion") return <Sys color={T.warn} text={`💡 ${String(p.reason ?? "")}`} />;
  if (e.kind === "decision") return <Sys text={`★ ${String(p.text ?? "")}`} />;
  if (e.kind === "error") return <Sys color={T.err} text={`✗ ${String(p.message ?? "error")}`} />;
  if (e.kind === "run_complete") return <Sys text={`✓ ${e.agentId} done`} />;
  if (e.kind === "route_started") return <Sys text={`➤ route started`} />;
  if (e.kind === "route_step")
    return <Sys text={`➤ hop ${Number(p.step) + 1} → ${String(p.agent)}${p.reason ? ` (${String(p.reason)})` : ""}`} />;
  if (e.kind === "route_paused")
    return <Sys color={T.warn} text={`⏸ route paused — ${String(p.question ?? "")}`} />;
  if (e.kind === "route_resumed") return <Sys text="➤ route resumed" />;
  if (e.kind === "route_completed") return <Sys color={T.ok} text="✔ route completed" />;
  if (e.kind === "route_failed")
    return <Sys color={p.aborted ? T.warn : T.err} text={`⊘ ${String(p.reason ?? "route ended")}`} />;
  return null;
}
