/**
 * Crews on the phone (Agent Teams): a lead, builders, a reviewer and a tester
 * working one goal on its own branch. The phone is where you keep the crew
 * moving while you're away from the desk — approve its plan, answer what a
 * teammate asks, give it the next goal, stop or resume it, look at what it
 * changed and apply it.
 *
 * Event-driven like Orchestra: every step is a `crew` event, the parent bumps
 * `pulse` when one lands, and this refetches then. A slow poll backs it up
 * while the crew works, because a phone can drop the feed without noticing.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Alert, ScrollView, Text, TextInput, TouchableOpacity, View } from "react-native";
import {
  createCrew,
  crewAction,
  crewDiff,
  getCrews,
  getEvents,
  updateCrew,
  type Creds,
  type Crew,
  type CrewAction,
  type CrewCard,
  type CrewCardStage,
  type CrewGoal,
  type CrewGoalStatus,
  type CrewRole,
  type CrewTeammate,
  type LoomEvent,
  type Project,
} from "./api";
import { AgentIcon } from "./agents";
import { Empty, Panel, SectionLabel, TAP, Unreachable } from "./components";
import { haptic } from "./haptics";
import { T, radii, spacing, usd } from "./theme";

const ROLE: Record<CrewRole, { label: string; color: () => string; does: string }> = {
  lead: { label: "Lead", color: () => T.shuttle, does: "plans the goal into cards" },
  builder: { label: "Builder", color: () => T.thread, does: "builds a card" },
  reviewer: { label: "Reviewer", color: () => T.warn, does: "reviews each card's diff" },
  tester: { label: "Tester", color: () => T.ok, does: "runs the tests on each card" },
  researcher: { label: "Researcher", color: () => T.accentBlue, does: "investigates and writes up" },
};

const GOAL_LOOK: Record<CrewGoalStatus, { label: string; color: () => string }> = {
  planning: { label: "planning", color: () => T.thread },
  awaiting_approval: { label: "needs your OK", color: () => T.warn },
  running: { label: "working", color: () => T.thread },
  waiting_human: { label: "needs you", color: () => T.warn },
  completed: { label: "completed", color: () => T.ok },
  failed: { label: "failed", color: () => T.err },
  stopped: { label: "stopped", color: () => T.dim },
  interrupted: { label: "interrupted", color: () => T.warn },
};

const STAGE_ORDER: CrewCardStage[] = ["building", "review", "testing", "planned", "done", "failed"];
const STAGE_LABEL: Record<CrewCardStage, string> = {
  planned: "Planned", building: "Building", review: "In review", testing: "Testing", done: "Done", failed: "Failed",
};
const STEP_VERB: Record<string, string> = { plan: "planning", planned: "starting", building: "building", review: "reviewing", testing: "testing", done: "wrapping up" };

const TEMPLATES: Array<{ id: string; name: string; who: string }> = [
  { id: "ship", name: "Ship", who: "lead, two builders, a reviewer and a tester" },
  { id: "fix", name: "Fix", who: "lead, builder and tester" },
  { id: "research", name: "Research", who: "lead and two researchers" },
  { id: "solo", name: "Solo+", who: "builder and reviewer" },
];

const terminal = (s: CrewGoalStatus) => s === "completed" || s === "failed" || s === "stopped";
const moving = (g?: CrewGoal) => !!g && (g.status === "planning" || g.status === "running");

/** A teammate's face: its agent's mark, ringed in its role's colour. */
function Face(props: { mate: CrewTeammate; kind: string; size?: number; live?: boolean }) {
  const size = props.size ?? 34;
  const c = ROLE[props.mate.role]?.color() ?? T.dim;
  return (
    <View
      style={{
        width: size + 6,
        height: size + 6,
        borderRadius: (size + 6) / 2,
        borderWidth: props.live ? 2.5 : 1.5,
        borderColor: c,
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: T.panel,
      }}
    >
      <AgentIcon kind={props.kind} size={size - 6} />
    </View>
  );
}

function Pill(props: { status: CrewGoalStatus }) {
  const look = GOAL_LOOK[props.status] ?? GOAL_LOOK.running;
  const c = look.color();
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 5, borderWidth: 1, borderColor: c, borderRadius: radii.pill, paddingHorizontal: 9, height: 22 }}>
      <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: c }} />
      <Text style={{ color: c, fontSize: 11.5, fontWeight: "600" }}>{look.label}</Text>
    </View>
  );
}

