/**
 * Adapter factory — the one place agent kinds are wired up.
 * Community adapters register here (or via the SDK entry point).
 */
import { resolveModel, enforceModelCap } from "../core/model-routing.js";


import { readProjectConfig } from "../core/registry.js";
import { resolveAgentAccount } from "../core/accounts.js";
import { GateCancelled, turnGate } from "../core/turn-gate.js";
import { isAdapter, type AgentConfig, type AnyAgent, type SendInput } from "../types.js";
import { AntigravityCliAdapter } from "./antigravity-cli.js";
import { AntigravityBridge } from "./bridges/antigravity.js";
import { KiroBridge } from "./bridges/kiro.js";
import { DemoAdapter } from "./demo.js";
import { EchoAdapter } from "./echo.js";
import { GrokAdapter } from "./grok.js";
import { AcpAdapter } from "./acp.js";
import { ModelAdapter } from "./model.js";
import { OpenCodeAdapter } from "./opencode.js";
import { ModelPool } from "./model-pool.js";
import { ProviderAgent } from "../providers/agent.js";

export type AgentFactory = (
  cfg: AgentConfig,
  projectDir: string,
) => AnyAgent;

const factories = new Map<string, AgentFactory>();

/**
 * What each registered kind actually IS, without building one.
 *
 * `capabilities.tier` is the truth, but reading it means constructing the agent,
 * and the roster has to answer "adapter or bridge?" for kinds that are switched
 * off or not spawned — the exact case where there is no instance. Callers used
 * to fall back to "adapter" when a kind wasn't in the ADES catalog, which is
 * wrong for precisely the kinds that aren't in it: the withdrawn `antigravity`
 * bridge, and `echo`. A disabled bridge then advertised itself as an adapter,
 * and any surface that filters on that field offered it.
 */
const tiers = new Map<string, "adapter" | "bridge">();

export function registerAgentKind(
  kind: string,
  factory: AgentFactory,
  tier: "adapter" | "bridge" = "adapter",
): void {
  factories.set(kind, factory);
  tiers.set(kind, tier);
}

/** The tier a kind builds as, or null if nothing registers that kind. */
export function tierForKind(kind: string): "adapter" | "bridge" | null {
  return tiers.get(kind) ?? null;
}

registerAgentKind("demo", (cfg, dir) => new DemoAdapter(cfg.id, dir, cfg.options));
registerAgentKind("echo", (cfg, dir) => new EchoAdapter(cfg.id, "echo", dir, cfg.options));
// Codex and Claude Code run as warm provider sessions (src/providers/).
registerAgentKind("claude-code", (cfg, dir) => new ProviderAgent(cfg.id, "claude-code", dir, cfg.options));
registerAgentKind("codex", (cfg, dir) => new ProviderAgent(cfg.id, "codex", dir, cfg.options));
registerAgentKind("opencode", (cfg, dir) => new OpenCodeAdapter(cfg.id, dir, cfg.options));
registerAgentKind("grok-code", (cfg, dir) => new GrokAdapter(cfg.id, dir, cfg.options));
// An agent that is a model endpoint rather than a command — see adapters/model.ts.
registerAgentKind("model", (cfg, dir) => new ModelAdapter(cfg.id, dir, cfg.options));
// Any Agent Client Protocol agent (Claude/Codex ACP adapters, Gemini, OpenCode, Grok) — see adapters/acp.ts.
registerAgentKind("acp", (cfg, dir) => new AcpAdapter(cfg.id, dir, cfg.options));
registerAgentKind("antigravity-cli", (cfg, dir) => new AntigravityCliAdapter(cfg.id, dir, cfg.options));
registerAgentKind("antigravity", (cfg, dir) => new AntigravityBridge(cfg.id, dir, cfg.options), "bridge");
registerAgentKind("kiro", (cfg, dir) => new KiroBridge(cfg.id, dir, cfg.options), "bridge");

/**
 * Kinds Loom will still *build* but no longer *offers*.
 *
 * The Antigravity CDP bridge drove the IDE's chat panel over DevTools and could
 * only watch; `antigravity-cli` replaced it with a real adapter that holds the
 * baton, so the bridge came out of ADES. Coming out of ADES took it off every
 * surface that advertises an agent — except one: `addAgent` validated against
 * this registry, so POST /api/projects/:id/agents accepted `kind:"antigravity"`
 * from anyone who guessed the name and put a withdrawn thing in your roster
 * that no view would offer you.
 *
 * The registration stays because deleting it would break the projects that
 * already name it: `createAgent` throws on an unknown kind, and every agent in
 * .loom/config.json is constructed when the project opens, so a withdrawn
 * registration is a project that won't open rather than an agent that quietly
 * stops. Same standing `echo` has — buildable if you ask for it by name, never
 * handed to anyone who didn't. What changed is that asking is now something you
 * do by editing your own config, not something the HTTP API will do for you.
 */
