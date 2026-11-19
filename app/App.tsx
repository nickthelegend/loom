import { notificationMachine } from "./src/r4-phone/model";
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

import { PhoneBoard } from "./src/r4-phone/board";
import { PhoneProject } from "./src/r4-phone/project";
import { useNotificationReplies } from "./src/r4-phone/replies";
import { usePhonePreferences } from "./src/r4-phone/preferences";
import { setHighContrast } from "./src/theme";
import { scopeOf } from "./src/cache-model";
import { parseLocation, accentOf } from "./src/shell-model";
import { ACCENT_KEY, onAccent, setAccent } from "./src/theme";
import { usePhoneEntry } from "./src/phone-entry";
import { usePhoneLock, LockScreen } from "./src/phone-lock";
import { loadHaptics } from "./src/phone-preferences";
import { outbox } from "./src/outbox";
import { haptic } from "./src/haptics";
import { StatusBar } from "expo-status-bar";
import { useEffect, useState } from "react";
import { AppState, TouchableOpacity, View, useColorScheme } from "react-native";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import { AccountSheet, Avatar } from "./src/account";
import { decideApproval, getProject, phoneApi, kv, listMachines, loadCreds, setUnauthorizedHandler, switchMachine, type Creds, type Project } from "./src/api";
import { credsOf, machineForPush } from "./src/machines-model";
import { FleetScreen } from "./src/fleet";
import { enablePush, onApprovalAction, onNotificationOpen, registerApprovalActions } from "./src/push";
import { BoardScreen, PairScreen, ProjectScreen, unpair } from "./src/screens";
import { loadAuthSkipped, recordAppOpen, setAuthSkipped, useAuth } from "./src/supabase";
import { isTeamMention } from "./src/sharing-model";
import { notificationRoute, type NotificationRoute } from "./src/team-runners-model";
import { T, THEME_KEY, onThemePref, scheme, setScheme, type ThemePref } from "./src/theme";
import { WelcomeScreen } from "./src/welcome";

type Route =
  | { name: "pair" }
  | { name: "board" }
  | { name: "fleet"; focus?: "team" }
  | {
      name: "project";
      project: Project;
      action?: "new-chat";
      chat?: { id: string; title: string };
      from?: "board" | "fleet";
      /** Opened from a tapped push: which tab (and goal), and a nonce so a second tap re-opens it. */
      focus?: { tab: "thread" | "orchestra" | "crew"; runId?: string; crewId?: string; n: number };
    };