function Btn(props: { label: string; onPress: () => void; kind?: "primary" | "outline" | "ghost"; disabled?: boolean; testID?: string }) {
  const kind = props.kind ?? "outline";
  return (
    <TouchableOpacity
      testID={props.testID}
      accessibilityRole="button"
      accessibilityLabel={props.label}
      disabled={props.disabled}
      onPress={props.onPress}
      style={{
        minHeight: 38,
        paddingHorizontal: 14,
        borderRadius: 10,
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: kind === "primary" ? T.bright : "transparent",
        borderWidth: kind === "outline" ? 1 : 0,
        borderColor: T.line2,
        opacity: props.disabled ? 0.5 : 1,
      }}
    >
      <Text style={{ color: kind === "primary" ? T.onBright : T.text, fontWeight: "600", fontSize: 14 }}>{props.label}</Text>
    </TouchableOpacity>
  );
}

export function CrewView(props: { creds: Creds; project: Project; pulse: number; onOpenChat: (chatId: string, title: string) => void }) {
  const { creds, project } = props;
  const [crews, setCrews] = useState<Crew[] | null>(null);
  const [previews, setPreviews] = useState<Record<string, CrewTeammate[]>>({});
  const [roster, setRoster] = useState<Array<{ id: string; kind: string }>>([]);
  const [sel, setSel] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [events, setEvents] = useState<LoomEvent[]>([]);
  const [busy, setBusy] = useState<string>("");
  const [text, setText] = useState("");
  const [to, setTo] = useState<string>("");
  const [making, setMaking] = useState(false);
  const [tpl, setTpl] = useState("ship");
  const [diff, setDiff] = useState<string | null>(null);
  const [showDiff, setShowDiff] = useState(false);
  // A quiet line that says what just happened (sent, approved, applied) — not a dialog to dismiss.
  const [notice, setNotice] = useState<{ text: string; tone: "ok" | "err" } | null>(null);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const say = useCallback((text: string, tone: "ok" | "err" = "ok") => {
    setNotice({ text, tone });
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => setNotice(null), 3500);
  }, []);
  useEffect(() => () => { if (noticeTimer.current) clearTimeout(noticeTimer.current); }, []);

  const crew = useMemo(() => (crews ?? []).find((c) => c.id === sel) ?? crews?.[0] ?? null, [crews, sel]);
  const goal = crew?.state.goal;
  const kindOf = useCallback(
    (agent: string) => project.agents.find((a) => a.id === agent)?.kind ?? roster.find((a) => a.id === agent)?.kind ?? agent,
    [project.agents, roster],
  );

  const load = useCallback(async () => {
    try {
      const r = await getCrews(creds, project.id);
      setErr(null);
      setCrews(r.crews);
      setPreviews(r.previews ?? {});
      setRoster(r.roster ?? []);
      setSel((cur) => (cur && r.crews.some((c) => c.id === cur) ? cur : r.crews[0]?.id ?? null));
      const c = r.crews.find((x) => x.id === sel) ?? r.crews[0];
      if (c?.state.channel) {
        const ev = await getEvents(creds, project.id, c.state.channel, 30).catch(() => null);
        if (ev) setEvents(ev.events.filter((e) => e.kind === "message" || (e.kind === "crew" && e.payload?.phase !== "updated")));
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }, [creds, project.id, sel]);

  useEffect(() => { void load(); }, [load]);
  // live: a crew event → refetch
  const first = useRef(true);
  useEffect(() => {
    if (first.current) { first.current = false; return; }
    void load();
  }, [props.pulse]); // eslint-disable-line react-hooks/exhaustive-deps
  // backup poll while the crew works
  useEffect(() => {
    if (!moving(goal)) return;
    const t = setInterval(() => void load(), 8000);
    return () => clearInterval(t);
  }, [goal?.status, load]); // eslint-disable-line react-hooks/exhaustive-deps

  const act = useCallback(async (action: CrewAction, body: { text?: string; to?: string } = {}) => {
    if (!crew) return;
    setBusy(action);
    try {
      const r = await crewAction(creds, project.id, crew.id, action, body);
      setCrews((prev) => (prev ?? []).map((c) => (c.id === r.crew.id ? r.crew : c)));
      haptic.success();
      if (action === "say") {
        setText("");
        const words: Record<string, string> = { goal: "Started as the crew's goal", answer: "Sent as the answer", note: "Left as a note for their next turn", replan: "Sent to the lead — it plans again" };
        say(`${words[r.routed ?? "note"] ?? "Sent"}${r.to ? ` (@${r.to})` : ""}`);
      }
      if (action === "approve") say("Plan approved — the crew is building");
      if (action === "stop") say("Stopped — its branch stays");
      if (action === "resume") say("Resumed from where it stopped");
      if (action === "apply" && r.into) say(`Merged into ${r.into}`);
      void load();
    } catch (e) {
      say(e instanceof Error ? e.message : String(e), "err");
    } finally {
      setBusy("");
    }
  }, [creds, project.id, crew, load]);

  const make = useCallback(async () => {
    setBusy("create");
    try {
      const r = await createCrew(creds, project.id, { template: tpl });
      setMaking(false);
      setSel(r.crew.id);
      haptic.success();
      void load();
    } catch (e) {
      Alert.alert("Couldn't make the crew", e instanceof Error ? e.message : String(e));
    } finally {
      setBusy("");
    }
  }, [creds, project.id, tpl, load]);

  const swap = useCallback((mate: CrewTeammate) => {
    if (!crew || crew.busy) return;
    const options = roster.filter((a) => a.id !== mate.agent);
    if (!options.length) return;
    Alert.alert(`Who sits in ${mate.id}?`, `Now: ${mate.agent}`, [
      ...options.slice(0, 6).map((a) => ({
        text: a.id,
        onPress: () => {
          const teammates = crew.teammates.map((t) => (t.id === mate.id ? { ...t, agent: a.id } : t));
          void updateCrew(creds, project.id, crew.id, { teammates })
            .then((r) => setCrews((prev) => (prev ?? []).map((c) => (c.id === r.crew.id ? r.crew : c))))
            .catch((e: unknown) => Alert.alert("Couldn't swap", e instanceof Error ? e.message : String(e)));
        },
      })),
      { text: "Cancel", style: "cancel" as const },
    ]);
  }, [creds, project.id, crew, roster]);

  const toggleDiff = useCallback(async () => {
    if (!crew) return;
    if (showDiff) { setShowDiff(false); return; }
    setShowDiff(true);
    setDiff(null);
    try { setDiff((await crewDiff(creds, project.id, crew.id)).diff || ""); } catch (e) { setDiff(`couldn't load: ${e instanceof Error ? e.message : String(e)}`); }
  }, [creds, project.id, crew, showDiff]);

  if (err && !crews) return <Unreachable what="crews" detail={err} onRetry={() => void load()} />;
  if (!crews) return <View style={{ padding: spacing.xl }}><ActivityIndicator color={T.dim} /></View>;

  // ── making one ──
  if (!crews.length || making) {
    return (
      <ScrollView contentContainerStyle={{ padding: spacing.lg, gap: spacing.md }} keyboardShouldPersistTaps="handled">
        <View style={{ alignItems: "center", gap: 8, paddingVertical: spacing.md }}>
          <View style={{ flexDirection: "row", alignItems: "center" }}>
            {(["lead", "builder", "builder", "reviewer", "tester"] as CrewRole[]).map((r, i) => (
              <View key={i} style={{ flexDirection: "row", alignItems: "center" }}>
                {i ? <View style={{ width: 12, height: 2, backgroundColor: T.line2 }} /> : null}
                <View style={{ width: 30, height: 30, borderRadius: 15, borderWidth: 2, borderColor: ROLE[r].color(), backgroundColor: T.panel }} />
              </View>
            ))}
          </View>
          <Text style={{ color: T.bright, fontSize: 19, fontWeight: "700" }}>{crews.length ? "New crew" : "No crew yet"}</Text>
          <Text style={{ color: T.dim, fontSize: 13.5, textAlign: "center", lineHeight: 19 }}>
            A few of your agents with jobs — a lead who plans, builders, a reviewer and a tester — working one goal on its own branch.
          </Text>
        </View>
        {TEMPLATES.map((t) => {
          const on = tpl === t.id;
          const seats = previews[t.id] ?? [];
          return (
            <TouchableOpacity
              key={t.id}
              testID={`crew-tpl-${t.id}`}
              accessibilityRole="radio"
              accessibilityState={{ checked: on }}
              onPress={() => setTpl(t.id)}
              style={{ borderWidth: on ? 1.5 : 1, borderColor: on ? T.thread : T.line, backgroundColor: T.panel, borderRadius: radii.card, padding: spacing.md, gap: 6 }}
            >
              <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                <Text style={{ color: T.bright, fontSize: 15, fontWeight: "700", flex: 1 }}>{t.name}</Text>
                <View style={{ flexDirection: "row" }}>
                  {seats.map((m, i) => (
                    <View key={i} style={{ marginLeft: i ? -8 : 0 }}><Face mate={m} kind={kindOf(m.agent)} size={20} /></View>
                  ))}
                </View>
              </View>
              <Text style={{ color: T.dim, fontSize: 13 }}>{t.who}</Text>
              {on && seats.length ? (
                <Text style={{ color: T.faint, fontSize: 12, fontFamily: T.mono }}>{seats.map((m) => `${m.id}=${m.agent}`).join("  ")}</Text>
              ) : null}
            </TouchableOpacity>
          );
        })}
        {!Object.keys(previews).length ? (
          <Text style={{ color: T.err, fontSize: 13 }}>This project has no agents that can be on a crew yet — add one on your computer first.</Text>
        ) : null}
        <View style={{ flexDirection: "row", gap: 8, justifyContent: "flex-end" }}>
          {crews.length ? <Btn label="Cancel" kind="ghost" onPress={() => setMaking(false)} /> : null}
          <Btn testID="crew-create" label={busy === "create" ? "Making…" : "Create crew"} kind="primary" disabled={!!busy || !Object.keys(previews).length} onPress={() => void make()} />
        </View>
      </ScrollView>
    );
  }

  const c = crew!;
  const liveId = moving(goal) ? goal!.current?.teammate : undefined;
  const fresh = !goal || terminal(goal.status);
  const done = goal ? goal.cards.filter((x) => x.stage === "done").length : 0;

  return (
    <View style={{ flex: 1 }}>
    <ScrollView contentContainerStyle={{ padding: spacing.lg, gap: spacing.md, paddingBottom: 40 }} keyboardShouldPersistTaps="handled">
      {/* hero */}
      <Panel>
        <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.md }}>
          <View style={{ flexDirection: "row" }}>
            {c.teammates.slice(0, 5).map((m, i) => (
              <View key={m.id} style={{ marginLeft: i ? -12 : 0 }}><Face mate={m} kind={kindOf(m.agent)} size={26} live={liveId === m.id} /></View>
            ))}
          </View>
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text testID="crew-name" style={{ color: T.bright, fontSize: 17, fontWeight: "700" }} numberOfLines={1}>{c.name}</Text>
            <Text style={{ color: T.dim, fontSize: 12 }}>{c.teammates.length} teammates{c.busy ? " · working" : ""}</Text>
            {c.testCommand ? <Text style={{ color: T.faint, fontSize: 11, fontFamily: T.mono }} numberOfLines={1}>✓ tests: {c.testCommand}</Text> : null}
          </View>
          <TouchableOpacity accessibilityLabel="new crew" onPress={() => setMaking(true)} style={{ minWidth: TAP, minHeight: TAP, alignItems: "center", justifyContent: "center" }}>
            <Text style={{ color: T.dim, fontSize: 22 }}>＋</Text>
          </TouchableOpacity>
        </View>
        {crews.length > 1 ? (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 6, marginTop: 10 }}>
            {crews.map((x) => (
              <TouchableOpacity key={x.id} onPress={() => setSel(x.id)} style={{ paddingHorizontal: 10, height: 28, justifyContent: "center", borderRadius: radii.pill, borderWidth: 1, borderColor: x.id === c.id ? T.thread : T.line }}>
                <Text style={{ color: x.id === c.id ? T.bright : T.dim, fontSize: 12.5 }}>{x.name}</Text>
              </TouchableOpacity>
            ))}
          </ScrollView>
        ) : null}
      </Panel>

      {/* teammates */}
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }}>
        {c.teammates.map((m) => {
          const live = liveId === m.id;
          const asking = goal?.status === "waiting_human" && goal.question?.teammate === m.id;
          const doing = live ? `${STEP_VERB[goal!.current!.step] ?? "working"}…` : asking ? "waiting for you" : ROLE[m.role]?.does ?? "";
          return (
            <TouchableOpacity
              key={m.id}
              testID={`crew-mate-${m.id}`}
              onLongPress={() => swap(m)}
              onPress={() => c.state.threads[m.id] && props.onOpenChat(c.state.threads[m.id]!, `${c.name} · ${m.id}`)}
              style={{ width: 150, padding: 10, gap: 6, borderRadius: 12, backgroundColor: T.panel, borderWidth: live ? 1.5 : 1, borderColor: live ? ROLE[m.role].color() : asking ? T.warn : T.line }}
            >
              <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                <Face mate={m} kind={kindOf(m.agent)} size={24} live={live} />
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text style={{ color: T.bright, fontWeight: "700", fontSize: 13 }} numberOfLines={1}>{m.id}</Text>
                  <Text style={{ color: ROLE[m.role]?.color() ?? T.dim, fontSize: 10, fontWeight: "700", letterSpacing: 0.6 }}>{(ROLE[m.role]?.label ?? m.role).toUpperCase()}</Text>
                </View>
              </View>
              <Text style={{ color: T.faint, fontSize: 11, fontFamily: T.mono }} numberOfLines={1}>{m.agent}</Text>
              <Text style={{ color: live ? ROLE[m.role].color() : asking ? T.warn : T.dim, fontSize: 11.5 }} numberOfLines={2}>{doing}</Text>
            </TouchableOpacity>
          );
        })}
      </ScrollView>
      <Text style={{ color: T.faint, fontSize: 11 }}>Tap a teammate for its thread · hold to swap its agent</Text>

      {/* the goal */}
      {goal ? (
        <Panel tint={goal.status === "completed" ? T.ok : goal.status === "failed" ? T.err : undefined}>
          <View style={{ gap: 10 }}>
            <Text testID="crew-goal" style={{ color: T.bright, fontSize: 15.5, fontWeight: "600", lineHeight: 21 }}>{goal.text}</Text>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <Pill status={goal.status} />
              {goal.cards.length ? <Text style={{ color: T.dim, fontSize: 12, fontFamily: T.mono }}>{done}/{goal.cards.length} done</Text> : null}
              {goal.costUsd ? <Text style={{ color: T.dim, fontSize: 12 }}>{usd(goal.costUsd)}</Text> : null}
            </View>
            {goal.cards.length ? (
              <View style={{ flexDirection: "row", gap: 3 }}>
                {goal.cards.map((x) => (
                  <View key={x.id} style={{ flex: 1, height: 5, borderRadius: 3, backgroundColor: x.stage === "done" ? T.ok : x.stage === "failed" ? T.err : x.stage === "planned" ? T.line2 : T.thread }} />
                ))}
              </View>
            ) : null}
            <Text style={{ color: T.faint, fontSize: 11, fontFamily: T.mono }} numberOfLines={1}>{goal.branch}</Text>
            <Banner goal={goal} busy={busy} onAct={(a) => void act(a)} />
            {goal.summary && goal.status === "completed" ? (
              <Text style={{ color: T.text, fontSize: 13, lineHeight: 19, backgroundColor: T.raised, padding: 10, borderRadius: 8 }}>{goal.summary.slice(0, 900)}</Text>
            ) : null}
            <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap" }}>
              {moving(goal) || goal.status === "waiting_human" || goal.status === "awaiting_approval" ? <Btn testID="crew-stop" label="Stop" kind="ghost" disabled={!!busy} onPress={() => void act("stop")} /> : null}
              {goal.status === "interrupted" || goal.status === "stopped" || goal.status === "failed" ? <Btn testID="crew-resume" label="Resume" disabled={!!busy} onPress={() => void act("resume")} /> : null}
              {goal.cards.some((x) => x.commits.length) ? <Btn label={showDiff ? "Hide changes" : "View changes"} kind="ghost" onPress={() => void toggleDiff()} /> : null}
              {goal.status === "completed" && !goal.applied ? <Btn testID="crew-apply" label="Apply (merge)" kind="primary" disabled={!!busy} onPress={() => void act("apply")} /> : null}
              {goal.applied ? <Text style={{ color: T.ok, fontWeight: "600", alignSelf: "center" }}>✓ applied to {goal.applied.into}</Text> : null}
            </View>
            {showDiff ? <Diff text={diff} /> : null}
          </View>
        </Panel>
      ) : (
        <Empty text={`No goal yet. Tell ${c.name} what to build — the lead plans it, you approve, the crew builds, reviews and tests it.`} />
      )}

      {goal && goal.cards.length ? <Cards goal={goal} crew={c} kindOf={kindOf} /> : goal?.status === "planning" ? (
        <Text style={{ color: T.dim, fontSize: 13 }}>The lead is planning the goal into cards…</Text>
      ) : null}

      {/* composer */}
      <View style={{ borderWidth: 1, borderColor: T.line, borderRadius: radii.card, backgroundColor: T.panel, padding: 10, gap: 8 }}>
        <TextInput
          testID="crew-say"
          value={text}
          onChangeText={setText}
          multiline
          autoCorrect={false}
          placeholder={fresh ? `What should ${c.name} build?` : goal?.status === "waiting_human" && goal.question ? `Answer ${goal.question.teammate}…` : goal?.status === "awaiting_approval" ? "Feedback on the plan (the lead plans again)…" : "Say something to the crew…"}
          placeholderTextColor={T.faint}
          style={{ color: T.text, fontSize: 15, minHeight: 48, maxHeight: 140, textAlignVertical: "top" }}
        />
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 6 }} style={{ flex: 1 }}>
            {["", ...c.teammates.map((m) => m.id)].map((id) => (
              <TouchableOpacity key={id || "all"} onPress={() => setTo(id)} style={{ paddingHorizontal: 9, height: 26, justifyContent: "center", borderRadius: radii.pill, borderWidth: 1, borderColor: to === id ? T.thread : T.line }}>
                <Text style={{ color: to === id ? T.bright : T.dim, fontSize: 12 }}>{id ? `@${id}` : fresh ? "everyone" : "the crew"}</Text>
              </TouchableOpacity>
            ))}
          </ScrollView>
          <Btn testID="crew-send" label={busy === "say" ? "…" : fresh ? "Start" : goal?.status === "waiting_human" ? "Answer" : "Send"} kind="primary" disabled={!text.trim() || !!busy} onPress={() => void act("say", { text: text.trim(), ...(to ? { to } : {}) })} />
        </View>
      </View>

      {/* channel */}
      <SectionLabel text="CHANNEL" />
      {events.length ? (
        <View style={{ gap: 8 }}>
          {events.slice(-20).map((e) => <ChannelLine key={e.id} ev={e} crew={c} />)}
          <TouchableOpacity onPress={() => props.onOpenChat(c.state.channel, c.name)}>
            <Text style={{ color: T.thread, fontSize: 13 }}>Open the whole channel →</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <Text style={{ color: T.faint, fontSize: 12.5 }}>The crew talks here: the plan, hand-offs, reviews, and anything you say.</Text>
      )}
    </ScrollView>
    {notice ? (
      <View
        testID="crew-notice"
        pointerEvents="none"
        style={{ position: "absolute", left: spacing.lg, right: spacing.lg, bottom: spacing.lg, flexDirection: "row", alignItems: "center", gap: 8,
          paddingHorizontal: 14, paddingVertical: 11, borderRadius: 12, backgroundColor: T.bright, shadowColor: "#000", shadowOpacity: 0.25, shadowRadius: 10, elevation: 6 }}
      >
        <Text style={{ color: notice.tone === "ok" ? T.ok : T.err, fontWeight: "800" }}>{notice.tone === "ok" ? "✓" : "!"}</Text>
        <Text style={{ color: T.onBright, fontSize: 13.5, flex: 1 }}>{notice.text}</Text>
      </View>
    ) : null}
    </View>
  );
}

