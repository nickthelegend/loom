/**
 * Loom Teams on the phone: which of your teammates' agents are live right now
 * and what they're about. Intent only (goal and task titles, the files each
 * one touches), never a transcript: that stays on the teammate's machine.
 *
 * Reading the team is for any full (unscoped) pairing. Changing membership is
 * this computer's identity on the hub, so the daemon keeps it admin-only and a
 * paired phone gets a 403. Every one of those actions degrades to "do this on
 * your computer" with the exact command, never to a bare error.
 *
 * Polls every 5s while on screen and in front, and refreshes early on the
 * daemon's `team` frames (debounced).
 */

import * as Clipboard from "expo-clipboard";
import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, Alert, AppState, Linking, Share, Text, TextInput, TouchableOpacity, View } from "react-native";
import {
  getTeam,
  openLiveStream,
  teamAction,
  type Creds,
  type TeamFeedEvent,
  type TeamLease,
  type TeamPresence,
  type TeamStatus,
  type TeamView,
} from "./api";
import { AgentIcon, agentLabel } from "./agents";
import { Badge, Btn, Empty, Panel, SectionLabel, Segmented, TAP, Unreachable, dur, field } from "./components";
import { T, radii, spacing } from "./theme";

const POLL_MS = 5000;
const DEBOUNCE_MS = 400;
const FEED_MAX = 15;

