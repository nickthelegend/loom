import { randomBytes } from "node:crypto";
/**
 * OpenCode adapter — manages an `opencode serve` process per project and
 * speaks its HTTP + SSE API.
 *
 *   create session : POST /api/session            → { data: { id: "ses…" } }
 *   send prompt    : POST /api/session/:id/prompt { prompt: { text } }
 *   wait for idle  : POST /api/session/:id/wait
 *   interrupt      : POST /api/session/:id/interrupt
 *   live events    : GET  /event   (SSE)
 *
 * Surface verified against opencode 1.17.20 — see docs/integration-notes.md.
 *
 * Native continuity (see core/continuity): a continuity turn runs on the
 * session its binding names, or a new one it reports as `turn_started`; a
 * bound session the server no longer has is NativeSessionMissing, before
 * anything is sent. The prompt's admission is the acceptance evidence
 * (`native_turn_accepted`), and the turn is over — and quiescent — when
 * `/api/session/active` no longer lists the session. Verified against
 * opencode 1.18.31 (`/api/session/{id}/model` switches the model in place,
 * `session.next.compaction.*` reports compaction).
 */

import { attachedImages } from "../providers/attachments.js";
import { type ChildProcess } from "node:child_process";
import { execFile, spawnContained, stopWindowsTree, stopWindowsPid } from "../core/process.js";
import { windowsJobReady } from "../core/windows-jobs.js";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { SendInput } from "../types.js";
import { readProjectState, writeProjectState } from "../core/registry.js";
import { AdapterBase, agentEnv, cliAvailable, cliOutput, fetchJson, firstLine, frameBriefing, freePort, interruptProcess, waitFor, type AgentCheck } from "./base.js";
import { requestApproval } from "../core/approvals.js";
import { logbook } from "../core/logbook.js";
import { permissionFor } from "../core/permissions.js";
import { NativeDispatchRejected, NativeQuiescenceUnknown, NativeSessionMissing } from "../core/continuity/contracts.js";

interface OpenCodeOptions {
  /** Reuse an already-running server instead of spawning one. */
  baseUrl?: string;
  /** Extra args for `opencode serve`. */
  extraArgs?: string[];
  /**
   * Model for this project's session, as "providerID/modelID"
   * (e.g. "opencode/minimax-m2.5"). Without it, opencode's own default
   * applies — which may differ from your TUI default and may not work
   * headless (learned the hard way).
   */
  model?: string;
  /** opencode agent to use (e.g. "build"). */
  agent?: string;
  /**
   * Minutes of no turns before Loom stops the `opencode serve` it started
   * (default 30, like the Codex/Claude session reaper; 0 keeps it up). The
   * next turn starts a fresh server, and the session resumes from opencode's
   * own store — so an idle project doesn't hold a server's memory all day.
   */
  idleMinutes?: number;
}

/** OPENCODE_IDLE_MS overrides it (tests); otherwise the agent's idleMinutes, else 30 minutes. */
function idleMsFor(options: OpenCodeOptions): number {
  const env = Number(process.env.LOOM_OPENCODE_IDLE_MS);
  if (Number.isFinite(env) && env >= 0 && process.env.LOOM_OPENCODE_IDLE_MS !== undefined) return env;
  const minutes = typeof options.idleMinutes === "number" && options.idleMinutes >= 0 ? options.idleMinutes : 30;
  return minutes * 60_000;
}

type Json = Record<string, unknown>;

/** "providerID/modelID" → ModelRef body for session create ({providerID, id}). */
export function parseModelRef(model: string): { providerID: string; id: string } | null {
  const idx = model.indexOf("/");
  if (idx <= 0 || idx === model.length - 1) return null;
  return { providerID: model.slice(0, idx), id: model.slice(idx + 1) };
}

/** Errors that come from something already in the session's history, not from this turn. */
const POISONED_HISTORY = /media must contain valid base64|invalid (?:image|base64)|could not process image|image (?:is )?(?:too large|not supported)/i;

function turnError(error: Json): string {
  return String(error.message ?? (error.data as Json | undefined)?.message ?? "opencode turn failed").slice(0, 500);
}

/** The prompt body, with attached pictures as file attachments so OpenCode sees them, not just their path. */
function promptWithFiles(text: string, dir: string): { text: string; files?: Array<{ uri: string; name: string }> } {
  // inline as a data URL: a file:// URL to a folder with a space in it ("Extreme SSD") reached the model as empty media
  const files = attachedImages(text, dir).map((im) => ({ uri: `data:${im.mime};base64,${fs.readFileSync(im.abs).toString("base64")}`, name: path.basename(im.rel) }));
  return files.length ? { text, files } : { text };
}

/** A turn's tokens for run_complete: totals, plus the cached and reasoning shares when there are any. */
function usagePayload(u: { input: number; output: number; cached: number; reasoning: number }): Record<string, number> {
  return {
    inputTokens: u.input,
    outputTokens: u.output,
    ...(u.cached ? { cachedInputTokens: u.cached } : {}),
    ...(u.reasoning ? { reasoningTokens: u.reasoning } : {}),
  };
}

/**
 * The model to use when the project pins none: opencode's free house model if
 * the server offers it, else any free opencode-hosted model, else nothing
 * (opencode's own default — the old behaviour).
 */
export function pickDefaultModel(ids: string[]): string | undefined {
  if (ids.includes("opencode/big-pickle")) return "opencode/big-pickle";
  return ids.find((id) => id.startsWith("opencode/") && id.endsWith("-free"));
}

/**
 * Permissions (core/permissions.ts) for the spawned server, via opencode's
 * inline-config variable — the user's own opencode.json is never touched.
 */
export function opencodePermissionEnv(options: object): Record<string, string> {
  // Only bypass changes anything. "ask" is refused for opencode upstream (see
  // core/permissions.ts): its headless session API ignored a deny-everything
  // config and the read-only `plan` agent alike — a file write went through
  // both (verified on opencode 1.18.31) — so a read-only switch here would lie.
  if (permissionFor("opencode", options as Record<string, unknown>) !== "bypass") return {};
  return {
    OPENCODE_CONFIG_CONTENT: JSON.stringify({
      permission: { edit: "allow", bash: "allow", webfetch: "allow", external_directory: "allow" },
    }),
  };
}

export class OpenCodeAdapter extends AdapterBase {
  /**
   * The Authorization header for this agent's opencode server. With OPENCODE_SERVER_PASSWORD
   * in the environment, opencode serve answers 401 to anything without it — Loom's own probes
   * included, so the server never looked ready ("timed out waiting for condition"). A server
   * Loom starts gets a password of its own; one you run (baseUrl) uses yours.
   */
  private auth: string | null = null;
  private withAuth(init?: RequestInit): RequestInit | undefined {
    if (!this.auth) return init;
    const headers = new Headers(init?.headers);
    headers.set("authorization", this.auth);
    return { ...init, headers };
  }
  private http(url: string, init?: RequestInit): Promise<Response> {
    return fetch(url, this.withAuth(init));
  }
  private json<T>(url: string, init?: RequestInit, timeoutMs?: number): Promise<T> {
    return fetchJson<T>(url, this.withAuth(init), timeoutMs);
  }