/** What the crew needs from you, said big. */
function Banner(props: { goal: CrewGoal; busy: string; onAct: (a: CrewAction) => void }) {
  const g = props.goal;
  const box = (tint: string, title: string, body: string, action?: { label: string; act: CrewAction; testID: string }) => (
    <View style={{ borderWidth: 1, borderColor: tint, borderRadius: 10, padding: 11, gap: 8, backgroundColor: T.raised }}>
      <Text style={{ color: T.bright, fontWeight: "700", fontSize: 14 }}>{title}</Text>
      <Text style={{ color: T.dim, fontSize: 13, lineHeight: 18 }}>{body}</Text>
      {action ? <Btn testID={action.testID} label={action.label} kind="primary" disabled={!!props.busy} onPress={() => props.onAct(action.act)} /> : null}
    </View>
  );
  if (g.status === "awaiting_approval") {
    return box(T.warn, `The plan is ready: ${g.cards.length} card${g.cards.length === 1 ? "" : "s"}.`, "Nobody builds until you OK it. Not right? Say what to change below and the lead plans again.", { label: "Approve plan", act: "approve", testID: "crew-approve" });
  }
  if (g.status === "waiting_human" && g.question) return box(T.warn, `${g.question.teammate} asks:`, g.question.text);
  if (g.status === "completed" && !g.applied) return box(T.ok, "Done: every card built, reviewed and tested.", "Look at the changes, then apply them to your branch.");
  if (g.status === "failed") {
    const bad = g.cards.find((x) => x.stage === "failed");
    const why = (bad?.error ?? g.error ?? "").slice(0, 300).replace(/([^.!?])$/, "$1.");
    return box(T.err, bad ? `“${bad.title}” failed.` : "The goal failed.", `${why} Resume tries it again; what's done stays done.`);
  }
  if (g.status === "interrupted") return box(T.warn, "Interrupted.", "Loom stopped while the crew was mid-turn. Resume picks up at the step it was on.");
  return null;
}

