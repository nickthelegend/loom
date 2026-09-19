/**
 * Thin client over the loom daemon API (same endpoints as the CLI/web app).
 * Credentials (daemon URL + client token) live in the device keychain.
 */

import * as SecureStore from "expo-secure-store";
import { AppState, Platform, type AppStateStatus } from "react-native";
import { RelayClient, parseCloudFragment } from "./relay-client";
import { unpackCredentials, type RelayCredentials } from "./relay-protocol";
import { supabaseRelayTransport } from "./relay-transport";

// Credentials live in the device keychain on native; on web (Expo web, used for
// the browser demo) SecureStore isn't available, so fall back to localStorage.
export const kv = {
  get: (k: string): Promise<string | null> =>
    Platform.OS === "web"
      ? Promise.resolve(globalThis.localStorage?.getItem(k) ?? null)
      : SecureStore.getItemAsync(k),
  set: (k: string, v: string): Promise<void> =>
    Platform.OS === "web"
      ? (globalThis.localStorage?.setItem(k, v), Promise.resolve())
      : SecureStore.setItemAsync(k, v),
  del: (k: string): Promise<void> =>
    Platform.OS === "web"
      ? (globalThis.localStorage?.removeItem(k), Promise.resolve())
      : SecureStore.deleteItemAsync(k),
};

/**
 * Loom Cloud: how to reach the daemon when its URL doesn't answer. Present
 * only when the pairing link carried the cloud params (the daemon owner turned
 * Loom Cloud on). `supabaseUrl`/`anonKey` are the DAEMON's Supabase project,
 * which need not be the one this app signs people in with.
 */
export interface CloudCreds {
  creds: RelayCredentials;
  supabaseUrl: string;
  anonKey: string;
}

export interface Creds {
  url: string; // e.g. http://100.x.y.z:7420
  token: string;
  relay?: CloudCreds;
}

export interface DaemonReachability {
  reachable: boolean;
  latencyMs?: number;
  name?: string;
}

export interface AgentStatus {
  id: string;
  kind: string;
  role: string;
  tier: "adapter" | "bridge";
  available: boolean;
  busy: boolean;
  holdsBaton: boolean;
  /** The model the adapter is pinned to, when the daemon knows one. */
  model?: string;
  /** Off agents stay in the roster but aren't spawned and can't hold the baton. */
  enabled?: boolean;
  /** The permission mode in effect (bypass | auto | ask). Absent on older daemons. */
  permissions?: PermissionMode;
}

export interface RouteState {
  name?: string;
  status: string;
  steps: string[];
  current: number;
  maxHops?: number;
  mode?: string;
  reason?: string;
  pendingQuestion?: string;
  costUsd?: number;
}

/**
 * One agent barred from the baton, and why.
 *
 * `since` is when the pause started, `displaced` says whether the agent was
 * actually holding the baton at the time and had it taken off it — a pause on an
 * idle agent and a pause that interrupted live work are different events and the
 * UI is expected to tell them apart.
 */
export interface QuarantineEntry {
  reason: string;
  since: number;
  displaced: boolean;
}

/** Keyed by agent id. Empty object means "nothing is paused", which is a fact. */
export type QuarantineMap = Record<string, QuarantineEntry>;

export interface Project {
  id: string;
  name: string;
  holder: string | null;
  agents: AgentStatus[];
  needsInput: boolean;
  route?: RouteState | null;
  routeNames?: string[];
  costUsd?: number;
  /**
   * Agents a firing alert (or a budget cap) has paused. It rides on the
   * project status because a pause otherwise lives only in state on disk, which
   * made the self-heal look like it had done nothing at all.
   *
   * Optional only because a daemon older than the field wouldn't send it; the
   * current one always does, empty object and all, so Self-heal reads an absent
   * field the same way the desktop does — as nothing paused.
   */
  quarantine?: QuarantineMap;
}

export interface LoomEvent {
  id: number;
  ts: number;
  kind: string;
  agentId?: string;
  chat?: string;
  payload: Record<string, unknown>;
}

/** A named conversation within a project — the desktop's sidebar chats. */
export interface Chat {
  id: string;
  title: string;
  createdAt: number;
}

/** Per-agent cost + token rollup from the daemon's /metrics endpoint. */
export interface AgentMetric {
  agentId: string;
  usd: number;
  turns: number;
  ms: number;
  tokensIn: number;
  tokensOut: number;
}

export interface Metrics {
  totalUsd: number;
  turns: number;
  totalMs: number;
  tokensIn: number;
  tokensOut: number;
  byAgent: AgentMetric[];
}

/** One trace span behind a triage verdict (the agent's own turns/handoffs/errors). */
export interface TriageSpan {
  ts: number;
  name: string;
  ms: number;
  code: number; // OTel status: 2 = error
  msg: string;
  kind: string;
  cost: number;
  tin: number;
  tout: number;
}

/** "Why did I fail?" — an agent root-caused from its own traces. */
export interface Triage {
  agent: string;
  spanCount: number;
  errorCount: number;
  evidence: TriageSpan[];
  rootCause: string;
  suggestedFix: string;
  source: "llm" | "heuristic" | "no-data";
  from: "backend" | "local-log" | "none";
}

export interface WorkingTree {
  git: boolean;
  branch?: string;
  files: Array<{ status: string; path: string }>;
  patch: string;
  truncated: boolean;
}

/** An issue or PR on the project's GitHub remote, read through the host's gh CLI. */
export interface TaskItem {
  id: number;
  title: string;
  author: string;
  labels: Array<{ name: string; color: string }>;
  assignees: string[];
  state: string;
  updatedAt: string;
  url: string;
  kind: "issue" | "pr";
  draft?: boolean;
}

/**
 * Either a list, or the reason there isn't one. The daemon never returns an
 * empty list to mean "unavailable" — an empty table would read as "no issues".
 */
export type TaskResult =
  | { available: true; repo: string; items: TaskItem[]; capped: boolean }
  | { available: false; reason: "no-cli" | "no-auth" | "no-remote" | "error"; detail: string };

// ---------------------------------------------------------------------------
// Observatory: the same shapes the daemon's web app renders. Every optional
// field below is optional in the daemon too — the phone must never fill one in.
// ---------------------------------------------------------------------------

/**
 * One span behind an Observatory panel. `from` on the response says whether
 * these came out of the telemetry backend's store or were rebuilt from the
 * local event log, which is a provenance fact the UI is required to show
 * rather than hide.
 */
export interface InsightSpan {
  traceId: string;
  spanId: string;
  ts: number;
  ade: string;
  model: string;
  handoffFrom: string;
  handoffTo: string;
  name: string; // "gen_ai.agent.turn" | "loom.baton.handoff" | "loom.error" | …
  ms: number;
  code: number; // OTel status: 2 = error
  msg: string;
  agent: string;
  tin: number;
  tout: number;
  cost: number;
}

export type SpanSource = "backend" | "local-log";

/**
 * One log line Loom shipped, read back out of the telemetry backend.
 *
 * `traceId`/`spanId` are empty strings when the record was emitted outside a
 * span, which is normal for status lines — an empty string here means "this line
 * is not correlated to a trace", not "we don't know", so the UI shows nothing
 * rather than a placeholder id.
 */
