/**
 * The MCP catalog — where a server comes from before it is a row in config.
 *
 * core/mcp.ts is the back half of this story: it takes the servers a project has
 * configured and puts them in front of an agent. This is the front half, and it
 * is the half that didn't exist. Until now the only way to add a server was to
 * know its URL and type it into a prompt — so the composer shipped six hardcoded
 * rows with empty urls (GitHub, Slack, Supabase, …) which looked like
 * integrations and were placeholders. A logo is not an integration, and neither
 * is a name with nothing behind it.
 *
 * Two sources, and the difference between them is the whole design:
 *
 *   1. **The official registry** (registry.modelcontextprotocol.io). Thousands
 *      of servers, searchable, maintained by somebody else. Everything in here
 *      is normalised from what the registry actually returned — nothing is
 *      filled in, and an entry that is installable by neither a URL nor a
 *      package is dropped rather than shown as a row that can't be clicked.
 *
 *   2. **A curated shortlist** of well-known providers, for the empty state,
 *      because "search 4000 servers" is a bad first screen and the registry's
 *      ranking is not ours to reinterpret. Every URL and command in that list
 *      was verified against the vendor's own documentation and, where it is a
 *      remote, probed for a live response. The ones that could NOT be pinned to
 *      a single correct endpoint carry `needsUrl` so the UI asks the user
 *      instead of us guessing — a hosted telemetry backend whose hostname
 *      contains the account's own region is not knowable from here.
 *
 * ## Why the cache exists
 *
 * The catalog modal searches as you type. Without a cache that is one HTTP
 * request per keystroke against somebody else's public service, which is rude
 * at best and rate-limited at worst. A short TTL is enough — the registry does
 * not change between two keystrokes, and 60 seconds of staleness in a browse
 * list costs nothing.
 *
 * ## Why a failed fetch is `degraded` and not an error
 *
 * A laptop on a plane still deserves the curated list. Returning an empty array
 * would read as "there are no MCP servers", which is false; throwing would take
 * the modal down over a network blip. `degraded: true` says exactly what
 * happened — the registry did not answer, this is what we know without it — and
 * the UI can say so out loud.
 */

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

/** How a server is spoken to. `streamable-http` from the registry maps to http. */
export type CatalogTransport = "http" | "sse" | "stdio";

/** One installable server, normalised out of a registry entry. */
export interface CatalogServer {
  /** The registry's fully-qualified name — unique and stable, e.g. `app.linear/linear`. */
  id: string;
  /** The same fully-qualified name. Kept because that is what the registry calls it. */
  name: string;
  /** A human label: the entry's own title, or the last segment of the name. */
  title: string;
  description: string;
  /** The source repository, when the entry declares one. */
  homepage?: string;
  transport: CatalogTransport;
  /** Set for a remote server. */
  url?: string;
  /** Set for a local one, derived from the published package. */
  command?: string;
  args?: string[];
  /** The published version this was derived from, when the entry declares one. */
  version?: string;
  source: "registry";
}

/**
 * One hand-verified provider for the featured shelf.
 *
 * Every field here is a claim somebody checked. `maintainer` is part of that:
 * "official" means the vendor publishes this server, "community" means somebody
 * else does — a real and important difference that the row should show, because
 * pointing a database server at production is not a decision to make on the
 * assumption that Postgres wrote it.
 */
export interface CuratedProvider {
  /** Stable key for a bundled logo. Never changes; the display name might. */
  slug: string;
  /** Display name, and the name the server is installed under. */
  name: string;
  description: string;
  /** The vendor's documentation for this server. */
  homepage: string;
  transport: CatalogTransport;
  url?: string;
  command?: string;
  args?: string[];
  /**
   * True when the endpoint depends on the user's own account, region, or
   * deployment and so cannot be known here. The UI must ask; it must NOT
   * install a default. A wrong URL is worse than an empty field: it fails at
   * handshake time with an auth error that looks like the user's fault.
   */
  needsUrl?: boolean;
  /** A documented URL with the unknown part left in, to prefill what `needsUrl` asks for. */
  urlTemplate?: string;
  /** What the user must still supply for this server to start, in one line. */
  requires?: string;
  /** Does the vendor publish this server, or does somebody else? */
  maintainer: "official" | "community";
  source: "curated";
}

