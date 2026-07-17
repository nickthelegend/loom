/**
 * The Loom daemon — one process, many projects, one API for every surface
 * (CLI today, iOS app next). REST for commands, WebSocket for the live
 * event stream.
 */

import { execFile } from "node:child_process";
import crypto from "node:crypto";
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
import { retrieve } from "../core/brain-index.js";
import { RouteActiveError } from "../core/routes.js";
import { ADES, buildDefaultRoutes, defaultAgentConfigs, detectAdes } from "../core/ades.js";
import { logbook, type LogLevel } from "../core/logbook.js";
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
  findProject,
  listProjects,
  readDaemonConfig,
  readProjectConfig,
  registerProject,
  writeDaemonConfig,
  writeProjectConfig,
} from "../core/registry.js";
import { cliAvailable } from "../adapters/base.js";
import { APP_HTML, APP_MANIFEST } from "./app-page.js";
import { GEIST_WOFF2 } from "./geist-font.js";
import { AuthManager, bearerToken } from "./auth.js";
import { PUSH_KINDS, pushContent, sendExpoPush } from "./push.js";
import { ProjectRuntime } from "./runtime.js";
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

export interface DaemonOptions {
  host?: string;
  port?: number;
  /** Bind to the Tailscale interface instead of localhost. */
  tailnet?: boolean;
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


export class LoomDaemon {
  private app = express();
  private server: Server | null = null;
  private wss: WebSocketServer | null = null;
  private auth: AuthManager;
  private runtimes = new Map<string, ProjectRuntime>();
  private sockets = new Map<WebSocket, { project?: string }>();
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
  });
  private unstreamLogs: (() => void) | null = null;
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

  constructor(opts: DaemonOptions = {}) {
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
    app.use(express.json({ limit: "2mb" }));

    // Public: the phone app shell (its API calls are bearer-authed),
    // health, and the pairing claim (the pairing token IS the auth).
    app.get("/", (_req, res) => res.redirect("/app"));
    app.get("/app", (_req, res) => {
      // Never cache the shell: a redeployed daemon must serve its own UI.
      res.type("html").setHeader("Cache-Control", "no-store").send(APP_HTML);
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
        version: "0.1.0",
        rev: BUILD_REV,
        terminal: this.terminals.mode,
      });
    });

    app.post("/api/pair/claim", (req, res) => {
      const { token, name } = (req.body ?? {}) as { token?: string; name?: string };
      if (!token) return void res.status(400).json({ error: "missing token" });
      const claimed = this.auth.claim(token, name ?? "device");
      if (!claimed) return void res.status(403).json({ error: "invalid or expired pairing token" });
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
      if (!isLoopback(req.socket.remoteAddress) || !isLoopbackHost(req.headers.host)) {
        return void res.status(403).json({ error: "not a local request" });
      }
      res.json({ token: this.auth.adminToken(), admin: true });
    });

    // Everything else requires a bearer token.
    app.use((req: Request, res: Response, next: NextFunction) => {
      const token = bearerToken(req.headers.authorization);
      if (!this.auth.isAuthorized(token)) {
        res.status(401).json({ error: "unauthorized" });
        return;
      }
      (req as Request & { isAdmin?: boolean }).isAdmin = this.auth.isAdmin(token);
      next();
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
    app.get("/api/updates", (_req, res) => {
      void (async () => {
        const root = loomRoot();
        let git = null;
        if (root) {
          const { remoteBehind } = await import("../core/git.js");
          git = await remoteBehind(root).catch(() => null);
        }
        res.json({ version: "0.1.0", rev: BUILD_REV, root, git });
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
        let ts: string | null = null;
        try {
          ts = await tailscaleIp();
        } catch {
          ts = null;
        }
        res.json({
          port: this.port,
          boundHost: this.host,
          exposed,
          localnet: { ip: lan, reachable: reach(lan) },
          tailnet: ts
            ? { ip: ts, available: true, reachable: reach(ts) }
            : {
                ip: null,
                available: false,
                reachable: false,
                reason: "Tailscale isn't logged in on this machine (run `tailscale up`)",
              },
        });
      })();
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
        const { token, expiresAt } = this.auth.newPairingToken();
        const url = `http://${host}:${this.port}`;
        // Deep link: scanning it with any camera opens the app, which claims the
        // single-use token from the URL fragment and pairs itself.
        const link = `${url}/app#pair=${token}`;
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

    app.get("/api/projects", (_req, res) => {
      void (async () => {
        const projects = [];
        for (const info of listProjects()) {
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
        const info = registerProject(resolved, config.name);
        res.json({ project: info, config });
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

    app.get(
      "/api/projects/:id/events",
      withRuntime(async (rt, req, res) => {
        const since = req.query.since ? Number(req.query.since) : undefined;
        const limit = req.query.limit ? Number(req.query.limit) : 200;
        // no ?chat= means the whole project — old clients keep seeing the
        // whole thread, which is what they've always shown
        const chat = req.query.chat ? String(req.query.chat) : undefined;
        res.json({ events: rt.log.list({ since, limit, ...(chat ? { chat } : {}) }) });
      }),
    );

    app.post(
      "/api/projects/:id/messages",
      withRuntime(async (rt, req, res) => {
        const { text, agentId, chat } = (req.body ?? {}) as {
          text?: string;
          agentId?: string;
          chat?: string;
        };
        if (!text?.trim()) return void res.status(400).json({ error: "missing text" });
        const result = await rt.sendMessage(text, agentId, chat ? { chat } : {});
        res.json(result);
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
     * It blocks for as long as the app takes to answer — minutes, for a real
     * task. That's why it's its own route: nothing else here is allowed to be
     * this slow, and the client needs to know to wait.
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
          res.status(409).json({ error: err instanceof Error ? err.message : String(err) });
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
        const { title } = (req.body ?? {}) as { title?: string };
        res.json({ chat: rt.createChat(String(title ?? "")) });
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
          });
          res.json({
            brain: cfg.brain ?? {},
            projection: cfg.projection ?? {},
            defaultAgent: cfg.defaultAgent ?? "",
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
        const inProject = new Set(rt.config.agents.map((a) => a.kind));
        res.json({
          ades: ADES.map((a) => ({
            kind: a.kind,
            label: a.label,
            tier: a.tier,
            // Bridges are never "installed" — they're an app you launch with a
            // debug port, so presence is a live question, not a lookup.
            installed: a.tier === "adapter" ? Boolean(availability[a.kind]) : null,
            inProject: inProject.has(a.kind),
            models: a.models ?? [],
          })),
        });
      }),
    );

    // Add an agent to a project. A roster used to be frozen at creation: install
    // a new ADE and your existing projects never heard of it.
    app.post(
      "/api/projects/:id/agents",
      withRuntime(async (rt, req, res) => {
        const { kind, id, role } = (req.body ?? {}) as { kind?: string; id?: string; role?: string };
        if (!kind?.trim()) return void res.status(400).json({ error: "missing kind" });
        try {
          res.json(rt.addAgent(kind.trim(), { id, role }));
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
        const { model } = (req.body ?? {}) as { model?: string };
        try {
          const cfg = rt.setAgentModel(String(req.params.agentId), model ?? "");
          res.json({ agent: cfg });
        } catch (err) {
          res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
        }
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
        const hits = retrieve(rt.brain, {
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
          spec?: string | Array<string | { step: string; role?: string; instruction?: string }>;
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
    app.post(
      "/api/projects/:id/board/tasks",
      withRuntime(async (rt, req, res) => {
        const { title, column, agent } = (req.body ?? {}) as {
          title?: string;
          column?: string;
          agent?: string;
        };
        if (!title?.trim()) return void res.status(400).json({ error: "missing title" });
        res.json({ task: rt.createTask({ title, ...(column ? { column } : {}), ...(agent ? { agent } : {}) }) });
      }),
    );

    app.post(
      "/api/projects/:id/board/tasks/:taskId",
      withRuntime(async (rt, req, res) => {
        const { title, column, agent } = (req.body ?? {}) as {
          title?: string;
          column?: string;
          agent?: string;
        };
        const task = rt.updateTask(String(req.params.taskId), {
          ...(title !== undefined ? { title } : {}),
          ...(column !== undefined ? { column } : {}),
          ...(agent !== undefined ? { agent } : {}),
        });
        if (!task) return void res.status(404).json({ error: "unknown task" });
        res.json({ task });
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
    rt.log.onEvent((e) => this.broadcast(info.id, e));
    this.runtimes.set(info.id, rt);
    return rt;
  }

  private broadcast(projectId: string, event: LoomEvent): void {
    const frame = JSON.stringify({ type: "event", projectId, event });
    for (const [ws, sub] of this.sockets) {
      if (ws.readyState !== WebSocket.OPEN) continue;
      if (sub.project && sub.project !== projectId) continue;
      ws.send(frame);
    }
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
      for (const [ws] of this.sockets) {
        if (ws.readyState === WebSocket.OPEN) ws.send(frame);
      }
    });
  }

  /** Fan a terminal frame out to every socket watching this project. */
  private broadcastTerm(projectId: string, frame: Record<string, unknown>): void {
    const payload = JSON.stringify(frame);
    for (const [ws, sub] of this.sockets) {
      if (ws.readyState !== WebSocket.OPEN) continue;
      if (sub.project && sub.project !== projectId) continue;
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
    if (!PUSH_KINDS.has(event.kind)) return;
    if (event.kind === "run_complete" && this.runtimes.get(projectId)?.routes.isActive()) {
      return; // a pipeline in flight buzzes once at the end, not per hop
    }
    const tokens = this.pushTokens();
    if (!tokens.length) return;
    const name = listProjects().find((p) => p.id === projectId)?.name ?? "project";
    void sendExpoPush(tokens, {
      ...pushContent(name, event),
      data: { projectId, kind: event.kind },
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

    // Fan every log record out to connected clients (the Console tab).
    this.unstreamLogs = this.streamLogs();
    this.writeConfig();

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
      const token = url.searchParams.get("token") ?? undefined;
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
      this.sockets.set(ws, { ...(resolvedProject ? { project: resolvedProject } : {}) });
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

  async close(): Promise<void> {
    this.unstreamLogs?.();
    this.unstreamLogs = null;
    this.terminals.closeAll();
    for (const rt of this.runtimes.values()) await rt.close();
    this.runtimes.clear();
    for (const { server, wss } of this.extra.values()) {
      wss.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    this.extra.clear();
    this.wss?.close();
    await new Promise<void>((resolve) => {
      if (!this.server) return resolve();
      this.server.close(() => resolve());
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
