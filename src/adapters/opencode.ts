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

import { spawn, type ChildProcess } from "node:child_process";
import type { SendInput } from "../types.js";
import { readProjectState, writeProjectState } from "../core/registry.js";
import { AdapterBase, cliAvailable, fetchJson, freePort, waitFor } from "./base.js";

interface OpenCodeOptions {
  /** Reuse an already-running server instead of spawning one. */
  baseUrl?: string;
  /** Extra args for `opencode serve`. */
  extraArgs?: string[];
}

type Json = Record<string, unknown>;

export class OpenCodeAdapter extends AdapterBase {
  private child: ChildProcess | null = null;
  private baseUrl: string | null = null;
  private sseAbort: AbortController | null = null;
  private options: OpenCodeOptions;
  private started = false;

  /** text parts per in-flight assistant message */
  private textParts = new Map<string, Map<string, string>>();
  private roles = new Map<string, string>();

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

  async start(): Promise<void> {
    if (this.started) return;
    if (this.options.baseUrl) {
      this.baseUrl = this.options.baseUrl.replace(/\/$/, "");
    } else {
      const port = await freePort();
      this.baseUrl = `http://127.0.0.1:${port}`;
      const child = spawn(
        "opencode",
        ["serve", "--port", String(port), "--hostname", "127.0.0.1", ...(this.options.extraArgs ?? [])],
        { cwd: this.projectDir, stdio: "ignore", env: process.env },
      );
      this.child = child;
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
    await this.ensureSession();
    this.startSse();
    this.started = true;
    this.emit({
      kind: "status",
      payload: { state: "ready", baseUrl: this.baseUrl, session: this.sessionId ?? null },
    });
  }

  private async ensureSession(): Promise<string> {
    const existing = this.sessionId;
    if (existing) {
      try {
        await fetchJson(`${this.baseUrl}/api/session/${existing}`);
        return existing;
      } catch {
        // stale session (server state moved on) — create a fresh one
      }
    }
    const res = await fetchJson<Json>(`${this.baseUrl}/api/session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    const data = (res.data ?? res) as Json;
    const id = String(data.id ?? "");
    if (!id) throw new Error("opencode: could not create session");
    this.sessionId = id;
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
    const props = (evt.properties ?? evt) as Json;
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
          if (text) this.emit({ kind: "message", payload: { text } });
        }
        this.textParts.delete(messageID);
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

  async send(input: SendInput): Promise<void> {
    if (!this.started) await this.start();
    if (this._busy) throw new Error(`opencode agent "${this.id}" is busy`);
    this._busy = true;
    const started = Date.now();
    try {
      const sid = await this.ensureSession();
      // No per-prompt system field in the API, so the handoff briefing is
      // prepended to the first turn, clearly delimited.
      const text = input.briefing
        ? `${input.briefing}\n\n--- user message ---\n${input.text}`
        : input.text;
      await fetchJson(`${this.baseUrl}/api/session/${sid}/prompt`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt: { text } }),
      });
      try {
        // Blocks until the session goes idle. Generous ceiling for long turns.
        await fetchJson(
          `${this.baseUrl}/api/session/${sid}/wait`,
          { method: "POST", headers: { "content-type": "application/json" }, body: "{}" },
          60 * 60 * 1000,
        );
      } catch (err) {
        this.emit({
          kind: "status",
          payload: { state: "wait_failed", detail: String(err).slice(0, 200) },
        });
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
