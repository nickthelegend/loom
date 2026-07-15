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
  | "status" // adapter/bridge lifecycle info
  | "error";

export interface LoomEvent {
  id: number;
  ts: number; // epoch ms
  kind: EventKind;
  /** Author agent id; absent for human/system events. */
  agentId?: string;
  payload: Record<string, unknown>;
}

export type NewEvent = {
  kind: EventKind;
  agentId?: string;
  payload: Record<string, unknown>;
  ts?: number;
};

// ---------------------------------------------------------------------------
// Agents & projects
// ---------------------------------------------------------------------------

export type AgentRole = "planner" | "executor" | "reviewer" | "general";

/** Adapter = full-duplex; bridge = read-mostly, never holds the baton. */
export type AgentTier = "adapter" | "bridge";

export interface AgentConfig {
  /** Stable instance id within the project, e.g. "claude-code". */
  id: string;
  /** Adapter kind, e.g. "claude-code" | "opencode" | "echo" | "antigravity". */
  kind: string;
  role: AgentRole;
  options?: Record<string, unknown>;
}

export interface ProjectConfig {
  name: string;
  agents: AgentConfig[];
  /** Agent that receives messages when nobody holds the baton. */
  defaultAgent?: string;
  /** Named multi-hop pipelines; steps are agent ids or roles. */
  routes?: Record<string, string[]>;
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
}

export interface ProjectStatus {
  id: string;
  name: string;
  dir: string;
  holder: string | null;
  agents: AgentStatus[];
  lastEvent: LoomEvent | null;
  needsInput: boolean;
  route?: RouteState | null;
  /** Named pipelines defined in config (for pickers/dropdowns). */
  routeNames?: string[];
}