export interface InsightLog {
  ts: number;
  severity: string;
  /** OTel severity_number (1–24), so severity can be ordered without parsing text. */
  severityNumber: number;
  body: string;
  traceId: string;
  spanId: string;
  agent: string;
  /** loom.event.kind — which event produced the line (run_complete, status, message, …). */
  kind: string;
  /** loom.chat — the conversation the line belongs to. */
  chat: string;
}

/**
 * Logs get a different provenance pair from spans, and the difference is the
 * whole point. A span has a local fallback: it is a summary of an event that is
 * already on the daemon's disk, so `from` can be "local-log". A log line is not
 * — its severity, body and trace correlation only exist once the record has been
 * built and shipped — so there is nothing to fall back to, and the daemon says
 * `"unavailable"` instead of handing back an empty list that would read as
 * "nothing happened".
 */
export type LogSource = "backend" | "unavailable";

/** A 0–100 score with the four penalty buckets that subtracted from 100. */
export interface Health {
  score: number;
  grade: "healthy" | "degraded" | "unhealthy";
  turns: number;
  errorCount: number;
  buckets: { errorRate: number; latency: number; tokenBloat: number; recency: number };
}

export type DecisionSource = "llm" | "cli" | "heuristic";

/**
 * A decision mined out of an agent's turn.
 *
 * Two fields carry rules the UI has to honour. `confidence` is absent for every
 * heuristic extraction — there is no measurement, so there is no bar to draw.
 * And `turnTokensUsed`/`turnCostUsd` are the WHOLE TURN's usage, not this
 * decision's share of it: a turn yielding three decisions has one price, and
 * labelling them per-decision would triple it on screen.
 */
export interface AgentDecision {
  id: string;
  projectId: string;
  chatId: string;
  agentId: string;
  agentRole: string;
  timestamp: number;
  turnIndex: number;
  traceId?: string;
  turnId?: string;
  category: string;
  title: string;
  reasoning: string;
  confidence?: number;
  source: DecisionSource;
  alternatives: string[];
  filesCreated: string[];
  filesModified: string[];
  artifactNames: string[];
  memoryKeys: string[];
  upstreamDecisionIds: string[];
  turnTokensUsed: number;
  turnCostUsd: number;
  durationMs: number;
}

export interface DecisionStats {
  total: number;
  byAgent: Record<string, number>;
  byCategory: Record<string, number>;
  /** null when no decision carried a confidence — "0" would read as certainty of nothing. */
  avgConfidence: number | null;
  confidenceSamples: number;
  bySource: Record<DecisionSource, number>;
  topAlternatives: string[];
  criticalPath: string[];
}

export interface AgentSnapState {
  turnsCompleted: number;
  tokensUsed: number;
  costUsd: number;
  lastAction: string;
  status: "idle" | "active" | "waiting" | "errored";
}

/** One scrub frame: the fleet's exact state folded from the log up to that instant. */
export interface TimeSnapshot {
  timestampMs: number;
  turnIndex: number;
  eventIndex: number;
  batonHolder: string;
  decisionsAtPoint: string[];
  agentStates: Record<string, AgentSnapState>;
  memorySnapshot: { decisionsCount: number; keyFacts: string[] };
  threadLength: number;
  lastMessage: { agentId: string; text: string; timestamp: number } | null;
  filesCreatedSoFar: number;
  filesModifiedSoFar: number;
  triggerEvent: { type: string; agentId: string; description: string };
}

/** An Ask answer, with the provenance the answer is only honest alongside. */
export interface AskResult {
  answer: string;
  /** Which CLI and model actually answered, e.g. "agy · gemini-3.6-flash-high". */
  via: string;
  /** MCP servers handed to the model for the question, telemetry ones included. */
  mcpServers: string[];
  /** "backend" when the evidence spans came from the telemetry store, "local-log" when it was empty/down. */
  spanSource: SpanSource | string;
  evidenceAgents?: number;
  evidenceSpans?: number;
  /** True when no CLI was available to answer at all — not an answer, a gap. */
  unavailable?: boolean;
}

/** Where a skill was discovered. The four roots the daemon scans. */
export type SkillOrigin = "project" | "user" | "plugin" | "bundled";

export interface SkillEntry {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  origin: SkillOrigin;
  /** Absolute path of the root it came from — the only proof of which copy this is. */
  source: string;
  /** True only for skills in the project's own skills/ dir: the ones DELETE may touch. */
  installed: boolean;
}

/** A configured MCP server. `connected` is MEASURED by the daemon, never inferred. */
export interface McpServer {
  name: string;
  url: string;
  description?: string;
  icon?: string;
  transport?: string;
  slug?: string;
  command?: string;
  args?: string[];
  enabledForSession?: boolean;
  connected: boolean;
  probedAt?: number;
}

/** A catalog row — either a registry entry or one of the curated `featured` ones. */
export interface McpCatalogEntry {
  id?: string;
  slug?: string;
  name: string;
  title?: string;
  description?: string;
  homepage?: string;
  version?: string;
  source?: string;
  transport?: string;
  url?: string;
  command?: string;
  args?: string[];
  requires?: string;
  maintainer?: string;
  /** The registry advertises the server but not an endpoint — the user must supply one. */
  needsUrl?: boolean;
}

export interface McpCatalog {
  servers: McpCatalogEntry[];
  featured: McpCatalogEntry[];
  /** True when the registry did not answer: `servers` is empty for that reason, not because nothing matched. */
  degraded: boolean;
}

const URL_KEY = "loomUrl";
const TOKEN_KEY = "loomToken";
const RELAY_KEY = "loomRelay";
const RELAY_CLIENT_KEY = "loomRelayClientId";

export async function loadCreds(): Promise<Creds | null> {
  const [url, token, relay] = await Promise.all([kv.get(URL_KEY), kv.get(TOKEN_KEY), kv.get(RELAY_KEY)]);
  if (!url || !token) return null;
  let cloud: CloudCreds | undefined;
  try {
    cloud = relay ? (JSON.parse(relay) as CloudCreds) : undefined;
  } catch {
    cloud = undefined; // a corrupt blob just means "no cloud route", never "not paired"
  }
  return { url, token, ...(cloud ? { relay: cloud } : {}) };
}

export async function saveCreds(creds: Creds): Promise<void> {
  await Promise.all([
    kv.set(URL_KEY, creds.url),
    kv.set(TOKEN_KEY, creds.token),
    creds.relay ? kv.set(RELAY_KEY, JSON.stringify(creds.relay)) : kv.del(RELAY_KEY),
  ]);
}

export async function clearCreds(): Promise<void> {
  connection.reset();
  await Promise.all([kv.del(URL_KEY), kv.del(TOKEN_KEY), kv.del(RELAY_KEY)]);
}

/**
 * The Loom Cloud half of a pairing link: `#pair=…&relay=<channel.key>&sb=…&sbk=…`.
 * Null when the link has none (Loom Cloud off) or they don't parse.
 */
export function cloudFromLink(raw: string): CloudCreds | null {
  const hash = raw.indexOf("#");
  if (hash < 0) return null;
  const fragment = raw.slice(hash).split(/\s/)[0]!;
  const parsed = parseCloudFragment(fragment);
  if (!parsed) return null;
  const creds = unpackCredentials(parsed.relay);
  if (!creds) return null;
  return { creds, supabaseUrl: parsed.supabaseUrl, anonKey: parsed.anonKey };
}

