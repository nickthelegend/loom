/**
 * Runners on the phone (Loom Teams Phase 5, D67–D78; the phone's part is D73):
 * start a goal on your runner, move a running goal there, and watch the goals
 * runners hold — tasks, cost, the question it asks, its PR. Plus the repo's
 * deployments (D72, read-only).
 *
 * Runners live behind the team hub; the phone asks the paired daemon, which
 * reads the hub and unseals job snapshots with the team key. Every action
 * answers with the runners and jobs as they now stand.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Alert, Linking, RefreshControl, ScrollView, Switch, Text, TextInput, TouchableOpacity, View } from "react-native";
import {
  getOrchestra,
  getTeamDeploys,
  getTeamRunners,
  teamRunnerAction,
  type Creds,
  type OrchestraRun,
  type Project,
  type RunnerAction,
  type RunnerJob,
  type TeamDeployment,
  type TeamRunner,
  type TeamRunners,
} from "./api";
import { agentLabel } from "./agents";
import { Badge, Btn, Empty, Panel, SectionLabel, Unreachable, ago, field } from "./components";
import { dollars } from "./team-landing-model";
import { TONE } from "./team-landing";
import {
  activeJobCount,
  bringBackConfirm,
  continueConfirm,
  deployChip,
  deployUrl,
  isRunLive,
  jobButtons,
  jobKindLabel,
  jobStateChip,
  jobTasks,
  runButtons,
  runnerName,
  shortSha,
  sortJobs,
  startConfirm,
  usableRunners,
  type RunButton,
} from "./team-runners-model";
import { T, radii, spacing } from "./theme";

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

function statusOf(e: unknown): number | undefined {
  const s = (e as { status?: unknown } | null)?.status;
  return typeof s === "number" ? s : undefined;
}

const meta = { color: T.faint, fontSize: 11, fontFamily: T.mono } as const;
const when = (ms: number | undefined) => (ms ? ago(new Date(ms).toISOString()) : "");

const LAND_TEXT = "The runner holding it brings in fresh main, runs the team's fast tests, pushes, and merges once GitHub's rules pass.";

/**
 * One runner action, with the answer applied and the errors said. `continue`
 * waits for running turns (up to 2 min); if the phone gives up first the move
 * still happens, so a timeout reads as "still moving", not a failure.
 */
async function runAction(
  creds: Creds,
  projectId: string,
  action: RunnerAction,
  body: Record<string, unknown>,
): Promise<TeamRunners | null> {
  try {
    const out = await teamRunnerAction(creds, projectId, action, body);
    return { runners: out.runners ?? [], jobs: out.jobs ?? [] };
  } catch (e) {
    const msg = errText(e);
    if (action === "continue" && /timed out/i.test(msg)) {
      Alert.alert("Still moving", "Running tasks are finishing their turn; the goal continues on the runner once they have. Pull to refresh.");
    } else Alert.alert("Couldn't do that", msg);
    return null;
  }
}

/** Pick a runner inline (only when there's more than one to pick from). */
function RunnerPicker(props: { runners: TeamRunner[]; value: string | null; onChange: (id: string) => void }) {
  if (props.runners.length < 2) return null;
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
      {props.runners.map((r) => {
        const on = r.deviceId === props.value;
        return (
          <TouchableOpacity
            key={r.deviceId}
            onPress={() => props.onChange(r.deviceId)}
            activeOpacity={0.7}
            accessibilityRole="radio"
            accessibilityState={{ selected: on }}
            accessibilityLabel={`${runnerName(r)}, ${r.online ? "online" : "offline"}`}
            style={{
              flexDirection: "row",
              alignItems: "center",
              gap: 6,
              minHeight: 34,
              paddingHorizontal: 11,
              borderRadius: radii.pill,
              borderWidth: 1,
              borderColor: on ? T.thread : T.line,
              backgroundColor: on ? T.raised : "transparent",
            }}
          >
            <Dot on={r.online} />
            <Text style={{ color: on ? T.text : T.dim, fontSize: 12.5, fontWeight: "600" }} numberOfLines={1}>
              {runnerName(r)}
            </Text>
          </TouchableOpacity>
        );
      })}
    </View>
  );
}

