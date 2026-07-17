/**
 * Routes — automated multi-hop handoffs. "Claude plans, OpenCode executes,
 * Claude reviews" as one command instead of three manual baton passes.
 *
 * The engine reuses the exact same machinery as manual handoffs (interrupt →
 * projection → briefing → baton), it just drives the sequence:
 *
 *   start(steps, task)
 *     └─ step i: handoff(agent_i) → send(instruction_i)
 *          run_complete, no question  → advance to step i+1
 *          run_complete, agent asked  → pause (waiting_human) + notify
 *              user answers in chat   → resume, next run_complete advances
 *          error / timeout            → route fails
 *   last step completes → route_completed + notify
 *
 * The human always outranks the route: a manual handoff or interrupt cancels
 * it. State persists in .loom/state.json; a daemon restart mid-route marks it
 * failed rather than pretending nothing happened.
 */

import type {
  AgentRole,
  LoomEvent,
  ProjectConfig,
  RouteState,
  RouteStepSpec,
  RouterKind,
} from "../types.js";
import type { EventLog } from "./eventlog.js";
import { notify } from "./notify.js";
import { newId, readProjectState, writeProjectState } from "./registry.js";
import { llmRouter, rulesRouter, type HopDecision, type RouterContext } from "./router.js";

const DEFAULT_STEP_TIMEOUT_MS = 45 * 60 * 1000;
const DEFAULT_MAX_HOPS = 8;

export class RouteActiveError extends Error {
  constructor() {
    super("a route is already active in this project — finish or abort it first");
    this.name = "RouteActiveError";
  }
}

/** What the engine needs from the project runtime (avoids a circular import). */
export interface RouteHost {
  projectName: string;
  projectDir: string;
  config: ProjectConfig;
  log: EventLog;
  handoff(to: string): Promise<unknown>;
  send(text: string, agentId: string): Promise<unknown>;
  interrupt(): Promise<unknown>;
  isAdapterId(id: string): boolean;
  /** Lifetime project spend (USD) — used to attribute cost to routes. */
  costTotal(): number;
}

export interface ResolvedSteps {
  ids: string[];
  /** Parallel to ids; null when the step carries no custom instruction. */
  instructions: Array<string | null>;
  /**
   * Parallel to ids; the job the step assigns, or null to inherit the agent's
   * own role. This is what lets a task say "claude-code plans, opencode
   * executes" without permanently changing either agent's default role.
   */
  roles: Array<string | null>;
}

export function stepName(spec: RouteStepSpec): string {
  return typeof spec === "string" ? spec : spec.step;
}

/** Resolve step specs (ids/roles, optionally with instructions) to adapter ids. */
export function resolveSteps(
  spec: RouteStepSpec[],
  config: ProjectConfig,
  isAdapterId: (id: string) => boolean,
): ResolvedSteps {
  if (!spec.length) throw new Error("a route needs at least one step");
  const ids: string[] = [];
  const instructions: Array<string | null> = [];
  const roles: Array<string | null> = [];
  for (const entry of spec) {
    const step = stepName(entry);
    const byId = config.agents.find((a) => a.id === step);
    const byRole = config.agents.find((a) => a.role === step && isAdapterId(a.id));
    const cfg = byId ?? byRole;
    if (!cfg) {
      throw new Error(`route step "${step}" matches no agent id or role in this project`);
    }
    if (!isAdapterId(cfg.id)) {
      throw new Error(
        `route step "${step}" resolves to "${cfg.id}", a bridge — bridges never hold the baton`,
      );
    }
    ids.push(cfg.id);
    instructions.push(
      typeof entry === "object" && entry.instruction?.trim() ? entry.instruction.trim() : null,
    );
    roles.push(
      typeof entry === "object" && entry.role?.trim() ? entry.role.trim().slice(0, 40) : null,
    );
  }
  return { ids, instructions, roles };
}