/** `fetch` with a deadline — React Native's fetch has none of its own. */
async function fetchWithin(url: string, init: RequestInit, ms: number): Promise<Response> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: ctl.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Exchange a single-use pairing token (from `loom pair`) for a client token.
 *
 * Direct first. If the daemon's URL doesn't answer (the phone is on another
 * network) and the link carried Loom Cloud params, the claim goes through the
 * relay instead — the daemon runs it against itself exactly as if it came in
 * over the LAN.
 */
export async function claim(url: string, pairToken: string, cloud?: CloudCreds | null): Promise<Creds> {
  const base = url.replace(/\/+$/, "").replace(/\/app.*$/, "");
  const body = { token: pairToken, name: "loom-app" };
  let direct: Response | null = null;
  try {
    direct = await fetchWithin(
      `${base}/api/pair/claim`,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
      cloud ? 2500 : 15_000,
    );
  } catch (e) {
    if (!cloud) throw e;
  }
  if (direct) {
    const json = (await direct.json().catch(() => ({}))) as { clientToken?: string; error?: string };
    if (!direct.ok || !json.clientToken) throw new Error(json.error ?? "pairing failed");
    return { url: base, token: json.clientToken, ...(cloud ? { relay: cloud } : {}) };
  }
  // unreachable directly, cloud params present: claim through the relay
  const transport = supabaseRelayTransport(cloud!.supabaseUrl, cloud!.anonKey, cloud!.creds.channel);
  const client = new RelayClient(transport, cloud!.creds, { clientId: await relayClientId() });
  try {
    await withTimeout(transport.ready(), RELAY_JOIN_MS, "couldn't join Loom Cloud");
    const res = await client.request("POST", "/api/pair/claim", { body, timeoutMs: 15_000 });
    const json = (res.body ?? {}) as { clientToken?: string; clientId?: string; error?: string };
    if (res.status >= 400 || !json.clientToken) throw new Error(json.error ?? `pairing failed (HTTP ${res.status})`);
    const creds: Creds = { url: base, token: json.clientToken, relay: cloud! };
    // We just proved the direct URL is dead and the relay works — start there.
    connection.bind(creds);
    connection.noteRoute(base, "cloud");
    return creds;
  } finally {
    void client.close();
  }
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(what)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

/** One relay client id per install — the daemon keys its per-client state on it. */
let clientIdMemo: Promise<string> | null = null;
function relayClientId(): Promise<string> {
  clientIdMemo ??= kv.get(RELAY_CLIENT_KEY).then(async (saved) => {
    if (saved) return saved;
    const b = new Uint8Array(12);
    globalThis.crypto.getRandomValues(b);
    const id = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
    await kv.set(RELAY_CLIENT_KEY, id).catch(() => {});
    return id;
  });
  return clientIdMemo;
}

// ---------------------------------------------------------------------------
// Connection manager: Direct → Loom Cloud → Offline
// ---------------------------------------------------------------------------

/** How the app is reaching the daemon right now. */
export type ConnRoute = "direct" | "cloud" | "offline" | "checking";

const DIRECT_PROBE_MS = 2500;
const RELAY_JOIN_MS = 8000;
/** Mobile OSes kill sockets silently; after this long away, assume they're dead. */
const STALE_BACKGROUND_MS = 10_000;
/** While on the relay, look for the direct path coming back this often. */
const RECHECK_CLOUD_MS = 60_000;
const RECHECK_OFFLINE_MS = 4000;

/**
 * Picks the route: the direct URL when `/api/health` answers within 2.5s,
 * otherwise Loom Cloud when the pairing carried it, otherwise offline.
 * Re-checks on foreground; after >10s in the background it also forces every
 * live stream to start fresh (T3 Code's reconnection pattern).
 */
class ConnectionManager {
  route: ConnRoute = "checking";
  private creds: Creds | null = null;
  private checkedAt = 0;
  private probing: Promise<ConnRoute> | null = null;
  private relay: RelayClient | null = null;
  private relayJoined: Promise<void> | null = null;
  private listeners = new Set<(r: ConnRoute) => void>();
  private resumeListeners = new Set<() => void>();
  private backgroundedAt: number | null = null;
  private appStateHooked = false;

  /** Point the manager at a paired daemon; a different daemon starts over. */
  bind(creds: Creds): void {
    this.hookAppState();
    if (
      this.creds &&
      this.creds.url === creds.url &&
      this.creds.token === creds.token &&
      this.creds.relay?.creds.channel === creds.relay?.creds.channel
    ) {
      return;
    }
    this.reset();
    this.creds = creds;
  }

  reset(): void {
    this.creds = null;
    this.checkedAt = 0;
    this.probing = null;
    void this.relay?.close();
    this.relay = null;
    this.relayJoined = null;
    this.set("checking");
  }

  /** Claim-time hint: we already know the direct URL failed and the relay worked. */
  noteRoute(url: string, route: ConnRoute): void {
    if (this.creds && this.creds.url !== url) return;
    this.route = route;
    this.checkedAt = Date.now();
    this.emit();
  }

  subscribe(fn: (r: ConnRoute) => void): () => void {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  }

  /** Fires when the app comes back after long enough that sockets can't be trusted. */
  onResume(fn: () => void): () => void {
    this.resumeListeners.add(fn);
    return () => void this.resumeListeners.delete(fn);
  }

  private set(r: ConnRoute): void {
    if (this.route === r) return;
    this.route = r;
    this.emit();
  }

  private emit(): void {
    for (const l of this.listeners) l(this.route);
  }

  /** The route to use now, probing when unknown or due. */
  async routeFor(creds: Creds): Promise<ConnRoute> {
    this.bind(creds);
    const age = Date.now() - this.checkedAt;
    if (this.route === "direct" && this.checkedAt) return "direct";
    if (this.route === "cloud" && this.checkedAt) {
      if (age > RECHECK_CLOUD_MS) void this.probe(); // look for direct coming back, without waiting
      return "cloud";
    }
    if (this.route === "offline" && age < RECHECK_OFFLINE_MS) return "offline";
    return this.probe();
  }

  /** Re-decide the route. Concurrent callers share one probe. */
  probe(): Promise<ConnRoute> {
    this.probing ??= this.runProbe().finally(() => {
      this.probing = null;
    });
    return this.probing;
  }

  private async runProbe(): Promise<ConnRoute> {
    const creds = this.creds;
    if (!creds) return "checking";
    let route: ConnRoute = "offline";
    try {
      // Any HTTP answer at all means the direct path works (a 401 is api()'s business).
      await fetchWithin(`${creds.url}/api/health`, { headers: { Authorization: `Bearer ${creds.token}` } }, DIRECT_PROBE_MS);
      route = "direct";
    } catch {
      if (creds.relay) {
        const client = await this.relayClient().catch(() => null);
        if (client && (await client.ping(6000)) !== null) route = "cloud";
        else this.dropRelay(); // a broken channel is rebuilt on the next probe
      }
    }
    if (this.creds !== creds) return this.route; // re-bound mid-probe; that probe wins
    this.checkedAt = Date.now();
    this.set(route);
    return route;
  }

  /** The joined relay client for the bound daemon (created on first use). */
  async relayClient(): Promise<RelayClient> {
    const cloud = this.creds?.relay;
    if (!cloud) throw new Error("this pairing has no Loom Cloud route");
    if (!this.relay) {
      const id = await relayClientId();
      if (this.relay || this.creds?.relay !== cloud) return this.relayClient(); // raced another caller
      const transport = supabaseRelayTransport(cloud.supabaseUrl, cloud.anonKey, cloud.creds.channel);
      this.relay = new RelayClient(transport, cloud.creds, { clientId: id });
      this.relayJoined = withTimeout(transport.ready(), RELAY_JOIN_MS, "couldn't join Loom Cloud");
    }
    const client = this.relay;
    await this.relayJoined;
    return client;
  }

  private dropRelay(): void {
    void this.relay?.close();
    this.relay = null;
    this.relayJoined = null;
  }

  /** A direct request just got an HTTP answer: that settles the route. */
  sawDirect(creds: Creds): void {
    if (this.creds !== creds && this.creds?.url !== creds.url) return;
    this.checkedAt = Date.now();
    this.set("direct");
  }

  /** A direct request failed at the network level: find out where we stand now. */
  async directFailed(creds: Creds): Promise<ConnRoute> {
    this.bind(creds);
    this.checkedAt = 0;
    this.set("checking");
    return this.probe();
  }

  private hookAppState(): void {
    if (this.appStateHooked) return;
    this.appStateHooked = true;
    AppState.addEventListener("change", (s: AppStateStatus) => {
      if (s === "background" || s === "inactive") {
        this.backgroundedAt ??= Date.now();
        return;
      }
      if (s !== "active") return;
      const away = this.backgroundedAt ? Date.now() - this.backgroundedAt : 0;
      this.backgroundedAt = null;
      if (!this.creds) return;
      if (away > STALE_BACKGROUND_MS) {
        this.relay?.refresh();
        for (const l of this.resumeListeners) l();
      }
      void this.probe();
    });
  }
}

export const connection = new ConnectionManager();

/**
 * Registered by App.tsx: called when any request 401s (token revoked or
 * expired) so the app can clear creds and return to the pair screen — the
 * same behavior the web app gets from logout().
 */
let onUnauthorized: (() => void) | null = null;
export function setUnauthorizedHandler(fn: (() => void) | null): void {
  onUnauthorized = fn;
}

/**
 * `timeoutMs` exists for one caller: Ask, which shells out to a headless CLI
 * and legitimately takes 30–60s. React Native's fetch has no timeout of its
 * own, so a request against a daemon that went away otherwise hangs the panel
 * forever with no error to show. Everything else leaves it unset and keeps the
 * old behaviour exactly.
 *
 * Routed: on Loom Cloud the same call rides the relay, and the daemon executes
 * it against itself with this same bearer token — so status codes, errors and
 * the 401 behaviour are identical on both paths.
 */
export async function api<T>(
  creds: Creds,
  path: string,
  init?: RequestInit,
  timeoutMs?: number,
): Promise<T> {
  connection.bind(creds);
  let route = creds.relay ? await connection.routeFor(creds) : "direct";
  if (route === "cloud") return viaRelay<T>(creds, path, init, timeoutMs);

  const ctl = timeoutMs ? new AbortController() : null;
  const timer = ctl ? setTimeout(() => ctl.abort(), timeoutMs) : null;
  let res: Response;
  try {
    res = await fetch(`${creds.url}${path}`, {
      ...init,
      ...(ctl ? { signal: ctl.signal } : {}),
      headers: {
        Authorization: `Bearer ${creds.token}`,
        ...(init?.body ? { "Content-Type": "application/json" } : {}),
        ...(init?.headers ?? {}),
      },
    });
  } catch (e) {
    // An abort reads as "Aborted"/"AbortError", which tells a user nothing about
    // what they were waiting for. Say what actually ran out.
    if (ctl?.signal.aborted) throw new Error(`timed out after ${Math.round(timeoutMs! / 1000)}s`);
    // The network went away under us (left the Wi-Fi, tailnet down). If this
    // pairing has a cloud route, re-decide and carry the call over.
    if (!init?.signal?.aborted) {
      route = await connection.directFailed(creds);
      if (route === "cloud") return viaRelay<T>(creds, path, init, timeoutMs);
    }
    throw e;
  } finally {
    if (timer) clearTimeout(timer);
  }
  connection.sawDirect(creds);
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return settle<T>(res.status, json);
}

async function viaRelay<T>(creds: Creds, path: string, init?: RequestInit, timeoutMs?: number): Promise<T> {
  const client = await connection.relayClient();
  let body: unknown;
  if (typeof init?.body === "string") {
    try {
      body = JSON.parse(init.body);
    } catch {
      body = init.body;
    }
  }
  const res = await client.request((init?.method ?? "GET").toUpperCase(), path, {
    auth: `Bearer ${creds.token}`,
    ...(body !== undefined ? { body } : {}),
    ...(timeoutMs ? { timeoutMs } : {}),
  });
  const json = (res.body && typeof res.body === "object" ? res.body : {}) as Record<string, unknown>;
  return settle<T>(res.status, json);
}

/**
 * A non-2xx from the daemon. Carries the status so a caller can tell "you may
 * not do this from a phone" (403) from "that failed" without parsing words.
 */
export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "ApiError";
  }
}

