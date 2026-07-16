/**
 * The Loom daemon — one process, many projects, one API for every surface
 * (CLI today, iOS app next). REST for commands, WebSocket for the live
 * event stream.
 */

import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import type { Server } from "node:http";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express, { type Request, type Response, type NextFunction } from "express";
import { WebSocketServer, WebSocket } from "ws";
import type { LoomEvent, ProjectInfo } from "../types.js";
import { NotHolderError } from "../core/baton.js";
import { RouteActiveError } from "../core/routes.js";
import {
  buildDefaultRoutes,
  defaultAgentConfigs,
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
import { listTasks } from "./tasks.js";
import { TerminalManager, TooManySessionsError } from "./terminals.js";

export interface DaemonOptions {
  host?: string;
  port?: number;
  /** Bind to the Tailscale interface instead of localhost. */
  tailnet?: boolean;
}

export const DEFAULT_PORT = 7420;

/**
 * Build fingerprint — a content hash of this compiled module AND the served
 * web app. A daemon started from an older build reports a different rev than
 * a freshly built CLI or desktop shell expects, and they restart it
 * automatically ("failed to fetch" after upgrades usually meant a stale
 * daemon serving yesterday's code). Content-based on purpose: mtimes are
 * unreliable across runtimes on some filesystems (exFAT drives skew them by
 * the local timezone offset). app-page.js is included so UI-only rebuilds
 * change the rev too.
 */
export const BUILD_REV = (() => {
  try {
    const me = fileURLToPath(import.meta.url);
    const hash = crypto.createHash("sha256").update(fs.readFileSync(me));
    try {
      hash.update(fs.readFileSync(path.join(path.dirname(me), "app-page.js")));
    } catch {
      /* app page missing — the server hash alone still fingerprints */
    }
    return hash.digest("hex").slice(0, 16);
  } catch {
    return "dev";
  }
})();

const TERM_MARK = "__LOOM_END__";

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
  host: string;
  port: number;

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

    app.post("/api/pair/new", (req, res) => {
      if (!(req as Request & { isAdmin?: boolean }).isAdmin) {
        return void res.status(403).json({ error: "admin only" });
      }
      const { token, expiresAt } = this.auth.newPairingToken();
      res.json({ token, expiresAt, url: `http://${this.host}:${this.port}` });
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
          const availability = {
            "claude-code": await cliAvailable("claude"),
            opencode: await cliAvailable("opencode"),
          };
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
        res.json({ events: rt.log.list({ since, limit }) });
      }),
    );

    app.post(
      "/api/projects/:id/messages",
      withRuntime(async (rt, req, res) => {
        const { text, agentId } = (req.body ?? {}) as { text?: string; agentId?: string };
        if (!text?.trim()) return void res.status(400).json({ error: "missing text" });
        const result = await rt.sendMessage(text, agentId);
        res.json(result);
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
        res.json({ event });
      }),
    );

    app.post(
      "/api/projects/:id/route",
      withRuntime(async (rt, req, res) => {
        const { task, spec, router, maxHops } = (req.body ?? {}) as {
          task?: string;
          spec?: string | Array<string | { step: string; instruction?: string }>;
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
        res.json(await buildBoard(info.dir, status.agents, blocked));
      } catch (err) {
        res.status(500).json({ error: (err as Error).message });
      }
    });

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
    this.maybePush(projectId, event);
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
      this.server = this.app.listen(this.port, this.host, () => resolve());
      this.server.on("error", reject);
    });
    const addr = this.server!.address();
    if (addr && typeof addr === "object") this.port = addr.port; // ephemeral port support

    this.wss = new WebSocketServer({ server: this.server!, path: "/ws" });
    this.wss.on("connection", (ws, req) => {
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

    // Record where we actually bound so CLIs can find us.
    const cfg = ensureDaemonConfig({ host: this.host, port: this.port });
    cfg.host = this.host;
    cfg.port = this.port;
    cfg.pid = process.pid;
    writeDaemonConfig(cfg);

    return { host: this.host, port: this.port };
  }

  async close(): Promise<void> {
    this.terminals.closeAll();
    for (const rt of this.runtimes.values()) await rt.close();
    this.runtimes.clear();
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