const ROLE_INSTRUCTIONS: Record<AgentRole, string> = {
  planner:
    "Produce a concrete, actionable plan for the task. Be specific about files and steps, and state clearly when the plan is complete.",
  executor:
    "Execute the work using the shared context handed to you. State clearly when the implementation is complete.",
  reviewer:
    "Review the preceding work for correctness, gaps and risks. Give a clear verdict and list any required fixes.",
  general: "Continue the task using the shared context handed to you.",
};

export class RouteEngine {
  private host: RouteHost;
  private sawNeedsInput = false;
  private lastQuestion: string | undefined;
  private stepTimer: NodeJS.Timeout | null = null;

  constructor(host: RouteHost) {
    this.host = host;
    this.failStaleOnBoot();
  }

  // ---------------------------------------------------------------------
  // State persistence (.loom/state.json — same pattern as the baton)
  // ---------------------------------------------------------------------

  private read(): RouteState | undefined {
    return readProjectState(this.host.projectDir).route;
  }

  private write(route: RouteState): void {
    const state = readProjectState(this.host.projectDir);
    route.updatedAt = Date.now();
    state.route = route;
    writeProjectState(this.host.projectDir, state);
  }

  state(): RouteState | null {
    return this.read() ?? null;
  }

  isActive(): boolean {
    const r = this.read();
    return Boolean(r && (r.status === "running" || r.status === "waiting_human"));
  }

  private failStaleOnBoot(): void {
    const r = this.read();
    if (r && (r.status === "running" || r.status === "waiting_human")) {
      r.status = "failed";
      r.reason = "daemon restarted mid-route";
      this.write(r);
      this.host.log.append({
        kind: "route_failed",
        payload: { routeId: r.id, reason: r.reason },
      });
    }
  }

  // ---------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------

  async start(spec: RouteStepSpec[], task: string, name?: string): Promise<RouteState> {
    if (this.isActive()) throw new RouteActiveError();
    const resolved = resolveSteps(spec, this.host.config, this.host.isAdapterId);
    // The step's assigned role wins; fall back to the agent's own default role
    // when the task didn't say. This is the seam that makes roles per-task.
    const stepRoles = resolved.ids.map(
      (id, i) => resolved.roles[i] ?? this.host.config.agents.find((a) => a.id === id)!.role,
    );
    const route: RouteState = {
      id: newId(4),
      ...(name ? { name } : {}),
      task,
      steps: resolved.ids,
      stepRoles,
      stepInstructions: resolved.instructions,
      current: 0,
      status: "running",
      mode: "static",
      costStartUsd: this.host.costTotal(),
      startedAt: Date.now(),
      updatedAt: Date.now(),
    };
    this.write(route);
    this.host.log.append({
      kind: "route_started",
      payload: { routeId: route.id, name: name ?? null, mode: "static", steps: resolved.ids, task },
    });
    await this.beginStep(route);
    return this.read()!;
  }

  /** Dynamic route: a router (LLM or rules) picks every next hop. */
  async startDynamic(
    task: string,
    opts: { router?: RouterKind; maxHops?: number } = {},
  ): Promise<RouteState> {
    if (this.isActive()) throw new RouteActiveError();
    const router = opts.router ?? "llm";
    const route: RouteState = {
      id: newId(4),
      name: "auto",
      task,
      steps: [],
      stepRoles: [],
      current: -1,
      status: "running",
      mode: "dynamic",
      router,
      maxHops: opts.maxHops ?? DEFAULT_MAX_HOPS,
      costStartUsd: this.host.costTotal(),
      startedAt: Date.now(),
      updatedAt: Date.now(),
    };
    this.write(route);
    this.host.log.append({
      kind: "route_started",
      payload: { routeId: route.id, name: "auto", mode: "dynamic", router, task },
    });
    const decision = await this.decide(route);
    if (decision.next === "done") {
      this.finish(route, "failed", `router declined to start: ${decision.reason}`);
      return this.read()!;
    }
    this.pushHop(route, decision);
    await this.beginStep(route);
    return this.read()!;
  }