export interface CatalogResult {
  /** Registry hits for the query. Empty when `degraded`. */
  servers: CatalogServer[];
  /** The verified shortlist. Always present — it needs no network. */
  featured: CuratedProvider[];
  /** True when the registry did not answer and `servers` is therefore empty. */
  degraded: boolean;
}

// ---------------------------------------------------------------------------
// The curated shelf
// ---------------------------------------------------------------------------

/**
 * Well-known providers, verified against vendor documentation.
 *
 * Each remote below was confirmed twice: it appears in the vendor's own docs (or
 * in the official registry under the vendor's namespace), and a live MCP
 * `initialize` to it answered — 401 for the ones that need auth, which is a
 * server saying "not without credentials" and therefore proof the endpoint is
 * real. A DNS failure or a 404 would have disqualified an entry.
 *
 * Three entries are worth reading the comment on rather than trusting the shape:
 * SigNoz (region in the hostname), Postgres (no official server exists at all),
 * and Cloudflare (sixteen servers, not one).
 */
export const CURATED_MCPS: CuratedProvider[] = [
  {
    slug: "github",
    name: "GitHub",
    description: "Repositories, issues, pull requests, Actions, and code search.",
    homepage: "https://github.com/github/github-mcp-server",
    transport: "http",
    // The trailing slash is what GitHub's own docs and registry entry use.
    url: "https://api.githubcopilot.com/mcp/",
    requires: "a GitHub account; the server authenticates over OAuth on first use",
    maintainer: "official",
    source: "curated",
  },
  {
    slug: "linear",
    name: "Linear",
    description: "Issues, projects, cycles, and comments in Linear.",
    homepage: "https://linear.app/docs/mcp",
    transport: "http",
    // Linear also publishes /sse, but its docs mark that a deprecated fallback.
    url: "https://mcp.linear.app/mcp",
    maintainer: "official",
    source: "curated",
  },
  {
    slug: "slack",
    name: "Slack",
    description: "Search and read Slack messages, channels, and files.",
    homepage: "https://docs.slack.dev/ai/slack-mcp-server/",
    transport: "http",
    url: "https://mcp.slack.com/mcp",
    // Slack's docs say plainly that they do not support Dynamic Client
    // Registration, so the generic "add a remote server and let it OAuth" path
    // does not work here — you need a Slack app declaring the mcp:connect
    // scope. Said out loud because the failure otherwise looks like a bug.
    requires: "a Slack app with the mcp:connect scope — Slack does not support dynamic client registration",
    maintainer: "official",
    source: "curated",
  },
  {
    slug: "notion",
    name: "Notion",
    description: "Search, read, create, and update Notion pages and databases.",
    homepage: "https://developers.notion.com/docs/mcp",
    transport: "http",
    url: "https://mcp.notion.com/mcp",
    maintainer: "official",
    source: "curated",
  },
  {
    slug: "sentry",
    name: "Sentry",
    description: "Query Sentry issues, errors, traces, and releases.",
    homepage: "https://mcp.sentry.dev",
    transport: "http",
    url: "https://mcp.sentry.dev/mcp",
    maintainer: "official",
    source: "curated",
  },
  {
    slug: "stripe",
    name: "Stripe",
    description: "Manage Stripe customers, products, prices, payments, and invoices.",
    homepage: "https://docs.stripe.com/mcp",
    transport: "http",
    url: "https://mcp.stripe.com",
    maintainer: "official",
    source: "curated",
  },
  {
    slug: "supabase",
    name: "Supabase",
    description: "Manage Supabase projects, run SQL, inspect schemas, generate types.",
    homepage: "https://supabase.com/docs/guides/getting-started/mcp",
    transport: "http",
    url: "https://mcp.supabase.com/mcp",
    maintainer: "official",
    source: "curated",
  },
  {
    slug: "figma",
    name: "Figma",
    description: "Pull Figma design context, components, and variables into code.",
    homepage: "https://developers.figma.com/docs/figma-mcp-server/",
    transport: "http",
    url: "https://mcp.figma.com/mcp",
    maintainer: "official",
    source: "curated",
  },
  {
    slug: "cloudflare",
    name: "Cloudflare Docs",
    // Cloudflare publishes sixteen topic servers (bindings, observability,
    // radar, browser, logs, …) at <topic>.mcp.cloudflare.com/mcp, not one
    // "Cloudflare" server. Featuring the docs one is a choice, and the honest
    // way to make it is to name it for what it is and say where the rest are —
    // rather than shipping a row called "Cloudflare" that turns out to only
    // answer documentation questions.
    description:
      "Search Cloudflare's documentation. Cloudflare's other servers (bindings, observability, radar, browser, logs, …) live at https://<topic>.mcp.cloudflare.com/mcp.",
    homepage: "https://developers.cloudflare.com/agents/model-context-protocol/mcp-servers-for-cloudflare/",
    transport: "http",
    url: "https://docs.mcp.cloudflare.com/mcp",
    maintainer: "official",
    source: "curated",
  },
  {
    slug: "playwright",
    name: "Playwright",
    description: "Drive a browser: navigate, click, fill, snapshot, screenshot.",
    homepage: "https://github.com/microsoft/playwright-mcp",
    transport: "stdio",
    command: "npx",
    args: ["@playwright/mcp@latest"],
    maintainer: "official",
    source: "curated",
  },
  {
    slug: "postgres",
    name: "Postgres",
    // The reference server everyone still links to — @modelcontextprotocol/
    // server-postgres — is deprecated on npm, archived upstream, last released
    // in 2024, and carries a published SQL-injection flaw (it wrapped queries
    // in a read-only transaction but accepted semicolon-delimited statements,
    // so a caller could break out of it). It is not shipped here at any price.
    //
    // The PostgreSQL project publishes no MCP server of its own, so the honest
    // label on the best-maintained alternative is "community", and the default
    // access mode is the restricted one. Someone who wants write access can say
    // so; nobody should get it because a featured row defaulted to it.
    description:
      "Query a PostgreSQL database: schemas, indexes, health checks, and read-only SQL. Community-maintained — PostgreSQL publishes no official MCP server.",
    homepage: "https://github.com/crystaldba/postgres-mcp",
    transport: "stdio",
    command: "uvx",
    args: ["postgres-mcp", "--access-mode=restricted"],
    requires: "a DATABASE_URI environment variable pointing at your database",
    maintainer: "community",
    source: "curated",
  },
  {
    slug: "filesystem",
    name: "Filesystem",
    // The allowed directories are positional arguments and the server will not
    // start without at least one. They are deliberately NOT defaulted to the
    // project directory here: which files an agent may write is the user's
    // decision, and a default that happens to be right is still a decision
    // nobody made.
    description: "Read and write local files, restricted to directories you allow.",
    homepage: "https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem",
    transport: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-filesystem"],
    requires: "one or more directories the server may access, appended as arguments",
    maintainer: "official",
    source: "curated",
  },
  {
    slug: "signoz",
    name: "SigNoz",
    // SigNoz Cloud's MCP hostname contains the account's region
    // (mcp.us / mcp.eu / mcp.in …), and their docs are explicit that the wrong
    // region fails authentication. There is no correct value to hardcode, so
    // this asks — with the documented shape prefilled so the user only has to
    // replace the one part we can't know. Self-hosted SigNoz is a different
    // endpoint entirely, which is another reason not to guess.
    description: "Query SigNoz metrics, traces, logs, alerts, and dashboards.",
    homepage: "https://signoz.io/docs/ai/signoz-mcp-server/",
    transport: "http",
    needsUrl: true,
    urlTemplate: "https://mcp.<region>.signoz.cloud/mcp",
    requires: "your SigNoz Cloud region, or the URL of your self-hosted deployment",
    maintainer: "official",
    source: "curated",
  },
];