/** The shared tail of both routes: 401 unpairs, other errors carry the daemon's words. */
async function settle<T>(status: number, json: Record<string, unknown>): Promise<T> {
  if (status === 401) {
    await clearCreds();
    onUnauthorized?.();
    throw new Error("unauthorized — pair again");
  }
  if (status < 200 || status >= 300) throw new ApiError(String(json.message ?? json.error ?? `HTTP ${status}`), status);
  return json as T;
}

export const getProjects = (c: Creds) => api<{ projects: Project[] }>(c, "/api/projects");

export async function pingDaemon(c: Creds): Promise<DaemonReachability> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5_000);
  const startedAt = Date.now();

  try {
    const health = await api<{ ok: boolean; name?: string }>(c, "/api/health", {
      signal: controller.signal,
    });
    return {
      reachable: health.ok,
      latencyMs: Date.now() - startedAt,
      ...(health.name ? { name: health.name } : {}),
    };
  } catch {
    return { reachable: false };
  } finally {
    clearTimeout(timeout);
  }
}

export const getProject = (c: Creds, id: string) =>
  api<{ project: Project }>(c, `/api/projects/${id}`);
export const getEvents = (c: Creds, id: string, chatId?: string, limit = 60) =>
  api<{ events: LoomEvent[] }>(
    c,
    `/api/projects/${id}/events?limit=${limit}${chatId ? `&chat=${encodeURIComponent(chatId)}` : ""}`,
  );
export const getChats = (c: Creds, id: string) =>
  api<{ chats: Chat[] }>(c, `/api/projects/${id}/chats`);
export const getTree = (c: Creds, id: string) =>
  api<{ tree: WorkingTree }>(c, `/api/projects/${id}/tree`);
export const getMetrics = (c: Creds, id: string) =>
  api<{ metrics: Metrics }>(c, `/api/projects/${id}/metrics`);
