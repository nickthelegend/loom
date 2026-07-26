/**
 * Thin client over the loom daemon API (same endpoints as the CLI/web app).
 * Credentials (daemon URL + client token) live in the device keychain.
 */

import * as SecureStore from "expo-secure-store";
import { Platform } from "react-native";

// Credentials live in the device keychain on native; on web (Expo web, used for
// the browser demo) SecureStore isn't available, so fall back to localStorage.
const kv = {
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

export interface Creds {
  url: string; // e.g. http://100.x.y.z:7420
  token: string;
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

export async function loadCreds(): Promise<Creds | null> {
  const [url, token] = await Promise.all([kv.get(URL_KEY), kv.get(TOKEN_KEY)]);
  return url && token ? { url, token } : null;
}

export async function saveCreds(creds: Creds): Promise<void> {
  await Promise.all([kv.set(URL_KEY, creds.url), kv.set(TOKEN_KEY, creds.token)]);
}

export async function clearCreds(): Promise<void> {
  await Promise.all([kv.del(URL_KEY), kv.del(TOKEN_KEY)]);
}

/** Exchange a single-use pairing token (from `loom pair`) for a client token. */
export async function claim(url: string, pairToken: string): Promise<Creds> {
  const base = url.replace(/\/+$/, "").replace(/\/app.*$/, "");
  const res = await fetch(`${base}/api/pair/claim`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: pairToken, name: "loom-app" }),
  });
  const json = (await res.json()) as { clientToken?: string; error?: string };
  if (!res.ok || !json.clientToken) throw new Error(json.error ?? "pairing failed");
  return { url: base, token: json.clientToken };
}

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
 */
export async function api<T>(
  creds: Creds,
  path: string,
  init?: RequestInit,
  timeoutMs?: number,
): Promise<T> {
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
    throw e;
  } finally {
    if (timer) clearTimeout(timer);
  }
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (res.status === 401) {
    await clearCreds();
    onUnauthorized?.();
    throw new Error("unauthorized — pair again");
  }
  if (!res.ok) throw new Error(String(json.message ?? json.error ?? `HTTP ${res.status}`));
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
export const sendMessage = (c: Creds, id: string, text: string, agentId?: string, chat?: string) =>
  api(c, `/api/projects/${id}/messages`, {
    method: "POST",
    body: JSON.stringify({ text, ...(agentId ? { agentId } : {}), ...(chat ? { chat } : {}) }),
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

export function wsUrl(creds: Creds, projectId: string): string {
  const proto = creds.url.startsWith("https") ? "wss" : "ws";
  const host = creds.url.replace(/^https?:\/\//, "");
  return `${proto}://${host}/ws?token=${encodeURIComponent(creds.token)}&project=${encodeURIComponent(projectId)}`;
}
