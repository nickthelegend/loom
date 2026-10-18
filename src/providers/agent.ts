/**
 * ProviderAgent: a Loom agent (the runtime's Adapter) backed by a warm provider
 * session per chat. The runtime keeps its one-turn-at-a-time contract —
 * `send()` resolves when the turn has ended — while the harness process stays
 * up between turns.
 *
 *   send()  → ProviderService.sendTurn(chat, agent) → canonical events
 *           → RuntimeIngestion → Loom log events (this.emit)
 *           ← turn.completed / turn.aborted settles send()
 *
 * One ProviderService serves every provider agent of a working directory, so
 * the session directory (`.loom/providers/sessions.json`) has one writer. The
 * idle reaper and the approval bridge hang off the same service.
 *
 * Brain continuity keeps its binding authoritative: a continuity turn runs on
 * the native session its binding names (or a fresh one), and a lost session is
 * reported as NativeSessionMissing so the binding moves to a new epoch. A turn
 * settles at turn level — the harness reported it done and no command it
 * started is still running — not at process exit: the process outlives the
 * turn, as in t3code.
 */

import { autoPolicyFor } from "../core/auto-policy.js";
import path from "node:path";
import type { McpServerConfig } from "@anthropic-ai/claude-agent-sdk";
import { AdapterBase, ADAPTER_CAPABILITIES, cliAvailable, cliOutput, firstLine, frameBriefing, type AgentCheck } from "../adapters/base.js";
import { hasApprovalBroker } from "../core/approvals.js";
import { NativeDispatchRejected, NativeQuiescenceUnknown, NativeSessionMissing } from "../core/continuity/contracts.js";
import { permissionFor } from "../core/permissions.js";
import { MAIN_CHAT, type AgentCapabilities, type McpServerEntry, type SendInput } from "../types.js";
import type { ProviderAdapter } from "./adapter.js";
import { ApprovalBridge } from "./approvals.js";
import { ClaudeProviderAdapter, claudeBin } from "./claude/adapter.js";
import { CodexProviderAdapter, codexBin } from "./codex/adapter.js";
import type { ProviderKind, ProviderRuntimeEvent, ThreadId, TurnId } from "./contracts.js";
import { runtimeModeFor } from "./contracts.js";
import { FileSessionDirectory } from "./directory.js";
import { isProviderError } from "./errors.js";
import { RuntimeIngestion, type LiveDelta, type LiveItem } from "./ingestion.js";
import { SessionReaper } from "./reaper.js";
import { ProviderService } from "./service.js";
import type { Json } from "./codex/rpc.js";

// ---------------------------------------------------------------------------
// One provider service per working directory
// ---------------------------------------------------------------------------

interface ProjectProviders {
  service: ProviderService;
  /** The agent instance that owns each registered adapter. */
  owners: Map<string, ProviderAgent>;
  reaper: SessionReaper;
  approvals: ApprovalBridge;
  /** Per agent: the chat it is preparing or running a turn in. */
  busy: Map<string, () => ThreadId | undefined>;
  refs: number;
}

const projects = new Map<string, ProjectProviders>();

function acquireProviders(dir: string, project: () => string): ProjectProviders {
  const key = path.resolve(dir);
  let p = projects.get(key);
  if (!p) {
    const busy = new Map<string, () => ThreadId | undefined>();
    const service = new ProviderService(new FileSessionDirectory(path.join(key, ".loom"), () => {}));
    const reaper = new SessionReaper(service, { busy: (threadId, instanceId) => busy.get(instanceId)?.() === threadId });
    reaper.start();
    p = { service, owners: new Map(), reaper, approvals: new ApprovalBridge(service, project), busy, refs: 0 };
    projects.set(key, p);
  }
  p.refs++;
  return p;
}

function releaseProviders(dir: string, p: ProjectProviders): void {
  if (--p.refs > 0) return;
  p.reaper.stop();
  p.approvals.close();
  const key = path.resolve(dir);
  if (projects.get(key) === p) projects.delete(key);
}

/** Stop every warm session in this process (daemon shutdown, tests). */
export async function stopAllProviderSessions(): Promise<void> {
  await Promise.allSettled([...projects.values()].map(p => p.service.stopAll()));
}

