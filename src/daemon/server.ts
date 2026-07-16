/**
 * The Loom daemon — one process, many projects, one API for every surface
 * (CLI today, iOS app next). REST for commands, WebSocket for the live
 * event stream.
 */

import { type ChildProcess, execFile, spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import type { Server } from "node:http";
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

/** Sentinel the shell prints after every command: `<MARK><rc>\t<cwd>\n`. */
const TERM_MARK = "__LOOM_END__";

interface TermSession {
  child: ChildProcess;
  projectId: string;
  termId: string;
  /** Pending stdout/stderr text not yet scanned for the sentinel. */
  buf: string;
  cwd: string;
  /** Bytes streamed for the current command (reset per input). */
  sent: number;
}

export class LoomDaemon {
  private app = express();
  private server: Server | null = null;
  private wss: WebSocketServer | null = null;
  private auth: AuthManager;
  private runtimes = new Map<string, ProjectRuntime>();
  private sockets = new Map<WebSocket, { project?: string }>();
  /** Live terminal shells, keyed by `${projectId}:${termId}`. */
  private termSessions = new Map<string, TermSession>();
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
    app.get("/api/health", (_req, res) => {
      res.json({ ok: true, name: "loom", version: "0.1.0", rev: BUILD_REV });
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

    // Terminal: one long-lived shell per terminal tab, streamed over the
    // project WebSocket. Not a PTY (no native deps), but a real shell session:
    // `cd` and exported vars persist, and Ctrl+C interrupts the foreground job
    // because the shell is its own process-group leader. After each command we
    // write a sentinel that reports the exit code and the new cwd, which the
    // daemon strips from the stream and reports as a `term-exit` frame.
    // Bearer auth + the tailnet are the trust boundary, same as the agents the
    // daemon already runs.
    app.post("/api/projects/:id/term/open", (req, res) => {
      const info = findProject(String(req.params.id));
      if (!info) return void res.status(404).json({ error: "unknown project" });
      const termId = String((req.body ?? {}).term ?? "t1");
      const key = `${info.id}:${termId}`;
      if (this.termSessions.has(key)) {
        return void res.json({ term: termId, cwd: this.termSessions.get(key)!.cwd, reused: true });
      }
      if (this.termSessions.size >= 12) {
        return void res.status(429).json({ error: "too many terminal sessions" });
      }
      let sess: TermSession;
      try {
        sess = this.openTermSession(info.id, info.dir, termId);
      } catch (err) {
        return void res.status(500).json({ error: (err as Error).message });
      }
      res.json({ term: termId, cwd: sess.cwd });
    });

    app.post("/api/projects/:id/term/input", (req, res) => {
      const info = findProject(String(req.params.id));
      if (!info) return void res.status(404).json({ error: "unknown project" });
      const { term, data } = (req.body ?? {}) as { term?: string; data?: string };
      const termId = String(term ?? "t1");
      let sess = this.termSessions.get(`${info.id}:${termId}`);
      if (!sess) {
        try {
          sess = this.openTermSession(info.id, info.dir, termId);
        } catch (err) {
          return void res.status(500).json({ error: (err as Error).message });
        }
      }
      const line = String(data ?? "");
      sess.sent = 0; // per-command output budget
      // Run the command, then report `exit-code<TAB>cwd` on its own line.
      const probe =
        process.platform === "win32"
          ? `\r\necho ${TERM_MARK}%ERRORLEVEL%\t%CD%\r\n`
          : `\n__loom_rc=$?; printf '\\n${TERM_MARK}%s\\t%s\\n' "$__loom_rc" "$PWD"\n`;
      sess.child.stdin?.write(line + probe);
      res.json({ ok: true });
    });

    app.post("/api/projects/:id/term/signal", (req, res) => {
      const info = findProject(String(req.params.id));
      if (!info) return void res.status(404).json({ error: "unknown project" });
      const termId = String((req.body ?? {}).term ?? "t1");
      const sess = this.termSessions.get(`${info.id}:${termId}`);
      if (!sess?.child.pid) return void res.json({ signalled: false });
      try {
        // negative pid → the whole process group, i.e. the foreground job
        process.kill(-sess.child.pid, "SIGINT");
      } catch {
        try {
          sess.child.kill("SIGINT");
        } catch {
          /* already gone */
        }
      }
      res.json({ signalled: true });
    });

    app.post("/api/projects/:id/term/close", (req, res) => {
      const info = findProject(String(req.params.id));
      if (!info) return void res.status(404).json({ error: "unknown project" });
      const termId = String((req.body ?? {}).term ?? "t1");
      this.closeTermSession(`${info.id}:${termId}`);
      res.json({ closed: true });
    });

    // Explorer: list a directory, read a file, search filenames. All strictly
    // sandboxed to the project directory (no traversal outside it).
    const projectPath = (id: string, rel: string | undefined): string | null => {
      const info = findProject(id);
      if (!info) return null;
      const base = path.resolve(info.dir);
      const target = path.resolve(base, rel ?? ".");
      if (target !== base && !target.startsWith(base + path.sep)) return null;
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

  /** Start a long-lived shell for one terminal tab, reading commands on stdin. */
  private openTermSession(projectId: string, dir: string, termId: string): TermSession {
    const isWin = process.platform === "win32";
    const shell = isWin ? "cmd.exe" : process.env.SHELL || "/bin/sh";
    const child = spawn(shell, isWin ? [] : ["-s"], {
      cwd: dir,
      // own process group, so SIGINT reaches the foreground job like Ctrl+C
      detached: !isWin,
      env: {
        ...process.env,
        TERM: "xterm-256color",
        // no tty, so tools suppress color unless forced
        FORCE_COLOR: "1",
        CLICOLOR_FORCE: "1",
        // and never block waiting on a pager
        PAGER: "cat",
        GIT_PAGER: "cat",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const key = `${projectId}:${termId}`;
    const sess: TermSession = { child, projectId, termId, buf: "", cwd: dir, sent: 0 };
    this.termSessions.set(key, sess);
    // Ctrl+C signals the whole process group. A non-interactive shell dies on
    // SIGINT by default, taking the session with it — installing a no-op
    // handler keeps the shell alive. Children reset handled signals to their
    // default on exec, so the foreground job still dies, as in a real terminal.
    if (!isWin) child.stdin?.write("trap ':' INT\n");
    const onData = (b: Buffer) => this.pumpTerm(sess, b.toString("utf8"));
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.on("error", (err) => {
      this.broadcastTerm(projectId, { type: "term", term: termId, chunk: `loom: ${err.message}\n` });
    });
    child.on("close", () => {
      this.termSessions.delete(key);
      this.broadcastTerm(projectId, { type: "term", term: termId, closed: true });
    });
    return sess;
  }

  /**
   * Scan shell output for the end-of-command sentinel, stripping it from the
   * stream and turning it into an exit/cwd frame. A sentinel can straddle two
   * chunks, so any trailing partial match is held back until the next read.
   */
  private pumpTerm(sess: TermSession, text: string): void {
    sess.buf += text;
    for (;;) {
      const idx = sess.buf.indexOf(TERM_MARK);
      if (idx === -1) break;
      const nl = sess.buf.indexOf("\n", idx);
      if (nl === -1) {
        // sentinel began but isn't complete — emit what precedes it and wait
        this.emitTerm(sess, sess.buf.slice(0, idx));
        sess.buf = sess.buf.slice(idx);
        return;
      }
      this.emitTerm(sess, sess.buf.slice(0, idx));
      const line = sess.buf.slice(idx + TERM_MARK.length, nl);
      const tab = line.indexOf("\t");
      const code = Number(tab === -1 ? line : line.slice(0, tab));
      const cwd = tab === -1 ? "" : line.slice(tab + 1).trim();
      if (cwd) sess.cwd = cwd;
      sess.buf = sess.buf.slice(nl + 1);
      this.broadcastTerm(sess.projectId, {
        type: "term",
        term: sess.termId,
        exit: Number.isFinite(code) ? code : 0,
        cwd: sess.cwd,
      });
    }
    let hold = 0;
    for (let i = Math.min(TERM_MARK.length - 1, sess.buf.length); i > 0; i--) {
      if (sess.buf.endsWith(TERM_MARK.slice(0, i))) {
        hold = i;
        break;
      }
    }
    const emit = sess.buf.slice(0, sess.buf.length - hold);
    sess.buf = sess.buf.slice(sess.buf.length - hold);
    this.emitTerm(sess, emit);
  }

  private emitTerm(sess: TermSession, chunk: string): void {
    if (!chunk) return;
    const MAX = 2_000_000; // per-command output budget
    if (sess.sent >= MAX) return;
    let out = chunk;
    if (sess.sent + out.length > MAX) {
      out = out.slice(0, MAX - sess.sent) + "\n…output truncated…\n";
    }
    sess.sent += out.length;
    this.broadcastTerm(sess.projectId, { type: "term", term: sess.termId, chunk: out });
  }

  private closeTermSession(key: string): void {
    const sess = this.termSessions.get(key);
    if (!sess) return;
    this.termSessions.delete(key);
    try {
      if (sess.child.pid && process.platform !== "win32") process.kill(-sess.child.pid, "SIGKILL");
      else sess.child.kill("SIGKILL");
    } catch {
      /* already gone */
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
      ws.send(JSON.stringify({ type: "hello", projects: listProjects().map((p) => p.id) }));
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
    for (const key of [...this.termSessions.keys()]) this.closeTermSession(key);
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
