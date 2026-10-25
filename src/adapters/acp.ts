/**
 * ACP adapter — drives any agent that speaks the Agent Client Protocol (agentclientprotocol.com)
 * over stdio: newline-delimited JSON-RPC 2.0, one warm process per Loom agent, one ACP session
 * per Loom chat.
 *
 *   initialize → session/new (or session/load to resume) → session/prompt
 *   ← session/update notifications (message/thought chunks, tool calls, plans)
 *   ← session/request_permission (answered by this agent's Loom mode)
 *   → session/cancel to interrupt
 *
 * One kind covers every ACP agent: Claude and Codex through their ACP adapters, Gemini CLI,
 * OpenCode, Grok — pick a preset, or give the command yourself.
 *
 * Permissions are Loom's, not the agent's: bypass picks the agent's own "allow" option; auto
 * runs Loom's Auto policy (core/auto-policy.ts) on the call; ask puts a real approval card in
 * Loom and on your phone. Anything that goes wrong answers "cancelled" — never a silent allow.
 *
 * Approach credit: Nuphos (github.com/nuphos/nuphos, Apache-2.0, © Zeabur Inc.), which runs its
 * agents behind ACP adapters. Loom's mapping of ACP updates to its events, and its permission
 * handling, are its own.
 */

import { type ChildProcess } from "node:child_process";
import { spawn } from "../core/process.js";
import { requestApproval } from "../core/approvals.js";
import { autoPolicyFor, decideAuto, refusalText } from "../core/auto-policy.js";
import { permissionFor } from "../core/permissions.js";
import type { SendInput } from "../types.js";
import { AdapterBase, agentEnv, cliAvailable } from "./base.js";

/** Ready-made commands for agents known to speak ACP. `command` in options wins. */
export const ACP_PRESETS: Record<string, { command: string[]; label: string; modes?: Partial<Record<"bypass" | "auto" | "ask", string>> }> = {
  claude: { command: ["npx", "-y", "@agentclientprotocol/claude-agent-acp"], label: "Claude Code (ACP)", modes: { bypass: "bypassPermissions", auto: "acceptEdits", ask: "default" } },
  codex: { command: ["npx", "-y", "@agentclientprotocol/codex-acp"], label: "Codex (ACP)" },
  gemini: { command: ["gemini", "--experimental-acp"], label: "Gemini CLI (ACP)" },
  opencode: { command: ["opencode", "acp"], label: "OpenCode (ACP)" },
  grok: { command: ["grok", "agent", "stdio"], label: "Grok (ACP)" },
};

interface AcpOptions {
  preset?: string;
  /** The agent command and its args, e.g. ["gemini", "--experimental-acp"]. */
  command?: string[] | string;
  env?: Record<string, string>;
  /** Loom mode → the agent's own session mode id (session/set_mode), when it has modes. */
  modes?: Partial<Record<"bypass" | "auto" | "ask", string>>;
  permissions?: string;
  loomProject?: string;
  /** A turn with no progress for this long is cancelled. Default 20 min. */
  idleTimeoutMs?: number;
}

type Json = Record<string, unknown>;
interface Pending { resolve: (v: unknown) => void; reject: (e: Error) => void }

/** The ACP "kind" of a tool call, as the name Loom's Auto policy knows. */
function policyTool(kind: string | undefined, raw: Json): { tool: string; input: Json } {
  if (kind === "execute") return { tool: "Bash", input: { command: String(raw.command ?? raw.cmd ?? (Array.isArray(raw.argv) ? raw.argv.join(" ") : "")) } };
  if (kind === "edit" || kind === "delete" || kind === "move") return { tool: "Write", input: { file_path: String(raw.path ?? raw.file_path ?? raw.abs_path ?? "") } };
  if (kind === "read") return { tool: "Read", input: { file_path: String(raw.path ?? raw.file_path ?? raw.abs_path ?? "") } };
  return { tool: kind ?? "tool", input: raw };
}