export const getTriage = (c: Creds, id: string, agentId: string) =>
  api<{ triage: Triage }>(c, `/api/projects/${id}/triage/${encodeURIComponent(agentId)}`);
export const getTasks = (c: Creds, id: string, kind: "issue" | "pr", search: string) =>
  api<TaskResult>(c, `/api/projects/${id}/tasks?kind=${kind}&search=${encodeURIComponent(search)}`);
/** `plan: true` asks the agent for a plan markdown file instead of code. */
export const sendMessage = (
  c: Creds,
  id: string,
  text: string,
  agentId?: string,
  chat?: string,
  opts?: { plan?: boolean },
) =>
  api(c, `/api/projects/${id}/messages`, {
    method: "POST",
    body: JSON.stringify({
      text,
      ...(agentId ? { agentId } : {}),
      ...(chat ? { chat } : {}),
      ...(opts?.plan ? { plan: true } : {}),
    }),
  });
export const handoff = (c: Creds, id: string, to: string) =>
  api(c, `/api/projects/${id}/handoff`, { method: "POST", body: JSON.stringify({ to }) });
export const interrupt = (c: Creds, id: string) =>
  api(c, `/api/projects/${id}/interrupt`, { method: "POST", body: "{}" });
export const startRoute = (c: Creds, id: string, task: string, spec: string) =>
  api(c, `/api/projects/${id}/route`, { method: "POST", body: JSON.stringify({ task, spec }) });
export const abortRoute = (c: Creds, id: string) =>
  api(c, `/api/projects/${id}/route`, { method: "DELETE" });

// --- Observatory ------------------------------------------------------------

/** Turn/handoff/error spans. `from` says whether the backend answered or the log did. */
export const getSpans = (c: Creds, id: string, agentId?: string, limit = 200) =>
  api<{ from: SpanSource; spans: InsightSpan[] }>(
    c,
    `/api/projects/${id}/insights/spans?limit=${limit}${agentId ? `&agent=${encodeURIComponent(agentId)}` : ""}`,
  );

/** Fleet health: one score per agent plus the overall, scored from their own spans. */
export const getHealth = (c: Creds, id: string) =>
  api<{ from: SpanSource; overall: Health; byAgent: Record<string, Health> }>(
    c,
    `/api/projects/${id}/insights/health`,
  );

/**
 * The fleet's own log lines, newest first.
 *
 * `severity` is a comma list and case-insensitive ("error,warn"); `q` is a plain
 * substring of the body, not a pattern. The daemon clamps `limit` to 1–1000, and
 * this clamps too so a caller's mistake is a smaller request rather than a
 * silently different one.
 */
export const getLogs = (
  c: Creds,
  id: string,
  opts: { severity?: string; q?: string; agent?: string; traceId?: string; limit?: number } = {},
) => {
  // Built by hand rather than with URLSearchParams: React Native ships a partial
  // polyfill whose toString() throws, so the browser habit breaks on device.
  const qs = [`limit=${Math.min(1000, Math.max(1, opts.limit ?? 300))}`];
  if (opts.severity) qs.push(`severity=${encodeURIComponent(opts.severity)}`);
  if (opts.q) qs.push(`q=${encodeURIComponent(opts.q)}`);
  if (opts.agent) qs.push(`agent=${encodeURIComponent(opts.agent)}`);
  if (opts.traceId) qs.push(`traceId=${encodeURIComponent(opts.traceId)}`);
  return api<{ from: LogSource; logs: InsightLog[] }>(
    c,
    `/api/projects/${id}/insights/logs?${qs.join("&")}`,
  );
};

/**
 * Lift a pause by hand — the operator override for a flapping rule or a
 * threshold set too tight. 404s when the agent isn't actually paused.
 *
 * It answers with the whole quarantine map as it stands after the delete, and
 * that map is the only thing a caller should redraw from: any project object it
 * already holds was fetched before this request and no longer describes the
 * fleet.
 */
export const liftQuarantine = (c: Creds, id: string, agentId: string) =>
  api<{ lifted: boolean; agentId: string; was: QuarantineEntry; quarantine: QuarantineMap }>(
    c,
    `/api/projects/${id}/quarantine/${encodeURIComponent(agentId)}`,
    { method: "DELETE" },
  );

export const getDecisions = (c: Creds, id: string, limit = 200) =>
  api<{ decisions: AgentDecision[]; stats: DecisionStats }>(
    c,
    `/api/projects/${id}/decisions?limit=${limit}`,
  );

export const getSnapshots = (c: Creds, id: string) =>
  api<{ snapshots: TimeSnapshot[] }>(c, `/api/projects/${id}/snapshots`);

/**
 * Ask the Observatory a question. The daemon runs a headless CLI with the
 * project's real MCP servers attached, so this is slow by construction — two
 * minutes is the ceiling, not the expectation.
 */
export const askObservatory = (c: Creds, id: string, question: string) =>
  api<AskResult>(
    c,
    `/api/projects/${id}/observatory/ask`,
    { method: "POST", body: JSON.stringify({ question }) },
    120_000,
  );

// --- Skills -----------------------------------------------------------------

export const getSkillsCatalog = (c: Creds, id: string) =>
  api<{ skills: SkillEntry[] }>(c, `/api/projects/${id}/skills/catalog`);

export const setSkillEnabled = (c: Creds, id: string, skillId: string, enabled: boolean) =>
  api<{ skills: unknown }>(c, `/api/projects/${id}/skills/${encodeURIComponent(skillId)}`, {
    method: "PUT",
    body: JSON.stringify({ enabled }),
  });

/** Install from a git remote or from a directory on the daemon's own machine. */
export const installSkill = (c: Creds, id: string, from: { gitUrl?: string; dir?: string }) =>
  api<{ skill: SkillEntry; skills: SkillEntry[] }>(c, `/api/projects/${id}/skills/install`, {
    method: "POST",
    body: JSON.stringify(from),
  });

// --- MCP servers ------------------------------------------------------------

/** Not project-scoped: it is the same public registry for every project. */
export const getMcpCatalog = (c: Creds, q: string) =>
  api<McpCatalog>(c, `/api/mcp/catalog?q=${encodeURIComponent(q)}`);

export const getMcps = (c: Creds, id: string) =>
  api<{ mcps: McpServer[]; probed: boolean }>(c, `/api/projects/${id}/mcps`);

export const installMcp = (c: Creds, id: string, server: Partial<McpCatalogEntry> & { name: string }) =>
  api<{ installed: McpServer | null; mcps: McpServer[] }>(c, `/api/projects/${id}/mcps/install`, {
    method: "POST",
    body: JSON.stringify(server),
  });

export const removeMcp = (c: Creds, id: string, name: string) =>
  api<{ removed: boolean; mcps: McpServer[] }>(
    c,
    `/api/projects/${id}/mcps/${encodeURIComponent(name)}`,
    { method: "DELETE" },
  );

// --- Agent settings ---------------------------------------------------------

/** 409 when the agent holds the baton or is mid-turn — the daemon refuses, we surface why. */
export const setAgentEnabled = (c: Creds, id: string, agentId: string, enabled: boolean) =>
  api<AgentStatus>(c, `/api/projects/${id}/agents/${encodeURIComponent(agentId)}/enabled`, {
    method: "PUT",
    body: JSON.stringify({ enabled }),
  });

