/**
 * Thin daemon client used by every surface (CLI now, app later).
 * Also owns daemon lifecycle: autostart-on-demand, health, shutdown.
 */

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import type {
  AgentConfig,
  CostSummary,
  LoomEvent,
  ProjectStatus,
  RouteState,
  RouteStepSpec,
  UnifiedMemory,
} from "../types.js";
import type { OrchestraRun } from "../core/orchestra.js";
import type { QueueItem } from "../core/prompt-queue.js";
import type { LogLine, ServerConfig, ServerStatus } from "../core/servers.js";
import {
  readDaemonConfig,
  type DaemonConfig,
} from "../core/registry.js";
import type { Memory } from "../core/brain.js";
import type { BoardData } from "./board.js";
import { BUILD_REV, DEFAULT_PORT } from "./server.js";

export class DaemonError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    public readonly body?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "DaemonError";
  }
}

/** What the daemon says about whether this copy of Loom is current. */
export interface UpdateStatus {
  version: string;
  rev: string;
  root: string | null;
  git: { behind: number; ahead: number; branch: string } | null;
  latest: string | null;
  release: { version: string; tag: string; url: string; publishedAt: string | null } | null;
  behindRelease: boolean;
  install: "git" | "npm-global" | "unknown";
  canApply: boolean;
  refusal: string | null;
  /** Exactly what applying would run, in order. */
  steps: string[];
}

/** What the daemon says about a project's prompt queue. */
export interface QueueView {
  queue: QueueItem[];
  paused: boolean;
  /** Why it paused itself (a refused send, a Stop, a restart). */
  reason?: string;
  /** What the head is waiting for, when it's waiting on something. */
  waitingFor?: string;
}

export class DaemonClient {
  private cfg: DaemonConfig;

  constructor(cfg: DaemonConfig) {
    this.cfg = cfg;
  }

  static fromDisk(): DaemonClient | null {
    const cfg = readDaemonConfig();
    return cfg ? new DaemonClient(cfg) : null;
  }

  get baseUrl(): string {
    return `http://${this.cfg.host}:${this.cfg.port}`;
  }