  private routerContext(r: RouteState): RouterContext {
    const agents = this.host.config.agents
      .filter((a) => this.host.isAdapterId(a.id))
      .map((a) => ({ id: a.id, role: a.role }));
    const recent = this.host.log
      .list({ kinds: ["message"], limit: 12 })
      .map((e) => ({
        author: e.agentId ?? String(e.payload.author ?? "user"),
        text: String(e.payload.text ?? ""),
      }));
    return { task: r.task, hops: [...r.steps], agents, recent };
  }

  private async decide(r: RouteState): Promise<HopDecision> {
    const ctx = this.routerContext(r);
    if (r.router === "llm") return llmRouter(ctx);
    return rulesRouter(ctx);
  }

  private pushHop(r: RouteState, decision: HopDecision): void {
    const role =
      this.host.config.agents.find((a) => a.id === decision.next)?.role ?? "general";
    r.steps.push(decision.next);
    r.stepRoles.push(role);
    r.stepInstructions = [...(r.stepInstructions ?? []), null];
    r.current = r.steps.length - 1;
    r.reason = decision.reason;
    this.write(r);
  }

  async abort(reason = "aborted by user"): Promise<RouteState> {
    const r = this.read();
    if (!r || !this.isActive()) throw new Error("no active route to abort");
    this.finish(r, "aborted", reason);
    await this.host.interrupt().catch(() => {});
    return this.read()!;
  }

  /** A manual baton pass while a route is active cancels the route. */
  onManualHandoff(): void {
    const r = this.read();
    if (r && this.isActive()) this.finish(r, "aborted", "manual handoff — route cancelled");
  }

  /** A manual interrupt while a route is active cancels the route. */
  onManualInterrupt(): void {
    const r = this.read();
    if (r && this.isActive()) this.finish(r, "aborted", "manual interrupt — route cancelled");
  }

  /**
   * A user message addressed to the current step's agent while the route is
   * paused = the answer to the agent's question. Resume; the next
   * run_complete advances the route.
   */
  onUserMessage(targetAgentId: string): void {
    const r = this.read();
    if (!r || r.status !== "waiting_human") return;
    if (targetAgentId !== r.steps[r.current]) return;
    this.sawNeedsInput = false;
    delete r.pendingQuestion;
    r.status = "running";
    this.write(r);
    this.host.log.append({
      kind: "route_resumed",
      payload: { routeId: r.id, step: r.current, agent: targetAgentId },
    });
  }

  /** Fed every adapter event by the runtime; drives the state machine. */
  handleAgentEvent(event: LoomEvent): void {
    const r = this.read();
    if (!r || (r.status !== "running" && r.status !== "waiting_human")) return;
    const currentAgent = r.steps[r.current];
    if (!event.agentId || event.agentId !== currentAgent) return;

    if (event.kind === "needs_input") {
      this.sawNeedsInput = true;
      this.lastQuestion = String(event.payload.question ?? "");
      return;
    }

    if (event.kind === "error" && r.status === "running") {
      this.finish(
        r,
        "failed",
        `step ${r.current + 1} (${currentAgent}) errored: ${String(event.payload.message ?? "unknown")}`,
      );
      return;
    }

    if (event.kind === "run_complete" && r.status === "running") {
      if (this.sawNeedsInput) {
        r.status = "waiting_human";
        r.pendingQuestion = this.lastQuestion ?? "";
        this.write(r);
        this.host.log.append({
          kind: "route_paused",
          payload: {
            routeId: r.id,
            step: r.current,
            agent: currentAgent,
            question: r.pendingQuestion,
          },
        });
        notify({
          title: `Loom · ${this.host.projectName}`,
          body: `route paused — ${currentAgent} asks: ${r.pendingQuestion}`,
        });
        return;
      }
      void this.advance(r).catch((err) =>
        this.finish(r, "failed", String(err instanceof Error ? err.message : err)),
      );
    }
  }

  // ---------------------------------------------------------------------
  // Step mechanics
  // ---------------------------------------------------------------------

  private routeCost(r: RouteState): number {
    return Math.max(0, this.host.costTotal() - (r.costStartUsd ?? 0));
  }

