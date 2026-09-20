/**
 * The project's dev servers: what they are, and what they're doing.
 *
 * Loom's Browser tab used to ask you for a URL and hope something answered.
 * The daemon can run the thing instead — and then the state it shows is a
 * fact, not a guess: a process that exists, a port that answers, an exit code
 * when it stops.
 *
 * Four states, and the difference between them matters:
 *   stopped   nothing running
 *   starting  the process is up, the port isn't answering yet
 *   running   the port answers
 *   crashed   it exited on its own, with the code it exited with
 *
 * This module is the supervision and the state. Routes, the socket and the UI
 * are elsewhere; nothing here starts anything by itself.
 */

import { type ChildProcess, spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";

export interface ServerConfig {
  /** Short, stable id — what `loom servers start <name>` takes. */
  name: string;
  /** The command line, run through the user's shell so `npm run dev` works. */
  command: string;
  /** Relative to the project, when the server doesn't live at its root. */
  cwd?: string;
  port?: number;
  /** Where to point the preview, when it isn't http://localhost:<port>. */
  url?: string;
  env?: Record<string, string>;
}

export type ServerState = "stopped" | "starting" | "running" | "crashed";

export interface ServerStatus extends ServerConfig {
  state: ServerState;
  pid: number | null;
  startedAt: number | null;
  /** Set when it exited on its own. */
  exitCode: number | null;
  /** Its last lines, newest last — the same buffer the log pane reads. */
  lines: number;
}

/** How much of each server's output is kept in memory. */
export const LOG_LINES = 2000;
/** How often a starting server's port is retried before it's called running. */
export const PORT_POLL_MS = 400;

export interface LogLine {
  at: number;
  stream: "out" | "err" | "loom";
  text: string;
}

/** Is something listening on this port? The only honest test of "running". */
export function portListening(port: number, host = "127.0.0.1", timeoutMs = 500): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    const done = (answer: boolean) => {
      socket.destroy();
      resolve(answer);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
    socket.connect(port, host);
  });
}

/**
 * Servers suggested by a project's package.json — a starting point a person
 * confirms, never something that runs on its own.
 *
 * Only the scripts that are obviously servers, and only a port when the script
 * says one: inventing a port produces a preview pointing at nothing.
 */
export function suggestServers(projectDir: string): ServerConfig[] {
  let scripts: Record<string, string> = {};
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(projectDir, "package.json"), "utf8")) as { scripts?: Record<string, string> };
    scripts = pkg.scripts ?? {};
  } catch {
    return [];
  }
  const interesting = ["dev", "start", "serve", "preview", "storybook"];
  const out: ServerConfig[] = [];
  for (const name of interesting) {
    const script = scripts[name];
    if (!script) continue;
    const port = portFromScript(script);
    out.push({ name, command: `npm run ${name}`, ...(port ? { port } : {}) });
  }
  return out;
}

/** A port a script names explicitly (`--port 3000`, `-p 8080`, `PORT=5173`). */
export function portFromScript(script: string): number | undefined {
  const m =
    /(?:--port[= ]|(?:^|\s)-p[= ])(\d{2,5})/.exec(script) ??
    /(?:^|\s)PORT=(\d{2,5})/.exec(script);
  const port = m ? Number(m[1]) : NaN;
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : undefined;
}

/** Where the preview should point for a configured server. */
export function urlFor(cfg: ServerConfig): string | null {
  if (cfg.url) return cfg.url;
  return cfg.port ? `http://localhost:${cfg.port}` : null;
}

interface Running {
  child: ChildProcess;
  startedAt: number;
  /** Cleared when the port answers, so "starting" can't last for ever silently. */
  poll: ReturnType<typeof setInterval> | null;
}

/**
 * Runs a project's servers. One instance per project runtime.
 *
 * Every transition is announced through `onChange` (the socket carries it) and
 * every line through `onLine` (the log pane, and the agents that ask for it).
 */
export class Servers {
  private live = new Map<string, Running>();
  private logs = new Map<string, LogLine[]>();
  private state = new Map<string, { state: ServerState; exitCode: number | null }>();

  constructor(
    private deps: {
      projectDir: string;
      configs: () => ServerConfig[];
      onChange: (name: string, status: ServerStatus) => void;
      onLine: (name: string, line: LogLine) => void;
      /** Tests inject a fake; production spawns a real shell. */
      spawnImpl?: typeof spawn;
    },
  ) {}

  list(): ServerStatus[] {
    return this.deps.configs().map((cfg) => this.status(cfg));
  }

  status(cfg: ServerConfig): ServerStatus {
    const run = this.live.get(cfg.name);
    const known = this.state.get(cfg.name);
    return {
      ...cfg,
      state: run ? known?.state ?? "starting" : known?.state ?? "stopped",
      pid: run?.child.pid ?? null,
      startedAt: run?.startedAt ?? null,
      exitCode: known?.exitCode ?? null,
      lines: this.logs.get(cfg.name)?.length ?? 0,
    };
  }

  mustConfig(name: string): ServerConfig {
    const cfg = this.deps.configs().find((s) => s.name === name);
    if (!cfg) throw new Error(`no server "${name}" in this project — add it to .loom/config.json`);
    return cfg;
  }

