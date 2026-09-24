/**
 * A light tap when you send, a success tick when a reply lands. Quiet where
 * the native module isn't there (web), and never allowed to throw into a send.
 */

import * as Haptics from "expo-haptics";
import { Platform } from "react-native";

const on = Platform.OS === "ios" || Platform.OS === "android";

export const haptic = {
  tap(): void {
    if (on) void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
  },
  success(): void {
    if (on) void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
  },
};
