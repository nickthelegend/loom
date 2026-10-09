/** Shared UI atoms: event lines, diff viewer, buttons — quiet graphite. */

import { useState } from "react";
import * as Clipboard from "expo-clipboard";
import { Alert, Pressable, ScrollView, Share, Text, TouchableOpacity, View } from "react-native";
import { haptic } from "./haptics";
import type { LoomEvent, TaskItem } from "./api";
import type { LiveMap } from "./live-model";
import { AgentIcon, agentLabel } from "./agents";
import { summarizeTools } from "./fold-model";
import { Markdown } from "./markdown";
import { T, hue, onScheme, radii, selvage, spacing } from "./theme";

/** The one text-input style the whole app uses. */
export const field = {
  backgroundColor: T.raised as string,
  borderColor: T.line as string,
  borderWidth: 1,
  borderRadius: radii.input,
  color: T.text as string,
  paddingHorizontal: 12,
  paddingVertical: 12,
  fontSize: 15,
};
// Plain values (spread into styles everywhere), re-filled when the phone
// switches between light and dark.
onScheme(() => {
  field.backgroundColor = T.raised;
  field.borderColor = T.line;
  field.color = T.text;
});

/**
 * 44pt is the floor for anything you tap. Every control in the new panels
 * either sets this or sits inside a row that does — a phone is not a mouse.
 */
export const TAP = 44;

/** "12.4k" — token counts are the one place a phone can't afford full digits. */
export const tok = (n: number): string =>
  n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n);

