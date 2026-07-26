/**
 * The Observatory, natively.
 *
 * The desktop app (src/daemon/app-page.ts) renders eight views over the fleet's
 * telemetry; this is the same eight on a phone, in the same order, drawn with
 * Views instead of SVG and touch instead of hover. It is not a webview and it
 * does not re-derive anything the daemon already computes — every number here
 * comes off an endpoint, and where the daemon has no number this shows an empty
 * state and says why.
 *
 *   metrics   the dashboard: hero tiles, composition, turn durations, health
 *   fleet     who is running right now and who holds the baton
 *   handoffs  the baton's routes, and how often each was walked
 *   selfheal  who a firing alert has paused, and every past pause as an episode
 *   timeline  the chronological trace
 *   decisions what each agent decided and why
 *   logs      what the fleet actually said, read back out of the backend
 *   replay    a scrubber that rewinds the run
 *
 * Provenance is shown, not assumed: /insights/* answer with `from`, which is
 * "backend" when the telemetry store served the spans and "local-log" when it
 * was empty or down. Those two are different claims about the same panel. Logs
 * are the one signal with no second answer — see LogsView for why "unavailable"
 * is printed there rather than quietly rendered as an empty list.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Modal,
  PanResponder,
  ScrollView,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import {
  getDecisions,
  getEvents,
  getHealth,
  getLogs,
  getMetrics,
  getProject,
  getSnapshots,
  getSpans,
  getTriage,
  liftQuarantine,
  type AgentDecision,
  type Creds,
  type DecisionStats,
  type Health,
  type InsightLog,
  type InsightSpan,
  type LogSource,
  type LoomEvent,
  type Metrics,
  type Project,
  type QuarantineMap,
  type TimeSnapshot,
  type Triage,
} from "./api";
import { LineChart, Meter, RankedBars, StackedBar, gradeColor, type Slice } from "./charts";
import {
  Badge,
  Callout,
  Empty,
  MetricCard,
  Panel,
  SectionLabel,
  Segmented,
  Sys,
  TAP,
  Unreachable,
  dur,
  field,
  tok,
  trunc,
} from "./components";
import { T, hue, radii, spacing, usd } from "./theme";

type ObsView =
  | "metrics"
  | "fleet"
  | "handoffs"
  | "selfheal"
  | "timeline"
  | "decisions"
  | "logs"
  | "replay";

// Same order as the desktop's tab strip, so a person who learned one already
// knows where the other keeps things.
const OBS_VIEWS: ReadonlyArray<{ key: ObsView; label: string }> = [
  { key: "metrics", label: "Metrics" },
  { key: "fleet", label: "Live fleet" },
  { key: "handoffs", label: "Handoffs" },
  { key: "selfheal", label: "Self-heal" },
  { key: "timeline", label: "Timeline" },
  { key: "decisions", label: "Decisions" },
  { key: "logs", label: "Logs" },
  { key: "replay", label: "Replay" },
];

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

interface Res<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
  reload: () => void;
}

/**
 * One fetch, one panel.
 *
 * Two behaviours matter here. A panel that has never loaded and failed shows
 * the failure with a retry — the requirement that no panel is ever silently
 * blank. And a panel that HAS data and then fails a poll keeps the data and
 * shows a thin staleness note instead: dropping a screenful of real numbers
 * because one 4-second refresh missed is worse than saying it's a moment old.
 */
function useResource<T>(
  fetcher: () => Promise<T>,
  key: string,
  opts: { pollMs?: number; enabled?: boolean } = {},
): Res<T> {
  const { pollMs, enabled = true } = opts;
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [nonce, setNonce] = useState(0);
  // The fetcher closes over props and is rebuilt every render; holding it in a
  // ref keeps the effect keyed on `key` alone instead of refetching constantly.
  const fn = useRef(fetcher);
  fn.current = fetcher;

  useEffect(() => {
    if (!enabled) return;
    let live = true;
    const run = (first: boolean) => {
      if (first) setLoading(true);
      fn.current()
        .then((d) => {
          if (!live) return;
          setData(d);
          setError(null);
        })
        .catch((e: unknown) => {
          if (!live) return;
          setError(e instanceof Error ? e.message : String(e));
        })
        .finally(() => {
          if (live && first) setLoading(false);
        });
    };
    run(true);
    const t = pollMs ? setInterval(() => run(false), pollMs) : null;
    return () => {
      live = false;
      if (t) clearInterval(t);
    };
  }, [key, nonce, enabled, pollMs]);

  return { data, error, loading, reload: useCallback(() => setNonce((n) => n + 1), []) };
}

/** The shell every panel body sits in: loading, hard failure, or the content. */
function Load<T>(props: { res: Res<T>; what: string; children: (data: T) => React.ReactNode }) {
  const { res } = props;
  if (!res.data) {
    if (res.error) return <Unreachable what={props.what} detail={res.error} onRetry={res.reload} />;
    return (
      <View style={{ alignItems: "center", paddingVertical: 34, gap: 10 }}>
        <ActivityIndicator color={T.primary} />
        <Sys text={`loading ${props.what}…`} />
      </View>
    );
  }
  return (
    <>
      {res.error ? (
        <Text style={{ color: T.warn, fontSize: 10.5, fontFamily: T.mono }} numberOfLines={2}>
          ⚠ last refresh failed ({res.error}) — showing the previous reading
        </Text>
      ) : null}
      {props.children(res.data)}
    </>
  );
}

// ---------------------------------------------------------------------------
// Shared derivations
// ---------------------------------------------------------------------------

const TURN_SPAN = "gen_ai.agent.turn";

/** The baton's moves, oldest first, straight off the thread's handoff events. */
function handoffPairs(events: LoomEvent[]): Array<{ from: string; to: string; ts: number }> {
  const out: Array<{ from: string; to: string; ts: number }> = [];
  for (const e of events) {
    if (e.kind !== "handoff") continue;
    const p = e.payload as Record<string, unknown>;
    const from = String(p.from ?? "");
    const to = String(p.to ?? "");
    if (!from || !to || from === to) continue;
    out.push({ from, to, ts: e.ts });
  }
  return out;
}

function statusTint(status: string): string {
  return status === "active" ? T.ok : status === "errored" ? T.err : status === "waiting" ? T.warn : T.dim;
}

// ---------------------------------------------------------------------------
// Observatory
// ---------------------------------------------------------------------------

export function ObservatoryView(props: { creds: Creds; project: Project }) {
  const { creds, project } = props;
  const [view, setView] = useState<ObsView>("metrics");
  const [triageFor, setTriageFor] = useState<string | null>(null);

  // metrics/events/health/spans back several views at once, so they load here
  // and each view reads whichever it needs. Snapshots and decisions are large
  // and only two views want them, so they stay behind `enabled`.
  const metrics = useResource(() => getMetrics(creds, project.id), `m:${project.id}`, { pollMs: 5000 });
  const events = useResource(() => getEvents(creds, project.id, undefined, 200), `e:${project.id}`, {
    pollMs: 5000,
  });
  const health = useResource(() => getHealth(creds, project.id), `h:${project.id}`, { pollMs: 15000 });
  const spans = useResource(() => getSpans(creds, project.id, undefined, 200), `s:${project.id}`, {
    pollMs: 15000,
  });
  const decisions = useResource(() => getDecisions(creds, project.id), `d:${project.id}`, {
    enabled: view === "decisions" || view === "replay",
  });
  const snapshots = useResource(() => getSnapshots(creds, project.id), `t:${project.id}`, {
    enabled: view === "replay",
  });
  /**
   * Self-heal reads the quarantine map, and a quarantine arrives over an alert
   * webhook at a moment nothing on this screen predicts. The `project` prop was
   * fetched by whoever mounted the Observatory and is therefore precisely the
   * thing that will be stale on the one view whose entire job is "right now" —
   * so that tab fetches its own copy the moment it opens (`enabled` flips, the
   * effect runs) and keeps it warm while it is the visible tab.
   */
  const fresh = useResource(() => getProject(creds, project.id), `p:${project.id}`, {
    enabled: view === "selfheal",
    pollMs: 8000,
  });

  return (
    <View style={{ flex: 1 }}>
      <View style={{ borderBottomWidth: 1, borderBottomColor: T.line, backgroundColor: T.panel }}>
        <Segmented options={OBS_VIEWS} value={view} onChange={setView} accent={T.primaryDim} />
      </View>

      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ padding: spacing.md, gap: spacing.md, paddingBottom: 40 }}
      >
        {view === "metrics" ? (
          <MetricsView
            project={project}
            metrics={metrics}
            health={health}
            spans={spans}
            onTriage={setTriageFor}
          />
        ) : view === "fleet" ? (
          <FleetView project={project} metrics={metrics} health={health} />
        ) : view === "handoffs" ? (
          <HandoffsView events={events} />
        ) : view === "selfheal" ? (
          <SelfHealView creds={creds} projectId={project.id} fresh={fresh} events={events} />
        ) : view === "timeline" ? (
          <TimelineView events={events} />
        ) : view === "decisions" ? (
          <DecisionsView decisions={decisions} />
        ) : view === "logs" ? (
          <LogsView creds={creds} projectId={project.id} />
        ) : (
          <ReplayView snapshots={snapshots} decisions={decisions} spans={spans} />
        )}
      </ScrollView>

      <TriageSheet
        creds={creds}
        projectId={project.id}
        agentId={triageFor}
        onClose={() => setTriageFor(null)}
      />
    </View>
  );
}

