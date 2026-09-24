/**
 * The Loom daemon — one process, many projects, one API for every surface
 * (CLI today, iOS app next). REST for commands, WebSocket for the live
 * event stream.
 */

import { hostedTarget } from "../core/hosted.js";
import { execFile, spawn } from "node:child_process";
import { VERSION } from "../version.js";
import crypto from "node:crypto";
import { repoOf, TeamLink } from "./team.js";
import { allModels, fetchModels, forgetProvider, listProviders, resolveProvider, setProvider } from "../core/providers.js";
import type { HubClient } from "../core/team-hub.js";
import fs from "node:fs";
import http, { type Server } from "node:http";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express, { type Request, type Response, type NextFunction } from "express";
import QRCode from "qrcode";
import { WebSocketServer, WebSocket } from "ws";
import type { LoomEvent, ProjectInfo } from "../types.js";
import { NotHolderError } from "../core/baton.js";
import type { MemoryKind, MemoryPatch } from "../core/brain.js";
import { findConflicts, retrieve } from "../core/brain-index.js";
import { RouteActiveError } from "../core/routes.js";
import { triageAgent } from "../observability/triage.js";
import {
  burnSeries,
  fetchMetricSeries,
  fetchSpans,
  healthScore,
  insightSpansFromLog,
  recentAgentErrors,
  traceSpans,
  LOOM_METRIC_NAMES,
  type InsightSpan,
  type MetricSeries,
} from "../observability/insights.js";
import { fetchLogs, type InsightLog } from "../observability/logs-query.js";
import { ask, type AskContext } from "../observability/ask.js";
import { probeMcpServer, writeMcpSession } from "../core/mcp.js";
import { findSpecs, SpecRunner, type SpecRun } from "./specs.js";
import { searchCatalog } from "../core/mcp-catalog.js";
import { buildSnapshots } from "../observability/snapshots.js";
import { authorSkill, SkillInstallError } from "../core/skill-install.js";
import { suggestSkill } from "../core/skills.js";
import { ADES, buildDefaultRoutes, defaultAgentConfigs, detectAdes } from "../core/ades.js";
import { defaultExec } from "./landing.js";
import { suggestServers, urlFor, type ServerConfig } from "../core/servers.js";
import { capture } from "../core/preview-shot.js";
import { digest } from "../core/digest.js";
import { logbook, type LogLevel } from "../core/logbook.js";
import { leaderboard, perDay, turnRows, turnsCsv } from "../core/turn-stats.js";
import {
  CHECK_TTL_MS,
  detectInstall,
  latestRelease,
  newerThan,
  plan,
  refuseDirtyCheckout,
  type Release,
} from "../core/updater.js";
import { searchChats, searchCode } from "../core/search.js";
import {
  addWorktree as gitAddWorktree,
  branches as gitBranches,
  checkout as gitCheckout,
  commit as gitCommit,
  discard as gitDiscard,
  fileDiff as gitFileDiff,
  GitError,
  init as gitInit,
  listWorktrees as gitListWorktrees,
  log as gitLog,
  push as gitPush,
  removeWorktree as gitRemoveWorktree,
  stage as gitStage,
  stagedDiff as gitStagedDiff,
  status as gitStatus,
  unstage as gitUnstage,
} from "../core/git.js";
import { claudeText } from "../core/claude-cli.js";
import { setupReport } from "../core/setup.js";
import {
  ensureDaemonConfig,
  ensureLoomHome,
  findProject,
  listProjects,
  readDaemonConfig,
  projectLoomDir,
  readProjectConfig,
  readProjectState,
  registerProject,
  renameProject,
  unregisterProject,
  writeDaemonConfig,
  writeProjectConfig,
  type BoardTask,
} from "../core/registry.js";
import { agyBin } from "../adapters/antigravity-cli.js";
import { cliAvailable } from "../adapters/base.js";
import { codexBin } from "../adapters/codex.js";
import { grokBin } from "../adapters/grok.js";
import { APP_HTML, APP_MANIFEST } from "./app-page.js";
import { GEIST_WOFF2 } from "./geist-font.js";
import { AuthManager, bearerToken } from "./auth.js";
import { pushContent, sendExpoPush, shouldPush } from "./push.js";
import {
  BudgetExceededError,
  LoomAskTimeoutError,
  ProjectRuntime,
  QuarantinedError,
} from "./runtime.js";
import { buildBoard } from "./board.js";
import {
  ghAuthStatus,
  ghProjectItems,
  ghProjects,
  listTasks,
  prReview,
  prView,
  runGh,
  type PrReviewAction,
} from "./tasks.js";
import { linearCreateIssue, linearTeams, listLinearIssues } from "./linear.js";
import { TerminalManager, TooManySessionsError } from "./terminals.js";
import { recordAgentEvent } from "../observability/index.js";
import {
  ensureCredentials,
  readCloudSettings,
  RelayBridge,
  supabaseTarget,
  supabaseTransport,
  writeCloudSettings,
} from "./relay.js";
import { packCredentials, toB64, type RelayTransport } from "../core/relay-protocol.js";
import {
  approvalEndpoint,
  setApprovalBroker,
  setApprovalEndpoint,
  type ApprovalDecision,
} from "../core/approvals.js";
import { PERMISSION_PROFILES } from "../core/permissions.js";
import { loadPolicy } from "../core/team-policy.js";
import { parseCondition, parseTarget, QueueItemGone } from "../core/prompt-queue.js";
import { deleteRecipe, getRecipe, listRecipes, roleToTarget, saveRecipe, targetToRole } from "../core/recipes.js";
import { clearRecent, deletePrompt, listPrompts, recordRecent, savePrompt, updatePrompt } from "../core/prompts.js";

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
}

export const DEFAULT_PORT = 7420;

/**
 * Fingerprint every built file the daemon can load, as one hash.
 *
 * The walk is what makes it honest. This used to hash exactly two files —
 * server.js and app-page.js — which meant a change anywhere else (an adapter,
 * the router, core/registry.ts) left the rev identical. `loom up` said "daemon
 * already running", the shell agreed it was current, and a daemon kept serving
 * the old code from memory. A correct fix looked like it did nothing, which
 * sends you debugging code that is already right.
 *
 * Content-based on purpose: mtimes are unreliable across runtimes on some
 * filesystems (exFAT drives skew them by the local timezone offset). Names are
 * hashed alongside contents so a rename or a deletion moves the rev too.
 *
 * Reading ~39 files (about half a megabyte) costs a couple of milliseconds at
 * import, once. A stale daemon costs an afternoon.
 *
 * The desktop shell has a twin of this in desktop/loom-app.js — it can't import
 * this module without pulling express into Electron's main process. They must
 * agree byte for byte; test/desktop-app.test.ts compares them against the real
 * built output so a drift fails there rather than in the field.
 */
export function fingerprintBuild(root: string): string | null {
  const rels: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".js")) rels.push(path.relative(root, full));
    }
  };
  walk(root);
  if (rels.length === 0) return null;
  rels.sort(); // readdir order is filesystem-dependent; the hash must not be
  const hash = crypto.createHash("sha256");
  for (const rel of rels) {
    hash.update(rel);
    hash.update(fs.readFileSync(path.join(root, rel)));
  }
  return hash.digest("hex").slice(0, 16);
}

/**
 * This build's rev. "dev" when there's nothing compiled to hash — running from
 * source under tsx, where the tree is .ts and the walk finds no .js at all.
 */
export const BUILD_REV = (() => {
  try {
    // dist/daemon/server.js → dist: everything this process can import.
    const me = fileURLToPath(import.meta.url);
    return fingerprintBuild(path.dirname(path.dirname(me))) ?? "dev";
  } catch {
    return "dev";
  }
})();

/**
 * Loom's own install root — the directory to ask "am I behind my remote?".
 *
 * Walks up from this module looking for a .git directory (a source checkout or
 * a cloned install). null when Loom was installed some other way (a package),
 * in which case "check for updates" honestly says there's no git tree to check.
 */
function loomRoot(): string | null {
  try {
    let dir = path.dirname(fileURLToPath(import.meta.url));
    for (let i = 0; i < 6; i++) {
      if (fs.existsSync(path.join(dir, ".git"))) return dir;
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {
    /* fall through */
  }
  return null;
}

const TERM_MARK = "__LOOM_END__";

/**
 * Just enough to give a pasted attachment a sensible extension.
 */
const MIME_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/svg+xml": "svg",
  "text/markdown": "md",
  "text/plain": "txt",
  "application/pdf": "pdf",
};

/**
 * Paths from an HTTP body, as strings and nothing else.
 *
 * These reach `git checkout --` and `git clean -fd`, which delete things. A
 * body is whatever the caller felt like sending, so anything that isn't a
 * string is dropped here rather than stringified into a path somewhere deeper.
 * This is the shape check; core/git.ts does the safety check, resolving every
 * one of them against the project root.
 */
function asPaths(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === "string" && x.length > 0).slice(0, 500);
}

/** KAIRO-style dense fleet metrics for the Observatory Metrics tab. */
function kairoMetrics(rt: ProjectRuntime): Record<string, unknown> {
  const cs = rt.costSummary();
  const decisions = rt.getDecisions();
  const stats = rt.decisionStats();
  const events = rt.log.list({ limit: 2000 });
  const runs = events.filter((e) => e.kind === "run_complete");
  const recent = runs.slice(-10);
  const num = (v: unknown): number => Number(v) || 0;
  // Distinct paths any turn touched, and how many touches there were. The set
  // used to be reported as `filesCreated`, which it never was — a file edited
  // in five turns is one path here, and creating it was not what put it there.
  const filePaths = new Set<string>();
  let fileChanges = 0;
  let filesCreated = 0;
  for (const e of events) {
    if (e.kind !== "turn_diff") continue;
    const files = Array.isArray(e.payload.files)
      ? (e.payload.files as Array<{ path?: string; status?: string }>)
      : [];
    fileChanges += files.length;
    for (const f of files) {
      if (f.path) filePaths.add(f.path);
      // "??" is git porcelain for untracked — the turn is where the file
      // started existing, which is the only "created" this log can support.
      if (String(f.status ?? "").trim() === "??") filesCreated += 1;
    }
  }
  const tokensByAgent: Record<string, number> = {};
  const costByAgent: Record<string, number> = {};
  for (const a of cs.byAgent) {
    tokensByAgent[a.agentId] = a.tokensIn + a.tokensOut;
    costByAgent[a.agentId] = a.usd;
  }
  return {
    agentsSpawned: new Set(runs.map((e) => e.agentId).filter(Boolean)).size,
    turnsCompleted: cs.turns,
    avgReasoningTimeMs: cs.turns ? Math.round(cs.totalMs / cs.turns) : 0,
    filesTouched: filePaths.size,
    filesCreated,
    filesModified: fileChanges,
    decisionsRecorded: decisions.length,
    // null when no decision carries a measured confidence — see decisionStats.
    avgConfidence: stats.avgConfidence,
    confidenceSamples: stats.confidenceSamples,
    decisionsBySource: stats.bySource,
    totalCostUsd: cs.totalUsd,
    totalTokensIn: cs.tokensIn,
    totalTokensOut: cs.tokensOut,
    costByAgent,
    tokensByAgent,
    criticalPath: stats.criticalPath,
    retriesTotal: events.filter((e) => e.kind === "error" || e.kind === "route_failed").length,
    tokenSparkline: recent.map((e) => num(e.payload.inputTokens) + num(e.payload.outputTokens)),
    costSparkline: recent.map((e) => num(e.payload.costUsd)),
  };
}

/** A server entry from the wire, checked — a command is a thing we will run. */
function parseServerConfig(raw: unknown): ServerConfig {
  const r = (raw ?? {}) as Record<string, unknown>;
  const name = String(r.name ?? "").trim();
  const command = String(r.command ?? "").trim();
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(name)) throw new Error(`"${name}" isn't a usable server name`);
  if (!command) throw new Error(`server "${name}" has no command`);
  const port = Number(r.port);
  const url = typeof r.url === "string" && r.url.trim() ? r.url.trim() : undefined;
  if (url && !/^https?:\/\//.test(url)) throw new Error(`server "${name}" has a url that isn't http(s)`);
  return {
    name,
    command,
    ...(typeof r.cwd === "string" && r.cwd.trim() ? { cwd: r.cwd.trim() } : {}),
    ...(Number.isInteger(port) && port > 0 && port < 65536 ? { port } : {}),
    ...(url ? { url } : {}),
    ...(r.env && typeof r.env === "object" ? { env: Object.fromEntries(Object.entries(r.env as Record<string, unknown>).map(([k, v]) => [k, String(v)])) } : {}),
  };
}