// ---------------------------------------------------------------------------
// The agent
// ---------------------------------------------------------------------------

interface AgentOptions {
  model?: string;
  /** Reasoning effort ("low" | "medium" | "high" | …, the provider's own words). */
  effort?: string;
  bin?: string;
  extraArgs?: string[];
  sandbox?: "read-only" | "workspace-write" | "danger-full-access";
  permissionMode?: string;
  loomProject?: string;
  /** How long a finished turn waits for its running commands (tests). */
  commandSettleMs?: number;
  [key: string]: unknown;
}

interface CurrentTurn {
  chat: ThreadId;
  turnId?: TurnId;
  interrupted: boolean;
  /** Terminal events seen for this chat during the send, by turn id. */
  ended: Map<TurnId, ProviderRuntimeEvent>;
  exited?: ProviderRuntimeEvent;
  /** Set once the turn is being sent: an exit before that (a session this send stopped) is not this turn's. */
  watching: boolean;
  wake?: () => void;
}

/** A project MCP server as a Codex `mcp_servers.<key>` config value. */
function codexMcpServer(entry: McpServerEntry): Json {
  if (entry.type === "stdio") return { command: entry.command, ...(entry.args ? { args: entry.args } : {}), ...(entry.env ? { env: entry.env } : {}) };
  // Codex's key for per-server HTTP headers is unverified; a guessed key is
  // either ignored or rejected, so headers are deliberately not sent.
  return { url: entry.url };
}

function claudeMcpServer(entry: McpServerEntry): McpServerConfig {
  if (entry.type === "stdio") return { type: "stdio", command: entry.command, ...(entry.args ? { args: entry.args } : {}), ...(entry.env ? { env: entry.env } : {}) };
  return { type: entry.type, url: entry.url, ...(entry.headers ? { headers: entry.headers } : {}) };
}

export class ProviderAgent extends AdapterBase {
  /** MCP servers are applied when a session starts; a change restarts (and resumes) it. */
  override readonly capabilities: AgentCapabilities = { ...ADAPTER_CAPABILITIES, mcp: true };
  private readonly options: AgentOptions;
  private providers: ProjectProviders | null = null;
  private adapter: ProviderAdapter | null = null;
  private unsubscribe: (() => void) | null = null;
  private readonly ingestion: RuntimeIngestion;
  private current: CurrentTurn | null = null;
  private settled: Promise<void> | null = null;
  /** The MCP servers each chat's live session was started with. */
  private readonly sessionMcp = new Map<ThreadId, string>();
  private mcp: SendInput["mcp"];
  private readonly liveListeners = new Set<(delta: LiveDelta) => void>();
  private readonly itemListeners = new Set<(item: LiveItem) => void>();

  constructor(id: string, readonly provider: ProviderKind, projectDir: string, options: Record<string, unknown> = {}) {
    super(id, provider, projectDir);
    this.options = options as AgentOptions;
    this.ingestion = new RuntimeIngestion({
      append: event => this.emit({ kind: event.kind, payload: event.payload }),
      live: delta => { for (const cb of this.liveListeners) { try { cb(delta); } catch { /* a viewer's problem */ } } },
      liveItem: item => { for (const cb of this.itemListeners) { try { cb(item); } catch { /* a viewer's problem */ } } },
      artifactDir: () => this.projectDir,
    });
  }

  /** Streamed text as it arrives (not persisted; the completed message is). */
  onLive(cb: (delta: LiveDelta) => void): () => void {
    this.liveListeners.add(cb);
    return () => this.liveListeners.delete(cb);
  }

  /** A tool's progress as it runs (not persisted; the finished tool is a tool_call). */
  onLiveItem(cb: (item: LiveItem) => void): () => void {
    this.itemListeners.add(cb);
    return () => this.itemListeners.delete(cb);
  }

  /** Answer a structured question the agent is waiting on (needs_input with a requestId). */
  async respondToUserInput(chat: ThreadId, requestId: string, answers: Record<string, unknown>): Promise<void> {
    const service = this.providers?.service;
    if (!service) throw new Error(`${this.provider} agent "${this.id}" has no live session`);
    await service.respondToUserInput(chat, this.id, requestId, answers);
  }

