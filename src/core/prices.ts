/**
 * What a token costs, by model — so an agent that reports tokens but no price
 * (Codex on a ChatGPT sign-in, Grok) still has a figure beside it, labelled
 * "est.": what those tokens would cost at the model's API price.
 *
 * The prices come from OpenRouter's public model list (no key needed), cached
 * in ~/.loom/prices.json for a day, rather than a table in this file that is
 * wrong by the next release. No list, or a model it doesn't carry, means no
 * estimate — never a guess.
 */

import fs from "node:fs";
import path from "node:path";
import { loomHome } from "./registry.js";

/** USD per token. */
export interface Price { in: number; out: number; cacheRead?: number }
export interface PriceBook { at: number; models: Record<string, Price> }

const LIST_URL = "https://openrouter.ai/api/v1/models";
export const PRICES_TTL_MS = 24 * 60 * 60_000;
const RETRY_MS = 10 * 60_000;

/**
 * One name for a model however a CLI or a catalog spells it: no provider
 * prefix, no :variant, no release date, dots as dashes ("openai/gpt-5.1" and
 * Codex's "gpt-5.1" meet; "anthropic/claude-opus-4.5" and "claude-opus-4-5-20251101" too).
 */
export function modelKey(model: string): string {
  return model.trim().toLowerCase().split("/").pop()!.replace(/:.*$/, "").replace(/\./g, "-").replace(/-(20\d{6}|\d{4}-\d{2}-\d{2})$/, "");
}

interface Listed { id?: string; pricing?: { prompt?: string; completion?: string; input_cache_read?: string } }

/** The book from a /models response. A free variant never hides the paid price of the same model. */
export function priceBookFrom(data: Listed[], at = Date.now()): PriceBook {
  const models: Record<string, Price> = {};
  for (const m of data) {
    if (typeof m.id !== "string" || !m.pricing) continue;
    const pin = Number(m.pricing.prompt), pout = Number(m.pricing.completion);
    if (!Number.isFinite(pin) || !Number.isFinite(pout) || pin < 0 || pout < 0) continue; // "-1" is "varies"
    const key = modelKey(m.id), had = models[key];
    if (had && had.in + had.out > 0 && pin + pout === 0) continue;
    const cache = Number(m.pricing.input_cache_read);
    models[key] = { in: pin, out: pout, ...(Number.isFinite(cache) && cache >= 0 && m.pricing.input_cache_read !== undefined ? { cacheRead: cache } : {}) };
  }
  return { at, models };
}

/** A turn's tokens at its model's price; undefined when the book doesn't know the model. */
export function estimateUsd(t: { model?: string; tokensIn: number; tokensOut: number; cachedIn?: number }, book: PriceBook | null): number | undefined {
  if (!book || !t.model) return undefined;
  const p = book.models[modelKey(t.model)];
  if (!p) return undefined;
  // tokensIn includes the cached part (codex, opencode report it that way)
  const cached = Math.min(t.cachedIn ?? 0, t.tokensIn);
  return (t.tokensIn - cached) * p.in + cached * (p.cacheRead ?? p.in) + t.tokensOut * p.out;
}

let book: PriceBook | null | undefined;
let lastTry = 0;
const file = () => path.join(loomHome(), "prices.json");

/** Refetch the list now. Resolves to the new book, or the old one if the fetch failed. */
export async function refreshPrices(fetchImpl: typeof fetch = fetch): Promise<PriceBook | null> {
  lastTry = Date.now();
  try {
    const res = await fetchImpl(LIST_URL, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) return book ?? null;
    const next = priceBookFrom(((await res.json()) as { data?: Listed[] }).data ?? []);
    if (!Object.keys(next.models).length) return book ?? null;
    book = next;
    try {
      fs.mkdirSync(path.dirname(file()), { recursive: true });
      fs.writeFileSync(file(), JSON.stringify(next));
    } catch { /* an unsaved book is still a book */ }
    return book;
  } catch {
    return book ?? null;
  }
}

/**
 * The prices Loom knows now, without waiting: from memory, else the saved
 * file. A missing or day-old book is refreshed in the background, so the next
 * read has it. LOOM_NO_PRICE_FETCH=1 keeps it offline (tests).
 */
export function priceBook(): PriceBook | null {
  if (book === undefined) {
    try { book = JSON.parse(fs.readFileSync(file(), "utf8")) as PriceBook; } catch { book = null; }
  }
  const stale = !book || Date.now() - book.at > PRICES_TTL_MS;
  if (stale && !process.env.LOOM_NO_PRICE_FETCH && Date.now() - lastTry > RETRY_MS) void refreshPrices();
  return book;
}

/** For tests: forget the book in memory, or set one. */
export function setPriceBook(next: PriceBook | null | undefined): void { book = next; lastTry = 0; }

/** Prompt caches go cold this long after the last turn (Anthropic's default TTL): after it, a resumed session is re-read at full price. */
export const CACHE_TTL_MS = 5 * 60_000;

/** Writing a prompt into the cache costs more than reading plain input (Anthropic: 1.25×). */
export const CACHE_WRITE = 1.25;

/**
 * What this agent really pays per input token, read off its own recent turns:
 * their reported cost spread over uncached input, cached input (a tenth) and
 * output (five times). A list price misses what the CLI actually bills —
 * long-context premiums, cache writes — and was 18× low on a cold Claude
 * session (#300). Null without priced turns to learn from.
 */
export function observedInputRate(turns: Array<{ costUsd: number; tokensIn: number; cachedIn: number; tokensOut: number }>): number | null {
  // turns that already were cold (most input uncached) say it best: what a cold re-read really cost, per token
  const cold = turns.filter((t) => t.costUsd > 0 && t.tokensIn >= 20_000 && Math.min(t.cachedIn, t.tokensIn) / t.tokensIn < 0.3);
  if (cold.length) {
    const c = cold.reduce((n, t) => n + t.costUsd, 0), tok = cold.reduce((n, t) => n + t.tokensIn, 0);
    return c / tok / CACHE_WRITE; // coldResume multiplies the write back in
  }
  let cost = 0, weight = 0;
  for (const t of turns) {
    if (!(t.costUsd > 0) || !(t.tokensIn > 0)) continue;
    const cached = Math.min(t.cachedIn, t.tokensIn);
    cost += t.costUsd;
    weight += (t.tokensIn - cached) + cached * 0.1 + t.tokensOut * 5;
  }
  return weight > 0 ? cost / weight : null;
}

/** What resuming a session of this size, this long after its last turn, would cost to re-read — when the cache has likely expired. */
export function coldResume(s: { tokens: number; ageMs: number; model?: string; rate?: number | null }, book: PriceBook | null): { cold: boolean; estUsd?: number } {
  const cold = s.ageMs > CACHE_TTL_MS;
  if (!cold) return { cold };
  // the whole context is written to the cache again: at the rate this agent is really billed, else the list price
  const listed = estimateUsd({ model: s.model ?? "", tokensIn: s.tokens, tokensOut: 0 }, book);
  const est = s.rate ? s.tokens * s.rate * CACHE_WRITE : listed !== undefined ? listed * CACHE_WRITE : undefined;
  return { cold, ...(est !== undefined ? { estUsd: est } : {}) };
}