export class LoomDaemon {
  private app = express();
  private server: Server | null = null;
  private wss: WebSocketServer | null = null;
  private auth: AuthManager;
  /** Wrong pairing codes per address, for throttling guesses at /api/pair/claim. */
  private claimTries = new Map<string, { fails: number; until: number }>();
  private runtimes = new Map<string, ProjectRuntime>();
  private sockets = new Map<WebSocket, { project?: string; scope?: string[] }>();
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
      createdAt: number;
      settle: (d: ApprovalDecision) => void;
    }
  >();

  /**
   * Put a tool use in front of a person and wait.
   *
   * One implementation for both callers: a CLI agent asking over HTTP through
   * the MCP approval server, and a model agent asking from inside this
   * process (core/approvals.ts registers this as the broker). The card, the
   * thread entry, the timeout and the audit trail are the same either way,
   * because "who is asking" should not change what you are shown.
   */
  private async askHuman(req: {
    project: string;
    agent: string;
    tool: string;
    input: unknown;
    summary?: string;
  }): Promise<ApprovalDecision> {
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
      payload: { phase: "requested", approvalId: id, tool, input: preview },
    });
    return new Promise<ApprovalDecision>((resolve) => {
      const settle = (d: ApprovalDecision) => {
        clearTimeout(timer);
        if (!this.approvals.delete(id)) return;
        rt.log.append({
          kind: "approval",
          agentId: req.agent,
          ...(chat ? { chat } : {}),
          payload: { phase: "decided", approvalId: id, tool, behavior: d.behavior, ...(d.message ? { message: d.message } : {}) },
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
        createdAt: Date.now(),
        settle,
      });
    });
  }

  /** Deny anything this agent was still waiting on — it has gone away. */
  private abandonApprovals(projectId: string, agent: string): void {
    for (const a of [...this.approvals.values()]) {
      if (a.projectId === projectId && a.agent === agent) {
        a.settle({ behavior: "deny", message: "The agent stopped waiting." });
      }
    }
  }

  /** Loom Cloud relay, when enabled. See daemon/relay.ts. */
  private relay: RelayBridge | null = null;
  private relayError: string | null = null;
  private relayTransportFactory: DaemonOptions["relayTransport"];

  /** Loom Teams: this daemon on a Team Hub. See daemon/team.ts. */
  readonly team: TeamLink;

  constructor(opts: DaemonOptions = {}) {
    this.team = new TeamLink({
      runtimes: () => [...this.runtimes.values()],
      broadcast: (frame) => {
        const payload = JSON.stringify(frame);
        // Team frames are daemon-level: unscoped (admin / full) clients only.
        for (const [ws, sub] of this.sockets) {
          if (ws.readyState === WebSocket.OPEN && !sub.scope) ws.send(payload);
        }
      },
      ...(opts.hubFactory ? { hubFactory: opts.hubFactory } : {}),
      ...(opts.runnerExec ? { runnerExec: opts.runnerExec } : {}),
      // Phase 5: a runner opens each goal's fresh clone as its own project, and drops it after.
      openProject: async (dir, name) => this.runtime(registerProject(dir, name).id),
      closeProject: async (rt) => {
        await rt.close().catch(() => {});
        this.runtimes.delete(rt.info.id);
        unregisterProject(rt.info.id);
      },
    });
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
    app.use(express.json({ limit: "2mb" }));

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

    // Public: the phone app shell (its API calls are bearer-authed),
    // health, and the pairing claim (the pairing token IS the auth).
    app.get("/", (_req, res) => res.redirect("/app"));
    app.get("/app", (_req, res) => {
      // The telemetry backend's own UI, for the Observatory's trace deep links.
      // Stripped of quote/angle characters because it lands inside a JS string
      // literal in the shell. Empty when unset, and the page hides the links
      // rather than pointing them at a guessed port.
      const traceUi = (process.env.LOOM_TRACE_UI_URL || "").replace(/["'<>]/g, "");
      // Never cache the shell: a redeployed daemon must serve its own UI.
      res
        .type("html")
        .setHeader("Cache-Control", "no-store")
        .send(APP_HTML.replace("%%TRACE_UI_URL%%", traceUi).replace("%%BUILD_REV%%", BUILD_REV));
    });
    app.get("/app/manifest.webmanifest", (_req, res) => {
      res
        .type("application/manifest+json")
        .setHeader("Cache-Control", "no-store")
        .send(JSON.stringify(APP_MANIFEST));
    });
    // The UI sans (Geist, SIL OFL 1.1) — embedded so the app works offline
    // on the tailnet with no CDN. Immutable: cache hard.
    app.get("/app/fonts/geist.woff2", (_req, res) => {
      res
        .type("font/woff2")
        .setHeader("Cache-Control", "public, max-age=31536000, immutable")
        .send(GEIST_WOFF2);
    });
    // xterm.js and its addons, served straight from node_modules — the app has
    // no build step and must work offline on a tailnet, so no bundler, no CDN.
    // These are plain UMD files the browser loads with <script>.
    const vendor: Record<string, [string, string]> = {
      "xterm.js": ["@xterm/xterm/lib/xterm.js", "application/javascript"],
      "xterm.css": ["@xterm/xterm/css/xterm.css", "text/css"],
      "addon-fit.js": ["@xterm/addon-fit/lib/addon-fit.js", "application/javascript"],
      "addon-web-links.js": [
        "@xterm/addon-web-links/lib/addon-web-links.js",
        "application/javascript",
      ],
    };
    app.get("/app/vendor/:file", (req, res) => {
      const entry = vendor[String(req.params.file)];
      if (!entry) return void res.status(404).end();
      try {
        res
          .type(entry[1])
          .setHeader("Cache-Control", "public, max-age=31536000, immutable")
          .send(fs.readFileSync(createRequire(import.meta.url).resolve(entry[0])));
      } catch {
        res.status(404).end();
      }
    });
    app.get("/api/health", (_req, res) => {
      res.json({
        ok: true,
        name: "loom",
        version: VERSION,
        rev: BUILD_REV,
        terminal: this.terminals.mode,
      });
    });

    app.post("/api/pair/claim", (req, res) => {
      const { token, name } = (req.body ?? {}) as { token?: string; name?: string };
      if (!token) return void res.status(400).json({ error: "missing token" });
      // A pairing token is the only credential this route takes, so guessing
      // is throttled: ten wrong ones from one address and it waits.
      const who = String(req.headers["x-loom-via"] ? "relay" : req.socket.remoteAddress ?? "?");
      const now = Date.now();
      const tries = this.claimTries.get(who);
      if (tries && tries.until > now && tries.fails >= 10) {
        const mins = Math.ceil((tries.until - now) / 60_000);
        res.setHeader("Retry-After", String(Math.ceil((tries.until - now) / 1000)));
        return void res.status(429).json({ error: `too many wrong pairing codes from here — try again in ${mins} minute${mins === 1 ? "" : "s"}` });
      }
      const claimed = this.auth.claim(token, name ?? "device");
      if (!claimed) {
        const t = tries && tries.until > now ? tries : { fails: 0, until: now + 10 * 60_000 };
        t.fails++;
        this.claimTries.set(who, t);
        if (this.claimTries.size > 1000) this.claimTries.clear(); // bounded, whatever happens
        return void res.status(403).json({ error: "invalid or expired pairing token" });
      }
      this.claimTries.delete(who);
      res.json(claimed);
    });

    /**
     * The local admin console bootstraps here — before the bearer wall, gated by
     * the socket being loopback. A same-machine caller gets the admin token (it
     * lives in a config file they can already read), which is what lets the web
     * app served on localhost mint pairing codes and open phone access. Everyone
     * else — a phone on the tailnet, anything past localhost — is turned away and
     * pairs like any other device. Admin-ness stays a property of the *token*,
     * so a paired client is never an admin no matter where it connects from.
     */
    app.get("/api/bootstrap", (req, res) => {
      // Both must hold: the TCP peer is loopback (can't be spoofed by a header),
      // AND the Host is a loopback literal (defeats DNS rebinding, where the
      // socket is loopback but the browser sends the attacker's hostname).
      // A relayed request arrives from loopback too — it must never be local.
      if (req.headers["x-loom-via"] || !isLoopback(req.socket.remoteAddress) || !isLoopbackHost(req.headers.host)) {
        return void res.status(403).json({ error: "not a local request" });
      }
      res.json({ token: this.auth.adminToken(), admin: true });
    });

    // An agent in "always ask" mode files a permission request here, through
    // Loom's MCP approval server (src/mcp/approve.ts), and the response waits
    // until a human decides. Guarded by the per-daemon approval secret, not a
    // client token: the MCP child can file requests and nothing else.
    app.post("/api/approvals/request", (req, res) => {
      const ep = approvalEndpoint();
      const given = String(req.headers["x-loom-approval"] ?? "");
      if (!ep || given.length !== ep.secret.length ||
          !crypto.timingSafeEqual(Buffer.from(given), Buffer.from(ep.secret))) {
        return void res.status(403).json({ error: "bad approval secret" });
      }
      const b = (req.body ?? {}) as { project?: string; agent?: string; tool?: string; input?: unknown };
      const info = b.project ? findProject(String(b.project)) : undefined;
      if (!info) return void res.status(400).json({ error: "unknown project" });
      void (async () => {
        const pending = await this.askHuman({
          project: info.id,
          agent: String(b.agent ?? "agent"),
          tool: String(b.tool ?? "tool"),
          input: b.input ?? {},
        }).catch((err) => ({ behavior: "deny" as const, message: String((err as Error).message) }));
        if (!res.writableEnded) res.json(pending);
      })();
      // An agent that hangs up has stopped waiting; don't hold the card open.
      req.on("close", () => this.abandonApprovals(info.id, String(b.agent ?? "agent")));
    });

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

    /**
     * What this machine still needs — the same answer `loom doctor` gives.
     *
     * Behind the auth wall on purpose: it enumerates which agents you have
     * installed and which GUI apps are open, a small inventory of your machine
     * and none of a stranger's business — which matters the moment the daemon
     * binds past localhost (--host, Tailscale).
     *
     * Probing GUI bridges means a couple of HTTP round trips to their debug
     * ports, so this is a request you make when you open Settings, not something
     * the app polls.
     */
    app.get("/api/setup", (_req, res) => {
      void setupReport()
        .then((report) => res.json(report))
        .catch((err) => res.status(500).json({ error: String(err?.message ?? err) }));
    });

    /**
     * `loom doctor`, over HTTP — the env checks always, plus one project's
     * checks when a ?project is given. Dynamically imported so doctor.js (which
     * pulls BUILD_REV back out of this file) doesn't create an import cycle at
     * module-init time.
     */
    app.get("/api/doctor", (req, res) => {
      void (async () => {
        try {
          const { envChecks, projectChecks } = await import("../cli/doctor.js");
          const checks = await envChecks();
          const projId = (req.query as Record<string, string>).project;
          if (projId) {
            const info = findProject(projId);
            if (info) checks.push(...projectChecks(info.dir));
          }
          res.json({ checks });
        } catch (err) {
          res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
        }
      })();
    });

    /**
     * Is this Loom current? Version + build rev, and — when Loom itself is a git
     * checkout — how many commits its own tree is behind its remote. Honest about
     * the two different "updates" that matter: a newer daemon build waiting to be
     * restarted (rev), and newer code waiting to be pulled (behind).
     */
    /**
     * Providers: where a model agent's turns go.
     *
     * Machine-wide, not per-project, because a key is a property of this
     * machine. Nothing here returns a key — `hint` is the last four
     * characters, which tells two keys apart and uses neither.
     */
    app.get("/api/providers", (_req, res) => {
      res.json({ providers: listProviders() });
    });

    app.post("/api/providers/:id", (req, res) => {
      const body = (req.body ?? {}) as {
        key?: string;
        baseUrl?: string;
        label?: string;
        headers?: Record<string, string>;
      };
      try {
        setProvider(String(req.params.id), {
          ...(typeof body.key === "string" ? { key: body.key } : {}),
          ...(typeof body.baseUrl === "string" ? { baseUrl: body.baseUrl } : {}),
          ...(typeof body.label === "string" ? { label: body.label } : {}),
          ...(body.headers ? { headers: body.headers } : {}),
        });
      } catch (err) {
        return void res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
      }
      res.json({ providers: listProviders() });
    });

    app.delete("/api/providers/:id", (req, res) => {
      const forgotten = forgetProvider(String(req.params.id));
      res.json({ forgotten, providers: listProviders() });
    });

    /** What every configured provider can run right now. */
    app.get("/api/models", (req, res) => {
      void (async () => {
        const q = req.query as Record<string, string | undefined>;
        const refresh = q.refresh === "1";
        if (q.provider) {
          const p = resolveProvider(q.provider);
          if (!p) return void res.status(404).json({ error: `no provider "${q.provider}"` });
          const got = await fetchModels(p, refresh ? { refresh: true } : {});
          return void res.json({
            models: got.models,
            cached: got.cached,
            errors: got.error ? [{ provider: p.id, error: got.error }] : [],
          });
        }
        const got = await allModels(refresh ? { refresh: true } : {});
        res.json({ models: got.models, errors: got.errors });
      })();
    });

    app.get("/api/updates", (req, res) => {
      void (async () => {
        const root = loomRoot();
        let git = null;
        if (root) {
          const { remoteBehind } = await import("../core/git.js");
          git = await remoteBehind(root).catch(() => null);
        }
        const release = await this.cachedRelease(req.query.refresh !== undefined);
        const install = detectInstall(path.dirname(fileURLToPath(import.meta.url)));
        const p = plan(install);
        res.json({
          version: VERSION,
          rev: BUILD_REV,
          root,
          git,
          // The release half: what's published, and whether this copy can fetch it.
          latest: release?.version ?? null,
          release,
          behindRelease: release ? newerThan(release.version, VERSION) : false,
          install: p.install,
          canApply: p.refusal === null,
          refusal: p.refusal,
          steps: p.steps.map((x) => [x.cmd, ...x.args].join(" ")),
        });
      })();
    });

    /**
     * Bring this copy up to date, in the words the plan showed.
     *
     * The update runs as a sequence of real commands whose output goes to the
     * logbook (and so to every open client, live). When it finishes, the daemon
     * exits: whatever started it — the CLI's ensureDaemon, the desktop shell,
     * a service manager — brings it back on the new build, which is also how a
     * stale build is replaced today.
     */
    app.post("/api/updates/apply", (req, res) => {
      // Updating replaces the code this machine runs: the local admin only,
      // never a paired phone.
      if (!(req as Request & { isAdmin?: boolean }).isAdmin) {
        return void res.status(403).json({ error: "admin only" });
      }
      void (async () => {
        if (this.updating) return void res.status(409).json({ error: "an update is already running" });
        const install = detectInstall(path.dirname(fileURLToPath(import.meta.url)));
        const p = plan(install);
        if (p.refusal) return void res.status(400).json({ error: p.refusal });
        if (p.install === "git" && p.cwd) {
          const dirty = await defaultExec("git", ["status", "--porcelain"], p.cwd);
          const refusal = refuseDirtyCheckout(dirty.out);
          if (refusal) return void res.status(400).json({ error: refusal });
        }
        this.updating = true;
        res.json({ started: true, steps: p.steps.map((x) => [x.cmd, ...x.args].join(" ")) });
        const ran: string[] = [];
        for (const step of p.steps) {
          const line = [step.cmd, ...step.args].join(" ");
          logbook.info("update", `running ${line}`);
          const r = await defaultExec(step.cmd, step.args, p.cwd ?? process.cwd(), { timeoutMs: 15 * 60_000 });
          ran.push(line);
          if (r.code !== 0) {
            this.updating = false;
            logbook.error("update", `${line} failed (exit ${r.code})`, (r.err || r.out).slice(-4000));
            return;
          }
          if (r.out.trim()) logbook.info("update", `${step.cmd} finished`, r.out.trim().slice(-2000));
        }
        logbook.info("update", `updated via ${ran.join(" && ")} — restarting on the new build`);
        // Let the answer and the log frames reach the clients before we go.
        setTimeout(() => {
          void this.close().finally(() => process.exit(0));
        }, 750);
      })();
    });

    /**
     * Is `gh` logged in, and as whom — machine-wide, so no project needed. The
     * whole GitHub half of Loom (board PRs, Projects, review) rides on this; the
     * status bar shows it and offers Connect when it's false.
     */
    app.get("/api/github/status", (_req, res) => {
      void ghAuthStatus()
        .then((s) => res.json(s))
        .catch((err) => res.status(500).json({ error: err instanceof Error ? err.message : String(err) }));
    });

    /**
     * LoomPad connectivity — proxies the voice backend's /health so the web app
     * can show a live "LoomPad connected" pill without a cross-origin fetch. The
     * backend (orchestrator-pad) does STT -> agent -> TTS for the physical pad;
     * when it's up, the pad gets its spoken replies. Best-effort: an unreachable
     * backend just returns { up:false } (the pill goes grey), never an error.
     */
    app.get("/api/loompad/health", (_req, res) => {
      const base = (process.env.LOOMPAD_BACKEND_URL || "http://127.0.0.1:8080").replace(/\/+$/, "");
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 2500);
      void fetch(base + "/health", { signal: ctl.signal })
        .then(async (r) => {
          clearTimeout(timer);
          if (!r.ok) return void res.json({ up: false, backend: base, status: r.status });
          const body = (await r.json().catch(() => ({}))) as Record<string, unknown>;
          res.json({ up: true, backend: base, ...body });
        })
        .catch(() => {
          clearTimeout(timer);
          res.json({ up: false, backend: base });
        });
    });

    /**
     * Everything the LoomPad modal needs in one call: is the voice backend up,
     * and the two ways the pad can reach it — the LAN (same Wi-Fi) and, once
     * Tailscale is signed in, a public Funnel URL (the pad from anywhere).
     */
    app.get("/api/loompad/connect", (_req, res) => {
      // Any paired client (the desktop shell, a phone) may read this — it's local
      // backend status + LAN/tailnet addresses, not a privileged mutation. The
      // desktop runs as a client, not admin, so gating this locked it out.
      void (async () => {
        const base = (process.env.LOOMPAD_BACKEND_URL || "http://127.0.0.1:8080").replace(/\/+$/, "");
        let port = 8080;
        try {
          port = Number(new URL(base).port) || 8080;
        } catch {
          /* keep the default */
        }
        let up = false;
        let brain: unknown;
        try {
          const ctl = new AbortController();
          const timer = setTimeout(() => ctl.abort(), 2000);
          const r = await fetch(base + "/health", { signal: ctl.signal });
          clearTimeout(timer);
          if (r.ok) {
            up = true;
            brain = ((await r.json().catch(() => ({}))) as { brain?: unknown }).brain;
          }
        } catch {
          /* backend is down — up stays false */
        }
        const lan = lanIp();
        const ts = await tailscaleState();
        res.json({
          up,
          brain,
          port,
          backend: base,
          local: lan ? { ip: lan, url: `http://${lan}:${port}` } : null,
          tailnet: {
            installed: ts.installed,
            loggedIn: ts.loggedIn,
            url: ts.loggedIn && ts.dnsName ? `https://${ts.dnsName}` : null,
          },
        });
      })();
    });

    app.post("/api/loompad/funnel", (_req, res) => {
      // Same as connect: the local desktop shell drives this, and it's a client.
      void (async () => {
        const base = (process.env.LOOMPAD_BACKEND_URL || "http://127.0.0.1:8080").replace(/\/+$/, "");
        let port = 8080;
        try {
          port = Number(new URL(base).port) || 8080;
        } catch {
          /* keep the default */
        }
        try {
          const { url } = await tailscaleFunnel(port);
          res.json({ url });
        } catch (err) {
          logbook.error("loompad", "could not enable Tailscale Funnel", err);
          res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
        }
      })();
    });

    /**
     * The two networks a phone could use to reach this daemon — the LAN and the
     * tailnet — with, for each, the address and whether the phone can actually
     * get here on it *right now*. It can't when we're bound to localhost, which
     * is the default; `reachable:false` is the modal's cue to offer "enable
     * phone access" (expose) before showing a QR that wouldn't resolve.
     */
    app.get("/api/pair/networks", (req, res) => {
      if (!(req as Request & { isAdmin?: boolean }).isAdmin) {
        return void res.status(403).json({ error: "admin only" });
      }
      void (async () => {
        const exposed = this.exposedIps();
        const reach = (ip: string | null) =>
          Boolean(ip) && (this.host === "0.0.0.0" || this.host === ip || exposed.includes(ip!));
        const lan = lanIp();
        const tstate = await tailscaleState();
        const ts = tstate.loggedIn ? tstate.ip : null;
        res.json({
          port: this.port,
          boundHost: this.host,
          exposed,
          localnet: { ip: lan, reachable: reach(lan) },
          tailnet: ts
            ? { ip: ts, available: true, reachable: reach(ts), installed: true }
            : {
                ip: null,
                available: false,
                reachable: false,
                installed: false,
                signedOut: tstate.installed,
                reason: tstate.installed
                  ? "Tailscale is installed but signed out."
                  : "Tailscale isn't installed on this machine.",
              },
        });
      })();
    });

    /**
     * Tailscale, from inside the app. `status` powers the connect-a-phone modal's
     * "Start Tailscale" affordance; `up` runs `tailscale up` and hands back the
     * one-time sign-in URL so the user finishes in a browser tab — no terminal.
     */
    app.get("/api/tailscale/status", (req, res) => {
      if (!(req as Request & { isAdmin?: boolean }).isAdmin) {
        return void res.status(403).json({ error: "admin only" });
      }
      void tailscaleState().then((s) => res.json(s));
    });

    app.post("/api/tailscale/up", (req, res) => {
      if (!(req as Request & { isAdmin?: boolean }).isAdmin) {
        return void res.status(403).json({ error: "admin only" });
      }
      void tailscaleUp().then(
        (r) => res.json(r),
        (err) => {
          logbook.error("tailscale", "could not bring Tailscale up", err);
          res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
        },
      );
    });

    /**
     * Make a phone-reachable address go live — a phone can't reach a
     * localhost-only daemon. We add a second listener on the requested LAN or
     * tailnet IP (never touching localhost), so this is safe to await and report
     * on directly. Explicit and user-driven (you clicked "connect a phone"), and
     * behind the token wall the whole time.
     */
    app.post("/api/pair/expose", (req, res) => {
      if (!(req as Request & { isAdmin?: boolean }).isAdmin) {
        return void res.status(403).json({ error: "admin only" });
      }
      void (async () => {
        const wanted = typeof req.body?.host === "string" ? (req.body.host as string).trim() : "";
        let ts: string | null = null;
        try {
          ts = await tailscaleIp();
        } catch {
          ts = null;
        }
        // Only ever bind an address that is genuinely ours (LAN or tailnet).
        const allowed = new Set([lanIp(), ts].filter(Boolean) as string[]);
        if (!wanted || !allowed.has(wanted)) {
          return void res.status(400).json({ error: "not a local or tailnet address of this machine" });
        }
        try {
          await this.expose(wanted);
          res.json({ ok: true, ip: wanted, port: this.port, exposed: this.exposedIps() });
        } catch (err) {
          logbook.error("daemon", `could not open phone access on ${wanted}`, err);
          res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
        }
      })();
    });

    app.post("/api/pair/new", (req, res) => {
      if (!(req as Request & { isAdmin?: boolean }).isAdmin) {
        return void res.status(403).json({ error: "admin only" });
      }
      void (async () => {
        // The QR must point at the address the phone will actually use, so the
        // caller may ask for the LAN or tailnet host — but only those. An
        // arbitrary host from the client never reaches the link.
        const wanted = typeof req.body?.host === "string" ? (req.body.host as string).trim() : "";
        let ts: string | null = null;
        try {
          ts = await tailscaleIp();
        } catch {
          ts = null;
        }
        const allowed = new Set([this.host, lanIp(), ts].filter(Boolean) as string[]);
        const host = wanted && allowed.has(wanted) ? wanted : this.host;
        const scopeIds = Array.isArray(req.body?.projects)
          ? (req.body.projects as unknown[]).map(String).filter(Boolean)
          : [];
        // Scope is resolved to ids at mint: a name that matches nothing is a
        // typo the admin should hear about now, not a permanently useless token.
        const resolvedScope: string[] = [];
        for (const p of scopeIds) {
          const info = findProject(p);
          if (!info) {
            return void res.status(400).json({ error: `unknown project "${p}" in scope` });
          }
          resolvedScope.push(info.id);
        }
        const { token, expiresAt } = this.auth.newPairingToken(
          resolvedScope.length ? resolvedScope : undefined,
        );
        const url = `http://${host}:${this.port}`;
        // Deep link: scanning it with any camera opens the app, which claims the
        // single-use token from the URL fragment and pairs itself.
        // With Loom Cloud on, the fragment also carries the relay channel + key
        // and the Supabase project, so the phone can reach this daemon from any
        // network. Fragment only: none of it is ever sent to a server.
        const cloud = this.cloudLinkParams();
        const link = `${url}/app#pair=${token}${cloud}`;
        let qrSvg: string | undefined;
        try {
          qrSvg = await QRCode.toString(link, {
            type: "svg",
            margin: 1,
            errorCorrectionLevel: "M",
          });
        } catch (err) {
          // The link still works even if the QR doesn't render — degrade, don't fail.
          logbook.warn("pair", "QR render failed — the copy link still works", err);
        }
        res.json({ token, expiresAt, url, link, ...(qrSvg ? { qrSvg } : {}) });
      })();
    });

    // ---- Loom Teams: this daemon on a Team Hub (daemon/team.ts) -------------
    // Reading the team view is for any full client; changing membership,
    // keys or sign-in is admin-only — it's this machine's identity.
    app.get("/api/team", (req, res) => {
      if (this.auth.allowedProjects(bearerToken(req.headers.authorization) ?? "")) {
        return void res.status(403).json({ error: "team view needs a full (unscoped) client" });
      }
      res.json(this.team.status());
    });
    /**
     * Sign in to the hosted Team Hub with GitHub, from the app.
     *
     * It only existed in the CLI, so the app's Team screen offered a
     * self-hosted form and nothing for the hub most people use. The daemon runs
     * the same loopback sign-in the CLI does and answers with GitHub's
     * authorize URL for the app to open; when GitHub sends the browser back,
     * the session lands here and the team connects. The app watches /api/team.
     */
    let hostedPending: { startedAt: number; error?: string } | null = null;
    app.post("/api/team/hosted-signin", (req, res) => {
      if (!(req as Request & { isAdmin?: boolean }).isAdmin) {
        return void res.status(403).json({ error: "admin only" });
      }
      void (async () => {
        try {
          const { hostedHubUrl, hostedSupabaseUrl, publishableKeyFor } = await import("../core/hosted.js");
          const { hostedSignIn } = await import("../hub/supabase-client.js");
          const supabaseUrl = hostedSupabaseUrl("hosted");
          if (!supabaseUrl) throw new Error("no hosted hub is configured for this build");
          let answered = false;
          hostedPending = { startedAt: Date.now() };
          const done = hostedSignIn({
            supabaseUrl,
            publishableKey: publishableKeyFor(supabaseUrl),
            timeoutMs: 10 * 60 * 1000,
            openBrowser: (url) => {
              answered = true;
              res.json({ url });
            },
          });
          done
            .then(async (session) => {
              await this.team.signIn(hostedHubUrl(supabaseUrl), { token: session.refreshToken });
              await this.team.connect();
              hostedPending = null;
            })
            .catch((err: Error) => {
              hostedPending = { startedAt: Date.now(), error: err.message };
              if (!answered) res.status(400).json({ error: err.message });
            });
        } catch (err) {
          res.status(400).json({ error: (err as Error).message });
        }
      })();
    });
    app.get("/api/team/hosted-signin", (_req, res) => {
      res.json({ pending: Boolean(hostedPending && !hostedPending.error), error: hostedPending?.error ?? null });
    });

    app.post("/api/team/:action", (req, res) => {
      if (!(req as Request & { isAdmin?: boolean }).isAdmin) {
        return void res.status(403).json({ error: "admin only" });
      }
      const b = (req.body ?? {}) as Record<string, string | undefined>;
      const action = String(req.params.action);
      void (async () => {
        try {
          let out: unknown = { ok: true };
          if (action === "signin") {
            // no hub = the hosted one; `token` is a hosted refresh token from a CLI that ran the browser sign-in
            await this.team.signIn(b.hub ?? "", {
              ...(b.github ? { github: b.github } : {}),
              ...(b.secret ? { secret: b.secret } : {}),
              ...(b.token ? { token: b.token } : {}),
            });
            await this.team.connect();
          } else if (action === "create") out = await this.team.createTeam(String(b.name ?? ""));
          else if (action === "invite") out = await this.team.invite(b.teamId || undefined);
          else if (action === "join") {
            if (!b.link) throw new Error("missing invite link");
            out = await this.team.join(b.link, { ...(b.github ? { github: b.github } : {}), ...(b.secret ? { secret: b.secret } : {}) });
          } else if (action === "leave") await this.team.leave(b.teamId || undefined);
          else if (action === "remove") {
            if (!b.userId) throw new Error("missing userId");
            out = await this.team.removeMember(b.userId, b.teamId || undefined);
          } else if (action === "rotate") out = await this.team.rotate(b.teamId || undefined);
          else if (action === "beat") out = { sessions: await this.team.beat() };
          else if (action === "poll-github") out = { added: await this.team.pollGitHub() };
          else if (action === "webhook") {
            // Phase 6 (D83): the team's GitHub webhook — payload URL + secret, optionally installed on the repo
            const q = (req.body ?? {}) as Record<string, unknown>;
            const rt = q.projectId ? this.runtimes.get(String(q.projectId)) : undefined;
            out = await this.team.webhook({
              ...(b.teamId ? { teamId: b.teamId } : {}),
              ...(b.repo ? { repo: b.repo } : {}),
              ...(q.install ? { install: true } : {}),
              ...(q.rotate ? { rotate: true } : {}),
              ...(rt ? { rt } : {}),
            });
          }
          else return void res.status(404).json({ error: `unknown team action "${action}"` });
          res.json({ result: out, team: this.team.status() });
        } catch (err) {
          res.status(400).json({ error: (err as Error).message });
        }
      })();
    });
    // ---- this daemon as a runner (Phase 5): admin only — it's this machine ----
    app.get("/api/runner", (req, res) => {
      if (!(req as Request & { isAdmin?: boolean }).isAdmin) return void res.status(403).json({ error: "admin only" });
      res.json(this.team.runner?.status() ?? { running: false, config: this.team.runnerConfig() });
    });
    app.post("/api/runner/:action", (req, res) => {
      if (!(req as Request & { isAdmin?: boolean }).isAdmin) return void res.status(403).json({ error: "admin only" });
      const b = (req.body ?? {}) as Record<string, unknown>;
      void (async () => {
        try {
          const action = String(req.params.action);
          let out: unknown = { ok: true };
          if (action === "pair") out = { link: this.team.pairRunnerLink() };
          else if (action === "join") {
            out = await this.team.joinAsRunner(String(b.link ?? ""), {
              ...(b.github ? { github: String(b.github) } : {}),
              ...(b.secret ? { secret: String(b.secret) } : {}),
              ...(b.token ? { token: String(b.token) } : {}),
              ...(b.shared !== undefined ? { shared: Boolean(b.shared) } : {}),
            });
          } else if (action === "start") out = await this.team.startRunner({ ...(b.shared !== undefined ? { shared: Boolean(b.shared) } : {}), ...(b.capacity ? { capacity: Number(b.capacity) } : {}) });
          else if (action === "stop") await this.team.stopRunner();
          else if (action === "revoke") await this.team.revokeRunner(String(b.deviceId ?? ""));
          else return void res.status(404).json({ error: `unknown runner action "${action}"` });
          res.json({ result: out });
        } catch (err) {
          res.status(400).json({ error: (err as Error).message });
        }
      })();
    });

    // ---- Loom Cloud: reach this daemon from any network (daemon/relay.ts) ----
    app.get("/api/cloud", (_req, res) => {
      res.json(this.cloudStatus());
    });
    app.post("/api/cloud/:action", (req, res) => {
      if (!(req as Request & { isAdmin?: boolean }).isAdmin) {
        return void res.status(403).json({ error: "admin only" });
      }
      const action = String(req.params.action);
      void (async () => {
        try {
          if (action === "enable") {
            const b = (req.body ?? {}) as { supabaseUrl?: string; anonKey?: string };
            if (b.supabaseUrl || b.anonKey) {
              const s = readCloudSettings();
              if (b.supabaseUrl) s.supabaseUrl = String(b.supabaseUrl).trim();
              if (b.anonKey) s.anonKey = String(b.anonKey).trim();
              writeCloudSettings(s);
            }
            await this.startCloud();
          } else if (action === "disable") await this.stopCloud();
          else if (action === "rotate") {
            // New channel + key: every phone paired through the cloud must re-pair.
            const was = readCloudSettings().enabled;
            await this.stopCloud({ rotate: true });
            if (was) await this.startCloud();
          } else return void res.status(404).json({ error: `unknown action "${action}"` });
          res.json(this.cloudStatus());
        } catch (err) {
          res.status(400).json({ ...this.cloudStatus(), error: (err as Error).message });
        }
      })();
    });

    app.get("/api/pair/clients", (_req, res) => {
      res.json({ clients: this.auth.clients() });
    });

    app.delete("/api/pair/clients/:clientId", (req, res) => {
      if (!(req as Request & { isAdmin?: boolean }).isAdmin) {
        return void res.status(403).json({ error: "admin only" });
      }
      const revoked = this.auth.revoke(String(req.params.clientId));
      if (!revoked) return void res.status(404).json({ error: "unknown client" });
      res.json({ revoked: true });
    });

    // A paired device registers (or clears) its Expo push token.
    app.post("/api/push/register", (req, res) => {
      const me = this.auth.clientFor(bearerToken(req.headers.authorization));
      if (!me) return void res.status(403).json({ error: "device tokens only — pair first" });
      const { token, platform } = (req.body ?? {}) as { token?: string; platform?: string };
      if (!token?.trim()) return void res.status(400).json({ error: "missing token" });
      this.auth.setPushToken(me.id, token.trim(), platform);
      res.json({ registered: true });
    });

    app.delete("/api/push/register", (req, res) => {
      const me = this.auth.clientFor(bearerToken(req.headers.authorization));
      if (!me) return void res.status(403).json({ error: "device tokens only" });
      this.auth.setPushToken(me.id, null);
      res.json({ registered: false });
    });

    // Admin: fire a test push at every registered device.
    app.post("/api/push/test", (req, res) => {
      if (!(req as Request & { isAdmin?: boolean }).isAdmin) {
        return void res.status(403).json({ error: "admin only" });
      }
      const tokens = this.pushTokens();
      void sendExpoPush(tokens, {
        title: "Loom",
        body: "test notification — pairing works ✓",
      });
      res.json({ sent: tokens.length });
    });

    app.get("/api/projects", (req, res) => {
      void (async () => {
        // A scoped token's world IS its scope: other projects are not listed,
        // not greyed out — a list that names what you cannot open is a map of
        // someone else's machine.
        const scope = (req as Request & { projectScope?: string[] | null }).projectScope;
        const projects = [];
        for (const info of listProjects()) {
          if (scope && !scope.includes(info.id)) continue;
          try {
            const rt = await this.runtime(info.id);
            projects.push(await rt.status());
          } catch (err) {
            projects.push({
              id: info.id,
              name: info.name,
              dir: info.dir,
              holder: null,
              agents: [],
              lastEvent: null,
              needsInput: false,
              error: String(err instanceof Error ? err.message : err),
            });
          }
        }
        res.json({ projects });
      })();
    });

    app.post("/api/projects", (req, res) => {
      void (async () => {
        const { dir, name } = (req.body ?? {}) as { dir?: string; name?: string };
        if (!dir) return void res.status(400).json({ error: "missing dir" });
        const resolved = path.resolve(dir);
        if (!fs.existsSync(resolved)) {
          return void res.status(400).json({ error: `no such directory: ${resolved}` });
        }
        let config = readProjectConfig(resolved);
        // A config that exists but has no name is legal on disk and was silently
        // corrosive: the defaulting branch below is skipped, `--name` is ignored,
        // and `registerProject` stores `name: null`. That null then surfaces as a
        // nameless row in the project list and as a missing `project` field in
        // snapshots — which declare it as a string. ProjectConfig types `name` as
        // required, but the file is read through an unchecked cast, so the type
        // system never had a chance to notice. Fill it in, and persist, because
        // the docs tell people to hand-edit this file for agents; forgetting the
        // name while doing so should cost them nothing.
        if (config && !String(config.name ?? "").trim()) {
          config = { ...config, name: name?.trim() || path.basename(resolved) };
          writeProjectConfig(resolved, config);
        }
        if (!config) {
          // Every ADE Loom can drive, probed in parallel — see core/ades.ts.
          // This used to name claude and opencode by hand, which is how the list
          // of what Loom actually drives drifted from the list of logos it ships.
          const availability = await detectAdes();
          const agents = defaultAgentConfigs(availability);
          const routes = buildDefaultRoutes(agents);
          config = {
            name: name ?? path.basename(resolved),
            agents,
            ...(routes ? { routes } : {}),
          };
          writeProjectConfig(resolved, config);
        }
        const info = registerProject(resolved, config.name || path.basename(resolved));
        res.json({ project: info, config });
      })();
    });

    /**
     * Stop tracking a project. The opposite of POST /api/projects, which did
     * not exist until now: you could point Loom at a directory and had no
     * supported way to un-point it short of hand-editing ~/.loom/registry.json
     * and restarting the daemon. `unregisterProject` was already sitting in
     * core/registry.ts with no caller.
     *
     * Registry-only, deliberately. The project's `.loom/` — its config, its
     * event log, its memory — stays exactly where it is, so re-adding the same
     * directory later restores the whole history rather than starting a blank
     * one. Deleting a run's record because someone tidied a list is not a
     * trade this should make on the user's behalf; `rm -rf .loom` is theirs.
     *
     * The live runtime is closed first. Left open it keeps polling, holds its
     * agents, and would happily write more events into a project the API has
     * just said it no longer tracks.
     */
    app.delete("/api/projects/:id", (req, res) => {
      void (async () => {
        const id = String(req.params.id);
        const info = listProjects().find((p) => p.id === id);
        if (!info) return void res.status(404).json({ error: "no such project" });
        const rt = this.runtimes.get(id);
        if (rt) {
          await rt.close();
          this.runtimes.delete(id);
        }
        // A spec run mid-flight would keep streaming into a project the API
        // just said it no longer tracks; its daemon-side scrollback files are
        // daemon state (not the project's .loom/), so tidying them here is not
        // deleting the user's data — re-adding the project starts terminals
        // fresh, exactly as expected.
        this.specRunner.stop(id);
        try {
          const dir = path.join(ensureLoomHome(), "scrollback");
          for (const f of fs.readdirSync(dir)) {
            if (f.startsWith(`${id}-`)) fs.rmSync(path.join(dir, f), { force: true });
          }
        } catch {
          /* no scrollback dir yet */
        }
        unregisterProject(id);
        res.json({ removed: true, project: info, keptOnDisk: projectLoomDir(info.dir) });
      })();
    });

    const withRuntime = (
      handler: (rt: ProjectRuntime, req: Request, res: Response) => Promise<void>,
    ) => {
      return (req: Request, res: Response) => {
        void (async () => {
          try {
            const rt = await this.runtime(String(req.params.id));
            await handler(rt, req, res);
          } catch (err) {
            if (err instanceof NotHolderError) {
              res.status(409).json({
                error: "not_holder",
                holder: err.holder,
                agentId: err.agentId,
                message: err.message,
              });
              return;
            }
            if (err instanceof RouteActiveError) {
              res.status(409).json({ error: "route_active", message: err.message });
              return;
            }
            // Same 409 family: a firing alert has this agent out of rotation,
            // and the client should say so rather than "500".
            if (err instanceof QuarantinedError) {
              res.status(409).json({
                error: "agent_quarantined",
                agentId: err.agentId,
                reason: err.reason,
                since: err.since,
                message: err.message,
              });
              return;
            }
            // 409, like the other "the fleet is in a state that forbids this"
            // refusals. The numbers ride along so a client can say what the cap
            // was and what has been spent against it, without guessing.
            if (err instanceof BudgetExceededError) {
              res.status(409).json({
                error: "budget_exceeded",
                agentId: err.agentId,
                budgetUsd: err.budgetUsd,
                spentTodayUsd: err.spentUsd,
                message: err.message,
              });
              return;
            }
            // A 500 used to be a sentence for one caller and nothing else: no
            // stack, no record, gone the moment the fetch resolved. Now the
            // Console gets it with the stack and the route that produced it.
            logbook.error(
              "api",
              `${req.method} ${req.path} failed: ${err instanceof Error ? err.message : String(err)}`,
              err,
              String(req.params.id ?? ""),
            );
            res.status(500).json({ error: String(err instanceof Error ? err.message : err) });
          }
        })();
      };
    };

    app.get(
      "/api/projects/:id",
      withRuntime(async (rt, _req, res) => {
        res.json({ project: await rt.status() });
      }),
    );

    // Per-agent cost / turns / tokens for the fleet — the same numbers the
    // observability layer ships as gen_ai spans, served locally so the UI can
    // render them without a telemetry backend being up at all.
    app.get(
      "/api/projects/:id/metrics",
      withRuntime(async (rt, _req, res) => {
        res.json({ metrics: rt.costSummary(), kairo: kairoMetrics(rt) });
      }),
    );

    // Decision explorer: structured decisions mined from agent turns.
    app.get(
      "/api/projects/:id/decisions",
      withRuntime(async (rt, req, res) => {
        const agent = req.query.agent ? String(req.query.agent) : undefined;
        const category = req.query.category ? String(req.query.category) : undefined;
        const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 200));
        let decisions = rt.getDecisions();
        if (agent) decisions = decisions.filter((d) => d.agentId === agent);
        if (category) decisions = decisions.filter((d) => d.category === category);
        res.json({ decisions: decisions.slice(0, limit), stats: rt.decisionStats() });
      }),
    );

    // Time-Travel Replay: snapshots folded from the event log, on demand.
    app.get(
      "/api/projects/:id/snapshots",
      withRuntime(async (rt, _req, res) => {
        res.json({ snapshots: buildSnapshots(rt.log.list({ limit: 2000 })) });
      }),
    );

    // Agent self-triage: read one agent's own traces back out of the telemetry
    // store (falling back to the local event log) and root-cause its last
    // failure.
    app.get(
      "/api/projects/:id/triage/:agentId",
      withRuntime(async (rt, req, res) => {
        const agent = String(req.params.agentId ?? "");
        const events = rt.log.list({ limit: 300 });
        res.json({ triage: await triageAgent(agent, events) });
      }),
    );

    // Observatory insights, read back from the backend's ClickHouse (with a
    // local-log fallback so the panels still work when it is empty/down):
    //   spans  → Span Replay (scrub a turn's spans frame by frame)
    //   trace  → Trace Waterfall (one trace's span tree + a backend deep link)
    //   burn   → per-agent cost over time + a linear 24h projection
    //   health → the 0–100 Agent Health Score with its penalty breakdown
    app.get(
      "/api/projects/:id/insights/spans",
      withRuntime(async (rt, req, res) => {
        const agent = req.query.agent ? String(req.query.agent) : undefined;
        const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 200));
        let spans = await fetchSpans(rt.info.name, { agent, limit }).catch(() => [] as InsightSpan[]);
        let from: "backend" | "local-log" = "backend";
        if (!spans.length) {
          spans = insightSpansFromLog(rt.log.list({ limit: 400 }), agent).slice(0, limit);
          from = "local-log";
        }
        res.json({ from, spans });
      }),
    );
    app.get(
      "/api/projects/:id/insights/trace/:traceId",
      withRuntime(async (_rt, req, res) => {
        const spans = await traceSpans(String(req.params.traceId ?? "")).catch(() => [] as InsightSpan[]);
        res.json({ traceId: String(req.params.traceId ?? ""), spans });
      }),
    );

    /**
     * The other two OTel signals, read back.
     *
     * Both differ from /insights/spans in one important way: there is no
     * local-log fallback. A span can be reconstructed from the event log because
     * it summarises an event Loom already stored; a log body or a metric sample
     * cannot be, and faking one would put a number on screen the telemetry
     * backend never saw. So when ClickHouse is unreachable these return
     * `from: "unavailable"` with an empty payload and the UI is expected to say
     * the backend is unreachable rather than render a plausible-looking empty
     * chart.
     *
     * `rt.info.name` — not the project id — is the filter value, because that is
     * what Loom stamps onto loom.project when it exports (same as the span
     * routes above).
     */
    app.get(
      "/api/projects/:id/insights/logs",
      withRuntime(async (rt, req, res) => {
        const limit = Math.min(1000, Math.max(1, Number(req.query.limit) || 200));
        let from: "backend" | "unavailable" = "backend";
        const logs = await fetchLogs({
          project: rt.info.name,
          agent: req.query.agent ? String(req.query.agent) : undefined,
          severity: req.query.severity ? String(req.query.severity) : undefined,
          traceId: req.query.traceId ? String(req.query.traceId) : undefined,
          search: req.query.q ? String(req.query.q) : undefined,
          limit,
        }).catch(() => {
          from = "unavailable";
          return [] as InsightLog[];
        });
        res.json({ from, logs });
      }),
    );

    app.get(
      "/api/projects/:id/insights/metrics",
      withRuntime(async (rt, req, res) => {
        // `names` is a comma list; omitting it means "everything Loom emits".
        const names = String(req.query.names ?? "")
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        // `since` accepts either an absolute epoch-ms or a lookback in ms; a
        // value small enough to be a duration cannot be a real 2020s timestamp.
        const raw = Number(req.query.since) || 0;
        const now = Date.now();
        const sinceMs = raw <= 0 ? now - 6 * 3600_000 : raw < 1e12 ? now - raw : raw;
        const stepMs = Math.max(1000, Number(req.query.step) || 60_000);
        let from: "backend" | "unavailable" = "backend";
        const series = await fetchMetricSeries(names.length ? names : LOOM_METRIC_NAMES, {
          project: rt.info.name,
          sinceMs,
          stepMs,
        }).catch(() => {
          from = "unavailable";
          return [] as MetricSeries[];
        });
        res.json({ from, sinceMs, stepMs, series });
      }),
    );

    /**
     * Ask the Observatory a question about this fleet.
     *
     * The evidence is assembled from the same sources the Observatory renders —
     * status, metrics, health, spans, decisions — so an answer can never cite a
     * number the screen doesn't also show. Any MCP servers the project has
     * configured are handed to the model for the turn, which is the point: when
     * one of them fronts the telemetry store, let the model query it directly
     * rather than trusting a summary.
     */
    app.post(
      "/api/projects/:id/observatory/ask",
      withRuntime(async (rt, req, res) => {
        const question = String((req.body ?? {}).question ?? "").trim();
        if (!question) return void res.status(400).json({ error: "missing question" });

        const status = await rt.status();
        const metrics = rt.costSummary();
        const byAgent = new Map(metrics.byAgent.map((a) => [a.agentId, a]));

        let spans = await fetchSpans(rt.info.name, { limit: 120 }).catch(() => [] as InsightSpan[]);
        let spanSource = "backend";
        if (!spans.length) {
          spans = insightSpansFromLog(rt.log.list({ limit: 300 })).slice(0, 120);
          spanSource = "local-log";
        }

        const ctx: AskContext = {
          projectName: rt.info.name,
          spendUsd: metrics.totalUsd ?? 0,
          turns: metrics.turns ?? 0,
          tokensIn: metrics.tokensIn ?? 0,
          tokensOut: metrics.tokensOut ?? 0,
          holder: status.holder ?? null,
          agents: status.agents.map((a) => {
            const mine = spans.filter((s) => s.agent === a.id);
            return {
              id: a.id, kind: a.kind, role: a.role, busy: a.busy,
              turns: byAgent.get(a.id)?.turns, usd: byAgent.get(a.id)?.usd,
              // Scored the same way the Metrics tab scores it: this agent's own
              // spans, so the answer and the screen can never disagree.
              health: mine.length ? healthScore(mine).score : null,
            };
          }),
          recentSpans: spans.slice(-40).map((s) => ({ ts: s.ts, agent: s.agent, name: s.name, ms: s.ms, code: s.code, model: s.model, msg: s.msg })),
          decisions: rt.getDecisions().map((d) => ({ agentId: d.agentId, title: d.title, category: d.category, confidence: d.confidence, source: d.source })),
          spanSource,
        };

        // Hand over the project's real MCP servers for this question, exactly
        // as a turn would get them.
        const session = writeMcpSession(rt.config.mcps);
        try {
          const result = await ask(question, ctx, {
            cwd: rt.info.dir,
            ...(session?.configPath ? { mcpConfigPath: session.configPath } : {}),
            mcpServers: (session?.servers ?? []).map((s) => s.name),
          });
          res.json({ ...result, spanSource, evidenceAgents: ctx.agents.length, evidenceSpans: ctx.recentSpans.length });
        } finally {
          session?.cleanup?.();
        }
      }),
    );
    app.get(
      "/api/projects/:id/insights/burn",
      withRuntime(async (rt, req, res) => {
        const hours = Math.min(720, Math.max(1, Number(req.query.hours) || 24));
        const buckets = Math.min(60, Math.max(2, Number(req.query.buckets) || 12));
        const series = await burnSeries(rt.info.name, { hours, buckets }).catch(() => null);
        // `budgetStatus` is what the caps are actually measured against — the
        // day's real spend per agent and whether it has run out. The bare
        // `budgets` map stays for the inputs that edit it.
        res.json({ burn: series, budgets: rt.budgets(), budgetStatus: rt.budgetStatus() });
      }),
    );
    // Turns off the log: the agent leaderboard, a per-day count for the
    // activity heatmap, and every turn as CSV.
    app.get(
      "/api/projects/:id/insights/turns",
      withRuntime(async (rt, req, res) => {
        const days = Math.min(366, Math.max(7, Number(req.query.days) || 84));
        const rows = turnRows(rt.log.list({ kinds: ["run_complete", "error"], limit: 50_000 }));
        // ?since= (ms) narrows the leaderboard to a window — "today", for loom stats
        const since = Number(req.query.since) || 0;
        const board = leaderboard(since ? rows.filter((r) => r.ts >= since) : rows);
        res.json({ leaderboard: board, days: perDay(rows, days), total: rows.length });
      }),
    );
    app.get(
      "/api/projects/:id/insights/turns.csv",
      withRuntime(async (rt, _req, res) => {
        const rows = turnRows(rt.log.list({ kinds: ["run_complete", "error"], limit: 50_000 }));
        const safe = rt.info.name.replace(/[^\w.-]+/g, "-");
        res
          .type("text/csv")
          .setHeader("Content-Disposition", `attachment; filename="${safe}-turns.csv"`)
          .send(turnsCsv(rows));
      }),
    );
    app.get(
      "/api/projects/:id/insights/health",
      withRuntime(async (rt, req, res) => {
        const agent = req.query.agent ? String(req.query.agent) : undefined;
        let spans = await fetchSpans(rt.info.name, { agent, limit: 300 }).catch(() => [] as InsightSpan[]);
        let from: "backend" | "local-log" = "backend";
        if (!spans.length) {
          spans = insightSpansFromLog(rt.log.list({ limit: 500 }), agent);
          from = "local-log";
        }
        if (agent) return void res.json({ from, health: healthScore(spans) });
        // Fleet: one score per agent (its own turns/errors), plus the overall.
        const byAgent: Record<string, ReturnType<typeof healthScore>> = {};
        for (const a of [...new Set(spans.map((s) => s.agent).filter(Boolean))]) {
          byAgent[a] = healthScore(spans.filter((s) => s.agent === a));
        }
        res.json({ from, overall: healthScore(spans), byAgent });
      }),
    );

    // Budget CRUD for the burn-rate panel — per-agent USD/day, persisted in
    // state and enforced on every dispatch (see ProjectRuntime#enforceBudget).
    // `status` carries today's real spend against each cap, so the panel can
    // show how close an agent is instead of only what was typed in.
    app.get(
      "/api/projects/:id/budgets",
      withRuntime(async (rt, _req, res) => {
        res.json({ budgets: rt.budgets(), status: rt.budgetStatus() });
      }),
    );
    app.put(
      "/api/projects/:id/budgets/:agentId",
      withRuntime(async (rt, req, res) => {
        const usd = Number((req.body as Record<string, unknown>)?.usdPerDay ?? 0);
        const budgets = rt.setBudget(String(req.params.agentId ?? ""), usd);
        res.json({ budgets, status: rt.budgetStatus() });
      }),
    );

    /**
     * Self-healing loop: an alert posts here.
     *   firing   → quarantine the failing agent and fail the baton over to a
     *              fallback (Loom keeps working while the agent is degraded).
     *   resolved → lift the quarantine and hand the baton BACK to the original
     *              agent — a real pause-then-retry, not a one-way failover.
     * Closing the loop from metric breach → intervention → recovery → retry.
     *
     * The body is an Alertmanager-style payload, which is what every backend
     * Loom is pointed at already sends — SigNoz, Prometheus/Alertmanager and
     * Grafana all POST the same `{status, alerts: [{status, labels}]}` shape.
     * So the route is named for the payload it accepts rather than for one
     * vendor, and a single webhook channel configured anywhere reaches it.
     */
    app.post("/api/webhooks/alerts", (req, res) => {
      void (async () => {
        const secret = process.env.LOOM_WEBHOOK_SECRET;
        if (secret && req.query.token !== secret && req.headers["x-loom-secret"] !== secret) {
          return void res.status(401).json({ error: "unauthorized" });
        }
        // No secret set is fine on loopback and nowhere else.
        //
        // This route sits in front of the bearer wall on purpose — an alert
        // sender posts here and has no Loom token — and its own secret was
        // optional, which together meant a daemon started with --host or
        // --tailnet served an unauthenticated endpoint that can quarantine an
        // agent, move the baton, and append status events the shared brain then
        // reads. On 127.0.0.1 that is a local-user-only capability and an
        // acceptable default; reachable from a network it is a stranger
        // steering the fleet. The comment on the auth bypass already said "set
        // that secret whenever the daemon binds past localhost" — this makes it
        // true rather than advisory, and says which variable to set instead of
        // just refusing.
        if (!secret && !isLoopbackHost(this.host)) {
          return void res.status(401).json({
            error:
              "this daemon is not bound to localhost, so the webhook needs LOOM_WEBHOOK_SECRET set",
          });
        }
        const body = (req.body ?? {}) as Record<string, unknown>;
        const rawAlerts = Array.isArray(body.alerts) ? (body.alerts as Record<string, unknown>[]) : [body];
        const q = req.query as Record<string, string>;
        const common = (body.commonLabels ?? {}) as Record<string, string>;
        const actions: Array<Record<string, unknown>> = [];
        for (const raw of rawAlerts) {
          const al = (raw ?? {}) as Record<string, unknown>;
          const labels = { ...common, ...((al.labels ?? {}) as Record<string, string>) };
          const status = String(al.status ?? body.status ?? "firing");
          const projectRef = labels["loom.project"] ?? labels.loom_project ?? q.project;
          const agent = labels["gen_ai.agent.id"] ?? labels.gen_ai_agent_id ?? labels.agent ?? q.agent;
          const alertName = String(labels.alertname ?? body.title ?? "alert");
          if (status !== "firing" && status !== "resolved") { actions.push({ skipped: `status "${status}"` }); continue; }
          if (!agent) { actions.push({ skipped: "no agent label on alert" }); continue; }
          const infos = listProjects();
          // A project ref must actually match — never silently act on an arbitrary
          // project. Only auto-pick when there's exactly one project and no ref.
          const info = projectRef
            ? infos.find((p) => p.name === projectRef || p.id === projectRef)
            : infos.length === 1 ? infos[0] : undefined;
          if (!info) {
            actions.push({ skipped: projectRef ? `no project matching "${projectRef}"` : "project label required (multiple projects)" });
            continue;
          }
          try {
            const rt = await this.runtime(info.id);
            if (status === "resolved") {
              // Recovery: retry the original agent if we had quarantined it.
              const q0 = rt.unquarantine(String(agent));
              if (!q0) { actions.push({ project: info.name, agent, alert: alertName, action: "resolved (was not quarantined)" }); continue; }
              const holder = rt.baton.holder();
              const retried = q0.displaced && holder !== agent;
              if (retried) await rt.handoff(String(agent));
              rt.log.append({ kind: "status", agentId: String(agent),
                payload: { state: "alert_recovery", alert: alertName, retried, pausedMs: Date.now() - q0.since } });
              actions.push({ project: info.name, agent, alert: alertName,
                action: retried ? `recovered — baton handed back to ${agent}` : "recovered — quarantine lifted" });
              continue;
            }
            // Firing: pause the agent and fail the baton over.
            const holder = rt.baton.holder();
            const agents = (await rt.status()).agents;
            const fallback = agents.find((a) => a.id !== agent)?.id;
            const displaced = holder === agent && !!fallback;
            rt.quarantine(String(agent), alertName, displaced);
            rt.log.append({ kind: "status", agentId: String(agent),
              payload: { state: "alert_intervention", alert: alertName, holder, fallback: fallback ?? null } });
            // Start the recheck loop: pause → recheck → return the baton if the
            // agent stops erroring, retrying a few times before giving up.
            this.startHealLoop(rt, String(agent), alertName, Date.now());
            if (displaced) {
              await rt.handoff(fallback!);
              actions.push({ project: info.name, agent, alert: alertName, action: `quarantined; baton handed to ${fallback}` });
            } else {
              actions.push({ project: info.name, agent, alert: alertName,
                action: fallback ? "quarantined (agent wasn't holding the baton)" : "quarantined (no fallback agent)" });
            }
          } catch (e) {
            actions.push({ agent, error: e instanceof Error ? e.message : String(e) });
          }
        }
        res.json({ ok: true, actions });
      })();
    });

    app.get(
      "/api/projects/:id/events",
      withRuntime(async (rt, req, res) => {
        const since = req.query.since ? Number(req.query.since) : undefined;
        // ?before= pages backwards: the thread's "earlier messages"
        const before = req.query.before ? Number(req.query.before) : undefined;
        const limit = req.query.limit ? Number(req.query.limit) : 200;
        // no ?chat= means the whole project — old clients keep seeing the
        // whole thread, which is what they've always shown
        const chat = req.query.chat ? String(req.query.chat) : undefined;
        const events = rt.log.list({
          since,
          limit,
          ...(before !== undefined && Number.isFinite(before) ? { before } : {}),
          ...(chat ? { chat } : {}),
        });
        // A thread's first page also carries the replies being typed in it
        // right now: reload mid-reply and you see the reply so far.
        const opening = chat && since === undefined && before === undefined;
        res.json({ events, ...(opening ? { live: rt.liveNow(chat) } : {}) });
      }),
    );

    app.post(
      "/api/projects/:id/messages",
      withRuntime(async (rt, req, res) => {
        const { text, agentId, chat, plan } = (req.body ?? {}) as {
          text?: string;
          agentId?: string;
          chat?: string;
          plan?: boolean;
        };
        if (!text?.trim()) return void res.status(400).json({ error: "missing text" });
        const result = await rt.sendMessage(text, agentId, { ...(chat ? { chat } : {}), ...(plan ? { plan: true } : {}) });
        recordRecent(text, { project: rt.info.name, mode: plan ? "plan" : "chat" });
        res.json(result);
      }),
    );

    /**
     * The project's dev servers: what's configured, and what each one is doing.
     *
     * "Running" means a port answered, not that a process exists — the
     * difference is the whole point of Loom knowing about them (core/servers.ts).
     */
    app.get(
      "/api/projects/:id/servers",
      withRuntime(async (rt, _req, res) => {
        res.json({ servers: rt.servers.list(), suggested: suggestServers(rt.info.dir) });
      }),
    );
    app.post(
      "/api/projects/:id/servers",
      withRuntime(async (rt, req, res) => {
        const b = (req.body ?? {}) as { servers?: unknown };
        if (!Array.isArray(b.servers)) return void res.status(400).json({ error: "servers must be a list" });
        try {
          const servers = b.servers.map(parseServerConfig);
          writeProjectConfig(rt.info.dir, { ...rt.config, servers });
          rt.config.servers = servers;
          res.json({ servers: rt.servers.list() });
        } catch (err) {
          res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
        }
      }),
    );
    for (const action of ["start", "stop", "restart"] as const) {
      app.post(
        `/api/projects/:id/servers/:name/${action}`,
        withRuntime(async (rt, req, res) => {
          try {
            const status = await rt.servers[action](String(req.params.name));
            res.json({ server: status });
          } catch (err) {
            res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
          }
        }),
      );
    }
    /**
     * Preview a server through Loom, so the page can report back.
     *
     * A dev server is a different origin, and one origin can't read another's
     * console. Loom stands in front of it instead (core/preview-proxy.ts) and
     * injects a script that posts what the page logs, fetches and throws. Each
     * server gets one proxy, started when first asked for.
     */
    app.post(
      "/api/projects/:id/servers/:name/preview",
      withRuntime(async (rt, req, res) => {
        try {
          const cfg = rt.servers.mustConfig(String(req.params.name));
          // configured, or else what the running server announced it's on
          const target = urlFor(cfg) ?? rt.servers.status(cfg).url ?? null;
          if (!target) return void res.status(400).json({ error: `server "${cfg.name}" has no port or url to preview` });
          const proxy = await rt.previewProxy(cfg.name, target);
          res.json({ url: `http://127.0.0.1:${proxy.port}`, target, bridged: true });
        } catch (err) {
          res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
        }
      }),
    );

    /** A server's recent output — the log pane, and what an agent reads. */
    app.get(
      "/api/projects/:id/servers/:name/log",
      withRuntime(async (rt, req, res) => {
        try {
          rt.servers.mustConfig(String(req.params.name));
          const limit = req.query.limit ? Math.max(1, Number(req.query.limit)) : 200;
          res.json({ lines: rt.servers.log(String(req.params.name), limit) });
        } catch (err) {
          res.status(404).json({ error: err instanceof Error ? err.message : String(err) });
        }
      }),
    );

    /**
     * The PR a card would open: the branch, its commits, its files, and the
     * exact command. Looking, not doing — pushing publishes, so nothing here
     * happens without the click that follows.
     */
    app.get(
      "/api/projects/:id/tasks/:taskId/pr",
      withRuntime(async (rt, req, res) => {
        try {
          res.json(await rt.taskPrPlan(String(req.params.taskId)));
        } catch (err) {
          res.status(404).json({ error: err instanceof Error ? err.message : String(err) });
        }
      }),
    );
    app.post(
      "/api/projects/:id/tasks/:taskId/pr",
      withRuntime(async (rt, req, res) => {
        try {
          res.json(await rt.openTaskPr(String(req.params.taskId)));
        } catch (err) {
          res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
        }
      }),
    );

    /**
     * What happened while you were away.
     *
     * `since` is the client's own idea of when it last looked — the daemon
     * doesn't track attention, and guessing at it would be worse than asking.
     */
    app.get(
      "/api/projects/:id/digest",
      withRuntime(async (rt, req, res) => {
        const since = req.query.since ? Number(req.query.since) : Date.now() - 12 * 3_600_000;
        const events = rt.log.list({ limit: 4000 });
        const label = (id: string) => rt.config.agents.find((a) => a.id === id)?.role ?? id;
        res.json(digest(events, Number.isFinite(since) ? since : 0, label));
      }),
    );

    /** The queue as clients read it: the items, plus why the head is waiting. */
    const queueView = (rt: ProjectRuntime) => {
      const q = rt.queue.snapshot();
      const head = q.items[0];
      const waitingFor = head && !q.paused ? rt.queueBlocker(head) : null;
      return { queue: q.items, paused: q.paused, ...(q.reason ? { reason: q.reason } : {}), ...(waitingFor ? { waitingFor } : {}) };
    };
    const queueError = (res: express.Response, err: unknown) =>
      void res.status(err instanceof QueueItemGone ? 404 : 400).json({ error: err instanceof Error ? err.message : String(err) });

    /**
     * The prompt queue: what you've lined up for this project.
     *
     * A prompt typed while an agent is mid-turn — or a goal typed while one is
     * still running — waits here instead of being refused, and stays yours
     * until it's sent: edit the text, change who takes it, reorder it, drop it.
     * The daemon sends the head as soon as nothing is in its way, one at a time.
     */
    app.get(
      "/api/projects/:id/queue",
      withRuntime(async (rt, _req, res) => {
        res.json(queueView(rt));
      }),
    );
    app.post(
      "/api/projects/:id/queue",
      withRuntime(async (rt, req, res) => {
        const b = (req.body ?? {}) as { text?: string; target?: unknown; chat?: string; plan?: boolean; when?: unknown };
        if (!b.text?.trim()) return void res.status(400).json({ error: "missing text" });
        try {
          const item = rt.enqueue({
            text: b.text,
            target: parseTarget(b.target),
            ...(b.chat ? { chat: b.chat } : {}),
            ...(b.plan ? { plan: true } : {}),
            ...(parseCondition(b.when) ? { when: parseCondition(b.when)! } : {}),
          });
          recordRecent(b.text, { project: rt.info.name, mode: item.target.kind === "orchestra" ? "orchestrate" : "chat" });
          res.json({ item, ...queueView(rt) });
        } catch (err) {
          res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
        }
      }),
    );
    app.patch(
      "/api/projects/:id/queue/:itemId",
      withRuntime(async (rt, req, res) => {
        const b = (req.body ?? {}) as { text?: string; target?: unknown; plan?: boolean; to?: number; when?: unknown };
        try {
          if (b.text !== undefined || b.target !== undefined || b.plan !== undefined || b.when !== undefined) {
            rt.editQueued(String(req.params.itemId), {
              ...(b.text !== undefined ? { text: String(b.text) } : {}),
              ...(b.target !== undefined ? { target: parseTarget(b.target) } : {}),
              ...(b.plan !== undefined ? { plan: Boolean(b.plan) } : {}),
              // null clears it: "go as soon as you can"
              ...(b.when !== undefined ? { when: b.when === null ? null : parseCondition(b.when) ?? null } : {}),
            });
          }
          if (b.to !== undefined) rt.queue.move(String(req.params.itemId), Number(b.to));
          void rt.drainPromptQueue();
          res.json(queueView(rt));
        } catch (err) {
          queueError(res, err);
        }
      }),
    );
    app.delete(
      "/api/projects/:id/queue/:itemId",
      withRuntime(async (rt, req, res) => {
        try {
          rt.queue.remove(String(req.params.itemId));
          void rt.drainPromptQueue();
          res.json(queueView(rt));
        } catch (err) {
          queueError(res, err);
        }
      }),
    );
    app.delete(
      "/api/projects/:id/queue",
      withRuntime(async (rt, _req, res) => {
        const dropped = rt.queue.clear();
        res.json({ dropped, ...queueView(rt) });
      }),
    );
    /**
     * Recipes: a queue worth keeping, replayed on any project.
     *
     * Saved by role rather than by agent id, because an id from one project
     * means nothing in another (core/recipes.ts).
     */
    app.get("/api/recipes", (_req, res) => {
      res.json({ recipes: listRecipes() });
    });
    app.post(
      "/api/projects/:id/queue/save",
      withRuntime(async (rt, req, res) => {
        const name = String((req.body ?? {}).name ?? "").trim();
        const items = rt.queue.snapshot().items;
        if (!items.length) return void res.status(400).json({ error: "there's nothing queued to save" });
        try {
          const roleOf = (agentId: string) => rt.config.agents.find((a) => a.id === agentId)?.role ?? rt.config.agents.find((a) => a.id === agentId)?.kind;
          const recipe = saveRecipe({
            name,
            fromProject: rt.info.name,
            steps: items.map((i) => ({ text: i.text, to: targetToRole(i.target, roleOf), ...(i.plan ? { plan: true } : {}) })),
          });
          res.json({ recipe });
        } catch (err) {
          res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
        }
      }),
    );
    app.post(
      "/api/projects/:id/queue/recipe",
      withRuntime(async (rt, req, res) => {
        const name = String((req.body ?? {}).name ?? "").trim();
        const recipe = getRecipe(name);
        if (!recipe) return void res.status(404).json({ error: `no recipe called "${name}"` });
        try {
          for (const step of recipe.steps) {
            rt.enqueue({
              text: step.text,
              target: roleToTarget(step.to, rt.config.agents),
              ...(step.plan ? { plan: true } : {}),
            });
          }
          res.json({ added: recipe.steps.length, ...queueView(rt) });
        } catch (err) {
          res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
        }
      }),
    );
    app.delete("/api/recipes/:name", (req, res) => {
      const gone = deleteRecipe(String(req.params.name));
      if (!gone) return void res.status(404).json({ error: "no such recipe" });
      res.json({ deleted: true });
    });

    /** Hold the queue where it is, or let it run again. */
    app.post(
      "/api/projects/:id/queue/pause",
      withRuntime(async (rt, req, res) => {
        const paused = (req.body ?? {}).paused !== false;
        rt.queue.setPaused(paused, paused ? "you paused the queue" : undefined);
        if (!paused) void rt.drainPromptQueue();
        res.json(queueView(rt));
      }),
    );

    /**
     * Drive a GUI agent: type into Antigravity's or Kiro's own chat and read
     * back what appeared.
     *
     * Separate from /messages because it is a different act. /messages hands a
     * turn to something that can hold the baton; this types into an app you're
     * signed into and waits for its panel to settle. The bridge never takes the
     * lock, so an adapter mid-turn is untouched.
     *
     * It waits up to 15 seconds for the app to answer. A GUI agent can disappear
     * without closing its socket, so the deadline keeps the caller from waiting
     * forever and gives it a useful recovery message instead.
     */
    app.post(
      "/api/projects/:id/bridge/:agentId/ask",
      withRuntime(async (rt, req, res) => {
        const { text, chat } = (req.body ?? {}) as { text?: string; chat?: string };
        const agentId = String(req.params.agentId);
        if (!text?.trim()) return void res.status(400).json({ error: "missing text" });
        try {
          const result = await rt.askBridge(agentId, text, chat ? { chat } : {});
          res.json(result);
        } catch (err) {
          // 409, not 500: "log into Antigravity" is a state you can fix, not a
          // bug in the daemon, and the message is the whole value of the reply.
          res.status(err instanceof LoomAskTimeoutError ? 504 : 409).json({
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }),
    );

    app.post(
      "/api/projects/:id/handoff",
      withRuntime(async (rt, req, res) => {
        const { to } = (req.body ?? {}) as { to?: string };
        if (!to) return void res.status(400).json({ error: "missing to" });
        const result = await rt.handoff(to);
        res.json({ ...result, to });
      }),
    );

    // Chats — several conversations inside one project. They share the brain,
    // the baton and the working tree; only the talking is separate.
    app.get(
      "/api/projects/:id/chats",
      withRuntime(async (rt, _req, res) => {
        res.json({ chats: rt.chats() });
      }),
    );

    app.post(
      "/api/projects/:id/chats",
      withRuntime(async (rt, req, res) => {
        const { title, agentId, model } = (req.body ?? {}) as {
          title?: string;
          agentId?: string;
          model?: string;
        };
        try {
          res.json({
            chat: rt.createChat(String(title ?? ""), {
              ...(agentId ? { agentId: String(agentId) } : {}),
              ...(model ? { model: String(model) } : {}),
            }),
          });
        } catch (err) {
          res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
        }
      }),
    );

    /**
     * One prompt, several models, a thread each. With free quota this costs
     * what asking one model costs.
     */
    app.post(
      "/api/projects/:id/ask",
      withRuntime(async (rt, req, res) => {
        const { text, models, title, briefing } = (req.body ?? {}) as {
          text?: string;
          models?: Array<string | { model: string; provider?: string }>;
          title?: string;
          briefing?: boolean;
        };
        if (!text?.trim()) return void res.status(400).json({ error: "missing text" });
        const picks = (models ?? []).map((m) =>
          typeof m === "string"
            ? // "provider/vendor/model" — the provider is the first segment
              // only when it names one we know; otherwise the whole string is
              // the model, because model ids contain slashes too.
              (() => {
                const [head, ...rest] = m.split("/");
                return head && rest.length && resolveProvider(head)
                  ? { model: rest.join("/"), provider: head }
                  : { model: m };
              })()
            : { model: String(m.model), ...(m.provider ? { provider: String(m.provider) } : {}) },
        );
        try {
          const asked = await rt.askModels(text, picks, {
            ...(title ? { title } : {}),
            ...(briefing === false ? { briefing: false } : {}),
          });
          res.json({ asked });
        } catch (err) {
          res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
        }
      }),
    );

    /**
     * Who answers in a thread. Null unbinds it, and the thread goes back to
     * following the baton like the main one.
     */
    app.post(
      "/api/projects/:id/chats/:chatId/agent",
      withRuntime(async (rt, req, res) => {
        const { agentId, model } = (req.body ?? {}) as { agentId?: string | null; model?: string };
        try {
          const chat = rt.setChatAgent(
            String(req.params.chatId),
            agentId ? String(agentId) : null,
            model ? String(model) : undefined,
          );
          if (!chat) return void res.status(404).json({ error: "no such thread" });
          res.json({ chat });
        } catch (err) {
          res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
        }
      }),
    );

    app.post(
      "/api/projects/:id/chats/:chatId/rename",
      withRuntime(async (rt, req, res) => {
        const { title } = (req.body ?? {}) as { title?: string };
        if (!title?.trim()) return void res.status(400).json({ error: "missing title" });
        const chat = rt.renameChat(String(req.params.chatId), title);
        if (!chat) return void res.status(400).json({ error: "cannot rename that chat" });
        res.json({ chat });
      }),
    );

    // Pin a thread to the top of the sidebar, or archive it out of the way.
    app.patch(
      "/api/projects/:id/chats/:chatId",
      withRuntime(async (rt, req, res) => {
        const body = (req.body ?? {}) as { pinned?: unknown; archived?: unknown };
        const flags: { pinned?: boolean; archived?: boolean } = {};
        if (body.pinned !== undefined) flags.pinned = body.pinned === true;
        if (body.archived !== undefined) flags.archived = body.archived === true;
        if (!Object.keys(flags).length) return void res.status(400).json({ error: "nothing to change: send pinned or archived" });
        if (String(req.params.chatId) === "main") {
          return void res.status(400).json({ error: "Main is always first and always there, so it can't be pinned or archived" });
        }
        const chat = rt.setChatFlags(String(req.params.chatId), flags);
        if (!chat) return void res.status(404).json({ error: "no such thread" });
        res.json({ chat });
      }),
    );

    // Star a message worth coming back to.
    app.post(
      "/api/projects/:id/chats/:chatId/star",
      withRuntime(async (rt, req, res) => {
        const { eventId, on } = (req.body ?? {}) as { eventId?: unknown; on?: unknown };
        const starred = rt.starMessage(String(req.params.chatId), Number(eventId), on !== false);
        if (!starred) return void res.status(400).json({ error: "no such thread or message" });
        res.json({ starred });
      }),
    );

    app.delete(
      "/api/projects/:id/chats/:chatId",
      withRuntime(async (rt, req, res) => {
        if (!rt.deleteChat(String(req.params.chatId))) {
          return void res.status(400).json({ error: "cannot delete that chat" });
        }
        res.json({ deleted: true });
      }),
    );

    // Rename an agent's role. It's free text — your project decides what jobs
    // exist, not us. Writes .loom/config.json, which is the source of truth.
    app.post(
      "/api/projects/:id/agents/:agentId/role",
      withRuntime(async (rt, req, res) => {
        const { role } = (req.body ?? {}) as { role?: string };
        if (typeof role !== "string") return void res.status(400).json({ error: "missing role" });
        const clean = role.trim().slice(0, 40);
        if (!clean) return void res.status(400).json({ error: "role cannot be empty" });
        const updated = rt.setAgentRole(String(req.params.agentId), clean);
        if (!updated) return void res.status(404).json({ error: "unknown agent" });
        res.json(updated);
      }),
    );

    // Standing instructions for one agent, sent ahead of every turn it takes.
    app.put(
      "/api/projects/:id/agents/:agentId/instructions",
      withRuntime(async (rt, req, res) => {
        const { instructions } = (req.body ?? {}) as { instructions?: unknown };
        if (typeof instructions !== "string") return void res.status(400).json({ error: "instructions must be text (empty clears them)" });
        const updated = rt.setAgentInstructions(String(req.params.agentId), instructions);
        if (!updated) return void res.status(404).json({ error: "unknown agent" });
        res.json(updated);
      }),
    );

    // Switch an agent off (or back on) without removing it from the roster.
    // 409 rather than 400 for the refusals — holding the baton and being
    // mid-turn are both states that pass on their own, so the message names
    // what to do rather than calling the request malformed.
    app.put(
      "/api/projects/:id/agents/:agentId/enabled",
      withRuntime(async (rt, req, res) => {
        const { enabled } = (req.body ?? {}) as { enabled?: boolean };
        try {
          res.json(rt.setAgentEnabled(String(req.params.agentId), enabled !== false));
        } catch (e) {
          res.status(409).json({ error: e instanceof Error ? e.message : String(e) });
        }
      }),
    );

    /**
     * Lift an alert pause by hand.
     *
     * The loop lifts itself when the alert resolves or the recheck sees the
     * agent healthy again, and that is the normal path. This is the override
     * for when you know better than the alert — a flapping rule, a threshold
     * set too tight — because otherwise the only way out is editing state on
     * disk, and an operator with no button will go and do exactly that.
     */
    app.delete(
      "/api/projects/:id/quarantine/:agentId",
      withRuntime(async (rt, req, res) => {
        const agentId = String(req.params.agentId);
        const lifted = rt.unquarantine(agentId);
        if (!lifted) return void res.status(404).json({ error: `"${agentId}" is not paused` });
        rt.log.append({
          kind: "status",
          agentId,
          payload: { state: "alert_recovery", alert: lifted.reason, retried: false, via: "manual" },
        });
        res.json({ lifted: true, agentId, was: lifted, quarantine: rt.quarantined() });
      }),
    );

    // Skills: the SKILL.md context blocks; per-project enable state; a keyword
    // suggestion for the current message (?suggest=<text>).
    app.get(
      "/api/projects/:id/skills",
      withRuntime(async (rt, req, res) => {
        const skills = rt.getSkills();
        const suggest = req.query.suggest ? suggestSkill(String(req.query.suggest), skills) : null;
        res.json({ skills, suggestion: suggest });
      }),
    );
    app.put(
      "/api/projects/:id/skills/:skillId",
      withRuntime(async (rt, req, res) => {
        const { enabled } = (req.body ?? {}) as { enabled?: boolean };
        res.json({ skills: rt.setSkillEnabled(String(req.params.skillId), enabled !== false) });
      }),
    );

    // The skill picker's list: every skill discoverable from this project, from
    // all four roots (project, ~/.claude, plugin caches, bundled), without the
    // bodies. `origin` and `source` say where each one lives, and `installed`
    // marks the ones in the project's own skills/ dir — the only ones DELETE
    // will touch.
    app.get(
      "/api/projects/:id/skills/catalog",
      withRuntime(async (rt, _req, res) => {
        res.json({ skills: rt.skillsCatalog() });
      }),
    );

    // Install a skill: from a git remote, or from a directory on this machine.
    // Everything the user can fix — a URL that isn't git, a repo with no
    // SKILL.md, a name already taken — comes back as a 400 with the reason,
    // because "invalid input" is useless when the real answer is "that repo has
    // no SKILL.md in it".
    app.post(
      "/api/projects/:id/skills/install",
      withRuntime(async (rt, req, res) => {
        const body = (req.body ?? {}) as { gitUrl?: string; dir?: string; force?: boolean };
        try {
          const skill = await rt.installSkill(body);
          res.json({ skill, skills: rt.skillsCatalog() });
        } catch (err) {
          if (err instanceof SkillInstallError) {
            return void res.status(400).json({ error: err.message });
          }
          throw err;
        }
      }),
    );

    // Remove a project-installed skill from disk. Refused (400) for a skill
    // that lives in ~/.claude or a plugin cache: those are shared with every
    // other tool on the machine and are not ours to delete.
    app.delete(
      "/api/projects/:id/skills/:skillId",
      withRuntime(async (rt, req, res) => {
        try {
          const removed = rt.removeSkill(String(req.params.skillId));
          res.json({ ...removed, skills: rt.skillsCatalog() });
        } catch (err) {
          if (err instanceof SkillInstallError) {
            return void res.status(400).json({ error: err.message });
          }
          throw err;
        }
      }),
    );

    // The MCP catalog: the official registry, searchable, plus a hand-verified
    // shortlist for the empty state. Not project-scoped — it is the same
    // catalog for everyone, and caching it per-project would multiply the
    // requests against somebody else's public service by the project count.
    //
    // `degraded: true` means the registry did not answer and `servers` is
    // therefore empty; `featured` needs no network and is always there.
    app.get("/api/mcp/catalog", (req, res) => {
      void (async () => {
        const q = String(req.query.q ?? "").trim();
        const limit = req.query.limit ? Number(req.query.limit) : undefined;
        res.json(await searchCatalog(q, limit));
      })();
    });

    // MCP servers: the connect/toggle list. PATCH upserts one by name.
    //
    // `connected` on each row is measured here, not inferred from the presence
    // of a url — every configured endpoint gets a bounded probe (2s, in
    // parallel) and reports what actually answered. `?probe=0` skips it for a
    // caller that only wants the configured list back fast.
    app.get(
      "/api/projects/:id/mcps",
      withRuntime(async (rt, req, res) => {
        const probe = String(req.query.probe ?? "1") !== "0";
        res.json({ mcps: probe ? await rt.getMcpsProbed() : rt.getMcps(), probed: probe });
      }),
    );
    app.patch(
      "/api/projects/:id/mcps",
      withRuntime(async (rt, req, res) => {
        const body = (req.body ?? {}) as { mcp?: { name?: string } };
        if (!body.mcp?.name) return void res.status(400).json({ error: "mcp.name required" });
        res.json({ mcps: rt.upsertMcp(body.mcp as Parameters<typeof rt.upsertMcp>[0]) });
      }),
    );

    // Install a server picked out of the catalog.
    //
    // Two things separate this from the PATCH above. It refuses a server with
    // neither a url nor a command — that is the exact shape of the old
    // placeholder rows, and the whole point of the catalog is that a row means
    // something now. And it probes what it just wrote, so the response carries a
    // measured `connected` rather than leaving the UI to render a green badge
    // off the presence of a string.
    app.post(
      "/api/projects/:id/mcps/install",
      withRuntime(async (rt, req, res) => {
        const body = (req.body ?? {}) as {
          name?: string;
          url?: string;
          command?: string;
          args?: unknown;
          transport?: string;
          headers?: Record<string, string>;
          env?: Record<string, string>;
          description?: string;
          slug?: string;
        };
        const name = String(body.name ?? "").trim();
        if (!name) return void res.status(400).json({ error: "name required" });
        const url = String(body.url ?? "").trim();
        const command = String(body.command ?? "").trim();
        if (!url && !command) {
          return void res.status(400).json({
            error: `"${name}" has neither a url nor a command — an MCP server needs somewhere to connect to or something to run`,
          });
        }
        if (url && !/^https?:\/\//i.test(url)) {
          return void res.status(400).json({ error: `"${url}" is not an http(s) URL` });
        }
        const transport = body.transport === "sse" || body.transport === "http" ? body.transport : undefined;
        const args = Array.isArray(body.args) ? body.args.map((a) => String(a)) : undefined;
        const mcps = rt.upsertMcp({
          name,
          url,
          ...(command ? { command } : {}),
          ...(args?.length ? { args } : {}),
          ...(url && transport ? { transport } : {}),
          ...(body.headers && Object.keys(body.headers).length ? { headers: body.headers } : {}),
          ...(body.env && Object.keys(body.env).length ? { env: body.env } : {}),
          ...(body.description ? { description: String(body.description) } : {}),
          ...(body.slug ? { slug: String(body.slug) } : {}),
          enabledForSession: true,
        });
        // Probe after persisting: the answer describes what is now configured,
        // and a server that fails its probe is still installed — unreachable is
        // a state to show, not a reason to refuse to save.
        const installed = mcps.find((m) => m.name === name);
        const connected = url ? await probeMcpServer(url).catch(() => false) : false;
        res.json({
          installed: installed ? { ...installed, connected, probedAt: Date.now() } : null,
          mcps: await rt.getMcpsProbed(),
        });
      }),
    );

    // The background poll's live view: up/down, consecutive failures, last
    // probe. POST forces a poll now instead of waiting for the next tick.
    app.get(
      "/api/projects/:id/mcps/health",
      withRuntime(async (rt, _req, res) => {
        res.json({ health: rt.mcpHealthReport() });
      }),
    );
    app.post(
      "/api/projects/:id/mcps/health",
      withRuntime(async (rt, _req, res) => {
        await rt.pollMcpHealth();
        res.json({ health: rt.mcpHealthReport() });
      }),
    );

    // Author a skill in place: scaffold skills/<id>/SKILL.md, validated by the
    // same parser the roster reads with — a skill this accepts is one the
    // loader will actually offer.
    app.post(
      "/api/projects/:id/skills/author",
      withRuntime(async (rt, req, res) => {
        const b = (req.body ?? {}) as {
          id?: string;
          name?: string;
          description?: string;
          body?: string;
          enable?: boolean;
        };
        try {
          const out = authorSkill(rt.info.dir, {
            id: String(b.id ?? ""),
            name: String(b.name ?? ""),
            description: String(b.description ?? ""),
            ...(b.body ? { body: String(b.body) } : {}),
          });
          if (b.enable !== false) rt.setSkillEnabled(path.basename(out.dir), true);
          res.json(out);
        } catch (err) {
          res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
        }
      }),
    );

    // Uninstall a server. 404 when nothing was configured under that name —
    // "deleted a thing that wasn't there" hides a typo in a server name.
    app.delete(
      "/api/projects/:id/mcps/:name",
      withRuntime(async (rt, req, res) => {
        const { removed, mcps } = rt.removeMcp(String(req.params.name));
        if (!removed) return void res.status(404).json({ error: `no configured MCP server "${req.params.name}"` });
        res.json({ removed: true, mcps });
      }),
    );

    // The Settings screen reads its editable knobs here — brain extractor,
    // projection mode, default agent — with the roster the picker chooses from.
    app.get(
      "/api/projects/:id/config",
      withRuntime(async (rt, _req, res) => {
        res.json(rt.settings());
      }),
    );

    // The Settings screen's editable knobs: the brain extractor, the projection
    // mode, the default agent. Everything is read live from config, so a merge
    // here lands on the next turn/handoff with no restart. Partial — send only
    // what changed. Returns the full config so the screen can re-render.
    app.patch(
      "/api/projects/:id/config",
      withRuntime(async (rt, req, res) => {
        const body = (req.body ?? {}) as Parameters<typeof rt.patchConfig>[0];
        try {
          const cfg = rt.patchConfig({
            brain: body.brain,
            projection: body.projection,
            defaultAgent: body.defaultAgent,
            git: body.git,
            safety: body.safety,
          });
          res.json({
            brain: cfg.brain ?? {},
            projection: cfg.projection ?? {},
            defaultAgent: cfg.defaultAgent ?? "",
            git: cfg.git ?? {},
            safety: cfg.safety ?? {},
          });
        } catch (err) {
          res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
        }
      }),
    );

    // ---- search -----------------------------------------------------------
    // Finding a file by name was the whole of search, which is its least useful
    // half: you remember a line, not a filename. And the thread — where a
    // project's actual reasoning lives — wasn't searchable at all.
    app.get(
      "/api/projects/:id/grep",
      withRuntime(async (rt, req, res) => {
        res.json(await searchCode(rt.info.dir, String(req.query.q ?? "")));
      }),
    );

    app.get(
      "/api/projects/:id/chats/search",
      withRuntime(async (rt, req, res) => {
        res.json(
          searchChats(rt.log, String(req.query.q ?? ""), {
            ...(req.query.chat ? { chat: String(req.query.chat) } : {}),
          }),
        );
      }),
    );

    // ---- source control ---------------------------------------------------
    // Reading the working tree has been possible since the Explorer landed;
    // doing anything about it has not. These are the writes, and they're the
    // only endpoints in Loom that can destroy work — hence the path checks in
    // core/git.ts and the noise in the log when you discard.
    app.get(
      "/api/projects/:id/git/status",
      withRuntime(async (rt, _req, res) => {
        res.json(await gitStatus(rt.info.dir));
      }),
    );

    const gitWrite = (
      fn: (dir: string, body: Record<string, unknown>) => Promise<unknown>,
    ) =>
      withRuntime(async (rt, req, res) => {
        try {
          res.json(await fn(rt.info.dir, (req.body ?? {}) as Record<string, unknown>));
        } catch (err) {
          // git's own words, not ours: "nothing to commit, working tree clean"
          // beats anything we'd invent about an exit code.
          const message = err instanceof Error ? err.message : String(err);
          logbook.warn("git", message, err instanceof GitError ? err.stderr : err, rt.info.id);
          res.status(400).json({ error: message });
        }
      });

    app.post(
      "/api/projects/:id/git/stage",
      gitWrite((dir, b) => gitStage(dir, asPaths(b.paths))),
    );
    app.post(
      "/api/projects/:id/git/unstage",
      gitWrite((dir, b) => gitUnstage(dir, asPaths(b.paths))),
    );
    app.post(
      "/api/projects/:id/git/discard",
      gitWrite((dir, b) => gitDiscard(dir, asPaths(b.paths), asPaths(b.untracked))),
    );
    app.post(
      "/api/projects/:id/git/commit",
      gitWrite((dir, b) => gitCommit(dir, String(b.message ?? ""))),
    );
    // init / push / checkout — all write, all through the same error surface.
    app.post(
      "/api/projects/:id/git/init",
      gitWrite((dir) => gitInit(dir)),
    );
    app.post(
      "/api/projects/:id/git/push",
      gitWrite((dir) => gitPush(dir)),
    );
    app.post(
      "/api/projects/:id/git/checkout",
      gitWrite((dir, b) => gitCheckout(dir, String(b.ref ?? ""))),
    );
    // read-only: the commit log, one file's diff, and the branch list
    app.get(
      "/api/projects/:id/git/log",
      withRuntime(async (rt, req, res) => {
        const limit = Number((req.query as Record<string, string>).limit) || 30;
        res.json({ commits: await gitLog(rt.info.dir, limit) });
      }),
    );
    app.get(
      "/api/projects/:id/git/diff",
      withRuntime(async (rt, req, res) => {
        const p = String((req.query as Record<string, string>).path ?? "");
        if (!p) return void res.status(400).json({ error: "missing path" });
        try {
          res.json({ path: p, patch: await gitFileDiff(rt.info.dir, p) });
        } catch (err) {
          res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
        }
      }),
    );
    app.get(
      "/api/projects/:id/git/branches",
      withRuntime(async (rt, _req, res) => {
        res.json(await gitBranches(rt.info.dir));
      }),
    );
    // Draft a commit message from the staged diff, via the logged-in Claude CLI
    // — the "Generate" affordance. No key; a no-op-ish 400 when Claude isn't
    // there, so the field just stays empty and the user types their own.
    app.post(
      "/api/projects/:id/git/suggest-message",
      withRuntime(async (rt, _req, res) => {
        const diff = await gitStagedDiff(rt.info.dir).catch(() => "");
        if (!diff.trim()) return void res.status(400).json({ error: "nothing to describe — stage or edit some files first" });
        try {
          const prompt =
            "Write a single-line Conventional Commit subject (type(scope): summary, imperative mood, <72 chars) " +
            "for this diff. Reply with ONLY the subject line, no quotes, no body.\n\n" +
            diff;
          const out = (await claudeText(prompt, { model: "haiku", timeoutMs: 30_000 })).trim();
          const message = out.split("\n")[0]?.replace(/^["'`]|["'`]$/g, "").trim().slice(0, 120) ?? "";
          if (!message) return void res.status(502).json({ error: "Claude returned nothing — type a message instead" });
          res.json({ message });
        } catch {
          // claudeText's raw "claude exited N" helps no one at the commit box.
          res.status(502).json({ error: "couldn't reach Claude to draft a message — type one instead" });
        }
      }),
    );

    // ---- the Console ------------------------------------------------------
    // Everything that went wrong, for the tab next to the terminal. Until this
    // existed an error's only home was ~/.loom/daemon.log, which you have to
    // know about, find, and tail — so in practice errors reached nobody.
    app.get("/api/logs", (req, res) => {
      const since = req.query.since === undefined ? undefined : Number(req.query.since);
      const level = req.query.level as "error" | "warn" | "info" | undefined;
      res.json({
        logs: logbook.list({
          ...(Number.isFinite(since) ? { since } : {}),
          ...(level ? { level } : {}),
          ...(req.query.project ? { project: String(req.query.project) } : {}),
        }),
      });
    });

    app.delete("/api/logs", (_req, res) => {
      logbook.clear();
      res.json({ ok: true });
    });

    /**
     * The window reporting its own errors — a failed fetch, a thrown render, an
     * unhandled rejection. Client-side failures used to die in the browser
     * console where no one was looking; now they land in the same Console tab as
     * the daemon's, streamed to every window and kept in the ring buffer.
     */
    app.post("/api/logs", (req, res) => {
      const b = (req.body ?? {}) as {
        level?: string;
        scope?: string;
        message?: string;
        detail?: unknown;
        project?: string;
      };
      const level: LogLevel = b.level === "error" || b.level === "warn" ? b.level : "info";
      const message = String(b.message ?? "").slice(0, 500);
      if (!message) return void res.status(400).json({ error: "missing message" });
      const scope = (b.scope ? String(b.scope) : "app").slice(0, 40);
      const rec = logbook.add(level, scope, message, b.detail, b.project ? String(b.project) : undefined);
      res.json({ ok: true, id: rec.id });
    });

    // Which agents Loom can drive on this machine, and which are already in
    // this project. The UI needs both to offer you the difference.
    app.get(
      "/api/projects/:id/agents/available",
      withRuntime(async (rt, _req, res) => {
        const availability = await detectAdes();
        const counts = rt.instanceCounts();
        res.json({
          ades: ADES.map((a) => ({
            kind: a.kind,
            label: a.label,
            tier: a.tier,
            // Bridges are never "installed" — they're an app you launch with a
            // debug port, so presence is a live question, not a lookup.
            installed: a.tier === "adapter" ? Boolean(availability[a.kind]) : null,
            inProject: (counts[a.kind] ?? 0) > 0,
            // How many sessions of this kind are already here. `inProject` used
            // to be the whole answer and the rail hid anything already present,
            // which made a second Claude Code session unreachable from the UI
            // even though the roster could hold one. Adapters can be added
            // again; bridges are read-mostly and one is enough.
            instances: counts[a.kind] ?? 0,
            canAddAnother: a.tier === "adapter",
          })),
        });
      }),
    );

    // ---- the Browser tab: Playwright specs -------------------------------
    // Agents write browser tests constantly and Loom had nowhere to watch them
    // run. List the project's specs, run one, stream the reporter over the
    // same socket the thread uses, and let a failure be handed back to an
    // agent. Playwright stays the project's dependency, not Loom's.
    app.get(
      "/api/projects/:id/specs",
      withRuntime(async (rt, _req, res) => {
        res.json({
          specs: findSpecs(rt.info.dir),
          running: this.specRunner.running(rt.info.id),
        });
      }),
    );

    app.post(
      "/api/projects/:id/specs/run",
      withRuntime(async (rt, req, res) => {
        const file = String((req.body as { file?: string } | undefined)?.file ?? "").trim();
        if (!file) return void res.status(400).json({ error: "missing file" });
        try {
          const run = this.specRunner.start(rt.info.id, rt.info.dir, file, {
            onLine: (r: SpecRun, line: string) =>
              this.broadcastTerm(rt.info.id, { type: "spec", runId: r.id, file: r.file, line }),
            onDone: (r: SpecRun) => {
              this.broadcastTerm(rt.info.id, {
                type: "spec_done",
                runId: r.id,
                file: r.file,
                exitCode: r.exitCode,
              });
              // The Console keeps the record; the stream is for watching live.
              if (r.exitCode === 0) {
                logbook.info("specs", `${r.file} passed`, undefined, rt.info.id);
              } else {
                logbook.error(
                  "specs",
                  `${r.file} failed (exit ${r.exitCode})`,
                  r.lines.slice(-40).join("\n"),
                  rt.info.id,
                );
              }
            },
          });
          res.json({ run: { id: run.id, file: run.file, startedAt: run.startedAt } });
        } catch (err) {
          res.status(409).json({ error: err instanceof Error ? err.message : String(err) });
        }
      }),
    );

    app.post(
      "/api/projects/:id/specs/stop",
      withRuntime(async (rt, _req, res) => {
        res.json({ stopped: this.specRunner.stop(rt.info.id) });
      }),
    );

    // Rename a project. The registry key stays the id; only the label moves —
    // renames must never orphan scoped tokens, board branches or memory.
    app.patch(
      "/api/projects/:id",
      withRuntime(async (rt, req, res) => {
        const name = String((req.body as { name?: string } | undefined)?.name ?? "").trim().slice(0, 60);
        if (!name) return void res.status(400).json({ error: "missing name" });
        if (!renameProject(rt.info.id, name)) {
          return void res.status(404).json({ error: "no such project" });
        }
        rt.info.name = name;
        res.json({ project: { id: rt.info.id, name } });
      }),
    );

    // Search the thread. The event log answers "what did we say about X"
    // without scrolling — bounded scan of message/decision text, newest first.
    app.get(
      "/api/projects/:id/events/search",
      withRuntime(async (rt, req, res) => {
        const q = String(req.query.q ?? "").trim().toLowerCase();
        if (!q) return void res.status(400).json({ error: "missing q" });
        const limit = Math.min(50, Number(req.query.limit) || 20);
        const hits = rt.log
          .list({ kinds: ["message", "decision", "needs_input"] })
          .filter((e) => String(e.payload.text ?? e.payload.question ?? "").toLowerCase().includes(q))
          .slice(-limit)
          .reverse();
        res.json({ hits });
      }),
    );

    // Fan a subtask out to a child agent. The parent keeps the baton, so this is
    // not "send to someone else" — it's one turn borrowing another pair of hands.
    app.post(
      "/api/projects/:id/subtasks",
      withRuntime(async (rt, req, res) => {
        const b = (req.body ?? {}) as {
          parent?: string;
          agentId?: string;
          task?: string;
          chat?: string;
        };
        if (!b.parent?.trim()) return void res.status(400).json({ error: "missing parent" });
        if (!b.agentId?.trim()) return void res.status(400).json({ error: "missing agentId" });
        if (!b.task?.trim()) return void res.status(400).json({ error: "missing task" });
        try {
          const out = await rt.spawnSubAgent(b.parent.trim(), {
            agentId: b.agentId.trim(),
            task: b.task,
            ...(b.chat ? { chat: b.chat } : {}),
          });
          res.json(out);
        } catch (err) {
          res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
        }
      }),
    );

    // ---- voice: hold-to-talk from any client ------------------------------
    // Audio in, text out. Transcription is a CONFIGURED command (LOOM_STT_CMD,
    // e.g. whisper.cpp: `whisper-cli -m model.bin -f {file} -otxt`), because
    // Loom's contract is no accounts and no keys — shipping a cloud STT call
    // would break the reason the rest works offline. No command configured is
    // an honest 501 with the setup line, not a fake transcript.
    app.post(
      "/api/projects/:id/voice",
      express.raw({ type: ["audio/*", "application/octet-stream"], limit: "25mb" }),
      withRuntime(async (rt, req, res) => {
        const cmd = process.env.LOOM_STT_CMD;
        if (!cmd) {
          return void res.status(501).json({
            error:
              "no transcriber configured — set LOOM_STT_CMD to a command that takes {file} and prints text (e.g. whisper.cpp)",
          });
        }
        const body = req.body as Buffer;
        if (!body?.length) return void res.status(400).json({ error: "no audio" });
        // Date.now() alone collides when two clients release the mic in the
        // same millisecond — one request then transcribes the other's audio.
        const tmp = path.join(
          os.tmpdir(),
          `loom-voice-${Date.now()}-${crypto.randomBytes(4).toString("hex")}.audio`,
        );
        try {
          fs.writeFileSync(tmp, body);
          const text = await new Promise<string>((resolve, reject) => {
            execFile(
              "/bin/sh",
              ["-c", cmd.replaceAll("{file}", tmp)],
              { timeout: 60_000, maxBuffer: 1024 * 1024 },
              (err, stdout) => (err ? reject(err) : resolve(stdout.trim())),
            );
          });
          if (!text) return void res.status(422).json({ error: "the transcriber returned nothing" });
          logbook.info("voice", `transcribed ${body.length} bytes → ${text.length} chars`, undefined, rt.info.id);
          res.json({ text });
        } catch (err) {
          res.status(500).json({ error: `transcription failed: ${err instanceof Error ? err.message : err}` });
        } finally {
          try {
            fs.rmSync(tmp, { force: true });
          } catch {
            /* gone */
          }
        }
      }),
    );

    // Named routes: define and remove without hand-editing config.json.
    // Validated against the current roster before saving.
    app.put(
      "/api/projects/:id/routes/:name",
      withRuntime(async (rt, req, res) => {
        const steps = (req.body as { steps?: unknown } | undefined)?.steps;
        if (!Array.isArray(steps) || !steps.length) {
          return void res.status(400).json({ error: "missing steps" });
        }
        try {
          res.json({ routes: rt.saveRoute(String(req.params.name), steps as never) });
        } catch (err) {
          res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
        }
      }),
    );

    app.delete(
      "/api/projects/:id/routes/:name",
      withRuntime(async (rt, req, res) => {
        try {
          res.json({ routes: rt.deleteRoute(String(req.params.name)) });
        } catch (err) {
          res.status(404).json({ error: err instanceof Error ? err.message : String(err) });
        }
      }),
    );

    // Checkpoint and restore: brain + board + config, NOT the working tree
    // (git owns files) and NOT the event log (history is what happened).
    app.get(
      "/api/projects/:id/snapshot",
      withRuntime(async (rt, _req, res) => {
        res.json(rt.snapshot());
      }),
    );

    app.post(
      "/api/projects/:id/restore",
      withRuntime(async (rt, req, res) => {
        try {
          res.json(rt.restore(req.body as Parameters<typeof rt.restore>[0]));
        } catch (err) {
          res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
        }
      }),
    );

    /**
     * Rewind (#101): points the *working tree* can be put back to.
     *
     * The pair above is deliberately not this. That one restores brain, board
     * and config and leaves files to git; this one is the files, and leaves
     * brain, board and history alone. Both exist because they answer different
     * questions, and a single "restore" that did both would be a button nobody
     * could predict.
     */
    app.get(
      "/api/projects/:id/checkpoints",
      withRuntime(async (rt, _req, res) => {
        res.json({ checkpoints: await rt.checkpoints() });
      }),
    );

    app.post(
      "/api/projects/:id/checkpoints/:cpId/rewind",
      withRuntime(async (rt, req, res) => {
        try {
          res.json(await rt.rewind(String(req.params.cpId)));
        } catch (err) {
          res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
        }
      }),
    );

    // Hung sessions: busy far longer than any plausible turn. GET lists them;
    // POST reaps one — interrupt, stop, respawn from config, baton released if
    // the corpse held it.
    app.get(
      "/api/projects/:id/stale",
      withRuntime(async (rt, _req, res) => {
        res.json({ stale: rt.staleSessions() });
      }),
    );

    app.post(
      "/api/projects/:id/agents/:agentId/reap",
      withRuntime(async (rt, req, res) => {
        try {
          res.json(await rt.reapSession(String(req.params.agentId ?? "")));
        } catch (err) {
          res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
        }
      }),
    );

    // Re-run the last failed turn on a different agent, with the failure
    // attached as context so the second agent knows what was tried.
    app.post(
      "/api/projects/:id/retry",
      withRuntime(async (rt, req, res) => {
        const to = String((req.body as { agentId?: string } | undefined)?.agentId ?? "").trim();
        if (!to) return void res.status(400).json({ error: "missing agentId" });
        try {
          res.json(await rt.retryTurn(to));
        } catch (err) {
          res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
        }
      }),
    );

    app.get(
      "/api/projects/:id/subtasks",
      withRuntime(async (rt, _req, res) => {
        res.json({ subtasks: rt.liveSubtasks() });
      }),
    );

    // ---- fleet: what every agent in every open project is doing ----------
    app.get("/api/activity", (req, res) => {
      const scope = this.auth.allowedProjects(bearerToken(req.headers.authorization) ?? "");
      const projects = [...this.runtimes.values()]
        .filter((rt) => !scope || scope.includes(rt.info.id))
        .map((rt) => rt.activity());
      const pending = [...this.approvals.values()].filter((a) => !scope || scope.includes(a.projectId)).length;
      res.json({ projects, approvals: pending, at: Date.now() });
    });

    // ---- prompt manager (core/prompts.ts) --------------------------------
    app.get("/api/prompts", (req, res) => {
      res.json(listPrompts(String(req.query.q ?? "")));
    });
    app.post("/api/prompts", (req, res) => {
      try {
        res.json({ prompt: savePrompt((req.body ?? {}) as { title?: string; text: string; pinned?: boolean }) });
      } catch (err) {
        res.status(400).json({ error: (err as Error).message });
      }
    });
    app.delete("/api/prompts/recent", (_req, res) => {
      clearRecent();
      res.json({ ok: true });
    });
    app.patch("/api/prompts/:promptId", (req, res) => {
      try {
        res.json({ prompt: updatePrompt(String(req.params.promptId), (req.body ?? {}) as never) });
      } catch (err) {
        res.status(404).json({ error: (err as Error).message });
      }
    });
    app.delete("/api/prompts/:promptId", (req, res) => {
      if (!deletePrompt(String(req.params.promptId))) return void res.status(404).json({ error: "no such prompt" });
      res.json({ ok: true });
    });

    // ---- team policy in effect for a project (D37) ----
    app.get(
      "/api/projects/:id/team/policy",
      withRuntime(async (rt, _req, res) => {
        res.json({ policy: await loadPolicy(rt.info.dir) });
      }),
    );

    // ---- team sharing, per project (D8: opt-in) ----
    // What this project has chosen (config `team`) and which GitHub repo its
    // origin is — the two facts the UI needs to show Shared / Private / Auto.
    app.get(
      "/api/projects/:id/team/share",
      withRuntime(async (rt, _req, res) => {
        // cfg is omitted when nothing was chosen — "auto", not "private".
        res.json({ ...(rt.config.team ? { cfg: rt.config.team } : {}), repo: (await repoOf(rt.info.dir)) ?? "" });
      }),
    );
    app.post(
      "/api/projects/:id/team/share",
      withRuntime(async (rt, req, res) => {
        try {
          const b = (req.body ?? {}) as { teamId?: string };
          res.json(await this.team.share(rt, b.teamId || undefined));
        } catch (err) {
          res.status(400).json({ error: (err as Error).message });
        }
      }),
    );
    app.delete(
      "/api/projects/:id/team/share",
      withRuntime(async (rt, _req, res) => {
        this.team.unshare(rt);
        res.json({ ok: true });
      }),
    );

    // ---- the team brain, per project (Phase 3, daemon/team-brain.ts) ----
    // The Team view (D49): canon, the team's memories with their tiers, and the
    // inbox of what needs a human.
    app.get(
      "/api/projects/:id/team/brain",
      withRuntime(async (rt, req, res) => {
        const tb = this.team.brainFor(rt);
        if (req.query.sync === "1") await tb.sync().catch(() => {});
        res.json({
          status: tb.status(),
          memories: tb.memories({ history: req.query.history === "1" }),
          inbox: tb.inbox(),
        });
      }),
    );
    app.post(
      "/api/projects/:id/team/brain/:action",
      withRuntime(async (rt, req, res) => {
        const tb = this.team.brainFor(rt);
        const b = (req.body ?? {}) as Record<string, unknown>;
        const str = (k: string) => {
          const v = String(b[k] ?? "").trim();
          if (!v) throw new Error(`missing ${k}`);
          return v;
        };
        try {
          let out: unknown = { ok: true };
          const action = String(req.params.action);
          if (action === "sync") await tb.sync();
          else if (action === "promote") {
            const ids = Array.isArray(b.ids) ? b.ids.map(String) : [str("id")];
            out = await tb.promote(ids);
          } else if (action === "correct") out = await tb.correct(str("id"), str("text"));
          else if (action === "resolve") await tb.resolve(str("winner"), str("loser"), String(b.reason ?? ""));
          else if (action === "merge") await tb.resolve(str("keep"), str("drop"), "duplicate");
          else if (action === "trust" || action === "private") {
            const id = str("id");
            const value = b.value === undefined ? true : Boolean(b.value);
            rt.brain.update(id, action === "trust" ? { untrusted: !value } : { private: value }, "user");
            await tb.sync();
          } else return void res.status(404).json({ error: `unknown team brain action "${action}"` });
          res.json({ result: out, status: tb.status(), memories: tb.memories(), inbox: tb.inbox() });
        } catch (err) {
          res.status(400).json({ error: (err as Error).message });
        }
      }),
    );

    // ---- landing, per project (Phase 4, daemon/landing.ts) ----
    // Goal PRs on their way to main — checks, fixes, review, Land — plus
    // teammates' goals waiting for someone to adopt them (D52–D63).
    app.get(
      "/api/projects/:id/team/landing",
      withRuntime(async (rt, req, res) => {
        const l = this.team.landingFor(rt);
        if (req.query.poll === "1") await l.tick().catch(() => {});
        res.json({ goals: l.status(), adoptable: await l.adoptable().catch(() => []) });
      }),
    );
    app.post(
      "/api/projects/:id/team/landing/:action",
      withRuntime(async (rt, req, res) => {
        const l = this.team.landingFor(rt);
        const b = (req.body ?? {}) as Record<string, unknown>;
        const runId = String(b.runId ?? "");
        try {
          let out: unknown = { ok: true };
          const action = String(req.params.action);
          if (action === "land") {
            // a goal that moved to a runner is landed there (Phase 5)
            out = rt.orchestra.get(runId)?.status === "moved" ? await this.team.landOnRunner(rt, runId) : await l.land(runId);
          }
          else if (action === "poll") await l.tick();
          else if (action === "review") {
            const run = rt.orchestra.get(runId);
            if (!run?.landing?.headSha) throw new Error("that goal has no PR commit to review yet");
            await l.review(run, run.landing.headSha);
            out = run.landing;
          } else if (action === "override") out = await l.overrideReview(runId, String(b.reason ?? ""));
          else if (action === "adopt") out = await l.adopt(Number(b.pr), {
            ...(b.orchestrator ? { orchestrator: String(b.orchestrator) } : {}),
            ...(Array.isArray(b.workers) ? { workers: b.workers.map(String) } : {}),
          });
          else return void res.status(404).json({ error: `unknown landing action "${action}"` });
          res.json({ result: out, goals: l.status() });
        } catch (err) {
          res.status(400).json({ error: (err as Error).message });
        }
      }),
    );
    // ---- deploys and release notes (Phase 5, daemon/deploys.ts) — read-only ----
    app.get(
      "/api/projects/:id/team/deploys",
      withRuntime(async (rt, _req, res) => {
        try {
          res.json({ deployments: await this.team.deploysFor(rt).list() });
        } catch (err) {
          res.status(400).json({ error: (err as Error).message });
        }
      }),
    );
    app.get(
      "/api/projects/:id/team/release-notes",
      withRuntime(async (rt, req, res) => {
        try {
          const since = String(req.query.since ?? "").trim();
          if (!since) throw new Error("since which tag or commit? ?since=v1.2.0");
          res.json({ markdown: await this.team.deploysFor(rt).releaseNotes(since) });
        } catch (err) {
          res.status(400).json({ error: (err as Error).message });
        }
      }),
    );

    // ---- runners (Phase 5, daemon/runner.ts) ----
    // A project's view: runners that can take its goals, and the jobs in flight.
    app.get(
      "/api/projects/:id/team/runners",
      withRuntime(async (rt, _req, res) => {
        try {
          res.json(await this.team.runnersView(rt));
        } catch (err) {
          res.status(400).json({ error: (err as Error).message });
        }
      }),
    );
    app.post(
      "/api/projects/:id/team/runners/:action",
      withRuntime(async (rt, req, res) => {
        const b = (req.body ?? {}) as Record<string, unknown>;
        const str = (k: string) => (b[k] === undefined || b[k] === null || b[k] === "" ? undefined : String(b[k]));
        try {
          const action = String(req.params.action);
          let out: unknown;
          if (action === "start") {
            out = await this.team.startOnRunner(rt, {
              goal: String(b.goal ?? ""),
              ...(str("orchestrator") ? { orchestrator: str("orchestrator")! } : {}),
              ...(Array.isArray(b.workers) ? { workers: b.workers.map(String) } : {}),
              ...(b.plan ? { plan: true } : {}),
              ...(str("runner") ? { runner: str("runner")! } : {}),
            });
          } else if (action === "continue") out = await this.team.continueOnRunner(rt, String(b.runId ?? ""), { ...(str("runner") ? { runner: str("runner")! } : {}) });
          else if (action === "bring-back") out = await this.team.bringBack(rt, String(b.runId ?? ""));
          else if (action === "land") out = await this.team.landOnRunner(rt, String(b.runId ?? ""));
          else return void res.status(404).json({ error: `unknown runner action "${action}"` });
          res.json({ result: out, ...(await this.team.runnersView(rt)) });
        } catch (err) {
          res.status(400).json({ error: (err as Error).message });
        }
      }),
    );

    // Repo setup for landing safely (D62): report, and a fix PR on request.
    app.get(
      "/api/projects/:id/team/doctor",
      withRuntime(async (rt, _req, res) => {
        try {
          res.json(await this.team.landingFor(rt).doctor());
        } catch (err) {
          res.status(400).json({ error: (err as Error).message });
        }
      }),
    );
    app.post(
      "/api/projects/:id/team/doctor/fix",
      withRuntime(async (rt, _req, res) => {
        try {
          res.json(await this.team.landingFor(rt).doctorFix());
        } catch (err) {
          res.status(400).json({ error: (err as Error).message });
        }
      }),
    );

    // ---- permissions & approvals (core/permissions.ts, core/approvals.ts) ---
    app.get("/api/permissions", (_req, res) => {
      res.json({ profiles: PERMISSION_PROFILES });
    });
    app.post(
      "/api/projects/:id/agents/:agentId/permissions",
      withRuntime(async (rt, req, res) => {
        const { permissions } = (req.body ?? {}) as { permissions?: string };
        try {
          const cfg = rt.setAgentPermissions(String(req.params.agentId), permissions as never);
          res.json({ agent: cfg });
        } catch (err) {
          res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
        }
      }),
    );
    app.get(
      "/api/projects/:id/approvals",
      withRuntime(async (rt, _req, res) => {
        const pending = [...this.approvals.values()]
          .filter((a) => a.projectId === rt.info.id)
          .map(({ settle: _s, ...a }) => a);
        res.json({ approvals: pending });
      }),
    );
    app.post(
      "/api/projects/:id/approvals/:approvalId",
      withRuntime(async (rt, req, res) => {
        const a = this.approvals.get(String(req.params.approvalId));
        if (!a || a.projectId !== rt.info.id) return void res.status(404).json({ error: "no such approval (already answered?)" });
        const b = (req.body ?? {}) as { decision?: string; message?: string };
        if (b.decision !== "allow" && b.decision !== "deny") {
          return void res.status(400).json({ error: 'decision must be "allow" or "deny"' });
        }
        a.settle(
          b.decision === "allow"
            ? { behavior: "allow" }
            : { behavior: "deny", message: String(b.message ?? "Denied in Loom.").slice(0, 500) },
        );
        res.json({ ok: true });
      }),
    );

    // ---- orchestra: one orchestrator, many parallel workers ---------------
    // See core/orchestra.ts. Every step is also an `orchestra` event on the
    // WebSocket, so clients render live from events and use these for actions.
    const orchestraError = (res: express.Response, err: unknown) =>
      void res.status(400).json({ error: err instanceof Error ? err.message : String(err) });

    app.get(
      "/api/projects/:id/orchestra",
      withRuntime(async (rt, _req, res) => {
        res.json({ runs: rt.orchestra.list(), active: rt.orchestra.active()?.id ?? null });
      }),
    );
    app.post(
      "/api/projects/:id/orchestra",
      withRuntime(async (rt, req, res) => {
        const b = (req.body ?? {}) as {
          goal?: string;
          orchestrator?: string;
          workers?: unknown;
          maxParallel?: number;
          maxRounds?: number;
          plan?: boolean;
          maxUsd?: number;
          /** The thread the goal was typed in; the orchestrator answers there. */
          chat?: string;
        };
        if (!b.goal?.trim()) return void res.status(400).json({ error: "missing goal" });
        const workers = Array.isArray(b.workers) ? b.workers.map(String).filter(Boolean) : undefined;
        try {
          const run = await rt.orchestra.start({
            goal: b.goal,
            ...(b.chat ? { chat: String(b.chat) } : {}),
            ...(b.orchestrator ? { orchestrator: String(b.orchestrator) } : {}),
            ...(workers?.length ? { workers } : {}),
            ...(b.maxParallel ? { maxParallel: Number(b.maxParallel) } : {}),
            ...(b.maxRounds ? { maxRounds: Number(b.maxRounds) } : {}),
            ...(b.plan ? { plan: true } : {}),
            ...(Number(b.maxUsd) > 0 ? { maxUsd: Number(b.maxUsd) } : {}),
          });
          recordRecent(b.goal, { project: rt.info.name, mode: "orchestrate" });
          res.json({ run });
        } catch (err) {
          orchestraError(res, err);
        }
      }),
    );
    app.get(
      "/api/projects/:id/orchestra/:runId",
      withRuntime(async (rt, req, res) => {
        const run = rt.orchestra.get(String(req.params.runId));
        if (!run) return void res.status(404).json({ error: "no such run" });
        res.json({ run });
      }),
    );
    // D32: the owner releases a task that waits on a teammate's goal.
    app.post(
      "/api/projects/:id/orchestra/:runId/tasks/:taskId/stop-waiting",
      withRuntime(async (rt, req, res) => {
        try {
          res.json({ task: rt.orchestra.stopWaiting(String(req.params.runId), String(req.params.taskId)) });
        } catch (err) {
          res.status(400).json({ error: (err as Error).message });
        }
      }),
    );

    // Re-run the delivery policy by hand (e.g. after fixing a push rejection).
    app.post(
      "/api/projects/:id/orchestra/:runId/deliver",
      withRuntime(async (rt, req, res) => {
        const run = rt.orchestra.get(String(req.params.runId));
        if (!run) return void res.status(404).json({ error: "no such run" });
        const mode = String((req.body as { mode?: string } | undefined)?.mode ?? "");
        const modes = ["commit", "push", "pr"];
        if (mode && !modes.includes(mode)) return void res.status(400).json({ error: `mode must be ${modes.join(", ")}` });
        await rt.orchestra.deliver(run, (mode || undefined) as never);
        res.json({ run });
      }),
    );
    for (const action of ["abort", "reply", "apply", "cleanup", "resume"] as const) {
      app.post(
        `/api/projects/:id/orchestra/:runId/${action}`,
        withRuntime(async (rt, req, res) => {
          const runId = String(req.params.runId);
          try {
            if (action === "abort") res.json({ run: await rt.orchestra.abort(runId) });
            else if (action === "resume") res.json({ run: await rt.orchestra.resume(runId) });
            else if (action === "reply") {
              const text = String((req.body as { text?: string } | undefined)?.text ?? "");
              res.json({ run: await rt.orchestra.reply(runId, text) });
            } else if (action === "apply") res.json(await rt.orchestra.apply(runId));
            else {
              await rt.orchestra.cleanup(runId);
              res.json({ ok: true });
            }
          } catch (err) {
            orchestraError(res, err);
          }
        }),
      );
    }

    // Add an agent to a project. A roster used to be frozen at creation: install
    // a new ADE and your existing projects never heard of it.
    app.post(
      "/api/projects/:id/agents",
      withRuntime(async (rt, req, res) => {
        const { kind, id, role, options } = (req.body ?? {}) as {
          kind?: string;
          id?: string;
          role?: string;
          options?: Record<string, unknown>;
        };
        if (!kind?.trim()) return void res.status(400).json({ error: "missing kind" });
        try {
          res.json(rt.addAgent(kind.trim(), { id, role, ...(options ? { options } : {}) }));
        } catch (err) {
          res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
        }
      }),
    );

    app.delete(
      "/api/projects/:id/agents/:agentId",
      withRuntime(async (rt, req, res) => {
        try {
          res.json(rt.removeAgent(String(req.params.agentId)));
        } catch (err) {
          res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
        }
      }),
    );

    // Point an agent at a different model. Empty string clears the override.
    app.post(
      "/api/projects/:id/agents/:agentId/model",
      withRuntime(async (rt, req, res) => {
        const { model, provider } = (req.body ?? {}) as { model?: string; provider?: string };
        try {
          const cfg = rt.setAgentModel(String(req.params.agentId), model ?? "", provider);
          res.json({ agent: cfg });
        } catch (err) {
          res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
        }
      }),
    );

    // The models this agent can run, and where the list came from.
    //
    // This comment used to promise "every real model this agent can run, asked
    // of the underlying tool — not a hardcoded list", and for two of the five
    // kinds that was a hardcoded list. Four are now genuinely asked (`opencode
    // models` alone reports ~500 across every provider it has, `codex debug
    // models` a JSON catalog); Claude Code has no way to answer and is served
    // from a remembered set. `source` says which, per response, so a caller can
    // report what actually happened instead of what we'd like to have happened.
    app.get(
      "/api/projects/:id/agents/:agentId/models",
      withRuntime(async (rt, req, res) => {
        const agent = rt.config.agents.find((a) => a.id === String(req.params.agentId));
        if (!agent) return void res.status(404).json({ error: "unknown agent" });
        const { models, source } = await listModelsForKind(agent.kind);
        res.json({ kind: agent.kind, count: models.length, models, source });
      }),
    );

    app.post(
      "/api/projects/:id/interrupt",
      withRuntime(async (rt, _req, res) => {
        res.json(await rt.interrupt());
      }),
    );

    app.post(
      "/api/projects/:id/decisions",
      withRuntime(async (rt, req, res) => {
        const { text } = (req.body ?? {}) as { text?: string };
        if (!text?.trim()) return void res.status(400).json({ error: "missing text" });
        const event = rt.log.append({ kind: "decision", payload: { text } });
        // Also a memory. The decision event stays because the projection and
        // forty other things read it; the memory is the addressable copy — the
        // one that can be retrieved by what it's about, corrected, and
        // forgotten. Seeding the brain from the surface people already use
        // beats asking them to fill a second box.
        rt.brain.add({
          kind: "decision",
          text,
          provenance: { agentId: "user", eventId: event.id, ts: event.ts },
        });
        res.json({ event });
      }),
    );

    // --- the brain ---------------------------------------------------------

    app.get(
      "/api/projects/:id/brain",
      withRuntime(async (rt, req, res) => {
        const q = req.query as Record<string, string | undefined>;
        const memories = rt.brain.list({
          ...(q.kind ? { kind: q.kind as MemoryKind } : {}),
          ...(q.chat ? { chat: q.chat } : {}),
          ...(q.includeExpired === "1" ? { includeExpired: true } : {}),
          ...(q.limit ? { limit: Math.min(500, Number(q.limit) || 100) } : {}),
        });
        res.json({ memories, stats: rt.brain.stats() });
      }),
    );

    app.get(
      "/api/projects/:id/brain/search",
      withRuntime(async (rt, req, res) => {
        const q = req.query as Record<string, string | undefined>;
        const files = q.files ? q.files.split(",").filter(Boolean) : [];
        if (!q.q?.trim() && !files.length) {
          return void res.status(400).json({ error: "missing q or files" });
        }
        // searchBrain, not retrieve: a search that scored differently from
        // the briefing it exists to explain would be worse than no search.
        const hits = await rt.searchBrain({
          ...(q.q ? { query: q.q } : {}),
          ...(files.length ? { files } : {}),
          ...(q.chat ? { chat: q.chat } : {}),
          ...(q.agent ? { agent: q.agent } : {}),
          limit: Math.min(50, Number(q.limit) || 12),
          explain: q.explain === "1",
        });
        res.json({ hits });
      }),
    );

    app.post(
      "/api/projects/:id/brain",
      withRuntime(async (rt, req, res) => {
        const body = (req.body ?? {}) as {
          text?: string;
          kind?: MemoryKind;
          entities?: string[];
          confidence?: number;
          chat?: string;
        };
        if (!body.text?.trim()) return void res.status(400).json({ error: "missing text" });
        try {
          const { memory, created } = rt.brain.add({
            kind: body.kind ?? "fact",
            text: body.text,
            ...(body.entities ? { entities: body.entities } : {}),
            ...(body.chat ? { scope: { chat: body.chat } } : {}),
            ...(body.confidence !== undefined ? { confidence: body.confidence } : {}),
            provenance: { agentId: "user", eventId: rt.log.lastId(), ts: Date.now() },
          });
          res.json({ memory, created });
        } catch (err) {
          res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
        }
      }),
    );

    // Likely contradictions between units, heuristically flagged for a human
    // to resolve — each flag names the signal that tripped it.
    // The event log on disk: how big, and a VACUUM to give back free pages.
    app.get(
      "/api/projects/:id/log/size",
      withRuntime(async (rt, _req, res) => {
        res.json(rt.log.size());
      }),
    );
    app.post(
      "/api/projects/:id/log/compact",
      withRuntime(async (rt, _req, res) => {
        const before = rt.log.size();
        try {
          rt.log.compact();
        } catch (err) {
          return void res.status(409).json({ error: `couldn't compact the log right now: ${err instanceof Error ? err.message : String(err)}` });
        }
        res.json({ before, after: rt.log.size() });
      }),
    );

    // How often each memory reached an agent's prompt.
    app.get(
      "/api/projects/:id/brain/usage",
      withRuntime(async (rt, _req, res) => {
        res.json({ usage: rt.memoryUsage() });
      }),
    );

    app.get(
      "/api/projects/:id/brain/conflicts",
      withRuntime(async (rt, _req, res) => {
        res.json({ conflicts: findConflicts(rt.brain.all()) });
      }),
    );

    // The brain as a file. Export is the live memories — history stays where it
    // happened; what travels is what the project knows. Import dedupes by hash,
    // so bringing the same file in twice reports "known", not duplicates.
    app.get(
      "/api/projects/:id/brain/export",
      withRuntime(async (rt, _req, res) => {
        res.json(rt.brain.export(rt.info.name));
      }),
    );

    app.post(
      "/api/projects/:id/brain/import",
      withRuntime(async (rt, req, res) => {
        try {
          const out = rt.brain.import(req.body as Parameters<typeof rt.brain.import>[0], {
            agentId: "import",
            eventId: rt.log.lastId(),
            ts: Date.now(),
          });
          res.json(out);
        } catch (err) {
          res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
        }
      }),
    );

    app.patch(
      "/api/projects/:id/brain/:mid",
      withRuntime(async (rt, req, res) => {
        try {
          res.json({ memory: rt.brain.update(String(req.params.mid), (req.body ?? {}) as MemoryPatch, "user") });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          res.status(/no such memory/.test(msg) ? 404 : 400).json({ error: msg });
        }
      }),
    );

    app.delete(
      "/api/projects/:id/brain/:mid",
      withRuntime(async (rt, req, res) => {
        const reason = String((req.query as Record<string, string>).reason ?? "").trim();
        if (!reason) return void res.status(400).json({ error: "forgetting needs a reason" });
        const forgot = rt.brain.forget(String(req.params.mid), reason, "user");
        if (!forgot) return void res.status(404).json({ error: "no such memory" });
        res.json({ forgot: true });
      }),
    );

    app.get(
      "/api/projects/:id/brain/:mid/history",
      withRuntime(async (rt, req, res) => {
        res.json({ history: rt.brain.history(String(req.params.mid)) });
      }),
    );

    app.post(
      "/api/projects/:id/route",
      withRuntime(async (rt, req, res) => {
        const { task, spec, router, maxHops } = (req.body ?? {}) as {
          task?: string;
          spec?:
            | string
            | Array<
                string | { step: string; role?: string; instruction?: string; onFail?: string; when?: string }
              >;
          router?: "rules" | "llm";
          maxHops?: number;
        };
        if (!task?.trim()) return void res.status(400).json({ error: "missing task" });
        const route = await rt.startRoute({
          task,
          ...(spec !== undefined ? { spec } : {}),
          ...(router ? { router } : {}),
          ...(maxHops ? { maxHops: Number(maxHops) } : {}),
        });
        res.json({ route });
      }),
    );

    app.get(
      "/api/projects/:id/route",
      withRuntime(async (rt, _req, res) => {
        res.json({ route: rt.routeState() });
      }),
    );

    app.get(
      "/api/projects/:id/costs",
      withRuntime(async (rt, _req, res) => {
        res.json({ costs: rt.costSummary() });
      }),
    );

    // The spend ledger as a daily series, per agent per day — "what did this
    // project cost me last week" and "which agent is eating the tokens" are
    // the same walk over the same events.
    app.get(
      "/api/projects/:id/costs/series",
      withRuntime(async (rt, req, res) => {
        const days = Math.max(1, Math.min(365, Number(req.query.days) || 30));
        res.json({ days, series: rt.costSeries(days) });
      }),
    );

    app.get(
      "/api/projects/:id/tree",
      withRuntime(async (rt, _req, res) => {
        res.json({ tree: await rt.workingTree() });
      }),
    );

    app.get(
      "/api/projects/:id/memory",
      withRuntime(async (rt, _req, res) => {
        res.json({ memory: rt.unifiedMemory() });
      }),
    );

    app.post(
      "/api/projects/:id/memory/import",
      withRuntime(async (rt, _req, res) => {
        res.json(rt.importMemories());
      }),
    );

    app.delete(
      "/api/projects/:id/route",
      withRuntime(async (rt, _req, res) => {
        res.json({ route: await rt.abortRoute() });
      }),
    );

    // Terminal: one long-lived shell per tab. A real pty when node-pty is
    // available (echo, job control, vim), otherwise a pipe-backed shell — see
    // terminals.ts. Output streams over the project WebSocket; input arrives
    // there too, because a tty needs a round-trip per keystroke. Bearer auth +
    // the tailnet are the trust boundary, same as the agents the daemon runs.
    app.post("/api/projects/:id/term/open", (req, res) => {
      const info = findProject(String(req.params.id));
      if (!info) return void res.status(404).json({ error: "unknown project" });
      const { term, cols, rows } = (req.body ?? {}) as {
        term?: string;
        cols?: number;
        rows?: number;
      };
      const termId = String(term ?? "t1");
      const existing = this.terminals.get(info.id, termId);
      if (existing) {
        // A reload rejoins the session it left, and gets replayed what it missed.
        return void res.json({
          term: termId,
          cwd: existing.cwd,
          mode: existing.mode,
          reused: true,
          scrollback: existing.scrollback(),
        });
      }
      try {
        const sess = this.terminals.open(info.id, termId, info.dir, cols ?? 80, rows ?? 24);
        res.json({ term: termId, cwd: sess.cwd, mode: sess.mode, reused: false, scrollback: "" });
      } catch (err) {
        // only the cap is a 429 — a shell that won't spawn is our problem, not
        // the client's rate
        res.status(err instanceof TooManySessionsError ? 429 : 500).json({
          error: (err as Error).message,
        });
      }
    });

    app.post("/api/projects/:id/term/input", (req, res) => {
      const info = findProject(String(req.params.id));
      if (!info) return void res.status(404).json({ error: "unknown project" });
      const { term, data } = (req.body ?? {}) as { term?: string; data?: string };
      const termId = String(term ?? "t1");
      try {
        // this opens a session when none exists, so it can fail the same ways
        // /term/open can — uncaught, Express answers a JSON client with HTML
        const sess =
          this.terminals.get(info.id, termId) ?? this.terminals.open(info.id, termId, info.dir);
        sess.write(String(data ?? ""));
        res.json({ ok: true });
      } catch (err) {
        res.status(err instanceof TooManySessionsError ? 429 : 500).json({
          error: (err as Error).message,
        });
      }
    });

    app.post("/api/projects/:id/term/signal", (req, res) => {
      const info = findProject(String(req.params.id));
      if (!info) return void res.status(404).json({ error: "unknown project" });
      const sess = this.terminals.get(info.id, String((req.body ?? {}).term ?? "t1"));
      if (!sess) return void res.json({ signalled: false });
      sess.interrupt();
      res.json({ signalled: true });
    });

    app.post("/api/projects/:id/term/resize", (req, res) => {
      const info = findProject(String(req.params.id));
      if (!info) return void res.status(404).json({ error: "unknown project" });
      const { term, cols, rows } = (req.body ?? {}) as {
        term?: string;
        cols?: number;
        rows?: number;
      };
      const sess = this.terminals.get(info.id, String(term ?? "t1"));
      if (!sess) return void res.json({ resized: false });
      sess.resize(Number(cols) || 80, Number(rows) || 24);
      res.json({ resized: true });
    });

    app.post("/api/projects/:id/term/close", (req, res) => {
      const info = findProject(String(req.params.id));
      if (!info) return void res.status(404).json({ error: "unknown project" });
      this.terminals.close(info.id, String((req.body ?? {}).term ?? "t1"));
      res.json({ closed: true });
    });

    // The board: live agents (from us) + pull requests (from gh), sorted into
    // working → needs you → in review → ready. See board.ts.
    app.get("/api/projects/:id/board", async (req, res) => {
      const info = findProject(String(req.params.id));
      if (!info) return void res.status(404).json({ error: "unknown project" });
      try {
        const rt = await this.runtime(info.id);
        const status = await rt.status();
        const blocked = status.blockedAgent ? [status.blockedAgent] : [];
        const search = req.query.search ? String(req.query.search) : undefined;
        res.json(
          await buildBoard(info.dir, status.agents, blocked, {
            tasks: rt.boardTasks(),
            ...(search ? { search } : {}),
          }),
        );
      } catch (err) {
        res.status(500).json({ error: (err as Error).message });
      }
    });

    // Cards you write yourself. Unlike an agent or a PR, these are ours, so a
    // drag really moves them — the column IS the state.
    // List the cards you wrote. POST existed without GET — a client that
    // wanted to render or script over its own tasks had to scrape the whole
    // board payload for own:true rows.
    app.get(
      "/api/projects/:id/board/tasks",
      withRuntime(async (rt, _req, res) => {
        res.json({ tasks: readProjectState(rt.info.dir).tasks ?? [] });
      }),
    );

    app.post(
      "/api/projects/:id/board/tasks",
      withRuntime(async (rt, req, res) => {
        const { title, column, agent, blockedBy } = (req.body ?? {}) as {
          title?: string;
          column?: string;
          agent?: string;
          blockedBy?: string[];
        };
        if (!title?.trim()) return void res.status(400).json({ error: "missing title" });
        res.json({
          task: rt.createTask({
            title,
            ...(column ? { column } : {}),
            ...(agent ? { agent } : {}),
            ...(Array.isArray(blockedBy) ? { blockedBy } : {}),
          }),
        });
      }),
    );

    app.post(
      "/api/projects/:id/board/tasks/:taskId",
      withRuntime(async (rt, req, res) => {
        const { title, column, agent, blockedBy } = (req.body ?? {}) as {
          title?: string;
          column?: string;
          agent?: string;
          blockedBy?: string[];
        };
        try {
          const task = rt.updateTask(String(req.params.taskId), {
            ...(title !== undefined ? { title } : {}),
            ...(column !== undefined ? { column } : {}),
            ...(agent !== undefined ? { agent } : {}),
            ...(blockedBy !== undefined ? { blockedBy } : {}),
          });
          if (!task) return void res.status(404).json({ error: "unknown task" });
          res.json({ task });
        } catch (err) {
          // The cycle refusal: A→B→A makes both unbecomable forever.
          res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
        }
      }),
    );

    // What's still in the way of a card. Empty means dispatchable.
    app.get(
      "/api/projects/:id/board/tasks/:taskId/blockers",
      withRuntime(async (rt, req, res) => {
        res.json({ blockers: rt.taskBlockers(String(req.params.taskId)) });
      }),
    );

    // A card becomes a turn: its title goes to its agent as a prompt. This is
    // where blocked-by has teeth — an agent picking up work whose prerequisite
    // isn't done produces work that gets thrown away, so a blocked card is
    // refused here with the blockers named.
    app.post(
      "/api/projects/:id/board/tasks/:taskId/dispatch",
      withRuntime(async (rt, req, res) => {
        const id = String(req.params.taskId);
        const state = readProjectState(rt.info.dir);
        const task = (state.tasks ?? []).find((t: BoardTask) => t.id === id);
        if (!task) return void res.status(404).json({ error: "unknown task" });
        const blockers = rt.taskBlockers(id);
        if (blockers.length) {
          return void res.status(409).json({
            error: "blocked",
            blockers,
            message: `blocked by ${blockers.map((b) => `"${b.title}"`).join(", ")}`,
          });
        }
        const agentId =
          task.agent ?? (req.body as { agentId?: string } | undefined)?.agentId;
        try {
          const out = await rt.sendMessage(task.title, agentId);
          rt.updateTask(id, { column: "working", agent: out.agentId });
          res.json({ dispatched: true, agentId: out.agentId });
        } catch (err) {
          res.status(409).json({ error: err instanceof Error ? err.message : String(err) });
        }
      }),
    );

    app.delete(
      "/api/projects/:id/board/tasks/:taskId",
      withRuntime(async (rt, req, res) => {
        if (!rt.deleteTask(String(req.params.taskId))) {
          return void res.status(404).json({ error: "unknown task" });
        }
        res.json({ deleted: true });
      }),
    );

    // Issues / PRs for the project's GitHub remote, read through the user's
    // own gh CLI (see tasks.ts) — Loom holds no token of its own.
    app.get("/api/projects/:id/tasks", async (req, res) => {
      const info = findProject(String(req.params.id));
      if (!info) return void res.status(404).json({ error: "unknown project" });
      const kind = String(req.query.kind ?? "issue") === "pr" ? "pr" : "issue";
      res.json(
        await listTasks(info.dir, {
          kind,
          ...(req.query.search ? { search: String(req.query.search) } : {}),
        }),
      );
    });

    // Small async wrapper: resolve the project or 404, run the handler, and turn
    // any throw into a 500 with its message. The GitHub/Linear/worktree reads
    // below all share this shape.
    const projectRoute =
      (fn: (dir: string, req: Request, res: Response) => Promise<void>) =>
      (req: Request, res: Response) => {
        const info = findProject(String(req.params.id));
        if (!info) return void res.status(404).json({ error: "unknown project" });
        void fn(info.dir, req, res).catch((err: unknown) =>
          res.status(500).json({ error: err instanceof Error ? err.message : String(err) }),
        );
      };

    // ---- GitHub Projects (v2) — the owner's boards, browsed in-app ----------
    app.get(
      "/api/projects/:id/gh/projects",
      projectRoute(async (dir, _req, res) => {
        res.json(await ghProjects(dir));
      }),
    );
    app.get(
      "/api/projects/:id/gh/projects/:num/items",
      projectRoute(async (dir, req, res) => {
        res.json(await ghProjectItems(dir, Number(req.params.num)));
      }),
    );

    // ---- Pull-request review — diff + approve / request-changes / comment ----
    app.get(
      "/api/projects/:id/prs/:num",
      projectRoute(async (dir, req, res) => {
        res.json(await prView(dir, Number(req.params.num)));
      }),
    );
    app.post(
      "/api/projects/:id/prs/:num/review",
      projectRoute(async (dir, req, res) => {
        const { action, body } = (req.body ?? {}) as { action?: string; body?: string };
        const allowed: PrReviewAction[] = ["approve", "request-changes", "comment"];
        if (!allowed.includes(action as PrReviewAction)) {
          return void res.status(400).json({ error: "action must be approve, request-changes, or comment" });
        }
        const result = await prReview(dir, Number(req.params.num), action as PrReviewAction, body ?? "");
        if ("available" in result) return void res.status(400).json({ error: result.detail });
        res.json(result);
      }),
    );

    // ---- Worktrees — open a checked-out branch from any task ----------------
    app.get(
      "/api/projects/:id/worktrees",
      projectRoute(async (dir, _req, res) => {
        res.json({ worktrees: await gitListWorktrees(dir) });
      }),
    );
    app.post(
      "/api/projects/:id/worktrees",
      projectRoute(async (dir, req, res) => {
        const b = (req.body ?? {}) as {
          pr?: number;
          issue?: number;
          branch?: string;
          newBranch?: string;
          base?: string;
        };
        if (b.pr) {
          const n = Number(b.pr);
          const wt = await gitAddWorktree(dir, { slug: "pr-" + n, detached: true });
          try {
            // gh handles fork PRs (adds the remote, fetches, makes the branch)
            await runGh(["pr", "checkout", String(n)], wt.path);
          } catch (err) {
            // don't strand an empty detached worktree if the checkout fails
            await gitRemoveWorktree(dir, wt.path, true).catch(() => {});
            throw err;
          }
          return void res.json({ path: wt.path, source: `PR #${n}` });
        }
        if (b.newBranch) {
          const wt = await gitAddWorktree(dir, {
            slug: b.newBranch,
            newBranch: String(b.newBranch),
            ...(b.base ? { base: String(b.base) } : {}),
          });
          return void res.json({ path: wt.path, branch: wt.branch });
        }
        if (b.branch) {
          const wt = await gitAddWorktree(dir, { slug: String(b.branch), branch: String(b.branch) });
          return void res.json({ path: wt.path, branch: wt.branch });
        }
        if (b.issue) {
          const slug = "issue-" + Number(b.issue);
          const wt = await gitAddWorktree(dir, { slug, newBranch: slug });
          return void res.json({ path: wt.path, branch: wt.branch, source: `issue #${Number(b.issue)}` });
        }
        res.status(400).json({ error: "say which: pr, issue, branch, or newBranch" });
      }),
    );
    app.delete(
      "/api/projects/:id/worktrees",
      projectRoute(async (dir, req, res) => {
        const wtPath = String((req.body ?? {}).path ?? req.query.path ?? "");
        if (!wtPath) return void res.status(400).json({ error: "which worktree? pass its path" });
        await gitRemoveWorktree(dir, wtPath, Boolean((req.body ?? {}).force));
        res.json({ removed: wtPath });
      }),
    );

    // ---- Linear — teams + create issue, through the user's own key ----------
    app.get(
      "/api/projects/:id/linear/teams",
      projectRoute(async (_dir, _req, res) => {
        res.json(await linearTeams());
      }),
    );
    app.get(
      "/api/projects/:id/linear/issues",
      projectRoute(async (_dir, req, res) => {
        res.json(await listLinearIssues(req.query.team ? String(req.query.team) : undefined));
      }),
    );
    app.post(
      "/api/projects/:id/linear/issues",
      projectRoute(async (_dir, req, res) => {
        const { teamId, title, description } = (req.body ?? {}) as {
          teamId?: string;
          title?: string;
          description?: string;
        };
        const result = await linearCreateIssue({
          teamId: teamId ?? "",
          title: title ?? "",
          ...(description ? { description } : {}),
        });
        if (result.available) return void res.json(result);
        res.status(400).json({ error: result.detail });
      }),
    );

    // Explorer: list a directory, read a file, search filenames. All strictly
    // sandboxed to the project directory (no traversal outside it).
    const contains = (base: string, target: string) =>
      target === base || target.startsWith(base + path.sep);
    /**
     * Resolve a project-relative path, or null if it escapes the project.
     * Two checks, because they catch different attacks: the lexical one stops
     * `../` traversal (and works for paths that don't exist yet), and the
     * realpath one stops a symlink *inside* the project from pointing out of
     * it — path.resolve happily resolves through links.
     */
    const projectPath = (id: string, rel: string | undefined): string | null => {
      const info = findProject(id);
      if (!info) return null;
      let base: string;
      try {
        base = fs.realpathSync(path.resolve(info.dir));
      } catch {
        return null;
      }
      const target = path.resolve(base, rel ?? ".");
      if (!contains(base, target)) return null;
      try {
        if (!contains(base, fs.realpathSync(target))) return null;
      } catch {
        // doesn't exist — the lexical check above is the whole answer
      }
      return target;
    };
    const HIDE_DIRS = new Set([".git", "node_modules", "dist", "build", ".next", ".cache", "coverage"]);

    app.get("/api/projects/:id/files", (req, res) => {
      const dir = projectPath(String(req.params.id), req.query.dir ? String(req.query.dir) : ".");
      if (!dir) return void res.status(404).json({ error: "not found" });
      const base = projectPath(String(req.params.id), ".")!;
      fs.readdir(dir, { withFileTypes: true }, (err, ents) => {
        if (err) return void res.status(400).json({ error: err.message });
        const entries = ents
          .filter((e) => e.name !== ".git")
          .map((e) => ({
            name: e.name,
            path: path.relative(base, path.join(dir, e.name)),
            dir: e.isDirectory(),
          }))
          .sort((a, b) =>
            a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1,
          )
          .slice(0, 500);
        res.json({ dir: path.relative(base, dir), entries });
      });
    });

    app.get("/api/projects/:id/file", (req, res) => {
      const file = projectPath(String(req.params.id), req.query.path ? String(req.query.path) : "");
      if (!file) return void res.status(404).json({ error: "not found" });
      fs.stat(file, (err, st) => {
        if (err) return void res.status(400).json({ error: err.message });
        if (st.isDirectory()) return void res.status(400).json({ error: "is a directory" });
        const MAX = 400_000;
        const truncated = st.size > MAX;
        const stream = fs.createReadStream(file, { start: 0, end: Math.min(st.size, MAX) - 1, encoding: "utf8" });
        let content = "";
        stream.on("data", (c) => (content += c));
        stream.on("error", (e) => res.status(400).json({ error: e.message }));
        stream.on("end", () => {
          const base = projectPath(String(req.params.id), ".")!;
          res.json({ path: path.relative(base, file), content, truncated, size: st.size });
        });
      });
    });

    app.get("/api/projects/:id/find", (req, res) => {
      const base = projectPath(String(req.params.id), ".");
      if (!base) return void res.status(404).json({ error: "not found" });
      const q = String(req.query.q ?? "").trim().toLowerCase();
      if (!q) return void res.json({ matches: [] });
      const matches: string[] = [];
      let visited = 0;
      const walk = (dir: string) => {
        if (matches.length >= 200 || visited >= 20_000) return;
        let ents: fs.Dirent[];
        try {
          ents = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
          return;
        }
        for (const e of ents) {
          if (matches.length >= 200 || visited >= 20_000) return;
          visited++;
          if (e.isDirectory()) {
            if (HIDE_DIRS.has(e.name)) continue;
            walk(path.join(dir, e.name));
          } else if (e.name.toLowerCase().includes(q)) {
            matches.push(path.relative(base, path.join(dir, e.name)));
          }
        }
      };
      walk(base);
      res.json({ matches });
    });

    /**
     * Stash a pasted image or dropped file, and hand back its path.
     *
     * The CLIs Loom drives take text and nothing else — SendInput is { text,
     * briefing }, no image channel. So the only honest way to "attach" an image
     * is to write it somewhere the agent can read and reference the path in the
     * message. Claude Code and Codex both read image files by path; for the
     * others it's at least a real artifact on disk rather than a lie in the UI.
     *
     * Under .loom/attachments/ so it's inside the project (the agent's cwd) but
     * out of the way. Name is derived from a content hash, never from the
     * client's — a caller doesn't get to choose where in the tree this lands.
     */
    /**
     * A picture of what the preview is showing, as an attachment.
     *
     * The frame is someone else's origin, so the page can't photograph it —
     * the daemon does, with the project's own Playwright (core/preview-shot.ts),
     * and the file lands beside pasted images so the composer carries it the
     * same way.
     */
    app.post("/api/projects/:id/preview/screenshot", (req, res) => {
      void (async () => {
        const dir = projectPath(String(req.params.id), ".");
        if (!dir) return void res.status(404).json({ error: "not found" });
        const b = (req.body ?? {}) as { url?: string; width?: number; height?: number; colorScheme?: string; fullPage?: boolean };
        try {
          const shot = await capture(dir, {
            url: String(b.url ?? ""),
            ...(b.width ? { width: Number(b.width) } : {}),
            ...(b.height ? { height: Number(b.height) } : {}),
            colorScheme: b.colorScheme === "dark" ? "dark" : "light",
            fullPage: Boolean(b.fullPage),
          });
          const buf = fs.readFileSync(shot.file);
          fs.rmSync(path.dirname(shot.file), { recursive: true, force: true });
          const hash = crypto.createHash("sha1").update(buf).digest("hex").slice(0, 12);
          const rel = path.join(".loom", "attachments", `preview-${hash}.png`);
          const abs = projectPath(String(req.params.id), rel);
          if (!abs) return void res.status(400).json({ error: "bad attachment path" });
          fs.mkdirSync(path.dirname(abs), { recursive: true });
          fs.writeFileSync(abs, buf);
          res.json({ path: rel, bytes: buf.length, width: shot.width, height: shot.height, colorScheme: shot.colorScheme, fullPage: shot.fullPage });
        } catch (err) {
          res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
        }
      })();
    });

    app.post("/api/projects/:id/attachments", (req, res) => {
      const base = projectPath(String(req.params.id), ".");
      if (!base) return void res.status(404).json({ error: "not found" });
      const { name, dataUrl } = (req.body ?? {}) as { name?: string; dataUrl?: string };
      const m = /^data:([\w/+.-]+);base64,(.+)$/s.exec(dataUrl ?? "");
      if (!m) return void res.status(400).json({ error: "expected a base64 data URL" });
      const mime = m[1] ?? "application/octet-stream";
      const buf = Buffer.from(m[2] ?? "", "base64");
      const MAX = 12 * 1024 * 1024;
      if (buf.length > MAX) return void res.status(413).json({ error: "attachment over 12MB" });

      // Extension from the declared type or the client's name, whichever we
      // trust more — but only ever the extension, never the path.
      const extFromName = typeof name === "string" ? path.extname(name).replace(/[^.\w]/g, "").slice(0, 8) : "";
      const ext = extFromName || "." + (MIME_EXT[mime] ?? "bin");
      const hash = crypto.createHash("sha1").update(buf).digest("hex").slice(0, 12);
      const rel = path.join(".loom", "attachments", hash + ext);
      const abs = projectPath(String(req.params.id), rel);
      if (!abs) return void res.status(400).json({ error: "bad attachment path" });
      try {
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, buf);
      } catch (err) {
        return void res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
      }
      res.json({ path: rel, bytes: buf.length, mime });
    });

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
    const frame = JSON.stringify(payload);
    for (const [ws, sub] of this.sockets) {
      if (ws.readyState !== WebSocket.OPEN) continue;
      if (projectId && sub.project && sub.project !== projectId) continue;
      if (projectId && sub.scope && !sub.scope.includes(projectId)) continue;
      ws.send(frame);
    }
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
      const frame = JSON.stringify({ type: "log", record });
      for (const [ws, sub] of this.sockets) {
        if (ws.readyState !== WebSocket.OPEN) continue;
        // A scoped socket gets its own projects' records only. Daemon-level
        // records (no project) stay admin/unscoped — a phone paired for one
        // project has no business watching the whole machine fail.
        if (sub.scope && (!record.project || !sub.scope.includes(record.project))) continue;
        ws.send(frame);
      }
    });
  }

  /** Fan a terminal frame out to every socket watching this project. */
  private broadcastTerm(projectId: string, frame: Record<string, unknown>): void {
    const payload = JSON.stringify(frame);
    for (const [ws, sub] of this.sockets) {
      if (ws.readyState !== WebSocket.OPEN) continue;
      if (sub.project && sub.project !== projectId) continue;
      if (sub.scope && !sub.scope.includes(projectId)) continue;
      ws.send(payload);
    }
  }

  private pushTokens(): string[] {
    const cfg = readDaemonConfig();
    return (cfg?.clients ?? [])
      .map((c) => c.pushToken)
      .filter((t): t is string => Boolean(t));
  }

  /** Fire-and-notify to phones. Route hops stay quiet; the outcome pushes. */
  private maybePush(projectId: string, event: LoomEvent): void {
    if (!shouldPush(event)) return;
    if (event.kind === "run_complete" && this.runtimes.get(projectId)?.routes.isActive()) {
      return; // a pipeline in flight buzzes once at the end, not per hop
    }
    const tokens = this.pushTokens();
    if (!tokens.length) return;
    const name = listProjects().find((p) => p.id === projectId)?.name ?? "project";
    void sendExpoPush(tokens, {
      ...pushContent(name, event),
      // the phone opens this project (and goal) when the alert is tapped
      data: { projectId, kind: event.kind, ...(typeof event.payload.runId === "string" ? { runId: event.payload.runId } : {}) },
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
    setApprovalEndpoint(`http://127.0.0.1:${this.port}`);
    // In-process agents ask the same way, without the HTTP round trip.
    setApprovalBroker((req) => this.askHuman(req));

    // Fan every log record out to connected clients (the Console tab).
    this.unstreamLogs = this.streamLogs();
    this.writeConfig();
    if (readCloudSettings().enabled) void this.startCloud().catch(() => {});
    void this.team.start().catch(() => {});

    return { host: this.host, port: this.port };
  }

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
        void this.runtime(project).catch(() => {});
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
        if (retried) await rt.handoff(agent).catch(() => {});
        rt.log.append({ kind: "status", agentId: agent, payload: { state: "alert_recovery", alert, retried, attempt, via: "recheck" } });
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
    await this.relay?.close().catch(() => {});
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
    await this.relay?.close().catch(() => {});
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
    await this.team.stop().catch(() => {});
    await this.relay?.close().catch(() => {});
    this.relay = null;
    for (const t of this.healTimers) clearTimeout(t);
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

/** Resolve this machine's Tailscale IPv4 — the tailnet is the trust boundary. */
export function tailscaleIp(): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("tailscale", ["ip", "-4"], (err, stdout) => {
      if (err) {
        reject(
          new Error(
            "could not resolve a Tailscale IP (is tailscale installed and up?) — refusing to bind beyond localhost",
          ),
        );
        return;
      }
      const ip = stdout.trim().split("\n")[0];
      if (!ip) return void reject(new Error("tailscale returned no IPv4"));
      resolve(ip);
    });
  });
}