function Cards(props: { goal: CrewGoal; crew: Crew; kindOf: (agent: string) => string }) {
  const g = props.goal;
  return (
    <View style={{ gap: spacing.md }}>
      {STAGE_ORDER.map((s) => {
        const here = g.cards.filter((x) => x.stage === s);
        if (!here.length) return null;
        return (
          <View key={s} style={{ gap: 6 }}>
            <SectionLabel text={`${STAGE_LABEL[s].toUpperCase()} · ${here.length}`} />
            {here.map((x) => <CardRow key={x.id} card={x} goal={g} crew={props.crew} kindOf={props.kindOf} />)}
          </View>
        );
      })}
    </View>
  );
}

function CardRow(props: { card: CrewCard; goal: CrewGoal; crew: Crew; kindOf: (agent: string) => string }) {
  const { card: x, goal: g } = props;
  const working = moving(g) && g.current?.card === x.id;
  const whoId = working ? g.current!.teammate : x.builder;
  const who = props.crew.teammates.find((m) => m.id === whoId);
  return (
    <View
      testID={`crew-card-${x.stage}`}
      style={{ borderWidth: working ? 1.5 : 1, borderColor: working ? T.thread : x.stage === "failed" ? T.err : T.line, borderRadius: 10, padding: 10, gap: 5, backgroundColor: T.panel }}
    >
      <Text style={{ color: T.bright, fontSize: 14, fontWeight: "600" }}>{x.stage === "done" ? "✓ " : ""}{x.title}</Text>
      {x.detail ? <Text style={{ color: T.dim, fontSize: 12.5, lineHeight: 17 }} numberOfLines={2}>{x.detail}</Text> : null}
      <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
        {who ? (
          <View style={{ flexDirection: "row", alignItems: "center", gap: 5 }}>
            <Face mate={who} kind={props.kindOf(who.agent)} size={14} live={working} />
            <Text style={{ color: T.dim, fontSize: 11.5, fontFamily: T.mono }}>{who.id}</Text>
          </View>
        ) : null}
        {x.rounds ? <Text style={{ color: T.warn, fontSize: 11.5 }}>↺ {x.rounds}</Text> : null}
        {x.commits.length ? <Text style={{ color: T.dim, fontSize: 11.5 }}>{x.commits.length} commit{x.commits.length === 1 ? "" : "s"}</Text> : null}
        {working ? <Text style={{ color: T.thread, fontSize: 11.5, fontWeight: "600" }}>{STEP_VERB[g.current!.step] ?? "working"}…</Text> : null}
      </View>
      {x.error ? <Text style={{ color: T.err, fontSize: 12 }}>{x.error.slice(0, 240)}</Text> : null}
    </View>
  );
}