  private async request<T>(
    method: string,
    pathName: string,
    body?: Record<string, unknown>,
  ): Promise<T> {
    const res = await fetch(`${this.baseUrl}${pathName}`, {
      method,
      headers: {
        authorization: `Bearer ${this.cfg.adminToken}`,
        ...(body ? { "content-type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(30_000),
    });
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      throw new DaemonError(
        String(json.message ?? json.error ?? `${method} ${pathName} → ${res.status}`),
        res.status,
        json,
      );
    }
    return json as T;
  }

  health(): Promise<{ ok: boolean }> {
    return this.request("GET", "/api/health");
  }

  listProjects(): Promise<{ projects: ProjectStatus[] }> {
    return this.request("GET", "/api/projects");
  }

  addProject(dir: string, name?: string): Promise<{ project: { id: string } }> {
    return this.request("POST", "/api/projects", { dir, ...(name ? { name } : {}) });
  }

  /** Stop tracking a project. Registry-only — its .loom/ stays on disk. */
  forgetProject(id: string): Promise<{ removed: boolean; keptOnDisk: string }> {
    return this.request("DELETE", `/api/projects/${encodeURIComponent(id)}`);
  }

  project(id: string): Promise<{ project: ProjectStatus }> {
    return this.request("GET", `/api/projects/${encodeURIComponent(id)}`);
  }

  models(id: string, agentId: string): Promise<{ kind: string; count: number; models: string[] }> {
    return this.request(
      "GET",
      `/api/projects/${encodeURIComponent(id)}/agents/${encodeURIComponent(agentId)}/models`,
    );
  }

  /**
   * Add an agent to a project's roster.
   *
   * `as` names the instance. Leave it off and the daemon picks the next free id
   * for the kind, so asking twice gives you two sessions rather than an error.
   */
  addAgent(
    id: string,
    kind: string,
    opts: { as?: string; role?: string } = {},
  ): Promise<AgentConfig> {
    return this.request("POST", `/api/projects/${encodeURIComponent(id)}/agents`, {
      kind,
      ...(opts.as ? { id: opts.as } : {}),
      ...(opts.role ? { role: opts.role } : {}),
    });
  }

  /** Which agents this machine can drive, and how many of each are here. */
  availableAgents(id: string): Promise<{
    ades: Array<{
      kind: string;
      label: string;
      tier: string;
      installed: boolean | null;
      inProject: boolean;
      instances: number;
      canAddAnother: boolean;
    }>;
  }> {
    return this.request("GET", `/api/projects/${encodeURIComponent(id)}/agents/available`);
  }

  /**
   * Fan a subtask out to a child agent alongside the parent's turn.
   *
   * The parent keeps the baton — this is one turn borrowing another pair of
   * hands, not a handoff.
   */
  // ── orchestra (core/orchestra.ts) ──

  orchestraRuns(id: string): Promise<{ runs: OrchestraRun[]; active: string | null }> {
    return this.request("GET", `/api/projects/${encodeURIComponent(id)}/orchestra`);
  }

  orchestraRun(id: string, runId: string): Promise<{ run: OrchestraRun }> {
    return this.request("GET", `/api/projects/${encodeURIComponent(id)}/orchestra/${encodeURIComponent(runId)}`);
  }

  startOrchestra(
    id: string,
    body: { goal: string; orchestrator?: string; workers?: string[]; maxParallel?: number; maxRounds?: number; plan?: boolean },
  ): Promise<{ run: OrchestraRun }> {
    return this.request("POST", `/api/projects/${encodeURIComponent(id)}/orchestra`, body);
  }

  orchestraAction(
    id: string,
    runId: string,
    action: "abort" | "reply" | "apply" | "cleanup",
    body?: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.request(
      "POST",
      `/api/projects/${encodeURIComponent(id)}/orchestra/${encodeURIComponent(runId)}/${action}`,
      body ?? {},
    );
  }

  // ── Loom Teams (daemon/team.ts) ──

  team(): Promise<Record<string, unknown>> {
    return this.request("GET", "/api/team");
  }

  teamAction(action: string, body?: Record<string, unknown>): Promise<{ result: unknown; team: Record<string, unknown> }> {
    return this.request("POST", `/api/team/${action}`, body ?? {});
  }

  shareProject(id: string, teamId?: string): Promise<{ repo: string; teamId: string }> {
    return this.request("POST", `/api/projects/${encodeURIComponent(id)}/team/share`, teamId ? { teamId } : {});
  }

  unshareProject(id: string): Promise<{ ok: boolean }> {
    return this.request("DELETE", `/api/projects/${encodeURIComponent(id)}/team/share`);
  }

  /** The team brain for a project (Phase 3): status, memories with tiers, inbox. */
  teamBrain(id: string, opts: { sync?: boolean; history?: boolean } = {}): Promise<TeamBrainView> {
    const q = [opts.sync ? "sync=1" : "", opts.history ? "history=1" : ""].filter(Boolean).join("&");
    return this.request("GET", `/api/projects/${encodeURIComponent(id)}/team/brain${q ? `?${q}` : ""}`);
  }

  teamBrainAction(id: string, action: string, body: Record<string, unknown> = {}): Promise<TeamBrainView & { result: unknown }> {
    return this.request("POST", `/api/projects/${encodeURIComponent(id)}/team/brain/${action}`, body);
  }

  /** Goal PRs on their way to main, and teammates' goals to adopt (Phase 4). */
  landing(id: string, opts: { poll?: boolean } = {}): Promise<{ goals: Array<Record<string, unknown>>; adoptable: Array<Record<string, unknown>> }> {
    return this.request("GET", `/api/projects/${encodeURIComponent(id)}/team/landing${opts.poll ? "?poll=1" : ""}`);
  }

  landingAction(id: string, action: string, body: Record<string, unknown> = {}): Promise<{ result: unknown; goals: Array<Record<string, unknown>> }> {
    return this.request("POST", `/api/projects/${encodeURIComponent(id)}/team/landing/${action}`, body);
  }

  teamDoctor(id: string): Promise<{ repo: string | null; branch: string; findings: Array<{ level: string; what: string; fix?: string }>; fixable: string[] }> {
    return this.request("GET", `/api/projects/${encodeURIComponent(id)}/team/doctor`);
  }

  teamDoctorFix(id: string): Promise<{ prUrl: string | null; files: string[] }> {
    return this.request("POST", `/api/projects/${encodeURIComponent(id)}/team/doctor/fix`, {});
  }

  // ── runners, deploys, release notes (Phase 5) ──

  runner(): Promise<Record<string, unknown>> {
    return this.request("GET", "/api/runner");
  }

  runnerAction(action: string, body: Record<string, unknown> = {}): Promise<{ result: unknown }> {
    return this.request("POST", `/api/runner/${action}`, body);
  }

  runners(id: string): Promise<{ runners: Array<Record<string, unknown>>; jobs: Array<Record<string, unknown>> }> {
    return this.request("GET", `/api/projects/${encodeURIComponent(id)}/team/runners`);
  }

  runnersAction(id: string, action: string, body: Record<string, unknown> = {}): Promise<{ result: unknown; runners: Array<Record<string, unknown>>; jobs: Array<Record<string, unknown>> }> {
    return this.request("POST", `/api/projects/${encodeURIComponent(id)}/team/runners/${action}`, body);
  }

  deploys(id: string): Promise<{ deployments: Array<Record<string, unknown>> }> {
    return this.request("GET", `/api/projects/${encodeURIComponent(id)}/team/deploys`);
  }

  releaseNotes(id: string, since: string): Promise<{ markdown: string }> {
    return this.request("GET", `/api/projects/${encodeURIComponent(id)}/team/release-notes?since=${encodeURIComponent(since)}`);
  }

  // ── Loom Cloud (daemon/relay.ts) ──

  cloud(): Promise<Record<string, unknown>> {
    return this.request("GET", "/api/cloud");
  }

  cloudAction(action: "enable" | "disable" | "rotate", body?: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.request("POST", `/api/cloud/${action}`, body ?? {});
  }

  spawnSubtask(
    id: string,
    parent: string,
    agentId: string,
    task: string,
    chat?: string,
  ): Promise<{ id: string; agentId: string }> {
    return this.request("POST", `/api/projects/${encodeURIComponent(id)}/subtasks`, {
      parent,
      agentId,
      task,
      ...(chat ? { chat } : {}),
    });
  }

  subtasks(id: string): Promise<{
    subtasks: Array<{ id: string; parent: string; agentId: string; task: string }>;
  }> {
    return this.request("GET", `/api/projects/${encodeURIComponent(id)}/subtasks`);
  }

  listTasks(id: string): Promise<{
    tasks: Array<{ id: string; title: string; column: string; agent?: string; blockedBy?: string[] }>;
  }> {
    return this.request("GET", `/api/projects/${encodeURIComponent(id)}/board/tasks`);
  }

  createTask(
    id: string,
    title: string,
    opts: { column?: string; agent?: string; blockedBy?: string[] } = {},
  ): Promise<{ task: { id: string; title: string; column: string } }> {
    return this.request("POST", `/api/projects/${encodeURIComponent(id)}/board/tasks`, {
      title,
      ...opts,
    });
  }

  saveRoute(id: string, name: string, steps: string[]): Promise<{ routes: Record<string, unknown> }> {
    return this.request(
      "PUT",
      `/api/projects/${encodeURIComponent(id)}/routes/${encodeURIComponent(name)}`,
      { steps },
    );
  }

  deleteRoute(id: string, name: string): Promise<{ routes: Record<string, unknown> }> {
    return this.request(
      "DELETE",
      `/api/projects/${encodeURIComponent(id)}/routes/${encodeURIComponent(name)}`,
    );
  }

  /** Re-run the last failed turn on a different agent, failure attached. */
  retryTurn(id: string, agentId: string): Promise<{ agentId: string; retried: string }> {
    return this.request("POST", `/api/projects/${encodeURIComponent(id)}/retry`, { agentId });
  }

  budgets(id: string): Promise<{
    budgets: Record<string, number>;
    status: Record<string, { budgetUsd: number; spentTodayUsd: number; over: boolean }>;
  }> {
    return this.request("GET", `/api/projects/${encodeURIComponent(id)}/budgets`);
  }

  setBudget(id: string, agentId: string, usdPerDay: number): Promise<{ budgets: Record<string, number> }> {
    return this.request(
      "PUT",
      `/api/projects/${encodeURIComponent(id)}/budgets/${encodeURIComponent(agentId)}`,
      { usdPerDay },
    );
  }

  version(): Promise<{ rev: string; node: string; platform: string; uptimeSec: number; pid: number }> {
    return this.request("GET", "/api/version");
  }

  forgetMemory(id: string, memoryId: string): Promise<{ forgotten: boolean }> {
    return this.request(
      "DELETE",
      `/api/projects/${encodeURIComponent(id)}/brain/${encodeURIComponent(memoryId)}`,
    );
  }

  renameProject(id: string, name: string): Promise<{ project: { id: string; name: string } }> {
    return this.request("PATCH", `/api/projects/${encodeURIComponent(id)}`, { name });
  }

  searchEvents(id: string, q: string, limit = 20): Promise<{ hits: LoomEvent[] }> {
    return this.request(
      "GET",
      `/api/projects/${encodeURIComponent(id)}/events/search?q=${encodeURIComponent(q)}&limit=${limit}`,
    );
  }

  snapshot(id: string): Promise<Record<string, unknown>> {
    return this.request("GET", `/api/projects/${encodeURIComponent(id)}/snapshot`);
  }

  restore(id: string, doc: unknown): Promise<{ brain: { added: number; known: number }; tasks: number }> {
    return this.request("POST", `/api/projects/${encodeURIComponent(id)}/restore`, doc as Record<string, unknown>);
  }

  staleSessions(id: string): Promise<{ stale: Array<{ agentId: string; busyMs: number }> }> {
    return this.request("GET", `/api/projects/${encodeURIComponent(id)}/stale`);
  }

  reapSession(id: string, agentId: string): Promise<{ respawned: boolean }> {
    return this.request(
      "POST",
      `/api/projects/${encodeURIComponent(id)}/agents/${encodeURIComponent(agentId)}/reap`,
    );
  }

  logs(opts: { level?: "error" | "warn" | "info"; project?: string } = {}): Promise<{
    logs: Array<{ id: number; at: number; level: string; scope: string; message: string; detail?: string; project?: string }>;
  }> {
    const params = new URLSearchParams();
    if (opts.level) params.set("level", opts.level);
    if (opts.project) params.set("project", opts.project);
    const qs = params.toString();
    return this.request("GET", `/api/logs${qs ? `?${qs}` : ""}`);
  }

  searchBrain(
    id: string,
    q: string,
    opts: { agent?: string; explain?: boolean; limit?: number } = {},
  ): Promise<{ hits: Array<{ memory: Memory; score: number; detail?: Record<string, unknown> }> }> {
    const params = new URLSearchParams({ q });
    if (opts.agent) params.set("agent", opts.agent);
    if (opts.explain) params.set("explain", "1");
    if (opts.limit) params.set("limit", String(opts.limit));
    return this.request("GET", `/api/projects/${encodeURIComponent(id)}/brain/search?${params}`);
  }

  brainConflicts(id: string): Promise<{
    conflicts: Array<{ a: { text: string }; b: { text: string }; similarity: number; signal: string }>;
  }> {
    return this.request("GET", `/api/projects/${encodeURIComponent(id)}/brain/conflicts`);
  }

  mcpHealth(id: string): Promise<{ health: Record<string, { up: boolean; failures: number; probedAt: number }> }> {
    return this.request("GET", `/api/projects/${encodeURIComponent(id)}/mcps/health`);
  }

  listSpecs(id: string): Promise<{
    specs: Array<{ path: string; bytes: number }>;
    running: { id: string; file: string } | null;
  }> {
    return this.request("GET", `/api/projects/${encodeURIComponent(id)}/specs`);
  }

  runSpec(id: string, file: string): Promise<{ run: { id: string; file: string } }> {
    return this.request("POST", `/api/projects/${encodeURIComponent(id)}/specs/run`, { file });
  }

  costSeries(id: string, days = 30): Promise<{
    days: number;
    series: Array<{ day: string; usd: number; turns: number; tokensIn: number; tokensOut: number; byAgent: Record<string, { usd: number; turns: number }> }>;
  }> {
    return this.request("GET", `/api/projects/${encodeURIComponent(id)}/costs/series?days=${days}`);
  }

  /** The brain as a portable document — see Brain.export. */
  exportBrain(id: string): Promise<Record<string, unknown>> {
    return this.request("GET", `/api/projects/${encodeURIComponent(id)}/brain/export`);
  }

  importBrain(id: string, doc: unknown): Promise<{ added: number; known: number }> {
    return this.request(
      "POST",
      `/api/projects/${encodeURIComponent(id)}/brain/import`,
      doc as Record<string, unknown>,
    );
  }

  removeAgent(id: string, agentId: string): Promise<{ removed: boolean }> {
    return this.request(
      "DELETE",
      `/api/projects/${encodeURIComponent(id)}/agents/${encodeURIComponent(agentId)}`,
    );
  }

  events(id: string, since?: number, limit?: number): Promise<{ events: LoomEvent[] }> {
    const params = new URLSearchParams();
    if (since !== undefined) params.set("since", String(since));
    if (limit !== undefined) params.set("limit", String(limit));
    const qs = params.toString();
    return this.request("GET", `/api/projects/${encodeURIComponent(id)}/events${qs ? `?${qs}` : ""}`);
  }

  send(id: string, text: string, agentId?: string): Promise<{ agentId: string }> {
    return this.request("POST", `/api/projects/${encodeURIComponent(id)}/messages`, {
      text,
      ...(agentId ? { agentId } : {}),
    });
  }

  handoff(id: string, to: string): Promise<{ from: string | null; to: string }> {
    return this.request("POST", `/api/projects/${encodeURIComponent(id)}/handoff`, { to });
  }

  // ── dev servers (core/servers.ts) ──

  servers(id: string): Promise<{ servers: ServerStatus[]; suggested: ServerConfig[] }> {
    return this.request("GET", `/api/projects/${encodeURIComponent(id)}/servers`);
  }

  setServers(id: string, servers: ServerConfig[]): Promise<{ servers: ServerStatus[] }> {
    return this.request("POST", `/api/projects/${encodeURIComponent(id)}/servers`, { servers });
  }

  serverAction(id: string, name: string, action: "start" | "stop" | "restart"): Promise<{ server: ServerStatus }> {
    return this.request("POST", `/api/projects/${encodeURIComponent(id)}/servers/${encodeURIComponent(name)}/${action}`, {});
  }

  serverLog(id: string, name: string, limit = 200): Promise<{ lines: LogLine[] }> {
    return this.request("GET", `/api/projects/${encodeURIComponent(id)}/servers/${encodeURIComponent(name)}/log?limit=${limit}`);
  }

  // ── updates (core/updater.ts) ──

  updates(refresh = false): Promise<UpdateStatus> {
    return this.request("GET", `/api/updates${refresh ? "?refresh=1" : ""}`);
  }

  applyUpdate(): Promise<{ started: boolean; steps: string[] }> {
    return this.request("POST", "/api/updates/apply", {});
  }

  interrupt(id: string): Promise<{ interrupted: string | null }> {
    return this.request("POST", `/api/projects/${encodeURIComponent(id)}/interrupt`, {});
  }

  // ── the prompt queue (core/prompt-queue.ts) ──

  queue(id: string): Promise<QueueView> {
    return this.request("GET", `/api/projects/${encodeURIComponent(id)}/queue`);
  }

  queueAdd(id: string, body: { text: string; target?: unknown; chat?: string; plan?: boolean }): Promise<QueueView & { item: QueueItem }> {
    return this.request("POST", `/api/projects/${encodeURIComponent(id)}/queue`, body as Record<string, unknown>);
  }

  queueEdit(id: string, itemId: string, patch: { text?: string; target?: unknown; to?: number }): Promise<QueueView> {
    return this.request("PATCH", `/api/projects/${encodeURIComponent(id)}/queue/${encodeURIComponent(itemId)}`, patch as Record<string, unknown>);
  }

  queueRemove(id: string, itemId: string): Promise<QueueView> {
    return this.request("DELETE", `/api/projects/${encodeURIComponent(id)}/queue/${encodeURIComponent(itemId)}`);
  }

  queueClear(id: string): Promise<QueueView & { dropped: number }> {
    return this.request("DELETE", `/api/projects/${encodeURIComponent(id)}/queue`);
  }

  queuePause(id: string, paused: boolean): Promise<QueueView> {
    return this.request("POST", `/api/projects/${encodeURIComponent(id)}/queue/pause`, { paused });
  }

  decision(id: string, text: string): Promise<{ event: LoomEvent }> {
    return this.request("POST", `/api/projects/${encodeURIComponent(id)}/decisions`, { text });
  }

  startRoute(
    id: string,
    task: string,
    spec?: string | RouteStepSpec[],
    opts: { router?: "rules" | "llm"; maxHops?: number } = {},
  ): Promise<{ route: RouteState }> {
    return this.request("POST", `/api/projects/${encodeURIComponent(id)}/route`, {
      task,
      ...(spec !== undefined ? { spec } : {}),
      ...(opts.router ? { router: opts.router } : {}),
      ...(opts.maxHops ? { maxHops: opts.maxHops } : {}),
    });
  }

  routeState(id: string): Promise<{ route: RouteState | null }> {
    return this.request("GET", `/api/projects/${encodeURIComponent(id)}/route`);
  }

  abortRoute(id: string): Promise<{ route: RouteState }> {
    return this.request("DELETE", `/api/projects/${encodeURIComponent(id)}/route`);
  }

  costs(id: string): Promise<{ costs: CostSummary }> {
    return this.request("GET", `/api/projects/${encodeURIComponent(id)}/costs`);
  }

  memory(id: string): Promise<{ memory: UnifiedMemory }> {
    return this.request("GET", `/api/projects/${encodeURIComponent(id)}/memory`);
  }

  importMemory(id: string): Promise<{ imported: number; sources: string[] }> {
    return this.request("POST", `/api/projects/${encodeURIComponent(id)}/memory/import`, {});
  }

  /** The learned memory units (the brain), newest first, with a kind breakdown. */
  brain(
    id: string,
    opts: { kind?: string; limit?: number } = {},
  ): Promise<{ memories: Memory[]; stats: { total: number; byKind: Record<string, number>; expired: number } }> {
    const qs = new URLSearchParams();
    if (opts.kind) qs.set("kind", opts.kind);
    if (opts.limit) qs.set("limit", String(opts.limit));
    const q = qs.toString();
    return this.request("GET", `/api/projects/${encodeURIComponent(id)}/brain${q ? `?${q}` : ""}`);
  }

  /** The board: cards (yours, agents, issues, PRs) each in one of four columns. */
  board(id: string): Promise<BoardData> {
    return this.request("GET", `/api/projects/${encodeURIComponent(id)}/board`);
  }

  tree(id: string): Promise<{
    tree: {
      git: boolean;
      branch?: string;
      files: Array<{ status: string; path: string }>;
      patch: string;
      truncated: boolean;
    };
  }> {
    return this.request("GET", `/api/projects/${encodeURIComponent(id)}/tree`);
  }

  newPairingToken(): Promise<{ token: string; expiresAt: number; url: string }> {
    return this.request("POST", "/api/pair/new", {});
  }

  pairedClients(): Promise<{
    clients: Array<{ id: string; name: string; createdAt: number; push?: boolean }>;
  }> {
    return this.request("GET", "/api/pair/clients");
  }

  pushTest(): Promise<{ sent: number }> {
    return this.request("POST", "/api/push/test", {});
  }

  revokeClient(clientId: string): Promise<{ revoked: boolean }> {
    return this.request("DELETE", `/api/pair/clients/${encodeURIComponent(clientId)}`);
  }

  /** Live event stream; returns a close function. */
  subscribe(
    onEvent: (projectId: string, event: LoomEvent) => void,
    projectId?: string,
  ): () => void {
    const params = new URLSearchParams({ token: this.cfg.adminToken });
    if (projectId) params.set("project", projectId);
    const ws = new WebSocket(`ws://${this.cfg.host}:${this.cfg.port}/ws?${params}`);
    ws.on("message", (data) => {
      try {
        const frame = JSON.parse(String(data)) as {
          type: string;
          projectId?: string;
          event?: LoomEvent;
        };
        if (frame.type === "event" && frame.event) {
          onEvent(frame.projectId ?? "", frame.event);
        }
      } catch {
        // Ignore malformed frames.
      }
    });
    ws.on("error", () => {});
    return () => ws.close();
  }
}

// ---------------------------------------------------------------------------
// Lifecycle helpers
// ---------------------------------------------------------------------------

async function healthProbe(cfg: DaemonConfig): Promise<{ ok: boolean; rev?: string }> {
  try {
    const res = await fetch(`http://${cfg.host}:${cfg.port}/api/health`, {
      signal: AbortSignal.timeout(1500),
    });
    if (!res.ok) return { ok: false };
    const body = (await res.json().catch(() => ({}))) as { rev?: string };
    return { ok: true, ...(body.rev ? { rev: body.rev } : {}) };
  } catch {
    return { ok: false };
  }
}

async function healthy(cfg: DaemonConfig): Promise<boolean> {
  return (await healthProbe(cfg)).ok;
}

/**
 * Get a client for a running daemon, starting one (detached) if needed.
 * A healthy daemon running an OLDER BUILD than this CLI is restarted —
 * stale daemons are the classic "failed to fetch / missing route" cause.
 */
export async function ensureDaemon(): Promise<DaemonClient> {
  let cfg = readDaemonConfig();
  if (cfg) {
    const probe = await healthProbe(cfg);
    if (probe.ok && probe.rev === BUILD_REV) return new DaemonClient(cfg);
    if (probe.ok && probe.rev !== BUILD_REV) {
      // Stale build — restart it in place.
      await stopDaemon();
      const gone = Date.now() + 5000;
      while (Date.now() < gone && (await healthy(cfg))) {
        await new Promise((r) => setTimeout(r, 200));
      }
    }
  }

  const compiled = fileURLToPath(new URL("../cli/index.js", import.meta.url));
  const devSource = fileURLToPath(new URL("../cli/index.ts", import.meta.url));
  const { existsSync } = await import("node:fs");
  // Built install → node dist/cli/index.js; dev checkout → tsx src/cli/index.ts.
  const [entry, extraArgs] = existsSync(compiled)
    ? [compiled, [] as string[]]
    : [devSource, ["--import", "tsx"]];
  const child = spawn(process.execPath, [...extraArgs, entry, "daemon"], {
    detached: true,
    stdio: "ignore",
    env: process.env,
  });
  child.unref();

  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 300));
    cfg = readDaemonConfig();
    if (cfg && (await healthy(cfg))) return new DaemonClient(cfg);
  }
  throw new Error("could not start the loom daemon (try `loom daemon` in the foreground)");
}

export async function daemonRunning(): Promise<DaemonConfig | null> {
  const cfg = readDaemonConfig();
  if (cfg && (await healthy(cfg))) return cfg;
  return null;
}

export async function stopDaemon(): Promise<boolean> {
  const cfg = readDaemonConfig();
  if (!cfg?.pid) return false;
  try {
    process.kill(cfg.pid, "SIGTERM");
    return true;
  } catch {
    return false;
  }
}

export interface TeamBrainView {
  status: Record<string, unknown>;
  memories: Array<{ id: string; text: string; kind: string; tier: string; author: string | null; confirmedBy: string[]; mine: boolean; state: string; untrusted?: boolean }>;
  inbox: Array<{ id: string; type: string; detail: string; a: { id: string; text: string; tier: string; author: string | null }; b?: { id: string; text: string; tier: string; author: string | null } }>;
}