/**
 * One `tailscale status --json`, folded into the three facts the connect-a-phone
 * flow needs: is the CLI installed, is it signed in, and the tailnet IPv4. Lets
 * the UI tell "install Tailscale" apart from "sign in" — and offer to do the
 * latter from inside the app. Never rejects; a missing binary is `installed:false`.
 */
export function tailscaleState(): Promise<{
  installed: boolean;
  loggedIn: boolean;
  ip: string | null;
  dnsName: string | null;
  state: string | null;
}> {
  return new Promise((resolve) => {
    execFile("tailscale", ["status", "--json"], (err, stdout) => {
      if (err && (err as NodeJS.ErrnoException).code === "ENOENT") {
        return void resolve({ installed: false, loggedIn: false, ip: null, dnsName: null, state: null });
      }
      // `status --json` still prints the JSON on stdout even when it exits non-zero
      // (logged out), so parse regardless of the exit code; only ENOENT means "no CLI".
      try {
        const j = JSON.parse(stdout) as {
          BackendState?: string;
          TailscaleIPs?: string[] | null;
          Self?: { DNSName?: string };
        };
        const ip = (j.TailscaleIPs ?? []).find((a) => !a.includes(":")) ?? null;
        const dnsName = (j.Self?.DNSName ?? "").replace(/\.$/, "") || null;
        resolve({
          installed: true,
          loggedIn: j.BackendState === "Running",
          ip,
          dnsName,
          state: j.BackendState ?? null,
        });
      } catch {
        resolve({ installed: true, loggedIn: false, ip: null, dnsName: null, state: null });
      }
    });
  });
}