const PHASE: Record<string, (p: Record<string, unknown>) => string> = {
  goal_started: (p) => `Goal started on ${String(p.branch ?? "a branch")}`,
  planned: (p) => `Planned ${Array.isArray(p.cards) ? p.cards.length : 0} card(s)${p.awaitingApproval ? " — waiting for your OK" : ""}`,
  plan_approved: () => "Plan approved",
  claimed: (p) => `${String(p.teammate ?? "A builder")} took “${String(p.title ?? "")}”`,
  reviewed: (p) => `${String(p.teammate ?? "Reviewer")} ${p.verdict === "changes" ? "asked for changes on" : "approved"} “${String(p.title ?? "")}”`,
  tested: (p) => `${String(p.teammate ?? "Tester")}: tests ${p.result === "fail" ? "fail" : "pass"} on “${String(p.title ?? "")}”`,
  card_done: (p) => `“${String(p.title ?? "")}” done`,
  card_failed: (p) => `“${String(p.title ?? "")}” failed`,
  asks: (p) => `${String(p.teammate ?? "A teammate")} asks: ${String(p.question ?? "")}`,
  stalled: (p) => `${String(p.teammate ?? "A teammate")} went silent${p.retrying ? " — trying again" : ""}`,
  retrying: (p) => `${String(p.teammate ?? "A teammate")}'s turn errored — trying again`,
  completed: () => "Goal completed",
  failed: () => "Goal failed",
  stopped: () => "Stopped",
  resumed: () => "Resumed",
  applied: (p) => `Applied to ${String(p.into ?? "your branch")}`,
};

