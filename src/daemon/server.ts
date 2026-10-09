import { ClientDelivery } from "./delivery.js";
import express, { type NextFunction, type Request, type Response } from "express";
import crypto from "node:crypto";
import fs from "node:fs";
import http, { type Server } from "node:http";
import os from "node:os";
import path from "node:path";
import { WebSocket, WebSocketServer } from "ws";
import {
  setApprovalBroker,
  type ApprovalDecision
} from "../core/approvals.js";
import { logbook } from "../core/logbook.js";
import { hostedTarget } from "../core/hosted.js";
import {
  ensureDaemonConfig,
  ensureLoomHome,
  findProject,
  listProjects,
  loomHome,
  readDaemonConfig,
  registerProject,
  unregisterProject,
  writeDaemonConfig
} from "../core/registry.js";
import { packCredentials, toB64, type RelayTransport } from "../core/relay-protocol.js";
import type { HubClient } from "../core/team-hub.js";
import {
  CHECK_TTL_MS,
  latestRelease,
  newerThan,
  type Release
} from "../core/updater.js";
import { VERSION } from "../version.js";
import { recordAgentEvent } from "../observability/index.js";
import {
  recentAgentErrors
} from "../observability/insights.js";
import type { LoomEvent, ProjectInfo } from "../types.js";
import { AuthManager, bearerToken } from "./auth.js";
import { pushCategory, pushContent, sendExpoPush, wantsPush, type PushCategory } from "./push.js";
import {
  ensureCredentials,
  readCloudSettings,
  RelayBridge,
  supabaseTarget,
  supabaseTransport,
  writeCloudSettings,
} from "./relay.js";
import { registerAgentDiscoveryRoutes } from './routes/agent-discovery.js';
import { registerAgentSettingsRoutes } from './routes/agent-settings.js';
import { registerAgentsRoutes } from './routes/agents.js';
import { registerAlertsRoutes } from './routes/alerts.js';
import { registerApprovalsRoutes } from './routes/approvals.js';
import { registerAssetsRoutes } from './routes/assets.js';
import { registerBoardRoutes } from './routes/board.js';
import { registerBrainRoutes } from './routes/brain.js';
import { registerChatsRoutes } from './routes/chats.js';
import { registerClientsRoutes } from './routes/clients.js';
import { registerCloudRoutes } from './routes/cloud.js';
import { registerConfigRoutes } from './routes/config.js';
import type { RouteContext } from './routes/context.js';
import { registerPreviewPublic, registerPreviewRoutes } from "./routes/preview.js";
import { registerFilesRoutes } from './routes/files.js';
import { registerGitRoutes } from './routes/git.js';
import { registerHistoryRoutes } from './routes/history.js';
import { registerIntegrationsProjectRoutes } from './routes/integrations-project.js';
import { registerIntegrationsRoutes } from './routes/integrations.js';
import { registerLogsRoutes } from './routes/logs.js';
import { registerMessagesRoutes } from './routes/messages.js';
import { registerObservabilityRoutes } from './routes/observability.js';
import { registerOrchestraRoutes } from './routes/orchestra.js';
import { registerPairingRoutes } from './routes/pairing.js';
import { registerProjectActionsRoutes } from './routes/project-actions.js';
import { registerProjectTeamRoutes } from './routes/project-team.js';
import { registerProjectsRoutes } from './routes/projects.js';
import { registerPromptsRoutes } from './routes/prompts.js';
import { registerProvidersRoutes } from './routes/providers.js';
import { registerPublicRoutes } from './routes/public.js';
import { registerQueueRoutes } from './routes/queue.js';
import { registerRoutingRoutes } from './routes/routing.js';
import { createRuntimeHandler } from './routes/runtime-handler.js';
import { registerSearchRoutes } from './routes/search.js';
import { registerServersRoutes } from './routes/servers.js';
import { registerSetupRoutes } from './routes/setup.js';
import { registerSpecsRoutes } from './routes/specs.js';
import { registerTaskDeliveryRoutes } from './routes/task-delivery.js';
import { registerTeamRoutes } from './routes/team.js';
import { registerTerminalsRoutes } from './routes/terminals.js';
import { registerToolsRoutes } from './routes/tools.js';
import { registerUpdatesRoutes } from './routes/updates.js';
import { registerVoiceRoutes } from './routes/voice.js';
import {
  ProjectRuntime
} from "./runtime.js";
import { SpecRunner } from "./specs.js";
import { BUILD_REV, DEFAULT_PORT, tailscaleIp } from './system.js';
import { TeamLink } from "./team.js";
import { Onboarding } from "./onboard.js";
import { addProjectAt } from "./routes/projects.js";
import { registerCrewsRoutes } from "./routes/crews.js";
import { registerOnboardRoutes } from "./routes/onboard.js";
import { TerminalManager } from "./terminals.js";
export { BUILD_REV, DEFAULT_PORT, fingerprintBuild, isLoopback, isLoopbackHost, lanIp, listModelsForKind, type ModelList, type ModelSource, tailscaleFunnel, tailscaleIp, tailscaleState, tailscaleUp } from './system.js';

