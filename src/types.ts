/**
 * Loom — shared types.
 *
 * The event log is the source of truth; everything else (agent memory,
 * board views, phone surfaces) is a projection of it.
 */

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export type EventKind =
  | "message" // human or agent turn
  | "tool_call" // agent used a tool
  | "tool_result"
  | "file_edit" // path + summary of a change
  | "decision" // distilled fact worth projecting into memory
  | "handoff" // baton moved
  | "suggestion" // loom suggests a handoff (user confirms)
  | "needs_input" // agent is blocked on the human
  | "run_complete" // agent finished a turn
  | "agent_join"
  | "agent_leave"
  | "role_change"
  | "route_started" // multi-hop routing lifecycle
  | "route_step"
  | "route_paused"
  | "route_resumed"
  | "route_completed"
  | "route_failed"
  | "turn_diff" // working-tree changes attributed to one agent turn
  | "memory_import" // an ADE's native memory pulled into the shared brain
  // The brain. A memory is not a row in a table somewhere — it is these three
  // events, folded. State is a fold, history is a filter, and the two can't
  // drift apart because they're the same bytes. See core/brain.ts.
  | "memory_add"
  | "memory_update"
  | "memory_forget"
  | "status" // adapter/bridge lifecycle info
  | "error";

/**
 * The chat every event belongs to. A project can hold several conversations;
 * they share one brain, one baton and one working tree — only the talking is
 * split. Events written before chats existed carry no id and read as MAIN.
 */
export const MAIN_CHAT = "main";

export interface LoomEvent {
  id: number;
  ts: number; // epoch ms
  kind: EventKind;
  /** Author agent id; absent for human/system events. */
  agentId?: string;
  /** Conversation this belongs to. Absent means the main chat. */
  chat?: string;
  payload: Record<string, unknown>;
}

export type NewEvent = {
  kind: EventKind;
  agentId?: string;
  chat?: string;
  payload: Record<string, unknown>;
  ts?: number;
};

/** A named conversation inside a project. */
export interface ChatInfo {
  id: string;
  title: string;
  createdAt: number;
}

// ---------------------------------------------------------------------------
// Agents & projects
// ---------------------------------------------------------------------------

/**
 * An agent's job, in your words. Free text: call an agent "architect",
 * "tester", "the one that writes docs" — whatever your project actually does.
 *
 * A few names carry extra meaning if you use them, and none if you don't:
 * `buildDefaultRoutes` seeds a plan→execute→review pipeline when it sees
 * planner/executor/reviewer, the rules router prefers a reviewer last, and a
 * route step matches an agent by role as well as by id (so a route named
 * ["architect","tester"] just works). Nothing requires them.
 */
export type AgentRole = string;

/** Roles Loom suggests when it sets a project up. Only suggestions. */
export const SUGGESTED_ROLES = ["planner", "executor", "reviewer", "general"] as const;

/** Adapter = full-duplex; bridge = read-mostly, never holds the baton. */
export type AgentTier = "adapter" | "bridge";

export interface AgentConfig {
  /** Stable instance id within the project, e.g. "claude-code". */
  id: string;
  /** Adapter kind, e.g. "claude-code" | "opencode" | "echo" | "antigravity". */
  kind: string;
  role: AgentRole;
  options?: Record<string, unknown>;
  /** Override the ADE's native memory files to import into the shared brain. */
  memoryFiles?: string[];
}

/** One ADE's native memory pulled into the unified brain. */
export interface MemorySource {
  agentId: string;
  kind: string;
  file: string;
  chars: number;
}

export interface UnifiedMemory {
  projectName: string;
  decisions: string[];
  sources: MemorySource[];
  /** The merged brain document (decisions + imported ADE memories + context). */
  document: string;
}

/**
 * A route step: which agent (by id or role), and what job it does.
 *
 * `role` is the job for THIS step — planner/executor/reviewer/… — chosen when
 * the task is created, independent of the agent's own default role. So the same
 * agent can plan in one task and review in another. `instruction` is optional
 * free-text focus on top of the role.
 */
export type RouteStepSpec = string | { step: string; role?: string; instruction?: string };

/** How shared memory is rendered on handoff. */
export interface ProjectionConfig {
  /** "template" (default, free, instant) or "llm" (distilled by a small Claude). */
  mode?: "template" | "llm";
  model?: string;
  timeoutMs?: number;
}

/** The brain's phase-2 extractor — learning from each turn. See core/brain-extract.ts. */
export interface BrainConfig {
  /**
   * Who reads finished turns for memory:
   *   "auto" (default) — a small Claude, when the CLI is available; a no-op when not.
   *   "off"            — never extract; the brain only holds what you type.
   */
  extractor?: "auto" | "off";
  /** Model for the extractor call; small+fast is right. */
  model?: string;
}

