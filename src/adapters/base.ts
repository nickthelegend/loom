/**
 * Shared adapter plumbing: event fan-out, busy tracking, memory-file
 * persistence, and small process/http helpers used by concrete adapters.
 */

import { type ChildProcess } from "node:child_process";
import { spawn } from "../core/process.js";
import { quiesceWindowsJob } from "../core/windows-jobs.js";
import net from "node:net";
import type {
  Adapter,
  AdapterEvent,
  AgentCapabilities,
  Bridge,
  SendInput,
  StreamDelta,
} from "../types.js";
import { writeMemoryFile } from "../core/registry.js";

import { NativeQuiescenceUnknown } from "../core/continuity/contracts.js";
import { AgentStateStore } from "../core/agent-state.js";

type EventCb = (e: AdapterEvent) => void;
type StreamCb = (d: StreamDelta) => void;

export abstract class AgentBase {
  readonly id: string;
  readonly kind: string;
  protected projectDir: string;
  protected readonly nativeState: AgentStateStore;
  private listeners = new Set<EventCb>();
  private streamers = new Set<StreamCb>();

  constructor(id: string, kind: string, projectDir: string) {
    this.id = id;
    this.kind = kind;
    this.projectDir = projectDir;
    this.nativeState = new AgentStateStore(projectDir, id);
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

  onStream(cb: StreamCb): () => void {
    this.streamers.add(cb);
    return () => this.streamers.delete(cb);
  }

  /**
   * Part of a reply, as it arrives. Not an event: nothing is logged, and the
   * finished `message` the adapter emits afterwards is what the thread keeps.
   */
  protected streamText(text: string, reasoning = false): void {
    if (!text) return;
    const d: StreamDelta = reasoning ? { text, reasoning: true } : { text };
    for (const cb of this.streamers) {
      try {
        cb(d);
      } catch {
        // A broken viewer must not break the turn.
      }
    }
  }

  async injectMemory(projection: string): Promise<void> {
    writeMemoryFile(this.projectDir, this.id, projection);
  }
}

/**
 * What an adapter can do before it says otherwise. Exported so an adapter that
 * differs in one respect can spread this and change that one thing, instead of
 * restating the whole set and drifting from it.
 */
export const ADAPTER_CAPABILITIES: AgentCapabilities = {
  tier: "adapter",
  // Off unless an adapter's CLI really takes MCP config — see AgentCapabilities.
  mcp: false,
};

/** One line of an agent's self-check: what was asked, and what came back. */
export interface AgentCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export abstract class AdapterBase extends AgentBase implements Adapter {
  readonly capabilities: AgentCapabilities = { ...ADAPTER_CAPABILITIES };
  protected _busy = false;
  protected continuityTurn: SendInput["continuity"];

  protected beginContinuity(input: SendInput): void {
    this.continuityTurn = input.continuity ? { ...input.continuity } : undefined;
  }
  protected endContinuity(): void { this.continuityTurn = undefined; }
  protected override emit(event: AdapterEvent): void {
    const turn = this.continuityTurn;
    super.emit(turn ? { ...event, payload: { ...event.payload, loomRunId: turn.runId,
      loomBindingId: turn.bindingId, loomSessionEpoch: turn.sessionEpoch } } : event);
  }

  busy(): boolean {
    return this._busy;
  }