export interface DaemonOptions {
  host?: string;
  port?: number;
  /** Bind to the Tailscale interface instead of localhost. */
  tailnet?: boolean;
  /**
   * Build the Loom Cloud transport. Defaults to Supabase Realtime; tests pass
   * an in-memory bus. See daemon/relay.ts.
   */
  relayTransport?: (channel: string) => Promise<RelayTransport>;
  /** Build the Team Hub client. Defaults to HTTP (`loom hub`); tests pass their own. */
  hubFactory?: (url: string, token: string) => HubClient;
  /** `loom runner exec` in a container: run this one claimed job, then call done (Phase 5, D70). */
  runnerExec?: { teamId: string; jobId: string; done(ok: boolean): void };
  /** Tests: GitHub without GitHub — `gh` for invites/grants, and the clone a join makes. */
  gh?: (args: string[]) => Promise<string>;
  onboard?: { clone?: (repo: string, dir: string) => Promise<void>; projectsHome?: string; accessPollMs?: number; accessWaitMs?: number };
}

export class LoomDaemon {
  private app = express();
  private server: Server | null = null;
  private wss: WebSocketServer | null = null;
  private auth: AuthManager;
  private runtimes = new Map<string, ProjectRuntime>();
  private sockets = new Map<WebSocket, { project?: string; scope?: string[] }>();
  private readonly delivery = new ClientDelivery(this.sockets, (socket) => socket.terminate());
  /** In-flight self-heal recheck timers, cleared on close. */
  private healTimers = new Set<ReturnType<typeof setTimeout>>();
  /** Terminal shells — a real pty when node-pty loaded, else plain pipes. */
  private terminals = new TerminalManager({
    onData: (projectId, term, chunk) =>
      this.broadcastTerm(projectId, { type: "term", term, chunk }),
    onCommandEnd: (projectId, term, exit, cwd) =>
      this.broadcastTerm(projectId, { type: "term", term, exit, cwd }),
    onExit: (projectId, term) => {
      this.terminals.forget(projectId, term);
      this.broadcastTerm(projectId, { type: "term", term, closed: true });
    },
    onTitle: (projectId, term, title) =>
      this.broadcastTerm(projectId, { type: "term", term, title }),
  }, 12, path.join(ensureLoomHome(), "scrollback"));
  private unstreamLogs: (() => void) | null = null;
  /** Playwright runs, one per project at a time. See specs.ts. */
  private specRunner = new SpecRunner();
  host: string;
  port: number;
  /**
   * Extra listeners, keyed by IP, added when a phone is connected. `host` stays
   * what we advertise and write to the daemon config (so local CLIs keep
   * reaching us over loopback); each entry here is a second socket on a specific
   * LAN or tailnet IP and the same port, so the phone can reach us without the
   * localhost listener ever being disturbed.
   */
  private extra = new Map<string, { server: Server; wss: WebSocketServer }>();

  /** Tool uses waiting on a human, from agents in "always ask" mode. */
  private approvals = new Map<
    string,
    {
      id: string;
      projectId: string;
      agent: string;
      tool: string;
      input: unknown;
      sessionOption?: boolean;
      createdAt: number;
      settle: (d: ApprovalDecision) => void;
    }
  >();

  /**
   * Put a tool use in front of a person and wait.
   *
   * One implementation for every caller — CLI adapters and model agents all
   * ask from inside this process (core/approvals.ts registers this as the
   * broker). The card, the
   * thread entry, the timeout and the audit trail are the same either way,
   * because "who is asking" should not change what you are shown.
   */
  private async askHuman(req: {
    project: string;
    agent: string;
    tool: string;
    input: unknown;
    summary?: string;
    signal?: AbortSignal;
    sessionOption?: boolean;
  }): Promise<ApprovalDecision> {
    if (req.signal?.aborted) return { behavior: "deny", message: "The agent stopped waiting." };
    const rt = await this.runtime(req.project).catch(() => null);
    if (!rt) return { behavior: "deny", message: "project not open" };
    const id = crypto.randomBytes(6).toString("hex");
    const tool = req.tool.slice(0, 120);
    const preview = (req.summary ?? JSON.stringify(req.input ?? {})).slice(0, 4000);
    const chat = rt.chatOf(req.agent);
    rt.log.append({
      kind: "approval",
      agentId: req.agent,
      ...(chat ? { chat } : {}),
      payload: { phase: "requested", approvalId: id, tool, input: preview, ...(req.sessionOption ? { sessionOption: true } : {}) },
    });
    return new Promise<ApprovalDecision>((resolve) => {
      const abandoned = () => settle({ behavior: "deny", message: "The agent stopped waiting." });
      const settle = (d: ApprovalDecision) => {
        clearTimeout(timer);
        req.signal?.removeEventListener("abort", abandoned);
        if (!this.approvals.delete(id)) return;
        rt.log.append({
          kind: "approval",
          agentId: req.agent,
          ...(chat ? { chat } : {}),
          payload: { phase: "decided", approvalId: id, tool, behavior: d.behavior, ...(d.scope === "session" ? { scope: "session" } : {}), ...(d.message ? { message: d.message } : {}) },
        });
        resolve(d);
      };
      const timer = setTimeout(
        () => settle({ behavior: "deny", message: "No answer within 30 minutes — denied." }),
        30 * 60_000,
      );
      this.approvals.set(id, {
        id,
        projectId: req.project,
        agent: req.agent,
        tool,
        input: req.input ?? {},
        ...(req.sessionOption ? { sessionOption: true } : {}),
        createdAt: Date.now(),
        settle,
      });
      // An agent whose turn ended has stopped waiting; don't hold the card open.
      req.signal?.addEventListener("abort", abandoned, { once: true });
    });
  }