// ---------------------------------------------------------------------------
// The registry
// ---------------------------------------------------------------------------

const DEFAULT_REGISTRY_URL = "https://registry.modelcontextprotocol.io/v0/servers";

/**
 * Which registry to ask.
 *
 * Read per call rather than captured at import, so a test can point it at a
 * local stub without a module-load dance — and so anyone running one of the
 * private subregistries the MCP spec allows can point Loom at theirs. Reading
 * it live is also what keeps the test suite off the public registry entirely: a
 * unit test that quietly makes a real network request is slow, flaky under
 * load, and fails on a plane.
 */
function registryUrl(): string {
  return process.env.LOOM_MCP_REGISTRY?.trim() || DEFAULT_REGISTRY_URL;
}

/**
 * How long a search stays fresh. Short, because the point is to survive a burst
 * of keystrokes rather than to avoid the network — a browse list that is a
 * minute stale is indistinguishable from a live one.
 */
const TTL_MS = 60_000;

/**
 * A failure is cached too, briefly. Otherwise every keystroke while offline
 * costs a full 8-second timeout, and the modal becomes unusable in exactly the
 * situation the curated fallback exists to handle. Ten seconds is long enough
 * to stop the storm and short enough that reconnecting feels immediate.
 */
const FAILURE_TTL_MS = 10_000;

