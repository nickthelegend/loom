/**
 * A scriptable in-memory ProviderAdapter. It behaves like a real one at the
 * contract: sessions start, resume from a cursor or report a lost session,
 * turns emit canonical events, requests wait for an answer, and stopping a
 * session reports its exit. Every call is recorded for assertions.
 */

import { randomUUID } from "node:crypto";
import { EventHub, type ProviderAdapter } from "../../src/providers/adapter.js";
import type {
  AdapterCapabilities, ApprovalDecision, ProviderKind, ProviderRuntimeEvent, ProviderSession, RuntimeEventPayloads,
  RuntimeEventType, SendTurnInput, SessionStartInput, ThreadSnapshot, TurnStartResult, UserInputAnswers,
} from "../../src/providers/contracts.js";
import { ProviderError } from "../../src/providers/errors.js";

/** One scripted step of a turn: an event to emit (turn/thread ids filled in), or a pause. */
export type FakeStep =
  | { [K in RuntimeEventType]: { type: K; payload: RuntimeEventPayloads[K]; itemId?: string; requestId?: string } }[RuntimeEventType]
  | { wait: number }
  /** Emit request.opened and wait for respondToRequest. */
  | { request: string; requestType?: "command_execution_approval" | "file_change_approval"; detail?: string; args?: unknown };

export interface FakeOptions {
  provider?: ProviderKind;
  capabilities?: Partial<AdapterCapabilities>;
  /** Cursors that no longer resume (native session gone). */
  lostCursors?: Set<unknown>;
  /** The steps of every turn, unless a turn is given its own. */
  script?: FakeStep[];
  /** Ends a turn with this completion when the script finishes. */
  finish?: RuntimeEventPayloads["turn.completed"] | null;
  /** Delay before startSession resolves. */
  startDelay?: number;
}

export class FakeAdapter implements ProviderAdapter {
  readonly provider: ProviderKind;
  readonly capabilities: AdapterCapabilities;
  readonly calls: Array<{ op: string; args: unknown[] }> = [];
  readonly responses: Array<{ requestId: string; decision: ApprovalDecision }> = [];
  private readonly sessions = new Map<string, ProviderSession>();
  private readonly hub = new EventHub<ProviderRuntimeEvent>();
  private readonly waiting = new Map<string, () => void>();
  private readonly running = new Map<string, { turnId: string; interrupted: boolean }>();
  private seq = 0;
  /** Steps for the next turn only. */
  next: FakeStep[] | null = null;
  startCount = 0;

  constructor(readonly instanceId: string, private readonly options: FakeOptions = {}) {
    this.provider = options.provider ?? "codex";
    this.capabilities = { steer: false, sessionModelSwitch: "in-session", supportsConversationRollback: false, manualCompaction: false, ...options.capabilities };
  }

  emit<K extends RuntimeEventType>(threadId: string, type: K, payload: RuntimeEventPayloads[K], extra: { turnId?: string; itemId?: string; requestId?: string } = {}): void {
    this.hub.publish({ eventId: randomUUID(), provider: this.provider, instanceId: this.instanceId, threadId,
      createdAt: Date.now(), ...extra, type, payload } as ProviderRuntimeEvent);
  }

  onEvent(listener: (event: ProviderRuntimeEvent) => void): () => void { return this.hub.subscribe(listener); }

  async startSession(input: SessionStartInput): Promise<ProviderSession> {
    this.calls.push({ op: "startSession", args: [input] });
    this.startCount++;
    if (this.options.startDelay) await new Promise(r => setTimeout(r, this.options.startDelay));
    if (input.resumeCursor !== undefined && this.options.lostCursors?.has(input.resumeCursor))
      throw new ProviderError("session_missing", "startSession", `no native session ${String(input.resumeCursor)}`);
    const cursor = input.resumeCursor ?? `native-${this.instanceId}-${++this.seq}`;
    const now = Date.now();
    const session: ProviderSession = { provider: this.provider, instanceId: this.instanceId, threadId: input.threadId, status: "ready",
      runtimeMode: input.runtimeMode, cwd: input.cwd, ...(input.modelSelection?.model ? { model: input.modelSelection.model } : {}),
      resumeCursor: cursor, createdAt: now, updatedAt: now };
    this.sessions.set(input.threadId, session);
    this.emit(input.threadId, "session.started", input.resumeCursor !== undefined ? { resume: cursor } : {});
    this.emit(input.threadId, "thread.started", { providerThreadId: String(cursor) });
    return { ...session };
  }