const WITHDRAWN_KINDS = new Set(["antigravity"]);

/** Is this kind one Loom used to offer and no longer does? */
export function isWithdrawnKind(kind: string): boolean {
  return WITHDRAWN_KINDS.has(kind);
}

/** The project runtime pools process-bound models; standalone callers keep the concrete adapter. */
export function createAgent(cfg: AgentConfig, projectDir: string, poolModels = false): AnyAgent {
  cfg = resolveAgentAccount(cfg);
  if (!cfg.options?.effort && ["echo", "claude-code", "codex", "antigravity-cli"].includes(cfg.kind)) {
    const effort = readProjectConfig(projectDir)?.defaultEffort;
    if (effort) cfg = { ...cfg, options: { ...cfg.options, effort } };
  }
  const factory = factories.get(cfg.kind);
  if (!factory) {
    throw new Error(
      `unknown agent kind "${cfg.kind}" (known: ${[...factories.keys()].join(", ")})`,
    );
  }
  const resolved = { ...cfg, options: { ...cfg.options, ...(typeof cfg.options?.model === "string" ? { model: resolveModel(cfg.options.model) } : {}) } };
  const agent = factory(resolved, projectDir);
  if (poolModels && isAdapter(agent) && (!["claude-code", "codex", "model", "acp"].includes(cfg.kind) || (cfg.kind === "acp" && Boolean(cfg.options?.modelFlag)))) {
    return gated(new ModelPool(cfg, projectDir, agent, next => {
      const instance = factory(next, projectDir);
      if (!isAdapter(instance)) throw new Error(`"${cfg.kind}" did not build an adapter`);
      return instance;
    }), cfg, projectDir);
  }
  return gated(agent, cfg, projectDir);
}

/**
 * Every turn an adapter takes passes the daemon-wide gate (#339): past the cap on turns at
 * once, or short of free memory, it waits for a slot — and says so in the thread — instead
 * of piling onto a machine that's already full. LOOM_TURN_GATE=off skips it (tests).
 */
function gated(agent: AnyAgent, cfg: AgentConfig, projectDir: string): AnyAgent {
  if (!isAdapter(agent)) return agent;
  const gate = process.env.LOOM_TURN_GATE !== "off";
  const send = agent.send.bind(agent);
  const busy = agent.busy.bind(agent);
  let preparing = false;
  agent.busy = () => preparing || busy();
  const emit = (agent as unknown as { emit(e: { kind: "status"; payload: Record<string, unknown> }): void }).emit.bind(agent);
  const say = (why: string) => emit({ kind: "status", payload: { state: "queued_for_slot", text: `waiting for a free slot — ${why}` } });
  // A turn waiting here hasn't reached the adapter, so the adapter isn't busy and
  // its own interrupt has nothing to stop. Stop has to reach the wait instead.
  const interrupt = agent.interrupt.bind(agent);
  let waiting: AbortController | null = null;
  agent.interrupt = async () => {
    if (waiting) {
      waiting.abort();
      return;
    }
    return interrupt();
  };
  agent.send = async (input: SendInput) => {
    if (preparing || busy()) throw new Error(`agent "${cfg.id}" is busy`);
    const selected = input.model ?? (typeof cfg.options?.model === "string" ? cfg.options.model : undefined);
    const model = selected ? resolveModel(selected) : undefined;
    input = { ...input, ...(model ? { model } : {}) };
    preparing = true;
    let release = () => {};
    const ctl = new AbortController();
    waiting = ctl;
    if (gate) slotWaiters.add(agent);
    try {
      if (gate) release = await turnGate.acquire(`${projectDir.split(/[\\/]/).pop()}: ${cfg.id}`, say, ctl.signal);
      const cap = enforceModelCap(model);
      if (cap) await cap;
    } catch (err) {
      release();
      if (err instanceof GateCancelled) {
        emit({ kind: "status", payload: { state: "interrupted" } });
        return;
      }
      throw err;
    } finally {
      preparing = false;
      if (waiting === ctl) {
        waiting = null;
        slotWaiters.delete(agent);
      }
    }
    // The concrete adapter owns busy state from here, including completion
    // events that can synchronously trigger the next turn.
    try { return await send(input); }
    finally { release(); }
  };
  return agent;
}

/** Adapters whose turn is waiting at the gate — not busy yet, but stoppable. */
const slotWaiters = new WeakSet<object>();

/** Is this agent's turn waiting for a daemon slot? Stop treats it as running. */
export function waitingForSlot(agent: unknown): boolean {
  return typeof agent === "object" && agent !== null && slotWaiters.has(agent);
}

export function knownAgentKinds(): string[] {
  return [...factories.keys()];
}
