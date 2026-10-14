/**
 * Where the phone app points outward: loompad.tech (install, downloads,
 * privacy), the open-source repo (Loom itself runs on your computer — the app
 * is its remote), and the store page to rate it on.
 */

import Constants from "expo-constants";
import { Linking, Platform } from "react-native";

export const SITE_URL = "https://loompad.tech";
export const REPO_URL = "https://github.com/nickthelegend/loom";
/** The site's Download section: the newest desktop apps and the install command. */
export const INSTALL_URL = `${SITE_URL}/#download`;
/** Always the newest release's file for that platform (the site resolves it). */
export const DESKTOP_URL = `${SITE_URL}/#download`;
export const PRIVACY_URL = `${SITE_URL}/privacy`;
export const PACKAGE = "tech.loompad.app";
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
