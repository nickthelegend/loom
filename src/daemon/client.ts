/**
 * Thin daemon client used by every surface (CLI now, app later).
 * Also owns daemon lifecycle: autostart-on-demand, health, shutdown.
 */

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import type { LoomEvent, ProjectStatus } from "../types.js";
import {
  readDaemonConfig,
  type DaemonConfig,
} from "../core/registry.js";
import { DEFAULT_PORT } from "./server.js";

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

  project(id: string): Promise<{ project: ProjectStatus }> {
    return this.request("GET", `/api/projects/${encodeURIComponent(id)}`);
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

  interrupt(id: string): Promise<{ interrupted: string | null }> {
    return this.request("POST", `/api/projects/${encodeURIComponent(id)}/interrupt`, {});
  }

  decision(id: string, text: string): Promise<{ event: LoomEvent }> {
    return this.request("POST", `/api/projects/${encodeURIComponent(id)}/decisions`, { text });
  }

  newPairingToken(): Promise<{ token: string; expiresAt: number; url: string }> {
    return this.request("POST", "/api/pair/new", {});
  }

  pairedClients(): Promise<{ clients: Array<{ id: string; name: string; createdAt: number }> }> {
    return this.request("GET", "/api/pair/clients");
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

async function healthy(cfg: DaemonConfig): Promise<boolean> {
  try {
    const res = await fetch(`http://${cfg.host}:${cfg.port}/api/health`, {
      signal: AbortSignal.timeout(1500),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Get a client for a running daemon, starting one (detached) if needed.
 * The daemon entry is this same CLI with the `daemon` subcommand.
 */
export async function ensureDaemon(): Promise<DaemonClient> {
  let cfg = readDaemonConfig();
  if (cfg && (await healthy(cfg))) return new DaemonClient(cfg);

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
