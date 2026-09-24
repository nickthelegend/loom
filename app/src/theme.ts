/**
 * Loom mobile design tokens — the "quiet graphite" system adapted from the
 * Orca mobile companion app (github.com/stablyai/orca, MIT): near-black
 * surfaces, hairline borders, neutral-grey active states, and one near-white
 * primary action per screen. Color is reserved for state — thread cyan marks
 * live activity, shuttle magenta marks the baton. See docs/design-system.md.
 */

import { Platform } from "react-native";

/** Dark: the design these tokens were drawn for. */
const DARK = {
  // surfaces
  bg: "#111111", // canvas
  panel: "#1a1a1a", // cards, bars
  raised: "#242424", // inputs, keys, pressed
  editor: "#1e1e1e", // diff/code surface
  line: "#2a2a2a", // hairline borders
  line2: "#3a3a3a", // selected/stronger hairline
  // text
  text: "#e0e0e0",
  dim: "#888888",
  faint: "#555555",
  // the single loudest thing on any screen: near-white primary action
  bright: "#f5f5f5",
  onBright: "#111111",
  // violet — the accent for the Observatory + self-heal moments
  primary: "#a78bfa",
  primaryDim: "#2e2545",
  // state — the only places color is allowed
  thread: "#67e8f9",
  threadDim: "#164e63",
  shuttle: "#e879f9",
  ok: "#22c55e",
  warn: "#f59e0b",
  err: "#ef4444",
  accentBlue: "#3b82f6", // links/selection only
  // diffs (VS Code-grade washes)
  gitAdd: "#81b88b",
  gitDel: "#c74e39",
  diffAddBg: "rgba(129, 184, 139, 0.1)",
  diffDelBg: "rgba(199, 78, 57, 0.11)",
  mono: Platform.select({ ios: "Menlo", default: "monospace" }) as string,
  // legacy aliases kept so stray references don't churn
  ink2: "#1e1e1e",
  panel2: "#242424",
  accent: "#67e8f9",
  accentDark: "#111111",
  mag: "#e879f9",
};

/**
 * Light: the same roles, re-drawn for a white canvas — the loud primary
 * action flips to near-black, and every state colour steps down to a shade
 * that keeps its contrast on white.
 */
const LIGHT: typeof DARK = {
  bg: "#f7f7f5",
  panel: "#ffffff",
  raised: "#efefec",
  editor: "#f4f4f1",
  line: "#e3e3de",
  line2: "#d0d0ca",
  text: "#1b1b1a",
  dim: "#62625e",
  faint: "#9a9a94",
  bright: "#151515",
  onBright: "#fafafa",
  primary: "#6d28d9",
  primaryDim: "#ede9fe",
  thread: "#0e7490",
  threadDim: "#cffafe",
  shuttle: "#a21caf",
  ok: "#15803d",
  warn: "#b45309",
  err: "#dc2626",
  accentBlue: "#1d4ed8",
  gitAdd: "#2f7d3a",
  gitDel: "#b3261e",
  diffAddBg: "rgba(47, 125, 58, 0.1)",
  diffDelBg: "rgba(179, 38, 30, 0.09)",
  mono: DARK.mono,
  ink2: "#f4f4f1",
  panel2: "#efefec",
  accent: "#0e7490",
  accentDark: "#f7f7f5",
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