  async sendTurn(input: SendTurnInput): Promise<TurnStartResult> {
    this.calls.push({ op: "sendTurn", args: [input] });
    const session = this.sessions.get(input.threadId);
    if (!session) throw new ProviderError("not_found", "sendTurn", "no session");
    const turnId = `turn-${++this.seq}`;
    const steps = this.next ?? this.options.script ?? [{ type: "item.completed", itemId: `msg-${this.seq}`, payload: { itemType: "assistant_message", status: "completed", detail: `echo: ${input.input}` } }];
    this.next = null;
    this.running.set(input.threadId, { turnId, interrupted: false });
    this.emit(input.threadId, "turn.started", input.modelSelection?.model ? { model: input.modelSelection.model } : {}, { turnId });
    void this.play(input.threadId, turnId, steps);
    return { threadId: input.threadId, turnId, resumeCursor: session.resumeCursor };
  }

  private async play(threadId: string, turnId: string, steps: FakeStep[]): Promise<void> {
    const run = () => this.running.get(threadId);
    for (const step of steps) {
      if (run()?.interrupted || run()?.turnId !== turnId) return;
      if ("wait" in step) { await new Promise(r => setTimeout(r, step.wait)); continue; }
      if ("request" in step) {
        const answered = new Promise<void>(resolve => this.waiting.set(step.request, resolve));
        this.emit(threadId, "request.opened", { requestType: step.requestType ?? "command_execution_approval",
          ...(step.detail ? { detail: step.detail } : {}), ...(step.args !== undefined ? { args: step.args } : {}) }, { turnId, requestId: step.request });
        await answered;
        continue;
      }
      this.emit(threadId, step.type, step.payload as never, { turnId, ...(step.itemId ? { itemId: step.itemId } : {}), ...(step.requestId ? { requestId: step.requestId } : {}) });
    }
    if (run()?.interrupted || run()?.turnId !== turnId) return;
    const finish = this.options.finish === undefined ? { state: "completed" as const } : this.options.finish;
    if (finish) {
      this.running.delete(threadId);
      this.emit(threadId, "turn.completed", finish, { turnId });
    }
  }

  async interruptTurn(threadId: string, turnId?: string): Promise<void> {
    this.calls.push({ op: "interruptTurn", args: [threadId, turnId] });
    const run = this.running.get(threadId);
    if (!run || (turnId && run.turnId !== turnId)) return;
    run.interrupted = true;
    this.running.delete(threadId);
    this.emit(threadId, "turn.completed", { state: "interrupted" }, { turnId: run.turnId });
  }

  async respondToRequest(threadId: string, requestId: string, decision: ApprovalDecision): Promise<void> {
    this.calls.push({ op: "respondToRequest", args: [threadId, requestId, decision] });
    this.responses.push({ requestId, decision });
    this.emit(threadId, "request.resolved", { requestType: "command_execution_approval", decision }, { requestId });
    this.waiting.get(requestId)?.();
    this.waiting.delete(requestId);
  }

  async respondToUserInput(threadId: string, requestId: string, answers: UserInputAnswers): Promise<void> {
    this.calls.push({ op: "respondToUserInput", args: [threadId, requestId, answers] });
  }

  async rollbackThread(threadId: string, numTurns: number): Promise<ThreadSnapshot> {
    this.calls.push({ op: "rollbackThread", args: [threadId, numTurns] });
    return { threadId, turns: [] };
  }

  async compact(threadId: string): Promise<void> {
    this.calls.push({ op: "compact", args: [threadId] });
  }

  async stopSession(threadId: string): Promise<void> {
    this.calls.push({ op: "stopSession", args: [threadId] });
    if (!this.sessions.delete(threadId)) return;
    this.running.delete(threadId);
    this.emit(threadId, "session.exited", { exitKind: "graceful" });
  }

  async stopAll(): Promise<void> {
    for (const threadId of [...this.sessions.keys()]) await this.stopSession(threadId);
  }

  listSessions(): ProviderSession[] { return [...this.sessions.values()].map(s => ({ ...s })); }
  hasSession(threadId: string): boolean { return this.sessions.has(threadId); }
}