// ---------------------------------------------------------------------------
// 1 · Metrics
// ---------------------------------------------------------------------------

function MetricsView(props: {
  project: Project;
  metrics: Res<{ metrics: Metrics }>;
  health: Res<{ from: string; overall: Health; byAgent: Record<string, Health> }>;
  spans: Res<{ from: string; spans: InsightSpan[] }>;
  onTriage: (agentId: string) => void;
}) {
  const { project } = props;
  const m = props.metrics.data?.metrics ?? null;
  const active = project.agents.filter((a) => a.busy).length;
  const totalUsd = m?.totalUsd ?? project.costUsd ?? 0;
  const tin = m?.tokensIn ?? 0;
  const tout = m?.tokensOut ?? 0;

  const tokenSlices: Slice[] = (m?.byAgent ?? []).map((a) => ({
    key: a.agentId,
    value: a.tokensIn + a.tokensOut,
    display: tok(a.tokensIn + a.tokensOut),
  }));
  const turnSlices: Slice[] = (m?.byAgent ?? []).map((a) => ({
    key: a.agentId,
    value: a.turns,
    display: String(a.turns),
  }));

  const turnPoints = useMemo(() => {
    const s = props.spans.data?.spans ?? [];
    return s
      .filter((x) => x.name === TURN_SPAN && x.ms > 0)
      .slice()
      .sort((a, b) => a.ts - b.ts)
      .map((x) => ({ ts: x.ts, value: x.ms, tag: x.agent || undefined }));
  }, [props.spans.data]);

  return (
    <>
      {/* hero tiles */}
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: spacing.sm }}>
        <MetricCard label="Agents" value={`${active} / ${project.agents.length}`} sub="active / fleet" />
        <MetricCard label="Baton" value={project.holder ?? "—"} sub="holds it now" accent />
        <MetricCard label="Spend" value={usd(totalUsd) || "$0"} sub="all agents" />
        <MetricCard label="Turns" value={String(m?.turns ?? 0)} sub="completed" />
        <MetricCard label="Tokens" value={tok(tin + tout)} sub={`${tok(tin)} in · ${tok(tout)} out`} />
      </ScrollView>

      {/* composition — the phone's answer to the desktop's two donuts */}
      <Panel>
        <Load res={props.metrics} what="metrics">
          {() => (
            <View style={{ gap: 18 }}>
              <StackedBar
                title="Tokens by agent"
                total={tok(tin + tout)}
                slices={tokenSlices}
                emptyText="No token usage recorded yet. Adapters report usage when a turn finishes — the breakdown fills in from the first one."
              />
              <StackedBar
                title="Turns by agent"
                total={String(m?.turns ?? 0)}
                slices={turnSlices}
                emptyText="No turns yet. Send a message and this splits by who did the work."
              />
            </View>
          )}
        </Load>
      </Panel>

      {/* turn duration over time */}
      <Panel>
        <Load res={props.spans} what="turn spans">
          {(d) => (
            <>
              <LineChart
                title="Turn duration"
                points={turnPoints}
                format={dur}
                emptyText="No completed turns to plot yet. Each finished turn adds a point."
              />
              <Text style={{ color: T.faint, fontSize: 10, fontFamily: T.mono }}>
                {d.from === "backend" ? "from backend spans" : "from the local event log — the backend had nothing"}
              </Text>
            </>
          )}
        </Load>
      </Panel>

      {/* per-agent health, each with its own triage */}
      <Panel>
        <SectionLabel text="Agent health" />
        <Load res={props.health} what="health scores">
          {(h) => {
            const scored = project.agents.filter((a) => h.byAgent[a.id]);
            return (
              <View style={{ gap: 12 }}>
                <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                  <Text style={{ color: T.dim, fontSize: 12, flex: 1 }}>Fleet overall</Text>
                  <Text style={{ color: gradeColor(h.overall.grade), fontSize: 15, fontWeight: "700" }}>
                    {h.overall.score}
                  </Text>
                  <Badge text={h.overall.grade} tint={gradeColor(h.overall.grade)} />
                </View>
                {!scored.length ? (
                  <Empty text="No agent has produced a scoreable span yet. Health is computed from an agent's own turns and errors — it appears once one runs." />
                ) : (
                  scored.map((a) => {
                    const s = h.byAgent[a.id]!;
                    const c = gradeColor(s.grade);
                    return (
                      <View key={a.id} style={{ gap: 6 }}>
                        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                          <Text style={{ color: T.text, fontSize: 13, fontWeight: "600", flex: 1 }} numberOfLines={1}>
                            {a.holdsBaton ? "◆ " : ""}
                            {trunc(a.id, 22)}
                          </Text>
                          <Text style={{ color: c, fontSize: 14, fontWeight: "700" }}>{s.score}</Text>
                          <TouchableOpacity
                            onPress={() => props.onTriage(a.id)}
                            activeOpacity={0.7}
                            accessibilityRole="button"
                            accessibilityLabel={`Triage ${a.id} — root-cause it from its own traces`}
                            style={{
                              minHeight: TAP,
                              justifyContent: "center",
                              paddingHorizontal: 14,
                              borderWidth: 1,
                              borderColor: T.primaryDim,
                              backgroundColor: T.primaryDim,
                              borderRadius: radii.key,
                            }}
                          >
                            <Text style={{ color: T.primary, fontSize: 11.5, fontWeight: "700" }}>⚠ Triage</Text>
                          </TouchableOpacity>
                        </View>
                        <Meter value={s.score} tint={c} />
                        <Text style={{ color: T.faint, fontSize: 10, fontFamily: T.mono, lineHeight: 15 }} numberOfLines={2}>
                          {s.turns} turns · {s.errorCount} err · penalties −{s.buckets.errorRate} errors −
                          {s.buckets.latency} latency −{s.buckets.tokenBloat} bloat −{s.buckets.recency} recency
                        </Text>
                      </View>
                    );
                  })
                )}
                <Text style={{ color: T.faint, fontSize: 10, fontFamily: T.mono }}>
                  {h.from === "backend" ? "scored from backend spans" : "scored from the local event log"}
                </Text>
              </View>
            );
          }}
        </Load>
      </Panel>
    </>
  );
}

// ---------------------------------------------------------------------------
// 2 · Live fleet
// ---------------------------------------------------------------------------