  private child: ChildProcess | null = null;
  private baseUrl: string | null = null;
  private sseAbort: AbortController | null = null;
  private options: OpenCodeOptions;
  private started = false;
  /** npm builds expose /session + /global/health; newer builds use /api. */
  private modernApi = false;
  /**
   * Before a turn: whatever a previous turn left in flight (an interrupted
   * reply's parts, a prompt's echo) is never coming back, and the dedupe sets
   * only need recent ids — so they're trimmed, not kept for the agent's life.
   */
  private trimTurnState(): void {
    this.textParts.clear();
    this.reasoningParts.clear();
    const keep = <T>(set: Set<T> | Map<T, unknown>, max = 500) => {
      if (set.size <= max) return;
      let drop = set.size - max;
      for (const k of set.keys()) { if (drop-- <= 0) break; set.delete(k); }
    };
    keep(this.roles); keep(this.emittedText); keep(this.toolsDone);
  }

  /** Stops an idle server Loom started (see idleMinutes). */
  private idleTimer: ReturnType<typeof setTimeout> | null = null;

  private cancelIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  /**
   * After a turn: stop the server we spawned once nothing has used it for a
   * while. Never one we were pointed at (baseUrl), never mid-turn, and never
   * while a question it asked is still waiting for an answer.
   */
  private armIdle(): void {
    this.cancelIdle();
    const ms = idleMsFor(this.options);
    if (!ms || this.options.baseUrl || !this.child) return;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (this._busy || this.questions.size || !this.child || !this.started) return void this.armIdle();
      logbook.info("opencode", `stopping idle opencode serve for "${this.id}" after ${Math.round(ms / 60_000)} min; the next turn restarts it`);
      void this.sleep().catch(() => {});
    }, ms);
    this.idleTimer.unref?.();
  }

  /** Stop the idle server quietly: not a failure, and not the agent stopping. */
  private async sleep(): Promise<void> {
    this.started = false;
    this.sseAbort?.abort();
    this.sseAbort = null;
    const child = this.child;
    this.child = null;
    if (!child) return;
    if (process.platform === "win32") await stopWindowsTree(child);
    else await interruptProcess(child, true);
    this.emit({ kind: "status", payload: { state: "idle_stopped" } });
  }

  private api(route: string): string {
    return `${this.baseUrl}${this.modernApi ? "" : "/api"}${route}`;
  }

  private promptBody(text: string): Json {
    if (!this.modernApi) return { prompt: promptWithFiles(text, this.projectDir) };
    const ref = this.options.model ? parseModelRef(this.options.model) : null;
    return {
      parts: [{ type: "text", text }, ...attachedImages(text, this.projectDir).map(im => ({
        type: "file", mime: im.mime, filename: path.basename(im.abs), url: `data:${im.mime};base64,${fs.readFileSync(im.abs).toString("base64")}`,
      }))],
      ...(ref ? { model: { providerID: ref.providerID, modelID: ref.id } } : {}),
      ...(this.options.agent ? { agent: this.options.agent } : {}),
    };
  }

  private async messageDetail(sid: string, mid: string): Promise<Json | null> {
    const detail = await this.json<Json>(this.api(`/session/${sid}/message/${mid}`)).catch(() => null);
    if (this.modernApi && detail?.info) return { ...(detail.info as Json), content: detail.parts };
    return detail;
  }
  // Token usage from the assistant message, stashed to ride run_complete.
  private lastUsage: { input: number; output: number; cached: number; reasoning: number } | null = null;
  // The provider/model the assistant message actually ran, for the gen_ai span.
  private lastModel: string | null = null;

  /** text parts per in-flight assistant message */
  private textParts = new Map<string, Map<string, string>>();
  private roles = new Map<string, string>();
  /** assistant messages whose text already went to the log (SSE path) */
  private emittedText = new Set<string>();
  /** The session a continuity turn is running on; the agent's own otherwise. */
  private activeSid: string | undefined;
  /** interrupt() was asked for during this turn. */
  private interrupted = false;
  /** Tools opencode started this turn, by call id (1.18 reports name and result separately). */
  private toolCalls = new Map<string, { tool: string; title: string; input?: Json }>();
  /** A compaction was already reported as done (both the step event and the session event can say so). */
  private compactionReported = false;

  constructor(id: string, projectDir: string, options: Record<string, unknown> = {}) {
    super(id, "opencode", projectDir);
    this.options = options as OpenCodeOptions;
  }

  private get sessionId(): string | undefined {
    return this.nativeState.read().sessionId as string | undefined;
  }

  private set sessionId(value: string | undefined) {
    this.nativeState.patch({ sessionId: value });
  }

  async available(): Promise<boolean> {
    if (this.options.baseUrl) return true;
    return cliAvailable("opencode");
  }

  async selfCheck(): Promise<AgentCheck[]> {
    if (this.options.baseUrl) return [{ name: "server", ok: true, detail: `uses the opencode server at ${this.options.baseUrl}` }];
    const v = await cliOutput("opencode", ["--version"]);
    if (v?.code !== 0) return [{ name: "installed", ok: false, detail: "opencode not found on this machine — install it" }];
    const checks: AgentCheck[] = [{ name: "installed", ok: true, detail: `opencode ${firstLine(v.out)}` }];
    const a = await cliOutput("opencode", ["auth", "list"]);
    const providers = (a?.out ?? "")
      .split("\n")
      .map((l) => /[●•]\s+(.+?)(?:\s{2,}|\s+(?:api|oauth|wellknown)\s*$|$)/.exec(l)?.[1]?.trim())
      .filter((x): x is string => !!x)
      // the environment section names the variable too ("OpenRouter OPENROUTER_API_KEY")
      .map((x) => x.replace(/\s+[A-Z][A-Z0-9_]{2,}$/, ""))
      .filter((x, i, all) => all.indexOf(x) === i);
    checks.push({
      name: "providers",
      // opencode's own free models need no sign-in, so none is a note, not a failure
      ok: true,
      detail: providers.length ? `signed in to ${providers.join(", ")}` : "no providers signed in — its free models still work",
    });
    return checks;
  }

  /** Kill a serve child left behind by a previous daemon (verified by cmdline). */
  private async reapOrphanServe(): Promise<void> {
    const pid = Number(this.nativeState.read().servePid ?? 0);
    if (!pid) return;
    const cmd = await new Promise<string>((resolve) => {
      const windows = process.platform === "win32";
      execFile(windows ? "powershell.exe" : "ps", windows ? ["-NoProfile", "-NonInteractive", "-Command", `(Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}').CommandLine`] : ["-p", String(pid), "-o", "command="], { timeout: 8000 }, (err, stdout) =>
        resolve(err ? "" : stdout.trim()),
      );
    });
    if (/opencode(?:\.exe)?["\s]+serve\b/i.test(cmd)) {
      try {
        if (process.platform === "win32") await stopWindowsPid(pid);
        else process.kill(pid, "SIGTERM");
        this.emit({ kind: "status", payload: { state: "reaped_orphan_serve", pid } });
      } catch {
        // already gone
      }
    }
    if (this.nativeState.read().servePid === pid) this.nativeState.patch({ servePid: undefined });
  }

  private serveErr = "";
  private serveExit: string | null = null;
  /** The last meaningful line opencode serve wrote to stderr. */
  private lastServeLine(): string {
    return this.serveErr.split("\n").map((l) => l.trim()).filter(Boolean).at(-1)?.slice(0, 300) ?? "";
  }

  private recordServePid(pid: number | undefined): void {
    this.nativeState.patch({ servePid: pid });
  }

  async start(): Promise<void> {
    if (this.started) return;
    if (this.options.baseUrl) {
      this.baseUrl = this.options.baseUrl.replace(/\/$/, "");
      const pw = process.env.OPENCODE_SERVER_PASSWORD;
      this.auth = pw ? `Basic ${Buffer.from(`${process.env.OPENCODE_SERVER_USERNAME || "opencode"}:${pw}`).toString("base64")}` : null;
    } else {
      await this.reapOrphanServe();
      const port = await freePort();
      this.baseUrl = `http://127.0.0.1:${port}`;
      // a password only this adapter knows: whatever OPENCODE_SERVER_PASSWORD says, and so no
      // other process on the machine can drive this agent through its port
      const password = randomBytes(18).toString("base64url");
      this.auth = `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`;
      const child = spawnContained(
        "opencode",
        ["serve", "--port", String(port), "--hostname", "127.0.0.1", ...(this.options.extraArgs ?? [])],
        { cwd: this.projectDir, stdio: ["ignore", "ignore", "pipe"],
          env: { ...agentEnv(), ...opencodePermissionEnv(this.options), OPENCODE_SERVER_USERNAME: "opencode", OPENCODE_SERVER_PASSWORD: password } },
      );
      this.child = child;
      // what it says on stderr, so a server that never comes up can say why
      this.serveErr = "";
      this.serveExit = null;
      child.stderr?.on("data", (d: Buffer) => { this.serveErr = (this.serveErr + d.toString()).slice(-2000); });
      child.once("exit", (code, signal) => { if (!this.started) this.serveExit = `exited (${code ?? signal})`; });
      child.on("error", (error) => this.emit({ kind: "error", payload: { message: `opencode serve could not start: ${error.message}` } }));
      this.recordServePid(child.pid);
      if (process.platform === "win32") await windowsJobReady(child);
      child.on("close", (code, signal) => {
        if (!this.started) return;
        this.started = false;
        // Killed by a signal with no turn running is the daemon shutting down
        // (or restarting) around it — not a failure, and not worth a red card
        // in the thread. The next send starts a fresh server either way.
        if (code === null && !this._busy) {
          this.emit({ kind: "status", payload: { state: "stopped", signal: signal ?? null } });
          return;
        }
        this.emit({ kind: "error", payload: { message: `opencode serve exited (${code ?? signal})` } });
      });
    }
    await waitFor(async () => {
      try { await this.json(`${this.baseUrl}/api/health`); this.modernApi = false; }
      catch { await this.json(`${this.baseUrl}/global/health`); this.modernApi = true; }
      return true;
    }, {
      timeoutMs: process.platform === "win32" ? 60_000 : 30_000,
      what: () => `opencode serve to answer on ${this.baseUrl}${this.serveErr ? ` — it said: ${this.lastServeLine()}` : ""}; check that \`opencode serve\` runs in this folder and that you're signed in (\`opencode auth login\`)`,
      gaveUp: () => (this.serveExit ? `opencode serve ${this.serveExit} before it was ready${this.serveErr ? `: ${this.lastServeLine()}` : ""} — try \`opencode serve\` in this folder to see why` : null),
    });
    await this.assertModelAvailable();
    // No session yet: an ordinary turn makes (or reuses) the agent's own when it
    // sends, and a continuity turn runs on its binding's. Creating one here left
    // an empty session behind every time a continuity project started.
    this.startSse();
    this.started = true;
    this.emit({
      kind: "status",
      payload: { state: "ready", baseUrl: this.baseUrl, session: this.sessionId ?? null },
    });
  }

  private get sessionModel(): string | undefined {
    return this.nativeState.read().sessionModel as string | undefined;
  }

  private set sessionModel(value: string | undefined) {
    this.nativeState.patch({ sessionModel: value });
  }

  /**
   * A session whose model can't be resolved is a silent trap: opencode
   * "admits" prompts and never runs them (ModelUnavailableError only shows
   * in server logs). Validate against /api/model — the list of models the
   * server can actually run — and fail loudly with suggestions instead.
   */
  private async assertModelAvailable(): Promise<void> {
    const res = await this.json<Json>(this.modernApi ? `${this.baseUrl}/provider` : `${this.baseUrl}/api/model`).catch(() => null);
    const connected = Array.isArray(res?.connected) ? res.connected as string[] : [];
    const models = this.modernApi && Array.isArray(res?.all)
      ? (res.all as Json[]).filter(p => connected.includes(String(p.id))).flatMap(p => Object.keys((p.models ?? {}) as Json).map(id => ({ providerID: p.id, id })))
      : Array.isArray(res?.data) ? (res!.data as Json[]) : [];
    if (!models.length) return; // endpoint unavailable — don't block
    const ids = models.map((m) => `${String(m.providerID)}/${String(m.id)}`);
    if (!this.options.model) {
      // No pin: opencode's own default is often a model its Console won't
      // serve headless ("Model is unavailable" on the first turn, verified on
      // opencode 1.18.31). Pick one the server says it can run instead.
      this.options.model = pickDefaultModel(ids);
      return;
    }
    if (ids.includes(this.options.model)) return;
    const base = this.options.model.split("/").pop()!.split("-")[0]!.toLowerCase();
    const near = ids.filter((id) => id.toLowerCase().includes(base)).slice(0, 5);
    const free = ids.filter((id) => id.endsWith("-free")).slice(0, 3);
    throw new Error(
      `opencode cannot run model "${this.options.model}" (listed ≠ available). ` +
        `Close matches: ${near.length ? near.join(", ") : "none"}. ` +
        `Free options: ${free.join(", ")}. Fix .loom/config.json agent options.model.`,
    );
  }

  private async ensureSession(): Promise<string> {
    const existing = this.sessionId;
    // Session model is fixed at creation — a changed config model means the
    // old session must be replaced, or turns keep running on the old model.
    const modelChanged = (this.options.model ?? undefined) !== this.sessionModel;
    if (existing && !modelChanged) {
      try {
        await this.json(this.api(`/session/${existing}`));
        return existing;
      } catch {
        // stale session (server state moved on) — create a fresh one
      }
    }
    const body: Json = {};
    if (this.options.model) {
      const ref = parseModelRef(this.options.model);
      if (ref) body.model = ref;
    }
    if (this.options.agent) body.agent = this.options.agent;
    const res = await this.json<Json>(this.api("/session"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = (res.data ?? res) as Json;
    const id = String(data.id ?? "");
    if (!id) throw new Error("opencode: could not create session");
    this.sessionId = id;
    this.sessionModel = this.options.model ?? undefined;
    return id;
  }

  private startSse(): void {
    const abort = new AbortController();
    this.sseAbort = abort;
    void (async () => {
      while (!abort.signal.aborted) {
        try {
          const res = await this.http(`${this.baseUrl}/event`, {
            signal: abort.signal,
            headers: { accept: "text/event-stream" },
          });
          if (!res.ok || !res.body) throw new Error(`SSE ${res.status}`);
          let buffer = "";
          for await (const chunk of res.body) {
            buffer += Buffer.from(chunk as Uint8Array).toString("utf8");
            let idx: number;
            while ((idx = buffer.indexOf("\n")) >= 0) {
              const line = buffer.slice(0, idx).trim();
              buffer = buffer.slice(idx + 1);
              if (!line.startsWith("data:")) continue;
              try {
                this.handleSse(JSON.parse(line.slice(5).trim()) as Json);
              } catch {
                // Unparseable SSE payloads are skipped, never fatal.
              }
            }
          }
        } catch {
          if (abort.signal.aborted) return;
          await new Promise((r) => setTimeout(r, 1000)); // reconnect
        }
      }
    })();
  }

  private handleSse(evt: Json): void {
    const type = String(evt.type ?? "");
    // Payload wrapping varies across opencode builds: {properties} or {data}.
    const props = (evt.properties ?? evt.data ?? evt) as Json;
    const mySession = this.activeSid ?? this.sessionId;
    if (type.startsWith("session.next.tool.") || type.startsWith("session.next.compaction.") || type === "session.compacted") {
      if (props.sessionID && props.sessionID !== mySession) return;
      this.handleSessionNext(type, props);
      return;
    }

    // opencode 1.18+ streams the reply as session.next.{text,reasoning}.delta,
    // one fragment each; the finished message still arrives the usual way.
    if (/^session\.next\.(text|reasoning)\.delta$/.test(type)) {
      if (props.sessionID && props.sessionID !== mySession) return;
      if (typeof props.delta === "string") this.streamText(props.delta, type.includes("reasoning"));
      return;
    }

    if (type === "message.part.updated") {
      const part = (props.part ?? {}) as Json;
      if (part.sessionID && part.sessionID !== mySession) return;
      const partType = String(part.type ?? "");
      const messageID = String(part.messageID ?? "");
      if (partType === "text" && typeof part.text === "string") {
        if (!this.textParts.has(messageID)) this.textParts.set(messageID, new Map());
        const parts = this.textParts.get(messageID)!;
        const partId = String(part.id ?? "p");
        const prev = parts.get(partId) ?? "";
        parts.set(partId, part.text);
        // The reply as it grows. Each update carries the part's whole text so
        // far (newer builds add the delta too); only the assistant's, never
        // the echo of your own prompt, which arrives as a text part as well.
        if (this.roles.get(messageID) === "assistant") {
          const delta = typeof props.delta === "string" ? props.delta : part.text.startsWith(prev) ? part.text.slice(prev.length) : "";
          if (delta) this.streamText(delta);
        }
      } else if (partType === "reasoning" && typeof part.text === "string") {
        // its thinking, kept (not only streamed): the finished part replaces any earlier copy
        if (this.roles.get(messageID) !== "user") this.reasoningParts.set(`${messageID}:${String(part.id ?? "r")}`, part.text);
      } else if (partType === "tool") {
        const state = (part.state ?? {}) as Json;
        const st = String(state.status ?? "");
        const key = String(part.callID ?? part.id ?? "");
        if ((st === "completed" || st === "error") && !this.toolsDone.has(key)) {
          if (key) this.toolsDone.add(key);
          const input = state.input && typeof state.input === "object" ? (state.input as Json) : undefined;
          const output = typeof state.output === "string" ? state.output : "";
          const error = st === "error" ? String(state.error ?? "failed") : "";
          const tool = String(part.tool ?? "tool");
          // a bash call that ran to the end "completed" even when its command failed: the exit code says which
          const meta = (state as Json).metadata as Json | undefined;
          const exitCode = typeof meta?.exit === "number" ? meta.exit : undefined;
          this.emit({
            kind: "tool_call",
            payload: {
              tool,
              summary: String((state as Json).title ?? tool),
              ok: st === "completed" && (exitCode === undefined || exitCode === 0),
              ...(exitCode !== undefined ? { exitCode } : {}),
              ...(tool === "bash" && typeof input?.command === "string" ? { command: input.command.slice(0, 2_000) } : {}),
              ...(input ? { input: Object.fromEntries(Object.entries(input).slice(0, 20).map(([k, v]) => [k, typeof v === "string" && v.length > 600 ? `${v.slice(0, 600)}\u2026` : v])) } : {}),
              ...(output.trim() ? { preview: output.length > 4000 ? `\u2026\n${output.slice(-4000)}` : output } : {}),
              ...(error ? { error: error.slice(0, 1500) } : {}),
            },
          });
          // its todo list is its plan
          if (tool === "todowrite" && Array.isArray(input?.todos)) this.emitPlan(input!.todos as Json[]);
        }
      } else if (partType === "patch") {
        const files = Array.isArray(part.files) ? part.files : [];
        for (const f of files) {
          this.emit({ kind: "file_edit", payload: { path: String(f) } });
        }
      }
      return;
    }

    if (type === "message.updated") {
      const info = (props.info ?? props.message ?? {}) as Json;
      if (info.sessionID && info.sessionID !== mySession) return;
      const messageID = String(info.id ?? "");
      const role = String(info.role ?? "");
      if (role) this.roles.set(messageID, role);
      // the echo of our own prompt (briefing and all) is never emitted: don't keep it
      if (role === "user") this.textParts.delete(messageID);
      const time = (info.time ?? {}) as Json;
      if (role === "assistant" && time.completed) {
        const thought = [...this.reasoningParts.entries()].filter(([k]) => k.startsWith(`${messageID}:`)).map(([, v]) => v).join("\n").trim();
        for (const k of [...this.reasoningParts.keys()]) if (k.startsWith(`${messageID}:`)) this.reasoningParts.delete(k);
        if (thought) this.emit({ kind: "message", payload: { text: thought, reasoning: true } });
        const parts = this.textParts.get(messageID);
        if (parts && parts.size) {
          const text = [...parts.values()].join("").trim();
          if (text) {
            this.emit({ kind: "message", payload: { text } });
            this.emittedText.add(messageID);
          }
        }
        this.textParts.delete(messageID);
        // Best-effort per-turn cost (present on opencode assistant messages).
        const cost = Number(info.cost ?? 0);
        if (cost > 0) {
          this.emit({ kind: "status", payload: { state: "turn_cost", costUsd: cost } });
        }
      }
      return;
    }

    if (type === "todo.updated") {
      if (props.sessionID && props.sessionID !== mySession) return;
      if (Array.isArray(props.todos)) this.emitPlan(props.todos as Json[]);
      return;
    }

    if (/^question(\.v2)?\.asked$/.test(type)) {
      if (props.sessionID && props.sessionID !== mySession) return;
      this.askQuestion(props, type.includes(".v2"));
      return;
    }
    // Answered or dismissed somewhere else (opencode's own TUI, a timeout): fold the card.
    if (/^question(\.v2)?\.(replied|rejected)$/.test(type)) {
      const id = String(props.requestID ?? props.id ?? "");
      if (id && this.questions.delete(`oc-q:${id}`)) {
        this.emit({ kind: "status", payload: { state: "question_answered", requestId: `oc-q:${id}`, ...(type.endsWith("rejected") ? { answers: {} } : {}) } });
      }
      return;
    }
    if (/^permission(\.v2)?\.asked$/.test(type)) {
      if (props.sessionID && props.sessionID !== mySession) return;
      void this.askPermission(props, type.includes(".v2"));
    }
  }

  private reasoningParts = new Map<string, string>();
  private toolsDone = new Set<string>();

  /** An image a tool returned (a file: URI, or data: base64 filed under .loom/attachments), as a path the thread can show. */
  private keepImage(uri: string, mime: string): Array<{ path: string; mime: string }> {
    try {
      if (uri.startsWith("file://")) {
        const abs = decodeURIComponent(uri.slice(7));
        const rel = path.relative(this.projectDir, abs);
        return [{ path: rel.startsWith("..") ? abs : rel.split(path.sep).join("/"), mime }];
      }
      const m = /^data:([^;,]+);base64,(.+)$/s.exec(uri);
      if (!m) return [];
      const buf = Buffer.from(m[2]!, "base64");
      if (!buf.length || buf.length > 12 * 1024 * 1024) return [];
      const ext = ({ "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp", "image/svg+xml": "svg" } as Record<string, string>)[m[1]!] ?? "png";
      const rel = path.join(".loom", "attachments", `${createHash("sha1").update(buf).digest("hex").slice(0, 12)}.${ext}`);
      const abs = path.join(this.projectDir, rel);
      if (!fs.existsSync(abs)) { fs.mkdirSync(path.dirname(abs), { recursive: true }); fs.writeFileSync(abs, buf); }
      return [{ path: rel.split(path.sep).join("/"), mime }];
    } catch {
      return [];
    }
  }

  /** opencode's todos as Loom's plan checklist. */
  private emitPlan(todos: Json[]): void {
    const plan = todos.map((t) => ({ step: String(t.content ?? t.text ?? ""),
      status: t.status === "completed" ? "completed" : t.status === "in_progress" ? "inProgress" : "pending" })).filter((t) => t.step);
    if (plan.length) this.emit({ kind: "status", payload: { state: "plan_updated", plan } });
  }

  // ---- opencode asking you things ---------------------------------------------

  /** Open questions by Loom request id → opencode's request, so an answer can find its way back. */
  private questions = new Map<string, { id: string; sid: string; count: number }>();

  /**
   * opencode's question tool: one or more questions, each with labelled
   * options, maybe several picks, maybe your own words. The card in the thread
   * answers it through respondToUserInput.
   */
  private askQuestion(props: Json, _v2: boolean): void {
    const id = String(props.id ?? "");
    const list = Array.isArray(props.questions) ? (props.questions as Json[]) : [];
    if (!id || !list.length) return;
    const questions = list.map((q, i) => ({
      id: String(i),
      header: String(q.header ?? "Question").slice(0, 40),
      question: String(q.question ?? ""),
      options: (Array.isArray(q.options) ? (q.options as Json[]) : []).map((o) =>
        typeof o === "string" ? { label: o, description: "" } : { label: String(o.label ?? ""), description: String(o.description ?? "") }),
      multiSelect: q.multiple === true,
      allowCustomAnswer: q.custom !== false,
    }));
    const requestId = `oc-q:${id}`;
    this.questions.set(requestId, { id, sid: String(props.sessionID ?? this.activeSid ?? this.sessionId ?? ""), count: questions.length });
    this.emit({
      kind: "needs_input",
      payload: { question: questions.map((q) => q.question).join("\n").slice(0, 500), questions, requestId, responseMode: "tool" },
    });
  }

  /** Answer an open opencode question. answers: { [questionIndex]: label | labels }; none at all dismisses it. */
  async respondToUserInput(_chat: string, requestId: string, answers: Record<string, unknown>): Promise<void> {
    const open = this.questions.get(requestId);
    if (!open || !this.baseUrl) throw new Error(`no open opencode question "${requestId}"`);
    const picks = Array.from({ length: open.count }, (_v, i) => {
      const a = answers[String(i)];
      return (Array.isArray(a) ? a : a == null || a === "" ? [] : [a]).map((x) => String(x));
    });
    const dismiss = picks.every((p) => !p.length);
    // the session-scoped route on current builds, the global one on older
    const routes = this.modernApi ? [`${this.baseUrl}/question/${encodeURIComponent(open.id)}/${dismiss ? "reject" : "reply"}`] : [
      `${this.baseUrl}/api/session/${encodeURIComponent(open.sid)}/question/${encodeURIComponent(open.id)}/${dismiss ? "reject" : "reply"}`,
      `${this.baseUrl}/question/${encodeURIComponent(open.id)}/${dismiss ? "reject" : "reply"}`,
    ];
    let last = "";
    for (const url of routes) {
      const res = await this.http(url, { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify(dismiss ? {} : { answers: picks }), signal: AbortSignal.timeout(15_000) }).catch((e: Error) => ({ ok: false, status: 0, text: async () => e.message }) as unknown as Response);
      if (res.ok) {
        this.questions.delete(requestId);
        this.emit({ kind: "status", payload: { state: "question_answered", requestId, answers } });
        return;
      }
      last = `${res.status} ${(await res.text().catch(() => "")).slice(0, 160)}`;
      if (res.status !== 404) break;
    }
    throw new Error(`opencode didn't take the answer (${last})`);
  }

  /**
   * opencode asking to run a command, edit a file, fetch a URL: the same
   * approval card Loom shows for any agent, and opencode hears once / always / no.
   */
  private async askPermission(props: Json, v2: boolean): Promise<void> {
    const id = String(props.id ?? "");
    if (!id || !this.baseUrl) return;
    const sid = String(props.sessionID ?? this.activeSid ?? this.sessionId ?? "");
    const tool = String((v2 ? props.action : props.permission) ?? "permission");
    const targets = (Array.isArray(v2 ? props.resources : props.patterns) ? (v2 ? props.resources : props.patterns) as unknown[] : []).map(String);
    const meta = (props.metadata ?? {}) as Json;
    const summary = String(meta.command ?? meta.description ?? meta.filePath ?? meta.url ?? (targets.length ? `${tool} ${targets.join(", ")}` : tool)).slice(0, 300);
    const decision = await requestApproval({
      project: (this.options as { loomProject?: string }).loomProject ?? "",
      agent: this.id, tool, input: { ...meta, ...(targets.length ? { targets } : {}) }, summary, sessionOption: true,
    });
    const reply = decision.behavior !== "allow" ? "reject" : decision.scope === "session" ? "always" : "once";
    const body = JSON.stringify({ reply, ...(decision.message ? { message: decision.message } : {}) });
    for (const url of this.modernApi ? [`${this.baseUrl}/permission/${encodeURIComponent(id)}/reply`] : [`${this.baseUrl}/api/session/${encodeURIComponent(sid)}/permission/${encodeURIComponent(id)}/reply`, `${this.baseUrl}/permission/${encodeURIComponent(id)}/reply`]) {
      const res = await this.http(url, { method: "POST", headers: { "content-type": "application/json" }, body, signal: AbortSignal.timeout(15_000) }).catch(() => null);
      if (res?.ok) return;
      if (res && res.status !== 404) break;
    }
    logbook.warn(`agent:${this.id}`, "opencode didn't take the permission reply", id);
  }

  /** opencode 1.18's tool and compaction events, for a session already known to be ours. */
  private handleSessionNext(type: string, props: Json): void {
    const callId = String(props.callID ?? "");
    if (type === "session.next.tool.called") {
      const input = (props.input ?? {}) as Json;
      const title = String(input.description ?? input.command ?? input.filePath ?? input.path ?? input.pattern ?? props.tool ?? "tool");
      this.toolCalls.set(callId, { tool: String(props.tool ?? "tool"), title: title.slice(0, 200), input });
      return;
    }
    if (type === "session.next.tool.success" || type === "session.next.tool.failed") {
      const call = this.toolCalls.get(callId) ?? { tool: "tool", title: "tool" };
      this.toolCalls.delete(callId);
      // the same call also arrives as a message part on these builds: log it once
      if (callId && this.toolsDone.has(callId)) return;
      if (callId) this.toolsDone.add(callId);
      const err = (props.error ?? {}) as Json;
      // the result: text blocks are its output, file blocks with an image type are pictures it made or read
      const content = Array.isArray(props.content) ? (props.content as Json[]) : [];
      const output = content.filter((c) => c.type === "text" && typeof c.text === "string").map((c) => String(c.text)).join("\n");
      const images = content.filter((c) => c.type === "file" && /^image\//.test(String(c.mime ?? ""))).flatMap((c) => this.keepImage(String(c.uri ?? ""), String(c.mime)));
      // bash "succeeds" when its command ran, failing or not: the exit code it reports says which
      const structured = (props.structured ?? {}) as Json;
      const exitRaw = structured.exit ?? (structured.metadata as Json | undefined)?.exit;
      const exitCode = typeof exitRaw === "number" ? exitRaw : undefined;
      const input = call.input ? Object.fromEntries(Object.entries(call.input).slice(0, 20).map(([k, v]) => [k, typeof v === "string" && v.length > 600 ? `${v.slice(0, 600)}\u2026` : v])) : undefined;
      this.emit({
        kind: "tool_call",
        payload: { tool: call.tool, summary: call.title, ok: !type.endsWith("failed") && (exitCode === undefined || exitCode === 0),
          ...(exitCode !== undefined ? { exitCode } : {}),
          ...(call.tool === "bash" && typeof call.input?.command === "string" ? { command: String(call.input.command).slice(0, 2_000) } : {}),
          ...(input && Object.keys(input).length ? { input } : {}),
          ...(output.trim() ? { preview: output.length > 4000 ? `\u2026\n${output.slice(-4000)}` : output } : {}),
          ...(images.length ? { images } : {}),
          ...(type.endsWith("failed") ? { error: String(err.message ?? "failed").slice(0, 1500) } : {}) },
      });
      if (call.tool === "todowrite" && Array.isArray(call.input?.todos)) this.emitPlan(call.input!.todos as Json[]);
      return;
    }
    if (type === "session.next.compaction.started") {
      this.compactionReported = false;
      this.emit({ kind: "status", payload: { state: "compacting", reason: String(props.reason ?? "auto") } });
      return;
    }
    if ((type === "session.next.compaction.ended" || type === "session.compacted") && !this.compactionReported) {
      this.compactionReported = true;
      this.emit({ kind: "status", payload: { state: "native_compacted", session: String(props.sessionID ?? this.activeSid ?? "") } });
    }
  }

  /** All messages in the session, oldest first (info objects). */
  private async listMessages(sid: string): Promise<Json[]> {
    const res = await this.json<Json>(this.api(`/session/${sid}/message`));
    const data = (res.data ?? res) as unknown;
    const items = Array.isArray(data) ? (data as Json[]) : [];
    return items
      .map((m) => ((m as Json).info ?? m) as Json)
      .sort(
        (a, b) =>
          Number((a.time as Json | undefined)?.created ?? 0) -
          Number((b.time as Json | undefined)?.created ?? 0),
      );
  }

  /**
   * Wait until the TURN is over — not just the first assistant message.
   * opencode runs a turn as a sequence of assistant messages (one per step),
   * so completion = the newest message is a completed assistant AND that
   * fact holds across two consecutive polls (nothing new started).
   * `/wait` is tried first but returns 503 on 1.17.
   */
  /** Is opencode still running this session? Null when this opencode can't say (older builds). */
  private async sessionActive(sid: string): Promise<boolean | null> {
    const res = await this.json<Json>(this.modernApi ? this.api("/session/status") : this.api("/session/active")).catch(() => null);
    const active = res ? ((res.data ?? res) as Json) : null;
    if (!active || typeof active !== "object" || Array.isArray(active)) return null;
    if (!Object.prototype.hasOwnProperty.call(active, sid)) return false;
    if (!this.modernApi) return true;
    const type = (active[sid] as Json | undefined)?.type;
    return type === "idle" ? false : type === "busy" || type === "retry" ? true : null;
  }

  /** When the current turn was interrupted (the wait gives up 20s later, whatever opencode says). */
  private interruptedAt: number | null = null;

  /** "provider/model" a session runs, when opencode says. */
  private async modelOfSession(sid: string): Promise<string | null> {
    const s = await this.json<Json>(this.api(`/session/${encodeURIComponent(sid)}`)).catch(() => null);
    const m = (s?.model ?? null) as Json | null;
    return m && typeof m.id === "string" ? `${typeof m.providerID === "string" ? `${m.providerID}/` : ""}${m.id}` : null;
  }

  /** Set when the last wait gave up on a turn opencode never began. */
  private neverStarted = false;

  /** How long a prompt may sit with nothing in the session before it counts as never started (options.startTimeoutMs, default 3 min). */
  private startTimeoutMs(): number {
    const v = (this.options as { startTimeoutMs?: unknown }).startTimeoutMs;
    return typeof v === "number" && v > 0 ? v : 180_000;
  }

  private async waitForTurn(sid: string, baseline: Set<string>, timeoutMs: number): Promise<Json | null> {
    try {
      if (!this.modernApi) await this.json(
        `${this.baseUrl}/api/session/${sid}/wait`,
        { method: "POST", headers: { "content-type": "application/json" }, body: "{}" },
        timeoutMs,
      );
    } catch {
      // 503 "not available yet" on 1.17 — fall through to polling.
    }
    const deadline = Date.now() + timeoutMs;
    const startBy = Date.now() + this.startTimeoutMs();
    // opencode stores the prompt the moment it takes it: nothing at all in the session this long
    // after an accepted prompt means it never will — even while it reports the session "busy"
    // (a model its session engine can't run left one busy forever: big-pickle on 1.18, field).
    const takenBy = Date.now() + Math.min(45_000, this.startTimeoutMs());
    let stableId: string | null = null;
    while (Date.now() < deadline) {
      // Interrupted: done as soon as opencode stops running it, answer or not
      // (one that never answered would otherwise be waited on for the hour) —
      // and at most 20s after the interrupt, even if opencode still calls it
      // busy: a stuck model kept the turn, and its server, alive 42 min (#312).
      if (this.interrupted && !this.interruptedAt) this.interruptedAt = Date.now();
      if (this.interrupted && ((await this.sessionActive(sid)) !== true || Date.now() - (this.interruptedAt ?? Date.now()) > 20_000)) {
        const after = await this.listMessages(sid).catch(() => [] as Json[]);
        const last = after.filter((m) => (m.type ?? m.role) === "assistant" && !baseline.has(String(m.id))).at(-1);
        return last ?? null;
      }
      const messages = await this.listMessages(sid).catch(() => [] as Json[]);
      if (Date.now() > takenBy && !messages.some((m) => !baseline.has(String(m.id)))) {
        this.neverStarted = true;
        return null;
      }
      // accepted but never begun: not even our own message reached the session, and opencode isn't working on it —
      // don't wait the hour out (a review sat 30 minutes on one, #291)
      if (Date.now() > startBy && !messages.some((m) => !baseline.has(String(m.id))) && (await this.sessionActive(sid)) !== true) {
        this.neverStarted = true;
        return null;
      }
      const newest = messages[messages.length - 1];
      const newAssistants = messages.filter(
        (m) =>
          (m.type ?? m.role) === "assistant" &&
          !baseline.has(String(m.id)) &&
          (m.time as Json | undefined)?.completed,
      );
      const turnLooksDone =
        newest &&
        (newest.type ?? newest.role) === "assistant" &&
        (newest.time as Json | undefined)?.completed &&
        newAssistants.length > 0;
      if (turnLooksDone) {
        // Errors are terminal immediately. A finished *step* is not a finished
        // turn: one that ended in tool calls is followed by another, and a slow
        // model can take longer than a poll to start it — so a session opencode
        // still lists as active, or a step that finished on tool calls, keeps
        // waiting. Otherwise require stability across two polls.
        if (newest!.finish === "error" || newest!.error) return newest!;
        const midTurn = /tool/i.test(String(newest!.finish ?? "")) || (await this.sessionActive(sid)) === true;
        if (midTurn) stableId = null;
        else if (stableId === String(newest!.id)) return newest!;
        else stableId = String(newest!.id);
      } else {
        stableId = null;
      }
      await new Promise((r) => setTimeout(r, typeof (this.options as { pollMs?: unknown }).pollMs === "number" ? (this.options as { pollMs: number }).pollMs : 3000));
    }
    return null;
  }

  async send(input: SendInput): Promise<void> {
    if (input.continuity) return this.sendContinuity(input);
    this.cancelIdle();
    if (!this.started) await this.start();
    if (this._busy) throw new Error(`opencode agent "${this.id}" is busy`);
    this._busy = true;
    this.trimTurnState();
    this.interrupted = false;
    this.interruptedAt = null;
    const started = Date.now();
    const timeoutMs = 60 * 60 * 1000;
    try {
      // One retry, in a fresh session, when opencode refuses the session's own
      // history: a single bad picture in it (media that isn't valid base64)
      // is replayed on every later turn and would lock this agent out for good.
      for (let attempt = 0; ; attempt++) {
        const sid = await this.ensureSession();
        const baseline = new Set(
          (await this.listMessages(sid).catch(() => [] as Json[])).map((m) => String(m.id)),
        );
        // No per-prompt system field in the API, so the handoff briefing rides in
        // the prompt — framed as an unmissable authoritative block (frameBriefing)
        // rather than a loose preamble.
        const text = input.briefing ? `${frameBriefing(input.briefing)}\n\n${input.text}` : input.text;
        const admission = await this.http(this.api(`/session/${sid}/${this.modernApi ? "prompt_async" : "prompt"}`), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(this.promptBody(text)),
          signal: AbortSignal.timeout(30_000),
        });
        if (!admission.ok) throw new Error(`opencode prompt failed (${admission.status}): ${(await admission.text()).slice(0, 500)}`);
        await admission.arrayBuffer();

        this.neverStarted = false;
        const turn = await this.waitForTurn(sid, baseline, timeoutMs);
        if (!turn && this.interrupted) {
          this.emit({ kind: "status", payload: { state: "interrupted" } });
        } else if (!turn && this.neverStarted) {
          // the session itself may be what's broken (bound to a model opencode can't run now):
          // once, carry on in a fresh session, which takes opencode's current default model
          const model = await this.modelOfSession(sid);
          if (attempt === 0) {
            this.sessionId = undefined;
            this.emit({ kind: "status", payload: { state: "session_reset", reason: `opencode never took the prompt in its session${model ? ` (model ${model})` : ""}; carrying on in a fresh session` } });
            continue;
          }
          this.emit({ kind: "error", payload: { message: `opencode accepted the prompt but never started the turn${model ? ` — its session runs ${model}, which may not work with this opencode` : " — its model may be unavailable"}; ` +
            "pick another model (loom agents, or opencode's own config) and try again. opencode's log (~/.local/share/opencode/log/opencode.log) says why" } });
        } else if (!turn) {
          this.emit({ kind: "error", payload: { message: "turn timed out waiting for opencode" } });
        } else {
          const turnId = String(turn.id);
          // Fetch the full message: parts (in case SSE missed them) + errors.
          const detail = await this.messageDetail(sid, turnId);
          const info = ((detail?.data ?? detail ?? turn) as Json) ?? turn;
          if (info.finish === "error" || info.error) {
            const err = (info.error ?? {}) as Json;
            const message = turnError(err);
            if (attempt === 0 && POISONED_HISTORY.test(message)) {
              this.sessionId = undefined;
              this.emit({ kind: "status", payload: { state: "session_reset", reason: `opencode refused this session's history (${message}); carrying on in a fresh session` } });
              continue;
            }
            this.emit({ kind: "error", payload: { message } });
          } else if (!this.emittedText.has(turnId)) {
            const content = Array.isArray(info.content) ? (info.content as Json[]) : [];
            const text = content
              .filter((p) => p.type === "text" && typeof p.text === "string")
              .map((p) => String(p.text))
              .join("")
              .trim();
            if (text) {
              this.emit({ kind: "message", payload: { text } });
              this.emittedText.add(turnId);
            }
          }
          const cost = Number(info.cost ?? 0);
          if (cost > 0) {
            this.emit({ kind: "status", payload: { state: "turn_cost", costUsd: cost } });
          }
          // OpenCode assistant messages carry token usage; capture it (cache
          // reads/writes count as input) so it isn't dropped.
          const tk = (info.tokens ?? {}) as Record<string, number>;
          const cache = (tk.cache ?? {}) as unknown as Record<string, number>;
          this.lastUsage = {
            input: (tk.input ?? 0) + (cache.read ?? 0) + (cache.write ?? 0),
            output: (tk.output ?? 0) + (tk.reasoning ?? 0),
            cached: cache.read ?? 0,
            reasoning: tk.reasoning ?? 0,
          };
          const mid = (info as Record<string, unknown>).modelID;
          const pid = (info as Record<string, unknown>).providerID;
          if (typeof mid === "string" && mid) this.lastModel = typeof pid === "string" && pid ? `${pid}/${mid}` : mid;
        }
        break;
      }
      this.emit({
        kind: "run_complete",
        payload: {
          durationMs: Date.now() - started,
          ...((this.lastModel ?? this.options.model) ? { model: this.lastModel ?? this.options.model } : {}),
          ...(this.lastUsage ? usagePayload(this.lastUsage) : {}),
        },
      });
      this.lastUsage = null;
      this.lastModel = null;
    } finally {
      this._busy = false;
      this.armIdle();
    }
  }

  /**
   * A continuity turn (see the header): the binding's session, the admission as
   * acceptance, and the session leaving `/api/session/active` as the end.
   * Failures before the prompt is admitted are NativeDispatchRejected — nothing
   * reached opencode — and a lost acknowledgement is never retried.
   */
  private async sendContinuity(input: SendInput): Promise<void> {
    const c = input.continuity!;
    if (this._busy) throw new NativeDispatchRejected(`opencode agent "${this.id}" is busy`);
    this.cancelIdle();
    this._busy = true;
    this.trimTurnState();
    this.interrupted = false;
    this.beginContinuity(input);
    const started = Date.now();
    let admitted = false;
    try {
      if (!this.started) {
        try {
          await this.start();
        } catch (err) {
          throw new NativeDispatchRejected(`opencode didn't start: ${(err as Error).message}`);
        }
      }
      const sid = await this.continuitySession(c.nativeSessionId, input.model);
      this.activeSid = sid;
      this.emit({ kind: "status", payload: { state: "turn_started", session: sid } });
      if (this.interrupted) throw new NativeDispatchRejected("interrupted before the turn started");
      const baseline = new Set((await this.listMessages(sid).catch(() => [] as Json[])).map((m) => String(m.id)));
      const text = [c.context, input.briefing, input.text].filter(Boolean).join("\n\n");
      let res: Response;
      try {
        res = await this.http(this.api(`/session/${encodeURIComponent(sid)}/${this.modernApi ? "prompt_async" : "prompt"}`), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(this.modernApi ? { ...this.promptBody(text), ...(input.model ? { model: { providerID: parseModelRef(input.model)?.providerID, modelID: parseModelRef(input.model)?.id } } : {}) } : { prompt: promptWithFiles(text, this.projectDir) }),
          signal: AbortSignal.timeout(30_000),
        });
      } catch (err) {
        // The request may or may not have reached the server: unknown, not rejected.
        throw new Error(`opencode prompt request failed: ${(err as Error).message}; native outcome is unknown`);
      }
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new NativeDispatchRejected(`opencode refused the prompt (${res.status}): ${body.slice(0, 300)}`);
      }
      if (this.modernApi && res.status !== 204) throw new Error(`opencode prompt returned unexpected admission status ${res.status}; native outcome is unknown`);
      const ack = ((await res.json().catch(() => ({}))) as Json).data as Json | undefined;
      admitted = true;
      this.emit({ kind: "status", payload: { state: "native_turn_accepted", session: sid, ...(ack?.id ? { messageId: String(ack.id) } : {}) } });

      const idle = await this.waitIdle(sid, baseline, this.turnTimeoutMs());
      if (!idle) {
        this.emit({ kind: "error", payload: { message: "opencode was still working when the turn timed out" } });
        throw new NativeQuiescenceUnknown("opencode still lists the session as active; quiescence unknown");
      }
      if (this.interrupted) {
        this.emit({ kind: "status", payload: { state: "interrupted" } });
        return;
      }
      const messages = await this.listMessages(sid).catch(() => [] as Json[]);
      const turn = [...messages].reverse().find((m) => (m.type ?? m.role) === "assistant" && !baseline.has(String(m.id)));
      if (!turn) {
        const message = "opencode finished without a reply";
        this.emit({ kind: "error", payload: { message } });
        throw new Error(message);
      }
      const failed = await this.reportTurn(sid, turn);
      if (failed) throw new Error(`opencode reported a failed turn: ${failed}`);
      this.emit({
        kind: "run_complete",
        payload: {
          durationMs: Date.now() - started,
          session: sid,
          ...((this.lastModel ?? this.options.model) ? { model: this.lastModel ?? this.options.model } : {}),
          ...(this.lastUsage ? usagePayload(this.lastUsage) : {}),
        },
      });
    } catch (err) {
      if (!admitted && !(err instanceof NativeSessionMissing) && !(err instanceof NativeDispatchRejected) && !/native outcome is unknown/.test(String((err as Error).message))) {
        throw new NativeDispatchRejected((err as Error).message);
      }
      throw err;
    } finally {
      this.lastUsage = null;
      this.lastModel = null;
      this.activeSid = undefined;
      this._busy = false;
      this.endContinuity();
      this.armIdle();
    }
  }

  private turnTimeoutMs(): number {
    const t = (this.options as { turnTimeoutMs?: unknown }).turnTimeoutMs;
    return typeof t === "number" && t > 0 ? t : 60 * 60 * 1000;
  }

  /** The session a continuity turn runs on: its binding's, or a new one. Nothing is sent yet. */
  private async continuitySession(bound: string | null, turnModel?: string): Promise<string> {
    const want = turnModel ?? this.options.model;
    const ref = want ? parseModelRef(want) : null;
    if (bound) {
      let res: Response;
      for (let attempt = 0; ; attempt++) {
        try {
          res = await this.http(this.api(`/session/${encodeURIComponent(bound)}`), { signal: AbortSignal.timeout(15_000) });
          break;
        } catch (err) {
          // A stale keep-alive socket can reset between native turns. Only
          // this read-only preflight is retried; prompt admission never is.
          if (attempt === 0) continue;
          throw new NativeDispatchRejected(`opencode server unreachable: ${(err as Error).message}`);
        }
      }
      if (res.status === 404) throw new NativeSessionMissing(`opencode no longer has session ${bound}`);
      if (!res.ok) throw new NativeDispatchRejected(`opencode answered ${res.status} for session ${bound}`);
      const info = (((await res.json().catch(() => ({}))) as Json).data ?? {}) as Json;
      const cur = (info.model ?? {}) as Json;
      // A model change keeps the session, as it does for the other harnesses.
      if (!this.modernApi && ref && (cur.providerID !== ref.providerID || cur.id !== ref.id)) {
        try {
          await this.json(`${this.baseUrl}/api/session/${encodeURIComponent(bound)}/model`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ model: ref }),
          });
        } catch (err) {
          throw new NativeDispatchRejected(`opencode couldn't switch the session to ${want}: ${(err as Error).message}`);
        }
      }
      return bound;
    }
    const body: Json = {};
    if (ref) body.model = ref;
    if (this.options.agent) body.agent = this.options.agent;
    try {
      const created = await this.json<Json>(this.api("/session"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(this.modernApi ? {} : body),
      });
      const id = String(((created.data ?? created) as Json).id ?? "");
      if (!id) throw new Error("no session id in the reply");
      return id;
    } catch (err) {
      throw new NativeDispatchRejected(`opencode couldn't create a session: ${(err as Error).message}`);
    }
  }

  /**
   * Wait until opencode no longer lists the session as active. Before it has
   * been seen running, an idle session only counts as done once a new
   * completed assistant message exists — the prompt may not have started yet.
   */
  private async waitIdle(sid: string, baseline: Set<string>, timeoutMs: number): Promise<boolean> {
    const pollMs = typeof (this.options as { pollMs?: unknown }).pollMs === "number" ? (this.options as { pollMs: number }).pollMs : 500;
    const deadline = Date.now() + timeoutMs;
    let sawRunning = false;
    while (Date.now() < deadline) {
      const active = await this.sessionActive(sid);
      if (active === true) sawRunning = true;
      else if (active === false) {
        if (sawRunning || this.interrupted) return true;
        const messages = await this.listMessages(sid).catch(() => [] as Json[]);
        if (messages.some((m) => (m.type ?? m.role) === "assistant" && !baseline.has(String(m.id)) && (m.time as Json | undefined)?.completed)) return true;
      }
      await new Promise((r) => setTimeout(r, pollMs));
    }
    return false;
  }

  /**
   * Emit a finished assistant message's text (unless the stream already did),
   * its cost, and stash its usage and model for run_complete. Returns the
   * error message when opencode says the turn failed.
   */
  private async reportTurn(sid: string, turn: Json): Promise<string | null> {
    const turnId = String(turn.id);
    const detail = await this.messageDetail(sid, turnId);
    const info = ((detail?.data ?? detail ?? turn) as Json) ?? turn;
    if (info.finish === "error" || info.error) {
      const err = (info.error ?? {}) as Json;
      const message = turnError(err);
      this.emit({ kind: "error", payload: { message } });
      return message;
    }
    if (!this.emittedText.has(turnId)) {
      const content = Array.isArray(info.content) ? (info.content as Json[]) : [];
      const text = content
        .filter((p) => p.type === "text" && typeof p.text === "string")
        .map((p) => String(p.text))
        .join("")
        .trim();
      if (text) {
        this.emit({ kind: "message", payload: { text } });
        this.emittedText.add(turnId);
      }
    }
    const cost = Number(info.cost ?? 0);
    if (cost > 0) this.emit({ kind: "status", payload: { state: "turn_cost", costUsd: cost } });
    const tk = (info.tokens ?? {}) as Record<string, number>;
    const cache = (tk.cache ?? {}) as unknown as Record<string, number>;
    this.lastUsage = {
      input: (tk.input ?? 0) + (cache.read ?? 0) + (cache.write ?? 0),
      output: (tk.output ?? 0) + (tk.reasoning ?? 0),
      cached: cache.read ?? 0,
      reasoning: tk.reasoning ?? 0,
    };
    const mid = info.modelID, pid = info.providerID;
    const model = (info.model ?? {}) as Json;
    if (typeof mid === "string" && mid) this.lastModel = typeof pid === "string" && pid ? `${pid}/${mid}` : mid;
    else if (typeof model.id === "string") this.lastModel = typeof model.providerID === "string" ? `${model.providerID}/${model.id}` : model.id;
    return null;
  }

  async interrupt(): Promise<void> {
    this.interrupted = true;
    const sid = this.activeSid ?? this.sessionId;
    if (!sid || !this.baseUrl) return;
    try {
      await this.json(this.api(`/session/${sid}/${this.modernApi ? "abort" : "interrupt"}`), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
    } catch {
      // If the server is gone there is nothing to interrupt.
    }
  }

  async stop(): Promise<void> {
    this.cancelIdle();
    this.started = false;
    this.sseAbort?.abort();
    this.sseAbort = null;
    if (this.child) {
      if (process.platform === "win32") await stopWindowsTree(this.child);
      else await interruptProcess(this.child, true);
      this.child = null;
    }
    this.emit({ kind: "status", payload: { state: "stopped" } });
  }
}
