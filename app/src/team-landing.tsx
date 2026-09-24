/**
 * Landing on the phone (Loom Teams Phase 4, "land safely"): the project's goal
 * PRs on their way to main, and teammates' goals waiting for someone.
 *
 * The phone's job here (D25) is to react to what needs you — a goal PR that
 * needs a human, a teammate's goal nobody has picked up — and to press Land
 * from anywhere. Everything else (fix attempts, reruns, the review) the daemon
 * does on its own; the card only says where it stands.
 *
 * Pull to refresh asks the daemon to check the PRs with the git host first
 * (poll=1). Every action answers with the goals as they now stand.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, Alert, Linking, RefreshControl, ScrollView, Text, TextInput, TouchableOpacity, View } from "react-native";
import {
  getTeam,
  getTeamLanding,
  teamLandingAction,
  type AdoptablePr,
  type Creds,
  type LandingAction,
  type LandingGoal,
  type Project,
  type TeamCosts,
  type TeamLanding,
} from "./api";
import { Badge, Btn, Empty, Panel, SectionLabel, Unreachable, field } from "./components";
import { openableUrl } from "./team-brain-model";
import {
  adoptConfirm,
  costSummary,
  dollars,
  landBlockedNote,
  landingBadge,
  landingButtons,
  reviewLine,
  sortGoals,
  stateChip,
  type Tone,
} from "./team-landing-model";
import { T, radii, spacing } from "./theme";

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

function statusOf(e: unknown): number | undefined {
  const s = (e as { status?: unknown } | null)?.status;
  return typeof s === "number" ? s : undefined;
}

export const TONE: Record<Tone, string> = {
  get ok() {
    return T.ok;
  },
  get warn() {
    return T.warn;
  },
  get err() {
    return T.err;
  },
  get live() {
    return T.thread;
  },
  get merged() {
    return T.primary;
  },
  get dim() {
    return T.dim;
  },
};

const open = (url: string | null) => {
  if (url) void Linking.openURL(url).catch(() => {});
};

/** "PR #12", tappable when the URL is a web link. */
function PrLink(props: { pr: number; url: string }) {
  const url = openableUrl(props.url);
  return (
    <TouchableOpacity
      disabled={!url}
      onPress={() => open(url)}
      accessibilityRole="link"
      accessibilityLabel={`Open pull request ${props.pr}`}
      hitSlop={8}
    >
      <Text style={{ color: url ? T.accentBlue : T.dim, fontSize: 12.5, fontFamily: T.mono, fontWeight: "600" }}>
        PR #{props.pr}
      </Text>
    </TouchableOpacity>
  );
}

const meta = {
  get color() {
    return T.faint;
  },
  fontSize: 11,
  fontFamily: T.mono,
};