function FleetView(props: {
  project: Project;
  metrics: Res<{ metrics: Metrics }>;
  health: Res<{ from: string; overall: Health; byAgent: Record<string, Health> }>;
}) {
  const { project } = props;
  const byAgent = new Map((props.metrics.data?.metrics.byAgent ?? []).map((a) => [a.agentId, a]));
  const hb = props.health.data?.byAgent ?? {};
  const running = project.agents.filter((a) => a.busy);

  return (
    <>
      <Panel tint={running.length ? T.threadDim : T.line}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <View
            style={{
              width: 8,
              height: 8,
              borderRadius: 4,
              backgroundColor: running.length ? T.thread : T.faint,
            }}
          />
          <Text style={{ color: T.text, fontSize: 13.5, fontWeight: "600", flex: 1 }}>
            {running.length
              ? `${running.length} agent${running.length === 1 ? "" : "s"} running`
              : "Nobody is running"}
          </Text>
          <Text style={{ color: T.shuttle, fontSize: 11.5, fontFamily: T.mono }} numberOfLines={1}>
            baton · {project.holder ? trunc(project.holder, 16) : "—"}
          </Text>
        </View>
        <Text style={{ color: T.faint, fontSize: 10.5, fontFamily: T.mono }}>
          live — this list refreshes with the project status
        </Text>
      </Panel>

      {!project.agents.length ? (
        <Empty text="This project has no agents configured. Add one on the desktop and it appears here." />
      ) : (
        project.agents.map((a) => {
          const c = byAgent.get(a.id);
          const h = hb[a.id];
          const state = a.busy ? "running" : a.holdsBaton ? "holds baton" : a.enabled === false ? "off" : "idle";
          const tint = a.busy ? T.thread : a.holdsBaton ? T.shuttle : a.enabled === false ? T.faint : T.dim;
          return (
            <View
              key={a.id}
              style={{
                backgroundColor: T.panel,
                borderWidth: 1,
                borderColor: a.holdsBaton ? T.primaryDim : T.line,
                borderRadius: radii.card,
                padding: 12,
                gap: 7,
                opacity: a.enabled === false ? 0.55 : 1,
              }}
            >
              <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: tint }} />
                <Text style={{ color: T.text, fontSize: 14, fontWeight: "600", flex: 1 }} numberOfLines={1}>
                  {trunc(a.id, 22)}
                </Text>
                <Text style={{ color: tint, fontSize: 11, fontFamily: T.mono }}>{state}</Text>
              </View>
              <Text style={{ color: T.dim, fontSize: 11, fontFamily: T.mono }} numberOfLines={1}>
                {a.kind}
                {a.role ? ` · ${a.role}` : ""}
                {a.model ? ` · ${trunc(a.model, 26)}` : ""}
              </Text>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
                <Text style={{ color: T.text, fontSize: 11.5, fontFamily: T.mono }}>
                  {c ? `${c.turns} turns` : "0 turns"}
                </Text>
                <Text style={{ color: T.text, fontSize: 11.5, fontFamily: T.mono }}>
                  {usd(c?.usd ?? 0) || "$0"}
                </Text>
                <Text style={{ color: T.dim, fontSize: 11.5, fontFamily: T.mono }}>
                  {tok((c?.tokensIn ?? 0) + (c?.tokensOut ?? 0))} tok
                </Text>
                <View style={{ flex: 1 }} />
                {h ? (
                  <Badge text={`health ${h.score}`} tint={gradeColor(h.grade)} />
                ) : (
                  <Badge text="health not measured" />
                )}
              </View>
              {c && c.ms > 0 ? (
                <Text style={{ color: T.faint, fontSize: 10, fontFamily: T.mono }}>
                  {dur(c.ms)} of wall time · {dur(c.ms / Math.max(1, c.turns))} per turn
                </Text>
              ) : null}
            </View>
          );
        })
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// 3 · Handoffs
// ---------------------------------------------------------------------------

function HandoffsView(props: { events: Res<{ events: LoomEvent[] }> }) {
  return (
    <Load res={props.events} what="handoffs">
      {(d) => {
        const pairs = handoffPairs(d.events);
        if (!pairs.length) {
          return (
            <Empty text="The baton has not moved yet. Every handoff between two agents is drawn here, with the number of times that route was taken." />
          );
        }
        const counts = new Map<string, { from: string; to: string; n: number; last: number }>();
        for (const p of pairs) {
          const k = `${p.from}${p.to}`;
          const cur = counts.get(k);
          if (cur) {
            cur.n += 1;
            cur.last = Math.max(cur.last, p.ts);
          } else counts.set(k, { from: p.from, to: p.to, n: 1, last: p.ts });
        }
        const last = pairs[pairs.length - 1]!;
        const rows = [...counts.values()]
          .sort((a, b) => b.n - a.n || b.last - a.last)
          .map((r) => ({
            key: `${r.from}->${r.to}`,
            label: `${trunc(r.from, 14)}  ⟿  ${trunc(r.to, 14)}`,
            n: r.n,
            highlight: r.from === last.from && r.to === last.to,
            sub:
              r.from === last.from && r.to === last.to
                ? `most recent · ${new Date(r.last).toLocaleString()}`
                : undefined,
          }));

        // The chain is the route as walked, not as configured — the desktop
        // shows the tail because a long run's early hops stop being the answer.
        const CAP = 14;
        const chain: string[] = [];
        for (const p of pairs) {
          if (!chain.length) chain.push(p.from);
          chain.push(p.to);
        }
        const trimmed = chain.length > CAP;
        const shown = trimmed ? chain.slice(chain.length - CAP) : chain;

        return (
          <>
            <Panel>
              <SectionLabel text="Baton path" />
              <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 5 }}>
                {trimmed ? (
                  <Text style={{ color: T.faint, fontSize: 10.5, fontFamily: T.mono }}>
                    +{chain.length - CAP} earlier →
                  </Text>
                ) : null}
                {shown.map((a, i) => (
                  <View key={`${a}-${i}`} style={{ flexDirection: "row", alignItems: "center", gap: 5 }}>
                    {i > 0 ? <Text style={{ color: T.faint, fontSize: 11 }}>→</Text> : null}
                    <View
                      style={{
                        borderWidth: 1,
                        borderColor: T.line2,
                        borderRadius: radii.pill,
                        paddingHorizontal: 8,
                        paddingVertical: 2,
                        backgroundColor: T.raised,
                      }}
                    >
                      <Text style={{ color: hue(a), fontSize: 10.5, fontFamily: T.mono }} numberOfLines={1}>
                        {trunc(a, 14)}
                      </Text>
                    </View>
                  </View>
                ))}
              </View>
            </Panel>

            <Panel>
              <SectionLabel text={`Routes · ${pairs.length} handoff${pairs.length === 1 ? "" : "s"} total`} />
              <RankedBars rows={rows} unit="" />
              <Text style={{ color: T.faint, fontSize: 10, fontFamily: T.mono }}>
                bar length is how often that route was walked
              </Text>
            </Panel>
          </>
        );
      }}
    </Load>
  );
}

// ---------------------------------------------------------------------------
// 4 · Self-heal
// ---------------------------------------------------------------------------

/** One pause, from the alert that opened it to the recovery that closed it. */
interface Episode {
  agent: string;
  alert: string;
  /** null when the fire happened before the window of events this screen holds. */
  from: number | null;
  /** null while the episode is open — or while its recovery went unrecorded. */
  to: number | null;
  fallback: string | null;
  via: string | null;
  retried: boolean;
}

/**
 * Pair each intervention with the recovery that ended it.
 *
 * Half-events are unreadable: "alert fired", twelve lines later "alert
 * resolved", and the reader does the join in their head. An episode has a start,
 * an end and a duration, which is the thing a person actually wants to know.
 *
 * Pairing walks oldest-first because an open episode has to be findable when its
 * recovery turns up; the result is reversed so the newest reads at the top. A
 * recovery with no intervention in the window keeps its own episode rather than
 * being dropped — the fire was real, it just happened before the events this
 * screen holds.
 */
function healEpisodes(events: LoomEvent[]): Episode[] {
  const heal = events
    .filter((e) => e.kind === "status" && String((e.payload as Record<string, unknown>).state ?? "").indexOf("alert_") === 0)
    .slice()
    .sort((a, b) => a.ts - b.ts);

  const open = new Map<string, Episode>();
  const episodes: Episode[] = [];
  for (const e of heal) {
    const p = e.payload as Record<string, unknown>;
    const agent = e.agentId ?? "?";
    if (p.state === "alert_intervention") {
      const ep: Episode = {
        agent,
        alert: String(p.alert ?? "alert"),
        from: e.ts,
        to: null,
        fallback: p.fallback ? String(p.fallback) : null,
        via: null,
        retried: false,
      };
      open.set(agent, ep);
      episodes.push(ep);
    } else if (p.state === "alert_recovery") {
      const ep = open.get(agent);
      if (ep) {
        ep.to = e.ts;
        ep.via = p.via ? String(p.via) : "resolved";
        ep.retried = Boolean(p.retried);
        open.delete(agent);
      } else {
        episodes.push({
          agent,
          alert: String(p.alert ?? "alert"),
          from: null,
          to: e.ts,
          fallback: null,
          via: p.via ? String(p.via) : "resolved",
          retried: Boolean(p.retried),
        });
      }
    }
  }
  return episodes.reverse();
}