const DEFAULT_LIMIT = 30;
const MAX_LIMIT = 100;

interface CacheEntry {
  at: number;
  ttl: number;
  value: CatalogResult;
}

const cache = new Map<string, CacheEntry>();

/** Drop everything cached. Exported for tests, which must not inherit a result. */
export function clearCatalogCache(): void {
  cache.clear();
}

/** The raw shapes the registry returns, named so the normaliser reads honestly. */
interface RegistryRemote {
  type?: string;
  url?: string;
}
interface RegistryPackage {
  registryType?: string;
  identifier?: string;
  version?: string;
  runtimeHint?: string;
}
interface RegistryServer {
  name?: string;
  title?: string;
  description?: string;
  version?: string;
  repository?: { url?: string };
  remotes?: RegistryRemote[] | null;
  packages?: RegistryPackage[] | null;
}
interface RegistryEnvelope {
  servers?: Array<{ server?: RegistryServer; _meta?: Record<string, { isLatest?: boolean }> }> | null;
}

/**
 * Search the official registry, falling back to the curated shelf.
 *
 * `query` is passed through as the registry's own `search` parameter — its
 * matching is its business, and reimplementing it here would give different
 * answers than the registry's website for the same words.
 */
export async function searchCatalog(query?: string, limit?: number): Promise<CatalogResult> {
  const q = String(query ?? "").trim();
  const n = Math.min(Math.max(Math.trunc(Number(limit) || DEFAULT_LIMIT), 1), MAX_LIMIT);
  const key = `${n}\0${q}`;

  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < hit.ttl) return hit.value;

  const featured = CURATED_MCPS;
  let result: CatalogResult;
  try {
    const url = new URL(registryUrl());
    url.searchParams.set("limit", String(n));
    if (q) url.searchParams.set("search", q);
    const res = await fetch(url, {
      signal: AbortSignal.timeout(8_000),
      headers: { accept: "application/json" },
    });
    if (!res.ok) throw new Error(`registry responded ${res.status}`);
    const body = (await res.json()) as RegistryEnvelope;
    result = { servers: normalizeRegistry(body), featured, degraded: false };
  } catch {
    // Offline, timed out, rate-limited, or the registry changed shape under us.
    // All four have the same honest answer: here is what we know for certain,
    // and a flag saying the rest is missing. Nothing is invented to fill it.
    result = { servers: [], featured, degraded: true };
  }

  cache.set(key, { at: Date.now(), ttl: result.degraded ? FAILURE_TTL_MS : TTL_MS, value: result });
  // The cache is a keystroke buffer, not a store. A bound keeps a long typing
  // session from retaining every prefix of every query for the process's life.
  if (cache.size > 200) {
    const oldest = [...cache.entries()].sort((a, b) => a[1].at - b[1].at)[0];
    if (oldest) cache.delete(oldest[0]);
  }
  return result;
}

/**
 * Registry entries → installable rows.
 *
 * Two things happen here that the raw response doesn't do for you:
 *
 *   - **Deduplication.** The registry returns every published version of a
 *     server as its own entry, so an unfiltered list shows "inference.sh" three
 *     times. Entries are collapsed by name, preferring the one the registry
 *     marks `isLatest` and otherwise the last seen (the list is version-ordered).
 *
 *   - **Dropping the uninstallable.** `remotes` and `packages` are both nullable
 *     and an entry can have neither — it is a name in a directory, not something
 *     you can connect to. Those are removed rather than rendered as a row whose
 *     Install button would have nothing to write.
 */
