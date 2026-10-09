/**
 * Loom mobile design tokens — the desktop app's own palette (src/web/styles/
 * base.css), so the phone and the desktop read as one product. Adapted from the
 * "quiet graphite" system of the
 * Orca mobile companion app (github.com/stablyai/orca, MIT): near-black
 * surfaces, hairline borders, neutral-grey active states, and one near-white
 * primary action per screen. Color is reserved for state — thread cyan marks
 * live activity, shuttle magenta marks the baton. See docs/design-system.md.
 */

import { Platform } from "react-native";

/** Dark: the design these tokens were drawn for. */
const DARK = {
  // surfaces
  bg: "#0a0a0a", // canvas — the desktop app's background
  panel: "#171717", // cards, bars (desktop --card)
  raised: "#262626", // inputs, keys, pressed (desktop --muted)
  editor: "#141414", // diff/code surface (desktop --editor-surface)
  line: "#222222", // hairline borders (desktop --border, 7% white)
  line2: "#383838", // selected/stronger hairline
  // text
  text: "#fafafa",
  dim: "#a1a1a1",
  faint: "#737373",
  // the single loudest thing on any screen: near-white primary action
  bright: "#e5e5e5",
  onBright: "#171717",
  // violet — the accent for the Observatory + self-heal moments
  primary: "#a78bfa",
  primaryDim: "#2e2545",
  // state — the only places color is allowed
  thread: "#67e8f9",
  threadDim: "#164e63",
  shuttle: "#e879f9",
  ok: "#10b981",
  warn: "#eab308",
  err: "#ff6568",
  accentBlue: "#3b82f6", // links/selection only
  // diffs (VS Code-grade washes)
  gitAdd: "#81b88b",
  gitDel: "#c74e39",
  diffAddBg: "rgba(129, 184, 139, 0.1)",
  diffDelBg: "rgba(199, 78, 57, 0.11)",
  mono: Platform.select({ ios: "Menlo", default: "monospace" }) as string,
  // legacy aliases kept so stray references don't churn
  ink2: "#141414",
  panel2: "#262626",
  accent: "#67e8f9",
  accentDark: "#0a0a0a",
  mag: "#e879f9",
};

/**
 * Light: the same roles, re-drawn for a white canvas — the loud primary
 * action flips to near-black, and every state colour steps down to a shade
 * that keeps its contrast on white.
 */
const LIGHT: typeof DARK = {
  bg: "#fafafa",
  panel: "#ffffff",
  raised: "#f5f5f5",
  editor: "#ffffff",
  line: "#e5e5e5",
  line2: "#d4d4d4",
  text: "#0a0a0a",
  dim: "#737373",
  faint: "#a3a3a3",
  bright: "#171717",
  onBright: "#fafafa",
  primary: "#6d28d9",
  primaryDim: "#ede9fe",
  thread: "#0e7490",
  threadDim: "#cffafe",
  shuttle: "#a21caf",
  ok: "#15803d",
  warn: "#b45309",
  err: "#e40014",
  accentBlue: "#1d4ed8",
  gitAdd: "#2f7d3a",
  gitDel: "#b3261e",
  diffAddBg: "rgba(47, 125, 58, 0.1)",
  diffDelBg: "rgba(179, 38, 30, 0.09)",
  mono: DARK.mono,
  ink2: "#ffffff",
  panel2: "#f5f5f5",
  accent: "#0e7490",
  accentDark: "#fafafa",
  mag: "#a21caf",
};

/**
 * The tokens every screen reads. Mutable on purpose: setScheme swaps the
 * palette in place and the app remounts its tree, so the hundreds of inline
 * styles that read T.x pick the new values up without each one subscribing.
 */
export const T: typeof DARK = { ...DARK };
export let scheme: "dark" | "light" = "dark";
const schemeListeners: Array<() => void> = [];
/** For style objects built once at module level: re-fill them on a switch. */
export function onScheme(fn: () => void): void {
  schemeListeners.push(fn);
  fn();
}
/** What you picked, as on the desktop: dark (the default), light, or follow the phone. */
export type ThemePref = "dark" | "light" | "system";
export const THEME_KEY = "loom.theme";
const prefListeners: Array<(p: ThemePref) => void> = [];
export function onThemePref(fn: (p: ThemePref) => void): () => void {
  prefListeners.push(fn);
  return () => void prefListeners.splice(prefListeners.indexOf(fn) >>> 0, 1);
}
/** Announce a new preference; App persists it and re-themes. */
export function pickTheme(p: ThemePref): void {
  for (const fn of [...prefListeners]) fn(p);
}

export function setScheme(next: "dark" | "light"): boolean {
  if (next === scheme) return false;
  Object.assign(T, next === "light" ? LIGHT : DARK);
  scheme = next;
  for (const fn of schemeListeners) fn();
  return true;
}

export const spacing = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24 } as const;

export const radii = { row: 6, key: 6, input: 6, card: 14, pill: 999 } as const;

export function hue(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) % 360;
  return `hsl(${h}, 60%, ${scheme === "light" ? 36 : 70}%)`;
}

/** A dimmer variant of an agent's thread color, for selvage edges. */
export function selvage(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) % 360;
  return `hsl(${h}, 50%, ${scheme === "light" ? 45 : 52}%)`;
}

export function usd(n?: number): string {
  if (!n || n <= 0) return "";
  return n >= 0.01 ? `$${n.toFixed(2)}` : `$${n.toFixed(4)}`;
}
