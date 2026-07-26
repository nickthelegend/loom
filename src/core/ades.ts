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
import { agyBin } from "../adapters/antigravity-cli.js";
import { cliAvailable } from "../adapters/base.js";
import { codexBin } from "../adapters/codex.js";
import { grokBin } from "../adapters/grok.js";

interface AdeCommon {
  /** The agent kind, as written in .loom/config.json. */
  kind: string;
  /** Human name, for docs and UI. */
  label: string;
}

/** Can hold the baton and run a turn headless. */
export interface AdeAdapterSpec extends AdeCommon {
  tier: "adapter";
  /** Is it usable on this machine right now? */
  probe: () => Promise<boolean>;
}

/**
 * A GUI app Loom drives over the DevTools protocol.
 *
 * No `probe`, and that's the point. A bridge needs its app running with a
 * debugging port, so "installed" answers nothing worth asking — the live
 * question is whether `GuiChatDriver` can reach it, which only the driver can
 * say. Kiro used to carry `probe: async () => false` to satisfy a type that
 * demanded one, and it was unreachable: every caller filters to adapters before
 * probing anything. Splitting the type deletes the dead code by making it
 * unwriteable, which is better than deleting it and leaving the hole open.
 */
export interface AdeBridgeSpec extends AdeCommon {
  tier: "bridge";
}

export type AdeSpec = AdeAdapterSpec | AdeBridgeSpec;

/**
 * Preference order matters: the first three adapters found get the canonical
 * planner/executor/reviewer roles that the default "ship" route is built from.
 *
 * There is no `models` list here any more. Each entry used to carry a handful
 * of model ids "as suggestions", they were serialised by
 * GET /api/projects/:id/agents/available, and nothing on the other end ever
 * read them — the picker asks
 * GET /api/projects/:id/agents/:agentId/models instead, which puts the question
 * to the CLI. So the field was a maintenance burden that shipped a second,
 * staler answer to a question already answered properly: codex's read
 * `gpt-5-codex, gpt-5, o4-mini` while `codex debug models` on the same machine
 * reported `gpt-5.6-terra, gpt-5.6-luna, gpt-5.5, gpt-5.4-mini`. Wrong is worse
 * than absent when the right answer is one HTTP call away.
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
    kind: "antigravity-cli",
    label: "Antigravity",
    tier: "adapter",
    probe: async () => {
      const bin = agyBin();
      return bin ? cliAvailable(bin) : false;
    },
  },
  {
    kind: "kiro",
    label: "Kiro",
    tier: "bridge",
  },
];

/**
 * A friendly default id for an auto-added agent. Almost always the kind itself
 * ("codex" is codex), but the Antigravity CLI reads better as just
 * "antigravity" — the `-cli` is an implementation detail, and it's the only
 * Antigravity now that the CDP bridge is no longer offered.
 */
function defaultIdFor(kind: string): string {
  return kind === "antigravity-cli" ? "antigravity" : kind;
}

/** The adapter entries, narrowed — the only ones that carry a probe. */
function adapterSpecs(): AdeAdapterSpec[] {
  return ADES.filter((a): a is AdeAdapterSpec => a.tier === "adapter");
}

/** Which kinds can hold the baton. */
export function adapterKinds(): string[] {
  return adapterSpecs().map((a) => a.kind);
}

/**
 * Probe every adapter on this machine, in parallel.
 *
 * Bridges are excluded on purpose: they need their GUI launched with a
 * debugging port, so "installed" tells you nothing about "drivable", and a
 * new project should not be born holding an agent that can't answer.
 */
export async function detectAdes(): Promise<Record<string, boolean>> {
  const adapters = adapterSpecs();
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
    .map((kind) => ({ id: defaultIdFor(kind), kind, role: defaultIdFor(kind) }));
}
