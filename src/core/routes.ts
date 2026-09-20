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
import {
  conditionHolds,
  describeFacts,
  describeStepCondition,
  NO_CHANGES,
  parseStepCondition,
  type TurnFacts,
} from "./step-conditions.js";

const DEFAULT_STEP_TIMEOUT_MS = 45 * 60 * 1000;
const DEFAULT_MAX_HOPS = 8;

export class RouteActiveError extends Error {
  constructor() {
    super("a route is already active in this project — finish or abort it first");
    this.name = "RouteActiveError";
  }
}

/**
 * What a handoff reports back. Only the merge matters to a route: with
 * `git.mergeOnHandoff` on, the baton carries the outgoing agent's branch into
 * the incoming agent's worktree, and that can conflict.
 */
export interface HandoffOutcome {
  merge?: { state: string; files?: string[] };
}

/** What the engine needs from the project runtime (avoids a circular import). */
export interface RouteHost {
  projectName: string;
  projectDir: string;
  config: ProjectConfig;
  log: EventLog;
  handoff(to: string): Promise<HandoffOutcome>;
  send(text: string, agentId: string): Promise<unknown>;
  interrupt(): Promise<unknown>;
  isAdapterId(id: string): boolean;
  /** Lifetime project spend (USD) — used to attribute cost to routes. */
  costTotal(): number;
  /**
   * What the agent's last turn actually changed, once the runtime has worked
   * it out. Step conditions read this; a host that can't say returns zeroes,
   * and every threshold condition then reads false — a route that can't
   * measure a turn doesn't get to guess about it.
   */
  turnFacts(agentId: string): Promise<TurnFacts>;
}

export interface ResolvedSteps {
  ids: string[];
  /** Parallel to ids; null when the step carries no custom instruction. */
  instructions: Array<string | null>;
  /** Parallel to ids; the step to jump back to when this one errors. */
  onFail: Array<string | null>;
  /**
   * Parallel to ids; the job the step assigns, or null to inherit the agent's
   * own role. This is what lets a task say "claude-code plans, opencode
   * executes" without permanently changing either agent's default role.
   */
  roles: Array<string | null>;
  /**
   * Parallel to ids; the condition the previous turn must meet for this step
   * to run at all, or null when it always runs. Kept as the text that was
   * written — it was already validated, and the thread quotes it back.
   */
  when: Array<string | null>;
}

/**
 * A step written inline can carry its condition after a `?`:
 * `reviewer?lines>200`. That way a saved route — which is a list of strings —
 * can hold one without anyone hand-editing config.json.
 */
function splitInline(step: string): { step: string; when: string | null } {
  const at = step.indexOf("?");
  if (at === -1) return { step: step.trim(), when: null };
  return { step: step.slice(0, at).trim(), when: step.slice(at + 1).trim() || null };
}