/**
 * Expose a local port to the public internet over Tailscale Funnel — how the
 * physical LoomPad reaches the voice backend from anywhere (a bare ESP32 can't
 * route to a 100.x tailnet address, but it can reach a Funnel's HTTPS URL).
 * `--bg` returns as soon as it's serving and prints the public URL.
 */
export function tailscaleFunnel(port: number): Promise<{ url: string }> {
  return new Promise((resolve, reject) => {
    execFile("tailscale", ["funnel", "--bg", String(port)], (err, stdout, stderr) => {
      const out = `${stdout}\n${stderr}`;
      const m = out.match(/https:\/\/[^\s/]+\.ts\.net\S*/);
      if (m) return void resolve({ url: m[0].replace(/\/+$/, "") });
      const msg = out.trim().split("\n").slice(0, 3).join(" ").trim();
      reject(new Error(msg || (err ? String(err) : "Funnel did not return a URL")));
    });
  });
}

/**
 * Fallback ids for a codex too old to have `codex debug models`.
 *
 * Not the shipped set — a *previous* shipped set, which is exactly what a codex
 * without the subcommand would be running. The current one is asked of the CLI;
 * see codexModelCatalog. Anything served from here is reported as
 * `source: "builtin"`.
 */
const CODEX_MODELS = [
  "gpt-5.5", "gpt-5.5-codex", "gpt-5.2-codex", "gpt-5.1-codex-max",
  "gpt-5.1-codex", "gpt-5.1-codex-mini", "gpt-5-codex", "o4-mini",
];

