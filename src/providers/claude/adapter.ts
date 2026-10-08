/**
 * Claude Code on the provider contract: one warm Agent SDK query per chat
 * session, fed by a streaming-input prompt queue.
 *
 *   query({ prompt: queue, options })  → initializationResult()   (startSession)
 *   queue.push(user message)            → … stream … → result      (sendTurn, many per process)
 *   query.setModel(model)                                          (model switch, in-session)
 *
 * The CLI stays up between turns, so a follow-up is one user message on an
 * open stream rather than a process launch and a session resume. SDK messages
 * are mapped onto the canonical runtime events; nothing above this file reads
 * one.
 *
 * Ported from t3code (MIT, © T3 Tools Inc.):
 *   apps/server/src/provider/Layers/ClaudeAdapter.ts — startSession (prompt
 *   queue, query options, session id chosen up front), sendTurn (setModel, the
 *   user message carries the turn id), interruptTurn (a hard session boundary:
 *   the query is closed, because interrupt() can acknowledge while background
 *   tasks keep the CLI alive), canUseTool, and the stream/result handling.
 * Loom spawns the CLI itself (spawnClaudeCodeProcess) so each session owns a
 * process group, and stopping it proves every tool it started is gone.
 */

import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  query, type CanUseTool, type McpServerConfig, type Options, type PermissionResult, type PermissionUpdate, type Query, type SDKMessage,
  type SDKUserMessage, type SpawnedProcess,
} from "@anthropic-ai/claude-agent-sdk";
import { guardNativeOutput } from "../../adapters/base.js";
import { EventHub, type ProviderAdapter } from "../adapter.js";
import type {
  AdapterCapabilities, ApprovalDecision, CanonicalItemType, CanonicalRequestType, InstanceId, ItemLifecyclePayload, ToolImage,
  ProviderRuntimeEvent, ProviderSession, RequestId, RuntimeEventPayloads, RuntimeEventType, RuntimeMode, SendTurnInput,
  SessionStartInput, ThreadId, TurnId, TurnStartResult, UserInputAnswers, UserInputQuestion,
} from "../contracts.js";
import { ProviderError } from "../errors.js";
import { spawnHarness, stopHarness, type HarnessProcess } from "../process.js";

export interface ClaudeAdapterOptions {
  /** Path to the claude binary, when it isn't `claude` on PATH. */
  bin?: string;
  /** Claude permission mode, overriding the runtime mode; e.g. "acceptEdits". */
  permissionMode?: string;
  /** Extra CLI args (`["--flag", "value", "--switch"]`), escape hatch. */
  extraArgs?: string[];
  /** Project MCP servers, applied when the session starts. */
  mcpServers?: () => Record<string, McpServerConfig> | undefined;
  /** Whether a person can answer approvals; without one, approval-required runs read-only (plan). */
  canAsk?: () => boolean;
  /** How long to wait for the CLI to initialize. */
  startTimeoutMs?: number;
}

/**
 * Where `claude` lives when it isn't on PATH. The installer puts it in
 * ~/.local/bin, which a daemon started from the desktop app often doesn't
 * have on PATH. PATH is still the last word.
 */
export function claudeBin(override?: string): string | null {
  if (override) return fs.existsSync(override) ? override : null;
  const home = process.env.HOME ?? "";
  for (const p of [`${home}/.local/bin/claude`, "/opt/homebrew/bin/claude", "/usr/local/bin/claude", `${home}/.bun/bin/claude`, `${home}/.volta/bin/claude`]) {
    if (p && fs.existsSync(p)) return p;
  }
  return "claude";
}

const MISSING_SESSION = /No conversation found|session .* (?:not found|does not exist)/i;
const WINDOW_MINUTES: Record<string, number> = { five_hour: 300, seven_day: 10_080, seven_day_opus: 10_080, seven_day_sonnet: 10_080 };
const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

/** What a person may answer to a Claude tool approval. */
const APPROVAL_OPTIONS: Array<{ decision: ApprovalDecision; label: string }> = [
  { decision: "accept", label: "Allow" },
  { decision: "acceptForSession", label: "Allow for this session" },
  { decision: "decline", label: "Deny" },
];

/** `["--a", "1", "--b"]` → `{ a: "1", b: null }`, the SDK's extraArgs shape. */
export function extraArgsRecord(args: unknown): Record<string, string | null> | undefined {
  if (args === undefined) return undefined;
  if (!Array.isArray(args) || args.some(a => typeof a !== "string")) throw new Error("extraArgs must be a list of strings");
  if (!args.length) return undefined;
  const out: Record<string, string | null> = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (!arg.startsWith("--")) continue;
    const eq = arg.indexOf("=");
    if (eq > 0) { out[arg.slice(2, eq)] = arg.slice(eq + 1); continue; }
    const next = args[i + 1];
    out[arg.slice(2)] = next !== undefined && !next.startsWith("--") ? (i++, next) : null;
  }
  return out;
}

/** t3code's classifyToolItemType, for the tools Claude Code ships. */
export function claudeToolItemType(name: string): CanonicalItemType {
  if (name === "Bash" || name === "BashOutput") return "command_execution";
  if (EDIT_TOOLS.has(name)) return "file_change";
  if (name.startsWith("mcp__")) return "mcp_tool_call";
  if (name === "WebSearch" || name === "WebFetch") return "web_search";
  if (name === "Task" || name === "Agent") return "collab_agent_tool_call";
  return "dynamic_tool_call";
}

