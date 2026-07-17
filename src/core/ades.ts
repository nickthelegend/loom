/**
 * The ADEs Loom knows how to drive, in one list.
 *
 * This exists because "which agents are real" used to be answered in three
 * places at once: a hardcoded probe pair in the daemon, a hardcoded pair in
 * defaultAgentConfigs, and a set of logos in the web app that agreed with
 * neither. The UI shipped Codex and Kiro marks for kinds `loom` would reject.
 * One list, and the answer is the same everywhere.
 *
 * An entry here is a claim that Loom can actually drive the thing. If it can't
 * yet, it doesn't get a row — a logo is not an integration.
 */

import type { AgentConfig } from "../types.js";
import { cliAvailable } from "../adapters/base.js";
import { codexBin } from "../adapters/codex.js";
import { grokBin } from "../adapters/grok.js";

export interface AdeSpec {
  /** The agent kind, as written in .loom/config.json. */
  kind: string;
  /** Human name, for docs and UI. */
  label: string;
  /**
   * adapter — can hold the baton and run a turn headless.
   * bridge  — a GUI app Loom drives over the DevTools protocol; needs the app
   *           running with a debugging port, so it is never auto-added.
   */
  tier: "adapter" | "bridge";
  /** Is it usable on this machine right now? */
  probe: () => Promise<boolean>;
  /**
   * Common model values this ADE's CLI accepts, as the model picker's
   * suggestions. Not exhaustive and not the truth about what's installed —
   * the picker always offers "Default" (no --model, the CLI's own choice) and
   * a custom field, so a stale entry here is a convenience that went out of
   * date, never a wall. Empty for bridges: a GUI app picks its own model in its
   * own window, and Loom doesn't get a flag.
   */
  models?: string[];
}

/**
 * Preference order matters: the first three adapters found get the canonical
 * planner/executor/reviewer roles that the default "ship" route is built from.
 */
export const ADES: AdeSpec[] = [
  {
    kind: "claude-code",
    label: "Claude Code",
    tier: "adapter",
    // The CLI takes short aliases as well as full ids; the aliases don't go
    // stale when a new snapshot ships, which the full ids do.
    models: ["opus", "sonnet", "haiku"],
    probe: () => cliAvailable("claude"),
  },
  {
    kind: "codex",
    label: "Codex",
    tier: "adapter",
    models: ["gpt-5-codex", "gpt-5", "o4-mini"],
    // The CLI ships inside Codex.app as well as on PATH; a Mac with the app and
    // an empty PATH is the common case.
    probe: async () => {
      const bin = codexBin();
      return bin ? cliAvailable(bin) : false;
    },
  },
  {
    kind: "opencode",
    label: "OpenCode",
    tier: "adapter",
    // opencode wants provider/model, and which providers exist is that install's
    // business — so these are examples, and the custom field is the real path.
    models: ["anthropic/claude-sonnet-4", "openai/gpt-5", "google/gemini-2.5-pro"],
    probe: () => cliAvailable("opencode"),
  },
  {
    kind: "grok-code",
    label: "Grok Code",
    tier: "adapter",
    models: ["grok-code-fast-1", "grok-4"],
    probe: async () => {
      const bin = grokBin();
      return bin ? cliAvailable(bin) : false;
    },
  },
  {
    kind: "antigravity",
    label: "Antigravity",
    tier: "bridge",
    // Presence is decided by the debugging port, not by a file on disk: an
    // installed-but-closed Antigravity is not something Loom can drive.
    probe: async () => false,
  },
  {
    kind: "kiro",
    label: "Kiro",
    tier: "bridge",
    probe: async () => false,
  },
];

/** Which kinds can hold the baton. */
export function adapterKinds(): string[] {
  return ADES.filter((a) => a.tier === "adapter").map((a) => a.kind);
}

/**
 * Probe every adapter on this machine, in parallel.
 *
 * Bridges are excluded on purpose: they need their GUI launched with a
 * debugging port, so "installed" tells you nothing about "drivable", and a
 * new project should not be born holding an agent that can't answer.
 */
export async function detectAdes(): Promise<Record<string, boolean>> {
  const adapters = ADES.filter((a) => a.tier === "adapter");
  const results = await Promise.all(adapters.map((a) => a.probe().catch(() => false)));
  const out: Record<string, boolean> = {};
  adapters.forEach((a, i) => (out[a.kind] = results[i] ?? false));
  return out;
}

/** Default "ship" pipeline over whichever of planner/executor/reviewer exist. */
export function buildDefaultRoutes(agents: AgentConfig[]): Record<string, string[]> | undefined {
  const order = ["planner", "executor", "reviewer"];
  const steps = order.filter((role) => agents.some((a) => a.role === role));
  return steps.length >= 2 ? { ship: steps } : undefined;
}

/**
 * The agents a new project starts with: the ADEs actually installed here, and
 * nothing else.
 *
 * It used to fall back to an `echo` agent when it found none. echo is a test
 * double — it replies with your own message and reports a made-up $0.001 — so
 * a machine without claude or opencode got a project whose "agent" faked every
 * turn, presented as a detected ADE. Better an empty roster and an honest "no
 * ADEs found". (echo is still a registered kind; you can ask for it by name in
 * .loom/config.json. It just isn't handed to anyone who didn't.)
 *
 * **Every agent's role is its own kind, and that isn't a placeholder.**
 *
 * This used to hand out planner / executor / reviewer by detection order, so
 * Claude Code became "the planner" and OpenCode became "the executor" because
 * of where they sat in a list in this file. Nobody decided that. It read like a
 * recommendation Loom had earned, it was an accident of iteration order, and it
 * quietly shaped how people used their own agents.
 *
 * A role is a job you define. Loom doesn't know which of your agents should
 * plan, and pretending it does is worse than saying nothing — so the default
 * describes rather than assigns ("codex" is codex), and you rename it to the
 * job you actually have. The rail's agent picker does that; so does
 * POST /api/projects/:id/agents/:agentId/role.
 */
export function defaultAgentConfigs(availability: Record<string, boolean>): AgentConfig[] {
  return adapterKinds()
    .filter((kind) => availability[kind])
    .map((kind) => ({ id: kind, kind, role: kind }));
}