/**
 * Claude Code's model aliases. The only builtin list left, and it is builtin
 * because the CLI genuinely cannot answer the question.
 *
 * `claude --help` has no `models` subcommand and lists none: what it documents
 * is the shape of the argument — "Provide an alias for the latest model (e.g.
 * 'fable', 'opus', or 'sonnet') or a model's full name (e.g. 'claude-fable-5')".
 * And `claude models` is not an error, which is the trap: `models` is taken as a
 * *prompt*, so the "enumeration" is a billed turn of an LLM writing prose about
 * models, with whatever ids it believes today. A model list that costs money and
 * can hallucinate is not a model list.
 *
 * So: aliases only. They are what the CLI's own help names, they resolve to the
 * latest snapshot by definition, and they can't go stale the way a pinned
 * "claude-sonnet-5" did — an id that used to sit in this array and has never
 * been a model. Full ids belong in the picker's custom field, where they're your
 * claim rather than ours.
 */
const CLAUDE_MODELS = ["opus", "sonnet", "haiku", "fable"];

/** Where a model list came from, so a caller can say which. */
export type ModelSource = "cli" | "builtin" | "api" | "none";
export type ModelList = { models: string[]; source: ModelSource };

const MODEL_LIST_CACHE = new Map<string, { list: ModelList; ts: number }>();