  /**
   * Compact the chat's native context now. Codex has a request for it; Claude
   * compacts on its `/compact` command, sent as a turn (t3code's
   * `compaction: { type: "slash-command" }`).
   */
  async compact(chat: ThreadId = MAIN_CHAT): Promise<void> {
    if (this.provider === "claude-code") return this.send({ text: "/compact", chat });
    if (this._busy) throw new Error(`${this.provider} agent "${this.id}" is busy`);
    const { service } = await this.attach();
    await service.ensureSession({ threadId: chat, instanceId: this.id, cwd: this.projectDir, runtimeMode: this.runtimeMode(),
      ...(this.options.model ? { model: this.options.model } : {}), onMissingSession: "fresh" });
    await service.compact(chat, this.id);
  }

  private get bin(): string | null {
    return this.provider === "codex" ? codexBin(this.options.bin) : claudeBin(this.options.bin);
  }

  async available(): Promise<boolean> {
    const bin = this.bin;
    return bin ? cliAvailable(bin) : false;
  }
  /** Installed, and (Codex) signed in — asked of the CLI itself, no turn spent. */
  async selfCheck(): Promise<AgentCheck[]> {
    const bin = this.bin;
    const name = this.provider === "codex" ? "codex" : "claude";
    if (!bin) return [{ name: "installed", ok: false, detail: `${name} CLI not found — install it${this.provider === "codex" ? " or open Codex.app once" : ""}` }];
    const v = await cliOutput(bin, ["--version"]);
    const checks: AgentCheck[] = [
      { name: "installed", ok: v?.code === 0, detail: v?.code === 0 ? firstLine(v.out) || bin : `${name} didn't answer --version` },
    ];
    if (this.provider === "codex") {
      const s = await cliOutput(bin, ["login", "status"]);
      checks.push({
        name: "signed in",
        ok: s?.code === 0,
        detail: s ? firstLine(s.out) || (s.code === 0 ? "signed in" : "not signed in — run: codex login") : "couldn't ask codex",
      });
    }
    return checks;
  }


  async start(): Promise<void> {
    this.emit({ kind: "status", payload: { state: "ready" } });
  }

  /**
   * Register this agent's adapter with its directory's service, once. A
   * rebuilt agent with the same id (a model or permission change) takes over:
   * the previous instance is stopped first, and its sessions resume here.
   */
  private async attach(): Promise<{ providers: ProjectProviders; service: ProviderService }> {
    if (this.providers) return { providers: this.providers, service: this.providers.service };
    const providers = acquireProviders(this.projectDir, () => String(this.options.loomProject ?? ""));
    const previous = providers.owners.get(this.id);
    if (previous && previous !== this) {
      try { await previous.stop(); }
      catch (error) { releaseProviders(this.projectDir, providers); throw error; }
    }
    // A concurrent attach may have finished while the previous owner stopped.
    const attached = this.providers as ProjectProviders | null;
    if (attached) { releaseProviders(this.projectDir, providers); return { providers: attached, service: attached.service }; }
    const mcpServers = () => this.mcp?.servers ?? [];
    const adapter: ProviderAdapter = this.provider === "codex"
      ? new CodexProviderAdapter(this.id, { ...(this.options.bin ? { bin: this.options.bin } : {}),
        ...(this.options.extraArgs ? { extraArgs: this.options.extraArgs } : {}), ...(this.options.sandbox ? { sandbox: this.options.sandbox } : {}),
        mcpConfig: () => Object.fromEntries(mcpServers().map(s => [`mcp_servers.${s.key}`, codexMcpServer(s.entry)])) })
      : new ClaudeProviderAdapter(this.id, { ...(this.options.bin ? { bin: this.options.bin } : {}),
        ...(this.options.extraArgs ? { extraArgs: this.options.extraArgs } : {}),
        ...(this.options.permissionMode ? { permissionMode: this.options.permissionMode } : {}),
        // looked up by project id: options stay plain data (native continuity clones them)
        autoPolicy: () => autoPolicyFor(String(this.options.loomProject ?? "")),
        mcpServers: () => Object.fromEntries(mcpServers().map(s => [s.key, claudeMcpServer(s.entry)])), canAsk: hasApprovalBroker });
    providers.service.register(adapter);
    providers.owners.set(this.id, this);
    providers.busy.set(this.id, () => this.current?.chat);
    this.unsubscribe = providers.service.onEvent(event => { if (event.instanceId === this.id) this.observe(event); });
    this.providers = providers;
    this.adapter = adapter;
    this.migrateLegacySession(providers.service);
    return { providers, service: providers.service };
  }

