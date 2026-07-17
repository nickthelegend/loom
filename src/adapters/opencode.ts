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
 */

import { execFile, spawn, type ChildProcess } from "node:child_process";
import type { SendInput } from "../types.js";
import { readProjectState, writeProjectState } from "../core/registry.js";
import { AdapterBase, agentEnv, cliAvailable, fetchJson, frameBriefing, freePort, waitFor } from "./base.js";

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

export class OpenCodeAdapter extends AdapterBase {
  private child: ChildProcess | null = null;
  private baseUrl: string | null = null;
  private sseAbort: AbortController | null = null;
  private options: OpenCodeOptions;
  private started = false;

  /** text parts per in-flight assistant message */
  private textParts = new Map<string, Map<string, string>>();
  private roles = new Map<string, string>();
  /** assistant messages whose text already went to the log (SSE path) */
  private emittedText = new Set<string>();

  constructor(id: string, projectDir: string, options: Record<string, unknown> = {}) {
    super(id, "opencode", projectDir);
    this.options = options as OpenCodeOptions;
  }

  private get sessionId(): string | undefined {
    return readProjectState(this.projectDir).agents[this.id]?.sessionId as string | undefined;
  }

  private set sessionId(value: string | undefined) {
    const state = readProjectState(this.projectDir);
    state.agents[this.id] = { ...state.agents[this.id], sessionId: value };
    writeProjectState(this.projectDir, state);
  }

  async available(): Promise<boolean> {
    if (this.options.baseUrl) return true;
    return cliAvailable("opencode");
  }

  /** Kill a serve child left behind by a previous daemon (verified by cmdline). */
  private async reapOrphanServe(): Promise<void> {
    const state = readProjectState(this.projectDir);
    const pid = Number(state.agents[this.id]?.servePid ?? 0);
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
    delete state.agents[this.id]?.servePid;
    writeProjectState(this.projectDir, state);
  }

  private recordServePid(pid: number | undefined): void {
    const state = readProjectState(this.projectDir);
    state.agents[this.id] = { ...state.agents[this.id], servePid: pid };
    writeProjectState(this.projectDir, state);
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
        { cwd: this.projectDir, stdio: "ignore", env: agentEnv() },
      );
      this.child = child;
      this.recordServePid(child.pid);
      child.on("close", (code) => {
        if (this.started) {
          this.emit({ kind: "error", payload: { message: `opencode serve exited (${code})` } });
          this.started = false;
        }
      });
    }
    await waitFor(async () => {
      await fetchJson(`${this.baseUrl}/api/health`);
      return true;
    });
    await this.assertModelAvailable();
    await this.ensureSession();
    this.startSse();
    this.started = true;
    this.emit({
      kind: "status",
      payload: { state: "ready", baseUrl: this.baseUrl, session: this.sessionId ?? null },
    });
  }

  private get sessionModel(): string | undefined {
    return readProjectState(this.projectDir).agents[this.id]?.sessionModel as string | undefined;
  }

  private set sessionModel(value: string | undefined) {
    const state = readProjectState(this.projectDir);
    state.agents[this.id] = { ...state.agents[this.id], sessionModel: value };
    writeProjectState(this.projectDir, state);
  }

  /**
   * A session whose model can't be resolved is a silent trap: opencode
   * "admits" prompts and never runs them (ModelUnavailableError only shows
   * in server logs). Validate against /api/model — the list of models the
   * server can actually run — and fail loudly with suggestions instead.
   */
  private async assertModelAvailable(): Promise<void> {
    if (!this.options.model) return;
    const res = await fetchJson<Json>(`${this.baseUrl}/api/model`).catch(() => null);
    const models = Array.isArray(res?.data) ? (res!.data as Json[]) : [];
    if (!models.length) return; // endpoint unavailable — don't block
    const ids = models.map((m) => `${String(m.providerID)}/${String(m.id)}`);
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
    const mySession = this.sessionId;

    if (type === "message.part.updated") {
      const part = (props.part ?? {}) as Json;
      if (part.sessionID && part.sessionID !== mySession) return;
      const partType = String(part.type ?? "");
      const messageID = String(part.messageID ?? "");
      if (partType === "text" && typeof part.text === "string") {
        if (!this.textParts.has(messageID)) this.textParts.set(messageID, new Map());
        this.textParts.get(messageID)!.set(String(part.id ?? "p"), part.text);
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
        // Errors are terminal immediately; otherwise require stability
        // across two polls so multi-step turns aren't cut short.
        if (newest!.finish === "error" || newest!.error) return newest!;
        if (stableId === String(newest!.id)) return newest!;
        stableId = String(newest!.id);
      } else {
        stableId = null;
      }
      await new Promise((r) => setTimeout(r, 3000));
    }
    return null;
  }

  async send(input: SendInput): Promise<void> {
    if (!this.started) await this.start();
    if (this._busy) throw new Error(`opencode agent "${this.id}" is busy`);
    this._busy = true;
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
      if (!turn) {
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
      }
      this.emit({ kind: "run_complete", payload: { durationMs: Date.now() - started } });
    } finally {
      this._busy = false;
    }
  }

  async interrupt(): Promise<void> {
    const sid = this.sessionId;
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
