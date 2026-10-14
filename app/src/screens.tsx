/**
 * The three screens: Pair, Board, Project — quiet graphite.
 *
 * The Project screen is a tab host. Its heavier tabs live in their own files —
 * Observatory in observatory.tsx, Ask in ask.tsx, Skills/MCP/Agents in
 * tools.tsx — so this file stays the navigation and the thread, which is what
 * it is actually about.
 */

import { useSafeAreaInsets } from "react-native-safe-area-context";
import { INSTALL_URL, open as openLink } from "./links";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  KeyboardAvoidingView,
  Modal,
  Platform,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { CameraView, useCameraPermissions } from "expo-camera";
import * as Clipboard from "expo-clipboard";
import {
  claim,
  clearCreds,
  getActivity,
  getApprovals,
  getChats,
  getCheckpoints,
  getImportable,
  importChat,
  type ImportableChat,
  gitCommit,
  gitPush,
  gitStage,
  rewindTo,
  type Checkpoint,
  createChat,
  deleteChat,
  renameChat,
  setChatFlags,
  getEvents,
  getProject,
  getProjects,
  getTasks,
  getTree,
  handoff,
  interrupt,
  openLiveStream,
  pingDaemon,
  saveCreds,
  sendMessage,
  getQueue,
  queueEdit,
  queueClear,
  queuePause,
  queueRemove,
  type QueueView,
  cloudFromLink,
  type Approval,
  type Chat,
  type Creds,
  type DaemonReachability,
  type LoomEvent,
  type Project,
  type TaskItem,
  type TaskResult,
  type WorkingTree,
  kv,
} from "./api";
import { Btn, DiffView, EventLine, LiveReplies, Sys, TaskRow, ThreadCtx, ago, field } from "./components";
import { applyEvent, applyStream, seed, type LiveMap, type StreamFrame } from "./live-model";
import { haptic } from "./haptics";
import { markRead, unreadChats, type SeenMap } from "./seen-model";
import { AskView } from "./ask";
import { MemoryView } from "./memory";
import { BoardView } from "./board";
import { AttachBar, AttachButton, useAttachments } from "./attach";
import { AgentIcon, AgentPicker, ModelPicker } from "./agents";
import { foldedEvents, groupToolRuns } from "./fold-model";
import { ApprovalBanner, ApprovalEvent, ApprovalsSheet, approvalDecisions } from "./approvals";
import { QuestionEvent, answeredQuestions } from "./question";
import { DeliveryChip } from "./delivery";
import { PermissionChip } from "./permissions";
import { PromptsSheet } from "./prompts";
import { notifyApproval } from "./push";
import { ConnectionBadge, useConnRoute } from "./brand";
import { describeLink, linkQuality, pushSample, sparkBars, type LinkSample } from "./link-model";
import { clearCache, loadProjects, loadThread, saveProjects, saveThread } from "./cache";
import { savedAgo } from "./cache-model";
import { OrchestraView } from "./orchestra";
import { CrewView } from "./crew";
import { ObservatoryView, Sheet } from "./observatory";
import { ToolsView } from "./tools";
import { TeamBrainView, useBrainSummary } from "./team-brain";
import { TeamLandingView, useLandingSummary } from "./team-landing";
import { TeamRunnersView, useRunnersSummary } from "./team-runners";
import { runnersTabVisible } from "./team-runners-model";
import { useStt } from "./stt";
import { T, radii, scheme, spacing, usd } from "./theme";

/** Brand lockup: the wordmark over a short thread-cyan hairline. */
function Wordmark(props: { size?: number }) {
  const size = props.size ?? 17;
  return (
    <View style={{ alignSelf: "center", alignItems: "stretch" }}>
      <Text
        style={{
          color: T.text,
          fontSize: size,
          fontWeight: "700",
          letterSpacing: -0.3,
        }}
      >
        loom
      </Text>
      <View
        style={{
          height: 2,
          marginTop: 3,
          borderRadius: 1,
          backgroundColor: T.thread,
          opacity: 0.55,
        }}
      />
    </View>
  );
}

// ---------------------------------------------------------------------------
// Pair
// ---------------------------------------------------------------------------

function PairStep(props: { n: number; text: string; link?: boolean }) {
  return (
    <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 10 }}>
      <View
        style={{
          width: 22,
          height: 22,
          borderRadius: 11,
          backgroundColor: T.raised,
          borderWidth: 1,
          borderColor: T.line,
          alignItems: "center",
          justifyContent: "center",
          marginTop: 1,
        }}
      >
        <Text style={{ color: T.dim, fontSize: 11, fontWeight: "700" }}>{props.n}</Text>
      </View>
      <Text style={{ color: props.link ? T.text : T.dim, fontSize: 13, lineHeight: 20, flex: 1, textDecorationLine: props.link ? "underline" : "none" }}>{props.text}</Text>
    </View>
  );
}