export const setAgentRole = (c: Creds, id: string, agentId: string, role: string) =>
  api<AgentStatus>(c, `/api/projects/${id}/agents/${encodeURIComponent(agentId)}/role`, {
    method: "POST",
    body: JSON.stringify({ role }),
  });

// --- Orchestra --------------------------------------------------------------

export type OrchestraStatus =
  | "starting"
  | "planning"
  | "running"
  | "reviewing"
  | "waiting_human"
  | "completed"
  | "failed"
  | "aborted";

export type OrchestraTaskStatus =
  | "pending"
  | "running"
  | "done"
  | "conflict"
  | "needs_input"
  | "failed"
  | "cancelled";

/**
 * Why a ready task isn't running yet (Loom Teams, Phase 2). "decide" waits on
 * the orchestrator; "wait" on a teammate's goal (the owner can stop waiting);
 * "zone" on a teammate's hard-zone lease; "capacity" on the team's caps.
 */
export interface OrchestraTaskHold {
  kind: "decide" | "wait" | "zone" | "capacity";
  reason: string;
  /** wait: the teammate goal this task waits on. */
  runId?: string;
  /** zone: the hard zone and who holds it. */
  zone?: string;
  holder?: string;
  since: number;
}

/** One unit of work a worker agent runs on its own branch. `chat` is its thread. */
export interface OrchestraTask {
  id: string;
  title: string;
  agent: string;
  kind: string;
  dependsOn: string[];
  status: OrchestraTaskStatus;
  chat: string;
  attempts: number;
  files?: string[];
  error?: string;
  result?: string;
  costUsd?: number;
  /** File globs the orchestrator declared this task will touch; teammates see them. */
  touches?: string[];
  /** The orchestrator's answer to a teammate overlap: wait:<goal> | narrow | proceed:<reason>. */
  overlap?: string;
  hold?: OrchestraTaskHold;
}

/** One orchestrator, many parallel workers, one integration branch. */
export interface OrchestraRun {
  id: string;
  goal: string;
  orchestrator: { agent: string; kind: string };
  workers: string[];
  status: OrchestraStatus;
  chat: string;
  branch: string;
  tasks: OrchestraTask[];
  round: number;
  maxRounds: number;
  maxParallel: number;
  summary?: string;
  question?: string;
  error?: string;
  applied?: { at: number; into: string };
  /** Plan mode: PLAN.md plus one spec per task, written under plans/<run id>/ on the branch. */
  plan?: boolean;
  /** What the git delivery policy did with the finished run. */
  delivered?: { mode: GitDelivery; into?: string; pushed?: string; prUrl?: string; at?: number };
  /** Set when delivery was attempted and failed (push rejected, gh missing…). */
  deliveryError?: string;
  costUsd: number;
  createdAt: number;
  /** Things the team coordinator told the orchestrator (drift, predicted conflicts). */
  notes?: string[];
}

/** Where a run's plan lives inside the repo — the daemon's planDir(). */
export const planPath = (run: { id: string }) => `plans/${run.id}/PLAN.md`;

export const getOrchestra = (c: Creds, id: string) =>
  api<{ runs: OrchestraRun[]; active: string | null }>(c, `/api/projects/${id}/orchestra`);

export const getOrchestraRun = (c: Creds, id: string, runId: string) =>
  api<{ run: OrchestraRun }>(c, `/api/projects/${id}/orchestra/${encodeURIComponent(runId)}`);

export const startOrchestra = (
  c: Creds,
  id: string,
  opts: { goal: string; orchestrator?: string; workers?: string[]; maxParallel?: number; plan?: boolean },
) => api<{ run: OrchestraRun }>(c, `/api/projects/${id}/orchestra`, { method: "POST", body: JSON.stringify(opts) });

export const abortOrchestra = (c: Creds, id: string, runId: string) =>
  api<{ run: OrchestraRun }>(c, `/api/projects/${id}/orchestra/${encodeURIComponent(runId)}/abort`, {
    method: "POST",
    body: "{}",
  });

export const replyOrchestra = (c: Creds, id: string, runId: string, text: string) =>
  api<{ run: OrchestraRun }>(c, `/api/projects/${id}/orchestra/${encodeURIComponent(runId)}/reply`, {
    method: "POST",
    body: JSON.stringify({ text }),
  });

export const applyOrchestra = (c: Creds, id: string, runId: string) =>
  api<{ merged: boolean; into: string }>(c, `/api/projects/${id}/orchestra/${encodeURIComponent(runId)}/apply`, {
    method: "POST",
    body: "{}",
  });

/** Re-run the delivery policy (after fixing a push rejection, say). Answers with the run. */
export const deliverOrchestra = (c: Creds, id: string, runId: string) =>
  api<{ run: OrchestraRun }>(c, `/api/projects/${id}/orchestra/${encodeURIComponent(runId)}/deliver`, {
    method: "POST",
    body: "{}",
  });

/** Release a task's `wait` hold: it proceeds alongside the teammate's goal. */
export const stopWaitingOrchestra = (c: Creds, id: string, runId: string, taskId: string) =>
  api<{ task: OrchestraTask }>(
    c,
    `/api/projects/${id}/orchestra/${encodeURIComponent(runId)}/tasks/${encodeURIComponent(taskId)}/stop-waiting`,
    { method: "POST", body: "{}" },
  );

// --- Permissions ------------------------------------------------------------

export type PermissionMode = "bypass" | "auto" | "ask";
export const PERMISSION_MODES: ReadonlyArray<PermissionMode> = ["bypass", "auto", "ask"];

/** One cell of the table: what the agent is run with, and whether it works at all. */
export interface PermissionCell {
  flags: string;
  label: string;
  /** How "ask" is honoured: real approvals in Loom, or a read-only stand-in. */
  ask?: "approvals" | "read-only";
  /** Measured against the real CLI: this mode doesn't do what it says. Shown disabled. */
  unsupported?: string;
}

export interface PermissionProfile {
  default: PermissionMode;
  modes: Record<PermissionMode, PermissionCell>;
}

export const getPermissionProfiles = (c: Creds) =>
  api<{ profiles: Record<string, PermissionProfile> }>(c, "/api/permissions");

/** 400 with the daemon's reason when the mode is unsupported or the agent is mid-turn. */
export const setAgentPermissions = (c: Creds, id: string, agentId: string, permissions: PermissionMode) =>
  api<{ agent: unknown }>(c, `/api/projects/${id}/agents/${encodeURIComponent(agentId)}/permissions`, {
    method: "POST",
    body: JSON.stringify({ permissions }),
  });

// --- Approvals --------------------------------------------------------------

/** A tool call waiting on a human. `input` is the raw tool input (object) from GET. */
export interface Approval {
  id: string;
  agent: string;
  tool: string;
  input: unknown;
  createdAt: number;
}

export const getApprovals = (c: Creds, id: string) =>
  api<{ approvals: Approval[] }>(c, `/api/projects/${id}/approvals`);

/** 404 means someone (or the 30-minute timeout) already answered it. */
export const decideApproval = (
  c: Creds,
  id: string,
  approvalId: string,
  decision: "allow" | "deny",
  message?: string,
) =>
  api<{ ok: boolean }>(c, `/api/projects/${id}/approvals/${encodeURIComponent(approvalId)}`, {
    method: "POST",
    body: JSON.stringify({ decision, ...(message ? { message } : {}) }),
  });