  /** Loom Cloud relay, when enabled. See daemon/relay.ts. */
  private relay: RelayBridge | null = null;
  private relayError: string | null = null;
  private relayTransportFactory: DaemonOptions["relayTransport"];

  /** Loom Teams: this daemon on a Team Hub. See daemon/team.ts. */
  readonly team: TeamLink;
  /** One-link onboarding: joining a team, its repo and its crews from an invite. See daemon/onboard.ts. */
  readonly onboarding: Onboarding;
  private gh: DaemonOptions["gh"];

  constructor(opts: DaemonOptions = {}) {
    this.team = new TeamLink({
      runtimes: () => [...this.runtimes.values()],
      broadcast: (frame) => {
        this.delivery.publish(frame, { kind: "admin" });
      },
      ...(opts.hubFactory ? { hubFactory: opts.hubFactory } : {}),
      ...(opts.runnerExec ? { runnerExec: opts.runnerExec } : {}),
      ...(opts.gh ? { gh: opts.gh } : {}),
      // Phase 5: a runner opens each goal's fresh clone as its own project, and drops it after.
      openProject: async (dir, name) => this.runtime(registerProject(dir, name).id),
      closeProject: async (rt) => {
        await rt.close().catch(() => { });
        this.runtimes.delete(rt.info.id);
        unregisterProject(rt.info.id);
      },
    });
    this.onboarding = new Onboarding({
      team: this.team,
      projects: () => listProjects(),
      addProject: async (dir, name) => (await addProjectAt(dir, name)).info,
      runtime: (id) => this.runtime(id),
      broadcast: (frame) => this.delivery.publish(frame, { kind: "admin" }),
      ...(opts.gh ? { gh: opts.gh } : {}),
      ...opts.onboard,
    });
    this.gh = opts.gh;
    this.relayTransportFactory = opts.relayTransport;
    this.host = opts.host ?? "127.0.0.1";
    this.port = opts.port ?? DEFAULT_PORT;
    const cfg = ensureDaemonConfig({ host: this.host, port: this.port });
    this.auth = new AuthManager(cfg);
    this.routes();
  }

  // -------------------------------------------------------------------------
  // HTTP routes
  // -------------------------------------------------------------------------

