/**
 * The free pool: a model agent that spreads its turns across every free model
 * a provider serves, instead of leaning on one.
 *
 * OpenRouter's free models are rate-limited per model (a burst on one gets a
 * 429 while the others are idle) and capped per account per day (50 requests
 * on a free-tier key, 1000 with credits, shared by every `:free` model). Those
 * are different failures with different answers:
 *
 * - one model rate-limited → rest it for a minute and take the next one;
 * - the daily cap spent → every free model will say the same thing, so stop at
 *   once and say when it resets, rather than walking the list to collect the
 *   same 429 nineteen times.
 *
 * An agent opts in with the model id `pool:free` (`openrouter/pool:free` in a
 * picker). Each turn takes the next model in a machine-wide rotation, so a
 * crew of model agents on the pool lands on different models at once.
 */

import fs from "node:fs";
import path from "node:path";

import { modelsUrl, requestHeaders, type ResolvedProvider } from "./providers.js";
import { loomHome } from "./registry.js";

export const FREE_POOL = "pool:free";

export const isPool = (model: string | undefined): boolean => model?.trim() === FREE_POOL;

/** Not chat models, whatever their price: music, safety classifiers, embeddings, speech. */
const NOT_CHAT = /lyria|content-safety|guard|embed|tts|whisper|moderation|image-preview|-image\b/i;

interface PoolModel {
  id: string;
  context: number;
  tools: boolean;
}

interface Listed {
  id?: string;
  context_length?: number;
  supported_parameters?: string[];
  pricing?: { prompt?: string; completion?: string };
  architecture?: { output_modalities?: string[] };
}

const cache = new Map<string, { at: number; models: PoolModel[] }>();
const LIST_TTL_MS = 30 * 60_000;