function Dot(props: { on: boolean }) {
  return <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: props.on ? T.ok : T.faint }} />;
}

const offlineNote = (r: TeamRunner | undefined) => (r && !r.online ? "\n\nIt's offline right now — the goal waits until it's back." : "");

/**
 * The runner buttons on one goal: Continue on runner (live here), Bring back
 * and Land (moved, held by a runner). Used by the Orchestra run view and the
 * Runners tab's "on this computer" list.
 */
export function RunRunnerActions(props: {
  creds: Creds;
  projectId: string;
  run: Pick<OrchestraRun, "id" | "status" | "moving" | "goal">;
  view: TeamRunners | null;
  onView: (v: TeamRunners) => void;
  /** After an action: the run itself changed (moved, or on its way home). */
  onChanged?: () => void;
}) {
  const { run, view } = props;
  const buttons = runButtons(run, view);
  const runners = useMemo(() => usableRunners(view?.runners ?? []), [view]);
  const [picking, setPicking] = useState(false);
  const [target, setTarget] = useState<string | null>(null);
  const [busy, setBusy] = useState<RunButton | null>(null);

  const go = async (action: RunButton, body: Record<string, unknown>) => {
    setBusy(action);
    const v = await runAction(props.creds, props.projectId, action, body);
    setBusy(null);
    setPicking(false);
    if (v) props.onView(v);
    props.onChanged?.();
  };

  const confirmContinue = (id: string) => {
    const r = runners.find((x) => x.deviceId === id);
    const name = r ? runnerName(r) : "your runner";
    Alert.alert("Continue on runner?", continueConfirm(name) + offlineNote(r), [
      { text: "Cancel", style: "cancel" },
      { text: "Continue there", onPress: () => void go("continue", { runId: run.id, runner: id }) },
    ]);
  };

  if (!buttons.length) return null;
  if (busy) {
    return (
      <View style={{ minHeight: 36, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8 }}>
        <ActivityIndicator color={T.dim} />
        {busy === "continue" ? <Text style={meta}>letting running turns finish…</Text> : null}
      </View>
    );
  }
  return (
    <View style={{ gap: 8 }}>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        {buttons.map((b) =>
          b === "continue" ? (
            <Btn
              key={b}
              small
              label={picking ? "Cancel" : "Continue on runner"}
              onPress={() => {
                if (runners.length === 1) return confirmContinue(runners[0]!.deviceId);
                setTarget((t) => t ?? runners[0]?.deviceId ?? null);
                setPicking((p) => !p);
              }}
            />
          ) : b === "land" ? (
            <Btn
              key={b}
              small
              primary
              label="Land"
              onPress={() =>
                Alert.alert("Land this goal?", LAND_TEXT, [
                  { text: "Cancel", style: "cancel" },
                  { text: "Land", onPress: () => void go("land", { runId: run.id }) },
                ])
              }
            />
          ) : (
            <Btn
              key={b}
              small
              label="Bring back"
              onPress={() =>
                Alert.alert("Bring it back?", bringBackConfirm(), [
                  { text: "Cancel", style: "cancel" },
                  { text: "Bring back", onPress: () => void go("bring-back", { runId: run.id }) },
                ])
              }
            />
          ),
        )}
      </View>
      {picking ? (
        <View style={{ gap: 8 }}>
          <RunnerPicker runners={runners} value={target} onChange={setTarget} />
          <View style={{ flexDirection: "row", justifyContent: "flex-end" }}>
            <Btn small primary label="Move it" onPress={() => target && confirmContinue(target)} />
          </View>
        </View>
      ) : null}
    </View>
  );
}

