/**
 * Suggested handoffs — routing stays manual (the user confirms every baton
 * pass), but Loom watches the stream for natural boundaries and *offers*
 * the next hop. This is the stepping stone toward auto-routing.
 */

import type { AgentRole, LoomEvent, ProjectConfig } from "../types.js";

const PLAN_DONE =
  /\b(plan(?:ning)?\s+(?:is\s+)?(?:complete|ready|done|final(?:ized)?)|ready\s+(?:for|to)\s+(?:implement|execution|execute|build)|implementation\s+plan\b.*\b(?:below|follows|ready))/i;
const EXEC_DONE =
  /\b(implementation\s+(?:is\s+)?(?:complete|done|finished)|all\s+tests?\s+pass(?:ing)?|ready\s+for\s+review)\b/i;

function firstWithRole(cfg: ProjectConfig, role: AgentRole, excludeId?: string) {
  return cfg.agents.find((a) => a.role === role && a.id !== excludeId);
}

export interface Suggestion {
  to: string;
  reason: string;
}

/**
 * Inspect a freshly appended event; return a handoff suggestion or null.
 * Only message events from the current baton holder are considered.
 */
export function suggestHandoff(
  event: LoomEvent,
  cfg: ProjectConfig,
  holder: string | null,
): Suggestion | null {
  if (event.kind !== "message" || !event.agentId) return null;
  if (holder && event.agentId !== holder) return null;

  const speaker = cfg.agents.find((a) => a.id === event.agentId);
  if (!speaker) return null;
  const text = String(event.payload.text ?? "");

  if (speaker.role === "planner" && PLAN_DONE.test(text)) {
    const executor = firstWithRole(cfg, "executor", speaker.id);
    if (executor) {
      return { to: executor.id, reason: "plan looks complete — hand to the executor?" };
    }
  }
  if (speaker.role === "executor" && EXEC_DONE.test(text)) {
    const reviewer =
      firstWithRole(cfg, "reviewer", speaker.id) ?? firstWithRole(cfg, "planner", speaker.id);
    if (reviewer) {
      return { to: reviewer.id, reason: "execution looks done — hand back for review?" };
    }
  }
  return null;
}