export function PairScreen(props: { onPaired: (c: Creds) => void }) {
  const insets = useSafeAreaInsets();
  const [url, setUrl] = useState("http://");
  const [token, setToken] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const [perm, requestPerm] = useCameraPermissions();

  // Pair from any raw string — a pasted deep link or a scanned QR both carry the
  // same `…/app#pair=…`, so the parse is identical.
  const pairFrom = async (raw: string) => {
    try {
      setErr(null);
      const linkMatch = raw.match(/(https?:\/\/[^\s#]+)/);
      const tokenMatch = raw.match(/pair=([A-Za-z0-9]+)/);
      // Loom Cloud params ride the same fragment when the daemon has the relay on;
      // with them, a phone on another network can still pair (and reconnect).
      const creds = await claim(
        linkMatch ? linkMatch[1]! : url.trim(),
        tokenMatch ? tokenMatch[1]! : token.trim(),
        cloudFromLink(raw),
      );
      await saveCreds(creds);
      props.onPaired(creds);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };

  const go = () => void pairFrom(`${url} ${token}`);
  // Something typed (or pasted by hand) into the fields: the button connects
  // with it. Nothing typed: it reads the link off the clipboard instead.
  const typed = token.trim().length > 0 || url.trim().replace(/^https?:\/\/$/, "").length > 0;

  const startScan = async () => {
    setErr(null);
    if (!perm?.granted) {
      const r = await requestPerm();
      if (!r.granted) return setErr("Camera permission is needed to scan the QR.");
    }
    setScanning(true);
  };

  // The camera fires this repeatedly while a QR is in view — guard so we claim once.
  const onScan = (e: { data: string }) => {
    if (!scanning) return;
    setScanning(false);
    void pairFrom(e.data);
  };

  const pairFromClipboard = async () => {
    try {
      const pairingLink = await Clipboard.getStringAsync();
      if (!pairingLink.trim()) {
        setErr("Copy the pairing link on your computer, then try again.");
        return;
      }
      setScanning(false);
      await pairFrom(pairingLink);
    } catch {
      setErr("Couldn't read the clipboard. Paste the pairing link instead.");
    }
  };

  return (
    <View style={{ flex: 1, justifyContent: "center", padding: spacing.xl, gap: 14 }}>
      <Text
        style={{
          color: T.text,
          fontSize: 30,
          fontWeight: "800",
          textAlign: "center",
          letterSpacing: -0.3,
        }}
      >
        loom
      </Text>
      <View
        style={{
          height: 2,
          width: 56,
          alignSelf: "center",
          backgroundColor: T.thread,
          opacity: 0.85,
          borderRadius: 1,
        }}
      />
      <Text
        style={{
          color: T.dim,
          textAlign: "center",
          fontSize: 14,
          lineHeight: 21,
          marginBottom: spacing.sm,
        }}
      >
        the shared-memory layer for your AI dev environments
      </Text>
      <View style={{ gap: 10, marginBottom: spacing.sm }}>
        <TouchableOpacity onPress={() => openLink(INSTALL_URL)} activeOpacity={0.7} accessibilityRole="link"
          accessibilityLabel="Install Loom on your computer — open source, on GitHub">
          <PairStep n={1} text="Install Loom on your computer — it runs your agents, and this app is its remote. Free and open source →" link />
        </TouchableOpacity>
        <PairStep n={2} text="Start it: open Loom Desktop, or run loom up --tailnet" />
        <PairStep n={3} text="Connect a phone (or loom pair) shows a QR — scan it below, or paste the link" />
      </View>
      <TextInput
        style={field}
        value={url}
        onChangeText={setUrl}
        autoCapitalize="none"
        autoCorrect={false}
        placeholder="http://100.x.y.z:7420"
        placeholderTextColor={T.faint}
        selectionColor={T.accentBlue}
      />
      <TextInput
        style={field}
        value={token}
        onChangeText={setToken}
        autoCapitalize="none"
        autoCorrect={false}
        placeholder="pairing token or whole link"
        placeholderTextColor={T.faint}
        selectionColor={T.accentBlue}
        returnKeyType="go"
        onSubmitEditing={go}
      />
      {err && <Text style={{ color: T.err, fontSize: 13, textAlign: "center" }}>{err}</Text>}
      {typed ? (
        <>
          <Btn label="Connect" primary onPress={go} />
          <Btn label="⚌  Scan QR code instead" onPress={startScan} />
        </>
      ) : (
        <>
          <Btn label="⚌  Scan QR code" primary onPress={startScan} />
          <Btn label="Paste link from clipboard" onPress={() => void pairFromClipboard()} />
        </>
      )}

      <Modal visible={scanning} animationType="slide" onRequestClose={() => setScanning(false)}>
        <View style={{ flex: 1, backgroundColor: "#000" }}>
          <CameraView
            style={StyleSheet.absoluteFill}
            facing="back"
            barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
            onBarcodeScanned={onScan}
          />
          <View style={{ position: "absolute", top: insets.top + 48, left: 24, right: 24, alignItems: "center" }}>
            <Text style={{ color: "#fff", fontSize: 17, fontWeight: "700", textAlign: "center" }}>
              Point at the QR on your computer
            </Text>
            <Text style={{ color: "rgba(255,255,255,0.7)", fontSize: 13, marginTop: 6, textAlign: "center" }}>
              Desktop → Connect a phone
            </Text>
          </View>
          <View
            style={{
              position: "absolute",
              top: "32%",
              left: "18%",
              width: "64%",
              aspectRatio: 1,
              borderWidth: 2,
              borderColor: "rgba(255,255,255,0.9)",
              borderRadius: 20,
            }}
          />
          <View style={{ position: "absolute", bottom: insets.bottom + 32, left: 24, right: 24, gap: 10 }}>
            <Btn label="Paste link from clipboard" onPress={() => void pairFromClipboard()} />
            <Btn label="Cancel" onPress={() => setScanning(false)} />
          </View>
        </View>
      </Modal>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Board
// ---------------------------------------------------------------------------

/** hue-tinted letter tile — mirrors the web app's repo glyphs. */
/** A tile's colours from `seed`; its letter from `label` (a project's name, not its id). */
function glyph(seed: string, label = seed): { bg: string; fg: string; ch: string } {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) % 360;
  return {
    bg: `hsla(${h}, 60%, 50%, 0.18)`,
    fg: `hsl(${h}, 55%, ${scheme === "light" ? 34 : 72}%)`, // the letter has to read on the tint in either theme
    ch: (label.trim()[0] ?? "?").toUpperCase(),
  };
}

function SectionLabel(props: { text: string }) {
  return (
    <Text
      style={{
        color: T.faint,
        fontSize: 11,
        fontWeight: "600",
        letterSpacing: 0.6,
        textTransform: "uppercase",
        marginBottom: 8,
        marginTop: 4,
      }}
    >
      {props.text}
    </Text>
  );
}

function StatTile(props: { value: string; label: string }) {
  return (
    <View
      style={{
        flex: 1,
        backgroundColor: T.panel,
        borderColor: T.line,
        borderWidth: 1,
        borderRadius: 10,
        paddingVertical: 12,
        paddingHorizontal: 12,
      }}
    >
      <Text style={{ color: T.text, fontSize: 18, fontWeight: "700", letterSpacing: -0.3 }}>
        {props.value}
      </Text>
      <Text style={{ color: T.faint, fontSize: 11, fontWeight: "500", marginTop: 2 }}>
        {props.label}
      </Text>
    </View>
  );
}

/** A project row styled like Orca's Desktop/Resume cards: tile + name + meta. */
function ProjectCard(props: { p: Project; onPress: () => void }) {
  const { p } = props;
  const g = glyph(`${p.id}${p.name}`, p.name);
  const r = p.route;
  const active = r && (r.status === "running" || r.status === "waiting_human");
  const working = p.agents.some((a) => a.busy);
  return (
    <TouchableOpacity
      onPress={props.onPress}
      activeOpacity={0.7}
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 12,
        backgroundColor: T.panel,
        borderColor: T.line,
        borderWidth: 1,
        borderRadius: radii.card,
        paddingVertical: 12,
        paddingHorizontal: 14,
      }}
    >
      <View
        style={{
          width: 40,
          height: 40,
          borderRadius: 11,
          backgroundColor: g.bg,
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <Text style={{ color: g.fg, fontFamily: T.mono, fontSize: 15, fontWeight: "700" }}>
          {g.ch}
        </Text>
      </View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <Text numberOfLines={1} style={{ color: T.text, fontWeight: "600", fontSize: 15, flexShrink: 1 }}>
            {p.name}
          </Text>
          {p.needsInput ? (
            <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: T.warn }} />
          ) : working ? (
            <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: T.ok }} />
          ) : null}
        </View>
        <Text numberOfLines={1} style={{ color: T.dim, fontSize: 12, fontFamily: T.mono, marginTop: 3 }}>
          baton {p.holder ?? "—"}
          {p.costUsd ? ` · ${usd(p.costUsd)}` : ""}
          {active ? ` · ${r!.name ?? "route"} ${r!.current + 1}/${r!.steps.length}` : ""}
          {p.needsInput ? " · needs input" : ""}
        </Text>
      </View>
      <Text style={{ color: T.faint, fontSize: 18 }}>›</Text>
    </TouchableOpacity>
  );
}

export function BoardScreen(props: {
  creds: Creds;
  onOpen: (p: Project) => void;
  onUnpair: () => void;
  /** Opens the Fleet screen: every agent in every open project. */
  onFleet: () => void;
  /** The avatar in the header; opens the account sheet. */
  accountButton?: React.ReactNode;
}) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [daemon, setDaemon] = useState<DaemonReachability | null>(null);
  // The last two minutes of health pings: how the link has been, not just now.
  const [link, setLink] = useState<LinkSample[]>([]);
  const route = useConnRoute();
  // When the list on screen is the phone's saved copy, this is when it was saved.
  const [cachedAt, setCachedAt] = useState<number | null>(null);
  const gotLive = useRef(false);
  useEffect(() => {
    void loadProjects<Project>(props.creds.url).then((c) => {
      if (!c || gotLive.current) return;
      setProjects(c.data);
      setCachedAt(c.at);
    });
  }, [props.creds.url]);
  // Pending approvals across every open project (from /api/activity); null = unknown.
  const [approvals, setApprovals] = useState<number | null>(null);
  const [approvalsOpen, setApprovalsOpen] = useState(false);
  const lastApprovals = useRef<number | null>(null);

  const refresh = useCallback(async () => {
    const probe = pingDaemon(props.creds);
    // an older daemon has no /api/activity: the banner just never shows
    void getActivity(props.creds)
      .then((a) => {
        const n = a.approvals ?? 0;
        if (lastApprovals.current !== null && n > lastApprovals.current) {
          notifyApproval({ agent: "An agent", tool: "a tool" });
        }
        lastApprovals.current = n;
        setApprovals(n);
      })
      .catch(() => {});
    try {
      setErr(null);
      const fresh = (await getProjects(props.creds)).projects;
      gotLive.current = true;
      setProjects(fresh);
      setCachedAt(null);
      void saveProjects(props.creds.url, fresh);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      const next = await probe;
      setDaemon((current) => ({ ...next, name: next.name ?? current?.name }));
      setLink((w) => pushSample(w, next.reachable ? (next.latencyMs ?? 0) : null));
    }
  }, [props.creds]);

  useEffect(() => {
    void refresh();
    const t = setInterval(refresh, 5000);
    return () => clearInterval(t);
  }, [refresh]);

  const host = props.creds.url.replace(/^https?:\/\//, "");
  const agentCount = projects.reduce(
    (n, p) => n + p.agents.filter((a) => a.tier === "adapter").length,
    0,
  );
  const working = projects.reduce((n, p) => n + p.agents.filter((a) => a.busy).length, 0);
  const spend = projects.reduce((s, p) => s + (p.costUsd ?? 0), 0);
  const active =
    projects.find(
      (p) => p.needsInput || (p.route && (p.route.status === "running" || p.route.status === "waiting_human")),
    ) ?? null;
  const daemonName = daemon?.name ?? "Loom daemon";
  const daemonReachability = daemon?.reachable ? `${daemon.latencyMs ?? 0} ms` : daemon ? "unreachable" : "checking…";
  const daemonDot = daemon?.reachable ? T.ok : daemon ? T.err : T.faint;

  return (
    <View style={{ flex: 1 }}>
      {/* header */}
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          paddingHorizontal: spacing.lg,
          paddingVertical: spacing.md,
          gap: spacing.md,
          borderBottomWidth: 1,
          borderBottomColor: T.line,
          backgroundColor: T.panel,
        }}
      >
        <Wordmark />
        <ConnectionBadge />
        <View style={{ flex: 1 }} />
        <TouchableOpacity
          onPress={props.onFleet}
          activeOpacity={0.7}
          accessibilityRole="button"
          accessibilityLabel={`Fleet: every agent at work${working ? `, ${working} working` : ""}`}
          style={{
            flexDirection: "row",
            alignItems: "center",
            gap: 6,
            backgroundColor: T.raised,
            borderColor: T.line,
            borderWidth: 1,
            borderRadius: radii.key,
            paddingVertical: 5,
            paddingHorizontal: 10,
          }}
        >
          <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: working ? T.ok : T.faint }} />
          <Text style={{ color: T.text, fontSize: 12, fontWeight: "500" }}>Fleet</Text>
        </TouchableOpacity>
        <Btn small label="unpair" onPress={props.onUnpair} />
        {props.accountButton}
      </View>

      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ padding: spacing.lg, paddingBottom: 40, gap: spacing.lg }}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={async () => {
              setRefreshing(true);
              await refresh();
              setRefreshing(false);
            }}
            tintColor={T.dim}
          />
        }
      >
        <Text style={{ color: T.text, fontSize: 24, fontWeight: "800", letterSpacing: -0.3 }}>
          Welcome back
        </Text>

        {/* stat tiles — real Loom metrics */}
        <View style={{ flexDirection: "row", gap: spacing.sm }}>
          <StatTile value={String(projects.length)} label="Projects" />
          <StatTile value={String(agentCount)} label="Agents" />
          <StatTile value={spend > 0 ? usd(spend) : "$0"} label="Spend" />
        </View>

        <ApprovalBanner count={approvals ?? 0} onPress={() => setApprovalsOpen(true)} />

        {err && <Sys color={T.err} text={cachedAt ? `${err} Showing this phone's copy, ${savedAgo(cachedAt)}.` : err} />}

        {/* the machine you're paired to — Orca calls this Desktops */}
        <View>
          <SectionLabel text="Desktops" />
          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              gap: 12,
              backgroundColor: T.panel,
              borderColor: T.line,
              borderWidth: 1,
              borderRadius: radii.card,
              paddingVertical: 12,
              paddingHorizontal: 14,
            }}
          >
            <View
              style={{
                width: 40,
                height: 40,
                borderRadius: 11,
                backgroundColor: T.raised,
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <View style={{ width: 18, height: 12, borderWidth: 1.5, borderColor: T.thread, borderRadius: 2 }} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={{ color: T.text, fontWeight: "600", fontSize: 15 }}>{daemonName}</Text>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 6, marginTop: 3 }}>
                <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: daemonDot }} />
                <Text style={{ color: T.dim, fontSize: 12, fontFamily: T.mono }} numberOfLines={1}>
                  {daemonReachability} · {host} · {projects.length} project{projects.length === 1 ? "" : "s"}
                  {working ? ` · ${working} active` : ""}
                </Text>
              </View>
              <LinkStrip samples={link} via={route === "cloud" ? "Loom Cloud" : route === "direct" ? "direct" : ""} />
            </View>
          </View>
        </View>

        {/* resume — the project currently needing you or running */}
        {active && (
          <View>
            <SectionLabel text="Resume" />
            <ProjectCard p={active} onPress={() => props.onOpen(active)} />
          </View>
        )}

        {/* Tasks — opens the board, which reads real issues and PRs from gh.
            No count is shown on purpose: the board fetches them per project when
            you open it, so a number here would be a second source of truth that
            drifts, or a guess. The row is the door, not the answer. */}
        {projects.length > 0 && (
          <View>
            <SectionLabel text="Tasks" />
            <TouchableOpacity
              activeOpacity={0.7}
              accessibilityRole="button"
              accessibilityLabel="Open the board: issues and pull requests"
              onPress={() => props.onOpen(active ?? projects[0]!)}
              style={{
                flexDirection: "row",
                alignItems: "center",
                gap: 12,
                backgroundColor: T.panel,
                borderColor: T.line,
                borderWidth: 1,
                borderRadius: radii.card,
                paddingVertical: 12,
                paddingHorizontal: 14,
                minHeight: 44,
              }}
            >
              <View
                style={{
                  width: 40,
                  height: 40,
                  borderRadius: 11,
                  backgroundColor: T.raised,
                  alignItems: "center",
                  justifyContent: "center",
                  gap: 3,
                }}
              >
                {[0, 1, 2].map((i) => (
                  <View key={i} style={{ flexDirection: "row", alignItems: "center", gap: 3 }}>
                    <View style={{ width: 4, height: 4, borderRadius: 1, backgroundColor: T.thread }} />
                    <View style={{ width: 9, height: 1.5, borderRadius: 1, backgroundColor: T.dim }} />
                  </View>
                ))}
              </View>
              <View style={{ flex: 1 }}>
                <Text style={{ color: T.text, fontWeight: "600", fontSize: 15 }}>Tasks</Text>
                <Text style={{ color: T.dim, fontSize: 12, marginTop: 3 }} numberOfLines={1}>
                  issues and pull requests, on the board
                </Text>
              </View>
              <Text style={{ color: T.dim, fontSize: 18 }}>{"\u203a"}</Text>
            </TouchableOpacity>
          </View>
        )}

        {/* projects */}
        <View>
          <SectionLabel text="Projects" />
          <View style={{ gap: spacing.sm }}>
            {projects.length === 0 ? (
              <Sys text="no projects yet — run loom init on your computer" />
            ) : (
              projects.map((p) => (
                <ProjectCard key={p.id} p={p} onPress={() => props.onOpen(p)} />
              ))
            )}
          </View>
        </View>

        {/* quick actions */}
        <View>
          <SectionLabel text="Quick actions" />
          <View style={{ flexDirection: "row", gap: spacing.sm }}>
            <TouchableOpacity
              activeOpacity={0.7}
              disabled={!projects.length}
              onPress={() => props.onOpen(active ?? projects[0]!)}
              style={{
                flex: 1,
                backgroundColor: T.panel,
                borderColor: T.line,
                borderWidth: 1,
                borderRadius: 12,
                paddingVertical: 14,
                alignItems: "center",
                opacity: projects.length ? 1 : 0.45,
              }}
            >
              <Text style={{ color: T.text, fontWeight: "600", fontSize: 14 }}>New task</Text>
              <Text style={{ color: T.faint, fontSize: 11, marginTop: 2 }}>message an agent</Text>
            </TouchableOpacity>
            <TouchableOpacity
              activeOpacity={0.7}
              onPress={async () => {
                setRefreshing(true);
                await refresh();
                setRefreshing(false);
              }}
              style={{
                flex: 1,
                backgroundColor: T.panel,
                borderColor: T.line,
                borderWidth: 1,
                borderRadius: 12,
                paddingVertical: 14,
                alignItems: "center",
              }}
            >
              <Text style={{ color: T.text, fontWeight: "600", fontSize: 14 }}>Refresh</Text>
              <Text style={{ color: T.faint, fontSize: 11, marginTop: 2 }}>reload the board</Text>
            </TouchableOpacity>
          </View>
        </View>
      </ScrollView>

      <ApprovalsSheet
        creds={props.creds}
        projects={projects}
        visible={approvalsOpen}
        onClose={() => setApprovalsOpen(false)}
        onChanged={() => void refresh()}
        kindOf={(id) => projects.flatMap((p) => p.agents).find((a) => a.id === id)?.kind}
      />
    </View>
  );
}

