/**
 * The provider contract: what a harness session is, what a turn takes, and the
 * one canonical runtime event stream every adapter emits.
 *
 * Ported from t3code (MIT, © T3 Tools Inc.):
 *   packages/contracts/src/provider.ts, providerRuntime.ts, orchestration.ts
 * as plain TypeScript, reduced to what Codex and Claude Code need. Names and
 * shapes follow t3code so later phases can keep porting without remapping.
 *
 * Vocabulary (see docs/refactoring/T3-PORT-NOTES.md): a t3code *thread* is a
 * Loom chat, and a provider *instance* is a Loom agent config entry. Loom keys
 * a session by (thread, instance), because a chat can switch provider.
 */

export type ProviderKind = "codex" | "claude-code";
export const PROVIDER_KINDS: readonly ProviderKind[] = ["codex", "claude-code"];
export const isProviderKind = (value: string): value is ProviderKind =>
  (PROVIDER_KINDS as readonly string[]).includes(value);

/** A Loom chat id. */
export type ThreadId = string;
/** A Loom agent id: one configured instance of a provider. */
export type InstanceId = string;
export type TurnId = string;
export type ItemId = string;
export type RequestId = string;

/** How much the agent may do unasked. Loom's permission modes, in t3code's words. */
export type RuntimeMode = "approval-required" | "auto-accept-edits" | "full-access";
export type InteractionMode = "default" | "plan";

export type ProviderSessionStatus = "connecting" | "ready" | "running" | "error" | "closed";

export interface ModelSelection {
  model?: string;
  /** Reasoning effort, in the provider's own vocabulary (e.g. "high"). */
  effort?: string;
}

export interface ProviderSession {
  provider: ProviderKind;
  instanceId: InstanceId;
  threadId: ThreadId;
  status: ProviderSessionStatus;
  runtimeMode: RuntimeMode;
  cwd: string;
  model?: string;
  /** What resumes this session after the process is gone: the native thread/session id. */
  resumeCursor?: unknown;
  activeTurnId?: TurnId;
  createdAt: number;
  updatedAt: number;
  lastError?: string;
}

export interface SessionStartInput {
  threadId: ThreadId;
  instanceId: InstanceId;
  cwd: string;
  runtimeMode: RuntimeMode;
  modelSelection?: ModelSelection;
  /** Resume this native session instead of starting a new one. */
  resumeCursor?: unknown;
}

export interface SendTurnInput {
  threadId: ThreadId;
  instanceId: InstanceId;
  input: string;
  modelSelection?: ModelSelection;
  interactionMode?: InteractionMode;
  /** Correlates the turn with the caller (Brain run id, client message id). */
  clientTurnId?: string;
}

export interface TurnStartResult {
  threadId: ThreadId;
  turnId: TurnId;
  resumeCursor?: unknown;
}

export type ApprovalDecision = "accept" | "acceptForSession" | "decline" | "cancel";
export type UserInputAnswers = Record<string, unknown>;

export interface AdapterCapabilities {
  /** Whether an existing session can change model without restarting. */
  sessionModelSwitch: "in-session" | "restart" | "unsupported";
  /** False when native conversation history cannot be rewound. */
  supportsConversationRollback: boolean;
  /** Whether the adapter can start a compaction on request. */
  manualCompaction: boolean;
}

export interface ThreadSnapshot {
  threadId: ThreadId;
  turns: Array<{ id: TurnId; items: unknown[] }>;
}

// ---------------------------------------------------------------------------
// Canonical runtime events
// ---------------------------------------------------------------------------

export type RuntimeSessionState = "starting" | "ready" | "running" | "waiting" | "stopped" | "error";
export type RuntimeThreadState = "active" | "idle" | "closed" | "compacted" | "error";
export type RuntimeTurnState = "completed" | "failed" | "interrupted" | "cancelled";
export type RuntimeItemStatus = "inProgress" | "completed" | "failed" | "declined";
export type ContentStreamKind = "assistant_text" | "reasoning_text" | "reasoning_summary_text" | "plan_text"
  | "command_output" | "file_change_output" | "unknown";

export type CanonicalItemType = "user_message" | "assistant_message" | "reasoning" | "plan"
  | "command_execution" | "file_change" | "mcp_tool_call" | "dynamic_tool_call" | "collab_agent_tool_call"
  | "web_search" | "image_view" | "context_compaction" | "error" | "unknown";

export type CanonicalRequestType = "command_execution_approval" | "file_read_approval" | "file_change_approval"
  | "apply_patch_approval" | "exec_command_approval" | "mcp_elicitation_approval" | "permission_approval"
  | "tool_user_input" | "unknown";

export interface ThreadTokenUsage {
  /** Tokens in the model's context now. */
  usedTokens: number;
  maxTokens?: number;
  totalProcessedTokens?: number;
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  reasoningOutputTokens?: number;
  compactsAutomatically?: boolean;
}

/** One turn's main-agent usage. Input includes cache reads and writes; output includes reasoning. */
export interface TurnTokenUsage {
  usageStatus: "complete" | "partial" | "unavailable";
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  cacheCreationTokens?: number;
  reasoningTokens?: number;
}

export interface RateLimitWindow {
  id: string;
  usedPercent: number;
  windowMinutes?: number;
  /** Epoch ms. */
  resetsAt?: number;
}

