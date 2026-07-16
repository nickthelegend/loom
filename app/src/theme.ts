/**
 * Loom mobile design tokens — the "quiet graphite" system adapted from the
 * Orca mobile companion app (github.com/stablyai/orca, MIT): near-black
 * surfaces, hairline borders, neutral-grey active states, and one near-white
 * primary action per screen. Color is reserved for state — thread cyan marks
 * live activity, shuttle magenta marks the baton. See docs/design-system.md.
 */

import { Platform } from "react-native";

export const T = {
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
} as const;

export const spacing = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24 } as const;

export const radii = { row: 6, key: 6, input: 6, card: 14, pill: 999 } as const;

export function hue(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) % 360;
  return `hsl(${h}, 60%, 70%)`;
}

/** A dimmer variant of an agent's thread color, for selvage edges. */
export function selvage(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) % 360;
  return `hsl(${h}, 50%, 52%)`;
}

export function usd(n?: number): string {
  if (!n || n <= 0) return "";
  return n >= 0.01 ? `$${n.toFixed(2)}` : `$${n.toFixed(4)}`;
}