/**
 * Whatever a CLI prints on stdout, or "" if it can't be run. Never throws.
 *
 * This is `spawn` and not `execFile` for a reason that cost an afternoon:
 * `execFile` calls back when the child's *streams* close, and `agy models`
 * leaves a language-server process holding stdout open after it exits, so
 * execFile waits out its whole timeout and hands back an empty string — the
 * Antigravity picker looked exactly like a CLI that reports no models, on a
 * machine where `agy models` prints eleven. Measured, repeatedly, one fresh
 * process per attempt: execFile 25s/0 lines, spawn 5.3s/11 lines.
 *
 * So: resolve on `exit`, with a short grace period for data still in the pipe,
 * and take `close` when it comes first (it does for every other CLI here).
 * stderr is drained and dropped — unread, a chatty CLI can fill its pipe and
 * block on the write.
 */
function runCapture(cmd: string, args: string[], timeoutMs = 20_000): Promise<string> {
  return new Promise((resolve) => {
    const MAX = 8 * 1024 * 1024;
    let out = "";
    let settled = false;
    let hard: NodeJS.Timeout | undefined;
    let drain: NodeJS.Timeout | undefined;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(hard);
      clearTimeout(drain);
      resolve(out);
    };
    let child;
    try {
      child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    } catch {
      return void resolve(""); // not a runnable path
    }
    hard = setTimeout(() => {
      child.kill("SIGKILL");
      finish();
    }, timeoutMs);
    child.stdout.on("data", (d: Buffer) => {
      if (out.length < MAX) out += d.toString();
    });
    child.stderr.on("data", () => {});
    child.on("error", finish); // not installed
    child.on("close", finish); // streams closed — everything it wrote is here
    child.on("exit", () => {
      // ...unless something it spawned still holds the pipe. Give the buffered
      // bytes a moment to arrive, then take what we have.
      drain = setTimeout(finish, 300);
    });
  });
}

