/**
 * Approvals: an agent in "Always ask" mode wants to run a tool, and the turn
 * is parked until a human says yes or no. On a phone this is the whole point —
 * approve from your pocket, put the phone away.
 *
 * The card shows who, which tool and exactly what it would run, then two big
 * answers. Deny can carry a reason, which the agent reads. Once answered —
 * here, on the desktop, or by the daemon's 30-minute timeout — the card folds
 * to one line.
 */

import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Text, TextInput, TouchableOpacity, View } from "react-native";
import { decideApproval, getApprovals, type Approval, type Creds, type LoomEvent } from "./api";
import { AgentIcon } from "./agents";
import { Empty, SectionLabel, TAP, Unreachable, ago, field } from "./components";
import { Sheet } from "./observatory";
import { T, radii, spacing } from "./theme";

export interface ApprovalOutcome {
  behavior: "allow" | "deny" | "gone";
  message?: string;
}

/** approvalId → how it was decided, folded from the thread's `approval` events. */
export function approvalDecisions(events: LoomEvent[]): Map<string, ApprovalOutcome> {
  const out = new Map<string, ApprovalOutcome>();
  for (const e of events) {
    if (e.kind !== "approval" || e.payload?.phase !== "decided") continue;
    const id = String(e.payload.approvalId ?? "");
    if (!id) continue;
    out.set(id, {
      behavior: e.payload.behavior === "allow" ? "allow" : "deny",
      ...(typeof e.payload.message === "string" ? { message: e.payload.message } : {}),
    });
  }
  return out;
}

/**
 * The input arrives as a JSON string on events (cut at 4000 chars, so it may
 * not parse) and as an object from GET. Either way: one headline for the tool's
 * most telling field, and the whole thing pretty-printed beneath.
 */
export function formatInput(input: unknown): { headline: string | null; body: string } {
  let value: unknown = input;
  if (typeof input === "string") {
    try {
      value = JSON.parse(input);
    } catch {
      return { headline: null, body: input };
    }
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const o = value as Record<string, unknown>;
    const key = ["command", "file_path", "path", "url", "pattern", "query", "description"].find(
      (k) => typeof o[k] === "string" && (o[k] as string).trim(),
    );
    const body = JSON.stringify(value, null, 2);
    return { headline: key ? String(o[key]) : null, body: body === "{}" ? "" : body };
  }
  return { headline: null, body: JSON.stringify(value, null, 2) ?? "" };
}

const COLLAPSED_LINES = 6;