/** The status code on an ApiError, duck-typed so a transpiled subclass can't fool instanceof. */
function statusOf(e: unknown): number | undefined {
  const s = (e as { status?: unknown } | null)?.status;
  return typeof s === "number" ? s : undefined;
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

const STATE: Record<string, { label: string; color: string }> = {
  running: { label: "running", color: T.ok },
  planning: { label: "planning", color: T.primary },
  reviewing: { label: "reviewing", color: T.shuttle },
  waiting_human: { label: "needs a human", color: T.warn },
  ci: { label: "in CI", color: T.thread },
  idle: { label: "idle", color: T.faint },
};

const stateOf = (s: string) => STATE[s] ?? { label: s.replace(/_/g, " "), color: T.dim };

/** "codex#t1" → "Codex (ChatGPT) · t1": the product, then which one of them. */
function agentName(p: TeamPresence): string {
  const [, tag] = p.agent.split("#");
  const label = agentLabel(p.kind || p.agent.split("#")[0]!);
  return tag ? `${label} · ${tag}` : label;
}

/** Only web links leave the app: a feed row's URL is a teammate's data. */
function openable(url: unknown): string | null {
  return typeof url === "string" && /^https?:\/\//i.test(url) ? url : null;
}

const who = (g: string | null | undefined) => (g ? `@${g}` : "GitHub");
const quoted = (s?: string) => (s ? `“${s}”` : "");

/** One feed event as a sentence a person would say. */
function sentence(e: TeamFeedEvent): string {
  const c = e.content ?? {};
  const m = e.meta ?? {};
  const pr = m.number != null ? `#${m.number}` : "a PR";
  const prTitle = c.title ? ` ${quoted(c.title)}` : "";
  const inRepo = e.repo ? ` in ${e.repo}` : "";
  // hub-authored events (a member joining) carry the login in meta, not as the actor
  const actor = e.github ?? (typeof m.github === "string" ? m.github : null);
  switch (e.type) {
    case "member_joined":
      return `${who(actor)} joined the team`;
    case "member_left":
      return `${who(actor)} left the team`;
    case "key_rotated":
      return "The team key was rotated";
    case "repo_shared":
      return `${who(actor)} shared ${e.repo ?? "a repo"}`;
    case "goal_started":
      return `${who(actor)} started ${quoted(c.goal) || "a goal"}${inRepo}`;
    case "goal_finished": {
      const st = typeof m.status === "string" ? m.status : "completed";
      const verb = st === "failed" ? "failed on" : st === "aborted" ? "stopped" : "finished";
      return `${who(actor)} ${verb} ${quoted(c.goal) || "a goal"}${inRepo}`;
    }
    case "plan_written":
      return `${who(actor)} wrote a plan for ${quoted(c.goal) || "a goal"}${inRepo}`;
    case "pr_opened":
      return `${who(actor)} opened ${pr}${prTitle}${inRepo}`;
    case "pr_merged":
      return `${pr}${prTitle} was merged${inRepo}`;
    case "pr_closed":
      return `${pr}${prTitle} was closed${inRepo}`;
    case "check_failed": {
      const checks = Array.isArray(m.checks) && m.checks.length ? `: ${m.checks.slice(0, 3).join(", ")}` : "";
      return `Checks failed on ${pr}${inRepo}${checks}`;
    }
    case "check_passed":
      return `Checks passed on ${pr}${inRepo}`;
    case "review_requested":
      return `${who(actor)} asked for a review on ${pr}${inRepo}`;
    case "review_submitted":
      return `${who(actor)} reviewed ${pr}${inRepo}`;
    case "lease_released": {
      const n = typeof m.leases === "number" ? m.leases : null;
      const what = n ? `${n} lease${n === 1 ? "" : "s"}` : "its leases";
      const why = typeof m.reason === "string" && m.reason ? ` (${m.reason})` : "";
      return `${who(actor)} released ${what}${inRepo}${why}`;
    }
    case "overlap_decided": {
      const cc = c as { reason?: string; goal?: string };
      const goal = cc.goal ? ` on ${quoted(cc.goal)}` : "";
      const why = cc.reason ? `: ${cc.reason}` : "";
      return `${who(actor)} chose to proceed alongside a teammate's files${goal}${inRepo}${why}`;
    }
    case "drift": {
      const paths = Array.isArray(m.paths) ? (m.paths as unknown[]).map(String) : [];
      const holders = Array.isArray(m.holders) ? (m.holders as unknown[]).map((h) => `@${String(h)}`) : [];
      const where = paths.length ? `${paths.slice(0, 3).join(", ")}${paths.length > 3 ? ` +${paths.length - 3}` : ""}` : "files";
      const whose = holders.length ? `, overlapping ${holders.join(", ")}` : "";
      return `${who(actor)}'s agent edited ${where} outside its declared files${inRepo}${whose}`;
    }
    case "zone_waiting": {
      const zone = typeof m.zone === "string" ? m.zone : "a hard zone";
      const holder = typeof m.holder === "string" ? `@${m.holder}` : "a teammate";
      return `${who(actor)} is queued behind ${holder} for ${zone}${inRepo}`;
    }
    case "conflict_predicted": {
      const members = Array.isArray(m.members) ? (m.members as unknown[]).map((x) => `@${String(x)}`) : [];
      const files = Array.isArray(m.files) ? (m.files as unknown[]).map(String) : [];
      const between = members.length >= 2 ? `${members[0]} and ${members[1]}` : "two goals";
      const where = files.length ? ` in ${files.slice(0, 3).join(", ")}${files.length > 3 ? ` +${files.length - 3}` : ""}` : "";
      return `Merge conflict ahead between ${between}${where}${inRepo}`;
    }
    default:
      return `${who(actor)} · ${e.type.replace(/_/g, " ")}${c.summary ? ` · ${c.summary}` : ""}`;
  }
}

const FEED_COLOR: Record<string, string> = {
  pr_merged: T.shuttle,
  pr_closed: T.err,
  check_failed: T.err,
  check_passed: T.ok,
  goal_started: T.thread,
  goal_finished: T.ok,
  lease_released: T.dim,
  overlap_decided: T.thread,
  drift: T.warn,
  zone_waiting: T.warn,
  conflict_predicted: T.warn,
};

/** Feed rows that warn: a merge conflict is coming if nobody acts. */
const WARNING = new Set(["conflict_predicted"]);

// ── pieces ──

function StatePill(props: { state: string }) {
  const s = stateOf(props.state);
  return <Badge text={s.label} tint={s.color} />;
}

function Chip(props: { text: string; tint?: string }) {
  return (
    <View
      style={{
        borderWidth: 1,
        borderColor: props.tint ?? T.line2,
        backgroundColor: T.raised,
        borderRadius: radii.row,
        paddingHorizontal: 6,
        paddingVertical: 1,
        maxWidth: "100%",
      }}
    >
      <Text style={{ color: props.tint ?? T.dim, fontSize: 10.5, fontFamily: T.mono }} numberOfLines={1}>
        {props.text}
      </Text>
    </View>
  );
}

/** A teammate's live session: product, state, what it's doing, where it's working. */
function PresenceRow(props: { p: TeamPresence; now: number }) {
  const { p } = props;
  const s = stateOf(p.state);
  const title = p.intent?.task ?? p.intent?.goal ?? p.intent?.thread ?? null;
  const sub = p.intent?.task && p.intent.goal ? p.intent.goal : null;
  return (
    <View
      accessible
      accessibilityLabel={`${agentName(p)}, ${s.label}${title ? `, ${title}` : ""}, in ${p.repo}`}
      style={{
        flexDirection: "row",
        gap: 10,
        paddingVertical: 10,
        paddingHorizontal: 12,
        borderRadius: radii.card,
        borderWidth: 1,
        borderColor: T.line,
        borderLeftWidth: 2,
        borderLeftColor: s.color,
        backgroundColor: T.panel,
      }}
    >
      <AgentIcon kind={p.kind || p.agent.split("#")[0]!} size={28} />
      <View style={{ flex: 1, minWidth: 0, gap: 4 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
          <Text style={{ color: T.text, fontSize: 13.5, fontWeight: "600", flexShrink: 1 }} numberOfLines={1}>
            {agentName(p)}
          </Text>
          <StatePill state={p.state} />
          <Text style={{ color: T.faint, fontSize: 10.5, fontFamily: T.mono, marginLeft: "auto" }}>
            {p.since ? dur(Math.max(0, props.now - p.since)) : ""}
          </Text>
        </View>
        {title ? (
          <Text style={{ color: T.text, fontSize: 13, lineHeight: 18 }} numberOfLines={2}>
            {title}
          </Text>
        ) : (
          <Text style={{ color: T.faint, fontSize: 12, fontStyle: "italic" }}>no title shared</Text>
        )}
        {sub ? (
          <Text style={{ color: T.dim, fontSize: 11.5, lineHeight: 16 }} numberOfLines={1}>
            ◇ {sub}
          </Text>
        ) : null}
        <Text style={{ color: T.faint, fontSize: 10.5, fontFamily: T.mono }} numberOfLines={1}>
          {p.repo}
          {p.branch ? ` · ${p.branch}` : ""}
        </Text>
        {p.touches.length ? (
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 4 }}>
            {p.touches.slice(0, 6).map((g) => (
              <Chip key={g} text={g} />
            ))}
            {p.touches.length > 6 ? <Chip text={`+${p.touches.length - 6}`} /> : null}
          </View>
        ) : null}
      </View>
    </View>
  );
}

const LEASE_STATE: Record<string, { label: string; color: string }> = {
  active: { label: "active", color: T.ok },
  landing: { label: "landing", color: T.shuttle },
  stale: { label: "stale", color: T.faint },
};

/** One lease: its state, which goal/task holds it, and the globs it covers. */
function LeaseRow(props: { l: TeamLease; now: number }) {
  const { l } = props;
  const st = l.stale ? LEASE_STATE.stale! : LEASE_STATE[l.state] ?? { label: l.state, color: T.dim };
  const title = l.intent?.task ?? l.intent?.goal ?? null;
  const sub = l.intent?.task && l.intent.goal ? l.intent.goal : null;
  return (
    <View
      accessible
      accessibilityLabel={`${title ?? `task ${l.taskId}`}, ${st.label}, ${l.fileCount} file${l.fileCount === 1 ? "" : "s"}${l.stale ? ". Not renewed lately" : ""}`}
      style={{
        gap: 4,
        paddingVertical: 8,
        paddingHorizontal: 10,
        borderRadius: radii.key,
        borderWidth: 1,
        borderColor: T.line,
        borderLeftWidth: 2,
        borderLeftColor: st.color,
        backgroundColor: T.raised,
        opacity: l.stale ? 0.55 : 1,
      }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
        <Text style={{ color: T.text, fontSize: 12.5, fontWeight: "600", flexShrink: 1 }} numberOfLines={1}>
          {title ?? l.taskId}
        </Text>
        <Badge text={st.label} tint={st.color} />
        <Text style={{ color: T.faint, fontSize: 10.5, fontFamily: T.mono, marginLeft: "auto" }}>
          {l.fileCount} file{l.fileCount === 1 ? "" : "s"}
        </Text>
      </View>
      {sub ? (
        <Text style={{ color: T.dim, fontSize: 11.5, lineHeight: 16 }} numberOfLines={1}>
          ◇ {sub}
        </Text>
      ) : null}
      <Text style={{ color: T.faint, fontSize: 10.5, fontFamily: T.mono }} numberOfLines={1}>
        {l.repo ? `${l.repo} · ` : ""}
        {l.runId}/{l.taskId}
        {l.stale && l.ts ? ` · last seen ${dur(Math.max(0, props.now - l.ts)).replace(/ \d+s$/, "")} ago` : ""}
      </Text>
      {l.globs.length ? (
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 4 }}>
          {l.globs.slice(0, 6).map((g) => (
            <Chip key={g} text={g} />
          ))}
          {l.globs.length > 6 ? <Chip text={`+${l.globs.length - 6}`} /> : null}
        </View>
      ) : null}
    </View>
  );
}