/** Model ids a CLI prints (one per line), ANSI stripped. Never throws. */
function runModelList(cmd: string, args: string[]): Promise<string[]> {
  return runCapture(cmd, args).then((stdout) => {
    const models: string[] = [];
    for (const raw of stdout.split("\n")) {
      // strip ANSI + leading bullets, take the first token: grok prints
      // "  * grok-4.5 (default)", opencode a bare "provider/id" per line.
      // eslint-disable-next-line no-control-regex
      const cleaned = raw.replace(/\u001b?\[[0-9;]*m/g, "").replace(/^[\s>*+-]+/, "").trim();
      const tok = cleaned.split(/\s+/)[0] ?? "";
      if (
        /^[A-Za-z0-9][\w./:@+-]*$/.test(tok) &&
        tok.length < 120 &&
        !/^(you|default|available|logged|models?|none|error)$/i.test(tok)
      ) {
        models.push(tok);
      }
    }
    return [...new Set(models)];
  });
}

/**
 * codex's own model catalog, which it will print as JSON: `codex debug models`.
 *
 * Not a documented list command — it's under `debug` — but it is the CLI
 * answering about itself rather than us remembering, and it's the same catalog
 * the picker in codex's own TUI is built from. Each entry carries a `slug` (the
 * value `-m` takes) and a `visibility`; `hide` means internal (codex-auto-review
 * is one), and offering an agent a model its own UI won't is offering a
 * failure. ~65ms and 184KB on this machine — the base instructions for every
 * model ride along in that JSON, hence the buffer.
 *
 * Empty on any older codex that has no `debug models`, which is the caller's cue
 * to fall back and say so.
 */
function codexModelCatalog(bin: string): Promise<string[]> {
  return runCapture(bin, ["debug", "models"]).then((stdout) => {
    try {
      const parsed = JSON.parse(stdout) as {
        models?: Array<{ slug?: unknown; visibility?: unknown }>;
      };
      const slugs = (parsed.models ?? [])
        .filter((m) => m.visibility !== "hide")
        .map((m) => String(m.slug ?? "").trim())
        .filter(Boolean);
      return [...new Set(slugs)];
    } catch {
      return []; // not JSON — an older codex, or one that errored
    }
  });
}

/**
 * The models an agent kind can run, and whether Loom asked or remembered.
 *
 * Four of the five adapters can be asked, each in its own dialect: `opencode
 * models` (~500 lines across every provider it has), `grok models`, `agy models`
 * (the Antigravity CLI — this branch was missing entirely, so its picker offered
 * "Default" and "Custom…" and nothing else), and `codex debug models`, which
 * prints a JSON catalog rather than lines. Claude Code cannot be asked at all —
 * see CLAUDE_MODELS.
 *
 * `source` is the point of the return shape. "cli" means the tool answered;
 * "builtin" means it couldn't and this is Loom's remembered list, which the UI
 * must be able to say out loud instead of implying a lookup that never
 * happened. An uninstalled CLI answers with nothing, and an empty answer from a
 * CLI is still "cli" — an empty picker for a tool you don't have is the honest
 * result, not a reason to serve it a remembered list behind its back. codex is
 * the one exception: an empty answer there can equally mean a codex too old to
 * have `debug models`, so it falls back — and "builtin" is the true label for
 * whichever of the two it was.
 *
 * Cached 60s per kind: the pickers reopen constantly and none of these change
 * between two clicks.
 */
export async function listModelsForKind(kind: string): Promise<ModelList> {
  const hit = MODEL_LIST_CACHE.get(kind);
  if (hit && Date.now() - hit.ts < 60_000) return hit.list;
  let list: ModelList = { models: [], source: "none" };
  if (kind === "opencode") {
    list = { models: await runModelList("opencode", ["models"]), source: "cli" };
  } else if (kind === "grok-code") {
    list = { models: await runModelList(grokBin() ?? "grok", ["models"]), source: "cli" };
  } else if (kind === "antigravity-cli") {
    list = { models: await runModelList(agyBin() ?? "agy", ["models"]), source: "cli" };
  } else if (kind === "codex") {
    const slugs = await codexModelCatalog(codexBin() ?? "codex");
    list = slugs.length ? { models: slugs, source: "cli" } : { models: CODEX_MODELS, source: "builtin" };
  } else if (kind === "claude-code") {
    list = { models: CLAUDE_MODELS, source: "builtin" };
  } else if (kind === "model") {
    // Not a CLI to ask and not a list to hardcode: the providers themselves
    // say what they have, and it changes under you (see #82).
    const { models } = await allModels();
    list = { models: models.map((m) => `${m.provider}/${m.id}`), source: "api" };
  }
  MODEL_LIST_CACHE.set(kind, { list, ts: Date.now() });
  return list;
}

/**
 * Bring Tailscale up from inside the app. Runs `tailscale up`; if the machine
 * needs to sign in, that prints a one-time login URL and then blocks until the
 * user authorizes — so we resolve with the URL as soon as we see it and leave
 * the process running (unref'd) to finish the handshake in the background. If it
 * was already signed in, `up` returns fast and we resolve with the tailnet IP.
 */
export function tailscaleUp(): Promise<{ loginUrl?: string; ip?: string }> {
  return new Promise((resolve, reject) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn("tailscale", ["up"], { detached: true, stdio: ["ignore", "pipe", "pipe"] });
    } catch (err) {
      return void reject(err instanceof Error ? err : new Error(String(err)));
    }
    let settled = false;
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      fn();
    };
    const scan = (buf: Buffer) => {
      const m = buf.toString().match(/https:\/\/login\.tailscale\.com\/\S+/);
      if (m) settle(() => {
        child.unref(); // keep it running in the background to finish the login
        resolve({ loginUrl: m[0] });
      });
    };
    child.stdout?.on("data", scan);
    child.stderr?.on("data", scan);
    child.on("error", (err) => settle(() => reject(err)));
    child.on("exit", () => {
      // Exited before printing a URL: either it was already up, or it failed.
      if (settled) return;
      tailscaleIp().then(
        (ip) => settle(() => resolve({ ip })),
        () => settle(() => reject(new Error("tailscale up exited without a login URL"))),
      );
    });
    setTimeout(() => settle(() => reject(new Error("timed out waiting for Tailscale to start"))), 25_000);
  });
}

