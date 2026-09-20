/**
 * Where a model agent's turns actually go, and where its key lives.
 *
 * Loom's agents have always been CLIs, which bring their own auth. A model
 * agent (adapters/model.ts) doesn't: it needs a base URL, a key, and whatever
 * headers that particular service insists on. This is the one place that
 * knows those things.
 *
 * ## Keys are not project config
 *
 * `.loom/config.json` is committed in most projects. A key in it is a key in
 * the repository, and then in the fork, and then in the search index. So the
 * project config names a PROVIDER — `"provider": "openrouter"` — and the key
 * lives either in the environment or in `~/.loom/providers.json`, mode 0600,
 * beside the daemon token that already lives there under the same rule.
 *
 * Nothing here returns a key to an HTTP client, logs one, or prints one. What
 * a person sees is whether a provider is configured and the last four
 * characters, which is enough to tell two keys apart and not enough to use
 * one.
 *
 * ## Providers differ in ways that matter
 *
 * They all speak `/v1/chat/completions`, and then each has a quirk: OpenRouter
 * wants attribution headers, AgentRouter refuses clients it doesn't recognise,
 * a local Ollama wants no key at all. Those live in the table rather than in
 * the adapter, so adding a provider is data.
 */

import fs from "node:fs";
import path from "node:path";

import { loomHome } from "./registry.js";

export interface ProviderSpec {
  id: string;
  label: string;
  /** Base URL with no trailing slash and no `/v1` — the paths add it. */
  baseUrl: string;
  /** Environment variables checked, in order, before the store. */
  envKeys: string[];
  /** Headers this provider needs beyond authorisation. */
  headers?: Record<string, string>;
  /** Does this model cost nothing here? A convention, where one exists. */
  free?: (modelId: string) => boolean;
  /** Said out loud by `loom providers`, when there's something to know. */
  note?: string;
  docs?: string;
}

/**
 * The ones Loom knows by name. Anything else is a custom provider: give it a
 * base URL and it works, because the protocol is the protocol.
 */
export const BUILTIN_PROVIDERS: ProviderSpec[] = [
  {
    id: "openrouter",
    label: "OpenRouter",
    baseUrl: "https://openrouter.ai/api",
    envKeys: ["OPENROUTER_API_KEY"],
    // OpenRouter asks callers to identify the app; it's used for their
    // leaderboards and rate limits, and it's ours to give honestly.
    headers: {
      "HTTP-Referer": "https://github.com/nickthelegend/loom",
      "X-Title": "Loom",
    },
    // Their own convention: a free model's id ends in `:free`.
    free: (id) => id.endsWith(":free"),
    docs: "https://openrouter.ai/docs",
  },
  {
    id: "agentrouter",
    label: "AgentRouter",
    baseUrl: "https://agentrouter.org",
    envKeys: ["AGENTROUTER_API_KEY"],
    // Everything AgentRouter serves is free quota, which is the whole point
    // of the service.
    free: () => true,
    note: "refuses clients it doesn't recognise (401 unauthorized_client_error) — ask them to allow-list Loom, or set a user-agent they accept with `loom providers:set agentrouter --header`",
    docs: "https://agentrouter.org/docs/",
  },
  {
    id: "openai",
    label: "OpenAI",
    baseUrl: "https://api.openai.com",
    envKeys: ["OPENAI_API_KEY"],
    docs: "https://platform.openai.com/docs/api-reference",
  },
  {
    id: "groq",
    label: "Groq",
    baseUrl: "https://api.groq.com/openai",
    envKeys: ["GROQ_API_KEY"],
    docs: "https://console.groq.com/docs",
  },
  {
    id: "ollama",
    label: "Ollama (local)",
    baseUrl: "http://127.0.0.1:11434",
    envKeys: ["OLLAMA_API_KEY"],
    // A local server wants no key, and demanding one would be theatre.
    free: () => true,
    note: "local — no key needed",
    docs: "https://github.com/ollama/ollama/blob/main/docs/api.md",
  },
];

/** What's been configured on this machine, by provider id. */
export interface StoredProvider {
  key?: string;
  /** Overrides the built-in base URL, or defines one for a custom provider. */
  baseUrl?: string;
  label?: string;
  /** Extra headers — how a person answers a provider that wants something odd. */
  headers?: Record<string, string>;
}

type Store = Record<string, StoredProvider>;

export function providersFile(): string {
  return path.join(loomHome(), "providers.json");
}

function readStore(): Store {
  try {
    return JSON.parse(fs.readFileSync(providersFile(), "utf8")) as Store;
  } catch {
    return {};
  }
}