/** For the Orchestra tab: a run's runner buttons, reading the runners itself. */
export function RunRunnerBar(props: { creds: Creds; projectId: string; run: OrchestraRun; onChanged: () => void }) {
  const [view, setView] = useState<TeamRunners | null>(null);
  const { creds, projectId, run } = props;
  const relevant = run.status === "moved" || isRunLive(run.status);
  useEffect(() => {
    if (!relevant) return;
    let live = true;
    void getTeamRunners(creds, projectId)
      .then((v) => {
        if (live) setView(v);
      })
      .catch(() => {}); // no team, no hub, an older daemon: no runner buttons
    return () => {
      live = false;
    };
  }, [creds, projectId, run.id, run.status, relevant]);
  if (!relevant || !view) return null;
  return <RunRunnerActions creds={creds} projectId={projectId} run={run} view={view} onView={setView} onChanged={props.onChanged} />;
}

function RunnerRow(props: { r: TeamRunner }) {
  const { r } = props;
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 6, borderTopWidth: 1, borderTopColor: T.line }}>
      <Dot on={r.online} />
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={{ color: T.text, fontSize: 13, fontWeight: "600" }} numberOfLines={1}>
          {r.label || "runner"}
        </Text>
        <Text style={meta} numberOfLines={1}>
          @{r.github}
          {r.kinds.length ? ` · ${r.kinds.map((k) => agentLabel(k)).join(", ")}` : ""}
        </Text>
      </View>
      <View style={{ alignItems: "flex-end", gap: 3 }}>
        {r.shared ? <Badge text="shared" tint={T.primary} /> : r.mine ? <Badge text="yours" /> : null}
        <Text style={meta}>{r.online ? "online" : `seen ${when(r.lastSeen)}`}</Text>
      </View>
    </View>
  );
}

function JobCard(props: { j: RunnerJob; busy: boolean; onAction: (j: RunnerJob, a: "land" | "bring-back") => void }) {
  const { j } = props;
  const chip = jobStateChip(j.state);
  const tint = TONE[chip.tone];
  const p = j.progress;
  const tasks = jobTasks(j);
  const buttons = jobButtons(j);
  const pr = p?.landing?.pr ? p.landing : null;
  return (
    <View
      style={{
        gap: 6,
        padding: 12,
        borderRadius: radii.card,
        borderWidth: 1,
        borderColor: p?.question ? T.warn : T.line,
        borderLeftWidth: 2,
        borderLeftColor: tint,
        backgroundColor: T.panel,
      }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <Badge text={chip.label} tint={tint} />
        <Text style={meta}>{jobKindLabel(j.kind)}</Text>
        {p?.status ? <Text style={[meta, { color: T.dim }]}>{p.status.replace(/_/g, " ")}</Text> : null}
        {p && p.costUsd > 0 ? <Text style={[meta, { marginLeft: "auto" }]}>{dollars(p.costUsd)}</Text> : null}
      </View>
      <Text style={{ color: T.text, fontSize: 13.5, lineHeight: 19 }} numberOfLines={3}>
        {p?.goal || j.goal || "(goal sealed)"}
      </Text>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 10 }}>
        {tasks ? (
          <Text style={meta}>
            {tasks.done}/{tasks.total} tasks
          </Text>
        ) : null}
        {j.runnerGithub ? <Text style={meta}>on @{j.runnerGithub}'s runner</Text> : null}
        {!j.mine ? <Text style={meta}>for @{j.github}</Text> : null}
        {p?.at ? <Text style={meta}>{when(p.at)}</Text> : null}
      </View>
      {pr ? (
        <TouchableOpacity
          disabled={!/^https?:\/\//i.test(pr.url)}
          onPress={() => void Linking.openURL(pr.url).catch(() => {})}
          accessibilityRole="link"
          hitSlop={8}
        >
          <Text style={{ color: T.accentBlue, fontSize: 12, fontFamily: T.mono }}>
            PR #{pr.pr} · {pr.state.replace(/_/g, " ")}
          </Text>
        </TouchableOpacity>
      ) : null}
      {p?.question ? (
        <Text style={{ color: T.warn, fontSize: 12.5, lineHeight: 18 }} selectable>
          Asks: {p.question}
        </Text>
      ) : null}
      {j.error ? (
        <Text style={{ color: T.err, fontSize: 12, lineHeight: 17 }} selectable>
          {j.error}
        </Text>
      ) : null}
      {props.busy ? (
        <ActivityIndicator color={T.dim} />
      ) : buttons.length ? (
        <View style={{ flexDirection: "row", gap: 8 }}>
          {buttons.map((b) => (
            <Btn key={b} small primary={b === "land"} label={b === "land" ? "Land" : "Bring back"} onPress={() => props.onAction(j, b)} />
          ))}
        </View>
      ) : null}
    </View>
  );
}

function DeployRow(props: { d: TeamDeployment }) {
  const { d } = props;
  const chip = deployChip(d.state);
  const url = deployUrl(d);
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 6, borderTopWidth: 1, borderTopColor: T.line }}>
      <Badge text={chip.label} tint={TONE[chip.tone]} />
      <Text style={{ color: T.text, fontSize: 12.5, flex: 1 }} numberOfLines={1}>
        {d.environment || "—"}
      </Text>
      <Text style={meta}>{shortSha(d.sha)}</Text>
      <Text style={meta}>{when(d.at)}</Text>
      {url ? (
        <TouchableOpacity
          onPress={() => void Linking.openURL(url).catch(() => {})}
          accessibilityRole="link"
          accessibilityLabel={`Open the ${d.environment} deployment`}
          hitSlop={8}
        >
          <Text style={{ color: T.accentBlue, fontSize: 13 }}>↗</Text>
        </TouchableOpacity>
      ) : null}
    </View>
  );
}