/** Who holds which files: every lease on the team's shared repos, grouped by member. */
function Leases(props: { leases: TeamLease[]; nameOf: Map<string, string>; now: number }) {
  if (!props.leases.length) return null;
  const groups = new Map<string, TeamLease[]>();
  for (const l of props.leases) {
    const k = l.mine ? "\u0000you" : l.github;
    groups.set(k, [...(groups.get(k) ?? []), l]);
  }
  // you first, then teammates; within a member, live before stale, active before landing
  const rank = (l: TeamLease) => (l.stale ? 2 : l.state === "active" ? 0 : 1);
  const entries = [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  return (
    <View style={{ gap: 6 }}>
      <SectionLabel text={`Leases · ${props.leases.length}`} />
      {entries.map(([k, rows]) => {
        const mine = k === "\u0000you";
        const gh = rows[0]!.github;
        const name = props.nameOf.get(gh);
        return (
          <View key={k} style={{ gap: 6 }}>
            <View style={{ flexDirection: "row", alignItems: "baseline", gap: 6 }}>
              <Text style={{ color: T.text, fontSize: 13, fontWeight: "600" }}>
                {mine ? "You" : name && name !== gh ? name : `@${gh}`}
              </Text>
              {!mine && name && name !== gh ? (
                <Text style={{ color: T.faint, fontSize: 11, fontFamily: T.mono }}>@{gh}</Text>
              ) : null}
              <Text style={{ color: T.faint, fontSize: 11, fontFamily: T.mono, marginLeft: "auto" }}>
                {rows.length} lease{rows.length === 1 ? "" : "s"}
              </Text>
            </View>
            {[...rows]
              .sort((a, b) => rank(a) - rank(b))
              .map((l) => (
                <LeaseRow key={l.id} l={l} now={props.now} />
              ))}
          </View>
        );
      })}
    </View>
  );
}

/**
 * Who touches which files, from presence alone: the fallback for a daemon that
 * predates real leases.
 */
function TouchedFiles(props: { presence: TeamPresence[] }) {
  const byGlob = new Map<string, Set<string>>();
  for (const p of props.presence) {
    for (const g of p.touches) {
      const set = byGlob.get(g) ?? new Set<string>();
      set.add(p.mine ? "you" : `@${p.github}`);
      byGlob.set(g, set);
    }
  }
  if (!byGlob.size) return null;
  const rows = [...byGlob.entries()].sort((a, b) => b[1].size - a[1].size || a[0].localeCompare(b[0]));
  return (
    <View style={{ gap: 6 }}>
      <SectionLabel text="Leases" />
      <Panel>
        {rows.slice(0, 12).map(([glob, owners]) => {
          const clash = owners.size > 1;
          return (
            <View key={glob} style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
              <Text
                style={{ color: clash ? T.warn : T.text, fontSize: 11.5, fontFamily: T.mono, flex: 1 }}
                numberOfLines={1}
              >
                {glob}
              </Text>
              <Text style={{ color: T.faint, fontSize: 11 }}>→</Text>
              <Text
                style={{ color: clash ? T.warn : T.dim, fontSize: 11.5, maxWidth: "45%" }}
                numberOfLines={1}
              >
                {[...owners].join(", ")}
              </Text>
            </View>
          );
        })}
        {rows.length > 12 ? (
          <Text style={{ color: T.faint, fontSize: 11 }}>+{rows.length - 12} more</Text>
        ) : null}
      </Panel>
    </View>
  );
}

function FeedRow(props: { e: TeamFeedEvent; now: number }) {
  const { e } = props;
  const url = e.type.startsWith("pr_") || e.type.startsWith("check_") || e.type.startsWith("review_")
    ? openable(e.meta?.url) ?? openable(e.meta?.prUrl)
    : openable(e.meta?.prUrl);
  const color = FEED_COLOR[e.type] ?? T.faint;
  const warning = WARNING.has(e.type);
  const body = (
    <>
      <Text style={{ color, fontSize: 11, fontFamily: T.mono, width: 12 }}>{warning ? "▲" : "●"}</Text>
      <Text
        style={{ color: warning ? T.warn : T.text, fontSize: 12.5, lineHeight: 18, flex: 1, fontWeight: warning ? "600" : "400" }}
        numberOfLines={3}
      >
        {sentence(e)}
      </Text>
      <Text style={{ color: T.faint, fontSize: 10.5, fontFamily: T.mono }}>
        {e.ts ? dur(Math.max(0, props.now - e.ts)).replace(/ \d+s$/, "") : ""}
      </Text>
      {url ? <Text style={{ color: T.faint, fontSize: 15 }}>›</Text> : null}
    </>
  );
  const style = {
    flexDirection: "row" as const,
    alignItems: "flex-start" as const,
    gap: 8,
    paddingVertical: 6,
    ...(warning
      ? {
          paddingHorizontal: 8,
          marginHorizontal: -4,
          borderRadius: radii.row,
          borderWidth: 1,
          borderColor: T.warn,
          backgroundColor: T.raised,
        }
      : {}),
  };
  if (!url)
    return (
      <View style={style} accessible accessibilityLabel={warning ? `Warning: ${sentence(e)}` : sentence(e)}>
        {body}
      </View>
    );
  return (
    <TouchableOpacity
      onPress={() => void Linking.openURL(url).catch(() => {})}
      activeOpacity={0.7}
      accessibilityRole="link"
      accessibilityLabel={`${sentence(e)}. Open on GitHub`}
      style={{ ...style, minHeight: TAP, alignItems: "center" }}
    >
      {body}
    </TouchableOpacity>
  );
}

/** The command to run on the computer, with a copy button. */
function OnYourComputer(props: { why: string; command: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <View
      style={{
        backgroundColor: T.panel,
        borderWidth: 1,
        borderColor: T.line,
        borderLeftWidth: 2,
        borderLeftColor: T.warn,
        borderRadius: radii.card,
        padding: 12,
        gap: 8,
      }}
    >
      <Text style={{ color: T.text, fontSize: 13.5, fontWeight: "600" }}>Do this on your computer</Text>
      <Text style={{ color: T.dim, fontSize: 12, lineHeight: 18 }}>{props.why}</Text>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <Text
          selectable
          style={{
            flex: 1,
            color: T.text,
            fontFamily: T.mono,
            fontSize: 11.5,
            backgroundColor: T.editor,
            borderRadius: radii.row,
            borderWidth: 1,
            borderColor: T.line,
            paddingHorizontal: 8,
            paddingVertical: 7,
          }}
          numberOfLines={2}
        >
          {props.command}
        </Text>
        <Btn
          small
          label={copied ? "Copied" : "Copy"}
          onPress={() => {
            void Clipboard.setStringAsync(props.command).then(() => setCopied(true));
          }}
        />
      </View>
    </View>
  );
}

const ADMIN_WHY =
  "Team membership is this computer's identity on the hub, so Loom only changes it from the machine running the daemon, not from a paired phone.";

/** Not on a team: paste an invite. On a phone the daemon usually says no, so say what to do instead. */
function JoinCard(props: { creds: Creds; status: TeamStatus; onJoined: (t: TeamStatus) => void }) {
  const [link, setLink] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [admin, setAdmin] = useState<string | null>(null);

  const paste = async () => {
    const s = (await Clipboard.getStringAsync().catch(() => "")).trim();
    if (s) setLink(s);
  };

  const join = async () => {
    const l = link.trim();
    if (!l) return;
    setErr(null);
    setAdmin(null);
    setBusy(true);
    try {
      const out = await teamAction(props.creds, "join", { link: l });
      setLink("");
      props.onJoined(out.team);
    } catch (e) {
      if (statusOf(e) === 403) setAdmin(l);
      else setErr(errText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={{ gap: spacing.sm }}>
      <Panel>
        <Text style={{ color: T.text, fontSize: 14, fontWeight: "700" }}>Join a team</Text>
        <Text style={{ color: T.dim, fontSize: 12, lineHeight: 18 }}>
          See what your teammates&apos; agents are working on: goals, tasks and the files they touch. Never their
          transcripts. Paste the invite link a teammate sent you.
        </Text>
        <TextInput
          value={link}
          onChangeText={setLink}
          placeholder="loom team invite link"
          placeholderTextColor={T.faint}
          autoCapitalize="none"
          autoCorrect={false}
          accessibilityLabel="Team invite link"
          style={{ ...field, fontSize: 13, fontFamily: T.mono }}
        />
        <View style={{ flexDirection: "row", gap: 8 }}>
          <View style={{ flex: 1 }}>
            <Btn label="Paste" onPress={() => void paste()} />
          </View>
          <View style={{ flex: 1, opacity: link.trim() && !busy ? 1 : 0.4 }}>
            {busy ? (
              <View style={{ minHeight: 44, alignItems: "center", justifyContent: "center" }}>
                <ActivityIndicator color={T.dim} />
              </View>
            ) : (
              <Btn primary label="Join" onPress={() => void join()} />
            )}
          </View>
        </View>
        <Text style={{ color: T.faint, fontSize: 11, lineHeight: 16 }}>
          The link carries the team key. Treat it like a password.
        </Text>
        {err ? <Text style={{ color: T.err, fontSize: 12 }}>{err}</Text> : null}
      </Panel>
      {admin ? <OnYourComputer why={ADMIN_WHY} command={`loom team join '${admin}'`} /> : null}
      {!props.status.signedIn ? (
        <Text style={{ color: T.faint, fontSize: 11.5, lineHeight: 17, textAlign: "center" }}>
          Starting a team instead? On your computer: loom team signin &lt;hub-url&gt;, then loom team create &lt;name&gt;.
        </Text>
      ) : null}
    </View>
  );
}

/** Invite and leave: tried here first, and handed to the computer on a 403. */
function TeamActions(props: { creds: Creds; team: TeamView; multi: boolean; onChanged: (t: TeamStatus) => void }) {
  const [busy, setBusy] = useState<"invite" | "leave" | null>(null);
  const [invite, setInvite] = useState<{ link: string; expiresAt: number } | null>(null);
  const [admin, setAdmin] = useState<{ why: string; command: string } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  // the CLI only needs to be told which team when there is more than one
  const teamFlag = props.multi ? ` --team ${props.team.id}` : "";

  const run = async (action: "invite" | "leave") => {
    setErr(null);
    setAdmin(null);
    setBusy(action);
    try {
      const out = await teamAction<{ link: string; expiresAt: number }>(props.creds, action, { teamId: props.team.id });
      if (action === "invite") {
        setInvite(out.result);
        setCopied(false);
      }
      props.onChanged(out.team);
    } catch (e) {
      if (statusOf(e) === 403) setAdmin({ why: ADMIN_WHY, command: `loom team ${action}${teamFlag}` });
      else setErr(errText(e));
    } finally {
      setBusy(null);
    }
  };

  const leave = () =>
    Alert.alert(`Leave ${props.team.name}?`, "Your agents stop showing up for the team, and theirs for you.", [
      { text: "Cancel", style: "cancel" },
      { text: "Leave", style: "destructive", onPress: () => void run("leave") },
    ]);

  const hoursLeft = invite ? Math.max(0, Math.round((invite.expiresAt - Date.now()) / 3_600_000)) : 0;

  return (
    <View style={{ gap: spacing.sm }}>
      <View style={{ flexDirection: "row", gap: 8 }}>
        <View style={{ flex: 1 }}>
          <Btn label={busy === "invite" ? "Inviting…" : "Invite a teammate"} onPress={() => void run("invite")} />
        </View>
        <Btn label={busy === "leave" ? "Leaving…" : "Leave"} onPress={leave} />
      </View>
      {invite ? (
        <View
          style={{
            backgroundColor: T.panel,
            borderWidth: 1,
            borderColor: T.line,
            borderLeftWidth: 2,
            borderLeftColor: T.warn,
            borderRadius: radii.card,
            padding: 12,
            gap: 8,
          }}
        >
          <Text style={{ color: T.warn, fontSize: 12.5, fontWeight: "600" }}>
            This link carries the team key. Send it like a password.
          </Text>
          <Text style={{ color: T.dim, fontSize: 11, fontFamily: T.mono }} numberOfLines={2}>
            {invite.link}
          </Text>
          <Text style={{ color: T.faint, fontSize: 11 }}>
            {hoursLeft ? `Expires in about ${hoursLeft}h. ` : ""}Anyone who has it can read the team&apos;s goals.
          </Text>
          <View style={{ flexDirection: "row", gap: 8 }}>
            <View style={{ flex: 1 }}>
              <Btn
                primary
                label="Share…"
                onPress={() => void Share.share({ message: invite.link }).catch(() => {})}
              />
            </View>
            <View style={{ flex: 1 }}>
              <Btn
                label={copied ? "Copied" : "Copy"}
                onPress={() => void Clipboard.setStringAsync(invite.link).then(() => setCopied(true))}
              />
            </View>
          </View>
        </View>
      ) : null}
      {admin ? <OnYourComputer why={admin.why} command={admin.command} /> : null}
      {err ? <Text style={{ color: T.err, fontSize: 12 }}>{err}</Text> : null}
    </View>
  );
}

function TeamBody(props: { creds: Creds; team: TeamView; multi: boolean; now: number; onChanged: (t: TeamStatus) => void }) {
  const { team, now } = props;
  const theirs = team.presence.filter((p) => !p.mine);
  const groups = new Map<string, TeamPresence[]>();
  for (const p of theirs) groups.set(p.github, [...(groups.get(p.github) ?? []), p]);
  const nameOf = new Map(team.members.map((m) => [m.github, m.name] as const));
  const feed = team.feed.slice(-FEED_MAX).reverse();

  return (
    <View style={{ gap: spacing.md }}>
      <Text style={{ color: T.faint, fontSize: 11, fontFamily: T.mono }} numberOfLines={1}>
        {team.members.length} member{team.members.length === 1 ? "" : "s"} · {team.repos.length} shared repo
        {team.repos.length === 1 ? "" : "s"} · {theirs.length} live
      </Text>

      {!theirs.length ? (
        <Empty
          text={
            team.repos.length
              ? "No teammate has an agent running right now. When one does, you'll see what it's working on here."
              : "Nothing is shared with this team yet. A project shows up here once someone runs `loom team share` in it."
          }
        />
      ) : (
        [...groups.entries()].map(([gh, rows]) => (
          <View key={gh} style={{ gap: 6 }}>
            <View style={{ flexDirection: "row", alignItems: "baseline", gap: 6 }}>
              <Text style={{ color: T.text, fontSize: 13, fontWeight: "600" }}>
                {nameOf.get(gh) && nameOf.get(gh) !== gh ? nameOf.get(gh) : `@${gh}`}
              </Text>
              {nameOf.get(gh) && nameOf.get(gh) !== gh ? (
                <Text style={{ color: T.faint, fontSize: 11, fontFamily: T.mono }}>@{gh}</Text>
              ) : null}
              <Text style={{ color: T.faint, fontSize: 11, fontFamily: T.mono, marginLeft: "auto" }}>
                {rows.length} session{rows.length === 1 ? "" : "s"}
              </Text>
            </View>
            {rows.map((p) => (
              <PresenceRow key={`${p.repo}/${p.agent}`} p={p} now={now} />
            ))}
          </View>
        ))
      )}

      {team.leases ? (
        <Leases leases={team.leases} nameOf={nameOf} now={now} />
      ) : (
        <TouchedFiles presence={team.presence} />
      )}

      <View style={{ gap: 6 }}>
        <SectionLabel text="Team feed" />
        {feed.length ? (
          <Panel>
            {feed.map((e, i) => (
              <FeedRow key={`${e.ts}:${e.type}:${i}`} e={e} now={now} />
            ))}
          </Panel>
        ) : (
          <Empty text="No team activity yet. Goals started, plans written and PRs opened land here." />
        )}
      </View>

      <TeamActions creds={props.creds} team={team} multi={props.multi} onChanged={props.onChanged} />
    </View>
  );
}

/**
 * The Team section. `refreshKey` lets the host screen's pull-to-refresh reload
 * it too.
 */
export function TeamSection(props: { creds: Creds; refreshKey?: number }) {
  const [status, setStatus] = useState<TeamStatus | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [teamId, setTeamId] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  const inFlight = useRef(false);

  const load = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      const r = await getTeam(props.creds);
      setStatus(r);
      setErr(null);
      setForbidden(false);
      setNow(Date.now());
    } catch (e) {
      if (statusOf(e) === 403) setForbidden(true);
      else setErr(errText(e));
    } finally {
      inFlight.current = false;
    }
  }, [props.creds]);

  // 5s while on screen and in front; stop asking once the daemon has said a
  // scoped pairing can't read the team (pull-to-refresh still retries)
  const forbiddenRef = useRef(false);
  forbiddenRef.current = forbidden;
  useEffect(() => {
    let t: ReturnType<typeof setInterval> | null = null;
    const start = () => {
      if (t) return;
      void load();
      t = setInterval(() => {
        if (!forbiddenRef.current) void load();
      }, POLL_MS);
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

  // the daemon-level feed: team frames go to full clients; refresh on them, debounced
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const close = openLiveStream(props.creds, undefined, (raw) => {
      if ((raw as { type?: unknown } | null)?.type !== "team") return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        void load();
      }, DEBOUNCE_MS);
    });
    return () => {
      if (timer) clearTimeout(timer);
      close();
    };
  }, [props.creds, load]);

  useEffect(() => {
    if (props.refreshKey) void load();
  }, [props.refreshKey, load]);

  const teams = status?.teams ?? [];
  const team = teams.find((t) => t.id === teamId) ?? teams[0] ?? null;

  let body: React.ReactNode;
  if (forbidden) {
    body = (
      <Panel>
        <Text style={{ color: T.text, fontSize: 13.5, fontWeight: "600" }}>Team view needs a full pairing</Text>
        <Text style={{ color: T.dim, fontSize: 12, lineHeight: 18 }}>
          This phone is paired for specific projects only, so it can&apos;t see the team. Pair it again from your
          computer without a project scope (loom pair) to see what your teammates&apos; agents are doing.
        </Text>
      </Panel>
    );
  } else if (err && !status) {
    body = <Unreachable what="the team" detail={err} onRetry={() => void load()} />;
  } else if (!status) {
    body = <ActivityIndicator color={T.dim} style={{ marginVertical: 16 }} />;
  } else if (!team) {
    body = <JoinCard creds={props.creds} status={status} onJoined={setStatus} />;
  } else {
    body = (
      <View style={{ gap: spacing.sm }}>
        {teams.length > 1 ? (
          <View style={{ marginHorizontal: -spacing.md }}>
            <Segmented
              options={teams.map((t) => ({ key: t.id, label: t.name }))}
              value={team.id}
              onChange={setTeamId}
              accent={T.thread}
            />
          </View>
        ) : null}
        <TeamBody creds={props.creds} team={team} multi={teams.length > 1} now={now} onChanged={setStatus} />
      </View>
    );
  }

  return (
    <View style={{ gap: spacing.sm }}>
      <SectionLabel text={team && teams.length === 1 ? `Team · ${team.name}` : "Team"} />
      {body}
      {err && status ? <Text style={{ color: T.err, fontSize: 12, textAlign: "center" }}>{err}</Text> : null}
    </View>
  );
}

/** For the account sheet: the team's name and size, or null when there's nothing to say. */
export function useTeamSummary(creds: Creds | null, active: boolean) {
  const [summary, setSummary] = useState<
    { kind: "team"; name: string; members: number; more: number } | { kind: "none" } | { kind: "scoped" } | null
  >(null);
  useEffect(() => {
    if (!creds || !active) return;
    let live = true;
    getTeam(creds)
      .then((s) => {
        if (!live) return;
        const t = s.teams[0];
        setSummary(t ? { kind: "team", name: t.name, members: t.members.length, more: s.teams.length - 1 } : { kind: "none" });
      })
      .catch((e) => {
        if (live) setSummary(statusOf(e) === 403 ? { kind: "scoped" } : null);
      });
    return () => {
      live = false;
    };
  }, [creds, active]);
  return summary;
}