export function normalizeRegistry(body: RegistryEnvelope): CatalogServer[] {
  const byName = new Map<string, CatalogServer>();
  const pinned = new Set<string>();
  for (const item of body?.servers ?? []) {
    const server = item?.server;
    const name = String(server?.name ?? "").trim();
    if (!server || !name) continue;
    const normalized = normalizeServer(server);
    if (!normalized) continue;
    const isLatest = Object.values(item?._meta ?? {}).some((m) => m?.isLatest === true);
    // A version the registry marks latest wins and holds; otherwise later
    // entries overwrite earlier ones, which for a version-ordered list is the
    // newest one we saw.
    if (pinned.has(name) && !isLatest) continue;
    byName.set(name, normalized);
    if (isLatest) pinned.add(name);
  }
  return [...byName.values()];
}

/** One entry, or null when it is installable by neither a remote nor a package. */
function normalizeServer(server: RegistryServer): CatalogServer | null {
  const name = String(server.name ?? "").trim();
  const base = {
    id: name,
    name,
    title: String(server.title ?? "").trim() || humanize(name),
    description: String(server.description ?? "").trim(),
    ...(server.repository?.url ? { homepage: String(server.repository.url) } : {}),
    ...(server.version ? { version: String(server.version) } : {}),
    source: "registry" as const,
  };

  // A remote wins over a package every time: it is a URL the user can connect
  // to now, against a package that has to be downloaded and run locally with
  // whatever credentials it wants in its environment.
  const remote = pickRemote(server.remotes);
  if (remote) return { ...base, transport: remote.transport, url: remote.url };

  const pkg = pickPackage(server.packages);
  if (pkg) return { ...base, transport: "stdio", command: pkg.command, args: pkg.args };

  return null;
}

/** The best remote: streamable-http if offered, else sse. */
function pickRemote(remotes: RegistryRemote[] | null | undefined): { transport: "http" | "sse"; url: string } | null {
  const usable = (remotes ?? []).filter((r) => /^https?:\/\//i.test(String(r?.url ?? "").trim()));
  const http = usable.find((r) => String(r.type ?? "").toLowerCase() === "streamable-http" || String(r.type ?? "").toLowerCase() === "http");
  if (http) return { transport: "http", url: String(http.url).trim() };
  const sse = usable.find((r) => String(r.type ?? "").toLowerCase() === "sse");
  if (sse) return { transport: "sse", url: String(sse.url).trim() };
  // A remote with a URL but an unfamiliar `type`. It is still a URL, and
  // core/mcp.ts guesses http-vs-sse from the path the same way — so honour it
  // rather than dropping a server over a spelling we haven't seen.
  const other = usable[0];
  return other ? { transport: /\/sse\/?$/i.test(String(other.url)) ? "sse" : "http", url: String(other.url).trim() } : null;
}

/**
 * A package → the command that runs it.
 *
 * Only the two ecosystems with a standard zero-install runner: npm via `npx -y`
 * and PyPI via `uvx`, both of which take `name@version`. Anything else (OCI,
 * NuGet, a bare binary) needs a decision about a runtime that isn't ours to
 * make, so those entries are left uninstallable rather than given a command
 * that probably doesn't exist on the machine.
 *
 * The registry's `runtimeArguments` are deliberately ignored: they encode
 * per-package placeholders that the user is expected to fill in, and splicing
 * them in unfilled produces a command line that looks complete and isn't.
 */
function pickPackage(packages: RegistryPackage[] | null | undefined): { command: string; args: string[] } | null {
  for (const pkg of packages ?? []) {
    const id = String(pkg?.identifier ?? "").trim();
    if (!id) continue;
    const version = String(pkg?.version ?? "").trim();
    const spec = version ? `${id}@${version}` : id;
    const type = String(pkg?.registryType ?? "").toLowerCase();
    const hint = String(pkg?.runtimeHint ?? "").toLowerCase();
    if (type === "npm" || hint === "npx") return { command: "npx", args: ["-y", spec] };
    if (type === "pypi" || hint === "uvx") return { command: "uvx", args: [spec] };
  }
  return null;
}

/** `ai.smithery/smithery-ai-github` → `Smithery Ai Github`, for an entry with no title. */
function humanize(name: string): string {
  const tail = name.split("/").pop() ?? name;
  return tail
    .replace(/[-_.]+/g, " ")
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase()) || name;
}
