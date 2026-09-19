// Must be first: gives Hermes crypto.getRandomValues, which the Loom Cloud
// relay (noble ciphers, relay-client) needs before any of it loads.
import "react-native-get-random-values";

/**
 * Loom — native app. Same daemon API as the CLI/TUI/web app:
 * pair over the tailnet (or Loom Cloud), watch the board, drive the shared
 * thread, and see exactly which code each prompt changed.
 *
 * Welcome (signed out, first run) → Pair → Board → Project (or Board → Fleet
 * → Project, on the thread the fleet row pointed at). An account is
 * optional; "continue without an account" is remembered.
 */

import { StatusBar } from "expo-status-bar";
import { useEffect, useState } from "react";
import { AppState, SafeAreaView, TouchableOpacity, View } from "react-native";
import { AccountSheet, Avatar } from "./src/account";
import { getProject, loadCreds, setUnauthorizedHandler, type Creds, type Project } from "./src/api";
import { FleetScreen } from "./src/fleet";
import { enablePush, onNotificationOpen } from "./src/push";
import { BoardScreen, PairScreen, ProjectScreen, unpair } from "./src/screens";
import { loadAuthSkipped, recordAppOpen, setAuthSkipped, useAuth } from "./src/supabase";
import { notificationRoute, type NotificationRoute } from "./src/team-runners-model";
import { T } from "./src/theme";
import { WelcomeScreen } from "./src/welcome";

type Route =
  | { name: "pair" }
  | { name: "board" }
  | { name: "fleet"; focus?: "team" }
  | {
      name: "project";
      project: Project;
      chat?: { id: string; title: string };
      from?: "board" | "fleet";
      /** Opened from a tapped push: which tab (and goal), and a nonce so a second tap re-opens it. */
      focus?: { tab: "thread" | "orchestra"; runId?: string; n: number };
    };

export default function App() {
  const [creds, setCreds] = useState<Creds | null>(null);
  const [route, setRoute] = useState<Route>({ name: "pair" });
  const [booted, setBooted] = useState(false);
  const [skipped, setSkipped] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  const auth = useAuth();
  // A tapped push notification, waiting for credentials to open its project.
  const [opening, setOpening] = useState<NotificationRoute | null>(null);

  useEffect(() => {
    void Promise.all([loadCreds(), loadAuthSkipped()]).then(([saved, skip]) => {
      setSkipped(skip);
      if (saved) {
        setCreds(saved);
        setRoute({ name: "board" });
      }
      setBooted(true);
    });
  }, []);

  // Country-only open ping: at most once per UTC day, never blocks anything.
  useEffect(() => {
    recordAppOpen();
    const sub = AppState.addEventListener("change", (s) => {
      if (s === "active") recordAppOpen();
    });
    return () => sub.remove();
  }, []);

  // Register for pushes whenever we have credentials (idempotent).
  useEffect(() => {
    if (creds) void enablePush(creds);
  }, [creds]);

  // Tapping a push opens its project (and goal): data { projectId, kind, runId? } from the daemon.
  useEffect(
    () =>
      onNotificationOpen((data) => {
        const r = notificationRoute(data);
        if (r) setOpening(r);
      }),
    [],
  );
  useEffect(() => {
    if (!opening || !creds) return;
    const want = opening;
    setOpening(null);
    void getProject(creds, want.projectId)
      .then(({ project }) =>
        setRoute({
          name: "project",
          project,
          from: "board",
          focus: { tab: want.tab, ...(want.runId ? { runId: want.runId } : {}), n: Date.now() },
        }),
      )
      .catch(() => {}); // a project this pairing can't see (or one since removed): stay put
  }, [opening, creds]);

  // A revoked/expired token anywhere sends us back to the pair screen.
  useEffect(() => {
    setUnauthorizedHandler(() => {
      setCreds(null);
      setRoute({ name: "pair" });
    });
    return () => setUnauthorizedHandler(null);
  }, []);

  const showWelcome = booted && auth.ready && !auth.user && !skipped;

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: T.bg }}>
      <StatusBar style="light" backgroundColor={T.bg} />
      {!booted || !auth.ready ? (
        <View style={{ flex: 1, backgroundColor: T.bg }} />
      ) : showWelcome ? (
        <WelcomeScreen
          onSignedIn={() => {
            // useAuth picks the session up; nothing else to do
          }}
          onSkip={() => {
            setSkipped(true);
            void setAuthSkipped(true);
          }}
        />
      ) : route.name === "pair" || !creds ? (
        <PairScreen
          onPaired={(c) => {
            setCreds(c);
            setRoute({ name: "board" });
          }}
        />
      ) : route.name === "board" ? (
        <BoardScreen
          creds={creds}
          onOpen={(project) => setRoute({ name: "project", project })}
          onFleet={() => setRoute({ name: "fleet" })}
          onUnpair={() => {
            void unpair();
            setCreds(null);
            setRoute({ name: "pair" });
          }}
          accountButton={
            <TouchableOpacity
              onPress={() => setAccountOpen(true)}
              activeOpacity={0.7}
              accessibilityRole="button"
              accessibilityLabel="Account and privacy"
              hitSlop={8}
            >
              <Avatar user={auth.user} size={30} />
            </TouchableOpacity>
          }
        />
      ) : route.name === "fleet" ? (
        <FleetScreen
          key={route.focus ?? "fleet"}
          creds={creds}
          focusTeam={route.focus === "team"}
          onBack={() => setRoute({ name: "board" })}
          onOpen={(projectId, chat) =>
            void getProject(creds, projectId)
              .then(({ project }) => setRoute({ name: "project", project, from: "fleet", ...(chat ? { chat } : {}) }))
              .catch(() => {})
          }
        />
      ) : (
        <ProjectScreen
          key={`${route.project.id}:${route.chat?.id ?? ""}:${route.focus?.n ?? ""}`}
          creds={creds}
          project={route.project}
          {...(route.chat ? { initialChat: route.chat } : {})}
          {...(route.focus ? { initialTab: route.focus.tab } : {})}
          {...(route.focus?.runId ? { initialRunId: route.focus.runId } : {})}
          onBack={() => setRoute(route.from === "fleet" ? { name: "fleet" } : { name: "board" })}
        />
      )}
      <AccountSheet
        visible={accountOpen}
        onClose={() => setAccountOpen(false)}
        user={auth.user}
        creds={creds}
        onOpenTeam={() => {
          setAccountOpen(false);
          setRoute({ name: "fleet", focus: "team" });
        }}
        onSignedOut={() => {
          // back to the welcome, which is where signing out should land you
          setAccountOpen(false);
          setSkipped(false);
          void setAuthSkipped(false);
        }}
      />
    </SafeAreaView>
  );
}