function ChannelLine(props: { ev: LoomEvent; crew: Crew }) {
  const p = props.ev.payload as Record<string, unknown>;
  if (props.ev.kind === "crew") {
    const phase = String(p.phase ?? "");
    const tone = phase === "completed" || phase === "card_done" || phase === "plan_approved" || (phase === "tested" && p.result !== "fail") || (phase === "reviewed" && p.verdict !== "changes")
      ? T.ok
      : phase === "failed" || phase === "card_failed" || (phase === "tested" && p.result === "fail") ? T.err
      : phase === "asks" || phase === "stalled" || phase === "retrying" || p.verdict === "changes" ? T.warn : T.dim;
    return (
      <View style={{ flexDirection: "row", gap: 8, alignItems: "flex-start" }}>
        <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: tone, marginTop: 6 }} />
        <Text style={{ color: tone === T.dim ? T.dim : T.text, fontSize: 12.5, flex: 1, lineHeight: 18 }}>{(PHASE[phase] ?? (() => phase))(p)}</Text>
      </View>
    );
  }
  const mine = p.author === "user";
  const who = (p.crew as { teammate?: string } | undefined)?.teammate;
  return (
    <View style={{ alignItems: mine ? "flex-end" : "flex-start" }}>
      {!mine && who ? <Text style={{ color: T.faint, fontSize: 11, marginBottom: 2 }}>{who}</Text> : null}
      <View style={{ maxWidth: "88%", backgroundColor: mine ? T.bright : T.raised, borderRadius: 12, paddingHorizontal: 11, paddingVertical: 7 }}>
        <Text style={{ color: mine ? T.onBright : T.text, fontSize: 13, lineHeight: 18 }}>{String(p.text ?? "").slice(0, 500)}</Text>
      </View>
    </View>
  );
}

function Diff(props: { text: string | null }) {
  if (props.text === null) return <ActivityIndicator color={T.dim} />;
  if (!props.text) return <Text style={{ color: T.dim }}>No changes on the branch.</Text>;
  return (
    <ScrollView horizontal style={{ maxHeight: 360, backgroundColor: T.editor, borderRadius: 8 }} nestedScrollEnabled>
      <ScrollView nestedScrollEnabled>
        <View style={{ padding: 8 }}>
          {props.text.split("\n").slice(0, 400).map((l, i) => (
            <Text
              key={i}
              style={{
                fontFamily: T.mono,
                fontSize: 11,
                color: l.startsWith("+") && !l.startsWith("+++") ? T.gitAdd : l.startsWith("-") && !l.startsWith("---") ? T.gitDel : l.startsWith("@@") ? T.thread : T.dim,
                backgroundColor: l.startsWith("+") && !l.startsWith("+++") ? T.diffAddBg : l.startsWith("-") && !l.startsWith("---") ? T.diffDelBg : "transparent",
              }}
            >
              {l || " "}
            </Text>
          ))}
        </View>
      </ScrollView>
    </ScrollView>
  );
}
