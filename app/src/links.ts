/**
 * Where the phone app points outward: the open-source repo (Loom itself runs
 * on your computer — the app is its remote), the desktop downloads, and the
 * store page to rate it on.
 */

import Constants from "expo-constants";
import { Linking, Platform } from "react-native";

export const REPO_URL = "https://github.com/nickthelegend/loom";
export const INSTALL_URL = `${REPO_URL}#install`;
export const DESKTOP_URL = `${REPO_URL}/releases/latest`;
export const PACKAGE = "dev.loom.app";
export const STORE_URL = `https://play.google.com/store/apps/details?id=${PACKAGE}`;

/** This app's own version, as the store knows it. */
export function appVersion(): string {
  return Constants.expoConfig?.version ?? "?";
}

export function open(url: string): void {
  void Linking.openURL(url).catch(() => {});
}

/** Rating lives on the Play Store page; the market:// link opens the Play app straight to it. */
export const canRate = Platform.OS === "android";
export function rateLoom(): void {
  void Linking.openURL(`market://details?id=${PACKAGE}&showAllReviews=true`).catch(() => open(STORE_URL));
}