/**
 * This machine's LAN IPv4 — the address a phone on the same Wi-Fi uses. We skip
 * loopback, link-local (169.254), and Tailscale's own 100.64/10 CGNAT range so
 * "local network" and "tailnet" stay distinct choices. Returns null when the
 * only addresses are loopback (e.g. no network) — the caller says so honestly
 * rather than minting an unreachable QR.
 */
export function lanIp(): string | null {
  const ifaces = os.networkInterfaces();
  const candidates: string[] = [];
  for (const addrs of Object.values(ifaces)) {
    for (const a of addrs ?? []) {
      if (a.family !== "IPv4" || a.internal) continue;
      if (a.address.startsWith("169.254.")) continue; // link-local, not routable
      if (a.address.startsWith("100.")) continue; // Tailscale CGNAT — that's the tailnet
      candidates.push(a.address);
    }
  }
  // Prefer the common private ranges (a real LAN) over anything exotic.
  const priv = candidates.find(
    (ip) => ip.startsWith("192.168.") || ip.startsWith("10.") || /^172\.(1[6-9]|2\d|3[01])\./.test(ip),
  );
  return priv ?? candidates[0] ?? null;
}

/** Is this connection from the same machine? (127.0.0.1, ::1, or v4-mapped v6.) */
export function isLoopback(remoteAddress: string | undefined): boolean {
  if (!remoteAddress) return false;
  return (
    remoteAddress === "127.0.0.1" ||
    remoteAddress === "::1" ||
    remoteAddress === "::ffff:127.0.0.1"
  );
}

/**
 * Is the request's `Host` header a loopback literal? The anti-DNS-rebinding
 * check: a rebinding attacker loads a page from their own domain, so the browser
 * sends `Host: attacker.example` even after the name rebinds to 127.0.0.1 — while
 * the genuine local console is always reached at `127.0.0.1`/`localhost`. Pairing
 * the socket check with this closes the "any website → localhost token oracle"
 * path. The port is ignored; only the host is checked.
 */
export function isLoopbackHost(hostHeader: string | undefined): boolean {
  if (!hostHeader) return false;
  let host = hostHeader.trim().toLowerCase();
  if (host.startsWith("[")) {
    const end = host.indexOf("]");
    host = end > 0 ? host.slice(1, end) : host.slice(1);
  } else if ((host.match(/:/g) || []).length === 1) {
    host = host.slice(0, host.indexOf(":")); // strip the port off host:port
  }
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}