/**
 * Self-heal — what your monitoring said, and what Loom did about it.
 *
 * Built from Loom's OWN record rather than the backend's API: the webhook
 * already tells the daemon every fire and resolve, so this needs no
 * credentials, no second service to poll, and it keeps working when the backend
 * is down — which is exactly the moment you want to know which agents are still
 * paused. Monitoring can tell you an alert fired; only this can tell you the
 * fleet reacted.
 */
function SelfHealView(props: {
  creds: Creds;
  projectId: string;
  fresh: Res<{ project: Project }>;
  events: Res<{ events: LoomEvent[] }>;
}) {
  /**
   * The map this view draws from is whatever answered most recently: the fresh
   * GET, or the map the DELETE hands back. It is deliberately state rather than
   * a read straight off `fresh.data` — a lift has to redraw from the response
   * body, because the project object in hand was fetched before the delete and
   * still lists the agent as paused.
   */
  const [live, setLive] = useState<QuarantineMap | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const served = props.fresh.data?.project.quarantine;

  useEffect(() => {
    if (props.fresh.data) setLive(served ?? {});
  }, [props.fresh.data, served]);

  const { creds, projectId } = props;
  const eventsReload = props.events.reload;
  const lift = useCallback(
    (agentId: string) => {
      setBusy(agentId);
      setErr(null);
      void liftQuarantine(creds, projectId, agentId)
        .then((r) => {
          setLive(r.quarantine ?? {});
          // The daemon writes an alert_recovery event for a manual lift, so the
          // episode below can close as soon as the log is re-read. Without this
          // nudge the history spends one poll interval calling a just-ended
          // episode "ended (no recovery recorded)", which is only true until the
          // event we ourselves caused arrives.
          eventsReload();
        })
        .catch((e: unknown) => setErr(e instanceof Error ? e.message : String(e)))
        .finally(() => setBusy(null));
    },
    [creds, projectId, eventsReload],
  );

  return (
    <Load res={props.fresh} what="the self-heal state">
      {() => {
        const q = live ?? {};
        const paused = Object.keys(q);
        const episodes = props.events.data ? healEpisodes(props.events.data.events) : [];

        return (
          <>
            <Panel tint={paused.length ? T.err : T.line}>
              <SectionLabel text="Paused right now" />
              {!paused.length ? (
                <Text style={{ color: T.ok, fontSize: 13, lineHeight: 20 }}>
                  ✓ Nothing is paused. Every agent can take the baton.
                </Text>
              ) : (
                paused.map((a) => {
                  const it = q[a]!;
                  return (
                    <View
                      key={a}
                      style={{
                        borderWidth: 1,
                        borderColor: T.line,
                        borderLeftWidth: 2,
                        borderLeftColor: T.err,
                        borderRadius: radii.card,
                        padding: 11,
                        gap: 7,
                      }}
                    >
                      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                        <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: T.err }} />
                        <Text style={{ color: T.text, fontSize: 14, fontWeight: "600", flex: 1 }} numberOfLines={1}>
                          {trunc(a, 22)}
                        </Text>
                        <TouchableOpacity
                          onPress={() => lift(a)}
                          disabled={busy === a}
                          activeOpacity={0.7}
                          accessibilityRole="button"
                          accessibilityLabel={`Lift the pause on ${a} — it can take the baton again`}
                          style={{
                            minHeight: TAP,
                            justifyContent: "center",
                            paddingHorizontal: 16,
                            borderWidth: 1,
                            borderColor: T.line2,
                            backgroundColor: T.raised,
                            borderRadius: radii.key,
                            opacity: busy === a ? 0.5 : 1,
                          }}
                        >
                          <Text style={{ color: T.text, fontSize: 12.5, fontWeight: "700" }}>
                            {busy === a ? "…" : "Lift"}
                          </Text>
                        </TouchableOpacity>
                      </View>
                      <Text style={{ color: T.dim, fontSize: 11.5, fontFamily: T.mono, lineHeight: 18 }}>
                        {it.reason} · paused {elapsed(Date.now() - it.since)} ago
                        {it.displaced ? " · the baton was taken off it" : ""}
                      </Text>
                    </View>
                  );
                })
              )}
              {err ? (
                <Text style={{ color: T.err, fontSize: 11.5, fontFamily: T.mono, lineHeight: 18 }}>
                  couldn&apos;t lift it — {err}
                </Text>
              ) : null}
            </Panel>

            <Panel>
              <SectionLabel
                text={
                  props.events.data
                    ? `History · ${episodes.length} episode${episodes.length === 1 ? "" : "s"}`
                    : "History"
                }
              />
              {!props.events.data ? (
                // Not "no alert has fired yet" — that would be a claim about the
                // fleet made from a request that hasn't come back.
                props.events.error ? (
                  <Unreachable
                    what="the self-heal history"
                    detail={props.events.error}
                    onRetry={props.events.reload}
                  />
                ) : (
                  <Sys text="reading the event log…" />
                )
              ) : !episodes.length ? (
                <Empty text="No alert has fired yet. Point your monitoring's webhook at /api/webhooks/alerts, and every fire and recovery lands here as an episode." />
              ) : (
                episodes.slice(0, 25).map((ep, i) => <EpisodeRow key={`${ep.agent}-${ep.from ?? ep.to}-${i}`} ep={ep} q={q} />)
              )}
            </Panel>

            <Text style={{ color: T.faint, fontSize: 10.5, fontFamily: T.mono, lineHeight: 17 }}>
              Alert rules live in your monitoring backend. A firing alert refuses that agent the
              baton; a resolved one gives it back.
            </Text>
          </>
        );
      }}
    </Load>
  );
}

/**
 * One episode.
 *
 * The rule this row exists to get right: an intervention with no matching
 * recovery is "still paused" ONLY if the live quarantine map still holds that
 * agent. Otherwise the episode ended and the recovery simply was never recorded
 * — an old run, an event window that rolled — and the row says so. Saying "still
 * paused" about an agent the section above shows taking work would be the screen
 * contradicting itself two panels apart.
 */
function EpisodeRow(props: { ep: Episode; q: QuarantineMap }) {
  const { ep } = props;
  const stillPaused =
    ep.from != null && ep.to == null && Object.prototype.hasOwnProperty.call(props.q, ep.agent);
  const lost = ep.from != null && ep.to == null && !stillPaused;
  const tint = stillPaused ? T.err : lost ? T.dim : T.ok;

  const when =
    (ep.from != null ? new Date(ep.from).toLocaleTimeString() : "—") +
    (ep.to != null
      ? ` → ${new Date(ep.to).toLocaleTimeString()}${ep.from != null ? ` · held ${dur(ep.to - ep.from)}` : ""}`
      : stillPaused
        ? " · still paused"
        : " · ended (no recovery recorded)") +
    (ep.fallback ? ` · baton moved to ${ep.fallback}` : "") +
    (ep.retried ? " · baton handed back" : "") +
    (ep.via && ep.via !== "resolved" ? ` · via ${ep.via}` : "");

  return (
    <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 8, paddingVertical: 6 }}>
      <View style={{ width: 7, height: 7, borderRadius: 4, marginTop: 5, backgroundColor: tint }} />
      <View style={{ flex: 1, gap: 3 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
          <Text style={{ color: hue(ep.agent), fontSize: 12.5, fontWeight: "600", flexShrink: 1 }} numberOfLines={1}>
            {trunc(ep.agent, 18)}
          </Text>
          <Badge text={trunc(ep.alert, 20)} />
        </View>
        <Text style={{ color: T.dim, fontSize: 10.5, fontFamily: T.mono, lineHeight: 16 }}>{when}</Text>
      </View>
      <Badge text={stillPaused ? "FIRING" : lost ? "ENDED" : "RECOVERED"} tint={tint} />
    </View>
  );
}

// ---------------------------------------------------------------------------
// 5 · Timeline
// ---------------------------------------------------------------------------

