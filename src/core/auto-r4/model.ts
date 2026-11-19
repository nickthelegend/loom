import { execFile, exec } from "node:child_process";
import { promisify } from "node:util";
import { nextCron, parseCron } from "../triggers.js";
import { fileSnapshot } from "./watch.js";

export type AutomationKind = "file" | "event" | "branch" | "url";
export interface AutomationFields {
  onChange?: string;
  on?: string;
  onCommit?: string;
  watchUrl?: string;
  select?: string;
  when?: string;
  condition?: string;
  recipe?: string;
  orchestrate?: boolean;
  route?: string;
  failureLimit?: number;
  failures?: number;
}
export const triggerEvents = ["turn_failed", "pr_merged", "ci_failed", "run_completed", "approval_expired"];
export const outgoingEvents = [...triggerEvents, "turn_finished", "needs_you", "pr_opened"];
export const git = async (dir: string, ...args: string[]) => (await promisify(execFile)("git", args, { cwd: dir, timeout: 10_000, maxBuffer: 2_000_000 })).stdout.trim();

/** Deliberately a small, predictable language; ambiguous dates are refused. */
export function schedulePreview(when: string, from = new Date()): { cron: string; next: number[] } {
  const s = when.trim().toLowerCase();
  const m = /^every (day|weekday|weekend|sunday|monday|tuesday|wednesday|thursday|friday|saturday) at (\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/.exec(s);
  let cron: string;
  if (s === "every hour" || s === "hourly") cron = "0 * * * *";
  else if (m) {
    let hour = Number(m[2]); const minute = Number(m[3] ?? 0);
    if (minute > 59 || (m[4] ? hour < 1 || hour > 12 : hour > 23)) throw new Error("invalid schedule time");
    if (m[4]) hour = hour % 12 + (m[4] === "pm" ? 12 : 0);
    const days: Record<string, string> = { day: "*", weekday: "1-5", weekend: "0,6", sunday: "0", monday: "1", tuesday: "2", wednesday: "3", thursday: "4", friday: "5", saturday: "6" };
    cron = `${minute} ${hour} * * ${days[m[1]!]}`;
  } else throw new Error('try "every weekday at 9am", "every day at 18:30", or "every hour"');
  const next: number[] = []; let date = from;
  for (let i = 0; i < 5; i++) { date = nextCron(parseCron(cron), date)!; next.push(date.getTime()); }
  return { cron, next };
}

export function validateCondition(raw: string): string {
  if (["clean", "dirty"].includes(raw) || /^(file|cmd):\S[\s\S]*$/.test(raw)) return raw;
  const m = /^hours:(\d{1,2})-(\d{1,2})$/.exec(raw);
  if (m && Number(m[1]) < 24 && Number(m[2]) <= 24 && m[1] !== m[2]) return raw;
  throw new Error('condition must be clean, dirty, file:<glob>, hours:9-18, or cmd:<command>');
}

export async function conditionReason(dir: string, raw?: string, now = new Date()): Promise<string | null> {
  if (!raw) return null;
  validateCondition(raw);
  let holds = false;
  if (raw === "clean" || raw === "dirty") {
    const dirty = Boolean(await git(dir, "status", "--porcelain", "--untracked-files=normal", "--", ".", ":(exclude).loom"));
    holds = raw === "dirty" ? dirty : !dirty;
  } else if (raw.startsWith("hours:")) {
    const [start, end] = raw.slice(6).split("-").map(Number) as [number, number];
    holds = start < end ? now.getHours() >= start && now.getHours() < end : now.getHours() >= start || now.getHours() < end;
  } else if (raw.startsWith("file:")) {
    holds = fileSnapshot(dir, raw.slice(5)).size > 0;
  } else {
    let command = raw.slice(4);
    if (command.startsWith('"') && command.endsWith('"')) command = command.slice(1, -1);
    try { await promisify(exec)(command, { cwd: dir, timeout: 10_000, maxBuffer: 64_000 }); holds = true; } catch { holds = false; }
  }
  return holds ? null : `skipped: condition ${raw} did not qualify`;
}

export function renderAutomation(prompt: string, body: unknown): string {
  return prompt.replace(/\{\{\s*(files|commits|range|old|new|event(?:\.[\w.-]+)?)\s*\}\}/g, (match, key: string) => {
    if (key === "event") return match;
    const value = key.split(".").reduce<unknown>((v, k) => v && typeof v === "object" && Object.hasOwn(v, k) ? (v as Record<string, unknown>)[k] : undefined, body);
    return value === undefined ? "" : typeof value === "string" ? value : JSON.stringify(value);
  });
}