  private complete(r: RouteState, note?: string): void {
    r.status = "completed";
    if (note) r.reason = note;
    r.costUsd = this.routeCost(r);
    this.write(r);
    this.host.log.append({
      kind: "route_completed",
      payload: {
        routeId: r.id,
        steps: r.steps.length,
        task: r.task,
        costUsd: r.costUsd,
        ...(note ? { note } : {}),
      },
    });
    notify({
      title: `Loom · ${this.host.projectName}`,
      body: `route complete: ${r.steps.join(" → ")}`,
    });
  }

  private async advance(r: RouteState): Promise<void> {
    this.clearTimer();

    if (r.mode === "dynamic") {
      if (r.steps.length >= (r.maxHops ?? DEFAULT_MAX_HOPS)) {
        this.complete(r, `hop budget (${r.maxHops ?? DEFAULT_MAX_HOPS}) reached`);
        return;
      }
      const decision = await this.decide(r);
      if (decision.next === "done") {
        this.complete(r, decision.reason);
        return;
      }
      this.pushHop(r, decision);
      await this.beginStep(r);
      return;
    }

    r.current += 1;
    if (r.current >= r.steps.length) {
      this.complete(r);
      return;
    }
    this.write(r);
    await this.beginStep(r);
  }

  private async beginStep(r: RouteState): Promise<void> {
    const agent = r.steps[r.current]!;
    this.sawNeedsInput = false;
    this.lastQuestion = undefined;
    this.host.log.append({
      kind: "route_step",
      payload: {
        routeId: r.id,
        step: r.current,
        of: r.mode === "static" ? r.steps.length : null,
        agent,
        ...(r.mode === "dynamic" && r.reason ? { reason: r.reason } : {}),
      },
    });
    this.armTimer(r.id, r.current);
    try {
      await this.host.handoff(agent);
      await this.host.send(this.instruction(r), agent);
    } catch (err) {
      const fresh = this.read();
      if (fresh && fresh.id === r.id) {
        this.finish(
          fresh,
          "failed",
          `step ${r.current + 1} (${agent}) could not start: ${String(err instanceof Error ? err.message : err)}`,
        );
      }
    }
  }

  private instruction(r: RouteState): string {
    const i = r.current;
    const role = r.stepRoles[i] ?? "general";
    const position = r.mode === "static" ? `step ${i + 1}/${r.steps.length}` : `hop ${i + 1}`;
    const header = `[Loom route${r.name ? ` "${r.name}"` : ""} — ${position} (${role})]`;
    const continuity =
      i === 0
        ? ""
        : "The previous step has completed; its full context was handed to you via the Loom briefing and .loom/memory.\n";
    const custom = r.stepInstructions?.[i];
    const focus = custom ? `\nStep-specific instructions: ${custom}` : "";
    return `${header}\nTask: ${r.task}\n${continuity}${ROLE_INSTRUCTIONS[role] ?? ROLE_INSTRUCTIONS.general}${focus}`;
  }

  private finish(r: RouteState, status: "failed" | "aborted", reason: string): void {
    this.clearTimer();
    r.status = status;
    r.reason = reason;
    r.costUsd = this.routeCost(r);
    delete r.pendingQuestion;
    this.write(r);
    this.host.log.append({
      kind: "route_failed",
      payload: { routeId: r.id, reason, aborted: status === "aborted" },
    });
    if (status === "failed") {
      notify({ title: `Loom · ${this.host.projectName}`, body: `route failed: ${reason}` });
    }
  }

  private armTimer(routeId: string, stepIndex: number): void {
    this.clearTimer();
    const timeoutMs = Number(process.env.LOOM_ROUTE_STEP_TIMEOUT_MS) || DEFAULT_STEP_TIMEOUT_MS;
    this.stepTimer = setTimeout(() => {
      const r = this.read();
      if (r && r.id === routeId && r.current === stepIndex && r.status === "running") {
        this.finish(r, "failed", `step ${stepIndex + 1} timed out`);
        void this.host.interrupt().catch(() => {});
      }
    }, timeoutMs);
    this.stepTimer.unref?.();
  }

  private clearTimer(): void {
    if (this.stepTimer) clearTimeout(this.stepTimer);
    this.stepTimer = null;
  }
}