/** Durations, rolled up so a 40-minute turn doesn't read as "2400000ms". */
export function dur(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "0s";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0)}s`;
  const m = s / 60;
  if (m < 60) return `${Math.floor(m)}m ${Math.round(s % 60)}s`;
  return `${Math.floor(m / 60)}h ${Math.round(m % 60)}m`;
}

/** Long ids and model names truncate in the middle — both ends carry meaning. */
export function trunc(s: string, max: number): string {
  if (s.length <= max) return s;
  const head = Math.ceil((max - 1) / 2);
  return `${s.slice(0, head)}…${s.slice(s.length - (max - 1 - head))}`;
}

export function SectionLabel(props: { text: string; style?: { marginTop?: number } }) {
  return (
    <Text
      style={{
        color: T.faint,
        fontSize: 10,
        fontFamily: T.mono,
        fontWeight: "600",
        letterSpacing: 0.6,
        textTransform: "uppercase",
        marginTop: props.style?.marginTop,
      }}
    >
      {props.text}
    </Text>
  );
}

/** A labelled metric tile. Value is the one loud thing; accent turns it violet. */
export function MetricCard(props: { label: string; value: string; sub?: string; accent?: boolean; width?: number | `${number}%` }) {
  return (
    <View
      style={{
        minWidth: 104,
        ...(props.width ? { width: props.width } : {}),
        backgroundColor: T.panel,
        borderWidth: 1,
        borderColor: props.accent ? T.primaryDim : T.line,
        borderRadius: radii.card,
        paddingVertical: 11,
        paddingHorizontal: 13,
        gap: 3,
      }}
    >
      <Text style={{ color: T.faint, fontSize: 9.5, fontFamily: T.mono, letterSpacing: 0.6, textTransform: "uppercase" }}>
        {props.label}
      </Text>
      <Text style={{ color: props.accent ? T.primary : T.text, fontSize: 20, fontWeight: "700" }} numberOfLines={1}>
        {props.value}
      </Text>
      {props.sub ? (
        <Text style={{ color: T.faint, fontSize: 10, fontFamily: T.mono }} numberOfLines={1}>
          {props.sub}
        </Text>
      ) : null}
    </View>
  );
}

export function Badge(props: { text: string; tint?: string }) {
  const c = props.tint ?? T.dim;
  return (
    <View
      style={{
        borderWidth: 1,
        borderColor: props.tint ? c : T.line2,
        borderRadius: radii.pill,
        paddingHorizontal: 9,
        paddingVertical: 2,
      }}
    >
      <Text style={{ color: c, fontSize: 10, fontFamily: T.mono, letterSpacing: 0.3 }} numberOfLines={1}>
        {props.text}
      </Text>
    </View>
  );
}

export function Callout(props: { label: string; text: string; tint: string }) {
  return (
    <View style={{ gap: 5 }}>
      <SectionLabel text={props.label} />
      <View
        style={{
          backgroundColor: T.panel,
          borderWidth: 1,
          borderColor: T.line,
          borderLeftWidth: 2,
          borderLeftColor: props.tint,
          borderRadius: radii.card,
          padding: 12,
        }}
      >
        {/* agents write these, in markdown */}
        <Markdown text={props.text} />
      </View>
    </View>
  );
}

/** The card every new panel sits in — one border, one radius, one padding. */
export function Panel(props: { children: React.ReactNode; tint?: string; padded?: boolean }) {
  return (
    <View
      style={{
        backgroundColor: T.panel,
        borderWidth: 1,
        borderColor: props.tint ?? T.line,
        borderRadius: radii.card,
        padding: props.padded === false ? 0 : 12,
        gap: 8,
      }}
    >
      {props.children}
    </View>
  );
}

/**
 * The one thing every panel here does when the daemon can't be reached: say so,
 * say what failed, and offer the retry. A blank panel is indistinguishable from
 * "there is genuinely nothing", which is the lie this exists to prevent.
 */
export function Unreachable(props: { what: string; detail: string; onRetry: () => void }) {
  return (
    <View
      style={{
        backgroundColor: T.panel,
        borderWidth: 1,
        borderColor: T.line,
        borderLeftWidth: 2,
        borderLeftColor: T.err,
        borderRadius: radii.card,
        padding: 14,
        gap: 8,
      }}
    >
      <Text style={{ color: T.text, fontSize: 13.5, fontWeight: "600" }}>Couldn&apos;t load {props.what}</Text>
      <Text style={{ color: T.dim, fontSize: 12, fontFamily: T.mono, lineHeight: 18 }}>{props.detail}</Text>
      <TouchableOpacity
        onPress={props.onRetry}
        activeOpacity={0.7}
        accessibilityRole="button"
        accessibilityLabel={`Retry loading ${props.what}`}
        style={{
          alignSelf: "flex-start",
          minHeight: TAP,
          justifyContent: "center",
          paddingHorizontal: 18,
          borderWidth: 1,
          borderColor: T.line2,
          backgroundColor: T.raised,
          borderRadius: radii.key,
        }}
      >
        <Text style={{ color: T.text, fontSize: 13, fontWeight: "600" }}>Retry</Text>
      </TouchableOpacity>
    </View>
  );
}

/**
 * An empty state that names the thing that would fill it. Charts get this, never
 * a decorative placeholder — a fake sparkline on an empty run is a lie with a
 * gradient on it.
 */
export function Empty(props: { text: string }) {
  return (
    <View
      style={{
        borderWidth: 1,
        borderColor: T.line,
        borderStyle: "dashed",
        borderRadius: radii.card,
        paddingVertical: 22,
        paddingHorizontal: 16,
      }}
    >
      <Text style={{ color: T.faint, fontSize: 12, lineHeight: 19, textAlign: "center" }}>
        {props.text}
      </Text>
    </View>
  );
}

/** A horizontally scrolling pill row — the sub-view switcher for every new tab. */
export function Segmented<K extends string>(props: {
  options: ReadonlyArray<{ key: K; label: string }>;
  value: K;
  onChange: (k: K) => void;
  accent?: string;
}) {
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      style={{ flexGrow: 0 }}
      contentContainerStyle={{ gap: 6, paddingHorizontal: spacing.md, paddingVertical: 8 }}
    >
      {props.options.map((o) => {
        const on = o.key === props.value;
        return (
          <TouchableOpacity
            key={o.key}
            onPress={() => props.onChange(o.key)}
            activeOpacity={0.7}
            accessibilityRole="tab"
            accessibilityState={{ selected: on }}
            style={{
              minHeight: 34,
              justifyContent: "center",
              paddingHorizontal: 13,
              borderRadius: radii.pill,
              backgroundColor: on ? T.raised : "transparent",
              borderWidth: 1,
              borderColor: on ? (props.accent ?? T.line2) : T.line,
            }}
          >
            <Text style={{ color: on ? T.text : T.dim, fontSize: 12.5, fontWeight: "600" }}>
              {o.label}
            </Text>
          </TouchableOpacity>
        );
      })}
    </ScrollView>
  );
}

/**
 * Buttons follow Orca mobile: the one primary action per screen is a
 * near-white fill with dark text; everything else is a raised neutral key.
 */
export function Btn(props: {
  label: string;
  onPress: () => void;
  primary?: boolean;
  small?: boolean;
}) {
  return (
    <TouchableOpacity
      onPress={props.onPress}
      activeOpacity={0.7}
      style={{
        backgroundColor: props.primary ? T.bright : T.raised,
        borderColor: props.primary ? T.bright : T.line,
        borderWidth: 1,
        borderRadius: props.small ? radii.key : 8,
        paddingVertical: props.small ? 5 : 11,
        paddingHorizontal: props.small ? 10 : 16,
      }}
    >
      <Text
        style={{
          color: props.primary ? T.onBright : T.text,
          fontWeight: props.primary ? "700" : "500",
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
    <Text
      style={{
        color: props.color ?? T.dim,
        fontSize: 12,
        fontFamily: T.mono,
        textAlign: "center",
        marginVertical: 8,
        letterSpacing: 0.2,
      }}
    >
      {props.text}
    </Text>
  );
}

/** Unified diff with +/− washes; used by turn cards and the Changes tab. */
export function DiffView(props: { patch: string; maxHeight?: number }) {
  const lines = props.patch.split("\n");
  return (
    <ScrollView
      style={{
        maxHeight: props.maxHeight ?? 320,
        backgroundColor: T.editor,
        borderRadius: radii.row,
        borderWidth: 1,
        borderColor: T.line,
      }}
      contentContainerStyle={{ paddingVertical: 6 }}
      nestedScrollEnabled
    >
      {lines.map((line, i) => {
        // git's per-file header collapses to the path, in bold; a phone has no room for the rest
        const file = /^diff --git a\/.+ b\/(.+)$/.exec(line);
        if (file)
          return (
            <Text key={i} style={{ color: T.text, fontFamily: T.mono, fontSize: 11.5, fontWeight: "700", paddingHorizontal: 8, paddingTop: i ? 10 : 2, paddingBottom: 2 }}>
              {file[1]}
            </Text>
          );
        if (/^(index |--- |\+\+\+ |new file mode|deleted file mode|old mode|new mode|similarity index|rename (from|to) )/.test(line)) return null;
        const nf = /^\?\? new file: (.+?)( \(binary\))?$/.exec(line);
        if (nf)
          return (
            <Text key={i} style={{ color: T.gitAdd, fontFamily: T.mono, fontSize: 11.5, fontWeight: "700", paddingHorizontal: 8, paddingTop: i ? 10 : 2 }}>
              {nf[1]} <Text style={{ color: T.faint, fontWeight: "400" }}>{nf[2] ? "new · binary" : "new"}</Text>
            </Text>
          );
        // the blank line git leaves at a file's end; the next header brings its own space
        if (!line && /^(diff --git |\?\? new file: )/.test(lines[i + 1] ?? "")) return null;
        const add = line.startsWith("+");
        const del = line.startsWith("-");
        const meta = line.startsWith("@@");
        return (
          <Text
            key={i}
            style={{
              color: add ? T.gitAdd : del ? T.gitDel : meta ? T.faint : T.dim,
              backgroundColor: add ? T.diffAddBg : del ? T.diffDelBg : "transparent",
              fontFamily: T.mono,
              fontSize: 11,
              lineHeight: 17,
              paddingHorizontal: 8,
            }}
          >
            {line || " "}
          </Text>
        );
      })}
    </ScrollView>
  );
}

/**
 * Replies being typed right now, under the thread: the agent's words as they
 * arrive (or "thinking" before the first), until the finished message lands
 * in the list and takes their place.
 */
export function LiveReplies(props: { live: LiveMap }) {
  const ids = Object.keys(props.live).filter((id) => props.live[id]!.text || props.live[id]!.thinking);
  if (!ids.length) return null;
  return (
    <View>
      {ids.map((id) => {
        const l = props.live[id]!;
        return (
          <View key={id} style={{ alignItems: "flex-start", marginVertical: 5 }}>
            <Text style={{ color: hue(id), fontSize: 11, fontFamily: T.mono, marginBottom: 3, marginHorizontal: 4, letterSpacing: 0.4 }}>
              {id}
              <Text style={{ color: T.faint }}>{l.text ? "  writing…" : "  thinking…"}</Text>
            </Text>
            {!!l.text && (
              <View
                style={{
                  maxWidth: "88%",
                  backgroundColor: T.panel,
                  borderColor: T.line,
                  borderWidth: 1,
                  borderLeftWidth: 2,
                  borderLeftColor: selvage(id),
                  borderRadius: radii.card,
                  borderBottomLeftRadius: 4,
                  paddingVertical: 9,
                  paddingHorizontal: 13,
                }}
              >
                <Markdown text={l.text + " ▍"} />
              </View>
            )}
          </View>
        );
      })}
    </View>
  );
}

/** Long-press a message: copy it, or hand it to another app. */
function messageActions(text: string, who: string): void {
  haptic.tap();
  Alert.alert(who, text.length > 140 ? text.slice(0, 140) + "…" : text, [
    { text: "Copy", onPress: () => void Clipboard.setStringAsync(text) },
    { text: "Share…", onPress: () => void Share.share({ message: text }).catch(() => {}) },
    { text: "Cancel", style: "cancel" },
  ]);
}

/** One event in the thread. turn_diff renders as an expandable change card. */
const toolFailed = (p: Record<string, unknown>) => p.ok === false || !!p.error || (typeof p.exitCode === "number" && p.exitCode !== 0);
const tokText = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n));
const usdText = (n: number) => (n >= 0.01 ? `$${n.toFixed(2)}` : `$${n.toFixed(4)}`);

/** One tool call: what it touched, and whether it failed. */
function ToolLine(props: { p: Record<string, unknown>; inGroup?: boolean }) {
  const p = props.p;
  const failed = toolFailed(p);
  const why = typeof p.exitCode === "number" && p.exitCode !== 0 ? ` · exit ${p.exitCode}` : failed ? " · failed" : "";
  const imgs = Array.isArray(p.images) ? p.images.length : 0;
  return (
    <View style={{ flexDirection: "row", gap: 7, paddingLeft: props.inGroup ? 10 : 30, marginVertical: props.inGroup ? 1 : 3 }}>
      <Text style={{ color: failed ? T.err : T.faint, fontSize: 11.5, fontFamily: T.mono }}>{failed ? "✗" : "›"}</Text>
      <Text style={{ color: failed ? T.err : T.dim, fontSize: 12, fontFamily: T.mono, flexShrink: 1 }} numberOfLines={2}>
        {p.server ? `${String(p.server)} · ` : ""}
        {String(p.summary ?? p.tool ?? "tool")}
        {why}
        {imgs ? ` · ${imgs} image${imgs === 1 ? "" : "s"}` : ""}
      </Text>
    </View>
  );
}

export function EventLine(props: { e: LoomEvent; kindOf?: (agentId: string) => string | undefined }) {
  const { e } = props;
  const p = e.payload as Record<string, unknown>;
  const [open, setOpen] = useState(false);

  if (e.kind === "message") {
    const author = e.agentId ?? String(p.author ?? "user");
    if (!e.agentId && author === "loom") {
      return <Sys text={`▸ ${String(p.text).split("\n")[0]}`} />;
    }
    const mine = !e.agentId;
    const text = String(p.text ?? "");
    // as on the desktop: your message is a card; an agent's reply is its logo
    // and name over plain text, no bubble
    if (mine)
      return (
        <Pressable
          delayLongPress={350}
          onLongPress={() => messageActions(text, "Your message")}
          accessibilityHint="long-press to copy or share"
          style={{
            alignSelf: "flex-end",
            maxWidth: "92%",
            marginVertical: 8,
            backgroundColor: T.panel,
            borderColor: T.line,
            borderWidth: 1,
            borderRadius: 12,
            paddingVertical: 10,
            paddingHorizontal: 14,
          }}
        >
          <Text style={{ color: T.text, fontSize: 14.5, lineHeight: 22 }}>{text}</Text>
        </Pressable>
      );
    const kind = props.kindOf?.(author) ?? author;
    return (
      <Pressable
        delayLongPress={350}
        onLongPress={() => messageActions(text, agentLabel(kind))}
        accessibilityHint="long-press to copy or share"
        style={{ marginTop: 10, marginBottom: 2, gap: 6 }}
      >
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <AgentIcon kind={kind} size={22} />
          <Text style={{ color: T.text, fontSize: 13.5, fontWeight: "700" }}>{agentLabel(kind)}</Text>
          {author !== kind && author !== agentLabel(kind) ? <Text style={{ color: T.faint, fontSize: 12 }}>{author}</Text> : null}
        </View>
        <View style={{ paddingLeft: 30 }}>
          <Markdown text={text} />
          {p.partial === true && (
            <Text style={{ color: T.faint, fontSize: 11, marginTop: 6 }}>stopped — this is what it had written</Text>
          )}
        </View>
      </Pressable>
    );
  }

  if (e.kind === "turn_diff") {
    const files = (p.files as Array<{ path: string }> | undefined) ?? [];
    return (
      <TouchableOpacity
        onPress={() => setOpen(!open)}
        activeOpacity={0.7}
        style={{
          backgroundColor: T.panel,
          borderColor: T.line,
          borderWidth: 1,
          borderRadius: radii.card,
          padding: 11,
          marginVertical: 6,
          gap: 4,
        }}
      >
        <Text style={{ color: T.text, fontSize: 12, fontWeight: "600" }}>
          this prompt changed {files.length} file{files.length === 1 ? "" : "s"}{"  "}
          <Text style={{ color: T.gitAdd }}>+{Number(p.added ?? 0)}</Text>{" "}
          <Text style={{ color: T.gitDel }}>−{Number(p.removed ?? 0)}</Text>{" "}
          <Text style={{ color: T.faint }}>{open ? "▾" : "▸"}</Text>
        </Text>
        <Text style={{ color: T.dim, fontSize: 11, fontFamily: T.mono }}>
          {files.slice(0, 4).map((f) => f.path).join(", ")}
          {files.length > 4 ? " …" : ""}
        </Text>
        {open && <DiffView patch={String(p.patch ?? "")} maxHeight={280} />}
      </TouchableOpacity>
    );
  }

  if (e.kind === "tool_call") return <ToolLine p={p} />;
  if ((e.kind as string) === "tool_group") {
    const calls = (p.calls as LoomEvent[] | undefined) ?? [];
    const failed = calls.filter((c) => toolFailed(c.payload as Record<string, unknown>)).length;
    return (
      <View style={{ paddingLeft: 30, marginVertical: 3 }}>
        <TouchableOpacity
          onPress={() => setOpen(!open)}
          activeOpacity={0.7}
          accessibilityRole="button"
          accessibilityState={{ expanded: open }}
          style={{ flexDirection: "row", alignItems: "center", gap: 6, alignSelf: "flex-start", paddingVertical: 5, paddingHorizontal: 10,
            borderRadius: 8, borderWidth: 1, borderColor: T.line, backgroundColor: T.panel }}
        >
          <Text style={{ color: T.faint, fontSize: 11 }}>{open ? "▾" : "›"}</Text>
          <Text style={{ color: T.dim, fontSize: 12.5, fontWeight: "600" }}>{summarizeTools(calls)}</Text>
          {failed ? <Text style={{ color: T.err, fontSize: 12 }}>· {failed} failed</Text> : null}
        </TouchableOpacity>
        {open ? (
          <View style={{ marginTop: 4, gap: 2 }}>
            {calls.map((c) => (
              <ToolLine key={c.id} p={c.payload as Record<string, unknown>} inGroup />
            ))}
          </View>
        ) : null}
      </View>
    );
  }
  if (e.kind === "status" && p.state === "plan_updated" && Array.isArray(p.plan) && p.plan.length) {
    // the desktop's checklist: filled when done, a ring while waiting, half while on it
    const plan = p.plan as Array<{ step?: string; status?: string }>;
    const done = plan.filter((x) => x.status === "completed").length;
    return (
      <View style={{ marginLeft: 30, marginVertical: 6, borderRadius: 12, borderWidth: 1, borderColor: T.line, backgroundColor: T.panel, overflow: "hidden" }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 12, paddingVertical: 9, borderBottomWidth: 1, borderBottomColor: T.line, backgroundColor: T.raised }}>
          <Text style={{ color: T.dim, fontSize: 13 }}>☰</Text>
          <Text style={{ color: T.text, fontSize: 13, fontWeight: "600", flex: 1 }}>Plan</Text>
          <Text style={{ color: T.faint, fontSize: 12, fontFamily: T.mono }}>{done}/{plan.length}</Text>
        </View>
        <View style={{ paddingHorizontal: 12, paddingVertical: 8, gap: 6 }}>
          {plan.map((x, i) => {
            const st = x.status === "completed" ? "done" : x.status === "inProgress" || x.status === "in_progress" ? "on" : "todo";
            return (
              <View key={i} style={{ flexDirection: "row", alignItems: "flex-start", gap: 9 }}>
                <View style={{ width: 14, height: 14, borderRadius: 7, marginTop: 2.5, borderWidth: 1.5,
                  borderColor: st === "todo" ? T.line2 : T.ok, backgroundColor: st === "done" ? T.ok : "transparent", overflow: "hidden" }}>
                  {st === "on" ? <View style={{ width: 5.5, height: "100%", backgroundColor: T.ok }} /> : null}
                </View>
                <Text style={{ color: st === "done" ? T.faint : T.text, fontSize: 13.5, lineHeight: 19, flex: 1,
                  textDecorationLine: st === "done" ? "line-through" : "none", fontWeight: st === "on" ? "600" : "400" }}>
                  {String(x.step ?? "")}
                </Text>
              </View>
            );
          })}
        </View>
      </View>
    );
  }
  if (e.kind === "file_edit") return <Sys color={T.faint} text={`✎ ${String(p.path ?? "")}`} />;
  if (e.kind === "handoff")
    return <Sys color={T.shuttle} text={`${String(p.from ?? "—")}  ⟿  ${String(p.to ?? "—")}`} />;
  if (e.kind === "needs_input") {
    // a plain question (no answer card): you reply in the composer
    const kind = props.kindOf?.(String(e.agentId ?? "")) ?? String(e.agentId ?? "");
    return (
      <View style={{ marginLeft: 30, marginVertical: 6, borderRadius: 12, borderWidth: 1, borderColor: T.warn, backgroundColor: T.panel, padding: 12, gap: 5 }}>
        <Text style={{ color: T.warn, fontSize: 11, fontWeight: "700", letterSpacing: 0.4 }}>NEEDS YOU · {agentLabel(kind).toUpperCase()}</Text>
        <Text style={{ color: T.text, fontSize: 14, lineHeight: 20 }}>{String(p.question ?? "")}</Text>
      </View>
    );
  }
  if (e.kind === "suggestion") return <Sys color={T.warn} text={`✦ ${String(p.reason ?? "")}`} />;
  if (e.kind === "decision") return <Sys text={`★ ${String(p.text ?? "")}`} />;
  if (e.kind === "memory_import")
    return <Sys color={T.thread} text={`◈ imported ${String(p.file ?? "")} into the shared brain`} />;
  if (e.kind === "error") return <Sys color={T.err} text={`✗ ${String(p.message ?? "error")}`} />;
  if (e.kind === "run_complete") {
    // the desktop's turn footer: who, how long, and what it cost
    const kind = props.kindOf?.(String(e.agentId ?? "")) ?? String(e.agentId ?? "");
    const bits = [agentLabel(kind)];
    if (p.durationMs) bits.push(dur(Number(p.durationMs)));
    if (p.model) bits.push(String(p.model));
    if (Number(p.costUsd) > 0) bits.push(usdText(Number(p.costUsd)));
    if (Number(p.outputTokens) > 0) bits.push(`${tokText(Number(p.outputTokens))} tokens out`);
    return (
      <View style={{ flexDirection: "row", alignItems: "center", gap: 7, paddingLeft: 30, marginTop: 4, marginBottom: 10 }}>
        <View style={{ width: 15, height: 15, borderRadius: 8, borderWidth: 1.2, borderColor: T.ok, alignItems: "center", justifyContent: "center" }}>
          <Text style={{ color: T.ok, fontSize: 9, fontWeight: "800", marginTop: -1 }}>✓</Text>
        </View>
        <Text style={{ color: T.faint, fontSize: 11.5, flexShrink: 1 }} numberOfLines={1}>{bits.join(" · ")}</Text>
      </View>
    );
  }
  if (e.kind === "route_started") return <Sys text={`▸ route started`} />;
  if (e.kind === "route_step")
    return <Sys text={`▸ hop ${Number(p.step) + 1} → ${String(p.agent)}${p.reason ? ` (${String(p.reason)})` : ""}`} />;
  if (e.kind === "route_paused")
    return <Sys color={T.warn} text={`⏸ route paused — ${String(p.question ?? "")}`} />;
  if (e.kind === "route_resumed") return <Sys text="▸ route resumed" />;
  if (e.kind === "route_completed") return <Sys color={T.ok} text="✓ route completed" />;
  if (e.kind === "route_failed")
    return <Sys color={p.aborted ? T.warn : T.err} text={`⊘ ${String(p.reason ?? "route ended")}`} />;
  return null;
}

/** "2 hours ago" — the phone has no room for a timestamp. */
export function ago(iso: string): string {
  const t = new Date(iso).getTime();
  // an unparseable date compares false against every bound below and would
  // fall through to "NaNy ago"; say nothing instead
  if (!Number.isFinite(t)) return "";
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 60) return "just now";
  const m = s / 60;
  if (m < 60) return `${Math.floor(m)}m ago`;
  const h = m / 60;
  if (h < 24) return `${Math.floor(h)}h ago`;
  const d = h / 24;
  if (d < 30) return `${Math.floor(d)}d ago`;
  const mo = d / 30;
  return mo < 12 ? `${Math.floor(mo)}mo ago` : `${Math.floor(mo / 12)}y ago`;
}

// the only colour in a task row is state — shuttle magenta for merged, the
// same token the baton uses everywhere else
const STATE_COLOR: Record<string, string> = {
  get open() {
    return T.ok;
  },
  get closed() {
    return T.err;
  },
  get merged() {
    return T.shuttle;
  },
  get draft() {
    return T.dim;
  },
};

/**
 * One issue/PR. Tapping it hands the issue to an agent — the whole reason
 * Tasks is on the phone: see it, start it, put the phone away.
 * Labels wear the colours GitHub reports; everything else stays graphite.
 */
export function TaskRow(props: { item: TaskItem; onStart: (item: TaskItem) => void; busy?: boolean }) {
  const { item } = props;
  const st = item.draft ? "draft" : item.state;
  const color = STATE_COLOR[st] ?? T.dim;
  return (
    <TouchableOpacity
      onPress={() => props.onStart(item)}
      activeOpacity={0.7}
      disabled={props.busy}
      accessibilityRole="button"
      accessibilityLabel={`Start ${item.kind === "pr" ? "PR" : "issue"} ${item.id}: ${item.title}`}
      style={{
        backgroundColor: T.panel,
        borderWidth: 1,
        borderColor: T.line,
        borderRadius: radii.card,
        padding: spacing.md,
        marginBottom: spacing.sm,
        opacity: props.busy ? 0.5 : 1,
      }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm }}>
        <Text style={{ color, fontFamily: T.mono, fontSize: 11 }}>
          {item.kind === "pr" ? "⑂" : "◉"} #{item.id}
        </Text>
        <View
          style={{
            borderWidth: 1,
            borderColor: color,
            borderRadius: radii.pill,
            paddingHorizontal: 6,
            paddingVertical: 1,
          }}
        >
          <Text style={{ color, fontSize: 9, fontWeight: "600" }}>
            {st.charAt(0).toUpperCase() + st.slice(1)}
          </Text>
        </View>
        <Text style={{ color: T.faint, fontSize: 10, fontFamily: T.mono, marginLeft: "auto" }}>
          {ago(item.updatedAt)}
        </Text>
      </View>
      <Text style={{ color: T.text, fontSize: 14, fontWeight: "600", marginTop: 6 }} numberOfLines={2}>
        {item.title}
      </Text>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 6, marginTop: 6, flexWrap: "wrap" }}>
        <Text style={{ color: T.dim, fontSize: 11, fontFamily: T.mono }}>{item.author}</Text>
        {item.labels.slice(0, 2).map((l) => {
          // sanitise: a label name is attacker-controlled on any repo you read
          const hex = /^[0-9a-fA-F]{3}$|^[0-9a-fA-F]{6}$/.test(l.color) ? `#${l.color}` : T.dim;
          return (
            <View
              key={l.name}
              style={{
                borderWidth: 1,
                borderColor: hex,
                borderRadius: radii.pill,
                paddingHorizontal: 6,
                paddingVertical: 1,
              }}
            >
              <Text style={{ color: hex, fontSize: 9 }} numberOfLines={1}>
                {l.name}
              </Text>
            </View>
          );
        })}
        <Text style={{ color: T.faint, fontSize: 11, marginLeft: "auto" }}>start →</Text>
      </View>
    </TouchableOpacity>
  );
}
