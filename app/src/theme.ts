/** Same palette as the daemon-served web app — one visual language. */
export const T = {
  bg: "#0b0e14",
  panel: "#131826",
  line: "#1e2436",
  text: "#dbe2f0",
  dim: "#7c88a1",
  accent: "#67e8f9",
  accentDark: "#06121a",
  warn: "#fbbf24",
  err: "#f87171",
  ok: "#4ade80",
  mag: "#e879f9",
  mono: "Menlo",
} as const;

export function hue(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) % 360;
  return `hsl(${h}, 60%, 70%)`;
}

export function usd(n?: number): string {
  if (!n || n <= 0) return "";
  return n >= 0.01 ? `$${n.toFixed(2)}` : `$${n.toFixed(4)}`;
}