export interface UserInputQuestion {
  id: string;
  header: string;
  question: string;
  options: Array<{ label: string; description: string; value?: string }>;
  allowCustomAnswer?: boolean;
  multiSelect?: boolean;
  /** A password-like answer: typed hidden, never kept in the thread. */
  secret?: boolean;
}

export interface ItemLifecyclePayload {
  itemType: CanonicalItemType;
  status?: RuntimeItemStatus;
  title?: string;
  detail?: string;
  data?: unknown;
  /** Set when the item ran inside a sub-agent. */
  parentToolUseId?: string;
}

/**
 * Normalized `data` for tool items, so nothing above the adapter parses a
 * provider's native item. An adapter fills the one matching its `itemType`.
 * Assistant and reasoning text arrive as `content.delta`; the completed item's
 * `detail` is the whole text, used only when nothing was streamed.
 */
export interface CommandItemData { command: string; cwd?: string; exitCode?: number | null; output?: string }
export interface FileChangeItemData { changes: Array<{ path: string; kind: string; diff?: string }> }
/**
 * An image a tool returned. `data` is base64 straight from the provider; ingestion
 * writes it under .loom/attachments and logs only the `path`. A `path` alone is a
 * file the tool looked at (Codex's view_image).
 */
export interface ToolImage { data?: string; path?: string; mime?: string }
export interface ToolItemData { tool: string; input?: Record<string, unknown>; output?: string; error?: string; server?: string; images?: ToolImage[] }

/** Payload by event type. */
export interface RuntimeEventPayloads {
  "session.started": { resume?: unknown };
  "session.state.changed": { state: RuntimeSessionState; reason?: string };
  "session.exited": { reason?: string; recoverable?: boolean; exitKind?: "graceful" | "error" };
  "thread.started": { providerThreadId?: string };
  "thread.state.changed": { state: RuntimeThreadState; beforeTokens?: number; afterTokens?: number; trigger?: "auto" | "manual" };
  "thread.token-usage.updated": { usage: ThreadTokenUsage };
  "turn.started": { model?: string; effort?: string };
  "turn.completed": { state: RuntimeTurnState; stopReason?: string | null; errorMessage?: string;
    totalCostUsd?: number; tokenUsage?: TurnTokenUsage; model?: string };
  "turn.aborted": { reason: string; detail?: { stderr?: string } };
  "turn.plan.updated": { explanation?: string | null; plan: Array<{ step: string; status: "pending" | "inProgress" | "completed" }> };
  "turn.proposed.delta": { delta: string };
  "turn.proposed.completed": { planMarkdown: string };
  "turn.diff.updated": { unifiedDiff: string };
  "item.started": ItemLifecyclePayload;
  "item.updated": ItemLifecyclePayload;
  "item.completed": ItemLifecyclePayload;
  "content.delta": { streamKind: ContentStreamKind; delta: string; contentIndex?: number };
  "request.opened": { requestType: CanonicalRequestType; detail?: string; args?: unknown;
    options?: Array<{ decision: ApprovalDecision; label: string }> };
  "request.resolved": { requestType: CanonicalRequestType; decision?: string };
  /**
   * Questions for the person. "tool" (default): the turn waits and the answer
   * goes back through respondToUserInput. "message": the turn has ended and the
   * person answers with their next message (Codex async questions).
   */
  "user-input.requested": { questions: UserInputQuestion[]; responseMode?: "tool" | "message" };
  "user-input.resolved": { answers: UserInputAnswers };
  "account.rate-limits.updated": { windows: RateLimitWindow[]; reached?: string | null };
  "model.rerouted": { fromModel: string; toModel: string; reason?: string };
  "config.warning": { summary: string; details?: string };
  "runtime.warning": { message: string; detail?: unknown; retrying?: boolean };
  "runtime.error": { message: string; class?: "provider_error" | "transport_error" | "permission_error" | "validation_error" | "unknown"; detail?: unknown };
}

export type RuntimeEventType = keyof RuntimeEventPayloads;

interface RuntimeEventBase {
  eventId: string;
  provider: ProviderKind;
  instanceId: InstanceId;
  threadId: ThreadId;
  /** Epoch ms. */
  createdAt: number;
  turnId?: TurnId;
  itemId?: ItemId;
  requestId?: RequestId;
  /** Native ids, for correlation and debugging. */
  providerRefs?: { providerTurnId?: string; providerItemId?: string; providerRequestId?: string };
  /** The native message, when kept for debugging. Never interpreted above the adapter. */
  raw?: { source: string; method?: string; payload: unknown };
}

export type ProviderRuntimeEvent = {
  [K in RuntimeEventType]: RuntimeEventBase & { type: K; payload: RuntimeEventPayloads[K] }
}[RuntimeEventType];

export type RuntimeEventOf<K extends RuntimeEventType> = Extract<ProviderRuntimeEvent, { type: K }>;

/** Loom's permission mode (core/permissions.ts) as a runtime mode, and back. */
export const RUNTIME_MODE_BY_PERMISSION = { bypass: "full-access", auto: "auto-accept-edits", ask: "approval-required" } as const;
export const runtimeModeFor = (permission: "bypass" | "auto" | "ask"): RuntimeMode => RUNTIME_MODE_BY_PERMISSION[permission];