/** The provider's free chat models, best first (most context). */
export async function freeModels(p: ResolvedProvider, opts: { tools?: boolean; fetchImpl?: typeof fetch } = {}): Promise<PoolModel[]> {
  const hit = cache.get(p.id);
  let models = hit && Date.now() - hit.at < LIST_TTL_MS ? hit.models : null;
  if (!models) {
    const res = await (opts.fetchImpl ?? fetch)(modelsUrl(p), { headers: requestHeaders(p), signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`${p.label} didn't list its models (${res.status})`);
    const body = (await res.json()) as { data?: Listed[] };
    models = (body.data ?? [])
      .filter((m): m is Listed & { id: string } => typeof m.id === "string")
      .filter((m) => p.free(m.id) || (m.pricing?.prompt === "0" && m.pricing?.completion === "0"))
      .filter((m) => !NOT_CHAT.test(m.id) && m.id !== "openrouter/free")
      .filter((m) => !m.architecture?.output_modalities || m.architecture.output_modalities.includes("text"))
      .map((m) => ({ id: m.id, context: m.context_length ?? 0, tools: (m.supported_parameters ?? []).includes("tools") }))
      .sort((a, b) => b.context - a.context);
    cache.set(p.id, { at: Date.now(), models });
  }
  const shut = closed();
  return models.filter((m) => !shut.has(m.id) && (!opts.tools || m.tools));
}

// ---- models closed to Loom ---------------------------------------------------------

/**
 * A free model the provider won't serve to Loom at all — OpenRouter keeps some
 * "for agentic harnesses" on its own app list and answers 403. That's about the
 * model, not the key: skip it for a week, then look again.
 */
export function isClosedToUs(status: number, body: string): boolean {
  return (status === 403 || status === 404) && /only available (?:on|to|in)|not available (?:for|to|via)|restricted to/i.test(body);
}

const closedFile = (): string => path.join(loomHome(), "free-closed.json");
const WEEK = 7 * 24 * 3600_000;

function closed(): Set<string> {
  try {
    const all = JSON.parse(fs.readFileSync(closedFile(), "utf8")) as Record<string, number>;
    return new Set(Object.entries(all).filter(([, at]) => Date.now() - at < WEEK).map(([id]) => id));
  } catch {
    return new Set();
  }
}

export function closeModel(model: string): void {
  let all: Record<string, number> = {};
  try { all = JSON.parse(fs.readFileSync(closedFile(), "utf8")) as Record<string, number>; } catch { /* none yet */ }
  all[model] = Date.now();
  try {
    fs.mkdirSync(path.dirname(closedFile()), { recursive: true });
    fs.writeFileSync(closedFile(), JSON.stringify(all));
  } catch { /* best effort */ }
}

/** Free here: by the provider's naming rule, or by the zero price its list gave. */
export function isFreeModel(p: ResolvedProvider, model: string): boolean {
  return p.free(model) || Boolean(cache.get(p.id)?.models.some((m) => m.id === model));
}

// ---- rotation and rest -------------------------------------------------------

let cursor = 0;
const restingUntil = new Map<string, number>();

/** A model that just said 429: leave it alone for a while. */
export function rest(model: string, ms = 60_000): void {
  restingUntil.set(model, Date.now() + ms);
}

/**
 * The order to try this turn: the next model in the rotation first, then the
 * rest, with resting models at the back. `max` bounds a turn's attempts.
 */
export function rotation(models: PoolModel[], max = 4): string[] {
  if (!models.length) return [];
  const start = cursor++ % models.length;
  const ordered = [...models.slice(start), ...models.slice(0, start)].map((m) => m.id);
  const now = Date.now();
  const awake = ordered.filter((id) => (restingUntil.get(id) ?? 0) <= now);
  const resting = ordered.filter((id) => (restingUntil.get(id) ?? 0) > now);
  return [...awake, ...resting].slice(0, max);
}

// ---- the account's daily cap ---------------------------------------------------

/** OpenRouter's "you've used today's free requests" (not one model being busy). */
export function isDailyCap(status: number, body: string): boolean {
  return status === 429 && /free-models-per-day|per[- ]day|daily/i.test(body);
}

/** When the cap lifts, from X-RateLimit-Reset (epoch ms or s), if it said. */
export function resetAt(headers: Headers | undefined): number | null {
  const raw = headers?.get("x-ratelimit-reset");
  const n = raw ? Number(raw) : NaN;
  if (!Number.isFinite(n) || n <= 0) return null;
  return n < 1e12 ? n * 1000 : n;
}

export function dailyCapMessage(label: string, at: number | null): string {
  const when = at ? ` — it resets ${new Date(at).toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" })}` : "";
  return `${label}'s free requests for today are used up (every free model shares one daily cap)${when}. ` +
    "Credits on the account raise the cap; until then, a paid model or another agent can take the turn.";
}

// ---- how much of today's cap Loom has used ----------------------------------------

interface UsageFile {
  day: string;
  count: number;
  capped?: number;
}

const usageFile = (): string => path.join(loomHome(), "free-usage.json");
const today = (): string => new Date().toISOString().slice(0, 10);

function readUsage(): UsageFile {
  try {
    const u = JSON.parse(fs.readFileSync(usageFile(), "utf8")) as UsageFile;
    if (u.day === today()) return u;
  } catch {
    /* none yet */
  }
  return { day: today(), count: 0 };
}

function writeUsage(u: UsageFile): void {
  try {
    fs.mkdirSync(path.dirname(usageFile()), { recursive: true });
    fs.writeFileSync(usageFile(), JSON.stringify(u));
  } catch {
    /* a counter is not worth failing a turn over */
  }
}

/** One free request this machine made today (UTC day, as OpenRouter counts). */
export function countFreeRequest(): void {
  const u = readUsage();
  u.count++;
  writeUsage(u);
}

/** The cap was hit: remember when, so the picker can say so without asking. */
export function noteCapped(at: number | null): void {
  const u = readUsage();
  u.capped = at ?? Date.now() + 6 * 3600_000;
  writeUsage(u);
}

/** Today's free requests from this machine, and whether the cap is known to be hit. */
export function freeUsage(): { day: string; used: number; cappedUntil: number | null } {
  const u = readUsage();
  return { day: u.day, used: u.count, cappedUntil: u.capped && u.capped > Date.now() ? u.capped : null };
}

/** Tests. */
export function resetPool(): void {
  cache.clear();
  restingUntil.clear();
  cursor = 0;
}