function StartOnRunner(props: { creds: Creds; projectId: string; runners: TeamRunner[]; onView: (v: TeamRunners) => void }) {
  const [open, setOpen] = useState(false);
  const [goal, setGoal] = useState("");
  const [plan, setPlan] = useState(false);
  const [target, setTarget] = useState<string | null>(props.runners[0]?.deviceId ?? null);
  const [busy, setBusy] = useState(false);
  const runner = props.runners.find((r) => r.deviceId === target) ?? props.runners[0];

  if (!open) return <Btn label="＋ Start a goal on a runner" onPress={() => setOpen(true)} />;

  const start = () => {
    const g = goal.trim();
    if (!g || !runner) return;
    Alert.alert("Start on runner?", startConfirm(runnerName(runner), plan) + offlineNote(runner), [
      { text: "Cancel", style: "cancel" },
      {
        text: "Start",
        onPress: () => {
          setBusy(true);
          void runAction(props.creds, props.projectId, "start", { goal: g, runner: runner.deviceId, ...(plan ? { plan: true } : {}) }).then((v) => {
            setBusy(false);
            if (!v) return;
            props.onView(v);
            setGoal("");
            setPlan(false);
            setOpen(false);
          });
        },
      },
    ]);
  };

  return (
    <Panel>
      <SectionLabel text="Start on runner" />
      <TextInput
        value={goal}
        onChangeText={setGoal}
        multiline
        autoFocus
        placeholder="The goal, e.g. Add CSV export to reports, with tests"
        placeholderTextColor={T.faint}
        accessibilityLabel="Goal to start on the runner"
        style={{ ...field, fontSize: 14, minHeight: 72, textAlignVertical: "top" }}
      />
      <RunnerPicker runners={props.runners} value={runner?.deviceId ?? null} onChange={setTarget} />
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <Text style={{ color: T.dim, fontSize: 12.5, flex: 1 }}>Plan first (PLAN.md and a spec per task)</Text>
        <Switch value={plan} onValueChange={setPlan} accessibilityLabel="Plan first" />
      </View>
      {busy ? (
        <ActivityIndicator color={T.dim} />
      ) : (
        <View style={{ flexDirection: "row", gap: 8, justifyContent: "flex-end" }}>
          <Btn small label="Cancel" onPress={() => setOpen(false)} />
          <Btn small primary label="Start" onPress={start} />
        </View>
      )}
    </Panel>
  );
}

/**
 * The project's Runners tab. `pulse` bumps on orchestra events (a goal moving
 * out or coming home rides those); a slow poll follows the runners' snapshots
 * while any of your goals is on one.
 */