  /**
   * Before warm sessions, one native session per agent was kept in the
   * project state. It becomes the main chat's binding, so an upgrade resumes
   * the conversation instead of starting over.
   */
  private migrateLegacySession(service: ProviderService): void {
    const legacy = this.nativeState.read().sessionId;
    if (typeof legacy !== "string" || !legacy) return;
    if (!service.directory.get(MAIN_CHAT, this.id)) {
      service.directory.upsert({ threadId: MAIN_CHAT, instanceId: this.id, provider: this.provider, status: "stopped",
        resumeCursor: legacy, runtimePayload: { cwd: this.projectDir }, runtimeMode: this.runtimeMode() });
    }
    this.nativeState.patch({ sessionId: undefined });
  }

  private runtimeMode() {
    return runtimeModeFor(permissionFor(this.provider, this.options as Record<string, unknown>));
  }

  private observe(event: ProviderRuntimeEvent): void {
    this.ingestion.ingest(event);
    this.trackCommands(event);
    const cur = this.current;
    if (!cur?.watching || event.threadId !== cur.chat) return;
    if ((event.type === "turn.completed" || event.type === "turn.aborted") && event.turnId) cur.ended.set(event.turnId, event);
    else if (event.type === "session.exited") cur.exited = event;
    else return;
    cur.wake?.();
  }

  /** Commands still running per chat: a turn is settled only once none are. */
  private readonly running = new Map<ThreadId, Set<string>>();
  private commandsIdle = new Map<ThreadId, () => void>();

  private trackCommands(event: ProviderRuntimeEvent): void {
    if (event.type === "session.exited") { this.running.delete(event.threadId); this.commandsIdle.get(event.threadId)?.(); return; }
    if ((event.type !== "item.started" && event.type !== "item.completed") || event.payload.itemType !== "command_execution" || !event.itemId) return;
    const set = this.running.get(event.threadId) ?? new Set<string>();
    if (event.type === "item.started") set.add(event.itemId);
    else set.delete(event.itemId);
    if (set.size) this.running.set(event.threadId, set);
    else { this.running.delete(event.threadId); this.commandsIdle.get(event.threadId)?.(); }
  }

  /**
   * Turn-level settlement: the harness said the turn is done and no command
   * it started is still running. Resolves false when commands are still
   * running at the deadline.
   */
  private async commandsSettled(chat: ThreadId, timeoutMs = 60_000): Promise<boolean> {
    if (!this.running.get(chat)?.size) return true;
    return new Promise(resolve => {
      const timer = setTimeout(() => { this.commandsIdle.delete(chat); resolve(false); }, timeoutMs);
      timer.unref();
      this.commandsIdle.set(chat, () => { clearTimeout(timer); this.commandsIdle.delete(chat); resolve(true); });
    });
  }