export function ApprovalCard(props: {
  creds: Creds;
  projectId: string;
  approvalId: string;
  agent: string;
  /** The agent's kind for the icon; falls back to its id. */
  kind?: string;
  tool: string;
  input: unknown;
  createdAt?: number;
  /** Set when the thread already carries the decision. */
  decided?: ApprovalOutcome;
  /** A label above the card — the project name in the cross-project list. */
  context?: string;
  onDecided?: (outcome: ApprovalOutcome) => void;
}) {
  const [local, setLocal] = useState<ApprovalOutcome | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [denying, setDenying] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState<"allow" | "deny" | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const outcome = props.decided ?? local;
  const { headline, body } = formatInput(props.input);

  const decide = async (decision: "allow" | "deny") => {
    if (busy) return;
    setErr(null);
    setBusy(decision);
    const message = decision === "deny" ? reason.trim() : "";
    try {
      await decideApproval(props.creds, props.projectId, props.approvalId, decision, message || undefined);
      const o: ApprovalOutcome = { behavior: decision, ...(message ? { message } : {}) };
      setLocal(o);
      props.onDecided?.(o);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // 404: answered elsewhere (desktop, another phone, the timeout). Not an error to you.
      if (/no such approval|already answered|HTTP 404/i.test(msg)) {
        const o: ApprovalOutcome = { behavior: "gone" };
        setLocal(o);
        props.onDecided?.(o);
      } else setErr(msg);
    } finally {
      setBusy(null);
    }
  };

  if (outcome) {
    const look =
      outcome.behavior === "allow"
        ? { glyph: "✓", text: "Allowed", color: T.ok }
        : outcome.behavior === "deny"
          ? { glyph: "✕", text: "Denied", color: T.err }
          : { glyph: "–", text: "Already answered", color: T.faint };
    return (
      <View
        accessibilityLabel={`${look.text}: ${props.agent} ${props.tool}`}
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: 8,
          marginVertical: 5,
          paddingVertical: 8,
          paddingHorizontal: 12,
          borderRadius: radii.card,
          borderWidth: 1,
          borderColor: T.line,
          backgroundColor: T.panel,
        }}
      >
        <Text style={{ color: look.color, fontSize: 12, fontFamily: T.mono, fontWeight: "700" }}>
          {look.glyph} {look.text}
        </Text>
        <Text style={{ color: T.dim, fontSize: 12, fontFamily: T.mono, flex: 1 }} numberOfLines={1}>
          {props.tool}
          {headline ? ` · ${headline}` : ""}
          {outcome.message ? ` — ${outcome.message}` : ""}
        </Text>
      </View>
    );
  }

  const lines = body.split("\n");
  const long = lines.length > COLLAPSED_LINES;
  const shown = expanded || !long ? body : lines.slice(0, COLLAPSED_LINES).join("\n");

  return (
    <View
      style={{
        marginVertical: 6,
        backgroundColor: T.panel,
        borderWidth: 1,
        borderColor: T.line,
        borderLeftWidth: 2,
        borderLeftColor: T.warn,
        borderRadius: radii.card,
        padding: spacing.md,
        gap: 10,
      }}
    >
      {props.context ? <SectionLabel text={props.context} /> : null}
      <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
        <AgentIcon kind={props.kind ?? props.agent} size={28} />
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={{ color: T.text, fontSize: 14, fontWeight: "600" }} numberOfLines={1}>
            {props.agent} wants to run <Text style={{ fontFamily: T.mono, color: T.warn }}>{props.tool}</Text>
          </Text>
          <Text style={{ color: T.faint, fontSize: 11, fontFamily: T.mono, marginTop: 2 }} numberOfLines={1}>
            waiting for you{props.createdAt ? ` · ${ago(new Date(props.createdAt).toISOString())}` : ""}
          </Text>
        </View>
      </View>

      {headline ? (
        <Text
          style={{ color: T.text, fontSize: 13, fontFamily: T.mono, lineHeight: 19 }}
          numberOfLines={expanded ? undefined : 3}
          selectable
        >
          {headline}
        </Text>
      ) : null}

      {body ? (
        <TouchableOpacity
          onPress={() => long && setExpanded((x) => !x)}
          activeOpacity={long ? 0.7 : 1}
          accessibilityRole={long ? "button" : undefined}
          accessibilityLabel={long ? (expanded ? "Collapse input" : "Show the full input") : undefined}
          style={{
            backgroundColor: T.editor,
            borderWidth: 1,
            borderColor: T.line,
            borderRadius: radii.row,
            paddingVertical: 8,
            paddingHorizontal: 10,
          }}
        >
          <Text style={{ color: T.dim, fontSize: 11, fontFamily: T.mono, lineHeight: 17 }} selectable>
            {shown}
          </Text>
          {long ? (
            <Text style={{ color: T.faint, fontSize: 11, marginTop: 4 }}>
              {expanded ? "▾ less" : `▸ ${lines.length - COLLAPSED_LINES} more lines`}
            </Text>
          ) : null}
        </TouchableOpacity>
      ) : null}

      {denying ? (
        <TextInput
          style={{ ...field, paddingVertical: 10, fontSize: 14 }}
          value={reason}
          onChangeText={setReason}
          autoFocus
          placeholder="Reason (optional) — the agent reads this"
          placeholderTextColor={T.faint}
          selectionColor={T.accentBlue}
          onSubmitEditing={() => void decide("deny")}
          returnKeyType="send"
        />
      ) : null}

      {err ? <Text style={{ color: T.err, fontSize: 12.5 }}>{err}</Text> : null}

      <View style={{ flexDirection: "row", gap: spacing.sm }}>
        <TouchableOpacity
          onPress={() => (denying ? void decide("deny") : setDenying(true))}
          disabled={!!busy}
          activeOpacity={0.7}
          accessibilityRole="button"
          accessibilityLabel={denying ? "Deny now" : "Deny"}
          style={{
            flex: 1,
            minHeight: 50,
            borderRadius: 10,
            borderWidth: 1,
            borderColor: denying ? T.err : T.line2,
            backgroundColor: T.raised,
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          {busy === "deny" ? (
            <ActivityIndicator color={T.err} />
          ) : (
            <Text style={{ color: T.err, fontSize: 16, fontWeight: "700" }}>{denying ? "Send deny" : "Deny"}</Text>
          )}
        </TouchableOpacity>
        {denying ? (
          <TouchableOpacity
            onPress={() => {
              setDenying(false);
              setReason("");
            }}
            accessibilityRole="button"
            accessibilityLabel="Back"
            style={{ minHeight: 50, paddingHorizontal: 14, alignItems: "center", justifyContent: "center" }}
          >
            <Text style={{ color: T.dim, fontWeight: "600" }}>Back</Text>
          </TouchableOpacity>
        ) : (
          <TouchableOpacity
            onPress={() => void decide("allow")}
            disabled={!!busy}
            activeOpacity={0.75}
            accessibilityRole="button"
            accessibilityLabel={`Allow ${props.tool}`}
            style={{
              flex: 1,
              minHeight: 50,
              borderRadius: 10,
              backgroundColor: T.bright,
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            {busy === "allow" ? (
              <ActivityIndicator color={T.onBright} />
            ) : (
              <Text style={{ color: T.onBright, fontSize: 16, fontWeight: "700" }}>Allow</Text>
            )}
          </TouchableOpacity>
        )}
      </View>
    </View>
  );
}

/**
 * One `approval` event in the thread. "requested" is the card (folded when the
 * thread also carries its decision); "decided" renders only when its request
 * scrolled out of the loaded history, so it isn't said twice.
 */
export function ApprovalEvent(props: {
  creds: Creds;
  projectId: string;
  e: LoomEvent;
  decisions: Map<string, ApprovalOutcome>;
  requested: Set<string>;
  kindOf?: (agentId: string) => string | undefined;
  onDecided?: () => void;
}) {
  const p = props.e.payload ?? {};
  const id = String(p.approvalId ?? "");
  const agent = props.e.agentId ?? "agent";
  if (p.phase === "requested") {
    const decided = props.decisions.get(id);
    return (
      <ApprovalCard
        creds={props.creds}
        projectId={props.projectId}
        approvalId={id}
        agent={agent}
        kind={props.kindOf?.(agent)}
        tool={String(p.tool ?? "tool")}
        input={p.input ?? ""}
        createdAt={props.e.ts}
        {...(decided ? { decided } : {})}
        onDecided={props.onDecided}
      />
    );
  }
  if (p.phase === "decided" && !props.requested.has(id)) {
    const allow = p.behavior === "allow";
    return (
      <Text
        style={{
          color: allow ? T.ok : T.err,
          fontSize: 12,
          fontFamily: T.mono,
          textAlign: "center",
          marginVertical: 8,
        }}
      >
        {allow ? "✓" : "✕"} {agent} · {String(p.tool ?? "tool")} {allow ? "allowed" : "denied"}
        {typeof p.message === "string" && p.message ? ` — ${p.message}` : ""}
      </Text>
    );
  }
  return null;
}

/** The "N waiting" strip on the Board and Project screens. Renders nothing at zero. */
export function ApprovalBanner(props: { count: number; onPress: () => void }) {
  if (props.count <= 0) return null;
  return (
    <TouchableOpacity
      onPress={props.onPress}
      activeOpacity={0.7}
      accessibilityRole="button"
      accessibilityLabel={`${props.count} approval${props.count === 1 ? "" : "s"} waiting. Review`}
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 10,
        minHeight: TAP,
        paddingHorizontal: 14,
        borderRadius: radii.card,
        borderWidth: 1,
        borderColor: T.warn,
        backgroundColor: "rgba(245, 158, 11, 0.08)",
      }}
    >
      <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: T.warn }} />
      <Text style={{ color: T.text, fontSize: 14, fontWeight: "600", flex: 1 }}>
        {props.count} approval{props.count === 1 ? "" : "s"} waiting
      </Text>
      <Text style={{ color: T.warn, fontSize: 12.5, fontWeight: "600" }}>Review ›</Text>
    </TouchableOpacity>
  );
}