function GoalCard(props: {
  g: LandingGoal;
  busy: boolean;
  onRun: (g: LandingGoal, action: LandingAction, body: Record<string, unknown>) => Promise<boolean>;
}) {
  const { g } = props;
  const l = g.landing;
  const chip = stateChip(l.state);
  const tint = TONE[chip.tone];
  const buttons = landingButtons(g);
  const note = landBlockedNote(g);
  const review = reviewLine(l.review);
  const failing = l.checks?.failing ?? [];
  const pending = l.checks?.pending ?? [];
  const [overriding, setOverriding] = useState(false);
  const [why, setWhy] = useState("");

  const land = () =>
    Alert.alert(
      `Land PR #${l.pr}?`,
      "Loom brings in fresh main, runs the team's fast tests, pushes, and merges once GitHub's rules pass.",
      [
        { text: "Cancel", style: "cancel" },
        { text: "Land", onPress: () => void props.onRun(g, "land", { runId: g.runId }) },
      ],
    );

  const override = async () => {
    const reason = why.trim();
    if (!reason) return;
    if (await props.onRun(g, "override", { runId: g.runId, reason })) {
      setOverriding(false);
      setWhy("");
    }
  };

  return (
    <View
      style={{
        gap: 7,
        padding: 12,
        borderRadius: radii.card,
        borderWidth: 1,
        borderColor: chip.attention ? tint : T.line,
        borderLeftWidth: 2,
        borderLeftColor: tint,
        backgroundColor: T.panel,
      }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <Badge text={chip.label} tint={tint} />
        <PrLink pr={l.pr} url={l.url} />
        {g.costUsd > 0 ? <Text style={[meta, { marginLeft: "auto" }]}>{dollars(g.costUsd)}</Text> : null}
      </View>
      <Text style={{ color: T.text, fontSize: 13.5, lineHeight: 19 }} numberOfLines={3}>
        {g.goal}
      </Text>

      {l.state === "needs_human" && l.reason ? (
        <Text style={{ color: T.err, fontSize: 12.5, lineHeight: 18 }} selectable>
          {l.reason}
        </Text>
      ) : l.reason && !["merged", "closed"].includes(l.state) ? (
        <Text style={{ color: T.dim, fontSize: 12, lineHeight: 17 }}>{l.reason}</Text>
      ) : null}

      {failing.length ? (
        <Text style={{ color: T.err, fontSize: 11.5, fontFamily: T.mono }} numberOfLines={3}>
          ✗ {failing.join(", ")}
        </Text>
      ) : null}
      {l.checks && (pending.length || l.checks.passing) ? (
        <Text style={meta} numberOfLines={1}>
          {l.checks.passing} passing{pending.length ? ` · ${pending.length} running` : ""}
        </Text>
      ) : null}
      {l.flaky?.length ? (
        <Text style={{ color: T.warn, fontSize: 11.5 }} numberOfLines={2}>
          Flaky (failed, then passed on rerun): {l.flaky.join(", ")}
        </Text>
      ) : null}
      {review ? (
        <Text
          style={{
            color: l.review?.state === "failure" && !l.review.overridden ? T.err : T.dim,
            fontSize: 11.5,
            fontFamily: T.mono,
          }}
          numberOfLines={2}
        >
          {review}
        </Text>
      ) : null}
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        {l.fixAttempts ? <Text style={meta}>{l.fixAttempts} fix attempt{l.fixAttempts === 1 ? "" : "s"}</Text> : null}
        {l.adoptedBy ? <Text style={[meta, { color: T.thread }]}>adopted by @{l.adoptedBy}</Text> : null}
        {g.adopted ? (
          <Text style={meta}>adopted from {g.adopted.owner ? `@${g.adopted.owner}` : "a teammate"}</Text>
        ) : null}
        {l.stack?.length ? <Text style={meta}>stack of {l.stack.length}</Text> : null}
      </View>
      {l.stack && l.stack.length > 1 ? (
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 10 }}>
          {l.stack.map((s) => (
            <PrLink key={s.pr} pr={s.pr} url={s.url} />
          ))}
        </View>
      ) : null}
      {note ? <Text style={{ color: T.faint, fontSize: 11.5, lineHeight: 16 }}>{note}</Text> : null}

      {overriding ? (
        <View style={{ gap: 6 }}>
          <TextInput
            value={why}
            onChangeText={setWhy}
            autoFocus
            multiline
            placeholder="Why the review is wrong (goes on the PR)"
            placeholderTextColor={T.faint}
            accessibilityLabel="Reason for overriding the review"
            style={{ ...field, fontSize: 13, minHeight: 56, textAlignVertical: "top" }}
          />
          {props.busy ? (
            <ActivityIndicator color={T.dim} />
          ) : (
            <View style={{ flexDirection: "row", gap: 8, justifyContent: "flex-end" }}>
              <Btn small label="Cancel" onPress={() => setOverriding(false)} />
              <Btn small primary label="Override" onPress={() => void override()} />
            </View>
          )}
        </View>
      ) : props.busy ? (
        <View style={{ minHeight: 30, alignItems: "center", justifyContent: "center" }}>
          <ActivityIndicator color={T.dim} />
        </View>
      ) : buttons.length ? (
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
          {buttons.map((b) =>
            b === "land" ? (
              <Btn key={b} small primary label="Land" onPress={land} />
            ) : b === "override" ? (
              <Btn key={b} small label="Override review" onPress={() => setOverriding(true)} />
            ) : (
              <Btn key={b} small label="Re-review" onPress={() => void props.onRun(g, "review", { runId: g.runId })} />
            ),
          )}
        </View>
      ) : null}
    </View>
  );
}