// ---------------------------------------------------------------------------
// Project: Thread | Orchestra | Observatory | Ask | Tasks | Changes | Tools
// ---------------------------------------------------------------------------

type Tab = "thread" | "orchestra" | "crew" | "observatory" | "ask" | "memory" | "brain" | "landing" | "runners" | "tasks" | "changes" | "tools";

/**
 * Six tabs no longer fit across a phone, so the strip scrolls. The labels stay
 * short for the same reason — "Observatory" is already the longest thing that
 * can sit here without pushing everything else off the edge.
 */
const TABS: ReadonlyArray<{ key: Tab; label: string; accent?: string }> = [
  { key: "thread", label: "Thread" },
  { key: "orchestra", label: "Orchestra", accent: T.thread },
  { key: "crew", label: "Crew", accent: T.shuttle },
  { key: "observatory", label: "Observatory", accent: T.primary },
  { key: "ask", label: "Ask", accent: T.primary },
  // the project's own memory, shared or not (the desktop's Memory tab)
  { key: "memory", label: "Memory", accent: T.ok },
  // only while the repo is shared with a team (see visibleTabs below)
  { key: "brain", label: "Team brain", accent: T.ok },
  // Phase 4: goal PRs on their way to main; shown with a team or once there are any
  { key: "landing", label: "Landing", accent: T.warn },
  // Phase 5: goals on always-on runners, and deploys; shown with a team or once there are runners
  { key: "runners", label: "Runners", accent: T.primary },
  { key: "tasks", label: "Tasks" },
  { key: "changes", label: "Changes" },
  { key: "tools", label: "Tools" },
];

