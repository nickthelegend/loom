/**
 * Orchestra on the phone: one orchestrator agent plans a goal into tasks, many
 * worker agents run them in parallel on their own branches, and the results
 * merge into one integration branch you can apply.
 *
 * The view is event-driven: every step is an `orchestra` event on the project
 * feed, and the parent passes a pulse whenever one arrives so the run is
 * refetched then, not on a timer. A slow poll backs it up while a run is live,
 * because a phone can drop the feed without noticing.
 *
 * Each task has its own chat. Tapping a card opens that thread — the real
 * transcript of the worker — rather than a summary of it.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Linking,
  ScrollView,
  Switch,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import {
  abortOrchestra,
  applyOrchestra,
  deliverOrchestra,
  getOrchestra,
  getOrchestraRun,
  planPath,
  replyOrchestra,
  startOrchestra,
  type Creds,
  type OrchestraRun,
  type OrchestraStatus,
  type OrchestraTask,
  type OrchestraTaskStatus,
  type Project,
} from "./api";
import { AgentIcon, agentLabel } from "./agents";
import { Badge, Callout, Empty, Panel, SectionLabel, TAP, Unreachable, ago, field } from "./components";
import { T, radii, spacing, usd } from "./theme";

const RUN_LOOK: Record<OrchestraStatus, { label: string; color: string }> = {
  starting: { label: "starting", color: T.dim },
  planning: { label: "planning", color: T.primary },
  running: { label: "running", color: T.thread },
  reviewing: { label: "reviewing", color: T.primary },
  waiting_human: { label: "needs you", color: T.warn },
  completed: { label: "completed", color: T.ok },
  failed: { label: "failed", color: T.err },
  aborted: { label: "aborted", color: T.faint },
};

const TASK_LOOK: Record<OrchestraTaskStatus, { label: string; color: string; glyph: string }> = {
  pending: { label: "pending", color: T.faint, glyph: "○" },
  running: { label: "running", color: T.thread, glyph: "◐" },
  done: { label: "merged", color: T.ok, glyph: "●" },
  conflict: { label: "conflict", color: T.warn, glyph: "◆" },
  needs_input: { label: "asks", color: T.warn, glyph: "?" },
  failed: { label: "failed", color: T.err, glyph: "✕" },
  cancelled: { label: "cancelled", color: T.faint, glyph: "–" },
};

const terminal = (s: OrchestraStatus) => s === "completed" || s === "failed" || s === "aborted";

function StatusPill(props: { status: OrchestraStatus }) {
  const look = RUN_LOOK[props.status] ?? RUN_LOOK.starting;
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 6,
        borderWidth: 1,
        borderColor: look.color,
        borderRadius: radii.pill,
        paddingHorizontal: 9,
        paddingVertical: 3,
      }}
    >
      <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: look.color }} />
      <Text style={{ color: look.color, fontSize: 10.5, fontFamily: T.mono, fontWeight: "600" }}>{look.label}</Text>
    </View>
  );
}

/** Tasks finished (merged or ended) over tasks planned; a segmented hairline bar. */
function Progress(props: { tasks: OrchestraTask[] }) {
  const total = props.tasks.length;
  const count = (s: OrchestraTaskStatus[]) => props.tasks.filter((t) => s.includes(t.status)).length;
  const done = count(["done"]);
  const running = count(["running"]);
  const trouble = count(["conflict", "needs_input", "failed"]);
  if (!total) return <Text style={{ color: T.faint, fontSize: 11.5 }}>no tasks planned yet</Text>;
  const seg = (n: number, color: string) =>
    n > 0 ? <View style={{ flex: n, backgroundColor: color }} /> : null;
  return (
    <View style={{ gap: 6 }}>
      <View style={{ flexDirection: "row", height: 6, borderRadius: 3, overflow: "hidden", backgroundColor: T.raised }}>
        {seg(done, T.ok)}
        {seg(running, T.thread)}
        {seg(trouble, T.warn)}
        {seg(total - done - running - trouble, "transparent")}
      </View>
      <Text style={{ color: T.dim, fontSize: 11.5, fontFamily: T.mono }}>
        {done}/{total} merged{running ? ` · ${running} running` : ""}
        {trouble ? ` · ${trouble} need attention` : ""}
      </Text>
    </View>
  );
}