function AdoptRow(props: { p: AdoptablePr; busy: boolean; onAdopt: (p: AdoptablePr) => void }) {
  const { p } = props;
  return (
    <View style={{ gap: 5, paddingVertical: 8, borderTopWidth: 1, borderTopColor: T.line }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <PrLink pr={p.pr} url={p.url} />
        <Text style={{ color: T.text, fontSize: 12.5, fontWeight: "600" }} numberOfLines={1}>
          @{p.owner}
        </Text>
        <View style={{ marginLeft: "auto" }}>
          {props.busy ? <ActivityIndicator color={T.dim} /> : <Btn small primary label="Adopt" onPress={() => props.onAdopt(p)} />}
        </View>
      </View>
      <Text style={{ color: T.dim, fontSize: 12, lineHeight: 17 }}>{p.reason}</Text>
      <Text style={meta} numberOfLines={1}>
        {p.branch}
      </Text>
    </View>
  );
}

function CostsPanel(props: { costs: TeamCosts }) {
  const c = costSummary(props.costs);
  if (!c) return null;
  return (
    <View style={{ gap: 6 }}>
      <SectionLabel text="Team spend" />
      <Panel>
        <View style={{ flexDirection: "row", gap: spacing.md }}>
          {[
            ["today", dollars(c.todayUsd)],
            ["per landed PR", c.perLandedPrUsd == null ? "—" : dollars(c.perLandedPrUsd)],
            ["total", dollars(c.totalUsd)],
            ...(c.ciMinutes ? [["CI time", `${c.ciMinutes} min`]] : []),
          ].map(([k, v]) => (
            <View key={k} style={{ flex: 1, gap: 2 }}>
              <Text style={{ color: T.text, fontSize: 15, fontWeight: "600", fontFamily: T.mono }}>{v}</Text>
              <Text style={{ color: T.faint, fontSize: 10.5 }}>{k}</Text>
            </View>
          ))}
        </View>
        <Text style={meta}>
          {c.landed} landed PR{c.landed === 1 ? "" : "s"}
        </Text>
        {c.today.length ? (
          c.today.map((r) => (
            <View key={r.member} style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
              <Text style={{ color: T.dim, fontSize: 12, flex: 1 }} numberOfLines={1}>
                @{r.member}
              </Text>
              <Text style={meta}>
                {r.goals} goal{r.goals === 1 ? "" : "s"}
              </Text>
              <Text style={{ color: T.text, fontSize: 12, fontFamily: T.mono }}>{dollars(r.usd)}</Text>
            </View>
          ))
        ) : (
          <Text style={{ color: T.faint, fontSize: 11.5 }}>No finished goals today.</Text>
        )}
      </Panel>
    </View>
  );
}

/**
 * The project's Landing tab. `onChanged` hands every fresh read up so the tab
 * strip's badge stays in step; `pulse` bumps on orchestra events (landing
 * progress rides those) and refetches without polling the git host.
 */
export function TeamLandingView(props: {
  creds: Creds;
  project: Project;
  teamId?: string | null;
  pulse?: number;
  onChanged?: (t: TeamLanding) => void;
}) {
  const { creds, project, teamId } = props;
  const [data, setData] = useState<TeamLanding | null>(null);
  const [costs, setCosts] = useState<TeamCosts | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const onChanged = useRef(props.onChanged);
  onChanged.current = props.onChanged;

  const take = useCallback((t: TeamLanding) => {
    setData(t);
    setErr(null);
    onChanged.current?.(t);
  }, []);

  const load = useCallback(
    async (poll: boolean) => {
      try {
        take(await getTeamLanding(creds, project.id, { poll }));
      } catch (e) {
        setErr(statusOf(e) === 404 ? "This daemon doesn't land goals yet. Update Loom on your computer." : errText(e));
      }
    },
    [creds, project.id, take],
  );

  const loadCosts = useCallback(() => {
    void getTeam(creds)
      .then(({ teams }) => {
        const t = (teamId ? teams.find((x) => x.id === teamId) : null) ?? (teams.length === 1 ? teams[0] : null);
        setCosts(t?.costs ?? null);
      })
      .catch(() => {}); // costs are a nicety; the goals still show
  }, [creds, teamId]);

  useEffect(() => {
    void load(false);
    loadCosts();
  }, [load, loadCosts]);

  const pulse = props.pulse ?? 0;
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    const t = setTimeout(() => void load(false), 600); // a burst of events → one read
    return () => clearTimeout(t);
  }, [pulse, load]);

  const refresh = async () => {
    setRefreshing(true);
    await load(true);
    loadCosts();
    setRefreshing(false);
  };

  const run = async (key: string, action: LandingAction, body: Record<string, unknown>) => {
    setBusy(key);
    try {
      const out = await teamLandingAction(creds, project.id, action, body);
      const next: TeamLanding = {
        goals: out.goals ?? data?.goals ?? [],
        adoptable: (data?.adoptable ?? []).filter((p) => action !== "adopt" || p.pr !== body.pr),
      };
      take(next);
      if (action === "adopt") void load(false); // the adopted goal's own run, and a fresh adoptable list
      return true;
    } catch (e) {
      Alert.alert("Couldn't do that", errText(e));
      return false;
    } finally {
      setBusy(null);
    }
  };

  const onAdopt = (p: AdoptablePr) =>
    Alert.alert(`Adopt PR #${p.pr}?`, adoptConfirm(p), [
      { text: "Cancel", style: "cancel" },
      { text: "Adopt", onPress: () => void run(`adopt:${p.pr}`, "adopt", { pr: p.pr }) },
    ]);

  let body: React.ReactNode;
  if (err && !data) {
    body = <Unreachable what="landing" detail={err} onRetry={() => void load(false)} />;
  } else if (!data) {
    body = <ActivityIndicator color={T.dim} style={{ marginVertical: 24 }} />;
  } else {
    const goals = sortGoals(data.goals);
    const needs = landingBadge(data);
    body = (
      <View style={{ gap: spacing.md }}>
        <Text style={meta} numberOfLines={2}>
          {goals.length} goal PR{goals.length === 1 ? "" : "s"} · {needs} need{needs === 1 ? "s" : ""} someone
        </Text>

        {data.adoptable.length ? (
          <View style={{ gap: 6 }}>
            <SectionLabel text={`Needs someone · ${data.adoptable.length}`} />
            <Panel tint={T.warn}>
              <View style={{ marginTop: -8 }}>
                {data.adoptable.map((p) => (
                  <AdoptRow key={p.pr} p={p} busy={busy === `adopt:${p.pr}`} onAdopt={onAdopt} />
                ))}
              </View>
            </Panel>
          </View>
        ) : null}

        <View style={{ gap: 6 }}>
          <SectionLabel text={`Goal PRs · ${goals.length}`} />
          {goals.length ? (
            goals.map((g) => (
              <GoalCard key={g.runId} g={g} busy={busy === g.runId} onRun={(x, a, b) => run(x.runId, a, b)} />
            ))
          ) : (
            <Empty text="No goal PRs yet. When an Orchestra goal opens a pull request, its way to main shows here: checks, fixes, the review, and Land." />
          )}
        </View>

        {costs ? <CostsPanel costs={costs} /> : null}
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
      {err && data ? <Text style={{ color: T.err, fontSize: 12, textAlign: "center" }}>{err}</Text> : null}
    </ScrollView>
  );
}