  async send(input: SendInput): Promise<void> {
    if (this._busy) throw new Error(`${this.provider} agent "${this.id}" is busy`);
    const bin = this.bin;
    if (!bin) throw new NativeDispatchRejected(this.provider === "codex" ? "codex CLI not found — install it or open Codex.app once"
      : "claude CLI not found — install Claude Code or set its path");
    this._busy = true;
    this.beginContinuity(input);
    const chat = input.chat ?? MAIN_CHAT;
    const cur: CurrentTurn = { chat, interrupted: false, ended: new Map(), watching: false };
    this.current = cur;
    let release!: () => void;
    this.settled = new Promise(resolve => { release = resolve; });
    let submitted = false;
    try {
      const { service } = await this.attach();
      const runtimeMode = this.runtimeMode();
      const model = input.model ?? this.options.model;
      const effort = this.options.effort;
      if (input.continuity) await this.bindContinuity(service, chat, input.continuity.nativeSessionId);
      // forget this chat's native session: the turn starts a new one with nothing to re-read (#280)
      else if (input.freshSession) await this.bindContinuity(service, chat, null);
      await this.applyMcp(service, chat, input.mcp);
      if (cur.interrupted) throw new NativeDispatchRejected("interrupted before the turn started");
      // Codex has no per-turn system channel and a warm Claude session's system
      // prompt is fixed, so a briefing rides in front of the text, framed as an
      // unmissable block (see frameBriefing).
      const text = input.continuity
        ? [input.continuity.context, input.briefing, input.text].filter(Boolean).join("\n\n")
        : input.briefing ? `${frameBriefing(input.briefing)}\n\n${input.text}` : input.text;
      if (input.continuity) this.ingestion.tagTurn(chat, this.id, { loomRunId: input.continuity.runId,
        loomBindingId: input.continuity.bindingId, loomSessionEpoch: input.continuity.sessionEpoch });
      let result;
      cur.watching = true;
      try {
        result = await service.sendTurn({ threadId: chat, instanceId: this.id, input: text, cwd: this.projectDir, runtimeMode,
          ...(model ? { model } : {}), ...(effort ? { effort } : {}),
          ...(model || effort ? { modelSelection: { ...(model ? { model } : {}), ...(effort ? { effort } : {}) } } : {}),
          ...(input.interactionMode ? { interactionMode: input.interactionMode } : {}),
          onMissingSession: input.continuity ? "fail" : "fresh",
          ...(input.continuity ? { clientTurnId: input.continuity.runId } : {}) });
      } catch (error) {
        this.ingestion.untagTurn(chat, this.id);
        const failure = this.dispatchError(error, Boolean(input.continuity));
        // A lost session is Brain's to rebuild, not an error to show.
        if (!(failure instanceof NativeSessionMissing) && !cur.interrupted) {
          const stderr = isProviderError(error) ? error.details.stderr : undefined;
          this.emit({ kind: "error", payload: { message: failure.message, ...(stderr ? { stderr: stderr.slice(-2000) } : {}) } });
        }
        throw failure;
      }
      submitted = true;
      this.sessionMcp.set(chat, JSON.stringify(input.mcp?.servers ?? []));
      cur.turnId = result.turnId;
      if (cur.interrupted) await service.interruptTurn(chat, this.id, result.turnId).catch(() => {});
      const end = await this.turnEnd(cur, result.turnId);
      // Turn-level settlement (the session stays warm): the harness reported
      // the turn done, and no command it started is still running. A command
      // that won't finish leaves Brain's outcome unproven.
      // Brain waits up to a minute for proof; an ordinary turn moves on after a
      // few seconds, since a harness can end a turn with a command it abandoned.
      const settleMs = typeof this.options.commandSettleMs === "number" ? this.options.commandSettleMs : input.continuity ? 60_000 : 5_000;
      if (!(await this.commandsSettled(chat, settleMs)) && input.continuity)
        throw new NativeQuiescenceUnknown(`${this.provider} reported the turn done while a command is still running; quiescence unknown`);
      if (end.type === "turn.completed") {
        // A failed turn is already in the log as an error. Brain also needs to
        // hear it from send(); outside continuity the error event ends the turn.
        if (end.payload.state === "failed" && input.continuity)
          throw new Error(`${this.provider} reported a failed turn${end.payload.errorMessage ? `: ${end.payload.errorMessage}` : ""}`);
        return;
      }
      if (end.type === "turn.aborted") throw new Error(end.payload.reason);
      // The session went away with no word on the turn.
      const message = `${this.provider} session ended before the turn completed; native outcome is unknown`;
      this.emit({ kind: "error", payload: { message } });
      throw new Error(message);
    } catch (error) {
      if (cur.interrupted && !submitted && !(error instanceof NativeSessionMissing)) {
        // Stopped before any prompt reached the harness: interrupted, not failed.
        this.emit({ kind: "status", payload: { state: "interrupted" } });
        if (input.continuity) throw error instanceof NativeDispatchRejected ? error : new NativeDispatchRejected("interrupted before the turn started");
        return;
      }
      throw error;
    } finally {
      this.current = null;
      this._busy = false;
      this.endContinuity();
      release();
    }
  }

