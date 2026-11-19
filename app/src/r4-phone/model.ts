export const DEFAULT_REPLIES = ["Continue", "Run the tests", "Explain that"];
export interface PhonePreferences { replies: string[]; textScale: number; highContrast: boolean; briefTime: string | null }
export const defaults: PhonePreferences = { replies: DEFAULT_REPLIES, textScale: 1, highContrast: false, briefTime: null };
export function parsePreferences(raw: string | null): PhonePreferences {
  try {
    const p = JSON.parse(raw ?? "{}");
    return { replies: Array.isArray(p.replies) && p.replies.every((r: unknown) => typeof r === "string" && r.length <= 200) ? p.replies.slice(0, 12) : DEFAULT_REPLIES,
      textScale: [0.85, 1, 1.15, 1.3, 1.5].includes(p.textScale) ? p.textScale : 1, highContrast: p.highContrast === true,
      briefTime: typeof p.briefTime === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(p.briefTime) ? p.briefTime : null };
  } catch { return { ...defaults }; }
}
export function yesterday(now = new Date()) { const end = new Date(now); end.setHours(0, 0, 0, 0); const start = new Date(end); start.setDate(start.getDate() - 1); return { start: +start, end: +end }; }
export function morning(now = new Date(), hour = 7) { const next = new Date(now); next.setHours(hour, 0, 0, 0); if (+next <= +now) next.setDate(next.getDate() + 1); return +next; }
export function moveReply(replies: string[], index: number, direction: number) { const out = [...replies], to = index + direction; if (to >= 0 && to < out.length) [out[index], out[to]] = [out[to]!, out[index]!]; return out; }
export interface ReplyAction { id: string; data: Record<string, unknown>; text: string }
export function notificationReply(action: ReplyAction, clientId: string) {
  if (action.data.clientId !== clientId || typeof action.data.projectId !== "string" || !action.text.trim() || !["run_complete", "needs_input"].includes(String(action.data.kind))) return null;
  return { id: `notification-${action.id}`, project: action.data.projectId, chat: typeof action.data.chat === "string" ? action.data.chat : "main", text: action.text.trim().slice(0, 100000) };
}
export async function acrossMachines<M, T>(machines: M[], load: (m: M) => Promise<T>) {
  return Promise.all(machines.map(async machine => { try { return { machine, data: await load(machine), error: null }; } catch (e) { return { machine, data: null, error: String(e) }; } }));
}

export const wideLayout = (width: number) => width >= 840;
export function scaledText(style: { fontSize?: number; lineHeight?: number }, scale: number) { return { fontSize: (style.fontSize ?? 14) * scale, ...(style.lineHeight ? { lineHeight: style.lineHeight * scale } : {}) }; }

export const swipeOpensActions = (dx: number, dy: number, threshold = 48) => Math.abs(dx) > threshold && Math.abs(dx) > Math.abs(dy) * 1.5;
export function readChange(seen: Record<string, number>, chat: { id: string; lastReplyId?: number }, read: boolean) { return { ...seen, [chat.id]: read ? chat.lastReplyId ?? 0 : -1 }; }

export function textScaleStyle(style: { fontSize?: number; lineHeight?: number }, scale: number, nested: boolean) {
  return nested && style.fontSize === undefined ? {} : scaledText(style, scale);
}
export function localQuiet<T extends { enabled: boolean; timeZone: string; snoozeUntil: number }>(quiet: T, timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone): T {
  return !quiet.enabled && quiet.timeZone === "UTC" && quiet.snoozeUntil === 0 ? { ...quiet, timeZone } : quiet;
}
/** Prefer a registered identity, then a unique daemon name. Only taps may use a sole pairing. */
export function notificationMachine<M extends { name: string }>(identities: Array<{ m: M; id: string | null }>, data: { clientId?: unknown; daemon?: unknown }, singleFallback = false): M | undefined {
  const exact = data.clientId ? identities.filter(x => x.id === data.clientId) : [];
  if (exact.length) return exact.length === 1 ? exact[0]!.m : undefined;
  const named = identities.filter(x => typeof data.daemon === "string" && x.m.name.toLowerCase() === data.daemon.toLowerCase());
  return named.length === 1 ? named[0]!.m : singleFallback && identities.length === 1 ? identities[0]!.m : undefined;
}
export const rotateReply = <T,>(pending: T[]) => pending.length ? [...pending.slice(1), pending[0]!] : pending;