function requestTypeFor(name: string): CanonicalRequestType {
  const t = claudeToolItemType(name);
  if (t === "command_execution") return "command_execution_approval";
  if (t === "file_change") return "file_change_approval";
  if (name === "Read" || name === "Glob" || name === "Grep" || name === "LS") return "file_read_approval";
  return "unknown";
}

export function summarizeToolInput(name: string, input: Record<string, unknown>): string {
  if (name === "TodoWrite" && Array.isArray(input.todos)) {
    const todos = input.todos as Array<{ status?: string }>;
    return `TodoWrite: ${todos.filter(t => t.status === "completed").length}/${todos.length} done`;
  }
  const interesting = input.file_path ?? input.notebook_path ?? input.command ?? input.query ?? input.pattern ?? input.url ?? input.description ?? input.prompt ?? "";
  return `${name}: ${String(interesting).replace(/\s+/g, " ").slice(0, 160)}`;
}

/** Tokens now in context from a main-thread response's usage: its last
 * server-side iteration when present, input (with cache) plus output. */
export function activeTokens(value: unknown): number {
  if (!value || typeof value !== "object") return 0;
  const usage = value as Record<string, unknown>;
  const iterations = Array.isArray(usage.iterations) ? usage.iterations : [];
  const u = (iterations.length ? iterations[iterations.length - 1] : usage) as Record<string, unknown>;
  const n = (k: string) => (typeof u[k] === "number" && Number.isFinite(u[k]) ? Math.max(0, u[k] as number) : 0);
  if (n("total_tokens") > 0) return n("total_tokens");
  return n("input_tokens") + n("cache_read_input_tokens") + n("cache_creation_input_tokens") + n("output_tokens");
}

/** An unbounded async queue: the streaming-input prompt. */
class PromptQueue implements AsyncIterable<SDKUserMessage> {
  private readonly items: SDKUserMessage[] = [];
  private waiting: ((r: IteratorResult<SDKUserMessage>) => void) | null = null;
  private closed = false;

  push(message: SDKUserMessage): void {
    if (this.closed) throw new Error("prompt queue is closed");
    if (this.waiting) { const w = this.waiting; this.waiting = null; w({ value: message, done: false }); }
    else this.items.push(message);
  }

  close(): void {
    this.closed = true;
    if (this.waiting) { const w = this.waiting; this.waiting = null; w({ value: undefined, done: true }); }
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: () => {
        const item = this.items.shift();
        if (item) return Promise.resolve({ value: item, done: false });
        if (this.closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise(resolve => { this.waiting = resolve; });
      },
      return: () => { this.close(); return Promise.resolve({ value: undefined, done: true }); },
    };
  }
}

interface Tool { name: string; input: Record<string, unknown>; itemType: CanonicalItemType; declined?: boolean }

interface Turn {
  id: TurnId;
  model?: string;
  /** The message id of the response being streamed, for delta item ids. */
  streamingMessageId?: string;
}

interface PendingRequest { requestType: CanonicalRequestType; turnId?: TurnId; toolUseId?: string; resolve: (d: ApprovalDecision) => void }

interface Session {
  info: ProviderSession;
  sessionId: string;
  query: Query;
  prompts: PromptQueue;
  proc: HarnessProcess | null;
  turn: Turn | null;
  tools: Map<string, Tool>;
  pending: Map<RequestId, PendingRequest>;
  inputs: Map<RequestId, { turnId?: TurnId; resolve: (answers: UserInputAnswers) => void }>;
  /** The permission mode the session started in; plan turns switch away and back. */
  basePermissionMode?: NonNullable<Options["permissionMode"]>;
  planMode: boolean;
  /** Largest context window a result has reported; outlives turns. */
  contextWindow?: number;
  used?: number;
  compactions: number;
  stopping: boolean;
  /** Why the session is being torn down, when it is a failure (not a stop). */
  failure?: string;
  /** The stream loop, which ends when the CLI does. */
  done: Promise<void>;
}

export class ClaudeProviderAdapter implements ProviderAdapter {
  readonly provider = "claude-code" as const;
  readonly capabilities: AdapterCapabilities = { sessionModelSwitch: "in-session", supportsConversationRollback: false, manualCompaction: false };
  private readonly sessions = new Map<ThreadId, Session>();
  private readonly hub = new EventHub<ProviderRuntimeEvent>();

  constructor(readonly instanceId: InstanceId, private readonly options: ClaudeAdapterOptions = {}) {}

  onEvent(listener: (event: ProviderRuntimeEvent) => void): () => void { return this.hub.subscribe(listener); }
  listSessions(): ProviderSession[] { return [...this.sessions.values()].map(s => ({ ...s.info })); }
  hasSession(threadId: ThreadId): boolean { return this.sessions.has(threadId); }

  private emit<K extends RuntimeEventType>(threadId: ThreadId, type: K, payload: RuntimeEventPayloads[K],
    extra: { turnId?: TurnId; itemId?: string; requestId?: RequestId } = {}): void {
    this.hub.publish({ eventId: randomUUID(), provider: this.provider, instanceId: this.instanceId, threadId, createdAt: Date.now(),
      ...(extra.turnId ? { turnId: extra.turnId } : {}), ...(extra.itemId ? { itemId: extra.itemId } : {}),
      ...(extra.requestId ? { requestId: extra.requestId } : {}), type, payload } as ProviderRuntimeEvent);
  }