export default function App() {
  const [creds, setCreds] = useState<Creds | null>(null);
  const [route, setRoute] = useState<Route>({ name: "pair" });
  const [booted, setBooted] = useState(false);
  const [skipped, setSkipped] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  const auth = useAuth();
  const lock = usePhoneLock();
  useNotificationReplies(lock.ready, lock.locked);
  const phonePreferences = usePhonePreferences();
  setHighContrast(phonePreferences.highContrast);
  const entry = usePhoneEntry();
  const [revealed, setRevealed] = useState(false);
  useEffect(() => { if (lock.ready && !lock.locked) setRevealed(true); }, [lock.ready, lock.locked]);
  useEffect(() => { if (lock.locked) setAccountOpen(false); }, [lock.locked]);
  const [pendingNew, setPendingNew] = useState(false);
  const [pendingApprovals, setPendingApprovals] = useState(false);
  useEffect(() => { void loadHaptics().catch(() => {}); }, []);
  useEffect(() => {
    if (!booted || !creds || !lock.ready || lock.locked || !entry.action) return;
    setRoute({ name: "board" });
    setPendingNew(entry.action === "new-chat");
    setPendingApprovals(entry.action === "approvals");
    entry.clearAction();
  }, [booted, creds, lock.ready, lock.locked, entry.action]);
  useEffect(() => {
    if (!entry.text || !creds || lock.locked) return;
    setRoute({ name: "board" });
  }, [entry.text, creds, lock.locked]);
  useEffect(() => {
    if (!creds || !lock.ready || lock.locked) return;
    let live = true;
    const flush = () => { if (live && AppState.currentState === "active") void outbox(creds).then(q => live ? q.flush(() => live && AppState.currentState === "active") : undefined).catch(() => {}); };
    flush(); const timer = setInterval(flush, 4000);
    const sub = AppState.addEventListener("change", state => { if (state === "active") flush(); });
    return () => { live = false; clearInterval(timer); sub.remove(); };
  }, [creds, lock.ready, lock.locked]);
  // A tapped push notification, waiting for credentials to open its project.
  const [openingTeam, setOpeningTeam] = useState(false);
  const [opening, setOpening] = useState<(NotificationRoute & { clientId?: string; daemon?: unknown }) | null>(null);

  useEffect(() => {
    void Promise.all([loadCreds(), loadAuthSkipped()]).then(async ([saved, skip]) => {
      setSkipped(skip);
      if (saved) {
        setCreds(saved);
        setRoute({ name: "board" });
        const last = parseLocation(await kv.get("loom.location." + scopeOf(saved.url)).catch(() => null));
        if (last) {
          try { const { project } = await getProject(saved, last.project); setRoute({ name: "project", project }); } catch { /* A removed project or offline machine opens on the board. */ }
        }
      }
      setBooted(true);
    });
  }, []);

  // Notification answers wait behind the same lock as the app's approval sheet.
  const [approvalAction, setApprovalAction] = useState<{ data: Record<string, unknown>; decision: "allow" | "deny" } | null>(null);
  useEffect(() => onApprovalAction((data, decision) => setApprovalAction({ data, decision })), []);
  useEffect(() => { if (lock.ready) void registerApprovalActions(lock.enabled); }, [lock.ready, lock.enabled]);
  useEffect(() => {
    if (!approvalAction || !lock.ready || lock.locked) return;
    const { data, decision } = approvalAction;
    setApprovalAction(null);
    const projectId = typeof data.projectId === "string" ? data.projectId : "";
    const approvalId = typeof data.approvalId === "string" ? data.approvalId : "";
    if (!projectId || !approvalId) return;
    void listMachines().then(({ machines, activeId }) => {
      const m = machineForPush(machines, data.daemon, activeId);
      if (m) void decideApproval(credsOf(m) as Creds, projectId, approvalId, decision).then(() => haptic.success()).catch(() => {});
    });
  }, [approvalAction, lock.ready, lock.locked]);

  // Register for pushes whenever we have credentials (idempotent).
  useEffect(() => {
    if (creds) void enablePush(creds);
  }, [creds]);

  // Tapping a push opens its project (and goal): data { projectId, kind, runId? } from the daemon.
  useEffect(
    () =>
      onNotificationOpen((data) => {
        if ((data as { screen?: string } | null)?.screen === "phone-brief") { setRoute({ name: "board" }); return; }
        if (isTeamMention(data)) { setOpeningTeam(true); return; }
        const r = notificationRoute(data);
        if (r) { const target = data as Record<string, unknown>; setOpening({ ...r, clientId: typeof target.clientId === "string" ? target.clientId : undefined, daemon: target.daemon }); }
      }),
    [],
  );
  useEffect(() => {
    if (!opening || !creds || !lock.ready || lock.locked) return;
    const want = opening;
    setOpening(null);
    void (async () => {
      const { machines } = await listMachines();
      const identities = await Promise.all(machines.map(async m => ({ m, id: await kv.get("loom.push-client." + m.token) })));
      const machine = notificationMachine(identities, want, true);
      if (!machine) return;
      const target = credsOf(machine) as Creds;
      const { project } = await phoneApi<{ project: Project }>(target, `/api/projects/${want.projectId}`);
      const active = await switchMachine(machine.id);
      if (!active || active.token !== target.token) return;
      setCreds(target);
      setRoute({ name: "project", project, from: "board", ...(want.chat ? { chat: { id: want.chat, title: "" } } : {}),
        focus: { tab: want.tab, ...(want.runId ? { runId: want.runId } : {}), ...(want.crewId ? { crewId: want.crewId } : {}), n: Date.now() } });
    })().catch(() => {});
  }, [opening, creds, lock.ready, lock.locked]);

  useEffect(() => {
    if (openingTeam && creds) { setOpeningTeam(false); setRoute({ name: "fleet", focus: "team" }); }
  }, [openingTeam, creds]);

  // A revoked/expired token anywhere sends us back to the pair screen.
  useEffect(() => {
    setUnauthorizedHandler(() => {
      // that computer let go of this phone — another paired one carries on, else pair again
      void loadCreds().then((next) => {
        setCreds(next);
        setRoute(next ? { name: "board" } : { name: "pair" });
      });
    });
    return () => setUnauthorizedHandler(null);
  }, []);

  const showWelcome = booted && auth.ready && !auth.user && !skipped;

  // Country-only open ping: at most once per UTC day, never blocks anything —
  // and never before the welcome, which is where a new install is told about it.
  const pastWelcome = booted && auth.ready && !showWelcome;
  useEffect(() => {
    if (!pastWelcome) return;
    recordAppOpen();
    const sub = AppState.addEventListener("change", (s) => {
      if (s === "active") recordAppOpen();
    });
    return () => sub.remove();
  }, [pastWelcome]);

  // Dark by default, as on the desktop; Light, or follow the phone, from the
  // account sheet. The palette swaps in place and the tree re-renders in place
  // (nothing is memoized, every style reads T at render), so drafts and open
  // chats survive a switch.
  const [, refreshAppearance] = useState(0);
  useEffect(() => {
    void kv.get(ACCENT_KEY).then(v => { setAccent(accentOf(v)); refreshAppearance(n => n + 1); });
    return onAccent(a => { setAccent(a); void kv.set(ACCENT_KEY, a); refreshAppearance(n => n + 1); });
  }, []);
  const sysScheme = useColorScheme();
  const [themePref, setThemePref] = useState<ThemePref>("dark");
  useEffect(() => {
    void kv.get(THEME_KEY).then((v) => { if (v === "light" || v === "system" || v === "dark") setThemePref(v); });
    return onThemePref((p) => { setThemePref(p); void kv.set(THEME_KEY, p); });
  }, []);
  setScheme(themePref === "system" ? (sysScheme === "light" ? "light" : "dark") : themePref);

  return (
    <SafeAreaProvider>
    {/* Android 15+ draws every app edge to edge (and an app targeting API 36
        can't opt out), so the status and navigation bars are real insets on
        both platforms now — not an opaque bar Android lays out for us. */}
    <SafeAreaView style={{ flex: 1, backgroundColor: T.bg }} edges={["top", "bottom", "left", "right"]}>
      <StatusBar style={scheme === "light" ? "dark" : "light"} />
      <View style={{ flex: 1, opacity: lock.locked ? 0 : 1 }} pointerEvents={lock.locked ? "none" : "auto"} accessibilityElementsHidden={lock.locked} importantForAccessibility={lock.locked ? "no-hide-descendants" : "auto"}>
      {!booted || !auth.ready || !revealed ? (
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
          {...(creds ? { onCancel: () => setRoute({ name: "board" }) } : {})}
        />
      ) : route.name === "board" ? (
        <PhoneBoard
          onMachineOpen={(c, project, chat) => { setCreds(c); setRoute({ name: "project", project, chat, focus: { tab: "thread", n: Date.now() } }); }}
          creds={creds}
          initialApprovals={pendingApprovals}
          onApprovalsOpened={() => setPendingApprovals(false)}
          entryHint={pendingNew ? "Choose a project for your new chat" : entry.text ? "Choose a project for shared text" : undefined}
          onOpen={(project, chat) => { setRoute({ name: "project", project, ...(chat ? { chat, focus: { tab: "thread", n: Date.now() } } : pendingNew ? { action: "new-chat" as const } : {}) }); setPendingNew(false); }}
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
        <PhoneProject
          key={`${route.project.id}:${route.chat?.id ?? ""}:${route.focus?.n ?? ""}`}
          creds={creds}
          project={route.project}
          initialAction={route.action}
          sharedDraft={entry.text}
          onSharedDraft={entry.clearText}
          {...(route.chat ? { initialChat: route.chat } : {})}
          {...(route.focus ? { initialTab: route.focus.tab } : {})}
          {...(route.focus?.crewId ? { initialCrewId: route.focus.crewId } : {})}
          {...(route.focus?.runId ? { initialRunId: route.focus.runId } : {})}
          onBack={() => { void kv.del("loom.location." + scopeOf(creds.url)).catch(() => {}); setRoute(route.from === "fleet" ? { name: "fleet" } : { name: "board" }); }}
        />
      )}
      </View>
      <LockScreen visible={lock.locked && (lock.ready || !!lock.error)} error={lock.error} onUnlock={() => void lock.unlock()} />
      <AccountSheet
        themePref={themePref}
        biometricLock={lock.enabled}
        onBiometricLock={lock.toggle}
        visible={accountOpen && !lock.locked}
        onClose={() => setAccountOpen(false)}
        user={auth.user}
        creds={creds}
        onOpenTeam={() => {
          setAccountOpen(false);
          setRoute({ name: "fleet", focus: "team" });
        }}
        onSwitchMachine={(c) => {
          // another computer: start fresh on its board (or pair, if none is left)
          setAccountOpen(false);
          setCreds(c);
          setRoute(c ? { name: "board" } : { name: "pair" });
        }}
        onAddMachine={() => {
          setAccountOpen(false);
          setRoute({ name: "pair" });
        }}
        onSignedOut={() => {
          // back to the welcome, which is where signing out should land you
          setAccountOpen(false);
          setSkipped(false);
          void setAuthSkipped(false);
        }}
      />
    </SafeAreaView>
    </SafeAreaProvider>
  );
}
