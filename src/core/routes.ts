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

import type { AgentRole, LoomEvent, ProjectConfig, RouteState } from "../types.js";
import type { EventLog } from "./eventlog.js";
import { notify } from "./notify.js";
import { newId, readProjectState, writeProjectState } from "./registry.js";

const DEFAULT_STEP_TIMEOUT_MS = 45 * 60 * 1000;

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
}

/** Resolve step specs (agent ids or roles) to concrete adapter ids. */
export function resolveSteps(
  spec: string[],
  config: ProjectConfig,
  isAdapterId: (id: string) => boolean,
): string[] {
  if (!spec.length) throw new Error("a route needs at least one step");
  return spec.map((step) => {
    const byId = config.agents.find((a) => a.id === step);
    const byRole = config.agents.find((a) => a.role === step && isAdapterId(a.id));
    const cfg = byId ?? byRole;
    if (!cfg) {
      throw new Error(
        `route step "${step}" matches no agent id or role in this project`,
      );
    }
    if (!isAdapterId(cfg.id)) {
      throw new Error(
        `route step "${step}" resolves to "${cfg.id}", a bridge — bridges never hold the baton`,
      );
    }
    return cfg.id;
  });
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

  async start(spec: string[], task: string, name?: string): Promise<RouteState> {
    if (this.isActive()) throw new RouteActiveError();
    const steps = resolveSteps(spec, this.host.config, this.host.isAdapterId);
    const stepRoles = steps.map(
      (id) => this.host.config.agents.find((a) => a.id === id)!.role,
    );
    const route: RouteState = {
      id: newId(4),
      ...(name ? { name } : {}),
      task,
      steps,
      stepRoles,
      current: 0,
      status: "running",
      startedAt: Date.now(),
      updatedAt: Date.now(),
    };
    this.write(route);
    this.host.log.append({
      kind: "route_started",
      payload: { routeId: route.id, name: name ?? null, steps, task },
    });
    await this.beginStep(route);
    return this.read()!;
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

  private async advance(r: RouteState): Promise<void> {
    this.clearTimer();
    r.current += 1;
    if (r.current >= r.steps.length) {
      r.status = "completed";
      this.write(r);
      this.host.log.append({
        kind: "route_completed",
        payload: { routeId: r.id, steps: r.steps.length, task: r.task },
      });
      notify({
        title: `Loom · ${this.host.projectName}`,
        body: `route complete: ${r.steps.join(" → ")}`,
      });
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
      payload: { routeId: r.id, step: r.current, of: r.steps.length, agent },
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
    const header = `[Loom route${r.name ? ` "${r.name}"` : ""} — step ${i + 1}/${r.steps.length} (${role})]`;
    const continuity =
      i === 0
        ? ""
        : "The previous step has completed; its full context was handed to you via the Loom briefing and .loom/memory.\n";
    return `${header}\nTask: ${r.task}\n${continuity}${ROLE_INSTRUCTIONS[role] ?? ROLE_INSTRUCTIONS.general}`;
  }

  private finish(r: RouteState, status: "failed" | "aborted", reason: string): void {
    this.clearTimer();
    r.status = status;
    r.reason = reason;
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