  /** Wait for the turn's terminal event, or the session's exit. */
  private turnEnd(cur: CurrentTurn, turnId: TurnId): Promise<ProviderRuntimeEvent> {
    return new Promise(resolve => {
      const check = () => {
        const end = cur.ended.get(turnId) ?? cur.exited;
        if (end) { cur.wake = undefined; resolve(end); }
      };
      cur.wake = check;
      check();
    });
  }

  /**
   * A continuity turn runs on the native session its binding names. A live
   * session on any other native session (or any live session, when the binding
   * wants a fresh one) is stopped first, and the directory is pointed at the
   * binding's session.
   */
  private async bindContinuity(service: ProviderService, chat: ThreadId, nativeSessionId: string | null): Promise<void> {
    const live = service.listSessions().find(s => s.threadId === chat && s.instanceId === this.id);
    if (live && live.resumeCursor === nativeSessionId && nativeSessionId !== null) return;
    if (live) await service.stopSession(chat, this.id);
    const binding = service.directory.get(chat, this.id);
    if ((binding?.resumeCursor ?? null) !== nativeSessionId) {
      service.directory.upsert({ threadId: chat, instanceId: this.id, provider: this.provider, status: "stopped",
        resumeCursor: nativeSessionId, runtimePayload: { cwd: this.projectDir }, runtimeMode: this.runtimeMode() });
    }
  }

  /** A session started with other MCP servers restarts (and resumes) with these. */
  private async applyMcp(service: ProviderService, chat: ThreadId, mcp: SendInput["mcp"]): Promise<void> {
    this.mcp = mcp;
    const wanted = JSON.stringify(mcp?.servers ?? []);
    const had = this.sessionMcp.get(chat);
    if (had !== undefined && had !== wanted && this.adapter?.hasSession(chat)) await service.stopSession(chat, this.id);
  }

  /** A provider error as the runtime and Brain understand dispatch failures. */
  private dispatchError(error: unknown, continuity: boolean): Error {
    if (!isProviderError(error)) return error instanceof Error ? error : new Error(String(error));
    if (error.code === "session_missing") {
      return continuity ? new NativeSessionMissing(error.message) : new NativeDispatchRejected(error.message);
    }
    if (error.notSubmitted) return new NativeDispatchRejected(error.message);
    return new Error(/native outcome is unknown/.test(error.message) ? error.message : `${error.message}; native outcome is unknown`);
  }

  async interrupt(): Promise<void> {
    const cur = this.current;
    if (!cur) return;
    cur.interrupted = true;
    const service = this.providers?.service;
    if (service && cur.turnId) await service.interruptTurn(cur.chat, this.id, cur.turnId).catch(() => {});
    const settled = this.settled ?? Promise.resolve();
    const within = (ms: number) => Promise.race([settled.then(() => true), new Promise<false>(resolve => setTimeout(() => resolve(false), ms).unref())]);
    if (await within(15_000)) return;
    // The harness did not stop the turn: end its session (and process group).
    if (service) await service.stopSession(cur.chat, this.id).catch(() => {});
    if (!(await within(10_000))) throw new NativeQuiescenceUnknown(`${this.provider} did not stop after interruption; quiescence unknown`);
  }

  async stop(): Promise<void> {
    await this.interrupt();
    const providers = this.providers;
    if (!providers) return;
    this.providers = null;
    this.adapter = null;
    try { await providers.service.unregister(this.id); }
    finally {
      this.unsubscribe?.();
      this.unsubscribe = null;
      if (providers.owners.get(this.id) === this) { providers.owners.delete(this.id); providers.busy.delete(this.id); }
      releaseProviders(this.projectDir, providers);
    }
  }
}

/** Claude Code as a Loom agent (the SDK's historical name). */
export class ClaudeCodeAdapter extends ProviderAgent {
  constructor(id: string, projectDir: string, options: Record<string, unknown> = {}) { super(id, "claude-code", projectDir, options); }
}

/** Codex as a Loom agent. */
export class CodexAdapter extends ProviderAgent {
  constructor(id: string, projectDir: string, options: Record<string, unknown> = {}) { super(id, "codex", projectDir, options); }
}