function writeStore(store: Store): void {
  const file = providersFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // 0600 before anything is in it: the window between create and chmod is
  // exactly when a key would be world-readable.
  fs.writeFileSync(file, JSON.stringify(store, null, 2), { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}

export interface ResolvedProvider {
  id: string;
  label: string;
  baseUrl: string;
  /** Null when nothing has been configured — callers decide if that's fatal. */
  key: string | null;
  headers: Record<string, string>;
  free: (modelId: string) => boolean;
  note?: string;
  docs?: string;
}

/** The spec for an id, built-in or stored, or null if nobody has heard of it. */
export function specFor(id: string): ProviderSpec | null {
  const builtin = BUILTIN_PROVIDERS.find((p) => p.id === id);
  if (builtin) return builtin;
  const stored = readStore()[id];
  if (!stored?.baseUrl) return null;
  return {
    id,
    label: stored.label ?? id,
    baseUrl: stored.baseUrl.replace(/\/+$/, ""),
    envKeys: [`${id.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_API_KEY`],
  };
}

/**
 * Everything needed to make a call: URL, key, headers.
 *
 * The environment wins over the stored file, so a shell that sets a key for
 * one run doesn't have to undo anything afterwards.
 */
export function resolveProvider(id: string, env: NodeJS.ProcessEnv = process.env): ResolvedProvider | null {
  const spec = specFor(id);
  if (!spec) return null;
  const stored = readStore()[id] ?? {};
  const key = spec.envKeys.map((k) => env[k]).find((v) => v?.trim()) ?? stored.key ?? null;
  return {
    id: spec.id,
    label: stored.label ?? spec.label,
    baseUrl: (stored.baseUrl ?? spec.baseUrl).replace(/\/+$/, ""),
    key: key?.trim() || null,
    headers: { ...(spec.headers ?? {}), ...(stored.headers ?? {}) },
    free: spec.free ?? (() => false),
    ...(spec.note ? { note: spec.note } : {}),
    ...(spec.docs ? { docs: spec.docs } : {}),
  };
}

/** Save a key, a base URL, headers — any subset. Writes 0600. */
export function setProvider(id: string, patch: StoredProvider): void {
  const clean = id.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]*$/.test(clean)) throw new Error(`"${id}" isn't a usable provider id`);
  if (!specFor(clean) && !patch.baseUrl) {
    throw new Error(`"${clean}" isn't a provider Loom knows — give it a base URL and it will be`);
  }
  const store = readStore();
  const next = { ...(store[clean] ?? {}), ...patch };
  if (next.baseUrl) next.baseUrl = next.baseUrl.replace(/\/+$/, "");
  store[clean] = next;
  writeStore(store);
}

export function forgetProvider(id: string): boolean {
  const store = readStore();
  if (!(id in store)) return false;
  delete store[id];
  writeStore(store);
  return true;
}

/** The last four characters, which tells two keys apart and uses neither. */
export function maskKey(key: string | null): string {
  if (!key) return "";
  return key.length <= 4 ? "…" : `…${key.slice(-4)}`;
}

export interface ProviderSummary {
  id: string;
  label: string;
  baseUrl: string;
  configured: boolean;
  /** Masked. There is no code path that returns the key itself. */
  hint: string;
  /** Where the key came from, so "why is it still the old one" is answerable. */
  source: "env" | "file" | "none";
  note?: string;
  docs?: string;
}