export function TeamRunnersView(props: { creds: Creds; project: Project; pulse?: number; onChanged?: (v: TeamRunners) => void }) {
  const { creds, project } = props;
  const [view, setView] = useState<TeamRunners | null>(null);
  const [runs, setRuns] = useState<OrchestraRun[]>([]);
  const [deploys, setDeploys] = useState<TeamDeployment[] | null>(null);
  const [deployErr, setDeployErr] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const onChanged = useRef(props.onChanged);
  onChanged.current = props.onChanged;

  const take = useCallback((v: TeamRunners) => {
    setView(v);
    setErr(null);
    onChanged.current?.(v);
  }, []);

  const loadRuns = useCallback(() => {
    void getOrchestra(creds, project.id)
      .then((r) => setRuns(r.runs))
      .catch(() => {});
  }, [creds, project.id]);

  const load = useCallback(async () => {
    try {
      take(await getTeamRunners(creds, project.id));
    } catch (e) {
      setErr(statusOf(e) === 404 ? "This daemon doesn't know runners yet. Update Loom on your computer." : errText(e));
    }
    loadRuns();
  }, [creds, project.id, take, loadRuns]);

  const loadDeploys = useCallback(async () => {
    try {
      setDeploys((await getTeamDeploys(creds, project.id)).deployments);
      setDeployErr(null);
    } catch (e) {
      setDeployErr(statusOf(e) === 404 ? null : errText(e));
      if (statusOf(e) === 404) setDeploys([]);
    }
  }, [creds, project.id]);

  useEffect(() => {
    void load();
    void loadDeploys();
  }, [load, loadDeploys]);

  const pulse = props.pulse ?? 0;
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    const t = setTimeout(() => void load(), 800);
    return () => clearTimeout(t);
  }, [pulse, load]);

  const active = activeJobCount(view);
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => void load(), 20_000);
    return () => clearInterval(t);
  }, [active, load]);

  const refresh = async () => {
    setRefreshing(true);
    await Promise.all([load(), loadDeploys()]);
    setRefreshing(false);
  };

  const onJob = (j: RunnerJob, a: "land" | "bring-back") => {
    const runId = j.progress?.runId ?? j.runId;
    if (!runId) return;
    const doIt = async () => {
      setBusy(j.id);
      const v = await runAction(creds, project.id, a, { runId });
      setBusy(null);
      if (v) take(v);
      loadRuns();
    };
    if (a === "land")
      Alert.alert(`Land${j.progress?.landing?.pr ? ` PR #${j.progress.landing.pr}` : ""}?`, LAND_TEXT, [
        { text: "Cancel", style: "cancel" },
        { text: "Land", onPress: () => void doIt() },
      ]);
    else
      Alert.alert("Bring it back?", bringBackConfirm(), [
        { text: "Cancel", style: "cancel" },
        { text: "Bring back", onPress: () => void doIt() },
      ]);
  };

  let body: React.ReactNode;
  if (err && !view) {
    body = <Unreachable what="runners" detail={err} onRetry={() => void load()} />;
  } else if (!view) {
    body = <ActivityIndicator color={T.dim} style={{ marginVertical: 24 }} />;
  } else {
    const usable = usableRunners(view.runners);
    const jobs = sortJobs(view.jobs);
    // Goals still running on this computer: a runner could take them.
    const here = [...runs].filter((r) => isRunLive(r.status) && !r.moving).sort((a, b) => b.createdAt - a.createdAt);
    body = (
      <View style={{ gap: spacing.md }}>
        <Text style={meta} numberOfLines={2}>
          {usable.filter((r) => r.online).length} of {usable.length} runner{usable.length === 1 ? "" : "s"} online · {active} of your goal
          {active === 1 ? "" : "s"} on one
        </Text>

        {usable.length ? <StartOnRunner creds={creds} projectId={project.id} runners={usable} onView={take} /> : null}

        <View style={{ gap: 6 }}>
          <SectionLabel text={`Runners · ${view.runners.length}`} />
          {view.runners.length ? (
            <Panel>
              <View style={{ marginTop: -6 }}>
                {view.runners.map((r) => (
                  <RunnerRow key={r.deviceId} r={r} />
                ))}
              </View>
            </Panel>
          ) : (
            <Empty text="No runners yet. On your computer: loom runner pair, then loom runner join <link> on an always-on box (a VPS, a home server, Docker)." />
          )}
        </View>

        {here.length && usable.length ? (
          <View style={{ gap: 6 }}>
            <SectionLabel text={`Running on your computer · ${here.length}`} />
            {here.map((r) => (
              <Panel key={r.id}>
                <Text style={{ color: T.text, fontSize: 13.5, lineHeight: 19 }} numberOfLines={2}>
                  {r.goal}
                </Text>
                <Text style={meta}>
                  {r.status.replace(/_/g, " ")} · {r.tasks.filter((t) => t.status === "done").length}/{r.tasks.length} tasks
                </Text>
                <RunRunnerActions creds={creds} projectId={project.id} run={r} view={view} onView={take} onChanged={loadRuns} />
              </Panel>
            ))}
          </View>
        ) : null}

        <View style={{ gap: 6 }}>
          <SectionLabel text={`Runner goals · ${jobs.length}`} />
          {jobs.length ? (
            jobs.map((j) => <JobCard key={j.id} j={j} busy={busy === j.id} onAction={onJob} />)
          ) : (
            <Empty text="Nothing on a runner yet. Start a goal there, or move a running one with Continue on runner." />
          )}
        </View>

        <View style={{ gap: 6 }}>
          <SectionLabel text={`Deploys${deploys ? ` · ${deploys.length}` : ""}`} />
          {deploys === null && !deployErr ? (
            <ActivityIndicator color={T.dim} />
          ) : deployErr ? (
            <Text style={{ color: T.dim, fontSize: 12 }}>{deployErr}</Text>
          ) : deploys && deploys.length ? (
            <Panel>
              <View style={{ marginTop: -6 }}>
                {deploys.map((d) => (
                  <DeployRow key={d.id} d={d} />
                ))}
              </View>
            </Panel>
          ) : (
            <Empty text="No deployments on GitHub for this repo." />
          )}
        </View>
      </View>
    );
  }

  return (
    <ScrollView
      style={{ flex: 1 }}
      contentContainerStyle={{ padding: spacing.md, paddingBottom: 32, gap: spacing.sm }}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void refresh()} tintColor={T.dim} />}
      keyboardShouldPersistTaps="handled"
    >
      {body}
      {err && view ? <Text style={{ color: T.err, fontSize: 12, textAlign: "center" }}>{err}</Text> : null}
    </ScrollView>
  );
}

