/** Shared UI atoms: event lines, diff viewer, buttons — quiet graphite. */

import { useState } from "react";
import { ScrollView, Text, TouchableOpacity, View } from "react-native";
import type { LoomEvent, TaskItem } from "./api";
import { T, hue, radii, selvage, spacing } from "./theme";

/** The one text-input style the whole app uses. */
export const field = {
  backgroundColor: T.raised,
  borderColor: T.line,
  borderWidth: 1,
  borderRadius: radii.input,
  color: T.text,
  paddingHorizontal: 12,
  paddingVertical: 12,
  fontSize: 15,
} as const;

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
export function MetricCard(props: { label: string; value: string; sub?: string; accent?: boolean }) {
  return (
    <View
      style={{
        minWidth: 104,
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
        <Text style={{ color: T.text, fontSize: 13.5, lineHeight: 20 }}>{props.text}</Text>
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
        const add = line.startsWith("+");
        const del = line.startsWith("-");
        const meta = line.startsWith("@@") || line.startsWith("??");
        return (
          <Text
            key={i}
            style={{
              color: add ? T.gitAdd : del ? T.gitDel : meta ? T.dim : T.dim,
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

/** One event in the thread. turn_diff renders as an expandable change card. */
export function EventLine(props: { e: LoomEvent }) {
  const { e } = props;
  const p = e.payload as Record<string, unknown>;
  const [open, setOpen] = useState(false);

  if (e.kind === "message") {
    const author = e.agentId ?? String(p.author ?? "user");
    if (!e.agentId && author === "loom") {
      return <Sys text={`▸ ${String(p.text).split("\n")[0]}`} />;
    }
    const mine = !e.agentId;
    return (
      <View style={{ alignItems: mine ? "flex-end" : "flex-start", marginVertical: 5 }}>
        {!mine && (
          <Text
            style={{
              color: hue(author),
              fontSize: 11,
              fontFamily: T.mono,
              marginBottom: 3,
              marginHorizontal: 4,
              letterSpacing: 0.4,
            }}
          >
            {author}
          </Text>
        )}
        <View
          style={{
            maxWidth: "88%",
            backgroundColor: mine ? T.raised : T.panel,
            borderColor: T.line,
            borderWidth: 1,
            // agent messages carry a selvage edge in their own thread color
            borderLeftWidth: mine ? 1 : 2,
            borderLeftColor: mine ? T.line : selvage(author),
            borderRadius: radii.card,
            borderBottomRightRadius: mine ? 4 : radii.card,
            borderBottomLeftRadius: mine ? radii.card : 4,
            paddingVertical: 9,
            paddingHorizontal: 13,
          }}
        >
          <Text style={{ color: T.text, fontSize: 14, lineHeight: 21 }}>
            {String(p.text ?? "")}
          </Text>
        </View>
      </View>
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

  if (e.kind === "tool_call") return <Sys color={T.faint} text={`⚙ ${String(p.summary ?? p.tool ?? "tool")}`} />;
  if (e.kind === "file_edit") return <Sys color={T.faint} text={`✎ ${String(p.path ?? "")}`} />;
  if (e.kind === "handoff")
    return <Sys color={T.shuttle} text={`${String(p.from ?? "—")}  ⟿  ${String(p.to ?? "—")}`} />;
  if (e.kind === "needs_input")
    return <Sys color={T.warn} text={`⏸ ${e.agentId} asks: ${String(p.question ?? "")}`} />;
  if (e.kind === "suggestion") return <Sys color={T.warn} text={`✦ ${String(p.reason ?? "")}`} />;
  if (e.kind === "decision") return <Sys text={`★ ${String(p.text ?? "")}`} />;
  if (e.kind === "memory_import")
    return <Sys color={T.thread} text={`◈ imported ${String(p.file ?? "")} into the shared brain`} />;
  if (e.kind === "error") return <Sys color={T.err} text={`✗ ${String(p.message ?? "error")}`} />;
  if (e.kind === "run_complete") return <Sys color={T.faint} text={`✓ ${e.agentId} done`} />;
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
  open: T.ok,
  closed: T.err,
  merged: T.shuttle,
  draft: T.dim,
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
