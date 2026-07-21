/** The three screens: Pair, Board, Project (Thread | Changes) — quiet graphite. */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Alert,
  FlatList,
  KeyboardAvoidingView,
  Modal,
  Platform,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { CameraView, useCameraPermissions } from "expo-camera";
import {
  claim,
  clearCreds,
  getChats,
  getEvents,
  getProject,
  getProjects,
  getTasks,
  getTree,
  handoff,
  interrupt,
  saveCreds,
  sendMessage,
  wsUrl,
  type Chat,
  type Creds,
  type LoomEvent,
  type Project,
  type TaskItem,
  type TaskResult,
  type WorkingTree,
} from "./api";
import { Btn, DiffView, EventLine, Sys, TaskRow } from "./components";
import { useStt } from "./stt";
import { T, radii, spacing, usd } from "./theme";

const field = {
  backgroundColor: T.raised,
  borderColor: T.line,
  borderWidth: 1,
  borderRadius: radii.input,
  color: T.text,
  paddingHorizontal: 12,
  paddingVertical: 12,
  fontSize: 15,
} as const;

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

function PairStep(props: { n: number; text: string }) {
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
      <Text style={{ color: T.dim, fontSize: 13, lineHeight: 20, flex: 1 }}>{props.text}</Text>
    </View>
  );
}

export function PairScreen(props: { onPaired: (c: Creds) => void }) {
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
      const creds = await claim(
        linkMatch ? linkMatch[1]! : url.trim(),
        tokenMatch ? tokenMatch[1]! : token.trim(),
      );
      await saveCreds(creds);
      props.onPaired(creds);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };

  const go = () => void pairFrom(`${url} ${token}`);

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
        <PairStep n={1} text="On your computer: loom up --tailnet" />
        <PairStep n={2} text="Then: loom pair — it prints a QR and a link" />
        <PairStep n={3} text="Scan the QR below — or paste the link" />
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
      />
      {err && <Text style={{ color: T.err, fontSize: 13, textAlign: "center" }}>{err}</Text>}
      <Btn label="⚌  Scan QR code" primary onPress={startScan} />
      <Btn label="Paste link instead" onPress={go} />

      <Modal visible={scanning} animationType="slide" onRequestClose={() => setScanning(false)}>
        <View style={{ flex: 1, backgroundColor: "#000" }}>
          <CameraView
            style={StyleSheet.absoluteFill}
            facing="back"
            barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
            onBarcodeScanned={onScan}
          />
          <View style={{ position: "absolute", top: 72, left: 24, right: 24, alignItems: "center" }}>
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
          <View style={{ position: "absolute", bottom: 48, left: 24, right: 24 }}>
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
function glyph(seed: string): { bg: string; fg: string; ch: string } {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) % 360;
  return {
    bg: `hsla(${h}, 60%, 50%, 0.18)`,
    fg: `hsl(${h}, 55%, 72%)`,
    ch: (seed.trim()[0] ?? "?").toUpperCase(),
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
        backgroundColor: "rgba(26,26,26,0.6)",
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
  const g = glyph(`${p.id}${p.name}`);
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
}) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setErr(null);
      setProjects((await getProjects(props.creds)).projects);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
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
        <View style={{ flex: 1 }} />
        <Btn small label="unpair" onPress={props.onUnpair} />
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

        {err && <Sys color={T.err} text={err} />}

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
              <Text style={{ color: T.text, fontWeight: "600", fontSize: 15 }}>Loom daemon</Text>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 6, marginTop: 3 }}>
                <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: T.ok }} />
                <Text style={{ color: T.dim, fontSize: 12, fontFamily: T.mono }} numberOfLines={1}>
                  {host} · {projects.length} project{projects.length === 1 ? "" : "s"}
                  {working ? ` · ${working} active` : ""}
                </Text>
              </View>
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
    </View>
  );
}

// ---------------------------------------------------------------------------
// Project: Thread | Changes
// ---------------------------------------------------------------------------

