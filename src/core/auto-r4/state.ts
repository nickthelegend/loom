import fs from "node:fs";
import path from "node:path";
import { loomHome } from "../registry.js";

export interface FireOptions { kind: "scheduled" | "webhook" | "manual" | "automation"; body?: unknown; event?: string; delivery?: string; depth?: number }
export interface AutomationState {
  startedAt?: number;
  cursor?: number;
  held: Array<{ trigger: string; opts: FireOptions; at: number }>;
  watches: Record<string, { value?: string; checkedAt?: number }>;
  depth: Record<string, number>;
  origins: Record<string, string>;
  pending: Record<string, number>;
  transitions: Record<string, string>;
}
export interface QuietHours { start: number; end: number; days: number[]; range: string }
export interface AutomationControl { quiet?: QuietHours; paused?: boolean; resumeAt?: number }
export function readJson<T>(file: string, fallback: T): T {
  try { return JSON.parse(fs.readFileSync(file, "utf8")) as T; }
  catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; return fallback; }
}
export function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file + ".tmp", JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(file + ".tmp", file);
}
const stateFile = (dir: string) => path.join(dir, ".loom", "automation.json");
export const readAutomation = (dir: string): AutomationState => ({ depth: {}, ...readJson<Omit<AutomationState, "depth"> & { depth?: Record<string, number> }>(stateFile(dir), { startedAt: Date.now(), held: [], watches: {}, origins: {}, pending: {}, transitions: {} }) });
export function changeAutomation(dir: string, fn: (state: AutomationState) => void): void {
  const state = readAutomation(dir); fn(state); writeJson(stateFile(dir), state);
}
export function forgetQueuedAutomation(file: string | null, items: Array<{ automation?: string; chat: string }>): void {
  if (!file || !items.some(i => i.automation)) return;
  changeAutomation(path.dirname(path.dirname(file)), s => {
    for (const item of items) if (item.automation) { delete s.pending[item.automation]; delete s.pending[item.chat]; }
  });
}
const controlFile = () => path.join(loomHome(), "automation.json");
export function readControl(): AutomationControl {
  const control = readJson<AutomationControl>(controlFile(), {});
  if (control.paused && control.resumeAt && control.resumeAt <= Date.now()) {
    control.paused = false; delete control.resumeAt; writeJson(controlFile(), control);
  }
  return control;
}
export const writeControl = (value: AutomationControl) => writeJson(controlFile(), value);
export function parseQuiet(range: string, days = "sun-sat"): QuietHours {
  const m = /^(\d{2}):(\d{2})-(\d{2}):(\d{2})$/.exec(range);
  if (!m || Number(m[1]) > 23 || Number(m[3]) > 23 || Number(m[2]) > 59 || Number(m[4]) > 59) throw new Error("quiet hours must be HH:MM-HH:MM");
  const start = Number(m[1]) * 60 + Number(m[2]), end = Number(m[3]) * 60 + Number(m[4]);
  if (start === end) throw new Error("quiet hours need different start and end times");
  const names = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
  const selected = new Set<number>();
  for (const part of days.toLowerCase().split(",")) {
    const pieces = part.trim().split("-"); const a = names.indexOf(pieces[0]!), b = names.indexOf(pieces[1] ?? pieces[0]!);
    if (a < 0 || b < 0 || pieces.length > 2) throw new Error("days must look like mon-fri or sat,sun");
    for (let d = a; ; d = (d + 1) % 7) { selected.add(d); if (d === b) break; }
  }
  return { range, start, end, days: [...selected] };
}
export function automationHold(now = new Date(), control = readControl()): string | null {
  if (control.paused && (!control.resumeAt || now.getTime() < control.resumeAt)) return "automation paused";
  const q = control.quiet; if (!q) return null;
  const minute = now.getHours() * 60 + now.getMinutes();
  const overnight = q.start > q.end;
  const day = overnight && minute < q.end ? (now.getDay() + 6) % 7 : now.getDay();
  return q.days.includes(day) && (overnight ? minute >= q.start || minute < q.end : minute >= q.start && minute < q.end) ? "automation quiet hours" : null;
}