// --- Git delivery -----------------------------------------------------------

export type GitDelivery = "none" | "commit" | "push" | "pr";

export interface ProjectConfig {
  git: {
    delivery: GitDelivery;
    commitPerTurn?: boolean;
    branchPerTask?: boolean;
    worktreePerAgent?: boolean;
  };
}

export const getProjectConfig = (c: Creds, id: string) => api<ProjectConfig>(c, `/api/projects/${id}/config`);

export const setGitDelivery = (c: Creds, id: string, delivery: GitDelivery) =>
  api<ProjectConfig>(c, `/api/projects/${id}/config`, {
    method: "PATCH",
    body: JSON.stringify({ git: { delivery } }),
  });

// --- Fleet activity ---------------------------------------------------------

export interface ActivityLast {
  line: string;
  ts: number;
  kind?: string;
  chat?: string;
}

export interface ActivityAgent {
  id: string;
  kind: string;
  role?: string;
  busy: boolean;
  since: number | null;
  permissions?: PermissionMode;
  holdsBaton: boolean;
  chat: string | null;
  chatTitle: string | null;
  last: ActivityLast | null;
}

export interface ActivityTask {
  id: string;
  title: string;
  agent: string;
  status: OrchestraTaskStatus;
  chat: string;
  last: ActivityLast | null;
}

export interface ActivityProject {
  project: { id: string; name: string };
  agents: ActivityAgent[];
  orchestra: { id: string; goal: string; status: OrchestraStatus; chat?: string; tasks: ActivityTask[] } | null;
}

export const getActivity = (c: Creds) =>
  api<{ projects: ActivityProject[]; approvals: number; at: number }>(c, "/api/activity");

// --- Loom Teams --------------------------------------------------------------

export interface TeamMember {
  id: string;
  github: string;
  name: string;
  role: string;
}

/** What a teammate's agent is about: titles only, never a transcript. */
export interface TeamIntent {
  goal?: string;
  task?: string;
  thread?: string;
}

export interface TeamPresence {
  github: string;
  repo: string;
  agent: string;
  kind: string;
  branch?: string;
  touches: string[];
  state: string;
  since: number;
  mine: boolean;
  intent: TeamIntent | null;
}

export interface TeamFeedEvent {
  type: string;
  github: string | null;
  ts: number;
  repo?: string;
  meta: {
    number?: number;
    url?: string;
    checks?: string[];
    runId?: string;
    prUrl?: string;
    status?: string;
    [k: string]: unknown;
  };
  content: { goal?: string; summary?: string; title?: string } | null;
}

/** A file lease one orchestra task holds on a shared repo. Titles only, sealed to the team. */
export interface TeamLease {
  id: string;
  github: string;
  repo: string;
  runId: string;
  taskId: string;
  globs: string[];
  fileCount: number;
  files?: string[];
  /** active while the task runs; landing after it finishes, until the goal's PR merges. */
  state: "active" | "landing";
  /** No renewal lately: the owner's laptop is probably asleep. */
  stale: boolean;
  intent: { goal?: string; task?: string } | null;
  mine: boolean;
  since?: number;
  ts?: number;
}

export interface TeamView {
  id: string;
  name: string;
  role: string;
  keyVersion: number | null;
  members: TeamMember[];
  repos: string[];
  presence: TeamPresence[];
  feed: TeamFeedEvent[];
  /** Phase 2; missing from an older daemon. */
  leases?: TeamLease[];
  /** Phase 4: spend rolled up from the team feed; null/missing when there's no feed yet. */
  costs?: TeamCosts | null;
}

/** What the team's goals cost (D64): per member per UTC day, and per landed PR. */
export interface TeamCosts {
  byMemberDay: Array<{ member: string; day: string; usd: number; goals: number }>;
  landed: number;
  totalUsd: number;
  perLandedPrUsd: number | null;
}

export interface TeamStatus {
  signedIn: boolean;
  hub: string | null;
  github: string | null;
  teams: TeamView[];
}

export type TeamAction = "invite" | "join" | "signin" | "create" | "leave";

export const getTeam = (c: Creds) => api<TeamStatus>(c, "/api/team");

/** Membership changes are admin-only on the daemon: a paired phone gets a 403 (ApiError.status). */
export const teamAction = <R = unknown>(c: Creds, action: TeamAction, body: Record<string, string> = {}) =>
  api<{ result: R; team: TeamStatus }>(c, `/api/team/${action}`, { method: "POST", body: JSON.stringify(body) });

/** `loom.team.json` in effect for a project: reviewed from origin, tightened by a local copy. */
export interface TeamPolicy {
  hardZones: string[];
  permissions: { ceiling: PermissionMode; bypassRequiresPlan: boolean };
  /** null = any agent */
  agents: { allow: string[] | null };
  delivery: { protected: string[] };
  orchestra: { maxParallelPerMember: number | null; teamMaxConcurrentAgents: number | null };
  source: "origin" | "local" | "none";
}

export const getTeamPolicy = (c: Creds, id: string) =>
  api<{ policy: TeamPolicy }>(c, `/api/projects/${id}/team/policy`);

// --- Team brain (Loom Teams Phase 3) ------------------------------------------

export type BrainTier = "canon" | "confirmed" | "own" | "proposed";

/** One team memory as the daemon shows it: canon from git, or a sealed team memory, or yours. */
export interface BrainMemory {
  id: string;
  text: string;
  kind: string;
  tier: BrainTier;
  /** null for canon: it came from a reviewed PR, not a person. */
  author: string | null;
  confirmedBy: string[];
  mine: boolean;
  /** Learned while reading outside content; stays local until trusted. */
  untrusted?: boolean;
  /** Only on the memories list (history=1 adds the non-live ones). */
  state?: "live" | "superseded" | "forgotten";
  supersedes?: string;
  supersededBy?: string;
  resolvedBy?: string;
  resolvedReason?: string;
}

/** Something in the team brain that needs a human. */
export interface BrainInboxItem {
  id: string;
  type: "contradiction" | "duplicate" | "correction" | "untrusted" | "promote";
  detail: string;
  a: BrainMemory;
  b?: BrainMemory;
}

export interface BrainStatus {
  shared: boolean;
  teamId: string | null;
  repo: string | null;
  canon: number;
  team: number;
  confirmed: number;
  mine: number;
  lastError: string | null;
}

export interface TeamBrain {
  status: BrainStatus;
  memories: BrainMemory[];
  inbox: BrainInboxItem[];
}

export type BrainAction = "sync" | "promote" | "correct" | "resolve" | "merge" | "trust" | "private";

export interface PromoteResult {
  branch: string;
  prUrl: string | null;
  added: number;
  note?: string;
}

/** `sync` pulls the team's memories first (slower, hits the hub and git); `history` adds resolved ones. */
export const getTeamBrain = (c: Creds, id: string, opts: { sync?: boolean; history?: boolean } = {}) => {
  const q = [opts.sync ? "sync=1" : null, opts.history ? "history=1" : null].filter(Boolean).join("&");
  return api<TeamBrain>(c, `/api/projects/${id}/team/brain${q ? `?${q}` : ""}`);
};

