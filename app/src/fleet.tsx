/**
 * Fleet: what every agent in every open project is doing right now — one row
 * per agent (busy or idle, which thread, its last step, its permission mode)
 * and the live orchestra's tasks beneath. Polls every 3s while on screen and
 * the app is in front; tapping a row opens that project on that thread.
 *
 * Below the local fleet, the Team section (team.tsx): teammates' live agents,
 * who holds which files, and the team feed.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, AppState, RefreshControl, ScrollView, Text, TouchableOpacity, View } from "react-native";
import { getActivity, type ActivityAgent, type ActivityProject, type ActivityTask, type Creds } from "./api";
import { AgentIcon, agentLabel } from "./agents";
import { ApprovalBanner, ApprovalsSheet } from "./approvals";
import { ConnectionBadge } from "./brand";
import { Empty, SectionLabel, TAP, Unreachable, dur } from "./components";
import { PermissionTag } from "./permissions";
import { TeamSection } from "./team";
import { T, radii, spacing } from "./theme";

const POLL_MS = 3000;

const TASK_COLOR: Record<string, string> = {
  pending: T.faint,
  running: T.thread,
  done: T.ok,
  conflict: T.warn,
  needs_input: T.warn,
  failed: T.err,
  cancelled: T.faint,
};

function sinceText(ts: number | null | undefined, now: number): string {
  return ts ? dur(Math.max(0, now - ts)) : "";
}

function AgentRow(props: { a: ActivityAgent; now: number; onPress: () => void }) {
  const { a } = props;
  const title = a.chatTitle ?? (a.chat && a.chat !== "main" ? a.chat : a.chat ? "Main" : null);
  return (
    <TouchableOpacity
      onPress={props.onPress}
      activeOpacity={0.7}
      accessibilityRole="button"
      accessibilityLabel={`${a.id}, ${a.busy ? "working" : "idle"}${title ? `, in ${title}` : ""}. Open thread`}
      style={{
        flexDirection: "row",
        gap: 10,
        minHeight: TAP + 12,
        paddingVertical: 10,
        paddingHorizontal: 12,
        borderRadius: radii.card,
        borderWidth: 1,
        borderColor: T.line,
        borderLeftWidth: 2,
        borderLeftColor: a.busy ? T.ok : a.holdsBaton ? T.shuttle : T.line,
        backgroundColor: T.panel,
      }}
    >
      <AgentIcon kind={a.kind} size={28} />
      <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
          <Text style={{ color: T.text, fontSize: 14, fontWeight: "600", flexShrink: 1 }} numberOfLines={1}>
            {a.id !== a.kind ? a.id : agentLabel(a.kind)}
          </Text>
          <PermissionTag mode={a.permissions} />
          {a.holdsBaton ? <Text style={{ color: T.shuttle, fontSize: 11 }}>⟵ baton</Text> : null}
        </View>
        <Text style={{ color: a.busy ? T.ok : T.faint, fontSize: 11, fontFamily: T.mono }} numberOfLines={1}>
          {a.busy ? `● working ${sinceText(a.since, props.now)}` : "○ idle"}
          {title ? ` · ${title}` : ""}
        </Text>
        {a.last?.line ? (
          <Text style={{ color: T.dim, fontSize: 12, fontFamily: T.mono, lineHeight: 17 }} numberOfLines={2}>
            {a.last.line}
          </Text>
        ) : null}
      </View>
      <Text style={{ color: T.faint, fontSize: 18, alignSelf: "center" }}>›</Text>
    </TouchableOpacity>
  );
}

function TaskRow(props: { t: ActivityTask; onPress: () => void }) {
  const { t } = props;
  const c = TASK_COLOR[t.status] ?? T.faint;
  return (
    <TouchableOpacity
      onPress={props.onPress}
      activeOpacity={0.7}
      accessibilityRole="button"
      accessibilityLabel={`Task ${t.title}, ${t.status}. Open thread`}
      style={{
        gap: 3,
        minHeight: TAP,
        paddingVertical: 9,
        paddingHorizontal: 12,
        borderRadius: radii.card,
        borderWidth: 1,
        borderColor: T.line,
        borderLeftWidth: 2,
        borderLeftColor: c,
        backgroundColor: T.panel,
      }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <Text style={{ color: T.text, fontSize: 13, fontWeight: "600", flex: 1 }} numberOfLines={1}>
          {t.title}
        </Text>
        <Text style={{ color: c, fontSize: 10.5, fontFamily: T.mono }}>{t.status.replace("_", " ")}</Text>
      </View>
      <Text style={{ color: T.faint, fontSize: 11, fontFamily: T.mono }} numberOfLines={1}>
        {t.id} · {t.agent}
        {t.last?.line ? ` · ${t.last.line}` : ""}
      </Text>
    </TouchableOpacity>
  );
}

export function FleetScreen(props: {
  creds: Creds;
  onBack: () => void;
  onOpen: (projectId: string, chat?: { id: string; title: string }) => void;
  /** Scroll to the Team section on arrival (from the account sheet's Team row). */
  focusTeam?: boolean;
}) {
  const [data, setData] = useState<{ projects: ActivityProject[]; approvals: number; at: number } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [approvalsOpen, setApprovalsOpen] = useState(false);
  const [now, setNow] = useState(Date.now());
  const [teamRefresh, setTeamRefresh] = useState(0);
  const scroller = useRef<ScrollView>(null);
  const scrolledToTeam = useRef(false);

  const load = useCallback(async () => {
    try {
      const r = await getActivity(props.creds);
      setErr(null);
      setData(r);
      setNow(Date.now());
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }, [props.creds]);

  // 3s while on screen and in front; a backgrounded phone shouldn't poll
  useEffect(() => {
    let t: ReturnType<typeof setInterval> | null = null;
    const start = () => {
      if (t) return;
      void load();
      t = setInterval(() => void load(), POLL_MS);
    };
    const stop = () => {
      if (t) clearInterval(t);
      t = null;
    };
    start();
    const sub = AppState.addEventListener("change", (s) => (s === "active" ? start() : stop()));
    return () => {
      stop();
      sub.remove();
    };
  }, [load]);

  const projects = data?.projects ?? [];
  const busy = projects.reduce((n, p) => n + p.agents.filter((a) => a.busy).length, 0);
  const total = projects.reduce((n, p) => n + p.agents.length, 0);
  const kinds = new Map(projects.flatMap((p) => p.agents.map((a) => [a.id, a.kind] as const)));

  return (
    <View style={{ flex: 1 }}>
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          minHeight: 48,
          paddingHorizontal: spacing.md,
          gap: spacing.sm + 2,
          backgroundColor: T.panel,
          borderBottomWidth: 1,
          borderBottomColor: T.line,
        }}
      >
        <TouchableOpacity
          onPress={props.onBack}
          activeOpacity={0.7}
          accessibilityRole="button"
          accessibilityLabel="Back to the board"
          style={{
            width: 34,
            height: 34,
            borderRadius: 17,
            alignItems: "center",
            justifyContent: "center",
            backgroundColor: T.raised,
          }}
        >
          <Text style={{ color: T.dim, fontSize: 17, lineHeight: 20 }}>←</Text>
        </TouchableOpacity>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={{ color: T.text, fontWeight: "600", fontSize: 14 }}>Fleet</Text>
          <Text style={{ color: T.faint, fontSize: 11, fontFamily: T.mono }} numberOfLines={1}>
            {data ? `${busy}/${total} working · ${projects.length} open project${projects.length === 1 ? "" : "s"}` : "loading…"}
          </Text>
        </View>
        <ConnectionBadge />
      </View>

      <ScrollView
        ref={scroller}
        style={{ flex: 1 }}
        contentContainerStyle={{ padding: spacing.md, gap: spacing.lg, paddingBottom: 40 }}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={async () => {
              setRefreshing(true);
              setTeamRefresh((n) => n + 1);
              await load();
              setRefreshing(false);
            }}
            tintColor={T.dim}
          />
        }
      >
        <ApprovalBanner count={data?.approvals ?? 0} onPress={() => setApprovalsOpen(true)} />

        {err && !data ? (
          <Unreachable what="the fleet" detail={err} onRetry={() => void load()} />
        ) : !data ? (
          <ActivityIndicator color={T.dim} style={{ marginTop: 30 }} />
        ) : !projects.length ? (
          <Empty text="No project is open on the daemon right now. Open one from the board and its agents show up here." />
        ) : (
          projects.map((p) => (
            <View key={p.project.id} style={{ gap: spacing.sm }}>
              <SectionLabel text={p.project.name} />
              {p.agents.map((a) => (
                <AgentRow
                  key={a.id}
                  a={a}
                  now={now}
                  onPress={() =>
                    props.onOpen(
                      p.project.id,
                      a.chat ? { id: a.chat, title: a.chatTitle ?? a.chat } : undefined,
                    )
                  }
                />
              ))}
              {p.orchestra ? (
                <View style={{ gap: 6, marginTop: 4 }}>
                  <TouchableOpacity
                    onPress={() =>
                      props.onOpen(p.project.id, p.orchestra?.chat ? { id: p.orchestra.chat, title: "orchestrator" } : undefined)
                    }
                    activeOpacity={0.7}
                    accessibilityRole="button"
                    style={{ flexDirection: "row", alignItems: "center", gap: 8, minHeight: 32 }}
                  >
                    <Text style={{ color: T.thread, fontSize: 11, fontFamily: T.mono }}>◇ orchestra · {p.orchestra.status.replace("_", " ")}</Text>
                    <Text style={{ color: T.dim, fontSize: 12, flex: 1 }} numberOfLines={1}>
                      {p.orchestra.goal}
                    </Text>
                  </TouchableOpacity>
                  {p.orchestra.tasks.map((t) => (
                    <TaskRow key={t.id} t={t} onPress={() => props.onOpen(p.project.id, { id: t.chat, title: t.title })} />
                  ))}
                </View>
              ) : null}
            </View>
          ))
        )}
        {err && data ? <Text style={{ color: T.err, fontSize: 12, textAlign: "center" }}>{err}</Text> : null}

        <View
          style={{ borderTopWidth: 1, borderTopColor: T.line, paddingTop: spacing.lg }}
          onLayout={(e) => {
            // once, when asked: the section moves as the fleet above it loads
            if (!props.focusTeam || scrolledToTeam.current || !data) return;
            scrolledToTeam.current = true;
            const y = e.nativeEvent.layout.y;
            setTimeout(() => scroller.current?.scrollTo({ y: Math.max(0, y - spacing.md), animated: true }), 50);
          }}
        >
          <TeamSection creds={props.creds} refreshKey={teamRefresh} />
        </View>
      </ScrollView>

      <ApprovalsSheet
        creds={props.creds}
        projects={projects.map((p) => p.project)}
        visible={approvalsOpen}
        onClose={() => setApprovalsOpen(false)}
        onChanged={() => void load()}
        kindOf={(id) => kinds.get(id)}
      />
    </View>
  );
}
