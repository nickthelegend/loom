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

export type TeamShareMode = "chat" | "changes" | "pass" | "review";
export function teamShareInput(mode: TeamShareMode, chat: string, fields: { login?: string; note?: string; preset: string; passcode?: string; notifyFirstOpen?: boolean }) {
  const login = fields.login?.trim().replace(/^@/, "");
  if ((mode === "pass" || mode === "review") && (!login || !/^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?$/i.test(login))) throw new Error("Enter a teammate's GitHub login");
  if (fields.passcode && (fields.passcode.length < 4 || fields.passcode.length > 128)) throw new Error("Passcode must have 4–128 characters");
  return { chat, preset: fields.preset, ...(fields.passcode ? { passcode: fields.passcode } : {}), notifyFirstOpen: Boolean(fields.notifyFirstOpen),
    ...(mode === "changes" ? { changes: true } : {}), ...(mode === "pass" || mode === "review" ? { [mode]: login, note: fields.note || "" } : {}) };
}
export function shareOpenLabel(link: { views?: number; lastOpenedAt?: number | null; passcodeProtected?: boolean }): string {
  return `${link.views ?? 0} views · ${link.lastOpenedAt ? new Date(link.lastOpenedAt).toLocaleString() : "Never opened"}${link.passcodeProtected ? " · Passcode" : ""}`;
}
export function teamLibraryLabel(entry: { name: string; source?: string }): string { return `${entry.name} · ${entry.source === "team" ? "Team" : "Personal"}`; }
export function annotationLabel(entry: { name: string; verdict?: string; messageId?: number }): string {
  return `${entry.name}${entry.verdict ? entry.verdict === "approve" ? " · Approved" : " · Changes requested" : ""}${entry.messageId ? ` · message #${entry.messageId}` : ""}`;
}

export function mentionShareUrl(text: unknown): string | null {
  if (typeof text !== "string") return null;
  for (const part of text.match(/https?:\/\/[^\s]+/g) || []) {
    try { const url = new URL(part); if (!url.username && !url.password && /^\/share\/[A-Za-z0-9_-]{20,64}$/.test(url.pathname)) return url.href; } catch { /* Not an openable web link. */ }
  }
  return null;
}
