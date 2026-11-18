/** Device-local shell choices; keep parsing independent of native storage. */
export const ACCENTS = {
  cyan: ["#67e8f9", "#0e7490"], violet: ["#c4b5fd", "#6d28d9"], emerald: ["#6ee7b7", "#047857"],
  amber: ["#fcd34d", "#b45309"], rose: ["#fda4af", "#be123c"], blue: ["#93c5fd", "#1d4ed8"],
} as const;
export type Accent = keyof typeof ACCENTS;
export function accentOf(value: unknown): Accent {
  return typeof value === "string" && Object.hasOwn(ACCENTS, value) ? value as Accent : "cyan";
}
export interface ShellLocation { project: string; chat: string; tab: string }
export function parseLocation(raw: string | null): ShellLocation | null {
  try {
    const v = JSON.parse(raw ?? "null") as Partial<ShellLocation> | null;
    return v && typeof v.project === "string" && v.project && typeof v.chat === "string" && v.chat && typeof v.tab === "string"
      ? { project: v.project, chat: v.chat, tab: v.tab } : null;
  } catch { return null; }
}
export interface ChatSearchHit { project: string; projectName: string; chat: string; chatTitle: string; eventId: number; snippet: string }
