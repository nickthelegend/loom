export const expiryPresets = [{ value: "1h", label: "1 hour" }, { value: "1d", label: "1 day" }, { value: "7d", label: "7 days" }] as const;
export function shareCountdown(expiresAt: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.ceil((expiresAt - now) / 1000));
  return seconds ? `${Math.floor(seconds / 86400)}d ${Math.floor(seconds % 86400 / 3600)}h ${Math.floor(seconds % 3600 / 60)}m ${seconds % 60}s left` : "Expired";
}
export function filterTeamActivity<T extends { type: string; github?: string | null; repo?: string; meta?: Record<string, unknown> }>(feed: T[], kind: string, query: string): T[] {
  const q = query.trim().toLowerCase();
  return feed.filter(e => (!kind || e.type === kind || (kind === "pr_merged" && e.type === "goal_landed")) &&
    (!q || `${e.github ?? ""} ${e.repo ?? ""} ${e.meta?.to ?? ""}`.toLowerCase().includes(q)));
}

export function isTeamMention(data: unknown): boolean {
  return Boolean(data && typeof data === "object" && (data as { screen?: unknown }).screen === "team" && (data as { kind?: unknown }).kind === "mention");
}

export function mentionQuery(text: string): string | null {
  return /(?:^|\s)@([a-z\d-]*)$/i.exec(text)?.[1]?.toLowerCase() ?? null;
}
export function insertMention(text: string, login: string): string {
  return text.replace(/@([a-z\d-]*)$/i, `@${login} `);
}
