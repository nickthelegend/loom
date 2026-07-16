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
    probe: () => cliAvailable("claude"),
  },
  {
    kind: "codex",
    label: "Codex",
    tier: "adapter",
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
    probe: () => cliAvailable("opencode"),
  },
  {
    kind: "grok-code",
    label: "Grok Code",
    tier: "adapter",
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
 * Roles are assigned by position, not by opinion. The first three ADEs found
 * take planner, executor and reviewer, because those are the names
 * buildDefaultRoutes wires the "ship" route from. Anything past the third gets
 * its own kind as its role: roles are free text, two agents sharing one would
 * make the route ambiguous, and deciding that Grok is "the reviewer" is an
 * opinion Loom hasn't earned. Rename them to whatever you actually think.
 */
const CANONICAL_ROLES = ["planner", "executor", "reviewer"];

export function defaultAgentConfigs(availability: Record<string, boolean>): AgentConfig[] {
  const found = adapterKinds().filter((kind) => availability[kind]);
  return found.map((kind, i) => ({
    id: kind,
    kind,
    role: CANONICAL_ROLES[i] ?? kind,
  }));
}