export function ProjectScreen(props: { creds: Creds; project: Project; onBack: () => void }) {
  const { creds } = props;
  const [project, setProject] = useState(props.project);
  const [tab, setTab] = useState<"thread" | "tasks" | "changes">("thread");
  const [chatId, setChatId] = useState("main");
  const [chats, setChats] = useState<Chat[]>([]);
  const [events, setEvents] = useState<LoomEvent[]>([]);
  const [tree, setTree] = useState<WorkingTree | null>(null);
  const [tasks, setTasks] = useState<TaskResult | null>(null);
  const [taskKind, setTaskKind] = useState<"issue" | "pr">("issue");
  const [taskBusy, setTaskBusy] = useState<number | null>(null);
  const [selected, setSelected] = useState<string | null>(
    props.project.holder ?? props.project.agents.find((a) => a.tier === "adapter")?.id ?? null,
  );
  const [text, setText] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const lastId = useRef(0);
  const listRef = useRef<FlatList<LoomEvent>>(null);

  // Voice input: dictation appends to whatever is already typed.
  const sttBase = useRef("");
  const stt = useStt((transcript) => {
    setText(sttBase.current ? `${sttBase.current} ${transcript}` : transcript);
  });

  // The project's chats — the desktop's sidebar list, so the phone can switch.
  useEffect(() => {
    void getChats(creds, project.id)
      .then(({ chats }) => setChats(chats))
      .catch(() => {});
  }, [creds, project.id]);

  // History + live WS, scoped to the selected chat. One socket carries the whole
  // project, so we filter live frames to this chat (events carry a `chat` id).
  useEffect(() => {
    let ws: WebSocket | null = null;
    let closed = false;
    setEvents([]); // clear the old chat's thread while the new one loads
    lastId.current = 0;
    void getEvents(creds, project.id, chatId).then(({ events }) => {
      lastId.current = events[events.length - 1]?.id ?? 0;
      setEvents(events);
    });
    const connect = () => {
      ws = new WebSocket(wsUrl(creds, project.id));
      ws.onmessage = (msg) => {
        try {
          const frame = JSON.parse(String(msg.data)) as { type: string; event?: LoomEvent };
          if (frame.type === "event" && frame.event && frame.event.id > lastId.current) {
            if (frame.event.chat && frame.event.chat !== chatId) return; // a different chat
            lastId.current = frame.event.id;
            setEvents((prev) => [...prev, frame.event!]);
          }
        } catch {
          // ignore malformed frames
        }
      };
      ws.onclose = () => {
        if (!closed) setTimeout(connect, 3000);
      };
    };
    connect();
    return () => {
      closed = true;
      ws?.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.id, chatId]);

  // Status poll + changes tab refresh.
  useEffect(() => {
    const t = setInterval(() => {
      void getProject(creds, project.id)
        .then(({ project: p }) => setProject(p))
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
    if (tab !== "tasks") return;
    let live = true;
    setTasks(null);
    void getTasks(creds, project.id, taskKind, `is:${taskKind} is:open`)
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
  }, [tab, taskKind, project.id]);

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
    const message = text.trim();
    if (!message) return;
    setText("");
    sttBase.current = "";
    setErr(null);
    try {
      if (selected && selected !== project.holder) await handoff(creds, project.id, selected);
      await sendMessage(creds, project.id, message, selected ?? undefined, chatId);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };

  const adapters = project.agents.filter((a) => a.tier === "adapter");
  const r = project.route;
  const routeActive = r && (r.status === "running" || r.status === "waiting_human");
  const armed = text.trim().length > 0;

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
        <Btn small label="■ stop" onPress={() =>
          void interrupt(creds, project.id).catch((e) => setErr(String(e.message ?? e)))
        } />
      </View>

      {/* tab strip — active tab carries a neutral 2px underline */}
      <View
        style={{
          flexDirection: "row",
          alignItems: "stretch",
          paddingHorizontal: spacing.md,
          gap: spacing.lg,
          backgroundColor: T.panel,
          borderBottomWidth: 1,
          borderBottomColor: T.line,
        }}
      >
        {(["thread", "tasks", "changes"] as const).map((name) => (
          <TouchableOpacity
            key={name}
            onPress={() => setTab(name)}
            activeOpacity={0.7}
            accessibilityRole="tab"
            accessibilityState={{ selected: tab === name }}
            style={{
              paddingVertical: 9,
              borderBottomWidth: 2,
              borderBottomColor: tab === name ? T.dim : "transparent",
              marginBottom: -1,
            }}
          >
            <Text
              style={{
                color: tab === name ? T.text : T.dim,
                fontWeight: "600",
                fontSize: 13,
              }}
            >
              {name === "thread" ? "Thread" : name === "tasks" ? "Tasks" : "Changes"}
            </Text>
          </TouchableOpacity>
        ))}
        {routeActive && (
          <View style={{ marginLeft: "auto", justifyContent: "center" }}>
            <Text style={{ color: T.thread, fontSize: 11, fontFamily: T.mono }}>
              ▸ {r!.name ?? "route"} {r!.current + 1}/{r!.steps.length}
              {r!.status === "waiting_human" ? " ⏸ reply below" : ""}
            </Text>
          </View>
        )}
      </View>

      {err && <Sys color={T.err} text={err} />}

      {tab === "thread" ? (
        <>
          {/* chats — the desktop's sidebar list, so you can read previous chats */}
          {chats.length > 1 && (
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              style={{ maxHeight: 46, flexGrow: 0, backgroundColor: T.panel, borderBottomWidth: 1, borderBottomColor: T.line }}
              contentContainerStyle={{ paddingHorizontal: spacing.md, paddingVertical: 8, gap: spacing.sm, alignItems: "center" }}
            >
              {chats.map((c) => {
                const on = c.id === chatId;
                return (
                  <TouchableOpacity
                    key={c.id}
                    onPress={() => setChatId(c.id)}
                    activeOpacity={0.7}
                    accessibilityRole="tab"
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
                    <Text style={{ color: on ? T.text : T.dim, fontSize: 12.5, fontWeight: "600" }}>
                      {c.title}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </ScrollView>
          )}
          <FlatList
            ref={listRef}
            data={events}
            keyExtractor={(e) => String(e.id)}
            renderItem={({ item }) => <EventLine e={item} />}
            contentContainerStyle={{ padding: spacing.md, paddingBottom: 20 }}
            onContentSizeChange={() => listRef.current?.scrollToEnd({ animated: true })}
            style={{ flex: 1 }}
          />
          {/* command dock */}
          <View style={{ backgroundColor: T.panel, borderTopWidth: 1, borderTopColor: T.line }}>
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              style={{ flexGrow: 0 }}
              contentContainerStyle={{
                paddingHorizontal: spacing.sm,
                paddingTop: spacing.sm,
                gap: 6,
              }}
            >
              {adapters.map((a) => {
                const sel = a.id === selected;
                return (
                  <TouchableOpacity
                    key={a.id}
                    onPress={() => setSelected(a.id)}
                    activeOpacity={0.7}
                    style={{
                      backgroundColor: sel ? T.bright : T.raised,
                      borderColor: sel ? T.bright : T.line,
                      borderWidth: 1,
                      borderRadius: radii.key,
                      paddingVertical: 5,
                      paddingHorizontal: 10,
                      minWidth: 36,
                      alignItems: "center",
                    }}
                  >
                    <Text
                      style={{
                        color: sel ? T.onBright : T.dim,
                        fontSize: 12,
                        fontFamily: T.mono,
                        fontWeight: sel ? "700" : "400",
                      }}
                    >
                      {a.id}
                      {a.id === project.holder ? " ⟵" : ""}
                      {a.busy ? " ·" : ""}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </ScrollView>
            <View
              style={{
                flexDirection: "row",
                gap: spacing.sm,
                paddingHorizontal: spacing.sm + 2,
                paddingVertical: spacing.sm + 2,
                alignItems: "center",
              }}
            >
              <TextInput
                style={{ ...field, flex: 1, paddingVertical: 9, fontSize: 14 }}
                value={text}
                onChangeText={setText}
                placeholder={
                  stt.listening
                    ? "listening…"
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
        </>
      ) : tab === "tasks" ? (
        <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: spacing.md }}>
          {/* Issues / PRs */}
          <View style={{ flexDirection: "row", gap: spacing.sm, marginBottom: spacing.md }}>
            {(["issue", "pr"] as const).map((k) => (
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
                  {k === "issue" ? "Issues" : "PRs"}
                </Text>
              </TouchableOpacity>
            ))}
            {tasks?.available && (
              <Text
                style={{ color: T.faint, fontFamily: T.mono, fontSize: 11, marginLeft: "auto", alignSelf: "center" }}
              >
                {tasks.repo}
              </Text>
            )}
          </View>

          {!tasks ? (
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
              <Sys text={tasks.detail} />
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
              {tree.files.map((f) => (
                <Text key={f.path} style={{ color: T.dim, fontFamily: T.mono, fontSize: 12 }}>
                  <Text style={{ color: f.status.includes("D") ? T.gitDel : T.gitAdd }}>
                    {f.status}
                  </Text>{" "}
                  {f.path}
                </Text>
              ))}
              {tree.files.length ? (
                <DiffView patch={tree.patch} maxHeight={520} />
              ) : (
                <Sys text="working tree is clean" />
              )}
            </>
          )}
        </ScrollView>
      )}
    </KeyboardAvoidingView>
  );
}

export async function unpair(): Promise<void> {
  await clearCreds();
}
