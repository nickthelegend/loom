/**
 * Register this device for pushes: ask permission, fetch the Expo push
 * token, hand it to the daemon (attached to our paired-client record).
 * The daemon buzzes us on questions, approvals, finished turns, goal
 * outcomes and new releases — the kinds this phone switched on (PUSH_KINDS).
 */

import Constants from "expo-constants";
import * as Notifications from "expo-notifications";
import { AppState, Platform, Vibration } from "react-native";
import { api, kv, type Creds } from "./api";

/** What the daemon can push, each switchable from the account sheet (daemon push.ts PUSH_CATEGORIES). */
export const PUSH_KINDS = [
  { id: "questions", label: "Questions", hint: "An agent, goal or crew is waiting on your answer" },
  { id: "approvals", label: "Approvals", hint: "A tool call or a crew's plan needs Allow / Approve" },
  { id: "done", label: "Turns done", hint: "An agent finished replying in one of your chats" },
  { id: "goals", label: "Goals", hint: "An Orchestra run, race, crew or route finished or failed" },
  { id: "updates", label: "Loom updates", hint: "A new Loom release is out for your computer" },
] as const;
export type PushKind = (typeof PUSH_KINDS)[number]["id"];
const ALL: PushKind[] = PUSH_KINDS.map((k) => k.id);
const KINDS_KEY = "loom.pushKinds";

export async function loadPushKinds(): Promise<PushKind[]> {
  try {
    const v = JSON.parse((await kv.get(KINDS_KEY)) ?? "null") as unknown;
    if (Array.isArray(v)) return ALL.filter((k) => v.includes(k));
  } catch {
    /* never chosen */
  }
  return ALL;
}

/** Save which kinds this phone wants and tell the daemon (re-registers with the same token). */
export async function setPushKinds(creds: Creds, kinds: PushKind[]): Promise<PushState> {
  await kv.set(KINDS_KEY, JSON.stringify(kinds));
  return enablePush(creds);
}

/** A standalone (Play / App Store) build needs its EAS project id for a push token; Expo Go doesn't. */
function easProjectId(): string | undefined {
  const c = Constants as unknown as { expoConfig?: { extra?: { eas?: { projectId?: string } } }; easConfig?: { projectId?: string } };
  return c.expoConfig?.extra?.eas?.projectId ?? c.easConfig?.projectId ?? undefined;
}

// Native only — expo-notifications has no push on web (this is the browser demo).
if (Platform.OS !== "web") {
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowAlert: true,
      shouldPlaySound: true,
      shouldSetBadge: false,
    }),
  });
}

/** on: registered · denied: the phone's notification setting is off · unavailable: no push here (a simulator, web, a build without push set up). */
export type PushState = "on" | "denied" | "unavailable";

export async function enablePush(creds: Creds): Promise<PushState> {
  if (Platform.OS === "web") return "unavailable";
  try {
    if (Platform.OS === "android") {
      await Notifications.setNotificationChannelAsync("default", {
        name: "Loom",
        importance: Notifications.AndroidImportance.HIGH,
        vibrationPattern: [0, 200, 100, 200],
      });
    }
    const perm = await Notifications.requestPermissionsAsync();
    if (!perm.granted) return "denied";
    const projectId = easProjectId();
    const token = (await Notifications.getExpoPushTokenAsync(projectId ? { projectId } : undefined)).data;
    await api(creds, "/api/push/register", {
      method: "POST",
      body: JSON.stringify({ token, platform: Platform.OS, kinds: await loadPushKinds() }),
    });
    return "on";
  } catch {
    // Push is optional — the app works fully without it.
    return "unavailable";
  }
}

export async function disablePush(creds: Creds): Promise<void> {
  await api(creds, "/api/push/register", { method: "DELETE" }).catch(() => {});
}

/**
 * An agent is waiting on your approval. A buzz when the app is open (the card
 * is already on screen); a local notification when it isn't, so the same
 * permission the daemon's pushes use also covers this. Best-effort: silent
 * where notifications aren't granted, a no-op on web.
 */
export function notifyApproval(what: { agent: string; tool: string; project?: string }): void {
  if (Platform.OS === "web") return;
  try {
    Vibration.vibrate([0, 60, 80, 60]);
  } catch {
    // no vibrator — nothing to do
  }
  if (AppState.currentState === "active") return;
  void Notifications.scheduleNotificationAsync({
    content: {
      title: `${what.agent} wants to run ${what.tool}`,
      body: what.project ? `${what.project} · allow or deny in Loom` : "Allow or deny in Loom",
    },
    trigger: null,
  }).catch(() => {});
}

/**
 * Tapping a Loom push opens its project (and goal): `onOpen` gets the pushed
 * `data` — `{ projectId, kind, runId? }` from the daemon (see
 * team-runners-model notificationRoute). Covers both a tap while the app runs
 * (the response listener) and a tap that launched it (the last response, read
 * once). Each notification is handled once even if both report it. No-op on web.
 */
export function onNotificationOpen(onOpen: (data: unknown) => void): () => void {
  if (Platform.OS === "web") return () => {};
  const seen = new Set<string>();
  let live = true;
  const handle = (r: Notifications.NotificationResponse | null) => {
    if (!live || !r) return;
    if (r.actionIdentifier !== Notifications.DEFAULT_ACTION_IDENTIFIER) return; // a tap, not a dismiss or custom action
    const id = r.notification.request.identifier;
    if (seen.has(id)) return;
    seen.add(id);
    onOpen(r.notification.request.content.data);
  };
  let sub: { remove: () => void } | null = null;
  try {
    sub = Notifications.addNotificationResponseReceivedListener(handle);
  } catch {
    // no native module (Expo Go without notifications) — nothing to listen to
  }
  void Notifications.getLastNotificationResponseAsync()
    .then((r) => {
      handle(r);
      // so a later remount (or a re-pair) doesn't reopen the same alert
      if (r) void Notifications.clearLastNotificationResponseAsync?.().catch(() => {});
    })
    .catch(() => {});
  return () => {
    live = false;
    sub?.remove();
  };
}