  private routes(): void {
    const daemon = this;
    const ctx: RouteContext = {
      get terminals() { return daemon.terminals; },
      get auth() { return daemon.auth; },
      askHuman: (...args) => this.askHuman(...args),
      cachedRelease: (...args) => this.cachedRelease(...args),
      get updating() { return daemon.updating; },
      set updating(value) { daemon.updating = value; },
      close: (...args) => this.close(...args),
      exposedIps: (...args) => this.exposedIps(...args),
      get host() { return daemon.host; },
      get port() { return daemon.port; },
      expose: (...args) => this.expose(...args),
      cloudLinkParams: (...args) => this.cloudLinkParams(...args),
      get team() { return daemon.team; },
      get runtimes() { return daemon.runtimes; },
      cloudStatus: (...args) => this.cloudStatus(...args),
      startCloud: (...args) => this.startCloud(...args),
      stopCloud: (...args) => this.stopCloud(...args),
      pushTokens: (...args) => this.pushTokens(...args),
      runtime: (...args) => this.runtime(...args),
      get specRunner() { return daemon.specRunner; },
      startHealLoop: (...args) => this.startHealLoop(...args),
      broadcastTerm: (...args) => this.broadcastTerm(...args),
      get approvals() { return daemon.approvals; },
    };

    const app = this.app;
    app.disable("x-powered-by");
    // Headers every response carries. No full CSP: the app shell is one
    // inline document by design. What it does get: no MIME sniffing, no
    // referrer leaking a token-bearing URL to a site you click through to,
    // and only Loom itself may frame the app (the Browser tab's previews
    // are same-origin, so they keep working).
    app.use((req: Request, res: Response, next: NextFunction) => {
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Referrer-Policy", "no-referrer");
      res.setHeader("Permissions-Policy", "geolocation=(), payment=(), usb=(), serial=(), bluetooth=()");
      if (req.path === "/app" || req.path === "/") {
        res.setHeader("X-Frame-Options", "SAMEORIGIN");
        res.setHeader("Content-Security-Policy", "frame-ancestors 'self'");
      }
      next();
    });

    // 2 MB for every JSON body but an attachment: a 12 MB file is ~16 MB as
    // base64, and the global cap used to refuse a retina screenshot at 413
    // before the route's own 12 MB check ever ran.
    const smallJson = express.json({ limit: "2mb" });
    const attachmentJson = express.json({ limit: "17mb" });
    app.use((req, res, next) => (/^\/api\/projects\/[^/]+\/attachments$/.test(req.path) ? attachmentJson : smallJson)(req, res, next));

    // CORS for same-machine browser origins only (the Expo web dev server running
    // on another localhost port, etc.). Scoped to loopback so it can't be abused
    // cross-site; the bearer wall below still guards every data route. Preflight
    // is answered here, ahead of auth.
    app.use((req: Request, res: Response, next: NextFunction) => {
      const origin = req.headers.origin;
      if (origin && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
        res.setHeader("Access-Control-Allow-Origin", origin);
        res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
        // PUT and PATCH belong here: toggling a skill, switching an agent on or
        // off, and updating an MCP server all use them, and a cross-origin
        // client (the Expo web build, a paired browser on another port) had
        // those requests refused at the preflight while the same-origin console
        // worked — which makes it look like the feature is broken only on
        // mobile.
        res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
        res.setHeader("Vary", "Origin");
        if (req.method === "OPTIONS") return void res.sendStatus(204);
      }
      next();
    });
    registerAssetsRoutes(app);
    registerPublicRoutes(app, ctx);
    registerPreviewPublic(app);

    // Everything else requires a bearer token.
    app.use((req: Request, res: Response, next: NextFunction) => {
      // Inbound alert webhooks can't carry the admin bearer token — an
      // Alertmanager-style sender has no Loom token to present — so they
      // authenticate with their own LOOM_WEBHOOK_SECRET instead. Set that
      // secret whenever the daemon binds past localhost.
      if (req.path.startsWith("/api/webhooks/")) {
        next();
        return;
      }
      const token = bearerToken(req.headers.authorization);
      if (!this.auth.isAuthorized(token)) {
        res.status(401).json({ error: "unauthorized" });
        return;
      }
      // Admin is the admin token, and only the admin token. A same-machine
      // caller becomes admin by *fetching* that token from /api/bootstrap
      // (above) — which is what the local console does — never by virtue of
      // the socket it arrived on. Trusting loopback here would silently
      // promote every paired client that happens to connect over it, and a
      // revoked phone would keep working for as long as it stayed local.
      (req as Request & { isAdmin?: boolean }).isAdmin = this.auth.isAdmin(token);
      (req as Request & { projectScope?: string[] | null }).projectScope =
        this.auth.allowedProjects(token);
      next();
    });

    // Cheap liveness: HEAD answers with no body, for probes that only ask "is
    // it up" — a monitor hitting GET /api/health every second serialises the
    // whole health payload to throw it away.
    app.head("/api/health", (_req, res) => {
      res.status(200).end();
    });

    // What exactly is running: build rev, node, uptime, platform. /api/health
    // carries rev for staleness checks; this is the fuller "loom health"
    // answer, and it's behind the wall because build details are inventory.
    app.get("/api/version", (_req, res) => {
      res.json({
        rev: BUILD_REV,
        node: process.version,
        platform: `${process.platform}-${process.arch}`,
        uptimeSec: Math.round(process.uptime()),
        pid: process.pid,
      });
    });

    // The scope wall: one guard over every project route, so a scoped token
    // cannot reach a project it wasn't paired for. Matching by resolved id —
    // the param may be a name, and a scope you could dodge by spelling the
    // project differently would be theatre.
    app.use("/api/projects/:id", (req, res, next) => {
      const scope = (req as Request & { projectScope?: string[] | null }).projectScope;
      if (!scope) return void next();
      const resolved = findProject(String(req.params.id))?.id ?? String(req.params.id);
      if (scope.includes(resolved)) return void next();
      res.status(403).json({ error: "this token is not scoped to that project" });
    });
    registerSetupRoutes(app);
    registerProvidersRoutes(app);
    registerUpdatesRoutes(app, ctx);
    registerIntegrationsRoutes(app);
    registerPairingRoutes(app, ctx);
    registerTeamRoutes(app, ctx);
    registerCloudRoutes(app, ctx);
    registerClientsRoutes(app, ctx);
    registerProjectsRoutes(app, ctx);
    const withRuntime = createRuntimeHandler(ctx);
    registerObservabilityRoutes(app, withRuntime);
    registerAlertsRoutes(app, ctx);
    registerMessagesRoutes(app, withRuntime);
    registerServersRoutes(app, withRuntime);
    registerTaskDeliveryRoutes(app, withRuntime);
    registerQueueRoutes(app, withRuntime);
    registerChatsRoutes(app, withRuntime);
    registerAgentSettingsRoutes(app, withRuntime);
    registerToolsRoutes(app, withRuntime);
    registerConfigRoutes(app, withRuntime);
    registerSearchRoutes(app, withRuntime);
    registerGitRoutes(app, withRuntime);
    registerLogsRoutes(app);
    registerAgentDiscoveryRoutes(app, withRuntime);
    registerSpecsRoutes(app, ctx, withRuntime);
    registerProjectActionsRoutes(app, withRuntime);
    registerVoiceRoutes(app, withRuntime);
    registerHistoryRoutes(app, withRuntime);
    registerPromptsRoutes(app, ctx);
    registerProjectTeamRoutes(app, ctx, withRuntime);
    registerApprovalsRoutes(app, ctx, withRuntime);
    registerOrchestraRoutes(app, withRuntime);
    registerCrewsRoutes(app, withRuntime);
    registerOnboardRoutes(app, { team: this.team, onboarding: this.onboarding, ...(this.gh ? { gh: this.gh } : {}) }, withRuntime);
    registerAgentsRoutes(app, withRuntime);
    registerBrainRoutes(app, withRuntime);
    registerRoutingRoutes(app, withRuntime);
    registerTerminalsRoutes(app, ctx);
    registerBoardRoutes(app, ctx, withRuntime);
    registerIntegrationsProjectRoutes(app);
    registerFilesRoutes(app);
    registerPreviewRoutes(app);

    // Anything under /api nobody answered: JSON, like every other API reply,
    // not Express's HTML page.
    app.use("/api", (_req: Request, res: Response) => {
      res.status(404).json({ error: "no such endpoint" });
    });
    // Errors that escaped a route, and bodies that never parsed. Express's
    // default answers these with an HTML page carrying a stack trace.
    app.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
      if (res.headersSent) return void next(err);
      const e = (err ?? {}) as { type?: string; status?: number; message?: string };
      if (e.type === "entity.too.large") return void res.status(413).json({ error: "that request is too large (the limit is 2 MB)" });
      if (e.type === "entity.parse.failed") return void res.status(400).json({ error: "that request body isn't valid JSON" });
      logbook.error("daemon", `request failed: ${e.message ?? String(err)}`, err);
      const status = typeof e.status === "number" && e.status >= 400 && e.status < 600 ? e.status : 500;
      res.status(status).json({ error: status >= 500 ? "something went wrong in the daemon — the Console has the details" : e.message || "bad request" });
    });
  }

  // -------------------------------------------------------------------------
  // Runtimes & event fan-out
  // -------------------------------------------------------------------------

  private async runtime(idOrName: string): Promise<ProjectRuntime> {
    const info: ProjectInfo | undefined = findProject(idOrName);
    if (!info) throw new Error(`unknown project "${idOrName}" — run loom init first`);
    const existing = this.runtimes.get(info.id);
    if (existing) {
      // Hot-reload edited .loom/config.json once the project is quiet.
      if (existing.configStale() && !existing.anyBusy()) {
        await existing.close();
        this.runtimes.delete(info.id);
      } else {
        return existing;
      }
    }
    const rt = await ProjectRuntime.open(info);
    rt.onServerEvent((f) => {
      this.broadcastFrame({ type: "server", projectId: info.id, ...f }, info.id);
    });
    rt.onQueueChange((q) => {
      const head = q.items[0];
      const waitingFor = head && !q.paused ? rt.queueBlocker(head) : null;
      this.broadcastFrame({
        type: "queue",
        projectId: info.id,
        queue: q.items,
        paused: q.paused,
        ...(q.reason ? { reason: q.reason } : {}),
        ...(waitingFor ? { waitingFor } : {}),
      }, info.id);
    });
    rt.onLiveDelta((d) => {
      this.broadcastFrame({ type: "phase" in d ? "item" : "delta", projectId: info.id, ...d }, info.id);
    });
    // Replies as they're written. Deltas are coalesced per agent for a frame
    // (~40ms), so a fast model is a few dozen socket frames a second at most,
    // not one per token. Never logged: the finished message is the record.
    const live = new Map<string, { chat: string; text: string; reasoning: boolean; off?: number }>();
    let liveTimer: NodeJS.Timeout | null = null;
    const flushLive = () => {
      liveTimer = null;
      for (const [agentId, f] of live) {
        this.broadcastFrame({
          type: "stream", projectId: info.id, agentId, chat: f.chat, text: f.text,
          ...(f.reasoning ? { reasoning: true } : {}),
          ...(f.off !== undefined ? { off: f.off } : {}),
        }, info.id);
      }
      live.clear();
    };
    rt.onStream((f) => {
      const key = f.agentId;
      const have = live.get(key);
      // A switch between thinking and answering (or thread) is a new piece.
      if (have && (have.reasoning !== Boolean(f.reasoning) || have.chat !== f.chat)) flushLive();
      const cur = live.get(key);
      if (cur) cur.text += f.text;
      else live.set(key, { chat: f.chat, text: f.text, reasoning: Boolean(f.reasoning), ...(f.off !== undefined ? { off: f.off } : {}) });
      if (!liveTimer) liveTimer = setTimeout(flushLive, 40);
    });
    rt.log.onEvent((e) => {
      // A finished message supersedes its typing: send what's buffered first
      // so the last few characters can't land after the message they belong to.
      if (e.kind === "message" && e.agentId && live.has(e.agentId)) {
        if (liveTimer) clearTimeout(liveTimer);
        flushLive();
      }
      this.broadcast(info.id, e);
      // The single central hook for live events — agent turns as well as
      // API-driven handoffs, routes and memory folds. Rehydration reads through
      // log.list(), not append(), so replaying history never re-exports it.
      recordAgentEvent(e, { project: info.name });
    });
    this.runtimes.set(info.id, rt);
    this.team.attachRuntime(rt);
    return rt;
  }

  /** One frame to everyone watching this project (or everyone, with no project). */
  private broadcastFrame(payload: Record<string, unknown>, projectId?: string): void {
    this.delivery.publish(payload, { kind: "project", projectId });
  }

  private broadcast(projectId: string, event: LoomEvent): void {
    this.broadcastFrame({ type: "event", projectId, event }, projectId);
    // An agent's error is a thread event AND a log line. The thread shows it to
    // whoever is reading that conversation; the Console shows it to whoever is
    // wondering why nothing happened. Those are often the same person and never
    // the same moment.
    if (event.kind === "error") {
      logbook.error(
        event.agentId ? `agent:${event.agentId}` : "project",
        String(event.payload.message ?? "agent error"),
        event.payload.stderr ?? event.payload.detail,
        projectId,
      );
    }
    this.maybePush(projectId, event);
  }

  /**
   * Push every log record to every connected client.
   *
   * Not per-project: a daemon-level fault (a crash guard firing, a bad route)
   * has no project, and it's exactly the one you most need to see. The Console
   * filters; the wire doesn't.
   */
  private streamLogs(): () => void {
    return logbook.subscribe((record) => {
      this.delivery.publish({ type: "log", record }, { kind: "log", projectId: record.project });
    });
  }

  /** Fan a terminal frame out to every socket watching this project. */
  private broadcastTerm(projectId: string, frame: Record<string, unknown>): void {
    this.delivery.publish(frame, { kind: "project", projectId });
  }

  private pushTokens(category?: PushCategory): string[] {
    const cfg = readDaemonConfig();
    return (cfg?.clients ?? [])
      .filter((c) => !category || wantsPush(c.pushKinds, category))
      .map((c) => c.pushToken)
      .filter((t): t is string => Boolean(t));
  }

  /** Fire-and-notify to phones. Route hops stay quiet; the outcome pushes. */
  private maybePush(projectId: string, event: LoomEvent): void {
    const category = pushCategory(event);
    if (!category) return;
    const rt = this.runtimes.get(projectId);
    let reply: string | undefined;
    if (event.kind === "run_complete") {
      if (rt?.routes.isActive()) return; // a pipeline in flight buzzes once at the end, not per hop
      if (event.payload.error) return; // the error event says it
      if (rt) {
        // a goal's or crew's own task turns stay quiet: the goal pushes when it's done
        try {
          const chat = event.chat ?? "main";
          const g = rt.chats().find((c) => c.id === chat)?.group;
          if (g && g.kind !== "import") return;
        } catch { /* push anyway */ }
        try {
          reply = rt.log.list({ kinds: ["message"], chat: event.chat ?? "main", before: event.id, limit: 1 })
            .find((m) => !m.agentId || m.agentId === event.agentId)?.payload.text as string | undefined;
        } catch { /* a push without the snippet */ }
      }
    }
    const tokens = this.pushTokens(category);
    if (!tokens.length) return;
    const name = listProjects().find((p) => p.id === projectId)?.name ?? "project";
    void sendExpoPush(tokens, {
      ...pushContent(name, event, { reply }),
      // the phone opens this project (and goal, or chat) when the alert is tapped
      data: {
        projectId,
        kind: event.kind,
        category,
        ...(typeof event.payload.runId === "string" ? { runId: event.payload.runId } : {}),
        ...(event.chat ? { chat: event.chat } : {}),
      },
    });
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  async listen(opts: { tailnet?: boolean } = {}): Promise<{ host: string; port: number }> {
    if (opts.tailnet) {
      this.host = await tailscaleIp();
    }
    await new Promise<void>((resolve, reject) => {
      // Use the `listening` *event*, not the listen() callback: Express fires the
      // callback even when the bind fails with EADDRINUSE, which would otherwise
      // resolve this as a phantom success — a daemon that prints "listening" and
      // exits 0 while another process actually holds the port.
      const server = this.app.listen(this.port, this.host);
      this.server = server;
      let settled = false;
      server.once("error", (err) => {
        if (!settled) {
          settled = true;
          reject(err);
        }
      });
      server.once("listening", () => {
        if (!settled) {
          settled = true;
          resolve();
        }
      });
    });
    const addr = this.server!.address();
    if (addr && typeof addr === "object") this.port = addr.port; // ephemeral port support

    this.wss = this.attachWs(this.server!);
    // Agents ask from inside the daemon (core/approvals.ts).
    setApprovalBroker((req) => this.askHuman(req));

    // Fan every log record out to connected clients (the Console tab).
    this.unstreamLogs = this.streamLogs();
    this.writeConfig();
    if (readCloudSettings().enabled) void this.startCloud().catch(() => { });
    void this.team.start().catch(() => { });
    this.watchReleases();

    return { host: this.host, port: this.port };
  }

  /**
   * A new Loom release tells each phone once ("updates" push). The first look
   * waits a minute so a restart doesn't hit GitHub at once, then every few
   * hours; the version already announced is remembered across restarts.
   */
  private watchReleases(): void {
    if (process.env.LOOM_NO_UPDATE_CHECK || process.env.VITEST) return;
    const look = async () => {
      const release = await this.cachedRelease(false);
      if (!release || !newerThan(release.version, VERSION)) return;
      const told = path.join(loomHome(), "update-announced");
      let last = "";
      try { last = fs.readFileSync(told, "utf8").trim(); } catch { /* never told */ }
      if (last === release.version) return;
      const tokens = this.pushTokens("updates");
      try { fs.writeFileSync(told, release.version); } catch { /* tell again next time */ }
      if (!tokens.length) return;
      void sendExpoPush(tokens, {
        title: `Loom ${release.version} is out`,
        body: `This computer runs ${VERSION}. Update it from Loom's Settings, or run: loom update`,
        data: { kind: "update", category: "updates", version: release.version, url: release.url },
      });
    };
    const first = setTimeout(() => void look().catch(() => { }), 60_000);
    const every = setInterval(() => void look().catch(() => { }), CHECK_TTL_MS);
    first.unref?.(); every.unref?.();
    this.healTimers.add(first);
    this.releaseTimer = every;
  }
  private releaseTimer: NodeJS.Timeout | null = null;

  /**
   * Attach a WebSocket server (path /ws) to an HTTP server and wire the
   * connection handler. Returned so extra phone-access listeners can track and
   * later close their own; all sockets land in the one shared `this.sockets`.
   */
  private attachWs(server: Server): WebSocketServer {
    const wss = new WebSocketServer({ server, path: "/ws" });
    wss.on("connection", (ws, req) => {
      const url = new URL(req.url ?? "/ws", `http://${this.host}:${this.port}`);
      // Prefer the token in the `Sec-WebSocket-Protocol` header (a header isn't
      // written to browser history or a proxy's request-line log the way a
      // `?token=` query is); fall back to the query for the CLI/native clients.
      const sub = req.headers["sec-websocket-protocol"];
      const fromHeader = sub
        ? sub.split(",").map((s) => s.trim()).find((s) => s.startsWith("loom.bearer."))?.slice("loom.bearer.".length)
        : undefined;
      const token = fromHeader ?? url.searchParams.get("token") ?? undefined;
      this.auth.reload(); // pick up freshly paired clients
      if (!this.auth.isAuthorized(token)) {
        ws.close(4401, "unauthorized");
        return;
      }
      const project = url.searchParams.get("project") ?? undefined;
      let resolvedProject: string | undefined;
      if (project) {
        resolvedProject = findProject(project)?.id ?? project;
        // Ensure the runtime is live so its events flow.
        void this.runtime(project).catch(() => { });
      }
      const wsScope = this.auth.allowedProjects(token);
      this.sockets.set(ws, {
        ...(resolvedProject ? { project: resolvedProject } : {}),
        ...(wsScope ? { scope: wsScope } : {}),
      });
      ws.send(
        JSON.stringify({
          type: "hello",
          projects: listProjects().map((p) => p.id),
          terminal: this.terminals.mode,
        }),
      );
      // Terminal input comes back up this socket: a tty needs a round-trip per
      // keystroke, which a POST each time can't carry. Only a socket scoped to
      // a project may drive that project's terminals.
      ws.on("message", (raw) => {
        let msg: { type?: string; term?: string; data?: string; cols?: number; rows?: number };
        try {
          msg = JSON.parse(String(raw)) as typeof msg;
        } catch {
          return;
        }
        if (!resolvedProject || !msg.term) return;
        const sess = this.terminals.get(resolvedProject, String(msg.term));
        if (!sess) return;
        if (msg.type === "term-input" && typeof msg.data === "string") sess.write(msg.data);
        else if (msg.type === "term-resize") {
          sess.resize(Number(msg.cols) || 80, Number(msg.rows) || 24);
        }
      });
      ws.on("close", () => this.sockets.delete(ws));
    });
    return wss;
  }

  /** Record where we actually bound so CLIs can find us. */
  private writeConfig(): void {
    const cfg = ensureDaemonConfig({ host: this.host, port: this.port });
    cfg.host = this.host;
    cfg.port = this.port;
    cfg.pid = process.pid;
    writeDaemonConfig(cfg);
  }

  /**
   * Make this daemon reachable at a specific address — a LAN or tailnet IP — by
   * adding a *second* listener on that IP and the same port. The localhost
   * listener is never touched: no teardown, no dropped sockets, no window where
   * the web app you are looking at goes away, and none of the EADDRINUSE races a
   * single-socket rebind to 0.0.0.0 hit while the browser held the port open.
   * Two distinct IPs on one port coexist fine. Idempotent.
   */
  async expose(ip: string): Promise<void> {
    if (!ip || ip === this.host || this.extra.has(ip)) return;
    const server = http.createServer(this.app);
    await new Promise<void>((resolve, reject) => {
      server.listen(this.port, ip, () => resolve());
      server.on("error", reject);
    });
    const wss = this.attachWs(server);
    this.extra.set(ip, { server, wss });
    logbook.info("daemon", `also listening on ${ip}:${this.port} for phone access`);
  }

  /** Extra addresses (LAN/tailnet) a phone can reach us on right now. */
  exposedIps(): string[] {
    return [...this.extra.keys()];
  }

  /**
   * The self-heal recheck loop: after a firing alert fails the baton over, wait
   * LOOM_HEAL_RECHECK_MS, ask the telemetry store (or the local log) whether the
   * agent has errored since it was quarantined, and if not, hand the baton back
   * — retrying up to LOOM_HEAL_MAX_RETRIES times before giving up. Best-effort
   * and unref'd: a daemon restart simply forgets the loop.
   */
  private startHealLoop(rt: ProjectRuntime, agent: string, alert: string, since: number): void {
    if (process.env.LOOM_HEAL_DISABLED === "1") return;
    const recheckMs = Math.max(1, Number(process.env.LOOM_HEAL_RECHECK_MS) || 60_000);
    const maxRetries = Math.max(1, Number(process.env.LOOM_HEAL_MAX_RETRIES) || 3);
    let attempt = 0;
    const tick = async (): Promise<void> => {
      attempt += 1;
      if (!rt.quarantined()[agent]) return; // lifted already (a resolved alert, say)
      const recovered = await this.agentRecovered(rt, agent, since).catch(() => false);
      if (recovered) {
        rt.unquarantine(agent);
        const retried = rt.baton.holder() !== agent;
        // A hand-back that's refused (the stand-in is mid-turn, say) is part
        // of what happened; recording "recovered" without it reads as done.
        let handBack: string | undefined;
        if (retried) await rt.handoff(agent).catch((err: unknown) => { handBack = err instanceof Error ? err.message : String(err); });
        rt.log.append({ kind: "status", agentId: agent, payload: { state: "alert_recovery", alert, retried, attempt, via: "recheck", ...(handBack ? { handBackFailed: handBack } : {}) } });
        return;
      }
      if (attempt >= maxRetries) {
        rt.log.append({ kind: "status", agentId: agent, payload: { state: "alert_heal_exhausted", alert, attempts: attempt } });
        return; // stays quarantined for a human
      }
      schedule();
    };
    const schedule = (): void => {
      const t = setTimeout(() => { this.healTimers.delete(t); void tick(); }, recheckMs);
      if (typeof t.unref === "function") t.unref();
      this.healTimers.add(t);
    };
    schedule();
  }

  /** Recovered = no error spans since it was quarantined (backend first, local log fallback). */
  private async agentRecovered(rt: ProjectRuntime, agent: string, sinceMs: number): Promise<boolean> {
    try {
      return (await recentAgentErrors(rt.info.name, agent, sinceMs)) === 0;
    } catch {
      const errs = rt.log.list({ limit: 400 }).filter(
        (e) => e.ts > sinceMs && e.agentId === agent &&
          (e.kind === "error" || (e.kind === "run_complete" && (e.payload as Record<string, unknown>).error)),
      );
      return errs.length === 0;
    }
  }

  // -------------------------------------------------------------------------
  // Loom Cloud
  // -------------------------------------------------------------------------

  /** `&relay=<channel.key>&sb=<url>&sbk=<anon key>` when the relay is on, else "". */
  private cloudLinkParams(): string {
    const s = readCloudSettings();
    const target = supabaseTarget(s);
    if (!s.enabled || !s.channel || !s.key || !target) return "";
    const b64 = (v: string) => toB64(new TextEncoder().encode(v));
    return `&relay=${packCredentials({ channel: s.channel, key: s.key })}&sb=${b64(target.url)}&sbk=${b64(target.anonKey)}`;
  }

  cloudStatus(): Record<string, unknown> {
    const s = readCloudSettings();
    const target = supabaseTarget(s);
    return {
      configured: Boolean(target || this.relayTransportFactory),
      enabled: s.enabled,
      connected: Boolean(this.relay),
      clients: this.relay?.clientCount() ?? 0,
      stats: this.relay?.stats ?? null,
      supabaseUrl: target?.url ?? null,
      hostedUrl: hostedTarget().supabaseUrl,
      error: this.relayError,
    };
  }

  async startCloud(): Promise<void> {
    const s = readCloudSettings();
    const creds = ensureCredentials(s);
    s.enabled = true;
    writeCloudSettings(s);
    await this.relay?.close().catch(() => { });
    this.relay = null;
    this.relayError = null;
    try {
      let transport: RelayTransport;
      if (this.relayTransportFactory) transport = await this.relayTransportFactory(creds.channel);
      else {
        const target = supabaseTarget(s);
        if (!target) throw new Error("no Supabase project — set LOOM_SUPABASE_URL and LOOM_SUPABASE_ANON_KEY");
        transport = await supabaseTransport(target.url, target.anonKey, creds.channel);
      }
      await Promise.race([
        transport.ready(),
        new Promise((_, rej) => setTimeout(() => rej(new Error("timed out joining the relay channel")), 15_000)),
      ]);
      this.relay = new RelayBridge({
        transport,
        key: creds.key,
        localBase: () => `http://127.0.0.1:${this.port}`,
        identity: () => ({ version: BUILD_REV, name: os.hostname() }),
      });
      logbook.info("cloud", "Loom Cloud relay connected");
    } catch (err) {
      this.relayError = (err as Error).message;
      logbook.warn("cloud", "Loom Cloud relay failed to start", this.relayError);
      throw err;
    }
  }

  async stopCloud(opts: { rotate?: boolean } = {}): Promise<void> {
    await this.relay?.close().catch(() => { });
    this.relay = null;
    const s = readCloudSettings();
    s.enabled = false;
    if (opts.rotate) {
      delete s.channel;
      delete s.key;
    }
    writeCloudSettings(s);
  }

  /** The last release check, kept so a poll can't hammer GitHub's API. */
  private releaseSeen: { at: number; release: Release | null } | null = null;
  private updating = false;

  private async cachedRelease(refresh: boolean): Promise<Release | null> {
    if (!refresh && this.releaseSeen && Date.now() - this.releaseSeen.at < CHECK_TTL_MS) return this.releaseSeen.release;
    const release = await latestRelease();
    this.releaseSeen = { at: Date.now(), release };
    return release;
  }

  async close(): Promise<void> {
    // A broker pointing at a closed daemon would leave the next adapter
    // waiting on a card nobody will ever see.
    setApprovalBroker(null);
    for (const a of [...this.approvals.values()]) {
      a.settle({ behavior: "deny", message: "the daemon is shutting down" });
    }
    await this.team.stop().catch(() => { });
    await this.relay?.close().catch(() => { });
    this.relay = null;
    for (const t of this.healTimers) clearTimeout(t);
    if (this.releaseTimer) clearInterval(this.releaseTimer);
    this.healTimers.clear();
    this.unstreamLogs?.();
    this.unstreamLogs = null;
    this.specRunner.closeAll();
    this.terminals.closeAll();
    for (const rt of this.runtimes.values()) await rt.close();
    this.runtimes.clear();
    for (const { server, wss } of this.extra.values()) {
      wss.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    this.extra.clear();
    // Close the live sockets too. wss.close() stops new connections but leaves
    // open ones open, and server.close() waits for every keep-alive socket a
    // browser holds — so a restart used to leave the old daemon alive forever,
    // its port freed but the process (and everything it held) still running.
    for (const ws of this.wss?.clients ?? []) ws.terminate();
    this.wss?.close();
    await new Promise<void>((resolve) => {
      if (!this.server) return resolve();
      this.server.close(() => resolve());
      this.server.closeAllConnections?.();
    });
    const cfg = readDaemonConfig();
    if (cfg && cfg.pid === process.pid) {
      delete cfg.pid;
      writeDaemonConfig(cfg);
    }
  }
}