/**
 * Whether the tab shows (runners or jobs exist; the team share is checked by
 * the caller) and how many of your goals are on a runner. `hidden` when this
 * daemon predates runners. On open, every 60s, and after an orchestra event.
 */
export function useRunnersSummary(creds: Creds, projectId: string, pulse = 0) {
  const [summary, setSummary] = useState({ runners: 0, jobs: 0, active: 0, hidden: false });
  const gone = useRef(false);
  const update = useCallback((v: TeamRunners) => {
    setSummary({ runners: v.runners?.length ?? 0, jobs: v.jobs?.length ?? 0, active: activeJobCount(v), hidden: false });
  }, []);
  const tick = useCallback(
    (live: () => boolean) => {
      if (gone.current) return;
      getTeamRunners(creds, projectId)
        .then((v) => {
          if (live()) update(v);
        })
        .catch((e) => {
          const st = statusOf(e);
          if (st === 404 || st === 403) {
            gone.current = true;
            if (live()) setSummary({ runners: 0, jobs: 0, active: 0, hidden: true });
          }
        });
    },
    [creds, projectId, update],
  );
  useEffect(() => {
    gone.current = false;
    let live = true;
    tick(() => live);
    const t = setInterval(() => tick(() => live), 60_000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [tick]);
  useEffect(() => {
    if (!pulse) return;
    let live = true;
    const t = setTimeout(() => tick(() => live), 2000);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [pulse, tick]);
  return { summary, update };
}
