/** Loom's weave identity — same design language as the daemon-served web app. */
export const T = {
  // surfaces
  bg: "#0a0d13",
  ink2: "#0c1017",
  panel: "#111725",
  panel2: "#161d2c",
  line: "#1f2838",
  line2: "#2a3446",
  // text
  text: "#e6ecf6",
  dim: "#8a97ad",
  faint: "#57627a",
  // accents — thread (live/primary) + shuttle (baton)
  thread: "#67e8f9",
  threadDim: "#2b525e",
  shuttle: "#e879f9",
  // signals
  ok: "#4ade80",
  warn: "#fbbf24",
  err: "#fb7185",
  mono: "Menlo",
  // legacy aliases kept so existing components don't churn
  accent: "#67e8f9",
  accentDark: "#04141a",
  mag: "#e879f9",
} as const;

export function hue(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) % 360;
  return `hsl(${h}, 65%, 72%)`;
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