export class AcpAdapter extends AdapterBase {
  private child: ChildProcess | null = null;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private buffer = "";
  private ready: Promise<Json> | null = null;
  private caps: Json = {};
  /** sessionId → the turn listening to its updates. */
  private turnsBySession = new Map<string, (update: Json) => void>();
  /** Permission requests the agent is waiting on, answered "cancelled" on interrupt. */
  private asking = new Map<number, AbortController>();
  private current: { sessionId: string } | null = null;
  /** Replayed history (session/load) is the past, not this turn: ignored while loading. */
  private loading = new Set<string>();
  private options: AcpOptions;
  private stderrTail = "";

  constructor(id: string, projectDir: string, options: Record<string, unknown> = {}) {
    super(id, "acp", projectDir);
    this.options = options as AcpOptions;
  }

  private commandLine(): string[] {
    const c = this.options.command;
    if (Array.isArray(c) && c.length) return c.map(String);
    if (typeof c === "string" && c.trim()) return c.trim().split(/\s+/);
    const preset = this.options.preset ? ACP_PRESETS[this.options.preset] : undefined;
    if (preset) return preset.command;
    throw new Error(`ACP agent "${this.id}" needs options.command or options.preset (${Object.keys(ACP_PRESETS).join(", ")})`);
  }

  async available(): Promise<boolean> {
    try { return await cliAvailable(this.commandLine()[0]!); } catch { return false; }
  }

  async start(): Promise<void> {
    this.emit({ kind: "status", payload: { state: "ready" } });
  }

  async stop(): Promise<void> {
    await this.interrupt();
    this.child?.kill();
    this.child = null;
    this.ready = null;
  }

  // ── JSON-RPC over stdio ──

  private write(msg: Json): void {
    this.child?.stdin?.write(JSON.stringify({ jsonrpc: "2.0", ...msg }) + "\n");
  }

