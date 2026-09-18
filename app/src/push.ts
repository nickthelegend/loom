/**
 * Register this device for pushes: ask permission, fetch the Expo push
 * token, hand it to the daemon (attached to our paired-client record).
 * The daemon buzzes us on needs_input / route outcomes / finished turns.
 */

import * as Notifications from "expo-notifications";
import { AppState, Platform, Vibration } from "react-native";
import { api, type Creds } from "./api";

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

export async function enablePush(creds: Creds): Promise<boolean> {
  if (Platform.OS === "web") return false;
  try {
    if (Platform.OS === "android") {
      await Notifications.setNotificationChannelAsync("default", {
        name: "Loom",
        importance: Notifications.AndroidImportance.HIGH,
        vibrationPattern: [0, 200, 100, 200],
      });
    }
    const perm = await Notifications.requestPermissionsAsync();
    if (!perm.granted) return false;
    const token = (await Notifications.getExpoPushTokenAsync()).data;
    await api(creds, "/api/push/register", {
      method: "POST",
      body: JSON.stringify({ token, platform: Platform.OS }),
    });
    return true;
  } catch {
    // Push is optional — the app works fully without it.
    return false;
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