  // ---- sessions ------------------------------------------------------------

  async startSession(input: SessionStartInput): Promise<ProviderSession> {
    if (this.sessions.has(input.threadId)) await this.stopSession(input.threadId);
    const fail = (code: "transport" | "request" | "session_missing" | "validation", message: string, cause?: unknown) =>
      new ProviderError(code, "startSession", message, { provider: this.provider, instanceId: this.instanceId, threadId: input.threadId, mayHaveStarted: false, cause });
    const bin = claudeBin(this.options.bin);
    if (!bin) throw fail("transport", "claude CLI not found — install Claude Code or set its path");
    let extraArgs: Record<string, string | null> | undefined;
    try { extraArgs = extraArgsRecord(this.options.extraArgs); }
    catch (error) { throw fail("validation", (error as Error).message); }

    const resume = typeof input.resumeCursor === "string" && input.resumeCursor ? input.resumeCursor : undefined;
    const sessionId = resume ?? randomUUID();
    const prompts = new PromptQueue();
    const model = input.modelSelection?.model;
    const mcpServers = this.options.mcpServers?.();
    const now = Date.now();
    const session = {
      info: { provider: this.provider, instanceId: this.instanceId, threadId: input.threadId, status: "connecting",
        runtimeMode: input.runtimeMode, cwd: input.cwd, resumeCursor: sessionId, createdAt: now, updatedAt: now, ...(model ? { model } : {}) },
      sessionId, prompts, proc: null, turn: null, tools: new Map(), pending: new Map(), inputs: new Map(), planMode: false, compactions: 0, stopping: false,
    } as Omit<Session, "query" | "done"> as Session;

    const options: Options = {
      cwd: input.cwd,
      pathToClaudeCodeExecutable: bin,
      // Claude Code's own system prompt and the user's/project's settings, as
      // an interactive `claude` would load them.
      systemPrompt: { type: "preset", preset: "claude_code" },
      settingSources: ["user", "project", "local"],
      includePartialMessages: true,
      ...this.permissions(session, input.runtimeMode),
      ...(resume ? { resume } : { sessionId }),
      ...(model ? { model } : {}),
      ...(input.modelSelection?.effort ? { effort: input.modelSelection.effort as NonNullable<Options["effort"]> } : {}),
      ...(mcpServers && Object.keys(mcpServers).length ? { mcpServers } : {}),
      ...(extraArgs ? { extraArgs } : {}),
      spawnClaudeCodeProcess: spawnOptions => {
        const proc = spawnHarness(spawnOptions.command, spawnOptions.args, { cwd: spawnOptions.cwd ?? input.cwd,
          env: spawnOptions.env as NodeJS.ProcessEnv });
        session.proc = proc;
        guardNativeOutput(proc.child, error => {
          session.failure = error.message;
          if (!session.turn) this.emit(input.threadId, "runtime.error", { message: error.message, class: "transport_error" });
          void this.stopSession(input.threadId).catch(() => {});
        });
        const onAbort = () => { void stopHarness(proc, 0).catch(() => {}); };
        if (spawnOptions.signal.aborted) onAbort();
        else spawnOptions.signal.addEventListener("abort", onAbort, { once: true });
        return proc.child as unknown as SpawnedProcess;
      },
    };

    this.emit(input.threadId, "session.state.changed", { state: "starting" });
    let q: Query;
    try { q = query({ prompt: prompts, options }); }
    catch (error) { throw fail("transport", `claude could not start: ${(error as Error).message}`, error); }
    session.query = q;
    session.done = this.consume(session);

    const timeoutMs = this.options.startTimeoutMs ?? 60_000;
    try {
      // A resume of a session the CLI doesn't have fails here, before any
      // prompt is read: "No conversation found with session ID".
      await Promise.race([q.initializationResult(),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`claude did not initialize within ${Math.round(timeoutMs / 1000)}s`)), timeoutMs).unref())]);
    } catch (error) {
      session.stopping = true;
      prompts.close();
      try { q.close(); } catch { /* already closed */ }
      if (session.proc) await stopHarness(session.proc, 0).catch(() => {});
      const stderr = session.proc?.stderr().trim() ?? "";
      if (resume && MISSING_SESSION.test(`${(error as Error).message}\n${stderr}`)) throw fail("session_missing", `claude session ${resume} could not be resumed`, error);
      const failure = fail("transport", `claude could not start: ${(error as Error).message}`.slice(0, 500), error);
      if (stderr) failure.details.stderr = stderr;
      throw failure;
    }
    session.info = { ...session.info, status: "ready", updatedAt: Date.now() };
    this.sessions.set(input.threadId, session);
    this.emit(input.threadId, "session.started", resume ? { resume } : {});
    this.emit(input.threadId, "thread.started", { providerThreadId: sessionId });
    this.emit(input.threadId, "session.state.changed", { state: "ready" });
    return { ...session.info };
  }

  /** Permission mode and approval callback from the runtime mode. */
  /**
   * Permission mode from the runtime mode, and a `canUseTool` in every mode (as
   * t3code has it): questions (AskUserQuestion) and plans (ExitPlanMode) reach
   * Loom whatever the mode. Other tools the CLI asks about are allowed in full
   * access, put to a person in approval-required, and denied in auto — Loom's
   * auto never stops to ask; a tool runs there only if Claude's settings allow it.
   */
  private permissions(s: Session, mode: RuntimeMode): Pick<Options, "permissionMode" | "canUseTool" | "allowDangerouslySkipPermissions"> {
    const permissionMode = (this.options.permissionMode as NonNullable<Options["permissionMode"]> | undefined)
      ?? (mode === "full-access" ? "bypassPermissions" : mode === "auto-accept-edits" ? "acceptEdits"
        // Approval-required needs someone to ask; with nobody, it runs read-only (plan), never "allow".
        : this.options.canAsk && !this.options.canAsk() ? "plan" : "default");
    s.basePermissionMode = permissionMode;
    const canUseTool: CanUseTool = (tool, toolInput, { signal, toolUseID, suggestions }) =>
      this.canUseTool(s, tool, toolInput, signal, toolUseID, suggestions);
    return { permissionMode, canUseTool, ...(permissionMode === "bypassPermissions" ? { allowDangerouslySkipPermissions: true } : {}) };
  }

  private async canUseTool(s: Session, tool: string, toolInput: Record<string, unknown>, signal: AbortSignal, toolUseId?: string,
    suggestions?: PermissionUpdate[]): Promise<PermissionResult> {
    if (s.stopping) return { behavior: "deny", message: "Session stopped." };
    if (tool === "AskUserQuestion") return this.askUser(s, toolInput, signal, toolUseId);
    if (tool === "ExitPlanMode") {
      // t3code: the client captures the plan; the model stops and waits.
      const plan = typeof toolInput.plan === "string" ? toolInput.plan.trim() : "";
      if (plan) this.emit(s.info.threadId, "turn.proposed.completed", { planMarkdown: plan }, s.turn ? { turnId: s.turn.id } : {});
      return { behavior: "deny", message: "The client captured your proposed plan. Stop here and wait for the user's feedback or implementation request in a later turn." };
    }
    const base = s.basePermissionMode;
    if (base === "bypassPermissions") return { behavior: "allow", updatedInput: toolInput };
    if (base === "acceptEdits" || base === "plan" || base === "dontAsk")
      return { behavior: "deny", message: `${tool} is not allowed in this permission mode. Loom's Auto mode never stops to ask; allow the tool in Claude's settings or switch this agent to Always ask.` };
    const requestId = randomUUID();
    const requestType = requestTypeFor(tool);
    const turnId = s.turn?.id;
    const decision = await new Promise<ApprovalDecision>(resolve => {
      s.pending.set(requestId, { requestType, resolve, ...(turnId ? { turnId } : {}), ...(toolUseId ? { toolUseId } : {}) });
      const onAbort = () => this.resolvePending(s, requestId, "cancel");
      signal.addEventListener("abort", onAbort, { once: true });
      this.emit(s.info.threadId, "request.opened", { requestType, detail: summarizeToolInput(tool, toolInput),
        args: { tool, input: toolInput }, options: APPROVAL_OPTIONS },
      { requestId, ...(turnId ? { turnId } : {}), ...(toolUseId ? { itemId: toolUseId } : {}) });
      if (signal.aborted) onAbort();
    });
    if (decision === "accept") return { behavior: "allow", updatedInput: toolInput };
    // t3code's toSessionPermissionUpdates: the CLI's own suggestions, scoped to this session.
    if (decision === "acceptForSession") return { behavior: "allow", updatedInput: toolInput,
      updatedPermissions: suggestions?.length ? suggestions.map(u => ({ ...u, destination: "session" as const }))
        : [{ type: "addRules", rules: [{ toolName: tool }], behavior: "allow", destination: "session" }] };
    if (toolUseId) { const t = s.tools.get(toolUseId); if (t) t.declined = true; }
    return { behavior: "deny", message: decision === "cancel" ? "User cancelled tool execution." : "Denied in Loom." };
  }

  /**
   * AskUserQuestion → `user-input.requested`, and the answers back as the
   * tool's input (t3code's handleAskUserQuestion). A question's id is its
   * text: the SDK looks answers up by question text.
   */
  private async askUser(s: Session, toolInput: Record<string, unknown>, signal: AbortSignal, toolUseId?: string): Promise<PermissionResult> {
    const raw = Array.isArray(toolInput.questions) ? toolInput.questions as Array<Record<string, unknown>> : [];
    const questions: UserInputQuestion[] = raw.map((q, i) => ({
      id: typeof q.question === "string" && q.question ? q.question : `q-${i}`,
      header: typeof q.header === "string" ? q.header : `Question ${i + 1}`,
      question: typeof q.question === "string" ? q.question : "",
      options: (Array.isArray(q.options) ? q.options as Array<Record<string, unknown>> : [])
        .map(o => ({ label: typeof o.label === "string" ? o.label : "", description: typeof o.description === "string" ? o.description : "" })),
      multiSelect: q.multiSelect === true,
      allowCustomAnswer: true,
    }));
    const requestId = randomUUID();
    const turnId = s.turn?.id;
    let aborted = false;
    const answers = await new Promise<UserInputAnswers>(resolve => {
      s.inputs.set(requestId, { resolve, ...(turnId ? { turnId } : {}) });
      const onAbort = () => { aborted = true; this.resolveInput(s, requestId, {}); };
      signal.addEventListener("abort", onAbort, { once: true });
      this.emit(s.info.threadId, "user-input.requested", { questions }, { requestId, ...(turnId ? { turnId } : {}), ...(toolUseId ? { itemId: toolUseId } : {}) });
      if (signal.aborted) onAbort();
    });
    if (aborted || s.stopping || !Object.keys(answers).length) return { behavior: "deny", message: "User cancelled tool execution." };
    const flat = Object.fromEntries(Object.entries(answers).map(([k, v]) => [k, Array.isArray(v) ? v.map(String).join(", ") : String(v)]));
    return { behavior: "allow", updatedInput: { questions: toolInput.questions, answers: flat } };
  }

  private resolveInput(s: Session, requestId: RequestId, answers: UserInputAnswers): boolean {
    const pending = s.inputs.get(requestId);
    if (!pending) return false;
    s.inputs.delete(requestId);
    pending.resolve(answers);
    this.emit(s.info.threadId, "user-input.resolved", { answers }, { requestId, ...(pending.turnId ? { turnId: pending.turnId } : {}) });
    return true;
  }

  private resolvePending(s: Session, requestId: RequestId, decision: ApprovalDecision): boolean {
    const pending = s.pending.get(requestId);
    if (!pending) return false;
    s.pending.delete(requestId);
    pending.resolve(decision);
    this.emit(s.info.threadId, "request.resolved", { requestType: pending.requestType, decision },
      { requestId, ...(pending.turnId ? { turnId: pending.turnId } : {}) });
    return true;
  }

  private session(threadId: ThreadId, operation: string): Session {
    const s = this.sessions.get(threadId);
    if (!s || s.stopping) throw new ProviderError("not_found", operation, `no live claude session for chat "${threadId}"`,
      { provider: this.provider, instanceId: this.instanceId, threadId, mayHaveStarted: false });
    return s;
  }

  async sendTurn(input: SendTurnInput): Promise<TurnStartResult> {
    const s = this.session(input.threadId, "sendTurn");
    const refuse = (message: string, cause?: unknown) => new ProviderError("request", "sendTurn", message,
      { provider: this.provider, instanceId: this.instanceId, threadId: input.threadId, mayHaveStarted: false, cause });
    if (s.turn) throw new ProviderError("validation", "sendTurn", "a claude turn is already running in this chat",
      { provider: this.provider, instanceId: this.instanceId, threadId: input.threadId, mayHaveStarted: false });
    const model = input.modelSelection?.model;
    if (model && model !== s.info.model) {
      try { await s.query.setModel(model); }
      catch (error) { throw refuse(`claude could not switch to model ${model}: ${(error as Error).message}`, error); }
      s.info = { ...s.info, model };
    }
    // Plan mode is Claude's own permission mode, switched per turn (t3code).
    const wantPlan = input.interactionMode === "plan";
    if (wantPlan !== s.planMode) {
      try { await s.query.setPermissionMode(wantPlan ? "plan" : s.basePermissionMode ?? "default"); }
      catch (error) { throw refuse(`claude could not ${wantPlan ? "enter" : "leave"} plan mode: ${(error as Error).message}`, error); }
      s.planMode = wantPlan;
    }
    const turnId = randomUUID();
    s.turn = { id: turnId, ...(s.info.model ? { model: s.info.model } : {}) };
    s.info = { ...s.info, status: "running", activeTurnId: turnId, updatedAt: Date.now() };
    this.emit(input.threadId, "turn.started", s.info.model ? { model: s.info.model } : {}, { turnId });
    try {
      s.prompts.push({ type: "user", message: { role: "user", content: [{ type: "text", text: input.input }] },
        parent_tool_use_id: null, uuid: turnId } as SDKUserMessage);
    } catch (error) {
      s.turn = null;
      delete s.info.activeTurnId;
      this.emit(input.threadId, "turn.aborted", { reason: "the claude session closed before the turn was sent" }, { turnId });
      throw refuse("the claude session closed before the turn was sent", error);
    }
    return { threadId: input.threadId, turnId, resumeCursor: s.sessionId };
  }

  /** A hard boundary, as t3code has it: close the query and its process group. The next turn resumes. */
  async interruptTurn(threadId: ThreadId): Promise<void> {
    if (!this.sessions.has(threadId)) return;
    await this.stopSession(threadId);
  }

  async respondToRequest(threadId: ThreadId, requestId: RequestId, decision: ApprovalDecision): Promise<void> {
    const s = this.session(threadId, "respondToRequest");
    if (!this.resolvePending(s, requestId, decision))
      throw new ProviderError("not_found", "respondToRequest", `no open claude request "${requestId}"`, { provider: this.provider, threadId });
  }

  async respondToUserInput(threadId: ThreadId, requestId: RequestId, answers: UserInputAnswers): Promise<void> {
    const s = this.session(threadId, "respondToUserInput");
    if (!this.resolveInput(s, requestId, answers))
      throw new ProviderError("not_found", "respondToUserInput", `no open claude question "${requestId}"`, { provider: this.provider, threadId });
  }

  async stopSession(threadId: ThreadId): Promise<void> {
    const s = this.sessions.get(threadId);
    if (!s) return;
    if (!s.stopping) {
      s.stopping = true;
      for (const id of [...s.pending.keys()]) this.resolvePending(s, id, "cancel");
      for (const id of [...s.inputs.keys()]) this.resolveInput(s, id, {});
      s.prompts.close();
      try { s.query.close(); } catch { /* already closed */ }
    }
    try {
      if (s.proc) await stopHarness(s.proc, 0);
      await Promise.race([s.done, new Promise(resolve => setTimeout(resolve, 3000).unref())]);
    } finally {
      if (s.failure) this.closed(s, s.failure, "error", "aborted");
      else this.closed(s, "session stopped", "graceful", "interrupted");
    }
  }

  async stopAll(): Promise<void> {
    const results = await Promise.allSettled([...this.sessions.keys()].map(id => this.stopSession(id)));
    const failed = results.find((r): r is PromiseRejectedResult => r.status === "rejected");
    if (failed) throw failed.reason;
  }

  /** The session is over: end its turn and report the exit (once). */
  private closed(s: Session, reason: string, exitKind: "graceful" | "error", turnEnd: "interrupted" | "aborted", stderr = ""): void {
    const threadId = s.info.threadId;
    if (this.sessions.get(threadId) !== s) return;
    this.sessions.delete(threadId);
    if (s.turn) {
      const turnId = s.turn.id;
      s.turn = null;
      if (turnEnd === "interrupted") this.emit(threadId, "turn.completed", { state: "interrupted", stopReason: reason }, { turnId });
      else this.emit(threadId, "turn.aborted", { reason: `${reason} before the turn completed; native outcome is unknown`,
        ...(stderr ? { detail: { stderr } } : {}) }, { turnId });
    }
    delete s.info.activeTurnId;
    s.info = { ...s.info, status: exitKind === "error" ? "error" : "closed", updatedAt: Date.now() };
    this.emit(threadId, "session.exited", { reason, exitKind, recoverable: true });
  }

  /** Read the SDK stream until the CLI goes away. */
  private async consume(s: Session): Promise<void> {
    let failure: string | null = null;
    try {
      for await (const msg of s.query) {
        try { this.handle(s, msg); }
        catch (error) { failure = `claude event handling failed: ${(error as Error).message}`; break; }
      }
    } catch (error) {
      failure = (error as Error).message;
    }
    if (s.stopping) return;
    s.stopping = true;
    for (const id of [...s.pending.keys()]) this.resolvePending(s, id, "cancel");
    for (const id of [...s.inputs.keys()]) this.resolveInput(s, id, {});
    s.prompts.close();
    try { s.query.close(); } catch { /* already closed */ }
    if (s.proc) await stopHarness(s.proc, 0).catch(() => {});
    const stderr = s.proc?.stderr().trim() ?? "";
    const reason = `claude exited${failure ? `: ${failure}`.slice(0, 300) : ""}${stderr ? ` — ${stderr.slice(-300)}` : ""}`;
    this.closed(s, reason, failure ? "error" : "graceful", "aborted", stderr);
  }

  // ---- SDK → canonical -----------------------------------------------------

  private handle(s: Session, msg: SDKMessage): void {
    const threadId = s.info.threadId;
    const turnId = s.turn?.id;
    const at = turnId ? { turnId } : {};
    switch (msg.type) {
      case "system":
        if (msg.subtype === "init") {
          if (typeof msg.model === "string" && msg.model) s.info = { ...s.info, model: msg.model };
          if (msg.session_id && msg.session_id !== s.sessionId) {
            s.sessionId = msg.session_id;
            s.info = { ...s.info, resumeCursor: msg.session_id };
            this.emit(threadId, "thread.started", { providerThreadId: msg.session_id });
          }
        } else if (msg.subtype === "status") {
          if (msg.status === "compacting") this.emit(threadId, "item.started", { itemType: "context_compaction", status: "inProgress" },
            { ...at, itemId: `compaction:${++s.compactions}` });
          if (msg.compact_result === "failed")
            this.emit(threadId, "runtime.warning", { message: `compaction failed${msg.compact_error ? `: ${msg.compact_error}` : ""}` }, at);
        } else if (msg.subtype === "compact_boundary") {
          // Native compaction: the session now holds a summary, not its history.
          const meta = msg.compact_metadata;
          this.emit(threadId, "thread.state.changed", { state: "compacted", trigger: meta.trigger === "manual" ? "manual" : "auto",
            ...(typeof meta.pre_tokens === "number" ? { beforeTokens: meta.pre_tokens } : {}),
            ...(typeof meta.post_tokens === "number" ? { afterTokens: meta.post_tokens } : {}) }, at);
          if (typeof meta.post_tokens === "number" && meta.post_tokens > 0) { s.used = meta.post_tokens; this.contextUsage(s, at); }
        }
        return;
      case "stream_event": {
        if (msg.parent_tool_use_id) return; // a sub-agent's narration is not this chat's
        const event = msg.event as unknown as { type: string; index?: number; message?: { id?: string };
          delta?: { type?: string; text?: string; thinking?: string } };
        if (event.type === "message_start") { if (s.turn && event.message?.id) s.turn.streamingMessageId = event.message.id; return; }
        if (event.type !== "content_block_delta" || !s.turn) return;
        const d = event.delta;
        const text = d?.type === "text_delta" ? d.text : d?.type === "thinking_delta" ? d.thinking : undefined;
        if (!text) return;
        const itemId = s.turn.streamingMessageId !== undefined && event.index !== undefined ? `${s.turn.streamingMessageId}:${event.index}` : undefined;
        this.emit(threadId, "content.delta", { streamKind: d?.type === "text_delta" ? "assistant_text" : "reasoning_text", delta: text,
          ...(event.index !== undefined ? { contentIndex: event.index } : {}) }, { ...at, ...(itemId ? { itemId } : {}) });
        return;
      }
      case "assistant": {
        const main = msg.parent_tool_use_id === null;
        const message = msg.message as unknown as { id?: string; content?: Array<Record<string, unknown>>; model?: string; usage?: unknown };
        if (main) {
          if (typeof message.model === "string" && message.model && s.turn) s.turn.model = message.model;
          const used = activeTokens(message.usage);
          if (used > 0 && used !== s.used) { s.used = used; this.contextUsage(s, at); }
          if (msg.error === "authentication_failed")
            this.emit(threadId, "runtime.error", { message: "claude not signed in — run `claude` and /login, then try again", class: "permission_error" }, at);
        }
        (message.content ?? []).forEach((block, index) => {
          const itemId = message.id ? `${message.id}:${index}` : undefined;
          const extra = { ...at, ...(itemId ? { itemId } : {}) };
          if (block.type === "text" && typeof block.text === "string" && main) {
            this.emit(threadId, "item.completed", { itemType: "assistant_message", status: "completed", detail: block.text }, extra);
          } else if (block.type === "thinking" && typeof block.thinking === "string" && main) {
            this.emit(threadId, "item.completed", { itemType: "reasoning", status: "completed", detail: block.thinking }, extra);
          } else if (block.type === "tool_use" && typeof block.id === "string") {
            const name = String(block.name ?? "tool");
            const toolInput = (block.input ?? {}) as Record<string, unknown>;
            let itemType = claudeToolItemType(name);
            // A write outside the session's directory (plan mode's own plan file
            // under ~/.claude/plans) is not a change to the project.
            const target = toolInput.file_path ?? toolInput.notebook_path;
            if (itemType === "file_change" && typeof target === "string" && outside(s.info.cwd, target)) itemType = "dynamic_tool_call";
            const tool: Tool = { name, input: toolInput, itemType };
            s.tools.set(block.id, tool);
            this.emit(threadId, "item.started", { itemType: tool.itemType, status: "inProgress", ...describeTool(tool),
              ...(main ? {} : { parentToolUseId: msg.parent_tool_use_id! }) }, { ...at, itemId: block.id });
            // A todo list is the agent's plan: shown as a checklist that updates in place.
            if (name === "TodoWrite" && main && Array.isArray(toolInput.todos)) {
              const plan = (toolInput.todos as Array<Record<string, unknown>>).map(t => ({ step: String(t.content ?? t.activeForm ?? ""),
                status: t.status === "completed" ? "completed" as const : t.status === "in_progress" ? "inProgress" as const : "pending" as const })).filter(t => t.step);
              if (plan.length) this.emit(threadId, "turn.plan.updated", { plan }, at);
            }
          }
        });
        return;
      }
      case "user": {
        const content = (msg.message as { content?: unknown }).content;
        if (!Array.isArray(content)) return;
        for (const block of content as Array<Record<string, unknown>>) {
          if (block.type !== "tool_result" || typeof block.tool_use_id !== "string") continue;
          const tool = s.tools.get(block.tool_use_id);
          if (!tool) continue;
          s.tools.delete(block.tool_use_id);
          const output = toolResultText(block.content);
          const images = toolResultImages(block.content);
          const status = tool.declined ? "declined" : block.is_error === true ? "failed" : "completed";
          this.emit(threadId, "item.completed", { itemType: tool.itemType, status, ...describeTool(tool, output, images, block.is_error === true),
            ...(msg.parent_tool_use_id ? { parentToolUseId: msg.parent_tool_use_id } : {}) }, { ...at, itemId: block.tool_use_id });
        }
        return;
      }
      case "result": {
        const windows = Object.values(msg.modelUsage ?? {}).map(u => u.contextWindow).filter(w => w > 0);
        if (windows.length) s.contextWindow = Math.max(...windows);
        this.contextUsage(s, at);
        const turn = s.turn;
        if (!turn) return; // a result for no turn of ours (a background task)
        s.turn = null;
        // A tool with no result by the end of the turn finished without saying how.
        for (const [id, tool] of s.tools) this.emit(threadId, "item.completed", { itemType: tool.itemType, ...describeTool(tool) }, { turnId: turn.id, itemId: id });
        s.tools.clear();
        delete s.info.activeTurnId;
        s.info = { ...s.info, status: "ready", updatedAt: Date.now() };
        const errors = msg.subtype === "success" ? [] : msg.errors ?? [];
        const interrupted = !msg.is_error ? false : errors.some(e => /interrupt/i.test(e));
        const errorMessage = msg.subtype === "success" ? (msg.is_error ? msg.result || "unknown error" : undefined) : errors.join("; ") || msg.subtype;
        // Cache reads and creations count as input, so tokens aren't lost.
        const usage = msg.usage as unknown as Record<string, number | undefined>;
        this.emit(threadId, "turn.completed", {
          state: !msg.is_error ? "completed" : interrupted ? "interrupted" : "failed",
          ...(msg.is_error && !interrupted && errorMessage ? { errorMessage } : {}),
          ...(msg.total_cost_usd !== undefined ? { totalCostUsd: msg.total_cost_usd } : {}),
          ...(turn.model ? { model: turn.model } : {}),
          tokenUsage: { usageStatus: "complete", inputTokens: (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0),
            outputTokens: usage.output_tokens ?? 0, ...(usage.cache_read_input_tokens !== undefined ? { cachedInputTokens: usage.cache_read_input_tokens } : {}),
            ...(usage.cache_creation_input_tokens !== undefined ? { cacheCreationTokens: usage.cache_creation_input_tokens } : {}) },
        }, { turnId: turn.id });
        return;
      }
      case "rate_limit_event": {
        const info = msg.rate_limit_info;
        // Overage the account has provisioned keeps the turn running.
        const blocked = info.status === "rejected" && !(info.overageStatus === "allowed" || info.overageStatus === "allowed_warning"
          || info.isUsingOverage === true || info.overageInUse === true);
        if (typeof info.utilization === "number" && info.rateLimitType) {
          this.emit(threadId, "account.rate-limits.updated", { windows: [{ id: info.rateLimitType, usedPercent: Math.round(info.utilization * 1000) / 10,
            ...(WINDOW_MINUTES[info.rateLimitType] ? { windowMinutes: WINDOW_MINUTES[info.rateLimitType] } : {}),
            ...(typeof info.resetsAt === "number" ? { resetsAt: info.resetsAt * 1000 } : {}) }], ...(blocked ? { reached: info.rateLimitType } : {}) }, at);
        }
        // A rejected window parks the turn inside the CLI: no result arrives
        // until it resets, so say why the turn is waiting.
        if (blocked) this.emit(threadId, "runtime.warning", { message: `Claude usage limit reached${info.rateLimitType ? ` (${info.rateLimitType})` : ""}${typeof info.resetsAt === "number" ? ` — resets ${new Date(info.resetsAt * 1000).toLocaleString()}` : ""}` }, at);
        return;
      }
      default:
        return;
    }
  }

  private contextUsage(s: Session, at: { turnId?: TurnId }): void {
    if (s.used === undefined) return;
    const max = s.contextWindow;
    this.emit(s.info.threadId, "thread.token-usage.updated", { usage: { usedTokens: max ? Math.min(s.used, max) : s.used,
      ...(max ? { maxTokens: max } : {}), compactsAutomatically: true } }, at);
  }
}