/** The same kinds the desktop's timeline admits, and what each one reads as. */
function timelineRow(e: LoomEvent): { text: string; color: string; bold?: boolean } | null {
  const p = e.payload as Record<string, unknown>;
  const state = String(p.state ?? "");

  if (e.kind === "status") {
    if (state === "alert_intervention")
      return {
        text: `⚡ Alert · ${String(p.alert ?? "alert")} → baton forced off ${e.agentId ?? "agent"}${p.fallback ? ` to ${String(p.fallback)}` : ""}`,
        color: T.primary,
        bold: true,
      };
    if (state === "alert_recovery")
      return {
        text: `✓ Recovery · ${String(p.alert ?? "alert")} resolved → ${p.retried ? `baton retried on ${e.agentId ?? "agent"}` : `quarantine lifted on ${e.agentId ?? "agent"}`}`,
        color: T.ok,
      };
    if (state === "agent_decision")
      return {
        text: `💡 ${e.agentId ?? "agent"} decided: ${String(p.title ?? "decision")}${p.confidence != null ? ` (${String(p.confidence)}% confidence)` : ""}`,
        color: T.primary,
      };
    if (state === "budget_exceeded")
      return {
        text: `💸 ${e.agentId ?? "agent"} paused — over its daily budget${p.budgetUsd != null ? ` (${usd(Number(p.spentTodayUsd ?? 0)) || "$0"} of ${usd(Number(p.budgetUsd)) || "$0"})` : ""}`,
        color: T.warn,
      };
    if (state.indexOf("budget_") === 0)
      return { text: `✓ ${e.agentId ?? "agent"} back under budget — pause lifted`, color: T.ok };
    if (state === "mcp_attached")
      return {
        text: `🔌 ${e.agentId ?? "agent"} got MCP: ${(Array.isArray(p.servers) ? (p.servers as unknown[]).join(", ") : "") || "no servers"}`,
        color: T.thread,
      };
    return null;
  }

  if (e.kind === "handoff")
    return {
      text: p.from
        ? `baton · ${String(p.from)}  ⟿  ${String(p.to ?? "—")}`
        : `baton · ${String(p.to ?? "agent")} takes it first`,
      color: T.shuttle,
    };
  if (e.kind === "run_complete")
    return {
      text: `✓ ${e.agentId ?? "agent"} finished a turn${p.durationMs ? ` · ${dur(Number(p.durationMs))}` : ""}`,
      color: T.faint,
    };
  if (e.kind === "error") return { text: `✗ ${String(p.message ?? "error")}`, color: T.err };
  if (e.kind === "needs_input") return { text: `⏸ ${e.agentId ?? "agent"} needs input`, color: T.warn };
  if (e.kind === "route_failed")
    return { text: `⊘ route failed${p.error ? ` · ${String(p.error)}` : ""}`, color: T.err };
  if (e.kind === "route_completed") return { text: "✓ route completed", color: T.ok };
  if (e.kind.indexOf("route_") === 0) return { text: `▸ route ${e.kind.slice(6)}`, color: T.dim };
  if (e.kind.indexOf("memory_") === 0)
    return { text: `◈ brain · ${e.kind.slice(7)}${p.kind ? ` (${String(p.kind)})` : ""}`, color: T.thread };
  if (e.kind === "decision") return { text: `★ ${String(p.text ?? "decision")}`, color: T.dim };
  return null;
}

