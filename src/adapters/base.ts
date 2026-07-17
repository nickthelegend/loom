/**
 * Shared adapter plumbing: event fan-out, busy tracking, memory-file
 * persistence, and small process/http helpers used by concrete adapters.
 */

import { spawn } from "node:child_process";
import net from "node:net";
import type {
  Adapter,
  AdapterEvent,
  AgentCapabilities,
  Bridge,
  SendInput,
} from "../types.js";
import { writeMemoryFile } from "../core/registry.js";

type EventCb = (e: AdapterEvent) => void;

export abstract class AgentBase {
  readonly id: string;
  readonly kind: string;
  protected projectDir: string;
  private listeners = new Set<EventCb>();

  constructor(id: string, kind: string, projectDir: string) {
    this.id = id;
    this.kind = kind;
    this.projectDir = projectDir;
  }

  onEvent(cb: EventCb): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  protected emit(e: AdapterEvent): void {
    for (const cb of this.listeners) {
      try {
        cb(e);
      } catch {
        // A broken subscriber must not break the stream.
      }
    }
  }

  async injectMemory(projection: string): Promise<void> {
    writeMemoryFile(this.projectDir, this.id, projection);
  }
}

export abstract class AdapterBase extends AgentBase implements Adapter {
  readonly capabilities: AgentCapabilities = {
    tier: "adapter",
    send: true,
    stream: true,
    injectMemory: true,
    interrupt: true,
    diff: true,
  };
  protected _busy = false;

  busy(): boolean {
    return this._busy;
  }

  abstract available(): Promise<boolean>;
  abstract start(): Promise<void>;
  abstract stop(): Promise<void>;
  abstract send(input: SendInput): Promise<void>;
  abstract interrupt(): Promise<void>;

  /** Default diff: `git status --porcelain` in the project dir. */
  async diff(): Promise<string> {
    return new Promise((resolve) => {
      const child = spawn("git", ["status", "--porcelain"], { cwd: this.projectDir });
      let out = "";
      child.stdout.on("data", (d: Buffer) => (out += d.toString()));
      child.on("close", () => resolve(out.trim()));
      child.on("error", () => resolve(""));
    });
  }
}

export abstract class BridgeBase extends AgentBase implements Bridge {
  readonly capabilities: AgentCapabilities = {
    tier: "bridge",
    send: false,
    stream: true,
    injectMemory: true,
    interrupt: false,
    diff: false,
  };

  abstract available(): Promise<boolean>;
  abstract start(): Promise<void>;
  abstract stop(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Wrap a handoff briefing so a CLI with no system channel still treats it as
 * authoritative.
 *
 * The claude adapter passes the briefing through `--append-system-prompt`, and
 * grok through `--rules` — both real system channels. Codex and opencode have
 * no per-turn system field, so the same briefing rides in the prompt. Framed
 * loosely ("here's some context") a model skims past it; framed as a delimited,
 * imperative directive block it doesn't. The pointer to the full `.loom/memory`
 * file is preserved from the briefing itself, so the agent can pull detail on
 * demand rather than being handed the whole store.
 */
export function frameBriefing(briefing: string): string {
  const b = briefing.trim();
  if (!b) return "";
  return [
    "===== LOOM SESSION MEMORY — read this first; it is authoritative =====",
    "You are continuing shared work handed to you through Loom. The context",
    "below carries over from the previous agent(s): decisions, conventions and",
    "constraints already settled for this project. Treat it as ground truth and",
    "honor it — do not re-open settled choices. Where it points to a",
    ".loom/memory file, read that file if you need the detail.",
    "",
    b,
    "===== end session memory — the user's message follows =====",
  ].join("\n");
}

/**
 * Env for spawning agent CLIs. When Loom itself runs inside a Claude Code
 * session (CLAUDECODE=1), the environment carries session-internal plumbing
 * (CLAUDE_CODE_*, a session-scoped ANTHROPIC_BASE_URL, …) that breaks nested
 * agent spawns — strip it so child agents auth like a fresh terminal.
 */
export function agentEnv(): NodeJS.ProcessEnv {
  if (!process.env.CLAUDECODE) return process.env;
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) {
    if (
      key === "CLAUDECODE" ||
      key.startsWith("CLAUDE_CODE_") ||
      key === "CLAUDE_AGENT_SDK_VERSION" ||
      key === "CLAUDE_EFFORT" ||
      key === "ANTHROPIC_BASE_URL" ||
      key === "BAGGAGE" ||
      key === "AI_AGENT"
    ) {
      delete env[key];
    }
  }
  return env;
}

/**
 * Is a CLI on PATH (exit 0 for `--version`)?
 *
 * Bounded: this sits in front of HTTP handlers (Tasks probes `gh` on every
 * request), and a version probe that wedges would otherwise hang that request
 * forever with no response. A CLI that can't say its own version inside the
 * timeout is unavailable as far as callers are concerned.
 */
export function cliAvailable(
  cmd: string,
  args: string[] = ["--version"],
  timeoutMs = 5_000,
): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const child = spawn(cmd, args, { stdio: "ignore" });
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        resolve(false);
      }, timeoutMs);
      timer.unref();
      const done = (v: boolean): void => {
        clearTimeout(timer);
        resolve(v);
      };
      child.on("close", (code) => done(code === 0));
      child.on("error", () => done(false));
    } catch {
      resolve(false);
    }
  });
}

/** Grab an ephemeral free TCP port. */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (addr && typeof addr === "object") {
        const port = addr.port;
        srv.close(() => resolve(port));
      } else {
        srv.close(() => reject(new Error("no port")));
      }
    });
    srv.on("error", reject);
  });
}

export async function waitFor(
  probe: () => Promise<boolean>,
  { timeoutMs = 30_000, intervalMs = 300 } = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await probe().catch(() => false)) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error("timed out waiting for condition");
}

export async function fetchJson<T>(
  url: string,
  init?: RequestInit,
  timeoutMs = 15_000,
): Promise<T> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`${init?.method ?? "GET"} ${url} → ${res.status}: ${body.slice(0, 300)}`);
  }
  return (await res.json()) as T;
}
