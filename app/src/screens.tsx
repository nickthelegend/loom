/** The three screens: Pair, Board, Project (Thread | Changes). */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  FlatList,
  KeyboardAvoidingView,
  Platform,
  RefreshControl,
  ScrollView,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import {
  claim,
  clearCreds,
  getEvents,
  getProject,
  getProjects,
  getTree,
  handoff,
  interrupt,
  saveCreds,
  sendMessage,
  wsUrl,
  type Creds,
  type LoomEvent,
  type Project,
  type WorkingTree,
} from "./api";
import { Btn, DiffView, EventLine, Sys } from "./components";
import { useStt } from "./stt";
import { T, usd } from "./theme";

const field = {
  backgroundColor: T.panel,
  borderColor: T.line,
  borderWidth: 1,
  borderRadius: 12,
  color: T.text,
  padding: 12,
  fontSize: 15,
} as const;

// ---------------------------------------------------------------------------
// Pair
// ---------------------------------------------------------------------------

export function PairScreen(props: { onPaired: (c: Creds) => void }) {
  const [url, setUrl] = useState("http://");
  const [token, setToken] = useState("");
  const [err, setErr] = useState<string | null>(null);

  const go = async () => {
    try {
      setErr(null);
      // Accept a pasted deep link (…/app#pair=…) in either field.
      const merged = `${url} ${token}`;
      const linkMatch = merged.match(/(https?:\/\/[^\s#]+)/);
      const tokenMatch = merged.match(/pair=([A-Za-z0-9]+)/);
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

  return (
    <View style={{ flex: 1, justifyContent: "center", padding: 24, gap: 12 }}>
      <Text style={{ color: T.text, fontSize: 34, fontFamily: T.mono, fontWeight: "700", textAlign: "center" }}>
        lo<Text style={{ color: T.accent }}>om</Text>
      </Text>
      <Text style={{ color: T.dim, textAlign: "center", marginBottom: 8 }}>
        one thread · every agent
      </Text>
      <Text style={{ color: T.dim, fontSize: 13 }}>
        On your computer: loom up --tailnet, then loom pair. Enter the daemon URL and the
        pairing token (or paste the whole link into either box).
      </Text>
      <TextInput
        style={field}
        value={url}
        onChangeText={setUrl}
        autoCapitalize="none"
        autoCorrect={false}
        placeholder="http://100.x.y.z:7420"
        placeholderTextColor={T.dim}
      />
      <TextInput
        style={field}
        value={token}
        onChangeText={setToken}
        autoCapitalize="none"
        autoCorrect={false}
        placeholder="pairing token"
        placeholderTextColor={T.dim}
      />
      {err && <Text style={{ color: T.err, fontSize: 13 }}>{err}</Text>}
      <Btn label="Pair this phone" primary onPress={go} />
    </View>
  );
}

// ---------------------------------------------------------------------------
// Board
// ---------------------------------------------------------------------------

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

  return (
    <View style={{ flex: 1 }}>
      <View style={{ flexDirection: "row", alignItems: "center", padding: 14, gap: 10 }}>
        <Text style={{ color: T.text, fontFamily: T.mono, fontWeight: "700", fontSize: 18 }}>
          lo<Text style={{ color: T.accent }}>om</Text>
        </Text>
        <Text style={{ color: T.dim, fontSize: 12 }}>projects</Text>
        <View style={{ flex: 1 }} />
        <Btn small label="unpair" onPress={props.onUnpair} />
      </View>
      {err && <Sys color={T.err} text={err} />}
      <FlatList
        data={projects}
        keyExtractor={(p) => p.id}
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
        contentContainerStyle={{ padding: 14, gap: 10 }}
        ListEmptyComponent={<Sys text="no projects yet — run loom init on your computer" />}
        renderItem={({ item: p }) => {
          const r = p.route;
          const active = r && (r.status === "running" || r.status === "waiting_human");
          return (
            <TouchableOpacity
              onPress={() => props.onOpen(p)}
              style={{
                backgroundColor: T.panel,
                borderColor: T.line,
                borderWidth: 1,
                borderRadius: 14,
                padding: 14,
              }}
            >
              <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                <View
                  style={{
                    width: 8,
                    height: 8,
                    borderRadius: 4,
                    backgroundColor: p.needsInput ? T.warn : "#3d475d",
                  }}
                />
                <Text style={{ color: T.text, fontWeight: "600", fontSize: 16 }}>{p.name}</Text>
                {active && (
                  <Text style={{ color: T.accent, fontSize: 11, marginLeft: "auto" }}>
                    ➤ {r!.name ?? "route"} {r!.current + 1}
                    {r!.status === "waiting_human" ? " ⏸" : ""}
                  </Text>
                )}
              </View>
              <Text style={{ color: T.dim, fontSize: 12.5, marginTop: 3 }}>
                baton: {p.holder ?? "—"}
                {p.costUsd ? ` · ${usd(p.costUsd)}` : ""}
                {p.needsInput ? " · needs input" : ""}
              </Text>
            </TouchableOpacity>
          );
        }}
      />
    </View>
  );
}

// ---------------------------------------------------------------------------
// Project: Thread | Changes
// ---------------------------------------------------------------------------

export function ProjectScreen(props: { creds: Creds; project: Project; onBack: () => void }) {
  const { creds } = props;
  const [project, setProject] = useState(props.project);
  const [tab, setTab] = useState<"thread" | "changes">("thread");
  const [events, setEvents] = useState<LoomEvent[]>([]);
  const [tree, setTree] = useState<WorkingTree | null>(null);
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

  // History + live WS.
  useEffect(() => {
    let ws: WebSocket | null = null;
    let closed = false;
    void getEvents(creds, project.id).then(({ events }) => {
      lastId.current = events[events.length - 1]?.id ?? 0;
      setEvents(events);
    });
    const connect = () => {
      ws = new WebSocket(wsUrl(creds, project.id));
      ws.onmessage = (msg) => {
        try {
          const frame = JSON.parse(String(msg.data)) as { type: string; event?: LoomEvent };
          if (frame.type === "event" && frame.event && frame.event.id > lastId.current) {
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
  }, [project.id]);

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

  const send = async () => {
    if (stt.listening) void stt.toggle(); // stop dictation on send
    const message = text.trim();
    if (!message) return;
    setText("");
    sttBase.current = "";
    setErr(null);
    try {
      if (selected && selected !== project.holder) await handoff(creds, project.id, selected);
      await sendMessage(creds, project.id, message, selected ?? undefined);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };

  const adapters = project.agents.filter((a) => a.tier === "adapter");
  const r = project.route;
  const routeActive = r && (r.status === "running" || r.status === "waiting_human");

  return (
    <KeyboardAvoidingView
      style={{ flex: 1 }}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <View style={{ flexDirection: "row", alignItems: "center", padding: 12, gap: 10 }}>
        <Btn small label="←" onPress={props.onBack} />
        <Text style={{ color: T.text, fontFamily: T.mono, fontWeight: "700", fontSize: 16 }}>
          {project.name}
        </Text>
        <Text style={{ color: T.dim, fontSize: 11 }}>{usd(project.costUsd)}</Text>
        <View style={{ flex: 1 }} />
        <Btn
          small
          label="■"
          onPress={() =>
            void interrupt(creds, project.id).catch((e) => setErr(String(e.message ?? e)))
          }
        />
      </View>

      <View style={{ flexDirection: "row", gap: 8, paddingHorizontal: 12, marginBottom: 6 }}>
        {(["thread", "changes"] as const).map((name) => (
          <TouchableOpacity key={name} onPress={() => setTab(name)}>
            <Text
              style={{
                color: tab === name ? T.accent : T.dim,
                fontWeight: tab === name ? "700" : "400",
                fontSize: 13,
              }}
            >
              {name === "thread" ? "Thread" : "Changes"}
            </Text>
          </TouchableOpacity>
        ))}
        {routeActive && (
          <Text style={{ color: T.accent, fontSize: 12, marginLeft: "auto" }}>
            ➤ {r!.name ?? "route"} {r!.current + 1}
            {r!.status === "waiting_human" ? " ⏸ reply below" : ""}
          </Text>
        )}
      </View>

      {err && <Sys color={T.err} text={err} />}

      {tab === "thread" ? (
        <>
          <FlatList
            ref={listRef}
            data={events}
            keyExtractor={(e) => String(e.id)}
            renderItem={({ item }) => <EventLine e={item} />}
            contentContainerStyle={{ padding: 12, paddingBottom: 20 }}
            onContentSizeChange={() => listRef.current?.scrollToEnd({ animated: true })}
            style={{ flex: 1 }}
          />
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            style={{ flexGrow: 0, borderTopWidth: 1, borderColor: T.line }}
            contentContainerStyle={{ padding: 8, gap: 8 }}
          >
            {adapters.map((a) => {
              const sel = a.id === selected;
              return (
                <TouchableOpacity
                  key={a.id}
                  onPress={() => setSelected(a.id)}
                  style={{
                    backgroundColor: sel ? T.accent : T.panel,
                    borderColor: sel ? T.accent : T.line,
                    borderWidth: 1,
                    borderRadius: 999,
                    paddingVertical: 5,
                    paddingHorizontal: 12,
                  }}
                >
                  <Text style={{ color: sel ? T.accentDark : T.dim, fontSize: 13 }}>
                    {a.id} {a.id === project.holder ? "⟵" : ""}
                    {a.busy ? " ⚙" : ""}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </ScrollView>
          <View style={{ flexDirection: "row", gap: 8, padding: 10, alignItems: "center" }}>
            <TextInput
              style={{ ...field, flex: 1, paddingVertical: 10 }}
              value={text}
              onChangeText={setText}
              placeholder={
                stt.listening
                  ? "listening…"
                  : selected && selected !== project.holder
                    ? `send shifts baton to ${selected}`
                    : "Message…"
              }
              placeholderTextColor={stt.listening ? T.err : T.dim}
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
                style={{
                  backgroundColor: stt.listening ? T.err : T.panel,
                  borderColor: stt.listening ? T.err : T.line,
                  borderWidth: 1,
                  borderRadius: 10,
                  paddingVertical: 10,
                  paddingHorizontal: 12,
                }}
              >
                <Text style={{ color: stt.listening ? "#fff" : T.text, fontSize: 15 }}>
                  {stt.listening ? "◉" : "🎙"}
                </Text>
              </TouchableOpacity>
            )}
            <Btn primary label="➤" onPress={send} />
          </View>
        </>
      ) : (
        <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 12, gap: 10 }}>
          {!tree ? (
            <Sys text="loading…" />
          ) : !tree.git ? (
            <Sys text="not a git repository" />
          ) : (
            <>
              <Text style={{ color: T.dim, fontSize: 13 }}>
                {tree.branch} · {tree.files.length} changed file
                {tree.files.length === 1 ? "" : "s"}
              </Text>
              {tree.files.map((f) => (
                <Text key={f.path} style={{ color: T.dim, fontFamily: T.mono, fontSize: 12 }}>
                  {f.status} {f.path}
                </Text>
              ))}
              {tree.files.length ? (
                <DiffView patch={tree.patch} maxHeight={520} />
              ) : (
                <Sys text="working tree is clean ✨" />
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