function TaskCard(props: { task: OrchestraTask; onOpen: () => void }) {
  const { task } = props;
  const look = TASK_LOOK[task.status] ?? TASK_LOOK.pending;
  const [open, setOpen] = useState(false);
  const detail = task.error || task.result;
  return (
    <TouchableOpacity
      onPress={props.onOpen}
      onLongPress={() => setOpen((o) => !o)}
      activeOpacity={0.7}
      accessibilityRole="button"
      accessibilityLabel={`${task.title}, ${agentLabel(task.kind)}, ${look.label}. Opens the task's thread`}
      style={{
        backgroundColor: T.panel,
        borderWidth: 1,
        borderColor: T.line,
        borderLeftWidth: 2,
        borderLeftColor: look.color,
        borderRadius: radii.card,
        padding: spacing.md,
        gap: 8,
      }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
        <AgentIcon kind={task.kind} size={28} />
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={{ color: T.text, fontSize: 14, fontWeight: "600" }} numberOfLines={2}>
            {task.title}
          </Text>
          <Text style={{ color: T.faint, fontSize: 11, fontFamily: T.mono, marginTop: 2 }} numberOfLines={1}>
            {task.id} · {agentLabel(task.kind)}
            {task.attempts > 1 ? ` · try ${task.attempts}` : ""}
            {task.files?.length ? ` · ${task.files.length} file${task.files.length === 1 ? "" : "s"}` : ""}
            {task.costUsd ? ` · ${usd(task.costUsd)}` : ""}
          </Text>
        </View>
        <View style={{ alignItems: "flex-end", gap: 4 }}>
          <Text style={{ color: look.color, fontSize: 11, fontFamily: T.mono, fontWeight: "600" }}>
            {look.glyph} {look.label}
          </Text>
          {task.status === "running" && <ActivityIndicator size="small" color={T.thread} />}
        </View>
      </View>
      {task.dependsOn.length ? (
        <Text style={{ color: T.faint, fontSize: 10.5, fontFamily: T.mono }}>after {task.dependsOn.join(", ")}</Text>
      ) : null}
      {detail ? (
        <Text
          style={{ color: task.error ? T.err : T.dim, fontSize: 12, lineHeight: 18 }}
          numberOfLines={open ? undefined : 3}
        >
          {detail}
        </Text>
      ) : null}
      <Text style={{ color: T.faint, fontSize: 11, marginLeft: "auto" }}>open thread →</Text>
    </TouchableOpacity>
  );
}

function Chip(props: { label: string; kind: string; on: boolean; onPress: () => void; disabled?: boolean }) {
  return (
    <TouchableOpacity
      onPress={props.onPress}
      disabled={props.disabled}
      activeOpacity={0.7}
      accessibilityRole="checkbox"
      accessibilityState={{ checked: props.on, disabled: !!props.disabled }}
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 7,
        minHeight: 36,
        paddingLeft: 5,
        paddingRight: 11,
        borderRadius: radii.pill,
        borderWidth: 1,
        borderColor: props.on ? T.bright : T.line,
        backgroundColor: props.on ? T.raised : "transparent",
        opacity: props.disabled ? 0.4 : 1,
      }}
    >
      <AgentIcon kind={props.kind} size={24} />
      <Text style={{ color: props.on ? T.text : T.dim, fontSize: 12.5, fontWeight: "600" }}>{props.label}</Text>
    </TouchableOpacity>
  );
}