export interface ProjectConfig {
  name: string;
  agents: AgentConfig[];
  /** Agent that receives messages when nobody holds the baton. */
  defaultAgent?: string;
  /** Named multi-hop pipelines; steps are agent ids/roles, optionally with instructions. */
  routes?: Record<string, RouteStepSpec[]>;
  projection?: ProjectionConfig;
  brain?: BrainConfig;
}

// ---------------------------------------------------------------------------
// Routing — automated multi-hop handoffs
// ---------------------------------------------------------------------------

export type RouteStatus = "running" | "waiting_human" | "completed" | "failed" | "aborted";

export type RouteMode = "static" | "dynamic";
export type RouterKind = "rules" | "llm";

export interface RouteState {
  id: string;
  name?: string;
  task: string;
  /** Resolved agent ids, in order. Dynamic routes grow this per hop. */
  steps: string[];
  stepRoles: AgentRole[];
  /** Optional per-step focus text (parallel to steps; null = role default only). */
  stepInstructions?: Array<string | null>;
  /** Index of the step currently executing (or last executed). */
  current: number;
  status: RouteStatus;
  /** static = fixed pipeline; dynamic = a router picks each next hop. */
  mode: RouteMode;
  router?: RouterKind;
  maxHops?: number;
  startedAt: number;
  updatedAt: number;
  reason?: string;
  pendingQuestion?: string;
  /** Project cost total when the route started (internal baseline). */
  costStartUsd?: number;
  /** Spend attributed to this route (set when it ends). */
  costUsd?: number;
}

export interface ProjectInfo {
  id: string;
  name: string;
  dir: string;
}

// ---------------------------------------------------------------------------
// Adapter contract (full-duplex — mandatory for adapters)
// ---------------------------------------------------------------------------

export interface SendInput {
  text: string;
  /** One-shot handoff briefing injected alongside this turn. */
  briefing?: string;
}

export interface AdapterEvent {
  kind: EventKind;
  payload: Record<string, unknown>;
}

export interface AgentCapabilities {
  tier: AgentTier;
  send: boolean;
  stream: boolean;
  injectMemory: boolean;
  interrupt: boolean;
  diff: boolean;
}

export interface BaseAgent {
  readonly id: string;
  readonly kind: string;
  readonly capabilities: AgentCapabilities;
  /** Is the underlying tool installed/reachable? */
  available(): Promise<boolean>;
  start(): Promise<void>;
  stop(): Promise<void>;
  /** Persist Loom's namespaced memory projection for this agent. */
  injectMemory(projection: string): Promise<void>;
  /** Subscribe to live events; returns unsubscribe. */
  onEvent(cb: (e: AdapterEvent) => void): () => void;
}

/** Full-duplex adapter — may hold the baton. */
export interface Adapter extends BaseAgent {
  send(input: SendInput): Promise<void>;
  interrupt(): Promise<void>;
  /** Working-tree changes attributable to the agent (porcelain-ish). */
  diff(): Promise<string>;
  busy(): boolean;
}

/** Read-mostly bridge — never holds the baton (GUI agents). */
export interface Bridge extends BaseAgent {}

export type AnyAgent = Adapter | Bridge;

export function isAdapter(a: AnyAgent): a is Adapter {
  return a.capabilities.tier === "adapter";
}

// ---------------------------------------------------------------------------
// Board / status projections
// ---------------------------------------------------------------------------

export interface AgentStatus {
  id: string;
  kind: string;
  role: AgentRole;
  tier: AgentTier;
  available: boolean;
  busy: boolean;
  holdsBaton: boolean;
  /** The model override in effect, or "" for the CLI's own default. */
  model: string;
}

export interface ProjectStatus {
  id: string;
  name: string;
  dir: string;
  holder: string | null;
  agents: AgentStatus[];
  lastEvent: LoomEvent | null;
  needsInput: boolean;
  /**
   * The agent whose question is still unanswered, when `needsInput` — the
   * board puts a name on the card, not just "someone is blocked".
   */
  blockedAgent?: string | null;
  /** Conversations in this project, main first. */
  chats?: ChatInfo[];
  route?: RouteState | null;
  /** Named pipelines defined in config (for pickers/dropdowns). */
  routeNames?: string[];
  /** Lifetime spend across all agents in this project (USD). */
  costUsd?: number;
}

// ---------------------------------------------------------------------------
// Cost telemetry
// ---------------------------------------------------------------------------

export interface AgentCost {
  agentId: string;
  usd: number;
  turns: number;
  ms: number;
}

export interface CostSummary {
  totalUsd: number;
  turns: number;
  totalMs: number;
  byAgent: AgentCost[];
}
