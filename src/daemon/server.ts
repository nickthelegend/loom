/**
 * The Loom daemon — one process, many projects, one API for every surface
 * (CLI today, iOS app next). REST for commands, WebSocket for the live
 * event stream.
 */

import { execFile } from "node:child_process";
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
import { AuthManager, bearerToken } from "./auth.js";
import { ProjectRuntime } from "./runtime.js";

export interface DaemonOptions {
  host?: string;
  port?: number;
  /** Bind to the Tailscale interface instead of localhost. */
  tailnet?: boolean;
}

export const DEFAULT_PORT = 7420;

/**
 * Build fingerprint — the mtime of this compiled module. A daemon started
 * from an older build reports an older rev than a freshly built CLI expects,
 * and the CLI restarts it automatically ("failed to fetch" after upgrades
 * usually meant a stale daemon serving yesterday's code).
 */
export const BUILD_REV = (() => {
  try {
    return String(Math.floor(fs.statSync(fileURLToPath(import.meta.url)).mtimeMs));
  } catch {
    return "dev";
  }
})();

export class LoomDaemon {
  private app = express();
  private server: Server | null = null;
  private wss: WebSocketServer | null = null;
  private auth: AuthManager;
  private runtimes = new Map<string, ProjectRuntime>();
  private sockets = new Map<WebSocket, { project?: string }>();
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
      res.type("html").send(APP_HTML);
    });
    app.get("/app/manifest.webmanifest", (_req, res) => {
      res.type("application/manifest+json").send(JSON.stringify(APP_MANIFEST));
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
          spec?: string | string[];
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

    app.delete(
      "/api/projects/:id/route",
      withRuntime(async (rt, _req, res) => {
        res.json({ route: await rt.abortRoute() });
      }),
    );
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