  private request(method: string, params: Json): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.write({ id, method, params });
    });
  }

  private onLine(line: string): void {
    let m: Json;
    try { m = JSON.parse(line) as Json; } catch { return; } // a log line on stdout: not ours
    if (m.method && m.id !== undefined) return void this.onAgentRequest(m.id as number, String(m.method), (m.params ?? {}) as Json);
    if (m.method) {
      if (m.method === "session/update") {
        const p = (m.params ?? {}) as { sessionId?: string; update?: Json };
        if (p.sessionId && !this.loading.has(p.sessionId)) this.turnsBySession.get(p.sessionId)?.(p.update ?? {});
      }
      return;
    }
    const waiter = this.pending.get(m.id as number);
    if (!waiter) return;
    this.pending.delete(m.id as number);
    if (m.error) waiter.reject(new Error(String((m.error as Json).message ?? JSON.stringify(m.error))));
    else waiter.resolve(m.result);
  }

  /** The agent asks us something: a permission, or (not advertised, so refused) a file or terminal. */
  private onAgentRequest(id: number, method: string, params: Json): void {
    if (method !== "session/request_permission") {
      this.write({ id, error: { code: -32601, message: `${method} isn't offered by Loom` } });
      return;
    }
    void this.decide(id, params).catch(() => this.write({ id, result: { outcome: { outcome: "cancelled" } } }));
  }

  private async decide(id: number, params: Json): Promise<void> {
    const options = (params.options ?? []) as Array<{ optionId: string; kind?: string; name?: string }>;
    const call = (params.toolCall ?? {}) as { title?: string; kind?: string; rawInput?: Json };
    const pick = (...kinds: string[]) => kinds.map((k) => options.find((o) => o.kind === k)).find(Boolean);
    const answer = (o: { optionId: string } | undefined) =>
      this.write({ id, result: { outcome: o ? { outcome: "selected", optionId: o.optionId } : { outcome: "cancelled" } } });
    const mode = permissionFor("acp", this.options as Record<string, unknown>);
    const raw = (call.rawInput ?? {}) as Json;
    if (mode === "bypass") return answer(pick("allow_always", "allow_once"));
    if (mode === "auto") {
      const { tool, input } = policyTool(call.kind, raw);
      const policy = autoPolicyFor(String(this.options.loomProject ?? "")) ?? { projectDir: this.projectDir, readPaths: [], allow: [] };
      const d = decideAuto(tool, input, policy);
      if (d.allow) return answer(pick("allow_once", "allow_always"));
      this.emit({ kind: "status", payload: { state: "auto_refused", text: refusalText(d) } });
      return answer(pick("reject_once", "reject_always"));
    }
    const ctl = new AbortController();
    this.asking.set(id, ctl);
    try {
      const allowAlways = pick("allow_always");
      const decision = await requestApproval({
        project: String(this.options.loomProject ?? ""), agent: this.id, tool: call.title ?? call.kind ?? "tool", input: raw,
        ...(call.title ? { summary: call.title } : {}), signal: ctl.signal, sessionOption: Boolean(allowAlways),
      });
      if (decision.behavior === "allow") return answer(decision.scope === "session" && allowAlways ? allowAlways : pick("allow_once", "allow_always"));
      return answer(pick("reject_once", "reject_always"));
    } finally {
      this.asking.delete(id);
    }
  }

  private boot(): Promise<Json> {
    if (this.ready) return this.ready;
    const [bin, ...args] = this.commandLine();
    const child = spawn(bin!, args, { cwd: this.projectDir, stdio: ["pipe", "pipe", "pipe"], env: { ...agentEnv(), ...(this.options.env ?? {}) } });
    this.child = child;
    child.stdout!.on("data", (d: Buffer) => {
      this.buffer += d.toString();
      let nl: number;
      while ((nl = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, nl).trim();
        this.buffer = this.buffer.slice(nl + 1);
        if (line) this.onLine(line);
      }
    });
    child.stderr!.on("data", (d: Buffer) => (this.stderrTail = (this.stderrTail + d.toString()).slice(-2000)));
    const gone = (why: string) => {
      if (this.child !== child) return;
      this.child = null;
      this.ready = null;
      for (const w of this.pending.values()) w.reject(new Error(`${why}${this.stderrTail ? `: ${this.stderrTail.trim().split("\n").slice(-3).join(" | ")}` : ""}`));
      this.pending.clear();
    };
    child.on("error", (e) => gone(`couldn't start ${bin}: ${e.message}`));
    child.on("close", (code) => gone(`the ACP agent exited (${code})`));
    this.ready = (this.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: "loom", version: "1" },
    }) as Promise<Json>).then((r) => { this.caps = (r?.agentCapabilities ?? {}) as Json; return r; });
    this.ready.catch(() => {});
    return this.ready;
  }

  /** This chat's ACP session: resumed when the agent can load one, made otherwise. */
  private async session(chat: string): Promise<string> {
    const sessions = (this.nativeState.read().sessions ?? {}) as Record<string, string>;
    const known = sessions[chat];
    const params = { cwd: this.projectDir, mcpServers: [] };
    let id: string | undefined;
    if (known && this.caps.loadSession) {
      this.loading.add(known);
      try { await this.request("session/load", { sessionId: known, ...params }); id = known; }
      catch { /* gone on the agent's side: a new one */ }
      finally { this.loading.delete(known); }
    } else if (known && this.liveSessions.has(known)) id = known;
    if (!id) {
      const r = (await this.request("session/new", params)) as { sessionId: string; modes?: { availableModes?: Array<{ id: string }> } };
      id = r.sessionId;
      const want = (this.options.modes ?? ACP_PRESETS[this.options.preset ?? ""]?.modes)?.[permissionFor("acp", this.options as Record<string, unknown>)];
      if (want && r.modes?.availableModes?.some((m) => m.id === want)) await this.request("session/set_mode", { sessionId: id, modeId: want }).catch(() => {});
      this.nativeState.patch({ sessions: { ...sessions, [chat]: id } });
    }
    this.liveSessions.add(id);
    return id;
  }
  private liveSessions = new Set<string>();

  async send(input: SendInput): Promise<void> {
    if (this._busy) throw new Error(`ACP agent "${this.id}" is busy`);
    this._busy = true;
    const started = Date.now();
    let text = "", thought = "", last = "";
    const flush = () => {
      if (thought.trim()) this.emit({ kind: "message", payload: { text: thought, reasoning: true } });
      if (text.trim()) { this.emit({ kind: "message", payload: { text } }); last = text.trim(); }
      thought = ""; text = "";
    };
    let idle: ReturnType<typeof setTimeout> | undefined;
    try {
      await this.boot();
      const sessionId = await this.session(input.chat ?? "main");
      this.current = { sessionId };
      const touch = () => {
        if (idle) clearTimeout(idle);
        idle = setTimeout(() => void this.interrupt(), this.options.idleTimeoutMs ?? 20 * 60_000);
      };
      touch();
      this.turnsBySession.set(sessionId, (u) => {
        touch();
        const kind = String(u.sessionUpdate ?? "");
        const content = (u.content ?? {}) as Json;
        if (kind === "agent_message_chunk" && typeof content.text === "string") { text += content.text; this.streamText(content.text); }
        else if (kind === "agent_thought_chunk" && typeof content.text === "string") { thought += content.text; this.streamText(content.text, true); }
        else if (kind === "tool_call" || kind === "tool_call_update") {
          flush();
          const items = Array.isArray(u.content) ? (u.content as Json[]) : [];
          if (kind === "tool_call") {
            this.emit({ kind: "tool_call", payload: { id: u.toolCallId, tool: u.title ?? u.kind ?? "tool", kind: u.kind, input: u.rawInput ?? {} } });
          }
          for (const c of items) {
            if (c.type === "diff" && typeof c.path === "string") {
              this.emit({ kind: "file_edit", payload: { path: c.path, summary: c.oldText ? "edited" : "created" } });
            }
          }
          if (kind === "tool_call_update" && (u.status === "completed" || u.status === "failed")) {
            const out = items.map((c) => ((c.content as Json | undefined)?.text ?? "")).filter(Boolean).join("\n");
            this.emit({ kind: "tool_result", payload: { id: u.toolCallId, ok: u.status === "completed", ...(out ? { output: String(out).slice(0, 4000) } : {}) } });
          }
        } else if (kind === "plan" && Array.isArray(u.entries)) {
          this.emit({ kind: "status", payload: { state: "plan_updated", entries: u.entries } });
        }
      });
      this.emit({ kind: "status", payload: { state: "turn_started", session: sessionId } });
      const prompt: Json[] = [];
      if (input.briefing?.trim()) prompt.push({ type: "text", text: `Carried-over session memory from Loom, authoritative for this project:\n\n${input.briefing.trim()}` });
      prompt.push({ type: "text", text: input.text });
      const result = (await this.request("session/prompt", { sessionId, prompt })) as { stopReason?: string; _meta?: Json; usage?: Json };
      flush();
      const stop = result?.stopReason ?? "end_turn";
      if (stop === "cancelled") { this.emit({ kind: "status", payload: { state: "interrupted" } }); return; }
      if (stop === "refusal") this.emit({ kind: "error", payload: { message: "the agent refused this prompt" } });
      else if (stop !== "end_turn") this.emit({ kind: "status", payload: { state: "stopped_early", reason: stop } });
      const usage = (result?.usage ?? (result?._meta?.usage as Json | undefined)) as { inputTokens?: number; outputTokens?: number } | undefined;
      this.emit({ kind: "run_complete", payload: { durationMs: Date.now() - started, ...(usage?.inputTokens || usage?.outputTokens ? { inputTokens: usage.inputTokens ?? 0, outputTokens: usage.outputTokens ?? 0 } : {}) } });
      // ACP has no structured question: an answer that ends asking one is waiting on you
      if (/\?\s*$/.test(last)) this.emit({ kind: "needs_input", payload: { question: last.slice(-500) } });
    } catch (e) {
      flush();
      this.emit({ kind: "error", payload: { message: (e as Error).message } });
      throw e;
    } finally {
      if (idle) clearTimeout(idle);
      if (this.current) this.turnsBySession.delete(this.current.sessionId);
      this.current = null;
      this._busy = false;
    }
  }

  async interrupt(): Promise<void> {
    for (const [id, ctl] of this.asking) { ctl.abort(); this.write({ id, result: { outcome: { outcome: "cancelled" } } }); }
    this.asking.clear();
    if (this.current) this.write({ method: "session/cancel", params: { sessionId: this.current.sessionId } });
  }
}