export function stepName(spec: RouteStepSpec): string {
  return splitInline(typeof spec === "string" ? spec : spec.step).step;
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
  const onFail: Array<string | null> = [];
  const when: Array<string | null> = [];
  for (const entry of spec) {
    const inline = splitInline(typeof entry === "string" ? entry : entry.step);
    const step = inline.step;
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
    onFail.push(typeof entry === "object" && entry.onFail?.trim() ? entry.onFail.trim() : null);

    // A condition is checked here, where the mistake is fixable, rather than
    // at run time where an unreadable one would quietly never match.
    const cond =
      (typeof entry === "object" && entry.when?.trim() ? entry.when.trim() : null) ?? inline.when;
    if (cond) {
      parseStepCondition(cond); // throws with what it does understand
      if (when.length === 0) {
        throw new Error(
          `the first step can't be conditional ("${cond}") — there's no turn before it to measure`,
        );
      }
    }
    when.push(cond);
  }
  // onFail targets resolve the same way steps do, and must point BACKWARD:
  // a forward jump on failure would skip work, and a self-jump is a retry
  // loop with no progress between attempts.
  const resolvedOnFail = onFail.map((target, i) => {
    if (!target) return null;
    const byId = config.agents.find((a) => a.id === target);
    const byRole = config.agents.find((a) => a.role === target && isAdapterId(a.id));
    const targetId = (byId ?? byRole)?.id;
    if (!targetId) throw new Error(`onFail "${target}" matches no agent id or role`);
    const at = ids.slice(0, i).lastIndexOf(targetId);
    if (at === -1) {
      throw new Error(
        `step ${i + 1}'s onFail "${target}" must name an EARLIER step — loops go backward`,
      );
    }
    return targetId;
  });
  return { ids, instructions, roles, onFail: resolvedOnFail, when };
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
      ...(resolved.onFail.some(Boolean)
        ? { stepOnFail: resolved.onFail, loops: 0, maxLoops: 3 }
        : {}),
      ...(resolved.when.some(Boolean) ? { stepWhen: resolved.when } : {}),
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
      // A step with an onFail loops back instead of sinking the route — the
      // "review fails → back to execute" arrow, as data. Budgeted: three
      // re-entries, then the route fails with the loop named, because a
      // pipeline that never converges should say so rather than orbit.
      const jumpTo = r.mode === "static" ? (r.stepOnFail?.[r.current] ?? null) : null;
      if (jumpTo) {
        const budget = r.maxLoops ?? 3;
        if ((r.loops ?? 0) >= budget) {
          this.finish(
            r,
            "failed",
            `step ${r.current + 1} (${currentAgent}) kept failing after ${budget} loops back to "${jumpTo}"`,
          );
          return;
        }
        const backTo = r.steps.slice(0, r.current).lastIndexOf(jumpTo);
        r.loops = (r.loops ?? 0) + 1;
        r.current = backTo;
        this.write(r);
        this.host.log.append({
          kind: "route_step",
          payload: {
            routeId: r.id,
            step: backTo,
            of: r.steps.length,
            agent: jumpTo,
            loopedFrom: currentAgent,
            loop: r.loops,
            reason: `"${currentAgent}" errored — looping back`,
          },
        });
        void this.beginStep(r).catch(() => {});
        return;
      }
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

    const finished = r.steps[r.current]!;
    r.current += 1;
    // Conditional steps are decided here, against the turn that just ended:
    // the reviewer runs when the change was big, and is skipped — visibly,
    // with the numbers — when it wasn't.
    while (r.current < r.steps.length) {
      const skip = await this.skipReason(r, finished);
      if (!skip) break;
      this.host.log.append({
        kind: "route_step",
        payload: {
          routeId: r.id,
          step: r.current,
          of: r.steps.length,
          agent: r.steps[r.current],
          skipped: true,
          reason: skip,
        },
      });
      r.current += 1;
    }
    if (r.current >= r.steps.length) {
      this.complete(r);
      return;
    }
    this.write(r);
    await this.beginStep(r);
  }

  /**
   * Why the step at `r.current` shouldn't run, or null if it should.
   *
   * The facts come from the agent whose turn just ended, and a host that
   * can't produce them reports a turn that changed nothing rather than an
   * error — a route shouldn't die because a diff couldn't be read, and
   * "nothing changed" is the answer a threshold can still be applied to.
   */
  private async skipReason(r: RouteState, finished: string): Promise<string | null> {
    const raw = r.stepWhen?.[r.current];
    if (!raw) return null;
    let cond;
    try {
      cond = parseStepCondition(raw);
    } catch {
      return null; // validated at start(); an unreadable one never blocks work
    }
    const facts = await this.host.turnFacts(finished).catch(() => NO_CHANGES);
    if (conditionHolds(cond, facts)) return null;
    return `skipped — needs ${describeStepCondition(cond)}, the turn changed ${describeFacts(facts)}`;
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
      const outcome = await this.host.handoff(agent);
      // A conflicted merge leaves conflict markers in the tree this step was
      // about to work in. Prompting on top of that produces work nobody can
      // review, so the route stops here and names the files. The merge is
      // left in place: those conflicts are the thing to resolve.
      const conflict = outcome?.merge?.state === "conflict" ? outcome.merge : null;
      if (conflict) {
        this.clearTimer();
        const files = (conflict.files ?? []).join(", ");
        this.finish(
          r,
          "failed",
          `handing the baton to ${agent} left a merge conflict in ${files || "the working tree"} — resolve it (or "git merge --abort" in that worktree) and start the route again`,
        );
        return;
      }
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