  log(name: string, limit = LOG_LINES): LogLine[] {
    const all = this.logs.get(name) ?? [];
    return all.slice(-limit);
  }

  /** Start it, unless it's already up. Returns as soon as the process exists. */
  async start(name: string): Promise<ServerStatus> {
    const cfg = this.mustConfig(name);
    if (this.live.has(name)) return this.status(cfg);
    const cwd = cfg.cwd ? path.resolve(this.deps.projectDir, cfg.cwd) : this.deps.projectDir;
    const spawnImpl = this.deps.spawnImpl ?? spawn;
    const child = spawnImpl(cfg.command, {
      cwd,
      shell: true, // `npm run dev` is a command line, not an argv
      // Its own process group, so stopping it stops what it started: the shell
      // is the parent, and killing only the shell leaves the real server
      // holding the port. (Windows has no groups; there the child is killed
      // directly and its tree is the OS's business.)
      detached: process.platform !== "win32",
      env: { ...process.env, ...(cfg.env ?? {}), FORCE_COLOR: "0" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const run: Running = { child, startedAt: Date.now(), poll: null };
    this.live.set(name, run);
    this.setState(cfg, "starting", null);
    this.append(name, { at: Date.now(), stream: "loom", text: `$ ${cfg.command}` });

    child.stdout?.on("data", (d: Buffer) => this.ingest(name, "out", d));
    child.stderr?.on("data", (d: Buffer) => this.ingest(name, "err", d));
    child.on("exit", (code, signal) => {
      if (run.poll) clearInterval(run.poll);
      this.live.delete(name);
      // A server we stopped is stopped; one that went on its own has crashed,
      // and the exit code is the most useful thing we can say about it.
      const asked = this.stopping.delete(name);
      const exitCode = code ?? null;
      this.append(name, {
        at: Date.now(),
        stream: "loom",
        text: asked ? "stopped" : `exited with ${signal ? `signal ${signal}` : `code ${exitCode ?? "?"}`}`,
      });
      this.setState(cfg, asked ? "stopped" : "crashed", exitCode);
    });
    child.on("error", (err) => {
      this.append(name, { at: Date.now(), stream: "loom", text: `could not start: ${err.message}` });
    });

    // "running" means the port answers. Without a port we can only say the
    // process is up, so it stays "starting" until it isn't — and says so.
    if (cfg.port) {
      run.poll = setInterval(() => {
        void portListening(cfg.port!).then((up) => {
          if (!up || !this.live.has(name)) return;
          if (run.poll) clearInterval(run.poll);
          run.poll = null;
          this.setState(cfg, "running", null);
        });
      }, PORT_POLL_MS);
      run.poll.unref?.();
    } else {
      this.setState(cfg, "running", null);
    }
    return this.status(cfg);
  }

  private stopping = new Set<string>();

  /** Ask it to stop, then insist. Resolves when the process is gone. */
  async stop(name: string, { timeoutMs = 8000 } = {}): Promise<ServerStatus> {
    const cfg = this.mustConfig(name);
    const run = this.live.get(name);
    if (!run) return this.status(cfg);
    this.stopping.add(name);
    const gone = new Promise<void>((resolve) => run.child.once("exit", () => resolve()));
    try {
      // The whole group: `npm run dev` spawns the server that holds the port.
      if (run.child.pid && process.platform !== "win32") process.kill(-run.child.pid, "SIGTERM");
      else run.child.kill("SIGTERM");
    } catch {
      run.child.kill("SIGTERM");
    }
    const hard = setTimeout(() => {
      try {
        if (run.child.pid && process.platform !== "win32") process.kill(-run.child.pid, "SIGKILL");
        else run.child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    }, timeoutMs);
    await gone;
    clearTimeout(hard);
    return this.status(cfg);
  }

  async restart(name: string): Promise<ServerStatus> {
    await this.stop(name);
    return this.start(name);
  }

  /** Everything down — the daemon is going, and orphans listen on ports for ever. */
  async closeAll(): Promise<void> {
    await Promise.all([...this.live.keys()].map((name) => this.stop(name, { timeoutMs: 3000 }).catch(() => {})));
  }

  private ingest(name: string, stream: "out" | "err", chunk: Buffer): void {
    for (const text of String(chunk).split("\n")) {
      if (!text.trim()) continue;
      this.append(name, { at: Date.now(), stream, text: text.replace(/\r$/, "") });
    }
  }

  private append(name: string, line: LogLine): void {
    const buf = this.logs.get(name) ?? [];
    buf.push(line);
    if (buf.length > LOG_LINES) buf.splice(0, buf.length - LOG_LINES);
    this.logs.set(name, buf);
    this.deps.onLine(name, line);
  }

  private setState(cfg: ServerConfig, state: ServerState, exitCode: number | null): void {
    const prev = this.state.get(cfg.name);
    if (prev?.state === state && prev.exitCode === exitCode) return;
    this.state.set(cfg.name, { state, exitCode });
    this.deps.onChange(cfg.name, this.status(cfg));
  }
}
