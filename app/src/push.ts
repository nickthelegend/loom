/**
 * Register this device for pushes: ask permission, fetch the Expo push
 * token, hand it to the daemon (attached to our paired-client record).
 * The daemon buzzes us on needs_input / route outcomes / finished turns.
 */

import * as Notifications from "expo-notifications";
import { Platform } from "react-native";
import { api, type Creds } from "./api";

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

export async function enablePush(creds: Creds): Promise<boolean> {
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