/**
 * Every pending approval across the given projects, as full cards. Loaded when
 * opened and refreshed every few seconds while open, so a request answered on
 * the desktop drops out here too.
 */
export function ApprovalsSheet(props: {
  creds: Creds;
  projects: ReadonlyArray<{ id: string; name: string }>;
  visible: boolean;
  onClose: () => void;
  /** After any answer, so the caller can refresh its count. */
  onChanged?: () => void;
  kindOf?: (agentId: string) => string | undefined;
}) {
  const [rows, setRows] = useState<Array<{ project: { id: string; name: string }; a: Approval }> | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const key = props.projects.map((p) => p.id).join(",");

  const load = useCallback(async () => {
    try {
      const lists = await Promise.all(
        props.projects.map(async (p) => {
          const { approvals } = await getApprovals(props.creds, p.id).catch(() => ({ approvals: [] as Approval[] }));
          return approvals.map((a) => ({ project: p, a }));
        }),
      );
      setErr(null);
      setRows(lists.flat().sort((x, y) => x.a.createdAt - y.a.createdAt));
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.creds, key]);

  useEffect(() => {
    if (!props.visible) return;
    setRows(null);
    void load();
    const t = setInterval(() => void load(), 4000);
    return () => clearInterval(t);
  }, [props.visible, load]);

  const many = props.projects.length > 1;
  return (
    <Sheet title="Approvals" visible={props.visible} onClose={props.onClose}>
      {err && !rows ? (
        <Unreachable what="approvals" detail={err} onRetry={() => void load()} />
      ) : !rows ? (
        <ActivityIndicator color={T.dim} style={{ marginVertical: 20 }} />
      ) : !rows.length ? (
        <Empty text="Nothing is waiting on you. Agents in Always ask mode park here when they want to run a tool." />
      ) : (
        rows.map(({ project, a }) => (
          <ApprovalCard
            key={a.id}
            creds={props.creds}
            projectId={project.id}
            approvalId={a.id}
            agent={a.agent}
            kind={props.kindOf?.(a.agent)}
            tool={a.tool}
            input={a.input}
            createdAt={a.createdAt}
            {...(many ? { context: project.name } : {})}
            onDecided={() => props.onChanged?.()}
          />
        ))
      )}
    </Sheet>
  );
}