export function ProjectScreen(props: {
  creds: Creds;
  project: Project;
  onBack: () => void;
  /** Open on this thread instead of main — the Fleet screen's rows point at one. */
  initialChat?: { id: string; title: string };
  /** Open on this tab (a tapped push notification: its goal's Orchestra tab). */
  initialTab?: "thread" | "orchestra";
  /** With initialTab "orchestra": open on this run. */
  initialRunId?: string;
}) {
  const { creds } = props;
  const [project, setProject] = useState(props.project);
  const [tab, setTab] = useState<Tab>(props.initialTab ?? "thread");
  const [chatId, setChatId] = useState(props.initialChat?.id ?? "main");
  const [chats, setChats] = useState<Chat[]>([]);
  const [chatMenu, setChatMenu] = useState<Chat | null>(null);
  const [importing, setImporting] = useState(false);
  const [groupOpen, setGroupOpen] = useState<{ g: NonNullable<Chat["group"]>; chats: Chat[] } | null>(null);
  const attach = useAttachments(creds, project.id, (msg) => setErr(msg));
  const reloadChats = () => void getChats(creds, project.id).then(({ chats }) => setChats(chats)).catch(() => {});
  // a chat change from the menu: do it, close the menu, re-read the list (and leave a deleted chat)
  const act = async (fn: () => Promise<unknown>, gone?: string) => {
    try {
      await fn();
      setChatMenu(null);
      if (gone && gone === chatId) setChatId("main");
      reloadChats();
    } catch (e) {
      setChatMenu(null);
      setErr(e instanceof Error ? e.message : String(e));
    }
  };
  const newChat = async () => {
    try {
      const { chat } = await createChat(creds, project.id, "");
      setChats((cs) => [...cs.filter((c) => c.id !== chat.id), chat]);
      setChatId(chat.id);
      haptic.tap();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };
  // A chat opened from elsewhere (an Orchestra task) that isn't in the sidebar list.
  const [extraChat, setExtraChat] = useState<Chat | null>(
    props.initialChat && props.initialChat.id !== "main"
      ? { id: props.initialChat.id, title: props.initialChat.title, createdAt: Date.now() }
      : null,
  );
  // Tool calls parked on a human, in any of this project's chats.
  const [pending, setPending] = useState<Approval[]>([]);
  const [approvalsOpen, setApprovalsOpen] = useState(false);
  const notified = useRef(new Set<string>());
  // Composer extras: plan mode and the prompt library.
  const [plan, setPlan] = useState(false);
  const [promptsOpen, setPromptsOpen] = useState(false);
  // Bumped on every `orchestra` event so the Orchestra tab refetches that run.
  const [orchPulse, setOrchPulse] = useState<{ n: number; runId: string | null }>({ n: 0, runId: null });
  // Bumped on every `crew` event so the Crew tab refetches.
  const [crewPulse, setCrewPulse] = useState(0);
  const [events, setEvents] = useState<LoomEvent[]>([]);
  // What agents are typing in this chat right now, before it's a message.
  const [live, setLive] = useState<LiveMap>({});
  // The thread's first page didn't come (the route was flipping, the relay
  // was slow): say so and try again, rather than showing an empty thread.
  const [historyErr, setHistoryErr] = useState<string | null>(null);
  const [historyTry, setHistoryTry] = useState(0);
  // The thread on screen is the phone's saved copy (the daemon hasn't answered yet).
  const [threadCachedAt, setThreadCachedAt] = useState<number | null>(null);
  const threadFresh = useRef(false);
  const [refreshing, setRefreshing] = useState(false);
  // What this phone has read, per chat (the chips' unread dots).
  const seenKey = `loomSeen:${project.id}`;
  const [seen, setSeen] = useState<SeenMap>({});
  useEffect(() => {
    void kv.get(seenKey).then((v) => {
      try {
        setSeen(v ? (JSON.parse(v) as SeenMap) : {});
      } catch {
        setSeen({});
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.id]);
  const saveSeen = (next: SeenMap) => {
    setSeen(next);
    void kv.set(seenKey, JSON.stringify(next)).catch(() => {});
  };
  const [tree, setTree] = useState<WorkingTree | null>(null);
  const [checkpoints, setCheckpoints] = useState<Checkpoint[] | null>(null);
  const [commitMsg, setCommitMsg] = useState("");
  const [committing, setCommitting] = useState<"commit" | "push" | null>(null);
  // everything changed goes in: a phone has no staging area to fiddle with
  const commitAll = async (push: boolean) => {
    if (!tree || !commitMsg.trim() || committing) return;
    setCommitting(push ? "push" : "commit");
    try {
      await gitStage(creds, project.id, tree.files.map((f) => f.path).filter((p) => !p.startsWith(".loom/")));
      const r = await gitCommit(creds, project.id, commitMsg.trim());
      let note = `Committed ${r.sha} · ${r.files} file${r.files === 1 ? "" : "s"}`;
      if (push) note += ` · pushed ${(await gitPush(creds, project.id)).branch}`;
      setCommitMsg("");
      setErr(null);
      Alert.alert("Done", note);
      void getTree(creds, project.id).then(({ tree }) => setTree(tree)).catch(() => {});
    } catch (e) {
      setErr(String(e instanceof Error ? e.message : e));
    } finally {
      setCommitting(null);
    }
  };
  const [tasks, setTasks] = useState<TaskResult | null>(null);
  const [tasksTry, setTasksTry] = useState(0);
  // the Board first, as on the desktop; Issues and PRs are GitHub's own lists
  const [taskKind, setTaskKind] = useState<"board" | "issue" | "pr">("board");
  const [taskBusy, setTaskBusy] = useState<number | null>(null);
  const [selected, setSelected] = useState<string | null>(
    props.project.holder ?? props.project.agents.find((a) => a.tier === "adapter")?.id ?? null,
  );
  const [text, setText] = useState("");
  /** What's lined up behind the running turn — see core/prompt-queue.ts. */
  const [queue, setQueue] = useState<QueueView | null>(null);
  const [editingQueued, setEditingQueued] = useState<{ id: string; text: string } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const lastId = useRef(0);
  // Keep the phone's copy of this thread current, a beat after it settles.
  useEffect(() => {
    if (!threadFresh.current || !events.length) return;
    const t = setTimeout(() => void saveThread(creds.url, project.id, chatId, events), 1500);
    return () => clearTimeout(t);
  }, [events, creds.url, project.id, chatId]);
  // Loom Teams Phase 3: the team brain's inbox count, for the tab badge.
  const brain = useBrainSummary(creds, props.project.id);
  // Phase 4: goal PRs that need you + teammates' goals that need someone.
  const landing = useLandingSummary(creds, props.project.id, orchPulse.n);
  // Phase 5: runners that take this project's goals, and the goals on them.
  const runners = useRunnersSummary(creds, props.project.id, orchPulse.n);
  const listRef = useRef<FlatList<LoomEvent>>(null);

  // Voice input: dictation appends to whatever is already typed.
  const sttBase = useRef("");
  const stt = useStt((transcript) => {
    setText(sttBase.current ? `${sttBase.current} ${transcript}` : transcript);
  });

  const loadPending = useCallback(() => {
    void getApprovals(creds, project.id)
      .then(({ approvals }) => setPending(approvals))
      .catch(() => {}); // an older daemon has no approvals: nothing is ever pending
  }, [creds, project.id]);

  useEffect(() => {
    loadPending();
  }, [loadPending]);

  // The project's chats — the desktop's sidebar list, so the phone can switch.
  useEffect(() => {
    void getChats(creds, project.id)
      .then(({ chats }) => setChats(chats))
      .catch(() => {});
  }, [creds, project.id]);

  // History + live feed, scoped to the selected chat. One feed carries the whole
  // project, so we filter live frames to this chat (events carry a `chat` id).
  // The feed rides whichever route is up — the /ws socket directly, or the
  // Loom Cloud relay — and reopens itself when that route changes.
  useEffect(() => {
    let live = true;
    let retryHistory: ReturnType<typeof setTimeout> | undefined;
    setEvents([]); // clear the old chat's thread while the new one loads
    setLive({});
    lastId.current = 0;
    threadFresh.current = false;
    setThreadCachedAt(null);
    // Show the saved copy at once; the daemon's answer replaces it.
    void loadThread<LoomEvent>(creds.url, project.id, chatId).then((c) => {
      if (!live || !c || threadFresh.current || !c.data.length) return;
      setEvents(c.data);
      setThreadCachedAt(c.at);
    });
    void getEvents(creds, project.id, chatId)
      .then(({ events, live: typing }) => {
        if (!live) return;
        threadFresh.current = true;
        setThreadCachedAt(null);
        lastId.current = Math.max(lastId.current, events[events.length - 1]?.id ?? 0);
        setEvents(events);
        setLive((m) => seed(m, typing, chatId));
        setHistoryErr(null);
        setRefreshing(false);
        const newest = events[events.length - 1]?.id ?? 0;
        if (newest) setSeen((s) => {
          const next = markRead(s, chatId, newest);
          if (next !== s) void kv.set(seenKey, JSON.stringify(next)).catch(() => {});
          return next;
        });
      })
      .catch((e: unknown) => {
        if (!live) return;
        setRefreshing(false);
        setHistoryErr(e instanceof Error ? e.message : String(e));
        retryHistory = setTimeout(() => setHistoryTry((n) => n + 1), 4000);
      });
    const close = openLiveStream(creds, project.id, (raw) => {
      const frame = raw as { type?: string; event?: LoomEvent; chat?: string } & Partial<StreamFrame>;
      if (frame?.type === "stream") {
        if ((frame.chat || "main") === chatId && frame.agentId && frame.text) {
          const f = frame as StreamFrame;
          setLive((m) => applyStream(m, f));
        }
        return;
      }
      if (frame?.type !== "event" || !frame.event) return;
      const ev = frame.event;
      setLive((m) => applyEvent(m, ev));
      // Orchestra steps land in task chats; the tab wants them whichever chat is open.
      if (ev.kind === "orchestra") {
        const runId = typeof ev.payload?.runId === "string" ? ev.payload.runId : null;
        setOrchPulse((p) => ({ n: p.n + 1, runId }));
      }
      // A crew spans its channel and a thread per teammate: the Crew tab wants every step.
      if (ev.kind === "crew") setCrewPulse((n) => n + 1);
      // Approvals matter whichever chat they're in: the banner counts them all.
      if (ev.kind === "approval") {
        const aid = String(ev.payload?.approvalId ?? "");
        if (ev.payload?.phase === "requested" && aid && !notified.current.has(aid)) {
          notified.current.add(aid);
          notifyApproval({ agent: ev.agentId ?? "An agent", tool: String(ev.payload.tool ?? "a tool"), project: project.name });
        }
        loadPending();
      }
      if (ev.id <= lastId.current) return;
      if (ev.chat && ev.chat !== chatId) return; // a different chat
      lastId.current = ev.id;
      setEvents((prev) => [...prev, ev]);
      if (ev.kind === "message" && ev.agentId && !ev.payload?.reasoning) {
        haptic.success(); // a reply landed where you're looking
        setSeen((s) => {
          const next = markRead(s, chatId, ev.id);
          if (next !== s) void kv.set(seenKey, JSON.stringify(next)).catch(() => {});
          return next;
        });
      }
    });
    return () => {
      live = false;
      if (retryHistory) clearTimeout(retryHistory);
      close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.id, chatId, historyTry]);

  // Status poll + changes tab refresh.
  useEffect(() => {
    const t = setInterval(() => {
      void getProject(creds, project.id)
        .then(({ project: p }) => setProject(p))
        .catch(() => {});
      loadPending();
      void getQueue(creds, project.id)
        .then(setQueue)
        .catch(() => {});
      // chats carry their newest reply id: the chips' unread dots
      void getChats(creds, project.id)
        .then(({ chats }) => setChats(chats))
        .catch(() => {});
      if (tab === "changes") {
        void getTree(creds, project.id)
          .then(({ tree }) => setTree(tree))
          .catch(() => {});
      }
    }, 4000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.id, tab]);

  useEffect(() => {
    if (tab === "changes") {
      void getTree(creds, project.id)
        .then(({ tree }) => setTree(tree))
        .catch((e) => setErr(String(e instanceof Error ? e.message : e)));
      void getCheckpoints(creds, project.id).then((r) => setCheckpoints(r.checkpoints)).catch(() => setCheckpoints([]));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  // Tasks: refetch when the tab opens or the kind flips. Not polled — gh shells
  // out to the network, and a phone in your pocket shouldn't drive that.
  //
  // `live` matters: the daemon runs two gh commands per fetch, so flipping
  // Issues↔PRs leaves two responses racing. Without this, a late PR response
  // wins while the Issues pill is lit — and tapping a row would hand an agent
  // a brief for the kind you aren't looking at.
  useEffect(() => {
    if (tab !== "tasks" || taskKind === "board") return;
    let live = true;
    setTasks(null);
    const kind = taskKind;
    void getTasks(creds, project.id, kind, `is:${kind} is:open`)
      .then((r) => {
        if (live) setTasks(r);
      })
      .catch((e) => {
        if (live) {
          setTasks({ available: false, reason: "error", detail: String(e instanceof Error ? e.message : e) });
        }
      });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, taskKind, project.id, tasksTry]);

  /**
   * Hand an issue to an agent: the same brief the desktop drafts, sent to the
   * baton holder. This is the whole point of Tasks on a phone — see it, start
   * it, put the phone away.
   *
   * Confirm first. The desktop shows this brief in an editable field before it
   * goes anywhere; a tap on a scrolling list has no such beat, and this spends
   * money and moves the baton. The prompt names the agent, so a mis-tap costs
   * one "Cancel" instead of a run.
   */
  const startTask = (item: TaskItem) => {
    if (taskBusy !== null) return; // one start at a time — a second would hand off twice
    const agent = selected ?? project.holder;
    if (!agent) return setErr("no agent to start this with");
    const noun = item.kind === "pr" ? "PR" : "issue";
    Alert.alert(
      `Start ${noun} #${item.id}?`,
      `${item.title}\n\n${agent} will read it and start work${
        agent !== project.holder ? `, taking the baton from ${project.holder ?? "nobody"}` : ""
      }.`,
      [
        { text: "Cancel", style: "cancel" },
        { text: "Start", onPress: () => void run(item, agent, noun) },
      ],
    );
  };

  const run = async (item: TaskItem, agent: string, noun: string) => {
    setErr(null);
    setTaskBusy(item.id);
    try {
      if (agent !== project.holder) await handoff(creds, project.id, agent);
      await sendMessage(
        creds,
        project.id,
        `${noun} #${item.id}: ${item.title}\n${item.url}\n\nRead the ${noun}, then implement it.`,
        agent,
        chatId,
      );
      setTab("thread");
    } catch (e) {
      setErr(String(e instanceof Error ? e.message : e));
    } finally {
      setTaskBusy(null);
    }
  };

  const send = async () => {
    if (stt.listening) void stt.toggle(); // stop dictation on send
    if (attach.uploading) return setErr("still uploading the picture…");
    // pictures lead the message as "[image] <path>" lines, as the desktop sends them
    const refs = attach.refs();
    const typed = text.trim();
    const message = refs.length ? refs.join("\n") + (typed ? `\n\n${typed}` : "") : typed;
    if (!message) return;
    attach.clear();
    haptic.tap();
    setText("");
    sttBase.current = "";
    setErr(null);
    try {
      if (selected && selected !== project.holder) await handoff(creds, project.id, selected);
      const res = await sendMessage(creds, project.id, message, selected ?? undefined, chatId, plan ? { plan: true } : undefined);
      // a prompt to a busy agent joins the queue: show it now, not at the next poll
      if ((res as { queued?: number }).queued) {
        void getQueue(creds, project.id)
          .then(setQueue)
          .catch(() => {});
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };

  const adapters = project.agents.filter((a) => a.tier === "adapter");
  const selectedAgent = project.agents.find((a) => a.id === selected) ?? null;
  const decisions = useMemo(() => approvalDecisions(events), [events]);
  const answered = useMemo(() => answeredQuestions(events), [events]);
  const requested = useMemo(
    () =>
      new Set(
        events
          .filter((e) => e.kind === "approval" && e.payload?.phase === "requested")
          .map((e) => String(e.payload.approvalId ?? "")),
      ),
    [events],
  );
  const kindOf = (id: string) => project.agents.find((a) => a.id === id)?.kind;
  const threadCtx = useMemo(() => ({ creds, projectId: project.id }), [creds, project.id]);
  // one checklist per plan, and no tool line under a card that already says it
  const shownEvents = useMemo(() => {
    const gone = foldedEvents(events);
    // and a run of tool calls is one line that opens, as on the desktop
    return groupToolRuns(gone.size ? events.filter((e) => !gone.has(e.id)) : events) as LoomEvent[];
  }, [events]);
  const refreshProject = () =>
    void getProject(creds, project.id)
      .then(({ project: p }) => setProject(p))
      .catch(() => {});
  const r = project.route;
  const routeActive = r && (r.status === "running" || r.status === "waiting_human");
  const armed = text.trim().length > 0 || attach.items.length > 0;

  return (
    <KeyboardAvoidingView
      style={{ flex: 1 }}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      {/* session top bar */}
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
          <Text numberOfLines={1} style={{ color: T.text, fontWeight: "600", fontSize: 14 }}>
            {project.name}
          </Text>
          <Text style={{ color: T.faint, fontSize: 11, fontFamily: T.mono }}>
            {project.needsInput ? "needs input" : usd(project.costUsd) || "idle"}
          </Text>
        </View>
        <DeliveryChip creds={creds} projectId={project.id} />
        <ConnectionBadge />
        {project.needsInput || project.agents.some((a) => a.busy) ? (
          <Btn small label="■ stop" onPress={() =>
            // this chat's turn, as on the desktop — not a turn in another thread
            void interrupt(creds, project.id, chatId)
              .then((r) => { if (!r.interrupted) setErr("Nothing is running in this chat."); })
              .catch((e) => setErr(String(e.message ?? e)))
          } />
        ) : null}
      </View>

      {/* tab strip — active tab carries a 2px underline; scrolls, six don't fit */}
      <View
        style={{
          backgroundColor: T.panel,
          borderBottomWidth: 1,
          borderBottomColor: T.line,
        }}
      >
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={{ flexGrow: 0 }}
          contentContainerStyle={{ paddingHorizontal: spacing.md, gap: spacing.lg, alignItems: "stretch" }}
        >
          {TABS.filter((t) => {
            if (t.key === tab) return true;
            if (t.key === "brain") return brain.summary.shared && !brain.summary.hidden;
            if (t.key === "landing")
              return !landing.summary.hidden && (brain.summary.shared || landing.summary.goals > 0 || landing.summary.count > 0);
            if (t.key === "runners") return runnersTabVisible({ ...runners.summary, shared: brain.summary.shared });
            return true;
          }).map((t) => {
            const count = t.key === "brain" ? brain.summary.inbox : t.key === "landing" ? landing.summary.count : 0;
            return (
              <TouchableOpacity
                key={t.key}
                onPress={() => setTab(t.key)}
                activeOpacity={0.7}
                accessibilityRole="tab"
                accessibilityState={{ selected: tab === t.key }}
                style={{
                  justifyContent: "center",
                  minHeight: 44,
                  borderBottomWidth: 2,
                  borderBottomColor: tab === t.key ? (t.accent ?? T.dim) : "transparent",
                  marginBottom: -1,
                }}
              >
                <View style={{ flexDirection: "row", alignItems: "center", gap: 5 }}>
                  <Text style={{ color: tab === t.key ? T.text : T.dim, fontWeight: "600", fontSize: 13 }}>
                    {t.label}
                  </Text>
                  {count > 0 ? (
                    <View
                      accessibilityLabel={t.key === "landing" ? `${count} need you` : `${count} to review`}
                      style={{
                        minWidth: 17,
                        height: 17,
                        paddingHorizontal: 4,
                        borderRadius: radii.pill,
                        backgroundColor: T.warn,
                        alignItems: "center",
                        justifyContent: "center",
                      }}
                    >
                      <Text style={{ color: T.onBright, fontSize: 10, fontWeight: "700" }}>
                        {count > 99 ? "99+" : count}
                      </Text>
                    </View>
                  ) : null}
                </View>
              </TouchableOpacity>
            );
          })}
        </ScrollView>
        {routeActive && (
          <View style={{ paddingHorizontal: spacing.md, paddingBottom: 6 }}>
            <Text style={{ color: T.thread, fontSize: 11, fontFamily: T.mono }} numberOfLines={1}>
              ▸ {r!.name ?? "route"} {r!.current + 1}/{r!.steps.length}
              {r!.status === "waiting_human" ? " ⏸ reply below" : ""}
            </Text>
          </View>
        )}
      </View>

      {pending.length > 0 && (
        <View style={{ paddingHorizontal: spacing.md, paddingTop: spacing.sm }}>
          <ApprovalBanner count={pending.length} onPress={() => setApprovalsOpen(true)} />
        </View>
      )}

      {err && <Sys color={T.err} text={err} />}

      {tab === "thread" ? (
        <>
          {/* chats — the desktop's sidebar list, so you can read previous chats */}
          {(
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              style={{ maxHeight: 46, flexGrow: 0, backgroundColor: T.panel, borderBottomWidth: 1, borderBottomColor: T.line }}
              contentContainerStyle={{ paddingHorizontal: spacing.md, paddingVertical: 8, gap: spacing.sm, alignItems: "center" }}
            >
              {/* first, so they're in reach however many chats there are: a new chat, or one brought in from an agent's own history */}
              <TouchableOpacity
                onPress={() => void newChat()}
                activeOpacity={0.7}
                accessibilityRole="button"
                accessibilityLabel="New chat"
                style={{ paddingHorizontal: 12, paddingVertical: 6, borderRadius: 999, borderWidth: 1, borderColor: T.line, borderStyle: "dashed" }}
              >
                <Text style={{ color: T.dim, fontSize: 12.5, fontWeight: "600" }}>+ New</Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={() => setImporting(true)}
                activeOpacity={0.7}
                accessibilityRole="button"
                accessibilityLabel="Import chats from Claude Code, Codex or OpenCode"
                style={{ paddingHorizontal: 12, paddingVertical: 6, borderRadius: 999, borderWidth: 1, borderColor: T.line, borderStyle: "dashed" }}
              >
                <Text style={{ color: T.dim, fontSize: 12.5, fontWeight: "600" }}>⤓ Import</Text>
              </TouchableOpacity>
              {(() => {
                const shown = [...chats, ...(extraChat && !chats.some((c) => c.id === extraChat.id) ? [extraChat] : [])]
                  .filter((c) => !c.archived || c.id === chatId)
                  // a run's / crew's threads ride under one chip (below), except the one you're in
                  .filter((c) => !c.group || c.pinned || c.id === chatId)
                  .sort((a, b) => (a.id === "main" ? -1 : b.id === "main" ? 1 : (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0)));
                const { unread, seen: based } = unreadChats(shown, seen, chatId);
                if (Object.keys(based).length !== Object.keys(seen).length) setTimeout(() => saveSeen(based), 0);
                return shown.map((c) => ({ c, dot: unread.has(c.id) }));
              })().map(({ c, dot }) => {
                const on = c.id === chatId;
                return (
                  <TouchableOpacity
                    key={c.id}
                    onPress={() => setChatId(c.id)}
                    onLongPress={() => c.id !== "main" && setChatMenu(c)}
                    delayLongPress={350}
                    activeOpacity={0.7}
                    accessibilityRole="tab"
                    accessibilityHint={c.id === "main" ? undefined : "long-press to rename, pin, archive or delete"}
                    accessibilityState={{ selected: on }}
                    style={{
                      paddingHorizontal: 12,
                      paddingVertical: 6,
                      borderRadius: 999,
                      backgroundColor: on ? T.raised : "transparent",
                      borderWidth: 1,
                      borderColor: on ? T.line : "transparent",
                    }}
                  >
                    <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                      {c.pinned ? <Text style={{ color: T.faint, fontSize: 10 }}>📌</Text> : null}
                      <Text style={{ color: on ? T.text : T.dim, fontSize: 12.5, fontWeight: "600" }}>{c.title}</Text>
                      {dot ? <View accessibilityLabel="unread" style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: T.thread }} /> : null}
                    </View>
                  </TouchableOpacity>
                );
              })}
              {/* one chip per run, race or crew: its threads open from a sheet */}
              {(() => {
                const by = new Map<string, { g: NonNullable<Chat["group"]>; chats: Chat[] }>();
                for (const c of chats) {
                  if (!c.group || c.archived || c.pinned) continue;
                  const k = `${c.group.kind}:${c.group.id}`;
                  const e = by.get(k) ?? { g: c.group, chats: [] };
                  e.chats.push(c);
                  by.set(k, e);
                }
                return [...by.entries()].sort((a, b) => Math.max(b[1].g.at, ...b[1].chats.map((c) => c.createdAt)) - Math.max(a[1].g.at, ...a[1].chats.map((c) => c.createdAt))).map(([k, e]) => {
                  const st = e.g.status ?? "";
                  const color = /^(running|planning|starting|reviewing)$/.test(st) ? T.ok : /^(waiting_human|awaiting_approval)$/.test(st) ? T.warn : /^(failed|aborted|stopped|interrupted)$/.test(st) ? T.err : T.faint;
                  const on = e.chats.some((c) => c.id === chatId);
                  return (
                    <TouchableOpacity key={k} onPress={() => setGroupOpen(e)} activeOpacity={0.7} accessibilityRole="button" accessibilityLabel={`${e.g.title}, ${e.chats.length} chats`}
                      style={{ flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 12, paddingVertical: 6, borderRadius: 999, borderWidth: 1, borderColor: on ? T.line2 : T.line, backgroundColor: on ? T.raised : "transparent", maxWidth: 230 }}>
                      <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: color }} />
                      <Text style={{ color: on ? T.text : T.dim, fontSize: 12.5, fontWeight: "600", flexShrink: 1 }} numberOfLines={1}>{e.g.title}</Text>
                      <Text style={{ color: T.faint, fontSize: 11.5 }}>{e.chats.length}</Text>
                    </TouchableOpacity>
                  );
                });
              })()}

            </ScrollView>
          )}
          <Sheet title={groupOpen ? `${groupOpen.g.kind === "race" ? "Race" : groupOpen.g.kind === "crew" ? "Crew" : groupOpen.g.kind === "import" ? "Imported" : "Orchestra"} · ${groupOpen.chats.length} chats` : ""} visible={!!groupOpen} onClose={() => setGroupOpen(null)}>
            {groupOpen ? <Text style={{ color: T.dim, fontSize: 12.5, marginBottom: 6 }} numberOfLines={2}>{groupOpen.g.title}</Text> : null}
            {(groupOpen?.chats ?? []).map((c) => (
              <TouchableOpacity key={c.id} onPress={() => { setGroupOpen(null); setChatId(c.id); }} activeOpacity={0.7} accessibilityRole="button"
                style={{ minHeight: 44, justifyContent: "center", borderBottomWidth: 1, borderBottomColor: T.line }}>
                <Text style={{ color: c.id === chatId ? T.text : T.dim, fontSize: 14, fontWeight: c.id === chatId ? "700" : "400" }} numberOfLines={1}>{c.title}</Text>
              </TouchableOpacity>
            ))}
          </Sheet>
          <ImportSheet
            visible={importing}
            creds={creds}
            project={project}
            onClose={() => setImporting(false)}
            onOpen={(id) => { setImporting(false); reloadChats(); setChatId(id); }}
          />
          <ChatMenu
            chat={chatMenu}
            onClose={() => setChatMenu(null)}
            onRename={(title) => chatMenu && void act(() => renameChat(creds, project.id, chatMenu.id, title))}
            onFlags={(flags) => chatMenu && void act(() => setChatFlags(creds, project.id, chatMenu.id, flags))}
            onDelete={() => chatMenu && void act(() => deleteChat(creds, project.id, chatMenu.id), chatMenu.id)}
          />
          {threadCachedAt ? (
            <View
              accessibilityRole="text"
              style={{ paddingHorizontal: spacing.lg, paddingVertical: 6, backgroundColor: T.raised, borderBottomWidth: 1, borderBottomColor: T.line }}
            >
              <Text style={{ color: T.warn, fontSize: 12, fontFamily: T.mono }} numberOfLines={1}>
                {historyErr ? "Offline" : "Catching up"} · this phone's copy, {savedAgo(threadCachedAt)}
              </Text>
            </View>
          ) : null}
          <ThreadCtx.Provider value={threadCtx}>
          <FlatList
            ref={listRef}
            data={shownEvents}
            keyExtractor={(e) => String(e.id)}
            renderItem={({ item }) =>
              item.kind === "approval" ? (
                <ApprovalEvent
                  creds={creds}
                  projectId={project.id}
                  e={item}
                  decisions={decisions}
                  requested={requested}
                  kindOf={kindOf}
                  onDecided={loadPending}
                />
              ) : item.kind === "needs_input" && typeof item.payload?.requestId === "string" && item.payload?.responseMode !== "message" &&
                Array.isArray(item.payload?.questions) && item.payload.questions.length ? (
                <QuestionEvent creds={creds} projectId={project.id} e={item} answered={answered.get(String(item.payload.requestId))} />
              ) : (
                <EventLine e={item} kindOf={kindOf} />
              )
            }
            ListHeaderComponent={
              historyErr && !events.length ? (
                <Sys color={T.warn} text={`Couldn't load this thread. ${historyErr} Trying again…`} />
              ) : null
            }
            ListFooterComponent={<LiveReplies live={live} />}
            refreshControl={
              <RefreshControl
                refreshing={refreshing}
                onRefresh={() => {
                  setRefreshing(true);
                  setHistoryTry((n) => n + 1);
                }}
                tintColor={T.dim}
                colors={[T.thread]}
                progressBackgroundColor={T.panel}
              />
            }
            contentContainerStyle={{ padding: spacing.md, paddingBottom: 20 }}
            onContentSizeChange={() => {
              listRef.current?.scrollToEnd({ animated: true });
              // a card measured after the first pass (a question, an image) would end up under the dock
              setTimeout(() => listRef.current?.scrollToEnd({ animated: true }), 300);
            }}
            // the keyboard closing after a send resizes the list without changing its content
            onLayout={() => listRef.current?.scrollToEnd({ animated: false })}
            style={{ flex: 1 }}
          />
          </ThreadCtx.Provider>
          {/* command dock */}
          <View style={{ backgroundColor: T.panel, borderTopWidth: 1, borderTopColor: T.line }}>
            {/*
              What's lined up behind the running turn. A prompt you send to a
              busy agent joins this by itself; here you can see it, fix its
              wording, send it somewhere else, or drop it before it runs.
            */}
            {queue && queue.queue.length > 0 && (
              <View style={{ paddingHorizontal: spacing.sm + 2, paddingTop: spacing.sm, gap: 4 }}>
                <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                  <Text style={{ color: T.dim, fontSize: 11, fontWeight: "700", letterSpacing: 0.6 }}>
                    {`QUEUE · ${queue.queue.length}`}
                  </Text>
                  <Text numberOfLines={1} style={{ color: T.faint, fontSize: 11, flex: 1 }}>
                    {queue.paused ? queue.reason ?? "paused" : queue.waitingFor ?? ""}
                  </Text>
                  <TouchableOpacity
                    onPress={() => {
                      void queuePause(creds, project.id, !queue.paused)
                        .then(setQueue)
                        .catch((e) => setErr(String(e instanceof Error ? e.message : e)));
                    }}
                    accessibilityLabel={queue.paused ? "resume the queue" : "pause the queue"}
                  >
                    <Text style={{ color: T.primary, fontSize: 11, fontWeight: "600" }}>
                      {queue.paused ? "Resume" : "Pause"}
                    </Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    onPress={() =>
                      Alert.alert(`Clear ${queue.queue.length} queued prompt${queue.queue.length === 1 ? "" : "s"}?`, "They won't run.", [
                        { text: "Cancel", style: "cancel" },
                        { text: "Clear", style: "destructive", onPress: () => void queueClear(creds, project.id).then(setQueue).catch((e) => setErr(String(e instanceof Error ? e.message : e))) },
                      ])
                    }
                    accessibilityLabel="clear the queue"
                  >
                    <Text style={{ color: T.dim, fontSize: 11, fontWeight: "600" }}>Clear</Text>
                  </TouchableOpacity>
                </View>
                {queue.queue.map((item, i) => {
                  const who =
                    item.target.kind === "orchestra"
                      ? "orchestrate"
                      : item.target.kind === "auto"
                        ? "auto"
                        : item.target.agentId;
                  const editing = editingQueued?.id === item.id;
                  return (
                    <View
                      key={item.id}
                      style={{
                        flexDirection: "row",
                        alignItems: "center",
                        gap: 8,
                        opacity: queue.paused ? 0.65 : 1,
                        borderWidth: 1,
                        borderColor: T.line,
                        backgroundColor: T.raised,
                        borderRadius: radii.key,
                        paddingHorizontal: 8,
                        paddingVertical: 6,
                      }}
                    >
                      {/*
                        Reorder without dragging: a phone-sized queue is short,
                        and two taps beat a long-press gesture people have to
                        discover. Up is disabled at the top, down at the bottom.
                      */}
                      <View style={{ alignItems: "center" }}>
                        <TouchableOpacity
                          disabled={i === 0}
                          onPress={() => {
                            void queueEdit(creds, project.id, item.id, { to: i - 1 })
                              .then(setQueue)
                              .catch((e) => setErr(String(e instanceof Error ? e.message : e)));
                          }}
                          accessibilityLabel="move this prompt up"
                          hitSlop={{ top: 6, bottom: 2, left: 8, right: 8 }}
                        >
                          <Text style={{ color: i === 0 ? T.line : T.dim, fontSize: 11 }}>▲</Text>
                        </TouchableOpacity>
                        <Text style={{ color: T.faint, fontFamily: T.mono, fontSize: 10 }}>{i + 1}</Text>
                        <TouchableOpacity
                          disabled={i === queue.queue.length - 1}
                          onPress={() => {
                            void queueEdit(creds, project.id, item.id, { to: i + 1 })
                              .then(setQueue)
                              .catch((e) => setErr(String(e instanceof Error ? e.message : e)));
                          }}
                          accessibilityLabel="move this prompt down"
                          hitSlop={{ top: 2, bottom: 6, left: 8, right: 8 }}
                        >
                          <Text style={{ color: i === queue.queue.length - 1 ? T.line : T.dim, fontSize: 11 }}>▼</Text>
                        </TouchableOpacity>
                      </View>
                      {editing ? (
                        <>
                          <TextInput
                            style={{ ...field, flex: 1, paddingVertical: 6, fontSize: 13 }}
                            value={editingQueued.text}
                            onChangeText={(t) => setEditingQueued({ id: item.id, text: t })}
                            autoFocus
                            onSubmitEditing={() => {
                              const next = editingQueued.text.trim();
                              setEditingQueued(null);
                              if (!next || next === item.text) return;
                              void queueEdit(creds, project.id, item.id, { text: next })
                                .then(setQueue)
                                .catch((e) => setErr(String(e instanceof Error ? e.message : e)));
                            }}
                            returnKeyType="done"
                          />
                          <TouchableOpacity onPress={() => setEditingQueued(null)} accessibilityLabel="cancel the edit">
                            <Text style={{ color: T.dim, fontSize: 11 }}>Cancel</Text>
                          </TouchableOpacity>
                        </>
                      ) : (
                        <>
                          <TouchableOpacity
                            style={{ flex: 1 }}
                            onPress={() => setEditingQueued({ id: item.id, text: item.text })}
                            accessibilityLabel={`edit the queued prompt for ${who}`}
                          >
                            <Text numberOfLines={2} style={{ color: T.text, fontSize: 13 }}>
                              {item.text}
                            </Text>
                            <Text style={{ color: T.faint, fontSize: 10, fontFamily: T.mono, marginTop: 2 }}>
                              {`to ${who}${item.editedAt ? " · edited" : ""}${item.plan ? " · plan" : ""}${
                                item.when ? " · held" : ""
                              }`}
                            </Text>
                          </TouchableOpacity>
                          {/* send it to someone else, as the desktop's target picker does */}
                          <TouchableOpacity
                            onPress={() =>
                              Alert.alert("Send this to…", undefined, [
                                ...["auto", ...adapters.map((a) => a.id), "orchestra"].filter((t) => t !== (item.target.kind === "agent" ? item.target.agentId : item.target.kind)).slice(0, 6).map((t) => ({
                                  text: t === "auto" ? "Whoever is free (auto)" : t === "orchestra" ? "Orchestrate it" : t,
                                  onPress: () => void queueEdit(creds, project.id, item.id, { target: t }).then(setQueue).catch((e) => setErr(String(e instanceof Error ? e.message : e))),
                                })),
                                { text: "Cancel", style: "cancel" as const },
                              ])
                            }
                            accessibilityLabel={`change who this prompt goes to (now ${who})`}
                            hitSlop={{ top: 8, bottom: 8, left: 6, right: 6 }}
                          >
                            <Text style={{ color: T.dim, fontSize: 12 }}>⇄</Text>
                          </TouchableOpacity>
                          {item.when ? (
                            <TouchableOpacity
                              onPress={() => void queueEdit(creds, project.id, item.id, { when: null }).then(setQueue).catch((e) => setErr(String(e instanceof Error ? e.message : e)))}
                              accessibilityLabel="stop holding this prompt and let it run in turn"
                              hitSlop={{ top: 8, bottom: 8, left: 6, right: 6 }}
                            >
                              <Text style={{ color: T.primary, fontSize: 11, fontWeight: "600" }}>Release</Text>
                            </TouchableOpacity>
                          ) : null}
                          <TouchableOpacity
                            onPress={() => {
                              void queueRemove(creds, project.id, item.id)
                                .then(setQueue)
                                .catch((e) => setErr(String(e instanceof Error ? e.message : e)));
                            }}
                            accessibilityLabel="remove this queued prompt"
                            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                          >
                            <Text style={{ color: T.dim, fontSize: 14 }}>×</Text>
                          </TouchableOpacity>
                        </>
                      )}
                    </View>
                  );
                })}
              </View>
            )}
            <View
              style={{
                flexDirection: "row",
                flexWrap: "wrap",
                alignItems: "center",
                gap: 6,
                paddingHorizontal: spacing.sm + 2,
                paddingTop: spacing.sm,
              }}
            >
              <AgentPicker
                agents={project.agents}
                selected={selected}
                holder={project.holder}
                onSelect={setSelected}
              />
              <ModelPicker creds={creds} projectId={project.id} agent={selectedAgent} onChanged={refreshProject} />
              <PermissionChip creds={creds} projectId={project.id} agent={selectedAgent} onChanged={refreshProject} />
              {/* grouped so they wrap together, right-aligned, on a narrow phone */}
              <View style={{ flexDirection: "row", alignItems: "center", gap: 6, marginLeft: "auto" }}>
                <TouchableOpacity
                  onPress={() => setPromptsOpen(true)}
                  activeOpacity={0.7}
                  accessibilityRole="button"
                  accessibilityLabel="Prompts: saved and recent"
                  style={{
                    minHeight: 34,
                    justifyContent: "center",
                    paddingHorizontal: 10,
                    borderRadius: radii.pill,
                    borderWidth: 1,
                    borderColor: T.line,
                    backgroundColor: T.raised,
                  }}
                >
                  <Text style={{ color: T.dim, fontSize: 12, fontWeight: "600" }}>Prompts</Text>
                </TouchableOpacity>
                <View
                  style={{ flexDirection: "row", alignItems: "center", gap: 4, minHeight: 34 }}
                  accessibilityRole="switch"
                  accessibilityState={{ checked: plan }}
                >
                  <Text style={{ color: plan ? T.primary : T.dim, fontSize: 12, fontWeight: "600" }}>Plan</Text>
                  <Switch
                    value={plan}
                    onValueChange={setPlan}
                    accessibilityLabel="Plan mode: the agent writes a plan instead of code"
                    trackColor={{ false: T.raised, true: T.primaryDim }}
                    thumbColor={plan ? T.primary : T.dim}
                    ios_backgroundColor={T.raised}
                    style={Platform.OS === "ios" ? { transform: [{ scale: 0.8 }] } : undefined}
                  />
                </View>
              </View>
            </View>
            <AttachBar items={attach.items} onRemove={attach.remove} />
            <View
              style={{
                flexDirection: "row",
                gap: spacing.sm,
                paddingHorizontal: spacing.sm + 2,
                paddingVertical: spacing.sm + 2,
                alignItems: "center",
              }}
            >
              <AttachButton onAdd={attach.add} onError={(m) => setErr(m)} />
              <TextInput
                style={{ ...field, flex: 1, paddingVertical: 9, fontSize: 14 }}
                value={text}
                onChangeText={setText}
                placeholder={
                  stt.listening
                    ? "listening…"
                    : plan
                      ? "What should it plan? (writes a plan, no code)"
                      : selected && selected !== project.holder
                      ? `send shifts baton to ${selected}`
                      : "Message…"
                }
                placeholderTextColor={stt.listening ? T.err : T.faint}
                selectionColor={T.accentBlue}
                onSubmitEditing={send}
                returnKeyType="send"
              />
              {stt.available && (
                <TouchableOpacity
                  onPress={() => {
                    sttBase.current = text.trim();
                    void stt.toggle().then((ok) => {
                      if (!ok) setErr("microphone permission needed for voice input");
                    });
                  }}
                  activeOpacity={0.7}
                  style={{
                    backgroundColor: stt.listening ? T.err : T.raised,
                    borderColor: stt.listening ? T.err : T.line,
                    borderWidth: 1,
                    borderRadius: radii.key,
                    paddingVertical: 9,
                    paddingHorizontal: 10,
                    minHeight: 34,
                    justifyContent: "center",
                  }}
                >
                  <Text
                    style={{
                      color: stt.listening ? "#ffffff" : T.dim,
                      fontSize: 12,
                      fontFamily: T.mono,
                      fontWeight: "600",
                    }}
                  >
                    {stt.listening ? "● rec" : "mic"}
                  </Text>
                </TouchableOpacity>
              )}
              <TouchableOpacity
                onPress={send}
                activeOpacity={0.7}
                style={{
                  width: 34,
                  height: 34,
                  borderRadius: 17,
                  alignItems: "center",
                  justifyContent: "center",
                  backgroundColor: armed ? T.bright : T.raised,
                  borderWidth: 1,
                  borderColor: armed ? T.bright : T.line,
                }}
              >
                <Text
                  style={{
                    color: armed ? T.onBright : T.dim,
                    fontSize: 16,
                    fontWeight: "700",
                    lineHeight: 19,
                  }}
                >
                  ↑
                </Text>
              </TouchableOpacity>
            </View>
          </View>
          <PromptsSheet
            creds={creds}
            visible={promptsOpen}
            onClose={() => setPromptsOpen(false)}
            draft={text}
            onInsert={(t) => setText((cur) => (cur.trim() ? `${cur.trimEnd()}\n${t}` : t))}
          />
        </>
      ) : tab === "crew" ? (
        <CrewView
          creds={creds}
          project={project}
          pulse={crewPulse}
          onOpenChat={(id, title) => {
            if (!chats.some((c) => c.id === id)) setExtraChat({ id, title, createdAt: Date.now() });
            setChatId(id);
            setTab("thread");
          }}
        />
      ) : tab === "orchestra" ? (
        <OrchestraView
          creds={creds}
          project={project}
          pulse={orchPulse.n}
          pulseRunId={orchPulse.runId}
          {...(props.initialRunId ? { initialRunId: props.initialRunId } : {})}
          onOpenChat={(id, title) => {
            if (!chats.some((c) => c.id === id)) setExtraChat({ id, title, createdAt: Date.now() });
            setChatId(id);
            setTab("thread");
          }}
        />
      ) : tab === "observatory" ? (
        <ObservatoryView creds={creds} project={project} />
      ) : tab === "ask" ? (
        <AskView creds={creds} project={project} />
      ) : tab === "memory" ? (
        <MemoryView creds={creds} project={project} />
      ) : tab === "brain" ? (
        <TeamBrainView creds={creds} project={project} onChanged={brain.update} />
      ) : tab === "landing" ? (
        <TeamLandingView
          creds={creds}
          project={project}
          teamId={brain.summary.teamId}
          pulse={orchPulse.n}
          onChanged={landing.update}
        />
      ) : tab === "runners" ? (
        <TeamRunnersView creds={creds} project={project} pulse={orchPulse.n} onChanged={runners.update} />
      ) : tab === "tools" ? (
        <ToolsView
          creds={creds}
          project={project}
          // Enabling/disabling an agent or changing its role rewrites the roster
          // the whole screen renders from, so pull it back immediately instead of
          // waiting out the 4s poll and letting the switch look like it snapped back.
          onAgentsChanged={() =>
            void getProject(creds, project.id)
              .then(({ project: p }) => setProject(p))
              .catch(() => {})
          }
        />
      ) : tab === "tasks" ? (
        <ScrollView
          style={{ flex: 1 }}
          contentContainerStyle={{ padding: spacing.md }}
          refreshControl={
            <RefreshControl
              refreshing={false}
              onRefresh={() => setTasksTry((n) => n + 1)}
              tintColor={T.dim}
              colors={[T.thread]}
              progressBackgroundColor={T.panel}
            />
          }
        >
          {/* Issues / PRs */}
          <View style={{ flexDirection: "row", gap: spacing.sm, marginBottom: spacing.md }}>
            {(["board", "issue", "pr"] as const).map((k) => (
              <TouchableOpacity
                key={k}
                onPress={() => setTaskKind(k)}
                activeOpacity={0.7}
                accessibilityRole="button"
                accessibilityState={{ selected: taskKind === k }}
                style={{
                  backgroundColor: taskKind === k ? T.raised : "transparent",
                  borderColor: taskKind === k ? T.line2 : T.line,
                  borderWidth: 1,
                  borderRadius: radii.pill,
                  paddingVertical: 5,
                  paddingHorizontal: 13,
                }}
              >
                <Text style={{ color: taskKind === k ? T.text : T.dim, fontSize: 12, fontWeight: "600" }}>
                  {k === "board" ? "Board" : k === "issue" ? "Issues" : "PRs"}
                </Text>
              </TouchableOpacity>
            ))}
            {taskKind !== "board" && tasks?.available && (
              <Text
                style={{ color: T.faint, fontFamily: T.mono, fontSize: 11, marginLeft: "auto", alignSelf: "center" }}
              >
                {tasks.repo}
              </Text>
            )}
          </View>

          {taskKind === "board" ? (
            <BoardView creds={creds} project={project} />
          ) : !tasks ? (
            <Sys text="loading…" />
          ) : !tasks.available ? (
            // never an empty list to mean "unavailable" — say which it is
            <View style={{ gap: 6, paddingVertical: spacing.lg }}>
              <Sys
                color={T.warn}
                text={
                  tasks.reason === "no-remote"
                    ? "no GitHub remote"
                    : tasks.reason === "no-auth"
                      ? "gh is signed out"
                      : tasks.reason === "no-cli"
                        ? "GitHub CLI not found on the daemon host"
                        : "couldn't load tasks"
                }
              />
              {/* gh's own words only when they're the news; otherwise what to do about it */}
              <Sys
                text={
                  tasks.reason === "no-remote"
                    ? "This project isn't on GitHub yet. Push it to a GitHub repo and its issues and pull requests show up here."
                    : tasks.reason === "no-auth"
                      ? "Run gh auth login on your computer, then pull to refresh."
                      : tasks.reason === "no-cli"
                        ? "Install the GitHub CLI (gh) on your computer, then pull to refresh."
                        : tasks.detail
                }
              />
            </View>
          ) : !tasks.items.length ? (
            <Sys text={`no open ${taskKind === "pr" ? "pull requests" : "issues"}`} />
          ) : (
            <>
              <Text style={{ color: T.faint, fontSize: 11, marginBottom: spacing.sm }}>
                tap one to hand it to {selected ?? project.holder ?? "an agent"} — you&apos;ll confirm first
              </Text>
              {tasks.items.map((it) => (
                <TaskRow key={it.id} item={it} onStart={startTask} busy={taskBusy === it.id} />
              ))}
              {tasks.capped && <Sys text={`showing the first ${tasks.items.length}`} />}
            </>
          )}
        </ScrollView>
      ) : (
        <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: spacing.md, gap: spacing.sm + 2 }}>
          {!tree ? (
            <Sys text="loading…" />
          ) : !tree.git ? (
            <Sys text="not a git repository" />
          ) : (
            <>
              <Text style={{ color: T.dim, fontSize: 13 }}>
                <Text style={{ fontFamily: T.mono, color: T.text }}>{tree.branch}</Text>
                {"  ·  "}
                {tree.files.length} changed file{tree.files.length === 1 ? "" : "s"}
              </Text>
              {tree.files.map((f) => {
                const st = fileStatus(f.status);
                return (
                  <Text key={f.path} style={{ color: T.dim, fontFamily: T.mono, fontSize: 12 }}>
                    <Text style={{ color: st.color }}>{st.label.padEnd(8, "\u00A0")}</Text>
                    {f.path}
                  </Text>
                );
              })}
              {tree.files.length ? (
                <View style={{ gap: 8 }}>
                  <TextInput value={commitMsg} onChangeText={setCommitMsg} placeholder="Commit message…" placeholderTextColor={T.faint}
                    style={{ color: T.text, backgroundColor: T.raised, borderRadius: radii.key, paddingHorizontal: 12, height: 40, fontSize: 14 }} />
                  <View style={{ flexDirection: "row", gap: 8 }}>
                    {(["commit", "push"] as const).map((k) => (
                      <TouchableOpacity key={k} onPress={() => void commitAll(k === "push")} disabled={!commitMsg.trim() || !!committing} activeOpacity={0.75} accessibilityRole="button"
                        style={{ flex: 1, minHeight: 40, borderRadius: radii.key, alignItems: "center", justifyContent: "center",
                          backgroundColor: k === "commit" ? T.bright : "transparent", borderWidth: k === "commit" ? 0 : 1, borderColor: T.line2, opacity: !commitMsg.trim() ? 0.4 : 1 }}>
                        {committing === k ? <ActivityIndicator color={k === "commit" ? T.onBright : T.text} /> : (
                          <Text style={{ color: k === "commit" ? T.onBright : T.text, fontWeight: "700" }}>{k === "commit" ? "Commit all" : "Commit & push"}</Text>
                        )}
                      </TouchableOpacity>
                    ))}
                  </View>
                  <DiffView patch={tree.patch} maxHeight={520} />
                </View>
              ) : (
                <Sys text="working tree is clean" />
              )}
              {/* Rewind: the files as they were before a turn — the desktop's rewind menu */}
              {checkpoints && checkpoints.length ? (
                <View style={{ gap: 2, marginTop: spacing.md }}>
                  <Text style={{ color: T.faint, fontSize: 11, fontWeight: "700", letterSpacing: 0.6, marginBottom: 4 }}>REWIND · BEFORE A TURN</Text>
                  {checkpoints.slice(0, 12).map((cp) => (
                    <TouchableOpacity
                      key={cp.id}
                      onPress={() =>
                        Alert.alert(
                          `Put the files back to "${cp.label.slice(0, 60)}"?`,
                          "Anything written since is removed, and anything removed since comes back. Your commits, your history and files git ignores are untouched — and the rewind itself is saved, so you can undo it.",
                          [
                            { text: "Cancel", style: "cancel" },
                            {
                              text: "Rewind",
                              style: "destructive",
                              onPress: () =>
                                void rewindTo(creds, project.id, cp.id)
                                  .then((r) => {
                                    const n = (r.changed ?? []).length;
                                    setErr(null);
                                    Alert.alert("Rewound", `${n} file${n === 1 ? "" : "s"} put back.`);
                                    void getTree(creds, project.id).then(({ tree }) => setTree(tree)).catch(() => {});
                                    void getCheckpoints(creds, project.id).then((x) => setCheckpoints(x.checkpoints)).catch(() => {});
                                  })
                                  .catch((e) => setErr(String(e instanceof Error ? e.message : e))),
                            },
                          ],
                        )
                      }
                      activeOpacity={0.7}
                      accessibilityRole="button"
                      accessibilityHint="puts the files back to how they were before this turn"
                      style={{ flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 9, borderBottomWidth: 1, borderBottomColor: T.line }}
                    >
                      <Text style={{ color: T.dim, fontSize: 13 }}>↺</Text>
                      <Text style={{ color: T.text, fontSize: 13, flex: 1 }} numberOfLines={1}>{cp.label}</Text>
                      <Text style={{ color: T.faint, fontSize: 11 }}>{ago(new Date(cp.at).toISOString())}</Text>
                    </TouchableOpacity>
                  ))}
                </View>
              ) : null}
            </>
          )}
        </ScrollView>
      )}

      <ApprovalsSheet
        creds={creds}
        projects={[{ id: project.id, name: project.name }]}
        visible={approvalsOpen}
        onClose={() => setApprovalsOpen(false)}
        onChanged={loadPending}
        kindOf={kindOf}
      />
    </KeyboardAvoidingView>
  );
}

/** git's two-letter porcelain code, in words. */
function fileStatus(code: string): { label: string; color: string } {
  const c = code.trim();
  if (c === "??" || c.includes("A")) return { label: "new", color: T.gitAdd };
  if (c.includes("U")) return { label: "conflict", color: T.warn };
  if (c.includes("D")) return { label: "deleted", color: T.gitDel };
  if (c.includes("R")) return { label: "renamed", color: T.warn };
  return { label: "edited", color: T.warn };
}

export async function unpair(): Promise<void> {
  await clearCreds();
  await clearCache();
}

/** Two minutes of pings as a row of bars, and what they add up to. */
function LinkStrip(props: { samples: LinkSample[]; via: string }) {
  const q = linkQuality(props.samples);
  if (q.samples < 2) return null;
  const color = q.grade === "good" ? T.ok : q.grade === "fair" ? T.warn : T.err;
  return (
    <View
      style={{ flexDirection: "row", alignItems: "center", gap: 8, marginTop: 6 }}
      accessible
      accessibilityLabel={`Link ${describeLink(q)}${props.via ? `, via ${props.via}` : ""}, over the last ${q.samples} checks`}
    >
      <View style={{ flexDirection: "row", alignItems: "flex-end", gap: 1.5, height: 14 }}>
        {sparkBars(props.samples).map((h, i) => (
          <View
            key={i}
            style={{
              width: 3,
              height: h < 0 ? 14 : Math.max(2, Math.round(h * 14)),
              borderRadius: 1,
              backgroundColor: h < 0 ? T.err : color,
              opacity: h < 0 ? 0.9 : 0.55 + 0.45 * (i / props.samples.length),
            }}
          />
        ))}
      </View>
      <Text style={{ color: T.dim, fontSize: 11, fontFamily: T.mono }} numberOfLines={1}>
        {describeLink(q)}
        {props.via ? ` · ${props.via}` : ""}
      </Text>
    </View>
  );
}

/** Long-press a chat: rename it, pin or archive it, or delete it — the desktop sidebar's menu. */
function ChatMenu(props: {
  chat: Chat | null;
  onClose: () => void;
  onRename: (title: string) => void;
  onFlags: (flags: { pinned?: boolean; archived?: boolean }) => void;
  onDelete: () => void;
}) {
  const [title, setTitle] = useState("");
  useEffect(() => setTitle(props.chat?.title ?? ""), [props.chat]);
  const c = props.chat;
  const row = (label: string, onPress: () => void, color = T.text) => (
    <TouchableOpacity onPress={onPress} activeOpacity={0.7} accessibilityRole="button"
      style={{ minHeight: 46, justifyContent: "center", borderBottomWidth: 1, borderBottomColor: T.line }}>
      <Text style={{ color, fontSize: 15, fontWeight: "600" }}>{label}</Text>
    </TouchableOpacity>
  );
  return (
    <Sheet title={c ? c.title : "Chat"} visible={!!c} onClose={props.onClose}>
      {c ? (
        <View style={{ gap: 4 }}>
          <View style={{ flexDirection: "row", gap: 8, marginBottom: 6 }}>
            <TextInput value={title} onChangeText={setTitle} placeholder="Chat name" placeholderTextColor={T.faint}
              returnKeyType="done" onSubmitEditing={() => title.trim() && props.onRename(title.trim())}
              style={{ flex: 1, color: T.text, backgroundColor: T.raised, borderRadius: radii.input, paddingHorizontal: 12, height: 42, fontSize: 15 }} />
            <TouchableOpacity disabled={!title.trim() || title.trim() === c.title} onPress={() => props.onRename(title.trim())}
              style={{ paddingHorizontal: 14, borderRadius: radii.input, backgroundColor: T.bright, justifyContent: "center", opacity: !title.trim() || title.trim() === c.title ? 0.4 : 1 }}>
              <Text style={{ color: T.onBright, fontWeight: "700" }}>Rename</Text>
            </TouchableOpacity>
          </View>
          {row(c.pinned ? "Unpin" : "Pin to the front", () => props.onFlags({ pinned: !c.pinned }))}
          {row(c.archived ? "Unarchive" : "Archive", () => props.onFlags({ archived: !c.archived }))}
          {row("Delete chat", () =>
            Alert.alert("Delete this chat?", `"${c.title}" and its messages go. The project's memory keeps what it learned.`, [
              { text: "Cancel", style: "cancel" },
              { text: "Delete", style: "destructive", onPress: props.onDelete },
            ]), T.err)}
        </View>
      ) : null}
    </Sheet>
  );
}

/** Chats you had with Claude Code, Codex or OpenCode in this project's folder, one tap from being Loom chats. */
function ImportSheet(props: { visible: boolean; creds: Creds; project: Project; onClose: () => void; onOpen: (chatId: string) => void }) {
  const [list, setList] = useState<ImportableChat[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [showLoom, setShowLoom] = useState(false);
  useEffect(() => {
    if (!props.visible) return;
    setList(null);
    setErr(null);
    void getImportable(props.creds, props.project.id).then((r) => setList(r.chats)).catch((e) => setErr(e instanceof Error ? e.message : String(e)));
  }, [props.visible, props.project.id]);
  const go = async (c: ImportableChat) => {
    if (c.chat) return props.onOpen(c.chat);
    setBusy(`${c.source}:${c.id}`);
    try {
      const r = await importChat(props.creds, props.project.id, c.source, c.id);
      props.onOpen(r.chat.id);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };
  const mine = (list ?? []).filter((c) => !c.fromLoom);
  const shown = showLoom ? list ?? [] : mine;
  const loomCount = (list ?? []).length - mine.length;
  return (
    <Sheet title="Import chats" visible={props.visible} onClose={props.onClose}>
      <Text style={{ color: T.faint, fontSize: 12, lineHeight: 17, marginBottom: 8 }}>
        From Claude Code, Codex and OpenCode&apos;s own history on your computer, for this folder. Nothing leaves it.
      </Text>
      {err ? <Text style={{ color: T.err, fontSize: 12.5, marginBottom: 6 }}>{err}</Text> : null}
      {!list && !err ? <ActivityIndicator color={T.dim} style={{ marginVertical: 16 }} /> : null}
      {list && !list.length ? <Text style={{ color: T.faint, fontSize: 13, paddingVertical: 12 }}>No chats from those agents ran in this folder.</Text> : null}
      {shown.slice(0, 60).map((c) => {
        const key = `${c.source}:${c.id}`;
        return (
          <TouchableOpacity key={key} onPress={() => void go(c)} disabled={!!busy} activeOpacity={0.7} accessibilityRole="button"
            style={{ flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: T.line }}>
            <AgentIcon kind={c.source} size={26} />
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text style={{ color: T.text, fontSize: 13.5 }} numberOfLines={1}>{c.title}</Text>
              <Text style={{ color: T.faint, fontSize: 11.5, marginTop: 2 }} numberOfLines={1}>
                {c.label} · {ago(new Date(c.updatedAt).toISOString())}{c.automated ? " · by a tool" : ""}{c.fromLoom ? " · Loom ran this" : ""}
              </Text>
            </View>
            {busy === key ? <ActivityIndicator color={T.dim} /> : <Text style={{ color: c.chat ? T.dim : T.primary, fontSize: 12.5, fontWeight: "700" }}>{c.chat ? "Open" : "Import"}</Text>}
          </TouchableOpacity>
        );
      })}
      {loomCount ? (
        <TouchableOpacity onPress={() => setShowLoom((v) => !v)} style={{ paddingVertical: 12, alignItems: "center" }}>
          <Text style={{ color: T.dim, fontSize: 12 }}>{showLoom ? "Hide" : "Show"} the {loomCount} Loom ran itself</Text>
        </TouchableOpacity>
      ) : null}
    </Sheet>
  );
}