/**
 * The tab badge (needs_human goals + adoptable PRs), from what the daemon
 * already has (no git-host poll): on open, every 30s, and shortly after an
 * orchestra event. `hidden` when this daemon predates landing.
 */
export function useLandingSummary(creds: Creds, projectId: string, pulse = 0) {
  const [summary, setSummary] = useState<{ count: number; goals: number; hidden: boolean }>({
    count: 0,
    goals: 0,
    hidden: false,
  });
  const gone = useRef(false);
  const update = useCallback((t: TeamLanding) => {
    setSummary({ count: landingBadge(t), goals: t.goals?.length ?? 0, hidden: false });
  }, []);
  const tick = useCallback(
    (live: () => boolean) => {
      if (gone.current) return;
      getTeamLanding(creds, projectId)
        .then((t) => {
          if (live()) update(t);
        })
        .catch((e) => {
          const st = statusOf(e);
          if (st === 404 || st === 403) {
            gone.current = true;
            if (live()) setSummary({ count: 0, goals: 0, hidden: true });
          }
        });
    },
    [creds, projectId, update],
  );
  useEffect(() => {
    gone.current = false;
    let live = true;
    tick(() => live);
    const t = setInterval(() => tick(() => live), 30_000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [tick]);
  useEffect(() => {
    if (!pulse) return;
    let live = true;
    const t = setTimeout(() => tick(() => live), 1500);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [pulse, tick]);
  return { summary, update };
}