/** Elapsed since the first event, rolled up — "2133m 37s" means nothing to a person. */
function elapsed(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ${Math.round((s % 3600) / 60)}m`;
  return `${Math.floor(s / 86400)}d ${Math.round((s % 86400) / 3600)}h`;
}

function TimelineView(props: { events: Res<{ events: LoomEvent[] }> }) {
  return (
    <Load res={props.events} what="the timeline">
      {(d) => {
        const rows = d.events
          .slice()
          .sort((a, b) => a.ts - b.ts)
          .map((e) => ({ e, r: timelineRow(e) }))
          .filter((x): x is { e: LoomEvent; r: NonNullable<ReturnType<typeof timelineRow>> } => x.r !== null);
        if (!rows.length)
          return <Empty text="No fleet events yet. Turns, handoffs, decisions, errors, budget pauses and MCP attachments all land here as they happen." />;
        const base = rows[0]!.e.ts;
        return (
          <View style={{ gap: 2 }}>
            {rows.map(({ e, r }) => (
              <View key={e.id} style={{ flexDirection: "row", alignItems: "flex-start", gap: 9, paddingVertical: 5 }}>
                <View
                  style={{
                    width: 7,
                    height: 7,
                    borderRadius: 4,
                    marginTop: 5,
                    backgroundColor: r.color,
                  }}
                />
                <Text
                  // minWidth 0 and a line cap, because one unbreakable string
                  // was moving the whole tab. A real event body carries an OAuth
                  // URL with no break opportunity; its min-content width is
                  // 397px, and a flex child defaults to min-width:auto, so it
                  // refuses to shrink below that inside a 375px column. The list
                  // then shifted to left:-28px — status dots clipped off the
                  // left, elapsed-time column pushed to x:434 and unreachable,
                  // since the container hides overflow rather than scrolling it.
                  // Every row on the tab degraded, not just the long one.
                  // (overflow-wrap:break-word does not help: it doesn't reduce
                  // min-content width.) LogRow already caps the same URL this
                  // way; Timeline was the one place that didn't.
                  numberOfLines={4}
                  style={{
                    color: r.color,
                    fontSize: 12,
                    lineHeight: 18,
                    flex: 1,
                    minWidth: 0,
                    fontFamily: T.mono,
                    fontWeight: r.bold ? "700" : "400",
                  }}
                >
                  {r.text}
                </Text>
                <Text style={{ color: T.faint, fontSize: 10, fontFamily: T.mono, marginTop: 2 }}>
                  {elapsed(e.ts - base)}
                </Text>
              </View>
            ))}
          </View>
        );
      }}
    </Load>
  );
}

// ---------------------------------------------------------------------------
// 6 · Decisions
// ---------------------------------------------------------------------------

const SOURCE_LABEL: Record<string, string> = {
  llm: "extracted by an LLM",
  cli: "extracted by a CLI",
  heuristic: "extracted by rule",
};

function DecisionsView(props: { decisions: Res<{ decisions: AgentDecision[]; stats: DecisionStats }> }) {
  const [open, setOpen] = useState<AgentDecision | null>(null);
  return (
    <>
      <Load res={props.decisions} what="decisions">
        {(d) => (
          <>
            <StatsHeader stats={d.stats} />
            {!d.decisions.length ? (
              <Empty text="No decisions mined yet. Loom reads each finished turn for what the agent chose and why — the first one appears after a turn that makes a call." />
            ) : (
              d.decisions.map((dec) => (
                <TouchableOpacity
                  key={dec.id}
                  onPress={() => setOpen(dec)}
                  activeOpacity={0.7}
                  accessibilityRole="button"
                  accessibilityLabel={`Open decision: ${dec.title}`}
                  style={{
                    minHeight: TAP,
                    backgroundColor: T.panel,
                    borderWidth: 1,
                    borderColor: T.line,
                    borderLeftWidth: 2,
                    borderLeftColor: hue(dec.agentId),
                    borderRadius: radii.card,
                    padding: 12,
                    gap: 6,
                  }}
                >
                  <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                    <Text style={{ color: hue(dec.agentId), fontSize: 11, fontFamily: T.mono, flexShrink: 1 }} numberOfLines={1}>
                      {trunc(dec.agentId, 16)}
                    </Text>
                    <Text style={{ color: T.faint, fontSize: 10, fontFamily: T.mono }}>{dec.category}</Text>
                    <Text style={{ color: T.faint, fontSize: 10, fontFamily: T.mono, marginLeft: "auto" }}>
                      turn {dec.turnIndex}
                    </Text>
                  </View>
                  <Text style={{ color: T.text, fontSize: 13.5, fontWeight: "600", lineHeight: 19 }} numberOfLines={2}>
                    {dec.title}
                  </Text>
                  <View style={{ flexDirection: "row", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                    <Badge text={dec.source} tint={dec.source === "llm" ? T.primary : T.dim} />
                    {dec.confidence == null ? (
                      <Badge text="confidence not measured" />
                    ) : (
                      <Badge text={`${dec.confidence}% confidence`} tint={T.thread} />
                    )}
                    {dec.alternatives.length ? <Badge text={`${dec.alternatives.length} alt`} /> : null}
                  </View>
                </TouchableOpacity>
              ))
            )}
          </>
        )}
      </Load>
      <DecisionSheet decision={open} onClose={() => setOpen(null)} />
    </>
  );
}

function StatsHeader(props: { stats: DecisionStats }) {
  const s = props.stats;
  return (
    <Panel>
      <SectionLabel text="Decision stats" />
      <View style={{ flexDirection: "row", gap: 6, flexWrap: "wrap" }}>
        <Badge text={`${s.total} total`} />
        <Badge text={`llm ${s.bySource.llm} · cli ${s.bySource.cli} · rule ${s.bySource.heuristic}`} />
        {/* An average over zero samples is not zero, it is nothing. Say which. */}
        {s.avgConfidence == null ? (
          <Badge text="no confidence measured" />
        ) : (
          <Badge text={`avg confidence ${Math.round(s.avgConfidence)}% (${s.confidenceSamples} of ${s.total})`} tint={T.thread} />
        )}
      </View>
      {s.criticalPath.length ? (
        <Text style={{ color: T.dim, fontSize: 11.5, fontFamily: T.mono }} numberOfLines={2}>
          critical path · {s.criticalPath.join(" → ")}
        </Text>
      ) : null}
    </Panel>
  );
}

function DecisionSheet(props: { decision: AgentDecision | null; onClose: () => void }) {
  const d = props.decision;
  return (
    <Sheet title={d ? `Decision · ${trunc(d.agentId, 18)}` : ""} visible={d !== null} onClose={props.onClose}>
      {d ? (
        <>
          <Text style={{ color: T.text, fontSize: 16, fontWeight: "700", lineHeight: 23 }}>{d.title}</Text>
          <View style={{ flexDirection: "row", gap: 6, flexWrap: "wrap" }}>
            <Badge text={d.category} />
            <Badge text={d.agentRole || "agent"} />
            <Badge text={SOURCE_LABEL[d.source] ?? d.source} tint={d.source === "llm" ? T.primary : T.dim} />
            <Badge text={new Date(d.timestamp).toLocaleString()} />
          </View>

          {/* The honesty rule: a bar only exists when a number does. */}
          <View style={{ gap: 5 }}>
            <SectionLabel text="Confidence" />
            {d.confidence == null ? (
              <Text style={{ color: T.dim, fontSize: 12.5, lineHeight: 19 }}>
                Not measured. This decision was {SOURCE_LABEL[d.source] ?? d.source}, which produces no confidence
                score — an empty bar here would be a reading, and there isn&apos;t one.
              </Text>
            ) : (
              <>
                <Meter value={d.confidence} tint={T.thread} height={8} />
                <Text style={{ color: T.dim, fontSize: 11.5, fontFamily: T.mono }}>{d.confidence} / 100</Text>
              </>
            )}
          </View>

          <Callout label="Reasoning" text={d.reasoning || "No reasoning was recorded."} tint={T.primary} />

          <View style={{ gap: 5 }}>
            <SectionLabel text="Alternatives considered" />
            {!d.alternatives.length ? (
              <Text style={{ color: T.faint, fontSize: 12 }}>None were recorded for this decision.</Text>
            ) : (
              d.alternatives.map((a, i) => (
                <Text key={i} style={{ color: T.dim, fontSize: 12.5, lineHeight: 19 }}>
                  · {a}
                </Text>
              ))
            )}
          </View>

          <View style={{ gap: 5 }}>
            <SectionLabel text="Files" />
            {!d.filesCreated.length && !d.filesModified.length ? (
              <Text style={{ color: T.faint, fontSize: 12 }}>This decision touched no files.</Text>
            ) : (
              <>
                {d.filesCreated.map((f) => (
                  <Text key={`c${f}`} style={{ color: T.gitAdd, fontSize: 11.5, fontFamily: T.mono }} numberOfLines={1}>
                    + {f}
                  </Text>
                ))}
                {d.filesModified.map((f) => (
                  <Text key={`m${f}`} style={{ color: T.dim, fontSize: 11.5, fontFamily: T.mono }} numberOfLines={1}>
                    ~ {f}
                  </Text>
                ))}
              </>
            )}
          </View>

          {/* Named for what they are: the turn's price, not this decision's. */}
          <View style={{ gap: 5 }}>
            <SectionLabel text="The turn this came from" />
            <Text style={{ color: T.dim, fontSize: 12, fontFamily: T.mono, lineHeight: 19 }}>
              turn {d.turnIndex} · {dur(d.durationMs)}
              {"\n"}
              {tok(d.turnTokensUsed)} tokens used by the whole turn
              {"\n"}
              {usd(d.turnCostUsd) || "$0"} cost of the whole turn
            </Text>
            <Text style={{ color: T.faint, fontSize: 10.5, lineHeight: 16 }}>
              A turn can yield several decisions; these figures belong to the turn, not to this one decision.
            </Text>
          </View>
        </>
      ) : null}
    </Sheet>
  );
}

// ---------------------------------------------------------------------------
// 7 · Logs
// ---------------------------------------------------------------------------

type SevKey = "all" | "ERROR" | "WARN" | "INFO" | "DEBUG";

const SEVERITIES: ReadonlyArray<{ key: SevKey; label: string }> = [
  { key: "all", label: "All" },
  { key: "ERROR", label: "ERROR" },
  { key: "WARN", label: "WARN" },
  { key: "INFO", label: "INFO" },
  { key: "DEBUG", label: "DEBUG" },
];

/**
 * Only the levels Loom actually writes get a colour. Anything else stays
 * graphite rather than being guessed into a severity it may not have.
 */
function sevTint(sev: string): string {
  const s = sev.toUpperCase();
  if (s === "FATAL" || s === "ERROR") return T.err;
  if (s === "WARN" || s === "WARNING") return T.warn;
  if (s === "INFO") return T.thread;
  if (s === "DEBUG" || s === "TRACE") return T.faint;
  return T.dim;
}

/**
 * The fleet's own log lines, read back out of the telemetry backend.
 *
 * Loom has emitted all three OTel signals for a long time but could only ever
 * read traces back, which is a strange thing to ship in an observability tool.
 * This is the other half.
 *
 * There is deliberately NO local fallback, and that is the one thing this panel
 * has to be honest about. A span has a fallback because a span is a summary of
 * an event that is already on the daemon's disk, so /insights/spans can answer
 * "local-log" and still be telling the truth. A log line is not: its severity,
 * its body and its trace correlation only exist once the record was built and
 * shipped. Rebuilding something log-shaped from the event log would be inventing
 * data. So when the backend is unreachable the daemon answers `from:
 * "unavailable"` and this prints that, rather than rendering an empty list —
 * which a reader would take as "nothing happened", the exact opposite claim.
 */
function LogsView(props: { creds: Creds; projectId: string }) {
  const [sev, setSev] = useState<SevKey>("all");
  const [text, setText] = useState("");
  const [q, setQ] = useState("");

  // The filter is part of the request key, so typing straight into it would fire
  // one backend round-trip per keystroke. 350ms is the same beat the MCP
  // registry search uses elsewhere in the app.
  useEffect(() => {
    const t = setTimeout(() => setQ(text.trim()), 350);
    return () => clearTimeout(t);
  }, [text]);

  const severity = sev === "all" ? "" : sev;
  const logs = useResource(
    () => getLogs(props.creds, props.projectId, { severity, q, limit: 300 }),
    `l:${props.projectId}:${severity}:${q}`,
    { pollMs: 10000 },
  );

  return (
    <Load res={logs} what="logs">
      {(d) =>
        d.from === "unavailable" ? (
          <Unread />
        ) : (
          <>
            <Panel padded={false}>
              <Segmented options={SEVERITIES} value={sev} onChange={setSev} accent={T.primaryDim} />
              <View style={{ paddingHorizontal: spacing.md, paddingBottom: spacing.md }}>
                <TextInput
                  style={{ ...field, paddingVertical: 10, fontSize: 14 }}
                  value={text}
                  onChangeText={setText}
                  autoCapitalize="none"
                  autoCorrect={false}
                  placeholder="filter text…"
                  placeholderTextColor={T.faint}
                  selectionColor={T.accentBlue}
                  accessibilityLabel="Filter log lines by the text of their body"
                />
              </View>
            </Panel>

            <Panel padded={false}>
              <View style={{ paddingHorizontal: 12, paddingTop: 12 }}>
                <SectionLabel
                  text={`Logs · ${d.logs.length} line${d.logs.length === 1 ? "" : "s"} · from the telemetry store`}
                />
              </View>
              {!d.logs.length ? (
                <View style={{ padding: 12 }}>
                  <Empty text="No log lines match. Loom ships every message, tool call, file edit and error — widen the filter." />
                </View>
              ) : (
                <View>
                  {d.logs.map((l, i) => (
                    <LogRow key={`${l.ts}-${i}`} log={l} last={i === d.logs.length - 1} />
                  ))}
                </View>
              )}
            </Panel>
          </>
        )
      }
    </Load>
  );
}

/** The one case where an empty list would be a lie, said out loud instead. */
function Unread() {
  return (
    <Panel tint={T.warn}>
      <SectionLabel text="Logs" />
      <Text style={{ color: T.text, fontSize: 13.5, lineHeight: 20 }}>
        Logs live in the telemetry store, and it isn&apos;t answering — so there is nothing to
        read. Unlike spans, logs have no local fallback. Bring your collector up on the
        daemon&apos;s machine and this fills in.
      </Text>
      <Text style={{ color: T.faint, fontSize: 10.5, fontFamily: T.mono, lineHeight: 17 }}>
        this is an unread run, not a quiet one — the fleet may have said plenty
      </Text>
    </Panel>
  );
}

/**
 * One line. Two rows rather than one: at 375pt a time, a level, an agent, a
 * trace and a body cannot share a line without the body becoming a stub, and the
 * body is the part anyone came for. It wraps to four lines and then truncates —
 * never wider than the panel.
 */
function LogRow(props: { log: InsightLog; last: boolean }) {
  const l = props.log;
  const sev = (l.severity || "INFO").toUpperCase();
  const tint = sevTint(sev);
  return (
    <View
      style={{
        borderBottomWidth: props.last ? 0 : 1,
        borderBottomColor: T.line,
        borderLeftWidth: 2,
        borderLeftColor: tint,
        paddingHorizontal: 10,
        paddingVertical: 7,
        gap: 3,
      }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: 7 }}>
        <Text style={{ color: T.faint, fontSize: 10, fontFamily: T.mono }}>
          {new Date(l.ts).toLocaleTimeString()}
        </Text>
        <Text style={{ color: tint, fontSize: 9.5, fontFamily: T.mono, fontWeight: "700", letterSpacing: 0.4 }}>
          {sev}
        </Text>
        <Text
          style={{ color: l.agent ? hue(l.agent) : T.faint, fontSize: 10, fontFamily: T.mono, flexShrink: 1 }}
          numberOfLines={1}
        >
          {l.agent ? trunc(l.agent, 14) : "—"}
        </Text>
        <View style={{ flex: 1 }} />
        {/* A short trace id, tinted by the trace it belongs to: lines from one
            turn share a colour, which is the correlation you want while
            scrolling. Not a link — the phone has no telemetry backend base URL
            to build one from, and inventing a host would be worse than not
            offering the tap. */}
        {l.traceId ? (
          <View
            style={{
              borderWidth: 1,
              borderColor: T.line2,
              borderRadius: radii.pill,
              paddingHorizontal: 6,
              paddingVertical: 1,
            }}
          >
            <Text style={{ color: hue(l.traceId), fontSize: 9.5, fontFamily: T.mono }}>
              {l.traceId.slice(0, 8)}
            </Text>
          </View>
        ) : null}
      </View>
      <Text style={{ color: T.text, fontSize: 11.5, fontFamily: T.mono, lineHeight: 17 }} numberOfLines={4}>
        {l.body}
      </Text>
    </View>
  );
}

// ---------------------------------------------------------------------------
// 8 · Replay
// ---------------------------------------------------------------------------

function ReplayView(props: {
  snapshots: Res<{ snapshots: TimeSnapshot[] }>;
  decisions: Res<{ decisions: AgentDecision[]; stats: DecisionStats }>;
  spans: Res<{ from: string; spans: InsightSpan[] }>;
}) {
  const [idx, setIdx] = useState<number | null>(null);
  const all = props.snapshots.data?.snapshots ?? [];
  // Default to the newest frame — "now" is the state a person already believes
  // they're looking at, so a scrubber that opens at t=0 reads as broken.
  const i = idx == null ? Math.max(0, all.length - 1) : Math.min(idx, all.length - 1);

  return (
    <Load res={props.snapshots} what="replay snapshots">
      {(d) => {
        const snaps = d.snapshots;
        if (!snaps.length)
          return <Empty text="Nothing to replay yet. Snapshots are folded from the event log — the first turn or handoff creates the first frame." />;
        const s = snaps[i]!;
        const decs = props.decisions.data?.decisions ?? [];
        const byId = new Map(decs.map((x) => [x.id, x]));
        const running = (props.spans.data?.spans ?? []).find(
          (x) => x.name === TURN_SPAN && x.ts <= s.timestampMs && s.timestampMs <= x.ts + Math.max(1, x.ms),
        );
        const states = Object.entries(s.agentStates);

        return (
          <>
            <Panel>
              <View style={{ flexDirection: "row", alignItems: "baseline", gap: 8 }}>
                <SectionLabel text={`Frame ${i + 1} of ${snaps.length}`} />
                <View style={{ flex: 1 }} />
                <Text style={{ color: T.text, fontSize: 11.5, fontFamily: T.mono }}>turn {s.turnIndex}</Text>
              </View>
              <Text style={{ color: T.dim, fontSize: 11.5, fontFamily: T.mono }}>
                {new Date(s.timestampMs).toLocaleString()}
              </Text>
              <Scrubber count={snaps.length} index={i} onIndex={setIdx} />
              <Text style={{ color: T.dim, fontSize: 12, lineHeight: 18 }} numberOfLines={2}>
                {s.triggerEvent.description}
              </Text>
            </Panel>

            <Panel tint={T.primaryDim}>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                <Text style={{ color: T.faint, fontSize: 11, fontFamily: T.mono, flex: 1 }}>baton at this instant</Text>
                <Text style={{ color: T.shuttle, fontSize: 14, fontWeight: "700" }} numberOfLines={1}>
                  {s.batonHolder || "—"}
                </Text>
              </View>
              <View style={{ flexDirection: "row", gap: 6, flexWrap: "wrap" }}>
                <Badge text={`thread ${s.threadLength} messages`} />
                <Badge text={`${s.decisionsAtPoint.length} decisions so far`} />
                <Badge text={`${s.filesCreatedSoFar} created · ${s.filesModifiedSoFar} modified`} />
              </View>
              {/* The turn actually in flight at that moment, matched by span window. */}
              {running ? (
                <Text style={{ color: T.thread, fontSize: 11.5, fontFamily: T.mono, lineHeight: 18 }} numberOfLines={2}>
                  ▶ {running.agent || "agent"} was mid-turn · {dur(running.ms)}
                  {running.model ? ` · ${trunc(running.model, 24)}` : ""}
                </Text>
              ) : (
                <Text style={{ color: T.faint, fontSize: 11.5, fontFamily: T.mono }}>
                  no turn was running at this instant
                  {props.spans.data ? "" : " (turn spans still loading)"}
                </Text>
              )}
            </Panel>

            <Panel>
              <SectionLabel text="Fleet at this instant" />
              {!states.length ? (
                <Empty text="No agent had acted by this frame." />
              ) : (
                states.map(([id, st]) => (
                  <View key={id} style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 4 }}>
                    <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: statusTint(st.status) }} />
                    <Text style={{ color: id === s.batonHolder ? T.shuttle : T.text, fontSize: 12.5, flex: 1 }} numberOfLines={1}>
                      {trunc(id, 20)}
                    </Text>
                    <Text style={{ color: T.dim, fontSize: 11, fontFamily: T.mono }}>
                      {st.turnsCompleted}t · {tok(st.tokensUsed)} · {usd(st.costUsd) || "$0"}
                    </Text>
                  </View>
                ))
              )}
            </Panel>

            <Panel>
              <SectionLabel text={`Decisions made by this point (${s.decisionsAtPoint.length})`} />
              {!s.decisionsAtPoint.length ? (
                <Text style={{ color: T.faint, fontSize: 12 }}>None yet at this frame.</Text>
              ) : (
                s.decisionsAtPoint.map((id) => {
                  const dec = byId.get(id);
                  return (
                    <Text key={id} style={{ color: T.dim, fontSize: 12, lineHeight: 18 }} numberOfLines={2}>
                      ★ {dec ? `${dec.agentId} — ${dec.title}` : id}
                    </Text>
                  );
                })
              )}
              {!props.decisions.data && s.decisionsAtPoint.length ? (
                <Text style={{ color: T.faint, fontSize: 10.5, fontFamily: T.mono }}>
                  titles load with the Decisions view
                </Text>
              ) : null}
            </Panel>

            {s.lastMessage ? (
              <Panel>
                <SectionLabel text={`Last message · ${trunc(s.lastMessage.agentId, 18)}`} />
                <Text style={{ color: T.dim, fontSize: 12.5, lineHeight: 19 }} numberOfLines={6}>
                  {s.lastMessage.text}
                </Text>
              </Panel>
            ) : null}
          </>
        );
      }}
    </Load>
  );
}

/**
 * The scrub track. RN core ships no slider, and pulling one in for a single
 * control is not worth a native module — so this is a PanResponder over a
 * measured track, with ± buttons beside it because dragging one frame out of a
 * hundred and fifty with a thumb is not a thing anyone can do.
 */
function Scrubber(props: { count: number; index: number; onIndex: (i: number) => void }) {
  const [w, setW] = useState(0);
  const wRef = useRef(0);
  const countRef = useRef(props.count);
  const onIndexRef = useRef(props.onIndex);
  const grabbedAt = useRef(0);
  wRef.current = w;
  countRef.current = props.count;
  onIndexRef.current = props.onIndex;

  const commit = (px: number) => {
    const width = wRef.current;
    const n = countRef.current;
    if (width <= 0 || n <= 1) return;
    const ratio = Math.max(0, Math.min(1, px / width));
    onIndexRef.current(Math.round(ratio * (n - 1)));
  };

  const pan = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderGrant: (e) => {
        grabbedAt.current = e.nativeEvent.locationX;
        commit(grabbedAt.current);
      },
      // gestureState.dx is measured from the grant point, so this stays correct
      // without needing the track's absolute page position.
      onPanResponderMove: (_e, g) => commit(grabbedAt.current + g.dx),
    }),
  ).current;

  const pct = props.count > 1 ? props.index / (props.count - 1) : 0;
  const step = (delta: number) =>
    props.onIndex(Math.max(0, Math.min(props.count - 1, props.index + delta)));

  return (
    <View style={{ gap: 8 }}>
      <View
        {...pan.panHandlers}
        onLayout={(e) => setW(e.nativeEvent.layout.width)}
        accessibilityRole="adjustable"
        accessibilityLabel={`Replay position, frame ${props.index + 1} of ${props.count}`}
        // The touchable band is 44pt even though the track is 6pt — a hairline
        // is a fine thing to look at and an impossible thing to hit.
        style={{ height: TAP, justifyContent: "center" }}
      >
        <View style={{ height: 6, backgroundColor: T.raised, borderRadius: radii.pill, overflow: "hidden" }}>
          <View style={{ width: `${pct * 100}%`, height: "100%", backgroundColor: T.primary }} />
        </View>
        {w > 0 ? (
          <View
            pointerEvents="none"
            style={{
              position: "absolute",
              left: Math.max(0, Math.min(w - 16, pct * w - 8)),
              width: 16,
              height: 16,
              borderRadius: 8,
              backgroundColor: T.bright,
              borderWidth: 2,
              borderColor: T.primary,
            }}
          />
        ) : null}
      </View>
      <View style={{ flexDirection: "row", gap: 8 }}>
        {(
          [
            { label: "⏮", to: 0, a11y: "Jump to the first frame" },
            { label: "◀", to: props.index - 1, a11y: "Previous frame" },
            { label: "▶", to: props.index + 1, a11y: "Next frame" },
            { label: "⏭", to: props.count - 1, a11y: "Jump to the last frame" },
          ] as const
        ).map((b) => (
          <TouchableOpacity
            key={b.label}
            onPress={() => (b.label === "◀" || b.label === "▶" ? step(b.label === "◀" ? -1 : 1) : props.onIndex(b.to))}
            activeOpacity={0.7}
            accessibilityRole="button"
            accessibilityLabel={b.a11y}
            style={{
              flex: 1,
              minHeight: TAP,
              alignItems: "center",
              justifyContent: "center",
              backgroundColor: T.raised,
              borderWidth: 1,
              borderColor: T.line,
              borderRadius: radii.key,
            }}
          >
            <Text style={{ color: T.text, fontSize: 14 }}>{b.label}</Text>
          </TouchableOpacity>
        ))}
      </View>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Sheets
// ---------------------------------------------------------------------------

/** The bottom sheet every detail view in the app uses. */
export function Sheet(props: {
  title: string;
  visible: boolean;
  onClose: () => void;
  children: React.ReactNode;
}) {
  return (
    <Modal visible={props.visible} transparent animationType="fade" onRequestClose={props.onClose}>
      <View style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.6)", justifyContent: "flex-end" }}>
        <View
          style={{
            backgroundColor: T.bg,
            borderTopLeftRadius: 18,
            borderTopRightRadius: 18,
            borderWidth: 1,
            borderColor: T.line,
            maxHeight: "86%",
            paddingBottom: 28,
          }}
        >
          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              paddingLeft: spacing.md,
              paddingRight: spacing.sm,
              paddingVertical: spacing.sm,
              borderBottomWidth: 1,
              borderBottomColor: T.line,
            }}
          >
            <Text style={{ color: T.text, fontSize: 15, fontWeight: "700", flex: 1 }} numberOfLines={1}>
              {props.title}
            </Text>
            <TouchableOpacity
              onPress={props.onClose}
              activeOpacity={0.7}
              accessibilityRole="button"
              accessibilityLabel="Close"
              style={{ width: TAP, height: TAP, alignItems: "center", justifyContent: "center" }}
            >
              <Text style={{ color: T.dim, fontSize: 20, lineHeight: 22 }}>✕</Text>
            </TouchableOpacity>
          </View>
          <ScrollView contentContainerStyle={{ padding: spacing.md, gap: spacing.md }}>
            {props.children}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

/** "Why did I fail?" — the agent root-causes itself from its own traces. */
function TriageSheet(props: {
  creds: Creds;
  projectId: string;
  agentId: string | null;
  onClose: () => void;
}) {
  const [triage, setTriage] = useState<Triage | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const { creds, projectId, agentId } = props;

  const run = useCallback(() => {
    if (!agentId) return;
    setTriage(null);
    setErr(null);
    void getTriage(creds, projectId, agentId)
      .then(({ triage: r }) => setTriage(r))
      .catch((e: unknown) => setErr(e instanceof Error ? e.message : String(e)));
  }, [creds, projectId, agentId]);

  useEffect(run, [run]);

  return (
    <Sheet title={agentId ? `Triage · ${trunc(agentId, 20)}` : ""} visible={agentId !== null} onClose={props.onClose}>
      {err ? (
        <Unreachable what={`${agentId}'s triage`} detail={err} onRetry={run} />
      ) : !triage ? (
        <View style={{ alignItems: "center", paddingVertical: 40, gap: 12 }}>
          <ActivityIndicator color={T.primary} />
          <Sys text={`Reading ${agentId}'s traces…`} />
        </View>
      ) : (
        <>
          <View style={{ flexDirection: "row", gap: 6, flexWrap: "wrap" }}>
            <Badge
              text={triage.source === "llm" ? "root-caused by an LLM" : triage.source === "no-data" ? "no data" : "rule-based"}
              tint={triage.source === "llm" ? T.primary : T.dim}
            />
            <Badge
              text={triage.from === "backend" ? "from the telemetry store" : triage.from === "local-log" ? "from the event log" : "no source"}
            />
            <Badge text={`${triage.spanCount} spans · ${triage.errorCount} err`} tint={triage.errorCount ? T.warn : T.dim} />
          </View>
          <Callout label="Root cause" text={triage.rootCause} tint={triage.errorCount ? T.warn : T.ok} />
          <Callout label="Suggested fix" text={triage.suggestedFix} tint={T.primary} />
          {triage.evidence.length ? (
            <View style={{ gap: 4 }}>
              <SectionLabel text="Evidence (its own spans)" />
              {triage.evidence.slice(0, 12).map((s, i) => (
                <Text
                  key={i}
                  style={{ color: s.code === 2 ? T.err : T.dim, fontSize: 11, fontFamily: T.mono, lineHeight: 17 }}
                  numberOfLines={2}
                >
                  {s.name}
                  {s.ms ? ` · ${dur(s.ms)}` : ""}
                  {s.msg ? ` · ${s.msg}` : ""}
                </Text>
              ))}
            </View>
          ) : (
            <Empty text="No spans for this agent yet — there is nothing to root-cause from." />
          )}
        </>
      )}
    </Sheet>
  );
}