/** Every provider Loom knows or has been told about, and whether it can be used. */
export function listProviders(env: NodeJS.ProcessEnv = process.env): ProviderSummary[] {
  const ids = new Set([...BUILTIN_PROVIDERS.map((p) => p.id), ...Object.keys(readStore())]);
  const out: ProviderSummary[] = [];
  for (const id of ids) {
    const p = resolveProvider(id, env);
    if (!p) continue;
    const spec = specFor(id);
    const fromEnv = Boolean(spec?.envKeys.some((k) => env[k]?.trim()));
    out.push({
      id: p.id,
      label: p.label,
      baseUrl: p.baseUrl,
      configured: Boolean(p.key) || id === "ollama",
      hint: maskKey(p.key),
      source: fromEnv ? "env" : p.key ? "file" : "none",
      ...(p.note ? { note: p.note } : {}),
      ...(p.docs ? { docs: p.docs } : {}),
    });
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

// ---------------------------------------------------------------------------
// The wire
// ---------------------------------------------------------------------------

export function chatUrl(p: ResolvedProvider): string {
  return `${p.baseUrl}/v1/chat/completions`;
}

export function modelsUrl(p: ResolvedProvider): string {
  return `${p.baseUrl}/v1/models`;
}

/**
 * Headers for a request. A provider with no key gets none — a local server
 * doesn't want `Authorization: Bearer null`, which is a 401 that reads like a
 * bad key rather than like no key.
 */
export function requestHeaders(p: ResolvedProvider): Record<string, string> {
  return {
    "content-type": "application/json",
    accept: "application/json",
    ...p.headers,
    ...(p.key ? { authorization: `Bearer ${p.key}` } : {}),
  };
}

/**
 * Turn a provider's refusal into something a person can act on.
 *
 * These four are the ones worth naming: they're the difference between "your
 * key is wrong", "your free quota is spent", "that model is gone" and "slow
 * down", and each has a different next step.
 */
export function explainStatus(status: number, body: string, p: ResolvedProvider): string {
  const snippet = body.replace(/\s+/g, " ").slice(0, 200);
  if (status === 401 && /unauthorized_client|client detected/i.test(body)) {
    return `${p.label} refused Loom as a client, not your key — it only accepts callers it recognises. ${p.note ?? ""}`.trim();
  }
  if (status === 401 || status === 403) {
    return `${p.label} rejected the key (${status}). Check it with \`loom providers\`. ${snippet}`;
  }
  if (status === 402) {
    return `${p.label} has no quota left for this model right now (402). Another model on the same key may still work. ${snippet}`;
  }
  if (status === 404 || status === 503) {
    return `${p.label} has no channel for that model (${status}) — the name may be wrong or the model retired. \`loom models --refresh\`. ${snippet}`;
  }
  if (status === 429) return `${p.label} is rate-limiting this key (429). ${snippet}`;
  return `${p.label} answered ${status}: ${snippet}`;
}

/** Is this the kind of failure another model on the same key might survive? */
export function isExhausted(status: number): boolean {
  return status === 402 || status === 429;
}

// ---------------------------------------------------------------------------
// What a provider currently has
// ---------------------------------------------------------------------------

export interface ProviderModel {
  id: string;
  provider: string;
  /** Free on this provider, by that provider's own convention. */
  free: boolean;
  /** AgentRouter reports these per model; most providers don't. */
  endpoints?: string[];
}

/** How long a model list is believed before asking again. */
export const MODELS_TTL_MS = 10 * 60_000;

interface CachedModels {
  at: number;
  models: ProviderModel[];
}

function cacheFile(): string {
  return path.join(loomHome(), "models-cache.json");
}

function readCache(): Record<string, CachedModels> {
  try {
    return JSON.parse(fs.readFileSync(cacheFile(), "utf8")) as Record<string, CachedModels>;
  } catch {
    return {};
  }
}

/**
 * The models a provider has right now.
 *
 * Cached on disk rather than in memory: the CLI is a new process every time,
 * and asking a provider for its catalogue once per command is rude to them and
 * slow for you. `refresh` skips the cache — which is what a model that has
 * just appeared (or vanished) needs.
 */
export async function fetchModels(
  p: ResolvedProvider,
  opts: { refresh?: boolean; fetchImpl?: typeof fetch } = {},
): Promise<{ models: ProviderModel[]; cached: boolean; error?: string }> {
  const cache = readCache();
  const hit = cache[p.id];
  if (!opts.refresh && hit && Date.now() - hit.at < MODELS_TTL_MS) {
    return { models: hit.models, cached: true };
  }
  const doFetch = opts.fetchImpl ?? fetch;
  try {
    const res = await doFetch(modelsUrl(p), { headers: requestHeaders(p) });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      // A stale list beats no list: the models probably still exist, and the
      // person asked what they could use, not whether the network is up.
      return { models: hit?.models ?? [], cached: Boolean(hit), error: explainStatus(res.status, body, p) };
    }
    const body = (await res.json()) as {
      data?: Array<{ id?: string; supported_endpoint_types?: string[] }>;
    };
    const models: ProviderModel[] = (body.data ?? [])
      .map((m) => String(m.id ?? ""))
      .filter(Boolean)
      .map((id) => {
        const raw = (body.data ?? []).find((m) => m.id === id);
        return {
          id,
          provider: p.id,
          free: p.free(id),
          ...(raw?.supported_endpoint_types ? { endpoints: raw.supported_endpoint_types } : {}),
        };
      })
      .sort((a, b) => a.id.localeCompare(b.id));
    try {
      const next = { ...cache, [p.id]: { at: Date.now(), models } };
      fs.mkdirSync(path.dirname(cacheFile()), { recursive: true });
      fs.writeFileSync(cacheFile(), JSON.stringify(next));
    } catch {
      /* a cache that can't be written is still a list that can be returned */
    }
    return { models, cached: false };
  } catch (err) {
    return {
      models: hit?.models ?? [],
      cached: Boolean(hit),
      error: `couldn't reach ${p.label}: ${String((err as Error).message)}`,
    };
  }
}

/** Every configured provider's models, for a picker that spans providers. */
export async function allModels(
  opts: { refresh?: boolean; env?: NodeJS.ProcessEnv } = {},
): Promise<{ models: ProviderModel[]; errors: Array<{ provider: string; error: string }> }> {
  const env = opts.env ?? process.env;
  const models: ProviderModel[] = [];
  const errors: Array<{ provider: string; error: string }> = [];
  for (const row of listProviders(env)) {
    if (!row.configured) continue;
    const p = resolveProvider(row.id, env);
    if (!p) continue;
    const got = await fetchModels(p, opts.refresh ? { refresh: true } : {});
    models.push(...got.models);
    if (got.error) errors.push({ provider: row.id, error: got.error });
  }
  return { models, errors };
}
