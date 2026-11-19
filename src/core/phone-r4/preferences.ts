import fs from "node:fs";
import path from "node:path";
import { ensureLoomHome, readDaemonConfig } from "../registry.js";

export type NotificationLevel = "all" | "needs-you" | "none";
export interface QuietHours { enabled: boolean; start: string; end: string; timeZone: string; allowApprovals: boolean; snoozeUntil: number }
export const defaultQuiet: QuietHours = { enabled: false, start: "22:00", end: "07:00", timeZone: "UTC", allowApprovals: true, snoozeUntil: 0 };
interface Preferences { quiet: QuietHours; chats: Record<string, NotificationLevel> }
const file = () => path.join(ensureLoomHome(), "phone-r4.json");
function read(): Record<string, Preferences> {
  try { return JSON.parse(fs.readFileSync(file(), "utf8")); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return {}; throw e; }
}
// Unscoped pairings belong to the same local owner as the admin console.
// Scoped clients retain isolated preferences; they cannot mute the owner's phone.
export function preferenceUser(device: string): string {
  const c = readDaemonConfig()?.clients?.find(c => c.id === device);
  return device === "owner" || device === "admin" || (c && !c.guest && !c.projects?.length) ? "owner" : device;
}
export function preferences(device: string): Preferences {
  const data = read(), user = preferenceUser(device);
  return data[user] ?? data[device] ?? (user === "owner" ? data.admin : undefined) ?? { quiet: { ...defaultQuiet }, chats: {} };
}
function save(device: string, value: Preferences): void {
  const data = { ...read(), [preferenceUser(device)]: value }, target = file();
  fs.writeFileSync(target + ".tmp", JSON.stringify(data), { mode: 0o600 });
  fs.renameSync(target + ".tmp", target);
}
export function validateQuiet(value: unknown): QuietHours {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("quiet hours must be an object");
  const q = value as QuietHours;
  if (typeof q.enabled !== "boolean" || typeof q.allowApprovals !== "boolean" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(q.start) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(q.end) || typeof q.timeZone !== "string" || !Number.isFinite(q.snoozeUntil) || q.snoozeUntil < 0) throw new Error("choose valid hours, timezone and snooze time");
  new Intl.DateTimeFormat("en", { timeZone: q.timeZone }).format();
  return { enabled: q.enabled, start: q.start, end: q.end, timeZone: q.timeZone, allowApprovals: q.allowApprovals, snoozeUntil: q.snoozeUntil };
}
export function setQuiet(device: string, value: unknown): QuietHours { const quiet = validateQuiet(value); save(device, { ...preferences(device), quiet }); return quiet; }
export const chatKey = (project: string, chat: string) => JSON.stringify([project, chat]);
export function setLevel(device: string, project: string, chat: string, level: unknown): NotificationLevel {
  if (level !== "all" && level !== "needs-you" && level !== "none") throw new Error("level is all, needs-you or none");
  const p = preferences(device); p.chats[chatKey(project, chat)] = level; save(device, p); return level;
}
export function quietNow(q: QuietHours, now = Date.now()): boolean {
  if (q.snoozeUntil > now) return true;
  if (!q.enabled || q.start === q.end) return false;
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: q.timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(now));
  return q.start < q.end ? parts >= q.start && parts < q.end : parts >= q.start || parts < q.end;
}
export function permitsPush(p: Preferences, category: string, project?: string, chat = "main", now = Date.now()): boolean {
  if (category === "approvals") return !quietNow(p.quiet, now) || p.quiet.allowApprovals;
  const level = project ? p.chats[chatKey(project, chat)] ?? "all" : "all";
  if (level === "none" || (level === "needs-you" && category !== "questions" && category !== "approvals")) return false;
  return !quietNow(p.quiet, now);
}
