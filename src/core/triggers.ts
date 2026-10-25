/**
 * Triggers: a schedule or a webhook starts an agent's next turn on its own — nobody sitting in
 * the chat. Each project keeps its own in .loom/triggers.json (0600: webhook secrets live there).
 *
 * Approach credit: Nuphos (github.com/nuphos/nuphos, Apache-2.0, © Zeabur Inc.) — "a schedule or
 * webhook starts your agent's next turn". Loom's version runs in the local daemon: no hosted
 * backend, the turn goes through the project's prompt queue like any other.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export interface Trigger {
  id: string;
  name: string;
  kind: "schedule" | "webhook";
  /** schedule: 5-field cron (minute hour day-of-month month day-of-week), local time. */
  cron?: string;
  /** schedule: or a plain interval, in minutes. */
  everyMin?: number;
  /** The prompt. A webhook's can use {{body}} (the JSON payload) and {{body.some.path}}. */
  prompt: string;
  /** Who answers; default: whoever the project routes to. */
  agent?: string;
  /** The thread its turns land in (made on first fire). */
  chat?: string;
  /** webhook: the shared secret (HMAC-SHA256 of the body, or sent as-is in a header). */
  secret?: string;
  /** webhook: ignore deliveries closer together than this (a flood guard; answered 200 so senders don't retry). */
  minIntervalSec?: number;
  enabled: boolean;
  createdAt: number;
  lastFiredAt?: number;
}

export interface TriggerRun {
  trigger: string;
  at: number;
  ok: boolean;
  /** "queued", or why it didn't: "skipped: still running", an error. */
  note: string;
}

interface TriggerFile {
  triggers: Trigger[];
  runs: TriggerRun[];
}

const MAX_RUNS = 200;
const file = (dir: string) => path.join(dir, ".loom", "triggers.json");

export function readTriggers(dir: string): TriggerFile {
  try {
    const raw = JSON.parse(fs.readFileSync(file(dir), "utf8")) as Partial<TriggerFile>;
    return { triggers: Array.isArray(raw.triggers) ? raw.triggers : [], runs: Array.isArray(raw.runs) ? raw.runs : [] };
  } catch {
    return { triggers: [], runs: [] };
  }
}

export function writeTriggers(dir: string, data: TriggerFile): void {
  fs.mkdirSync(path.dirname(file(dir)), { recursive: true });
  const tmp = `${file(dir)}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ triggers: data.triggers, runs: data.runs.slice(-MAX_RUNS) }, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(tmp, file(dir));
}

export function newTriggerId(): string {
  return `trg_${crypto.randomBytes(5).toString("hex")}`;
}

export function newSecret(): string {
  return crypto.randomBytes(24).toString("base64url");
}

/** What a trigger looks like to a client: the secret never leaves the daemon after it's made. */
export function publicTrigger(t: Trigger): Omit<Trigger, "secret"> & { hasSecret: boolean } {
  const { secret, ...rest } = t;
  return { ...rest, hasSecret: Boolean(secret) };
}

// ---------------------------------------------------------------------------
// Schedules
// ---------------------------------------------------------------------------

const RANGES: Array<[number, number]> = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 6]];
const NAMES: Record<string, string> = {
  "@hourly": "0 * * * *", "@daily": "0 0 * * *", "@midnight": "0 0 * * *", "@weekly": "0 0 * * 0", "@monthly": "0 0 1 * *",
  "@weekdays": "0 9 * * 1-5",
};

/** Parse one cron field into the set of values it allows; throws with the field in the message. */
function field(spec: string, [lo, hi]: [number, number], name: string): Set<number> {
  const out = new Set<number>();
  for (const part of spec.split(",")) {
    const m = /^(\*|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/.exec(part.trim());
    if (!m) throw new Error(`can't read "${part}" in the ${name} field`);
    const step = m[4] ? Number(m[4]) : 1;
    const from = m[1] === "*" ? lo : Number(m[2]);
    const to = m[1] === "*" ? hi : m[3] !== undefined ? Number(m[3]) : m[4] ? hi : from;
    if (step < 1 || from < lo || to > hi || from > to) throw new Error(`"${part}" is out of range for the ${name} field (${lo}-${hi})`);
    for (let v = from; v <= to; v += step) out.add(name === "day-of-week" && v === 7 ? 0 : v);
  }
  return out;
}

export interface Cron { fields: Set<number>[]; domAny: boolean; dowAny: boolean }

export function parseCron(spec: string): Cron {
  const expanded = NAMES[spec.trim()] ?? spec.trim();
  const parts = expanded.split(/\s+/);
  if (parts.length !== 5) throw new Error(`a schedule has 5 fields (minute hour day month weekday) — got "${spec}"`);
  const names = ["minute", "hour", "day-of-month", "month", "day-of-week"];
  // 7 is Sunday too
  const ranges = RANGES.map((r, i) => (i === 4 ? [0, 7] as [number, number] : r));
  return { fields: parts.map((p, i) => field(p, ranges[i]!, names[i]!)), domAny: parts[2] === "*", dowAny: parts[4] === "*" };
}