  /**
   * Is this agent ready to take a turn? Only the questions that cost nothing:
   * is it installed, is it signed in, does the provider list the model. It
   * never sends a prompt — a test that spends quota to say "yes" is one
   * nobody runs twice. Adapters with more to say override it.
   */
  async selfCheck(): Promise<AgentCheck[]> {
    const ok = await this.available();
    return [{ name: "installed", ok, detail: ok ? "found, and it answers" : "not found on this machine — install it, or set its path" }];
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

/** Bound a native JSONL record before readline accumulates an arbitrary tool
 * output. The guard stores only a byte count, never a second copy of the data. */
export function guardNativeOutput(child: ChildProcess, fail: (error: Error) => void): void {
  let bytes = 0, failed = false;
  const guard = (chunk: Buffer | string) => {
    if (failed) return;
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    let start = 0;
    while (start < data.length) {
      const newline = data.indexOf(10, start), end = newline < 0 ? data.length : newline;
      bytes += end - start;
      if (bytes > 32_000_000) {
        failed = true; fail(new Error("native JSONL record exceeds 32 MB; oversized partial output was not imported")); return;
      }
      if (newline < 0) break;
      bytes = 0; start = newline + 1;
    }
  };
  child.stdout?.prependListener("data", guard);
  child.once("close", () => child.stdout?.off("data", guard));
}

/** Starts inherited-child cleanup at parent exit and bounds inherited pipe drain.
 * The returned close command must settle before emitting terminal native events. */
export function trackNativeExit(child: ChildProcess, fail: (error: Error) => void): () => Promise<void> {
  let group: Promise<void> | undefined, deadline: NodeJS.Timeout | undefined;
  child.once("exit", () => {
    if (!child.pid) return;
    group = quiesceProcessGroup(child);
    void group.catch(() => {});
    deadline = setTimeout(() => fail(new NativeQuiescenceUnknown("native parent exited but tool streams did not close; inspect descendants")), 6500);
  });
  return async () => {
    clearTimeout(deadline);
    if (child.pid) await (group ?? quiesceProcessGroup(child));
  };
}

/** SIGKILL submission is not proof of quiescence. Wait for process close and
 * propagate a timeout so a successor cannot acquire the same working tree. */
export async function interruptProcess(child: ChildProcess, processGroup = false): Promise<void> {
  if (process.platform === "win32" && processGroup) {
    const closed = child.exitCode !== null || child.signalCode !== null ? Promise.resolve()
      : new Promise<void>(resolve => child.once("close", () => resolve()));
    await quiesceWindowsJob(child);
    await Promise.race([closed, new Promise<void>((_, reject) => setTimeout(() => reject(new NativeQuiescenceUnknown("Windows native process streams did not close")), 6000).unref())]);
    return;
  }
  if (child.exitCode !== null || child.signalCode !== null) {
    if (processGroup && child.pid) await quiesceProcessGroup(child);
    return;
  }
  await new Promise<void>((resolve, reject) => {
    let force: NodeJS.Timeout, deadline: NodeJS.Timeout;
    const cleanup = () => { clearTimeout(force); clearTimeout(deadline); child.off("close", closed); };
    const closed = () => { cleanup(); if (processGroup && child.pid) void quiesceProcessGroup(child).then(resolve, reject); else resolve(); };
    child.once("close", closed);
    const signal = (value: NodeJS.Signals) => { if (processGroup && child.pid) { try { process.kill(-child.pid, value); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; } } else child.kill(value); };
    force = setTimeout(() => { try { signal("SIGKILL"); } catch (error) { cleanup(); reject(error); } }, 3000);
    deadline = setTimeout(() => { cleanup(); reject(new NativeQuiescenceUnknown("native process did not close after interruption; quiescence unknown")); }, 6000);
    try { signal("SIGINT"); } catch (error) { cleanup(); reject(error); }
  });
}

/** Native POSIX launches own a process group so inherited tool children cannot
 * keep editing after their parent reports completion. Escaped/detached children
 * are outside this POSIX guarantee. Windows verifies the owned Job Object. */
export async function quiesceProcessGroup(target: number | ChildProcess): Promise<void> {
  if (process.platform === "win32") {
    if (typeof target === "number") throw new NativeQuiescenceUnknown("a PID alone cannot prove Windows Job Object ownership");
    return quiesceWindowsJob(target);
  }
  const pid = typeof target === "number" ? target : target.pid;
  if (!pid) throw new NativeQuiescenceUnknown("native process has no PID");
  const alive = () => {
    try { process.kill(-pid, 0); return true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return false; throw new NativeQuiescenceUnknown(`cannot inspect native process group ${pid}; quiescence unknown`); }
  };
  if (!alive()) return;
  const signal = (value: NodeJS.Signals) => {
    try { process.kill(-pid, value); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw new NativeQuiescenceUnknown(`cannot terminate native process group ${pid}; quiescence unknown`); }
  };
  signal("SIGINT");
  const began = Date.now(); let forced = false;
  while (alive()) {
    if (Date.now() - began >= 6000) throw new NativeQuiescenceUnknown(`native process group ${pid} did not terminate; inspect descendants before reconciliation`);
    if (!forced && Date.now() - began >= 3000) { signal("SIGKILL"); forced = true; }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

export abstract class BridgeBase extends AgentBase implements Bridge {
  readonly capabilities: AgentCapabilities = {
    tier: "bridge",
    // A bridge drives someone else's GUI; there is no command line to put a
    // config on, and whatever MCP servers that app has are its own.
    mcp: false,
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

/** A CLI's exit code and output (stdout, then stderr), or null when it couldn't be run. Bounded like cliAvailable. */
export function cliOutput(cmd: string, args: string[], timeoutMs = 8_000): Promise<{ code: number | null; out: string } | null> {
  return new Promise((resolve) => {
    try {
      const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, NO_COLOR: "1" } });
      let out = "";
      let err = "";
      child.stdout?.on("data", (d: Buffer) => { if (out.length < 20_000) out += d.toString(); });
      child.stderr?.on("data", (d: Buffer) => { if (err.length < 20_000) err += d.toString(); });
      const timer = setTimeout(() => { child.kill("SIGKILL"); resolve(null); }, timeoutMs);
      timer.unref();
      child.on("close", (code) => { clearTimeout(timer); resolve({ code, out: stripAnsi(out.trim() ? out : err) }); });
      child.on("error", () => { clearTimeout(timer); resolve(null); });
    } catch {
      resolve(null);
    }
  });
}

export function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "");
}

export const firstLine = (s: string): string => (s.split("\n").map((l) => l.trim()).find(Boolean) ?? "").slice(0, 160);

/**
 * Is a CLI on PATH (exit 0 for `--version`)?
 *
 * Bounded: this sits in front of HTTP handlers (Tasks probes `gh` on every
 * request), and a version probe that wedges would otherwise hang that request
 * forever with no response. A CLI that can't say its own version inside the
 * timeout is unavailable as far as callers are concerned.
 */
/**
 * A remembered yes/no probe. Status is asked for constantly (every project's,
 * by every open window and the desktop pet), and each ask probed every agent
 * afresh — a `--version` process per CLI agent, a full model list per model
 * agent. A yes is trusted for a minute and a no for 15 s (so a fresh install
 * shows up quickly); callers asking at once share the probe in flight.
 */
const probes = new Map<string, { at: number; value: boolean; pending?: Promise<boolean> }>();
export function rememberedProbe(key: string, probe: () => Promise<boolean>, ttl = { yes: 60_000, no: 15_000 }): Promise<boolean> {
  const hit = probes.get(key);
  if (hit?.pending) return hit.pending;
  if (hit && Date.now() - hit.at < (hit.value ? ttl.yes : ttl.no)) return Promise.resolve(hit.value);
  const pending = probe().catch(() => false).then((value) => {
    probes.set(key, { at: Date.now(), value });
    if (probes.size > 256) probes.delete(probes.keys().next().value!);
    return value;
  });
  probes.set(key, { at: hit?.at ?? 0, value: hit?.value ?? false, pending });
  return pending;
}
/** Forget remembered probes (a key, or all): after installing or signing in, ask afresh. */
export function forgetProbes(key?: string): void {
  if (key === undefined) probes.clear();
  else probes.delete(key);
}

export function cliAvailable(
  cmd: string,
  args: string[] = ["--version"],
  // Windows npm launchers may load a native binary through Node first; a cold
  // OpenCode version probe takes over six seconds on an otherwise usable disk.
  timeoutMs = process.platform === "win32" ? 15_000 : 5_000,
): Promise<boolean> {
  return rememberedProbe(`cli\0${cmd}\0${args.join("\0")}`, () => spawnProbe(cmd, args, timeoutMs));
}

function spawnProbe(cmd: string, args: string[], timeoutMs: number): Promise<boolean> {
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