function StartForm(props: {
  creds: Creds;
  project: Project;
  onStarted: (run: OrchestraRun) => void;
  onCancel?: () => void;
}) {
  const adapters = props.project.agents.filter((a) => a.tier === "adapter" && a.enabled !== false);
  const [goal, setGoal] = useState("");
  const [orch, setOrch] = useState<string | null>(props.project.holder ?? adapters[0]?.id ?? null);
  const [workers, setWorkers] = useState<string[]>(adapters.map((a) => a.id));
  const [parallel, setParallel] = useState(3);
  const [plan, setPlan] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const toggle = (id: string) =>
    setWorkers((w) => (w.includes(id) ? w.filter((x) => x !== id) : [...w, id]));

  const start = async () => {
    if (!goal.trim() || busy) return;
    setErr(null);
    setBusy(true);
    try {
      const { run } = await startOrchestra(props.creds, props.project.id, {
        goal: goal.trim(),
        ...(orch ? { orchestrator: orch } : {}),
        ...(workers.length ? { workers } : {}),
        maxParallel: parallel,
        ...(plan ? { plan: true } : {}),
      });
      props.onStarted(run);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const label = (id: string) => {
    const a = adapters.find((x) => x.id === id);
    return a ? agentLabel(a.kind) : id;
  };

  return (
    <View style={{ gap: spacing.md }}>
      <View style={{ gap: 6 }}>
        <SectionLabel text="Goal" />
        <TextInput
          style={{ ...field, minHeight: 96, textAlignVertical: "top", lineHeight: 21 }}
          value={goal}
          onChangeText={setGoal}
          multiline
          placeholder="What should the team build? e.g. Add dark mode to settings, with tests"
          placeholderTextColor={T.faint}
          selectionColor={T.accentBlue}
        />
      </View>

      <View style={{ gap: 6 }}>
        <SectionLabel text="Orchestrator — plans, reviews, merges" />
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
          {adapters.map((a) => (
            <Chip
              key={a.id}
              label={agentLabel(a.kind)}
              kind={a.kind}
              on={orch === a.id}
              disabled={!a.available}
              onPress={() => setOrch(a.id)}
            />
          ))}
        </View>
      </View>

      <View style={{ gap: 6 }}>
        <SectionLabel text={`Workers — ${workers.length || "any"} selected`} />
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
          {adapters.map((a) => (
            <Chip
              key={a.id}
              label={agentLabel(a.kind)}
              kind={a.kind}
              on={workers.includes(a.id)}
              disabled={!a.available}
              onPress={() => toggle(a.id)}
            />
          ))}
        </View>
        {!adapters.length && <Empty text="This project has no enabled agents to orchestrate." />}
      </View>

      <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.md }}>
        <View style={{ flex: 1 }}>
          <Text style={{ color: T.text, fontSize: 14, fontWeight: "600" }}>In parallel</Text>
          <Text style={{ color: T.faint, fontSize: 11.5, marginTop: 2 }}>
            workers running at once, each on its own branch
          </Text>
        </View>
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            borderWidth: 1,
            borderColor: T.line2,
            borderRadius: radii.pill,
            backgroundColor: T.raised,
          }}
        >
          {(["−", "+"] as const).map((sym, i) => {
            const next = parallel + (i ? 1 : -1);
            const ok = next >= 1 && next <= 8;
            const btn = (
              <TouchableOpacity
                key={sym}
                disabled={!ok}
                onPress={() => setParallel(next)}
                accessibilityRole="button"
                accessibilityLabel={i ? "More in parallel" : "Fewer in parallel"}
                style={{ width: TAP, height: 38, alignItems: "center", justifyContent: "center", opacity: ok ? 1 : 0.3 }}
              >
                <Text style={{ color: T.text, fontSize: 18, fontWeight: "600" }}>{sym}</Text>
              </TouchableOpacity>
            );
            return i === 0 ? (
              <View key="dec" style={{ flexDirection: "row", alignItems: "center" }}>
                {btn}
                <Text style={{ color: T.text, fontSize: 16, fontWeight: "700", fontFamily: T.mono, minWidth: 22, textAlign: "center" }}>
                  {parallel}
                </Text>
              </View>
            ) : (
              btn
            );
          })}
        </View>
      </View>

      <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.md }}>
        <View style={{ flex: 1 }}>
          <Text style={{ color: T.text, fontSize: 14, fontWeight: "600" }}>Plan first</Text>
          <Text style={{ color: T.faint, fontSize: 11.5, marginTop: 2, lineHeight: 16 }}>
            writes PLAN.md and one spec per task on the run&apos;s branch, which the workers build from
          </Text>
        </View>
        <Switch
          value={plan}
          onValueChange={setPlan}
          accessibilityLabel="Plan first"
          trackColor={{ false: T.raised, true: T.primaryDim }}
          thumbColor={plan ? T.primary : T.dim}
          ios_backgroundColor={T.raised}
        />
      </View>

      {err && <Text style={{ color: T.err, fontSize: 13 }}>{err}</Text>}

      <TouchableOpacity
        onPress={start}
        disabled={!goal.trim() || busy}
        activeOpacity={0.75}
        accessibilityRole="button"
        style={{
          minHeight: 48,
          borderRadius: 10,
          backgroundColor: T.bright,
          alignItems: "center",
          justifyContent: "center",
          opacity: goal.trim() ? 1 : 0.4,
        }}
      >
        {busy ? (
          <ActivityIndicator color={T.onBright} />
        ) : (
          <Text style={{ color: T.onBright, fontSize: 15, fontWeight: "700" }}>
            {plan ? "Plan & start orchestra" : "Start orchestra"}
          </Text>
        )}
      </TouchableOpacity>
      {props.onCancel && (
        <TouchableOpacity onPress={props.onCancel} style={{ minHeight: TAP, alignItems: "center", justifyContent: "center" }}>
          <Text style={{ color: T.dim, fontSize: 13.5, fontWeight: "600" }}>Back to the run</Text>
        </TouchableOpacity>
      )}
    </View>
  );
}