/** Title, detail and normalized data for a Claude tool call. */
function describeTool(tool: Tool, output?: string, images?: ToolImage[], failed = false): Omit<ItemLifecyclePayload, "itemType" | "status"> {
  const detail = summarizeToolInput(tool.name, tool.input);
  switch (tool.itemType) {
    case "command_execution": {
      const command = String(tool.input.command ?? "");
      return { detail: command, data: { command, ...(output !== undefined ? { output } : {}) } };
    }
    case "mcp_tool_call": {
      // mcp__<server>__<tool>
      const [, server = "", ...rest] = tool.name.split("__");
      return { title: tool.name, detail: `${server} · ${rest.join("__") || tool.name}`, data: { tool: rest.join("__") || tool.name, server, input: tool.input,
        ...(output !== undefined ? (failed ? { error: output } : { output }) : {}), ...(images?.length ? { images } : {}) } };
    }
    case "file_change": {
      const p = tool.input.file_path ?? tool.input.notebook_path;
      return { title: tool.name, detail, data: { changes: p ? [{ path: String(p), kind: tool.name === "Write" ? "add_or_update" : "update" }] : [] } };
    }
    default:
      return { title: tool.name, detail, data: { tool: tool.name, input: tool.input,
        ...(output !== undefined ? (failed ? { error: output } : { output }) : {}), ...(images?.length ? { images } : {}) } };
  }
}

/** Image blocks in a tool result (Read on a PNG, an MCP screenshot): base64 for ingestion to file. */
function toolResultImages(content: unknown): ToolImage[] {
  if (!Array.isArray(content)) return [];
  return (content as Array<Record<string, unknown>>).flatMap(c => {
    const src = c && c.type === "image" ? (c.source as Record<string, unknown> | undefined) : undefined;
    return src && src.type === "base64" && typeof src.data === "string" ? [{ data: src.data, mime: String(src.media_type ?? "image/png") }] : [];
  });
}

/** Is an absolute path outside `dir`? Symlinks resolved (macOS /tmp is /private/tmp). */
function outside(dir: string, file: string): boolean {
  if (!path.isAbsolute(file)) return false;
  const real = (p: string) => { try { return fs.realpathSync(p); } catch { try { return path.join(fs.realpathSync(path.dirname(p)), path.basename(p)); } catch { return p; } } };
  const rel = path.relative(real(dir), real(file));
  return rel.startsWith("..") || path.isAbsolute(rel);
}

function toolResultText(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  return content.map(c => (c && typeof c === "object" && typeof (c as { text?: unknown }).text === "string" ? (c as { text: string }).text : "")).join("");
}