/** Every action answers with the brain as it now stands, so the screen never refetches. */
export const teamBrainAction = <R = unknown>(c: Creds, id: string, action: BrainAction, body: Record<string, unknown> = {}) =>
  api<TeamBrain & { result: R }>(c, `/api/projects/${id}/team/brain/${action}`, {
    method: "POST",
    body: JSON.stringify(body),
  });

// --- Landing (Loom Teams Phase 4) ---------------------------------------------

export type LandingStateName =
  | "open"
  | "pending"
  | "green"
  | "failing"
  | "fixing"
  | "needs_human"
  | "landing"
  | "merged"
  | "closed";

/** A goal PR's journey to main, as the daemon keeps it on the run (core/orchestra.ts). */
export interface LandingState {
  pr: number;
  url: string;
  state: LandingStateName;
  /** The PR commit checks and the review ran against; Re-review needs one. */
  headSha?: string;
  fixAttempts: number;
  flaky: string[];
  checks?: { failing: string[]; pending: string[]; passing: number };
  reviews: number;
  review?: {
    state: "success" | "failure" | "skipped";
    reviewer: string | null;
    high: number;
    findings: number;
    at?: number;
    overridden?: string;
  };
  /** Why it waits on a human. */
  reason?: string;
  landRequested?: boolean;
  /** A teammate holds this goal right now. */
  adoptedBy?: string;
  returned?: boolean;
  stack?: Array<{ pr: number; url: string; branch: string; base: string; state?: string }>;
  updatedAt?: number;
}

export interface LandingGoal {
  runId: string;
  goal: string;
  /** The run's OrchestraStatus; a string so a newer daemon's status still parses. */
  status: string;
  costUsd: number;
  /** This run adopted a teammate's PR. */
  adopted?: { branch: string; pr: number; url: string; ownerRunId?: string; owner?: string };
  landing: LandingState;
}

/** A teammate's goal PR that has waited long enough for someone else to pick it up. */
export interface AdoptablePr {
  pr: number;
  url: string;
  branch: string;
  owner: string;
  ownerRunId?: string;
  reason: string;
}

export interface TeamLanding {
  goals: LandingGoal[];
  adoptable: AdoptablePr[];
}

export type LandingAction = "land" | "poll" | "review" | "override" | "adopt";

/** `poll` asks the daemon to check the PRs with the git host first (slower). */
export const getTeamLanding = (c: Creds, id: string, opts: { poll?: boolean } = {}) =>
  api<TeamLanding>(c, `/api/projects/${id}/team/landing${opts.poll ? "?poll=1" : ""}`);

/** Every action answers with the goals as they now stand (not `adoptable`). */
export const teamLandingAction = <R = unknown>(c: Creds, id: string, action: LandingAction, body: Record<string, unknown> = {}) =>
  api<{ result: R; goals: LandingGoal[] }>(c, `/api/projects/${id}/team/landing/${action}`, {
    method: "POST",
    body: JSON.stringify(body),
  });

// --- Prompt manager ---------------------------------------------------------

export interface SavedPrompt {
  id: string;
  title: string;
  text: string;
  pinned: boolean;
  uses: number;
}

export interface RecentPrompt {
  text: string;
  at: number;
  mode?: string;
}

export const getPrompts = (c: Creds, q = "") =>
  api<{ saved: SavedPrompt[]; recent: RecentPrompt[] }>(c, `/api/prompts?q=${encodeURIComponent(q)}`);

export const savePrompt = (c: Creds, p: { title?: string; text: string; pinned?: boolean }) =>
  api<{ prompt: SavedPrompt }>(c, "/api/prompts", { method: "POST", body: JSON.stringify(p) });

export const updatePrompt = (c: Creds, promptId: string, patch: { pinned?: boolean; used?: true }) =>
  api<{ prompt: SavedPrompt }>(c, `/api/prompts/${encodeURIComponent(promptId)}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });

export const deletePrompt = (c: Creds, promptId: string) =>
  api<{ ok: boolean }>(c, `/api/prompts/${encodeURIComponent(promptId)}`, { method: "DELETE" });

export function wsUrl(creds: Creds, projectId?: string): string {
  const proto = creds.url.startsWith("https") ? "wss" : "ws";
  const host = creds.url.replace(/^https?:\/\//, "");
  const project = projectId ? `&project=${encodeURIComponent(projectId)}` : "";
  return `${proto}://${host}/ws?token=${encodeURIComponent(creds.token)}${project}`;
}

/**
 * The project's live event feed, on whichever route is up: the /ws socket when
 * direct, the relay's stream when on Loom Cloud. Frames are identical either
 * way. It follows the connection manager — a route change or a long trip to the
 * background tears the feed down and opens a fresh one. Returns the closer.
 *
 * With no project it is the daemon-level feed (team frames, for a full client).
 */
export function openLiveStream(creds: Creds, projectId: string | undefined, onFrame: (frame: unknown) => void): () => void {
  let closed = false;
  let mode: "direct" | "cloud" | null = null;
  let ws: WebSocket | null = null;
  let relay: RelayClient | null = null;
  let retry: ReturnType<typeof setTimeout> | null = null;
  let chain: Promise<void> = Promise.resolve();

  const stop = () => {
    if (retry) clearTimeout(retry);
    retry = null;
    if (ws) {
      ws.onclose = null;
      ws.onmessage = null;
      ws.close();
      ws = null;
    }
    relay?.closeStream();
    relay = null;
    mode = null;
  };

  const later = (fn: () => void, ms: number) => {
    if (retry) clearTimeout(retry);
    retry = setTimeout(() => {
      retry = null;
      fn();
    }, ms);
  };

  const startDirect = () => {
    const sock = new WebSocket(wsUrl(creds, projectId));
    ws = sock;
    sock.onmessage = (msg) => {
      try {
        onFrame(JSON.parse(String(msg.data)));
      } catch {
        // ignore malformed frames
      }
    };
    sock.onclose = () => {
      if (ws !== sock || closed) return;
      ws = null;
      mode = null;
      // With a cloud route to fall back on, a dropped socket is a reason to re-decide.
      later(() => void (creds.relay ? connection.directFailed(creds).then(() => pick()) : pick()), 3000);
    };
  };

  const pickNow = async (force: boolean) => {
    if (closed) return;
    const route = creds.relay ? await connection.routeFor(creds) : "direct";
    if (closed) return;
    const want = route === "cloud" ? "cloud" : "direct"; // offline keeps knocking on the direct door
    if (!force && want === mode) return;
    stop();
    mode = want;
    if (want === "direct") return startDirect();
    try {
      const client = await connection.relayClient();
      if (closed || mode !== "cloud") return;
      relay = client;
      client.openStream(`Bearer ${creds.token}`, { onFrame }, projectId);
    } catch {
      mode = null;
      later(() => void pick(), 3000);
    }
  };
  // Serialised, so a route event and a retry can't both open a socket.
  const pick = (force = false): Promise<void> => (chain = chain.then(() => pickNow(force)).catch(() => {}));

  const offRoute = connection.subscribe((r) => {
    if (r === "direct" || r === "cloud") void pick();
  });
  const offResume = connection.onResume(() => void pick(true));
  void pick();
  return () => {
    closed = true;
    offRoute();
    offResume();
    stop();
  };
}