function RunView(props: {
  creds: Creds;
  projectId: string;
  run: OrchestraRun;
  onRun: (run: OrchestraRun) => void;
  onOpenChat: (chatId: string, title: string) => void;
}) {
  const { run } = props;
  const [reply, setReply] = useState("");
  const [busy, setBusy] = useState<"reply" | "abort" | "apply" | "deliver" | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const act = async (kind: "reply" | "abort" | "apply" | "deliver", fn: () => Promise<void>) => {
    setErr(null);
    setBusy(kind);
    try {
      await fn();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const send = () =>
    act("reply", async () => {
      const text = reply.trim();
      if (!text) return;
      const r = await replyOrchestra(props.creds, props.projectId, run.id, text);
      setReply("");
      props.onRun(r.run);
    });

  const abort = () =>
    Alert.alert("Abort this run?", "Running workers are stopped. Merged work stays on the integration branch.", [
      { text: "Keep going", style: "cancel" },
      {
        text: "Abort",
        style: "destructive",
        onPress: () =>
          void act("abort", async () => {
            props.onRun((await abortOrchestra(props.creds, props.projectId, run.id)).run);
          }),
      },
    ]);

  const apply = () =>
    Alert.alert("Apply to your branch?", `Merges ${run.branch} into the project's current branch.`, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Apply",
        onPress: () =>
          void act("apply", async () => {
            const r = await applyOrchestra(props.creds, props.projectId, run.id);
            Alert.alert(r.merged ? "Applied" : "Nothing to merge", r.merged ? `Merged into ${r.into}.` : undefined);
            props.onRun((await getOrchestraRun(props.creds, props.projectId, run.id)).run);
          }),
      },
    ]);

  const redeliver = () =>
    void act("deliver", async () => {
      props.onRun((await deliverOrchestra(props.creds, props.projectId, run.id)).run);
    });

  // The daemon applies any run that has stopped moving; offer it once something merged.
  const settled = run.status === "completed" || run.status === "waiting_human" || run.status === "failed" || run.status === "aborted";
  const canApply = settled && !run.applied && (run.status === "completed" || run.tasks.some((t) => t.status === "done"));
  const live = !terminal(run.status);

  return (
    <View style={{ gap: spacing.md }}>
      <Panel>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <StatusPill status={run.status} />
          <Text style={{ color: T.faint, fontSize: 11, fontFamily: T.mono, flex: 1 }} numberOfLines={1}>
            round {run.round}/{run.maxRounds} · ×{run.maxParallel}
          </Text>
          {run.costUsd > 0 && <Badge text={usd(run.costUsd)} />}
        </View>
        <Text style={{ color: T.text, fontSize: 15.5, fontWeight: "600", lineHeight: 22 }}>{run.goal}</Text>
        <TouchableOpacity
          onPress={() => props.onOpenChat(run.chat, "orchestrator")}
          activeOpacity={0.7}
          accessibilityRole="button"
          style={{ flexDirection: "row", alignItems: "center", gap: 8, minHeight: 36 }}
        >
          <AgentIcon kind={run.orchestrator.kind} size={22} />
          <Text style={{ color: T.dim, fontSize: 12.5, flex: 1 }} numberOfLines={1}>
            orchestrated by {agentLabel(run.orchestrator.kind)}
          </Text>
          <Text style={{ color: T.faint, fontSize: 11 }}>thread →</Text>
        </TouchableOpacity>
        <Progress tasks={run.tasks} />
        <Text style={{ color: T.faint, fontSize: 10.5, fontFamily: T.mono }} numberOfLines={1}>
          ⑂ {run.branch}
        </Text>
        {run.plan ? (
          <Text style={{ color: T.primary, fontSize: 11, fontFamily: T.mono }} numberOfLines={2} selectable>
            ▤ plan · {planPath(run)}
          </Text>
        ) : null}
      </Panel>

      {run.status === "waiting_human" && (
        <View style={{ gap: 8 }}>
          <Callout label="The orchestrator asks" text={run.question ?? "It needs your input to continue."} tint={T.warn} />
          <View style={{ flexDirection: "row", gap: spacing.sm, alignItems: "flex-end" }}>
            <TextInput
              style={{ ...field, flex: 1, paddingVertical: 10, fontSize: 14, maxHeight: 120 }}
              value={reply}
              onChangeText={setReply}
              multiline
              placeholder="Reply…"
              placeholderTextColor={T.faint}
              selectionColor={T.accentBlue}
            />
            <TouchableOpacity
              onPress={send}
              disabled={!reply.trim() || busy === "reply"}
              accessibilityRole="button"
              accessibilityLabel="Send reply"
              style={{
                minHeight: TAP,
                paddingHorizontal: 16,
                borderRadius: radii.key,
                backgroundColor: reply.trim() ? T.bright : T.raised,
                borderWidth: 1,
                borderColor: reply.trim() ? T.bright : T.line,
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              {busy === "reply" ? (
                <ActivityIndicator color={T.onBright} />
              ) : (
                <Text style={{ color: reply.trim() ? T.onBright : T.dim, fontWeight: "700" }}>Send</Text>
              )}
            </TouchableOpacity>
          </View>
        </View>
      )}

      {run.summary ? <Callout label="Summary" text={run.summary} tint={T.ok} /> : null}
      {run.error ? <Callout label="Error" text={run.error} tint={T.err} /> : null}
      {run.applied ? (
        <Callout label="Applied" text={`Merged into ${run.applied.into} ${ago(new Date(run.applied.at).toISOString())}.`} tint={T.ok} />
      ) : null}
      <Delivery run={run} busy={busy === "deliver"} onRetry={redeliver} />
      {err && <Text style={{ color: T.err, fontSize: 13 }}>{err}</Text>}

      {(live || canApply) && (
        <View style={{ flexDirection: "row", gap: spacing.sm }}>
          {live && (
            <TouchableOpacity
              onPress={abort}
              disabled={busy === "abort"}
              activeOpacity={0.7}
              accessibilityRole="button"
              style={{
                flex: 1,
                minHeight: TAP,
                borderRadius: radii.key,
                borderWidth: 1,
                borderColor: T.line2,
                backgroundColor: T.raised,
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              {busy === "abort" ? <ActivityIndicator color={T.err} /> : <Text style={{ color: T.err, fontWeight: "600" }}>Abort</Text>}
            </TouchableOpacity>
          )}
          {canApply && (
            <TouchableOpacity
              onPress={apply}
              disabled={busy === "apply"}
              activeOpacity={0.7}
              accessibilityRole="button"
              style={{
                flex: 1,
                minHeight: TAP,
                borderRadius: radii.key,
                backgroundColor: T.bright,
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              {busy === "apply" ? (
                <ActivityIndicator color={T.onBright} />
              ) : (
                <Text style={{ color: T.onBright, fontWeight: "700" }}>Apply to branch</Text>
              )}
            </TouchableOpacity>
          )}
        </View>
      )}

      <View style={{ gap: spacing.sm }}>
        <SectionLabel text={`Tasks · ${run.tasks.length}`} />
        {run.tasks.length ? (
          run.tasks.map((t) => <TaskCard key={t.id} task={t} onOpen={() => props.onOpenChat(t.chat, t.title)} />)
        ) : (
          <Empty text={live ? "The orchestrator is planning — tasks appear here as it assigns them." : "This run ended before any tasks were planned."} />
        )}
      </View>
    </View>
  );
}

/**
 * What the git delivery policy did with the run: a PR to open, a pushed branch,
 * a local commit — or the error, with a retry once it's fixed on the host.
 */
function Delivery(props: { run: OrchestraRun; busy: boolean; onRetry: () => void }) {
  const { delivered, deliveryError } = props.run;
  if (!delivered && !deliveryError) return null;
  const ok = !!delivered && !deliveryError;
  const text = deliveryError
    ? deliveryError
    : delivered!.prUrl
      ? `Pull request opened from ${delivered!.pushed ?? props.run.branch}.`
      : delivered!.pushed
        ? `Pushed ${delivered!.pushed}.`
        : delivered!.into
          ? `Committed into ${delivered!.into}.`
          : `Delivered (${delivered!.mode}).`;
  return (
    <View style={{ gap: 5 }}>
      <SectionLabel text={ok ? "Delivered" : "Delivery failed"} />
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: 10,
          backgroundColor: T.panel,
          borderWidth: 1,
          borderColor: T.line,
          borderLeftWidth: 2,
          borderLeftColor: ok ? T.ok : T.err,
          borderRadius: radii.card,
          padding: 12,
        }}
      >
        <Text style={{ color: ok ? T.text : T.err, fontSize: 13.5, lineHeight: 20, flex: 1 }} selectable>
          {text}
        </Text>
        {ok && delivered!.prUrl ? (
          <TouchableOpacity
            onPress={() => void Linking.openURL(delivered!.prUrl!).catch(() => {})}
            activeOpacity={0.75}
            accessibilityRole="link"
            accessibilityLabel="Open the pull request"
            style={{
              minHeight: TAP,
              paddingHorizontal: 16,
              borderRadius: radii.key,
              backgroundColor: T.bright,
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <Text style={{ color: T.onBright, fontWeight: "700" }}>PR ↗</Text>
          </TouchableOpacity>
        ) : null}
        {deliveryError ? (
          <TouchableOpacity
            onPress={props.onRetry}
            disabled={props.busy}
            activeOpacity={0.7}
            accessibilityRole="button"
            accessibilityLabel="Retry delivery"
            style={{
              minHeight: TAP,
              paddingHorizontal: 16,
              borderRadius: radii.key,
              borderWidth: 1,
              borderColor: T.line2,
              backgroundColor: T.raised,
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            {props.busy ? <ActivityIndicator color={T.dim} /> : <Text style={{ color: T.text, fontWeight: "600" }}>Retry</Text>}
          </TouchableOpacity>
        ) : null}
      </View>
    </View>
  );
}

/**
 * The tab. `pulse` changes whenever an `orchestra` event arrives on the live
 * feed; `pulseRunId` names the run it was about.
 */
export function OrchestraView(props: {
  creds: Creds;
  project: Project;
  pulse: number;
  pulseRunId: string | null;
  onOpenChat: (chatId: string, title: string) => void;
}) {
  const { creds, project } = props;
  const [runs, setRuns] = useState<OrchestraRun[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [composing, setComposing] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await getOrchestra(creds, project.id);
      setErr(null);
      const sorted = [...r.runs].sort((a, b) => b.createdAt - a.createdAt);
      setRuns(sorted);
      setSelected((cur) => cur ?? r.active ?? sorted[0]?.id ?? null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }, [creds, project.id]);

  useEffect(() => {
    void load();
  }, [load]);

  const upsert = useCallback((run: OrchestraRun) => {
    setRuns((prev) => {
      const rest = (prev ?? []).filter((r) => r.id !== run.id);
      return [run, ...rest].sort((a, b) => b.createdAt - a.createdAt);
    });
  }, []);

  // live: an orchestra event → refetch that run (or the list, for a run we don't know)
  useEffect(() => {
    if (!props.pulse) return;
    const id = props.pulseRunId;
    if (id && runs?.some((r) => r.id === id)) {
      void getOrchestraRun(creds, project.id, id)
        .then(({ run }) => upsert(run))
        .catch(() => {});
    } else void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.pulse]);

  const run = useMemo(() => runs?.find((r) => r.id === selected) ?? null, [runs, selected]);

  // backup poll while the selected run is live — feeds drop silently on phones
  useEffect(() => {
    if (!run || terminal(run.status)) return;
    const t = setInterval(() => {
      void getOrchestraRun(creds, project.id, run.id)
        .then(({ run: r }) => upsert(r))
        .catch(() => {});
    }, 8000);
    return () => clearInterval(t);
  }, [creds, project.id, run?.id, run?.status, upsert]); // eslint-disable-line react-hooks/exhaustive-deps

  const activeRun = runs?.find((r) => !terminal(r.status)) ?? null;

  return (
    <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: spacing.md, gap: spacing.md, paddingBottom: 40 }}>
      <View style={{ gap: 4 }}>
        <Text style={{ color: T.text, fontSize: 20, fontWeight: "800", letterSpacing: -0.3 }}>Orchestra</Text>
        <Text style={{ color: T.dim, fontSize: 12.5, lineHeight: 18 }}>
          One agent plans, the rest build in parallel on their own branches, and it all merges into one.
        </Text>
      </View>

      {err && !runs ? (
        <Unreachable what="Orchestra" detail={err} onRetry={() => void load()} />
      ) : !runs ? (
        <ActivityIndicator color={T.dim} style={{ marginTop: 30 }} />
      ) : composing || !run ? (
        <StartForm
          creds={creds}
          project={project}
          onStarted={(r) => {
            upsert(r);
            setSelected(r.id);
            setComposing(false);
          }}
          {...(run ? { onCancel: () => setComposing(false) } : {})}
        />
      ) : (
        <>
          <RunView creds={creds} projectId={project.id} run={run} onRun={upsert} onOpenChat={props.onOpenChat} />
          {!activeRun && (
            <TouchableOpacity
              onPress={() => setComposing(true)}
              activeOpacity={0.7}
              accessibilityRole="button"
              style={{
                minHeight: TAP,
                borderRadius: radii.key,
                borderWidth: 1,
                borderColor: T.line2,
                borderStyle: "dashed",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <Text style={{ color: T.text, fontWeight: "600" }}>＋ New run</Text>
            </TouchableOpacity>
          )}
        </>
      )}

      {runs && runs.length > 1 && !composing && (
        <View style={{ gap: spacing.sm }}>
          <SectionLabel text="Earlier runs" />
          {runs
            .filter((r) => r.id !== selected)
            .slice(0, 8)
            .map((r) => (
              <TouchableOpacity
                key={r.id}
                onPress={() => setSelected(r.id)}
                activeOpacity={0.7}
                accessibilityRole="button"
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  gap: 10,
                  minHeight: TAP,
                  paddingHorizontal: 12,
                  borderRadius: radii.card,
                  borderWidth: 1,
                  borderColor: T.line,
                  backgroundColor: T.panel,
                }}
              >
                <Text style={{ color: T.text, fontSize: 13, flex: 1 }} numberOfLines={1}>
                  {r.goal}
                </Text>
                <Text style={{ color: T.faint, fontSize: 10.5, fontFamily: T.mono }}>
                  {ago(new Date(r.createdAt).toISOString())}
                </Text>
                <StatusPill status={r.status} />
              </TouchableOpacity>
            ))}
        </View>
      )}
    </ScrollView>
  );
}
