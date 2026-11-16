/**
 * The provider adapter contract. An adapter owns one provider's protocol and
 * its live sessions; everything above it (ProviderService, ingestion, Brain,
 * clients) sees only these operations and the canonical runtime events.
 *
 * Ported from t3code's provider/Services/ProviderAdapter.ts (MIT, © T3 Tools
 * Inc.) as a plain async interface. One difference: t3code keys sessions by
 * thread alone, because a thread never changes driver. Loom switches provider
 * within a chat, so each adapter instance serves one Loom agent and keys its
 * sessions by chat; the service routes (chat, agent) to the right adapter.
 */

import type {
  AdapterCapabilities, ApprovalDecision, InstanceId, ProviderKind, ProviderRuntimeEvent, ProviderSession,
  RequestId, SendTurnInput, SessionStartInput, ThreadId, ThreadSnapshot, TurnId, TurnStartResult, UserInputAnswers,
} from "./contracts.js";

export type RuntimeEventListener = (event: ProviderRuntimeEvent) => void;

export interface ProviderAdapter {
  readonly provider: ProviderKind;
  /** The Loom agent this adapter serves. */
  readonly instanceId: InstanceId;
  readonly capabilities: AdapterCapabilities;

  /** Start a session, or resume one from `resumeCursor`. Resolves once the session is ready. */
  startSession(input: SessionStartInput): Promise<ProviderSession>;
  /** Start a turn on a live session. Resolves once the provider has accepted it. */
  sendTurn(input: SendTurnInput): Promise<TurnStartResult>;
  /** True on acceptance, false if not delivered. Throw on uncertain delivery; callers must not resend. */
  steer?(chat: ThreadId, text: string): Promise<boolean>;
  /** Interrupt the active turn (or `turnId`). Resolves once the provider has acknowledged. */
  interruptTurn(threadId: ThreadId, turnId?: TurnId): Promise<void>;
  respondToRequest(threadId: ThreadId, requestId: RequestId, decision: ApprovalDecision): Promise<void>;
  respondToUserInput(threadId: ThreadId, requestId: RequestId, answers: UserInputAnswers): Promise<void>;
  /** Start a compaction; completion arrives as `thread.state.changed: compacted`. */
  compact?(threadId: ThreadId): Promise<void>;
  readThread?(threadId: ThreadId): Promise<ThreadSnapshot>;
  rollbackThread?(threadId: ThreadId, numTurns: number): Promise<ThreadSnapshot>;
  /** Stop one session and wait for its process to be gone. */
  stopSession(threadId: ThreadId): Promise<void>;
  stopAll(): Promise<void>;
  listSessions(): ProviderSession[];
  hasSession(threadId: ThreadId): boolean;
  /** Subscribe to this adapter's canonical events. Returns an unsubscribe. */
  onEvent(listener: RuntimeEventListener): () => void;
}

/**
 * A synchronous fan-out for runtime events. A throwing listener is isolated so
 * one bad subscriber cannot stop the others from seeing the stream.
 */
export class EventHub<T> {
  private readonly listeners = new Set<(event: T) => void>();
  constructor(private readonly onListenerError: (error: unknown) => void = () => {}) {}

  subscribe(listener: (event: T) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  publish(event: T): void {
    for (const listener of [...this.listeners]) {
      try { listener(event); } catch (error) { this.onListenerError(error); }
    }
  }

  get size(): number { return this.listeners.size; }
}
