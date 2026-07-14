/**
 * Loom Adapter SDK — build an adapter (full-duplex) or a bridge (read-mostly)
 * for a new agent and register it with `registerAgentKind`.
 *
 * Contract (see ARCHITECTURE.md):
 *  - Adapters MUST implement send / stream (onEvent) / injectMemory /
 *    interrupt / diff, and may hold the baton.
 *  - Bridges only observe and receive projections; they never hold the baton.
 */

export type {
  Adapter,
  AdapterEvent,
  AgentCapabilities,
  AgentConfig,
  AgentRole,
  AgentTier,
  AnyAgent,
  Bridge,
  EventKind,
  SendInput,
} from "./types.js";
export { isAdapter } from "./types.js";
export {
  AdapterBase,
  AgentBase,
  BridgeBase,
  cliAvailable,
  fetchJson,
  freePort,
  waitFor,
} from "./adapters/base.js";
export { registerAgentKind, createAgent, knownAgentKinds } from "./adapters/index.js";
export { EchoAdapter } from "./adapters/echo.js";
export { ClaudeCodeAdapter } from "./adapters/claude-code.js";
export { OpenCodeAdapter } from "./adapters/opencode.js";
export { AntigravityBridge } from "./adapters/bridges/antigravity.js";
