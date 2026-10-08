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

import { execFile, spawn, type ChildProcess } from "node:child_process";
import type { SendInput } from "../types.js";
import { readProjectState, writeProjectState } from "../core/registry.js";
import { AdapterBase, agentEnv, cliAvailable, cliOutput, fetchJson, firstLine, frameBriefing, freePort, waitFor, type AgentCheck } from "./base.js";
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
}

type Json = Record<string, unknown>;

/** "providerID/modelID" → ModelRef body for session create ({providerID, id}). */
export function parseModelRef(model: string): { providerID: string; id: string } | null {
  const idx = model.indexOf("/");
  if (idx <= 0 || idx === model.length - 1) return null;
  return { providerID: model.slice(0, idx), id: model.slice(idx + 1) };
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
  private child: ChildProcess | null = null;
  private baseUrl: string | null = null;
  private sseAbort: AbortController | null = null;
  private options: OpenCodeOptions;
  private started = false;
  // Token usage from the assistant message, stashed to ride run_complete.
  private lastUsage: { input: number; output: number } | null = null;
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
  private toolCalls = new Map<string, { tool: string; title: string }>();
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
      execFile("ps", ["-p", String(pid), "-o", "command="], (err, stdout) =>
        resolve(err ? "" : stdout.trim()),
      );
    });
    if (/opencode serve/.test(cmd)) {
      try {
        process.kill(pid, "SIGTERM");
        this.emit({ kind: "status", payload: { state: "reaped_orphan_serve", pid } });
      } catch {
        // already gone
      }
    }
    if (this.nativeState.read().servePid === pid) this.nativeState.patch({ servePid: undefined });
  }

  private recordServePid(pid: number | undefined): void {
    this.nativeState.patch({ servePid: pid });
  }

  async start(): Promise<void> {
    if (this.started) return;
    if (this.options.baseUrl) {
      this.baseUrl = this.options.baseUrl.replace(/\/$/, "");
    } else {
      await this.reapOrphanServe();
      const port = await freePort();
      this.baseUrl = `http://127.0.0.1:${port}`;
      const child = spawn(
        "opencode",
        ["serve", "--port", String(port), "--hostname", "127.0.0.1", ...(this.options.extraArgs ?? [])],
        { cwd: this.projectDir, stdio: "ignore", env: { ...agentEnv(), ...opencodePermissionEnv(this.options) } },
      );
      this.child = child;
      this.recordServePid(child.pid);
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
      await fetchJson(`${this.baseUrl}/api/health`);
      return true;
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
    const res = await fetchJson<Json>(`${this.baseUrl}/api/model`).catch(() => null);
    const models = Array.isArray(res?.data) ? (res!.data as Json[]) : [];
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
        await fetchJson(`${this.baseUrl}/api/session/${existing}`);
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
    const res = await fetchJson<Json>(`${this.baseUrl}/api/session`, {
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
          const res = await fetch(`${this.baseUrl}/event`, {
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
      } else if (partType === "tool") {
        const state = (part.state ?? {}) as Json;
        if (String(state.status ?? "") === "completed") {
          this.emit({
            kind: "tool_call",
            payload: {
              tool: String(part.tool ?? "tool"),
              summary: String((state as Json).title ?? part.tool ?? "tool"),
            },
          });
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
      const time = (info.time ?? {}) as Json;
      if (role === "assistant" && time.completed) {
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

    if (/^(permission|question)(\.v2)?\.asked$/.test(type)) {
      if (props.sessionID && props.sessionID !== mySession) return;
      const detail =
        (props.title as string | undefined) ??
        (props.text as string | undefined) ??
        ((props.permission as Json | undefined)?.title as string | undefined) ??
        type;
      this.emit({ kind: "needs_input", payload: { question: String(detail).slice(0, 500) } });
    }
  }

  /** opencode 1.18's tool and compaction events, for a session already known to be ours. */
  private handleSessionNext(type: string, props: Json): void {
    const callId = String(props.callID ?? "");
    if (type === "session.next.tool.called") {
      const input = (props.input ?? {}) as Json;
      const title = String(input.description ?? input.command ?? input.filePath ?? input.path ?? input.pattern ?? props.tool ?? "tool");
      this.toolCalls.set(callId, { tool: String(props.tool ?? "tool"), title: title.slice(0, 200) });
      return;
    }
    if (type === "session.next.tool.success" || type === "session.next.tool.failed") {
      const call = this.toolCalls.get(callId) ?? { tool: "tool", title: "tool" };
      this.toolCalls.delete(callId);
      const err = (props.error ?? {}) as Json;
      this.emit({
        kind: "tool_call",
        payload: { tool: call.tool, summary: call.title, ...(type.endsWith("failed") ? { error: String(err.message ?? "failed").slice(0, 300) } : {}) },
      });
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
    const res = await fetchJson<Json>(`${this.baseUrl}/api/session/${sid}/message`);
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
    const res = await fetchJson<Json>(`${this.baseUrl}/api/session/active`).catch(() => null);
    const active = res ? ((res.data ?? res) as Json) : null;
    if (!active || typeof active !== "object") return null;
    return Object.prototype.hasOwnProperty.call(active, sid);
  }

  private async waitForTurn(sid: string, baseline: Set<string>, timeoutMs: number): Promise<Json | null> {
    try {
      await fetchJson(
        `${this.baseUrl}/api/session/${sid}/wait`,
        { method: "POST", headers: { "content-type": "application/json" }, body: "{}" },
        timeoutMs,
      );
    } catch {
      // 503 "not available yet" on 1.17 — fall through to polling.
    }
    const deadline = Date.now() + timeoutMs;
    let stableId: string | null = null;
    while (Date.now() < deadline) {
      // Interrupted: done as soon as opencode stops running it, answer or not
      // (one that never answered would otherwise be waited on for the hour).
      if (this.interrupted && (await this.sessionActive(sid)) !== true) {
        const after = await this.listMessages(sid).catch(() => [] as Json[]);
        const last = after.filter((m) => (m.type ?? m.role) === "assistant" && !baseline.has(String(m.id))).at(-1);
        return last ?? null;
      }
      const messages = await this.listMessages(sid).catch(() => [] as Json[]);
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
    if (!this.started) await this.start();
    if (this._busy) throw new Error(`opencode agent "${this.id}" is busy`);
    this._busy = true;
    this.interrupted = false;
    const started = Date.now();
    const timeoutMs = 60 * 60 * 1000;
    try {
      const sid = await this.ensureSession();
      const baseline = new Set(
        (await this.listMessages(sid).catch(() => [] as Json[])).map((m) => String(m.id)),
      );
      // No per-prompt system field in the API, so the handoff briefing rides in
      // the prompt — framed as an unmissable authoritative block (frameBriefing)
      // rather than a loose preamble.
      const text = input.briefing ? `${frameBriefing(input.briefing)}\n\n${input.text}` : input.text;
      await fetchJson(`${this.baseUrl}/api/session/${sid}/prompt`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt: { text } }),
      });

      const turn = await this.waitForTurn(sid, baseline, timeoutMs);
      if (!turn && this.interrupted) {
        this.emit({ kind: "status", payload: { state: "interrupted" } });
      } else if (!turn) {
        this.emit({ kind: "error", payload: { message: "turn timed out waiting for opencode" } });
      } else {
        const turnId = String(turn.id);
        // Fetch the full message: parts (in case SSE missed them) + errors.
        const detail = await fetchJson<Json>(
          `${this.baseUrl}/api/session/${sid}/message/${turnId}`,
        ).catch(() => null);
        const info = ((detail?.data ?? detail ?? turn) as Json) ?? turn;
        if (info.finish === "error" || info.error) {
          const err = (info.error ?? {}) as Json;
          this.emit({
            kind: "error",
            payload: {
              message: String(err.message ?? "opencode turn failed").slice(0, 500),
            },
          });
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
        };
        const mid = (info as Record<string, unknown>).modelID;
        const pid = (info as Record<string, unknown>).providerID;
        if (typeof mid === "string" && mid) this.lastModel = typeof pid === "string" && pid ? `${pid}/${mid}` : mid;
      }
      this.emit({
        kind: "run_complete",
        payload: {
          durationMs: Date.now() - started,
          ...(this.lastModel ? { model: this.lastModel } : {}),
          ...(this.lastUsage ? { inputTokens: this.lastUsage.input, outputTokens: this.lastUsage.output } : {}),
        },
      });
      this.lastUsage = null;
      this.lastModel = null;
    } finally {
      this._busy = false;
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
    this._busy = true;
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
        res = await fetch(`${this.baseUrl}/api/session/${encodeURIComponent(sid)}/prompt`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ prompt: { text } }),
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
          ...(this.lastModel ? { model: this.lastModel } : {}),
          ...(this.lastUsage ? { inputTokens: this.lastUsage.input, outputTokens: this.lastUsage.output } : {}),
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
      try {
        res = await fetch(`${this.baseUrl}/api/session/${encodeURIComponent(bound)}`, { signal: AbortSignal.timeout(15_000) });
      } catch (err) {
        throw new NativeDispatchRejected(`opencode server unreachable: ${(err as Error).message}`);
      }
      if (res.status === 404) throw new NativeSessionMissing(`opencode no longer has session ${bound}`);
      if (!res.ok) throw new NativeDispatchRejected(`opencode answered ${res.status} for session ${bound}`);
      const info = (((await res.json().catch(() => ({}))) as Json).data ?? {}) as Json;
      const cur = (info.model ?? {}) as Json;
      // A model change keeps the session, as it does for the other harnesses.
      if (ref && (cur.providerID !== ref.providerID || cur.id !== ref.id)) {
        try {
          await fetchJson(`${this.baseUrl}/api/session/${encodeURIComponent(bound)}/model`, {
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
      const created = await fetchJson<Json>(`${this.baseUrl}/api/session`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
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
      const res = await fetchJson<Json>(`${this.baseUrl}/api/session/active`).catch(() => null);
      const active = res ? ((res.data ?? res) as Json) : null;
      if (active && Object.prototype.hasOwnProperty.call(active, sid)) sawRunning = true;
      else if (active) {
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
    const detail = await fetchJson<Json>(`${this.baseUrl}/api/session/${sid}/message/${turnId}`).catch(() => null);
    const info = ((detail?.data ?? detail ?? turn) as Json) ?? turn;
    if (info.finish === "error" || info.error) {
      const err = (info.error ?? {}) as Json;
      const message = String(err.message ?? "opencode turn failed").slice(0, 500);
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
      await fetchJson(`${this.baseUrl}/api/session/${sid}/interrupt`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
    } catch {
      // If the server is gone there is nothing to interrupt.
    }
  }

  async stop(): Promise<void> {
    this.started = false;
    this.sseAbort?.abort();
    this.sseAbort = null;
    if (this.child) {
      this.child.kill("SIGTERM");
      this.child = null;
    }
    this.emit({ kind: "status", payload: { state: "stopped" } });
  }
}
