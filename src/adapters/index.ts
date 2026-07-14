/**
 * Adapter factory — the one place agent kinds are wired up.
 * Community adapters register here (or via the SDK entry point).
 */

import type { AgentConfig, AnyAgent } from "../types.js";
import { AntigravityBridge } from "./bridges/antigravity.js";
import { ClaudeCodeAdapter } from "./claude-code.js";
import { EchoAdapter } from "./echo.js";
import { OpenCodeAdapter } from "./opencode.js";

export type AgentFactory = (
  cfg: AgentConfig,
  projectDir: string,
) => AnyAgent;

const factories = new Map<string, AgentFactory>();

export function registerAgentKind(kind: string, factory: AgentFactory): void {
  factories.set(kind, factory);
}

registerAgentKind("echo", (cfg, dir) => new EchoAdapter(cfg.id, "echo", dir));
registerAgentKind("claude-code", (cfg, dir) => new ClaudeCodeAdapter(cfg.id, dir, cfg.options));
registerAgentKind("opencode", (cfg, dir) => new OpenCodeAdapter(cfg.id, dir, cfg.options));
registerAgentKind("antigravity", (cfg, dir) => new AntigravityBridge(cfg.id, dir, cfg.options));

export function createAgent(cfg: AgentConfig, projectDir: string): AnyAgent {
  const factory = factories.get(cfg.kind);
  if (!factory) {
    throw new Error(
      `unknown agent kind "${cfg.kind}" (known: ${[...factories.keys()].join(", ")})`,
    );
  }
  return factory(cfg, projectDir);
}

export function knownAgentKinds(): string[] {
  return [...factories.keys()];
}