/** Does the cron allow this minute? Day-of-month and day-of-week are OR'd when both are set, as in cron. */
export function cronMatches(c: Cron, d: Date): boolean {
  const [min, hour, dom, mon, dow] = c.fields as [Set<number>, Set<number>, Set<number>, Set<number>, Set<number>];
  if (!min.has(d.getMinutes()) || !hour.has(d.getHours()) || !mon.has(d.getMonth() + 1)) return false;
  const domOk = dom.has(d.getDate()), dowOk = dow.has(d.getDay());
  if (c.domAny && c.dowAny) return true;
  if (c.domAny) return dowOk;
  if (c.dowAny) return domOk;
  return domOk || dowOk;
}

/** The next minute the cron allows after `from` (searching up to a year ahead). */
export function nextCron(c: Cron, from: Date): Date | null {
  const d = new Date(from.getTime());
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() + 1);
  for (let i = 0; i < 366 * 24 * 60; i++) {
    if (cronMatches(c, d)) return d;
    d.setMinutes(d.getMinutes() + 1);
  }
  return null;
}

/** Is this schedule due now? At most once per minute (cron) or per interval. */
export function isDue(t: Trigger, now: Date): boolean {
  if (!t.enabled || t.kind !== "schedule") return false;
  const last = t.lastFiredAt ?? 0;
  if (t.everyMin) return now.getTime() - (t.lastFiredAt ?? t.createdAt) >= t.everyMin * 60_000;
  if (!t.cron) return false;
  let c: Cron;
  try { c = parseCron(t.cron); } catch { return false; }
  const minute = Math.floor(now.getTime() / 60_000);
  return cronMatches(c, now) && Math.floor(last / 60_000) !== minute;
}

/** When it fires next, for showing. */
export function nextFire(t: Trigger, now = new Date()): number | null {
  if (t.kind !== "schedule" || !t.enabled) return null;
  if (t.everyMin) return (t.lastFiredAt ?? t.createdAt) + t.everyMin * 60_000;
  try { return nextCron(parseCron(t.cron ?? ""), now)?.getTime() ?? null; } catch { return null; }
}

/** "30m", "2h", "1d" → minutes. */
export function parseEvery(s: string): number {
  const m = /^(\d+)\s*(m|min|h|d)?$/i.exec(s.trim());
  if (!m) throw new Error(`"${s}" isn't an interval — try 15m, 2h or 1d`);
  const n = Number(m[1]) * ({ h: 60, d: 1440 }[(m[2] ?? "m").toLowerCase()] ?? 1);
  if (n < 1) throw new Error("the shortest interval is 1 minute");
  return n;
}

// ---------------------------------------------------------------------------
// Webhooks
// ---------------------------------------------------------------------------

/**
 * Is this delivery from someone who holds the secret? Accepts GitHub's X-Hub-Signature-256
 * (sha256=<hex HMAC of the raw body>), the same as X-Loom-Signature, or the secret itself in
 * X-Loom-Secret / ?token= for senders that can't sign. Constant-time throughout.
 */
export function verifyDelivery(secret: string, raw: Buffer, headers: Record<string, string | string[] | undefined>, token?: string): boolean {
  const eq = (a: string, b: string) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
  const sig = String(headers["x-hub-signature-256"] ?? headers["x-loom-signature"] ?? "");
  if (sig) {
    const want = "sha256=" + crypto.createHmac("sha256", secret).update(raw).digest("hex");
    return eq(sig.toLowerCase(), want);
  }
  const plain = String(headers["x-loom-secret"] ?? token ?? "");
  return plain ? eq(plain, secret) : false;
}

/**
 * {{body}} / {{payload}} → the payload as JSON (trimmed); {{body.a.b}} → that value; {{event}} → the
 * X-*-Event header; {{trigger.name}}, {{trigger.firedAt}}.
 */
export function renderPrompt(prompt: string, body: unknown, event = "", trigger?: { name: string; firedAt: number }): string {
  const get = (p: string) => p.split(".").reduce<unknown>((v, k) => (v && typeof v === "object" ? (v as Record<string, unknown>)[k] : undefined), body);
  const show = (v: unknown) => (v === undefined ? "" : typeof v === "string" ? v : JSON.stringify(v, null, 2));
  return prompt
    .replace(/\{\{\s*event\s*\}\}/g, event)
    .replace(/\{\{\s*trigger\.name\s*\}\}/g, trigger?.name ?? "")
    .replace(/\{\{\s*trigger\.firedAt\s*\}\}/g, trigger ? new Date(trigger.firedAt).toISOString() : "")
    .replace(/\{\{\s*(?:body|payload)\.([\w.-]+)\s*\}\}/g, (_m, p: string) => show(get(p)))
    .replace(/\{\{\s*(?:body|payload)\s*\}\}/g, () => show(body).slice(0, 20_000));
}
