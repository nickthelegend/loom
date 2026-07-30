/**
 * ProjectRuntime — one live project inside the daemon: its event log, its
 * agents, and its baton. All mutations flow through here so the log stays
 * the single source of truth.
 */

import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type {
  AgentConfig,
  AgentCost,
  AnyAgent,
  ChatInfo,
  CostSummary,
  LoomEvent,
  McpServerConfig,
  ProjectConfig,
  ProjectInfo,
  ProjectStatus,
  SendInput,
  UnifiedMemory,
} from "../types.js";
import type { RouteState, RouteStepSpec, RouterKind } from "../types.js";
import { isAdapter, MAIN_CHAT } from "../types.js";
import { createAgent, isWithdrawnKind, knownAgentKinds, tierForKind } from "../adapters/index.js";
import { ADES } from "../core/ades.js";
import { BatonManager, NotHolderError } from "../core/baton.js";
import { Brain, CONFIDENCE_FLOOR } from "../core/brain.js";
import { compileBrief, retrieve } from "../core/brain-index.js";
import { extractFromTurn, type ExtractEngine } from "../core/brain-extract.js";
import { claudeText } from "../core/claude-cli.js";
import { EventLog } from "../core/eventlog.js";
import { addWorktree as gitAddWorktree, ensureBranch, stageAndCommitFiles, worktreePath } from "../core/git.js";
import { logbook } from "../core/logbook.js";
import { renderProjection } from "../core/distill.js";
import {
  buildUnifiedMemory,
  hashContent,
  readNativeMemory,
  type ImportedBlock,
} from "../core/memory.js";
import { probeMcpServer, probeMcpServers, writeMcpSession } from "../core/mcp.js";
import { notify } from "../core/notify.js";
import {
  decisionStats,
  extractDecisions,
  normalizeStoredDecision,
  type AgentDecision,
  type DecisionStats,
} from "../observability/decisions.js";
import { turnTraceId } from "../observability/index.js";
import {
  buildSkillsBlock,
  discoverSkillRoots,
  loadSkills,
  type SkillCatalogEntry,
  type SkillManifest,
  type SkillRoot,
} from "../core/skills.js";
import {
  SkillInstallError,
  installSkillFromDir,
  installSkillFromGit,
  type SkillInstallResult,
} from "../core/skill-install.js";
import { resolveSteps, RouteEngine } from "../core/routes.js";
import { buildBriefing, buildProjection } from "../core/projection.js";
import {
  newId,
  projectLoomDir,
  readProjectConfig,
  readProjectState,
  writeProjectConfig,
  writeProjectState,
  writeMemoryFile,
  type BoardTask,
} from "../core/registry.js";
import { suggestHandoff } from "../core/suggestions.js";
import {
  diffSinceSnapshot,
  porcelainStatus,
  workingTree,
  type WorkingTree,
} from "../core/worktree.js";

const PROJECTION_WINDOW = 400; // recent events distilled on handoff

/**
 * How a budget pause is labelled in the shared quarantine map, so this guard
 * can tell its own pauses from the ones a firing alert put there.
 */
const BUDGET_PAUSE_REASON = "budget ";

/** Local midnight — the day a "USD/day" budget is measured against. */
function startOfDay(now: number): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/**
 * A turn refused because the agent is at or over its daily spend budget.
 *
 * Typed (like NotHolderError) because the callers need to tell it apart: the
 * API answers it with a 409 and the numbers, and a route reports which step
 * couldn't start and why, rather than a generic failure.
 */
export class BudgetExceededError extends Error {
  constructor(
    public readonly agentId: string,
    public readonly budgetUsd: number,
    public readonly spentUsd: number,
  ) {
    super(
      `agent "${agentId}" has spent $${spentUsd.toFixed(4)} today, at or over its $${budgetUsd.toFixed(2)}/day budget — raise the budget or wait for the day to roll over`,
    );
    this.name = "BudgetExceededError";
  }
}

/**
 * Thrown when a dispatch targets an agent a firing alert has paused.
 *
 * Separate from BudgetExceededError because the recovery is different and the
 * UI should say so: a budget pause lifts itself when the day rolls over or you
 * raise the cap, while this one lifts when the alert reports itself resolved.
 */
export class QuarantinedError extends Error {
  constructor(
    public readonly agentId: string,
    public readonly reason: string,
    public readonly since: number,
  ) {
    super(
      `agent "${agentId}" is paused by a firing alert — ${reason}. It resumes when that alert resolves, or hand the baton to another agent.`,
    );
    this.name = "QuarantinedError";
  }
}

export const LOOM_ASK_TIMEOUT_MS = 15_000;
export const LOOM_ASK_TIMEOUT_MESSAGE =
  "The agent didn't reply within 15 seconds. Make sure its app is open and signed in, then try again.";

export class LoomAskTimeoutError extends Error {
  constructor() {
    super(LOOM_ASK_TIMEOUT_MESSAGE);
    this.name = "LoomAskTimeoutError";
  }
}

export function withLoomAskTimeout<T>(reply: Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new LoomAskTimeoutError()), LOOM_ASK_TIMEOUT_MS);
    reply.then(
      (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      (err) => {
        clearTimeout(timeout);
        reject(err);
      },
    );
  });
}

export class ProjectRuntime {
  readonly info: ProjectInfo;
  readonly config: ProjectConfig;
  readonly log: EventLog;
  readonly baton: BatonManager;
  readonly routes: RouteEngine;
  /** Memory as units — see core/brain.ts. Reads and writes through `log`. */
  readonly brain: Brain;
  private agents = new Map<string, AnyAgent>();
  private startedAgents = new Set<string>();
  private configMtime = 0;
  /**
   * Which conversation each agent's current turn belongs to. Set when a turn
   * starts and left in place afterwards — an agent's trailing events (a late
   * run_complete, a diff) still belong to the chat that prompted them.
   */
  private turnChat = new Map<string, string>();

  private constructor(info: ProjectInfo, config: ProjectConfig, log: EventLog) {
    this.info = info;
    this.config = config;
    this.log = log;
    this.baton = new BatonManager(info.dir, log);
    this.brain = new Brain(log);

    // Same path as addAgent: an agent added at runtime must behave exactly like
    // one that was here at open, and two copies of this loop would drift.
    // (An agent streams events long after send() returns and has no idea which
    // conversation prompted it — spawnAgent tags them with the chat that started
    // the turn, so a reply lands where the question was asked.)
    for (const agentCfg of config.agents) if (agentCfg.enabled !== false) this.spawnAgent(agentCfg);

    this.routes = new RouteEngine({
      projectName: info.name,
      projectDir: info.dir,
      config,
      log,
      handoff: (to) => this.handoff(to, { source: "route" }),
      send: (text, agentId) => this.sendMessage(text, agentId, { source: "route" }),
      interrupt: () => this.interrupt({ source: "route" }),
      costTotal: () => this.costs.totalUsd,
      isAdapterId: (id) => {
        const agent = this.agents.get(id);
        return Boolean(agent && isAdapter(agent));
      },
    });
  }

  static async open(info: ProjectInfo): Promise<ProjectRuntime> {
    const config = readProjectConfig(info.dir);
    if (!config) throw new Error(`project at ${info.dir} has no .loom/config.json — run loom init`);
    const log = await EventLog.open(projectLoomDir(info.dir));
    const rt = new ProjectRuntime(info, config, log);
    rt.configMtime = configMtimeOf(info.dir);
    rt.rehydrateCosts();
    // Pull each connected ADE's native memory into the shared brain on open.
    try {
      rt.importMemories();
    } catch {
      // Memory import is best-effort; never block opening a project.
    }
    // Watch the project's MCP servers, if it has any — see mcpHealth.
    rt.startMcpHealthLoop();
    // Worktree-per-agent: prepare each adapter's checkout and respawn it there.
    // Safe pre-start — agents are constructed lazily-started, so replacing the
    // instance before its first turn loses nothing.
    if (config.git?.worktreePerAgent) {
      for (const cfg of config.agents) {
        if (cfg.enabled === false) continue;
        const live = rt.agents.get(cfg.id);
        if (!live || live.capabilities.tier !== "adapter") continue;
        await rt.ensureAgentWorktree(cfg.id);
        rt.agents.delete(cfg.id);
        rt.spawnAgent(cfg);
      }
    }
    return rt;
  }

  // -------------------------------------------------------------------------
  // Cost telemetry — O(1) incremental, rehydrated from the log on open
  // -------------------------------------------------------------------------

  private costs = { totalUsd: 0, turns: 0, totalMs: 0, tokensIn: 0, tokensOut: 0 };
  private costsByAgent = new Map<
    string,
    { usd: number; turns: number; ms: number; tokensIn: number; tokensOut: number }
  >();
  // A turn's cost lands on a `turn_cost` status just before its `run_complete`
  // (the CLI reports it mid-stream). We hold it here so the completed turn — and
  // therefore its exported gen_ai span — carries the real cost, not just tokens.
  private pendingCost = new Map<string, number>();
  // Turn text accumulated per agent (from its message events) so we can extract
  // structured decisions once the turn completes. Reset after each run_complete.
  private turnText = new Map<string, string>();

  private rehydrateCosts(): void {
    for (const event of this.log.list({ kinds: ["status", "run_complete"] })) {
      this.trackCost(event);
    }
  }

  private trackCost(event: LoomEvent): void {
    const agentId = event.agentId ?? "unknown";
    const entry =
      this.costsByAgent.get(agentId) ?? { usd: 0, turns: 0, ms: 0, tokensIn: 0, tokensOut: 0 };
    if (event.kind === "status" && event.payload.state === "turn_cost") {
      const usd = Number(event.payload.costUsd ?? 0);
      if (usd > 0) {
        this.costs.totalUsd += usd;
        entry.usd += usd;
        this.costsByAgent.set(agentId, entry);
        // The moment the money crosses the cap, pause — don't wait for the next
        // dispatch to notice. enforceBudget still guards every dispatch (that's
        // the hard stop); this makes the pause visible when the spend happens,
        // so a looping agent shows as paused NOW rather than at its next ask,
        // and the burn panel's "over" and the roster's "paused" agree in time.
        const cap = this.budgets()[agentId];
        if (
          Number.isFinite(cap) &&
          cap! > 0 &&
          this.spendTodayFor(agentId) >= cap! &&
          !this.quarantined()[agentId]
        ) {
          this.quarantine(agentId, `${BUDGET_PAUSE_REASON}$${cap!.toFixed(2)}/day`, false);
          this.appendIfOpen({
            kind: "status",
            agentId,
            payload: { state: "budget_exceeded", budgetUsd: cap, spentTodayUsd: this.spendTodayFor(agentId) },
          });
        }
      }
    } else if (event.kind === "run_complete") {
      const ms = Number(event.payload.durationMs ?? 0);
      // Adapters that report token usage (codex, claude-code, …) carry it on
      // run_complete; cost-only adapters leave these 0. Either way the totals
      // stay honest — an absent number is never invented here.
      const tin = Number(event.payload.inputTokens ?? event.payload.tokensIn ?? 0) || 0;
      const tout = Number(event.payload.outputTokens ?? event.payload.tokensOut ?? 0) || 0;
      this.costs.turns += 1;
      this.costs.totalMs += ms;
      this.costs.tokensIn += tin;
      this.costs.tokensOut += tout;
      entry.turns += 1;
      entry.ms += ms;
      entry.tokensIn += tin;
      entry.tokensOut += tout;
      this.costsByAgent.set(agentId, entry);
    }
  }

  costSummary(): CostSummary {
    const byAgent: AgentCost[] = [...this.costsByAgent.entries()]
      .map(([agentId, c]) => ({ agentId, ...c }))
      .sort((a, b) => b.usd - a.usd || b.turns - a.turns);
    return {
      totalUsd: this.costs.totalUsd,
      turns: this.costs.turns,
      totalMs: this.costs.totalMs,
      tokensIn: this.costs.tokensIn,
      tokensOut: this.costs.tokensOut,
      byAgent,
    };
  }

  /** Per-agent spend budgets (USD/day), set from the Observatory burn-rate panel. */
  budgets(): Record<string, number> {
    return readProjectState(this.info.dir).budgets ?? {};
  }

  /** Set (usd > 0) or clear (usd ≤ 0) one agent's daily budget; returns the new map. */
  setBudget(agentId: string, usdPerDay: number): Record<string, number> {
    const state = readProjectState(this.info.dir);
    const budgets = { ...(state.budgets ?? {}) };
    if (Number.isFinite(usdPerDay) && usdPerDay > 0) budgets[agentId] = usdPerDay;
    else delete budgets[agentId];
    writeProjectState(this.info.dir, { ...state, budgets });
    return budgets;
  }

  /**
   * What one agent has really spent since local midnight.
   *
   * Read from the log, using the same rule the running cost totals use: a
   * turn's money arrives on a `turn_cost` status and nowhere else. (The same
   * figure is copied onto `run_complete` for the exported span; counting both
   * would double every turn.) Adapters that report tokens but no dollars —
   * codex, agy — contribute 0, honestly, because they hand us no price.
   */
  spendTodayFor(agentId: string, now = Date.now()): number {
    const since = startOfDay(now);
    let usd = 0;
    for (const e of this.log.list({ kinds: ["status"] })) {
      if (e.agentId !== agentId || e.ts < since) continue;
      if (e.payload.state !== "turn_cost") continue;
      usd += Number(e.payload.costUsd ?? 0) || 0;
    }
    return usd;
  }

  /**
   * The spend ledger as a daily series, per agent per day.
   *
   * "What did this project cost me last week" had no answer short of reading
   * turn by turn. Same source of truth as spendTodayFor — turn_cost statuses
   * and nowhere else — bucketed by local day. Tokens ride along from
   * run_complete, keyed the same way, so 'which agent is eating the tokens'
   * (#17) is the same walk as 'what did this cost' (#16). Days with no spend
   * simply don't appear; a chart can zero-fill, the API doesn't lie.
   */
  costSeries(days = 30, now = Date.now()): Array<{
    day: string;
    usd: number;
    turns: number;
    tokensIn: number;
    tokensOut: number;
    byAgent: Record<string, { usd: number; turns: number; tokensIn: number; tokensOut: number }>;
  }> {
    const since = startOfDay(now) - (days - 1) * 24 * 60 * 60 * 1000;
    const buckets = new Map<
      string,
      {
        usd: number;
        turns: number;
        tokensIn: number;
        tokensOut: number;
        byAgent: Record<string, { usd: number; turns: number; tokensIn: number; tokensOut: number }>;
      }
    >();
    const dayOf = (ts: number): string => {
      const d = new Date(ts);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    };
    const bucket = (ts: number) => {
      const key = dayOf(ts);
      let b = buckets.get(key);
      if (!b) {
        b = { usd: 0, turns: 0, tokensIn: 0, tokensOut: 0, byAgent: {} };
        buckets.set(key, b);
      }
      return b;
    };
    const agentSlot = (
      b: ReturnType<typeof bucket>,
      agentId: string,
    ): { usd: number; turns: number; tokensIn: number; tokensOut: number } => {
      let s = b.byAgent[agentId];
      if (!s) {
        s = { usd: 0, turns: 0, tokensIn: 0, tokensOut: 0 };
        b.byAgent[agentId] = s;
      }
      return s;
    };
    for (const e of this.log.list({ kinds: ["status", "run_complete"] })) {
      if (e.ts < since) continue;
      const agentId = e.agentId ?? "unknown";
      if (e.kind === "status" && e.payload.state === "turn_cost") {
        const usd = Number(e.payload.costUsd ?? 0) || 0;
        if (usd <= 0) continue;
        const b = bucket(e.ts);
        b.usd += usd;
        agentSlot(b, agentId).usd += usd;
      } else if (e.kind === "run_complete") {
        const tin = Number(e.payload.inputTokens ?? e.payload.tokensIn ?? 0) || 0;
        const tout = Number(e.payload.outputTokens ?? e.payload.tokensOut ?? 0) || 0;
        const b = bucket(e.ts);
        b.turns += 1;
        b.tokensIn += tin;
        b.tokensOut += tout;
        const s = agentSlot(b, agentId);
        s.turns += 1;
        s.tokensIn += tin;
        s.tokensOut += tout;
      }
    }
    return [...buckets.entries()]
      .map(([day, b]) => ({ day, ...b }))
      .sort((a, b) => a.day.localeCompare(b.day));
  }

  /** Every budgeted agent: its cap, what it has spent today, and whether it's out. */
  budgetStatus(now = Date.now()): Record<string, { budgetUsd: number; spentTodayUsd: number; over: boolean }> {
    const out: Record<string, { budgetUsd: number; spentTodayUsd: number; over: boolean }> = {};
    for (const [agentId, budgetUsd] of Object.entries(this.budgets())) {
      const spentTodayUsd = this.spendTodayFor(agentId, now);
      out[agentId] = { budgetUsd, spentTodayUsd, over: spentTodayUsd >= budgetUsd };
    }
    return out;
  }

  /**
   * Refuse to dispatch to an agent a firing alert has paused.
   *
   * The self-heal loop wrote quarantines into state and *nothing read them
   * back*: the webhook paused an agent, and the very next handoff or message
   * went straight to it. So the headline feature — the telemetry backend says
   * an agent is unhealthy, Loom takes it out of rotation — paused nothing at
   * all. It sat beside `enforceBudget`, which had exactly the same bug and was
   * fixed; this is the other half.
   *
   * Budget pauses are skipped here because `enforceBudget` owns them and can
   * lift them on its own (a new day, a raised cap). An alert pause only lifts
   * when the alert says resolved, so there is nothing to re-check.
   */
  private enforceQuarantine(agentId: string): void {
    const q = this.quarantined()[agentId];
    if (!q || q.reason.startsWith(BUDGET_PAUSE_REASON)) return;
    throw new QuarantinedError(agentId, q.reason, q.since);
  }

  /**
   * Refuse a turn an agent can't afford.
   *
   * A budget that nothing checks is a text field, and that is all this was: the
   * burn panel wrote USD/day into state and no code path ever read it back, so
   * an agent with a $1 cap would happily spend $40. Now every dispatch — a
   * message you send, a baton hop, a route step — passes through here first.
   *
   * At or over the cap the agent is quarantined and the turn throws, taking the
   * same route through the UI as the self-heal alert pause (same state map,
   * same shape) so a paused agent looks paused however it got there. The pause
   * lifts itself: the spend is measured against the current day, so when the
   * day rolls over — or you raise the cap — the next attempt clears it and logs
   * the recovery. A budget of 0/unset means no budget, and nothing is enforced.
   */
  private enforceBudget(agentId: string, now = Date.now()): void {
    const budgetUsd = this.budgets()[agentId];
    if (!Number.isFinite(budgetUsd) || !budgetUsd || budgetUsd <= 0) {
      this.liftBudgetPause(agentId, now);
      return;
    }
    const spentUsd = this.spendTodayFor(agentId, now);
    if (spentUsd < budgetUsd) {
      this.liftBudgetPause(agentId, now);
      return;
    }
    if (!this.quarantined()[agentId]) {
      this.quarantine(agentId, `${BUDGET_PAUSE_REASON}$${budgetUsd.toFixed(2)}/day`, false, now);
    }
    // One event per refusal, not one per pause: the thread should show every
    // turn that didn't happen, not just the first.
    this.log.append({
      kind: "status",
      agentId,
      payload: { state: "budget_exceeded", budgetUsd, spentTodayUsd: spentUsd },
    });
    throw new BudgetExceededError(agentId, budgetUsd, spentUsd);
  }

  /**
   * Lift a pause this guard put there, and only that one — a quarantine from a
   * firing alert is somebody else's to lift, and clearing it here would
   * un-pause an agent that is still broken.
   */
  private liftBudgetPause(agentId: string, now = Date.now()): void {
    const q = this.quarantined()[agentId];
    if (!q?.reason.startsWith(BUDGET_PAUSE_REASON)) return;
    this.unquarantine(agentId);
    this.log.append({
      kind: "status",
      agentId,
      payload: { state: "budget_recovered", reason: q.reason, pausedMs: Math.max(0, now - q.since) },
    });
  }

  /** Agents currently paused by a firing alert (self-heal quarantine). */
  quarantined(): Record<string, { reason: string; since: number; displaced: boolean }> {
    return readProjectState(this.info.dir).quarantine ?? {};
  }

  /** Pause an agent (a firing alert). `displaced` marks that it lost the baton to a fallback. */
  quarantine(agentId: string, reason: string, displaced: boolean, now = Date.now()): void {
    const state = readProjectState(this.info.dir);
    const quarantine = { ...(state.quarantine ?? {}) };
    quarantine[agentId] = { reason, since: now, displaced };
    writeProjectState(this.info.dir, { ...state, quarantine });
  }

  /** Lift an agent's quarantine (its alert resolved); returns what it was, or null. */
  unquarantine(agentId: string): { reason: string; since: number; displaced: boolean } | null {
    const state = readProjectState(this.info.dir);
    const quarantine = { ...(state.quarantine ?? {}) };
    const prev = quarantine[agentId] ?? null;
    if (prev) {
      delete quarantine[agentId];
      writeProjectState(this.info.dir, { ...state, quarantine });
    }
    return prev;
  }

  /** Has .loom/config.json changed since this runtime was opened? */
  configStale(): boolean {
    return configMtimeOf(this.info.dir) > this.configMtime;
  }

  /**
   * Rename an agent's job. Writes .loom/config.json (the source of truth) and
   * updates this runtime in place — the generic hot-reload would do it too, but
   * only once the project is quiet, and a label you just typed shouldn't wait
   * on an agent's turn to finish. Nothing is torn down: a role is a name, not
   * a capability, so no adapter needs restarting.
   */
  setAgentRole(agentId: string, role: string): { id: string; role: string } | null {
    const cfg = this.config.agents.find((a) => a.id === agentId);
    if (!cfg) return null;
    cfg.role = role;
    this.saveConfig();
    return { id: agentId, role };
  }

  /**
   * Edit the project's settings the Settings screen owns — the brain extractor,
   * the projection mode, the default agent. These were config-file-only until
   * now; everything is read live from this.config (brain?.extractor at turn end,
   * projection at handoff), so a merge here takes effect on the next turn/hop
   * with no restart. Only the known keys are honoured; unknown ones are ignored.
   */
  patchConfig(patch: {
    brain?: { extractor?: "auto" | "off"; model?: string };
    projection?: { mode?: "template" | "llm"; model?: string; timeoutMs?: number };
    defaultAgent?: string;
  }): ProjectConfig {
    // Validate everything that can be rejected BEFORE touching this.config, so a
    // bad field can't leave a half-applied change in memory that the next save
    // would then persist.
    const wantsDefault = typeof patch.defaultAgent === "string";
    const defaultId = wantsDefault ? patch.defaultAgent!.trim() : "";
    if (wantsDefault && defaultId && !this.config.agents.some((a) => a.id === defaultId)) {
      throw new Error(`no agent "${defaultId}" in this project`);
    }
    if (patch.brain) {
      const b = { ...(this.config.brain ?? {}) };
      if (patch.brain.extractor === "auto" || patch.brain.extractor === "off") b.extractor = patch.brain.extractor;
      if (typeof patch.brain.model === "string") b.model = patch.brain.model.trim() || undefined;
      this.config.brain = b;
    }
    if (patch.projection) {
      const pr = { ...(this.config.projection ?? {}) };
      if (patch.projection.mode === "template" || patch.projection.mode === "llm") pr.mode = patch.projection.mode;
      if (typeof patch.projection.model === "string") pr.model = patch.projection.model.trim() || undefined;
      this.config.projection = pr;
    }
    if (wantsDefault) {
      // empty clears it; a real value was checked against the roster above
      if (!defaultId) delete this.config.defaultAgent;
      else this.config.defaultAgent = defaultId;
    }
    this.saveConfig();
    return this.config;
  }

  /**
   * The slice of config the Settings screen edits, read back for display: the
   * brain extractor, the projection mode, the default agent, and the roster the
   * default-agent picker chooses from. Defaults are spelled out here (extractor
   * "auto", projection "template") so the screen shows the effective value, not
   * a blank that hides what's actually running.
   */
  settings(): {
    brain: { extractor: "auto" | "off"; model: string };
    projection: { mode: "template" | "llm"; model: string };
    defaultAgent: string;
    agents: Array<{ id: string; kind: string; role?: string }>;
  } {
    return {
      brain: {
        extractor: this.config.brain?.extractor === "off" ? "off" : "auto",
        model: this.config.brain?.model ?? "",
      },
      projection: {
        mode: this.config.projection?.mode === "llm" ? "llm" : "template",
        model: this.config.projection?.model ?? "",
      },
      defaultAgent: this.config.defaultAgent ?? "",
      agents: this.config.agents.map((a) => ({ id: a.id, kind: a.kind, role: a.role })),
    };
  }

  /**
   * Put an agent in this project.
   *
   * Until this existed a project's roster was whatever was detected the moment
   * it was created, forever. Install a new ADE and your existing projects never
   * heard about it — which is why a machine with six agents had boards offering
   * two, and looked like a bug in the board.
   *
   * The role defaults to the kind, which is a description rather than an
   * opinion: Loom has no basis for deciding Codex is "the reviewer".
   */
  addAgent(kind: string, opts: { id?: string; role?: string } = {}): AgentConfig {
    if (!knownAgentKinds().includes(kind)) {
      throw new Error(`unknown agent kind "${kind}" (known: ${knownAgentKinds().join(", ")})`);
    }
    // Known is not the same as offered. This is the endpoint the "add agent"
    // rail drives, and the rail only ever lists ADES. Accepting a kind that no
    // view offers meant a withdrawn agent could be put in a roster by guessing
    // its name, and then sat there unadvertised and unexplained. Refuse it
    // here, and name what replaced it.
    if (isWithdrawnKind(kind)) {
      const replacement = kind === "antigravity" ? ' — use "antigravity-cli"' : "";
      throw new Error(`"${kind}" is no longer offered${replacement}`);
    }
    // A second session of the same kind is a feature, not a mistake.
    //
    // The roster has always been keyed by instance id with kind alongside it, so
    // two Claude Code sessions in one project were representable — but adding
    // one threw, because the id defaulted to the kind and the kind was taken. A
    // caller who names the instance gets that name; a caller who doesn't gets
    // the next free suffix, so "add another" needs no ceremony. Both sessions
    // read and write the one project brain: memory import dedupes by file path,
    // and units are project-scoped, so nothing has to change for them to share.
    const explicit = opts.id?.trim().slice(0, 40);
    if (explicit && this.config.agents.some((a) => a.id === explicit)) {
      throw new Error(`"${explicit}" is already in this project`);
    }
    const id = explicit || this.nextInstanceId(kind);
    if (!id) throw new Error("an agent needs an id");
    const cfg: AgentConfig = { id, kind, role: (opts.role ?? kind).trim().slice(0, 40) || kind };
    // Build it before saving. A config entry with no live agent behind it makes
    // status() throw the moment anything asks — this.agent(id) doesn't find it —
    // so the project 500s on every poll and the roster you just changed becomes
    // unreachable. Writing the file is the easy half; the runtime has to learn
    // too, and it can't wait for a restart to do it.
    this.spawnAgent(cfg);
    this.config.agents.push(cfg);
    this.saveConfig();
    return cfg;
  }

  /**
   * The next free instance id for a kind: `codex`, then `codex-2`, `codex-3`.
   *
   * The bare kind stays the first instance's id so existing projects, configs
   * and route specs that name `codex` keep meaning what they meant.
   */
  private nextInstanceId(kind: string): string {
    const taken = new Set(this.config.agents.map((a) => a.id));
    if (!taken.has(kind)) return kind;
    for (let n = 2; n < 100; n++) {
      const candidate = `${kind}-${n}`;
      if (!taken.has(candidate)) return candidate;
    }
    throw new Error(`too many ${kind} sessions in this project`);
  }

  /** How many instances of each kind the roster holds. */
  instanceCounts(): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const a of this.config.agents) counts[a.kind] = (counts[a.kind] ?? 0) + 1;
    return counts;
  }

  /**
   * Where this agent works: its own worktree when the project opted in, the
   * shared tree otherwise.
   *
   * With git.worktreePerAgent on, each adapter gets a sibling checkout on its
   * own branch (agent/<id>), so two agents editing at once cannot collide in
   * the filesystem. The trade is stated where it's decided: merging is
   * MANUAL in this version — the branches are ordinary git branches and
   * `git merge agent/<id>` is the handoff of record. Auto-merge on baton
   * handoff is a different feature with different failure modes (conflicts
   * mid-handoff), deliberately not smuggled in here.
   */
  private agentDirs = new Map<string, string>();

  agentDir(agentId: string): string {
    return this.agentDirs.get(agentId) ?? this.info.dir;
  }

  private async ensureAgentWorktree(agentId: string): Promise<string> {
    const existing = this.agentDirs.get(agentId);
    if (existing) return existing;
    const wt = worktreePath(this.info.dir, `agent-${agentId}`);
    if (!fs.existsSync(wt)) {
      try {
        await gitAddWorktree(this.info.dir, {
          slug: `agent-${agentId}`,
          newBranch: `agent/${agentId}`,
        });
      } catch (err) {
        // Branch already exists from a previous run — attach to it instead.
        try {
          await gitAddWorktree(this.info.dir, { slug: `agent-${agentId}`, branch: `agent/${agentId}` });
        } catch {
          logbook.warn(
            "git",
            `worktree for ${agentId} could not be created — falling back to the shared tree`,
            String(err),
            this.info.id,
          );
          this.agentDirs.set(agentId, this.info.dir);
          return this.info.dir;
        }
      }
    }
    this.agentDirs.set(agentId, wt);
    return wt;
  }

  /**
   * Create one agent and subscribe to it, exactly as the constructor does.
   *
   * Shared so a roster change can't drift from a cold start: an agent added at
   * runtime must stream its events into the log the same way as one that was
   * there when the project opened.
   */
  private spawnAgent(cfg: AgentConfig): AnyAgent {
    const agent = createAgent(cfg, this.agentDir(cfg.id));
    this.agents.set(cfg.id, agent);
    agent.onEvent((e) => {
      const chat = this.turnChat.get(agent.id);
      let payload = e.payload;
      // Enrich the completed turn so its gen_ai span carries system + model +
      // cost (adapters only put tokens on run_complete). The kind is known
      // here; the model prefers what the adapter actually used, else the
      // configured override; the cost is the turn_cost stashed a moment ago.
      const p = e.payload as Record<string, unknown>;
      if (e.kind === "status" && p.state === "turn_cost") {
        const usd = Number(p.costUsd ?? 0);
        if (usd > 0) this.pendingCost.set(agent.id, usd);
      } else if (e.kind === "run_complete") {
        const model =
          (typeof p.model === "string" && p.model) ||
          (typeof cfg.options?.model === "string" ? cfg.options.model : undefined);
        const cost = this.pendingCost.get(agent.id);
        this.pendingCost.delete(agent.id);
        payload = {
          ...p,
          adapter: cfg.kind,
          ...(model ? { model } : {}),
          ...(cost !== undefined ? { costUsd: cost } : {}),
        };
      }
      // Any terminal event stops the stale-session clock — a turn that ended in
      // an error is over, not hung.
      if (e.kind === "run_complete" || e.kind === "error" ||
          (e.kind === "status" && p.state === "interrupted")) {
        this.busySince.delete(agent.id);
      }
      const event = this.log.append({
        kind: e.kind,
        agentId: agent.id,
        ...(chat ? { chat } : {}),
        payload,
      });
      this.afterAgentEvent(event);
    });
    return agent;
  }

  /**
   * Take an agent out.
   *
   * Refused while it holds the baton or is mid-turn: removing it there would
   * strand the lock on an agent that no longer exists, and the thread would
   * show a turn that nothing is running.
   */
  removeAgent(agentId: string): { removed: string } {
    const cfg = this.config.agents.find((a) => a.id === agentId);
    if (!cfg) throw new Error(`unknown agent "${agentId}"`);
    const holder = this.validHolder();
    if (holder === agentId) {
      throw new Error(`"${agentId}" holds the baton — hand it to someone else first`);
    }
    const live = this.agents.get(agentId);
    if (live && isAdapter(live) && live.busy()) {
      throw new Error(`"${agentId}" is mid-turn — interrupt it first`);
    }
    // Its events stay in the log: the history happened, and a roster change
    // doesn't unhappen it. Only the roster forgets.
    this.config.agents = this.config.agents.filter((a) => a.id !== agentId);
    this.saveConfig();
    if (live) {
      void Promise.resolve(live.stop()).catch(() => {});
      this.agents.delete(agentId);
    }
    return { removed: agentId };
  }

  /**
   * Point an agent at a different model.
   *
   * The model is read once, when the adapter is constructed (createAgent hands
   * it cfg.options), so changing it means building a fresh agent — which drops
   * the CLI session the old one was resuming. That's the right behaviour for a
   * model switch: continuing one model's conversation on another model is not a
   * thing the underlying CLIs support anyway. Refused mid-turn, because swapping
   * the process out from under a running turn would strand it.
   *
   * An empty model clears the override, so the CLI falls back to its own default
   * — the honest "Default" the picker offers.
   */
  setAgentModel(agentId: string, model: string): AgentConfig {
    const cfg = this.config.agents.find((a) => a.id === agentId);
    if (!cfg) throw new Error(`unknown agent "${agentId}"`);
    const live = this.agents.get(agentId);
    if (live && isAdapter(live) && live.busy()) {
      throw new Error(`"${agentId}" is mid-turn — wait for it to finish, then switch models`);
    }
    const next = model.trim().slice(0, 80);
    const options = { ...(cfg.options ?? {}) } as Record<string, unknown>;
    if (next) options.model = next;
    else delete options.model;
    cfg.options = options;

    // Rebuild so the new model actually takes: stop the old process, spawn a
    // replacement subscribed exactly as the constructor's loop does.
    if (live) {
      void Promise.resolve(live.stop()).catch(() => {});
      this.agents.delete(agentId);
    }
    this.spawnAgent(cfg);
    this.saveConfig();
    return cfg;
  }

  /** Write the roster, without tripping our own staleness check. */
  private saveConfig(): void {
    writeProjectConfig(this.info.dir, this.config);
    // we just wrote the file, so don't let configStale() see our own write and
    // schedule a pointless reload
    this.configMtime = configMtimeOf(this.info.dir);
  }

  // ── Skills (SKILL.md context blocks injected into the briefing) ──

  /**
   * Where skills live — every layout, not just ours.
   *
   * See core/skills.ts#discoverSkillRoots for the list and the precedence. This
   * used to be two hardcoded directories, which meant a machine with sixty
   * skills in `~/.claude` reported the one that shipped in this repo.
   */
  private skillRoots(): SkillRoot[] {
    return discoverSkillRoots(this.info.dir, path.join(process.cwd(), "skills"));
  }

  /** The directory this project's own skills are installed into. */
  private ownSkillsDir(): string {
    return path.join(this.info.dir, "skills");
  }

  /** All available skills with this project's enabled state. */
  getSkills(): SkillManifest[] {
    return loadSkills(this.skillRoots(), this.config.skills ?? {});
  }

  /**
   * The catalog the picker renders: every discoverable skill, without the body.
   *
   * The bodies are the entire point of a skill and also the reason this exists
   * separately from `getSkills()` — a machine with sixty installed skills has
   * megabytes of markdown, and a list screen needs none of it.
   *
   * `installed` means "this file is inside the project directory", which is the
   * same question `removeSkill` asks: those are the only ones Loom put there
   * and the only ones it may delete.
   */
  skillsCatalog(): SkillCatalogEntry[] {
    const own = this.ownSkillsDir();
    return this.getSkills().map((s) => ({
      id: s.id,
      name: s.name,
      description: s.description,
      enabled: s.enabled,
      origin: s.origin,
      source: s.source,
      installed: path.resolve(s.source) === path.resolve(own),
    }));
  }

  /**
   * Install a skill from a local directory or a git remote, into this project.
   *
   * Throws SkillInstallError for anything the user can fix (bad URL, unsafe id,
   * a name that already exists) — the route turns those into a 400 with the
   * message, because "invalid input" tells you nothing when the real answer is
   * "that repo has no SKILL.md in it".
   */
  async installSkill(input: { gitUrl?: string; dir?: string; force?: boolean }): Promise<SkillInstallResult> {
    const gitUrl = String(input.gitUrl ?? "").trim();
    const dir = String(input.dir ?? "").trim();
    if (gitUrl && dir) throw new SkillInstallError("give either gitUrl or dir, not both");
    if (gitUrl) return installSkillFromGit(gitUrl, this.info.dir, { force: input.force === true });
    if (dir) return installSkillFromDir(dir, this.info.dir, { force: input.force === true });
    throw new SkillInstallError("nothing to install — pass gitUrl or dir");
  }

  /**
   * Delete a project-installed skill from disk.
   *
   * Refused for anything outside the project. A skill in `~/.claude/skills` is
   * the user's, shared with every other tool they run, and a project-scoped
   * "remove" button that reached out and deleted it would be a data-loss bug
   * dressed as a feature. The refusal says where the skill actually lives so
   * the answer ("go delete it yourself, here") is in the message.
   *
   * The enabled flag goes with it: leaving `skills[id] = true` in config for a
   * directory that no longer exists means the next turn's briefing silently
   * loses a block the config still claims is on.
   */
  removeSkill(id: string): { removed: true; id: string; path: string } {
    const skill = this.getSkills().find((s) => s.id === id);
    if (!skill) throw new SkillInstallError(`no skill "${id}"`);
    const own = this.ownSkillsDir();
    if (path.resolve(skill.source) !== path.resolve(own)) {
      throw new SkillInstallError(
        `"${id}" lives in ${skill.source}, outside this project — Loom didn't install it and won't delete it`,
      );
    }
    const dir = path.join(own, skill.id);
    fs.rmSync(dir, { recursive: true, force: true });
    if (this.config.skills?.[skill.id]) this.setSkillEnabled(skill.id, false);
    return { removed: true, id: skill.id, path: dir };
  }

  /**
   * Switch one agent off (or back on) without taking it out of the roster.
   *
   * Refused while it holds the baton or is mid-turn, for the same reason
   * `removeAgent` is: stopping it there would strand the lock on something that
   * no longer exists, and the thread would show a turn nothing is running. The
   * refusal names the fix rather than just saying no.
   *
   * Off really means off — the agent is stopped and dropped from the live map,
   * not merely hidden. A roster entry that still answers is the kind of "off"
   * that costs money.
   */
  setAgentEnabled(agentId: string, enabled: boolean): { id: string; enabled: boolean } {
    const cfg = this.config.agents.find((a) => a.id === agentId);
    if (!cfg) throw new Error(`unknown agent "${agentId}"`);
    const on = enabled !== false;
    if (!on) {
      if (this.validHolder() === agentId) {
        throw new Error(`"${agentId}" holds the baton — hand it off before switching it off`);
      }
      const live = this.agents.get(agentId);
      if (live && isAdapter(live) && live.busy()) {
        throw new Error(`"${agentId}" is mid-turn — interrupt it first`);
      }
    }
    cfg.enabled = on;
    this.saveConfig();
    const live = this.agents.get(agentId);
    if (on && !live) {
      this.spawnAgent(cfg); // bring it back to life
    } else if (!on && live) {
      void Promise.resolve(live.stop()).catch(() => {});
      this.agents.delete(agentId);
      this.startedAgents.delete(agentId);
    }
    this.log.append({ kind: on ? "agent_join" : "agent_leave", agentId, payload: { enabled: on } });
    return { id: agentId, enabled: on };
  }

  /** Enable/disable one skill for this project; returns the new enabled map. */
  setSkillEnabled(id: string, on: boolean): Record<string, boolean> {
    const skills = { ...(this.config.skills ?? {}) };
    if (on) skills[id] = true;
    else delete skills[id];
    this.config.skills = skills;
    this.saveConfig();
    return skills;
  }

  /** The ACTIVE SKILLS block to prepend to a briefing, or "" when none are on. */
  activeSkillsBlock(): string {
    return buildSkillsBlock(this.getSkills());
  }

  // ── MCP servers ──

  private static DEFAULT_MCPS: McpServerConfig[] = [
    { name: "GitHub", url: "", description: "issues, PRs, code search", icon: "github" },
    { name: "Supabase", url: "", description: "query, schema, migrations", icon: "database" },
    { name: "SigNoz", url: "", description: "traces, metrics, alerts", icon: "chart" },
    { name: "Linear", url: "", description: "issues, projects, cycles", icon: "linear" },
    { name: "Slack", url: "", description: "messages, channels, users", icon: "slack" },
    { name: "Filesystem", url: "", description: "read/write local files", icon: "folder" },
  ];

  /** Configured MCP servers, merged over the built-in suggestions (deduped by name). */
  getMcps(): McpServerConfig[] {
    const saved = this.config.mcps ?? [];
    const byName = new Map(ProjectRuntime.DEFAULT_MCPS.map((m) => [m.name, { ...m }]));
    for (const m of saved) byName.set(m.name, { ...(byName.get(m.name) ?? {}), ...m });
    return [...byName.values()];
  }

  /**
   * The same list, with `connected` MEASURED rather than assumed.
   *
   * The old reading of that field was "a url is typed into this row", which the
   * UI rendered as a green "connected" badge — a claim about a live connection
   * made without ever opening one. Here every configured URL gets a bounded
   * probe (see core/mcp.ts) and the answer is whatever came back. Rows with no
   * URL aren't probed and report false, because "not configured" is not
   * "connected".
   */
  // -------------------------------------------------------------------------
  // MCP health
  // -------------------------------------------------------------------------
  /**
   * Live health per configured MCP server, from the background poll.
   *
   * A server that died used to stay listed as connected, and its tools failed
   * silently mid-turn — the agent just found them gone. The poll notices the
   * transition, says so in the Console, and while a server is down it is left
   * out of turn injection entirely: an absent tool the agent never saw beats a
   * present tool that throws. When the server answers again it is included
   * again automatically — that is the whole reconnect story for per-turn
   * config files; there is no persistent connection to rebuild.
   */
  private mcpHealth = new Map<string, { up: boolean; failures: number; probedAt: number }>();
  private mcpTimer: ReturnType<typeof setInterval> | null = null;

  /** Poll every configured server once; log the transitions. */
  async pollMcpHealth(timeoutMs = 2_000): Promise<void> {
    const mcps = this.getMcps().filter((m) => m.enabledForSession !== false);
    for (const m of mcps) {
      const url = String(m.url ?? "").trim();
      if (!url) continue; // stdio servers have no probe-able endpoint
      const up = await probeMcpServer(url, timeoutMs).catch(() => false);
      const prev = this.mcpHealth.get(m.name);
      const failures = up ? 0 : (prev?.failures ?? 0) + 1;
      this.mcpHealth.set(m.name, { up, failures, probedAt: Date.now() });
      if (prev && prev.up && !up) {
        logbook.error("mcp", `"${m.name}" stopped answering — its tools are withheld from turns until it returns`, url, this.info.id);
      } else if (prev && !prev.up && up) {
        logbook.info("mcp", `"${m.name}" is back — its tools rejoin the next turn`, undefined, this.info.id);
      }
    }
    // Forget servers that were removed from config.
    const names = new Set(mcps.map((m) => m.name));
    for (const k of [...this.mcpHealth.keys()]) if (!names.has(k)) this.mcpHealth.delete(k);
  }

  mcpHealthReport(): Record<string, { up: boolean; failures: number; probedAt: number }> {
    return Object.fromEntries(this.mcpHealth);
  }

  /**
   * The servers a turn should carry: everything not known-down.
   *
   * Unknown (never probed — a fresh daemon, a just-added server) passes
   * through; refusing a server nobody has measured would block first use on a
   * poll that hasn't run yet. Only a measured, repeated failure withholds.
   */
  healthyMcps(): McpServerConfig[] {
    return (this.config.mcps ?? []).filter((m) => {
      const h = this.mcpHealth.get(m.name);
      return !h || h.up || h.failures < 2;
    });
  }

  startMcpHealthLoop(intervalMs = Number(process.env.LOOM_MCP_POLL_MS) || 60_000): void {
    if (this.mcpTimer || !(this.config.mcps ?? []).length) return;
    this.mcpTimer = setInterval(() => {
      void this.pollMcpHealth().catch(() => {});
    }, intervalMs);
    this.mcpTimer.unref?.();
  }

  async getMcpsProbed(timeoutMs = 2_000): Promise<McpServerConfig[]> {
    const mcps = this.getMcps();
    const reachable = await probeMcpServers(mcps, timeoutMs).catch(() => ({}) as Record<string, boolean>);
    const probedAt = Date.now();
    return mcps.map((m) => ({
      ...m,
      connected: reachable[m.name] ?? false,
      ...(m.name in reachable ? { probedAt } : {}),
    }));
  }

  /** Add or update one MCP (by name); persists only the real (non-default) fields. */
  upsertMcp(mcp: McpServerConfig): McpServerConfig[] {
    const saved = (this.config.mcps ?? []).filter((m) => m.name !== mcp.name);
    saved.push(mcp);
    this.config.mcps = saved;
    this.saveConfig();
    return this.getMcps();
  }

  /**
   * Remove a configured MCP server by name.
   *
   * `removed` is false when nothing was configured under that name, which the
   * route answers with a 404 rather than a cheerful 200 — "deleted a thing that
   * wasn't there" is the kind of success that hides a typo in a server name.
   *
   * Note what this does to a name that is also one of the built-in suggestion
   * rows (GitHub, Slack, …): the *configuration* goes, and the suggestion comes
   * back with an empty url, because those rows aren't installed servers, they're
   * placeholders getMcps() merges in. That is the honest outcome — the server is
   * gone, and what's left is an offer to add one — but a caller diffing the list
   * for the name will still find it, so it should compare `url`/`command`.
   */
  removeMcp(name: string): { removed: boolean; mcps: McpServerConfig[] } {
    const saved = this.config.mcps ?? [];
    const kept = saved.filter((m) => m.name !== name);
    if (kept.length === saved.length) return { removed: false, mcps: this.getMcps() };
    this.config.mcps = kept;
    this.saveConfig();
    return { removed: true, mcps: this.getMcps() };
  }

  // -------------------------------------------------------------------------
  // Chats — several conversations, one brain
  // -------------------------------------------------------------------------

  /**
   * Every conversation in this project, main first. Main is implicit: it's
   * always there and it owns every event written before chats existed, so it
   * is never stored. The rest live in state.json — a chat you created and
   * haven't spoken in yet has no events to derive it from.
   */
  chats(): ChatInfo[] {
    const stored = readProjectState(this.info.dir).chats ?? [];
    return [
      { id: MAIN_CHAT, title: "Main", createdAt: 0 },
      ...stored.filter((c) => c.id !== MAIN_CHAT),
    ];
  }

  createChat(title: string): ChatInfo {
    const state = readProjectState(this.info.dir);
    const chat: ChatInfo = {
      id: newId(4),
      // numbered, not "New chat" — the button already says New chat, and a
      // sidebar of identical rows tells you nothing
      title: title.trim().slice(0, 60) || `Chat ${(state.chats ?? []).length + 2}`,
      createdAt: Date.now(),
    };
    state.chats = [...(state.chats ?? []), chat];
    writeProjectState(this.info.dir, state);
    return chat;
  }

  renameChat(id: string, title: string): ChatInfo | null {
    if (id === MAIN_CHAT) return null; // main's name is not yours to change
    const state = readProjectState(this.info.dir);
    const chat = (state.chats ?? []).find((c) => c.id === id);
    if (!chat) return null;
    chat.title = title.trim().slice(0, 60) || chat.title;
    writeProjectState(this.info.dir, state);
    return chat;
  }

  /**
   * Forget a conversation. Its events stay in the log — it's append-only, and
   * the brain is built from all of them; deleting the thread you had with an
   * agent shouldn't quietly rewrite what the project decided. The chat just
   * stops being listed.
   */
  deleteChat(id: string): boolean {
    if (id === MAIN_CHAT) return false; // there is always a main chat
    const state = readProjectState(this.info.dir);
    const before = (state.chats ?? []).length;
    state.chats = (state.chats ?? []).filter((c) => c.id !== id);
    if (state.chats.length === before) return false;
    writeProjectState(this.info.dir, state);
    return true;
  }

  // -------------------------------------------------------------------------
  // Board tasks — the cards you write yourself
  // -------------------------------------------------------------------------

  boardTasks(): BoardTask[] {
    return readProjectState(this.info.dir).tasks ?? [];
  }

  createTask(input: {
    title: string;
    column?: string;
    agent?: string;
    blockedBy?: string[];
  }): BoardTask {
    const state = readProjectState(this.info.dir);
    const blockedBy = this.validBlockers(state.tasks ?? [], input.blockedBy);
    const task: BoardTask = {
      id: newId(4),
      title: input.title.trim().slice(0, 200),
      column: input.column ?? "working",
      ...(input.agent ? { agent: input.agent } : {}),
      ...(blockedBy.length ? { blockedBy } : {}),
      createdAt: Date.now(),
    };
    state.tasks = [...(state.tasks ?? []), task];
    writeProjectState(this.info.dir, state);
    return task;
  }

  /** Only blockers that exist. A link to a deleted card blocks nothing forever. */
  private validBlockers(tasks: BoardTask[], ids?: string[]): string[] {
    if (!ids?.length) return [];
    const known = new Set(tasks.map((t) => t.id));
    return [...new Set(ids)].filter((id) => known.has(id));
  }

  /**
   * A card is blocked while any of its blockers is not yet `ready`.
   *
   * `ready` is the board's own definition of done — the last column. Deleted
   * blockers don't count (validBlockers keeps them out, and a stale link that
   * survived a race reads as done rather than blocking forever).
   */
  taskBlockers(id: string): Array<{ id: string; title: string; column: string }> {
    const tasks = readProjectState(this.info.dir).tasks ?? [];
    const task = tasks.find((t) => t.id === id);
    if (!task?.blockedBy?.length) return [];
    const byId = new Map(tasks.map((t) => [t.id, t]));
    return task.blockedBy
      .map((bid) => byId.get(bid))
      .filter((b): b is BoardTask => Boolean(b) && b!.column !== "ready")
      .map((b) => ({ id: b.id, title: b.title, column: b.column }));
  }

  /** task/<id>-<slug>: stable id first so a retitle doesn't orphan the branch. */
  private taskBranchName(task: BoardTask): string {
    const slug = task.title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40);
    return `task/${task.id}${slug ? `-${slug}` : ""}`;
  }

  /** Move or retitle a card. Yours, so this is the real state — not a hint. */
  updateTask(
    id: string,
    patch: { title?: string; column?: string; agent?: string; blockedBy?: string[] },
  ): BoardTask | null {
    const state = readProjectState(this.info.dir);
    const task = (state.tasks ?? []).find((t) => t.id === id);
    if (!task) return null;
    // Opt-in: dragging a card to Working checks out its branch; reaching
    // Review logs the PR command rather than running it — pushing publishes,
    // and publishing implicitly is a line Loom doesn't cross even under a
    // flag. The branch name leads with the stable id so a retitle doesn't
    // orphan it. Failures (not a repo, dirty tree) land in the Console; the
    // drag itself always succeeds — the board must not refuse to reflect
    // reality because git had opinions.
    if (this.config.git?.branchPerTask && patch.column && patch.column !== task.column) {
      const branch = this.taskBranchName(task);
      if (patch.column === "working") {
        void ensureBranch(this.info.dir, branch)
          .then(({ created }) =>
            this.appendIfOpen({
              kind: "status",
              payload: { state: "task_branch", task: task.id, branch, created },
            }),
          )
          .catch((err) =>
            logbook.warn("git", `couldn't switch to ${branch}`, String(err), this.info.id),
          );
      } else if (patch.column === "in-review") {
        logbook.info(
          "git",
          `"${task.title}" reached review — open the PR with: gh pr create --head ${branch}`,
          undefined,
          this.info.id,
        );
      }
    }
    if (patch.title !== undefined) task.title = patch.title.trim().slice(0, 200) || task.title;
    if (patch.column !== undefined) task.column = patch.column;
    if (patch.agent !== undefined) task.agent = patch.agent;
    if (patch.blockedBy !== undefined) {
      // Cycles refused at write: A→B→A makes both unbecomable forever, and the
      // person who typed it is the one who can pick which link was wrong.
      const next = this.validBlockers(state.tasks ?? [], patch.blockedBy).filter((b) => b !== id);
      if (this.wouldCycle(state.tasks ?? [], id, next)) {
        throw new Error("that dependency would make a cycle — nothing in it could ever start");
      }
      if (next.length) task.blockedBy = next;
      else delete task.blockedBy;
    }
    writeProjectState(this.info.dir, state);
    return task;
  }

  /** Would `id` depending on `blockers` create a loop back to `id`? */
  private wouldCycle(tasks: BoardTask[], id: string, blockers: string[]): boolean {
    const byId = new Map(tasks.map((t) => [t.id, t]));
    const stack = [...blockers];
    const seen = new Set<string>();
    while (stack.length) {
      const cur = stack.pop()!;
      if (cur === id) return true;
      if (seen.has(cur)) continue;
      seen.add(cur);
      for (const b of byId.get(cur)?.blockedBy ?? []) stack.push(b);
    }
    return false;
  }

  deleteTask(id: string): boolean {
    const state = readProjectState(this.info.dir);
    const before = (state.tasks ?? []).length;
    state.tasks = (state.tasks ?? []).filter((t) => t.id !== id);
    if (state.tasks.length === before) return false;
    writeProjectState(this.info.dir, state);
    return true;
  }

  /** Any adapter mid-turn? (Hot reloads are deferred while work is in flight.) */
  anyBusy(): boolean {
    return [...this.agents.values()].some((a) => isAdapter(a) && a.busy());
  }

  agent(id: string): AnyAgent {
    const agent = this.agents.get(id);
    if (!agent) throw new Error(`unknown agent "${id}" in project "${this.info.name}"`);
    return agent;
  }

  private async ensureStarted(agentId: string): Promise<AnyAgent> {
    const agent = this.agent(agentId);
    if (!this.startedAgents.has(agentId)) {
      await agent.start();
      this.startedAgents.add(agentId);
    }
    return agent;
  }

  /** Pre-turn porcelain snapshots, for per-prompt diff attribution. */
  private preTurnTree = new Map<string, string>();

  /** After a turn: log which files that prompt changed (turn_diff), then learn. */
  private captureTurnDiff(agentId: string): void {
    const before = this.preTurnTree.get(agentId);
    if (before === undefined) {
      // No snapshot (e.g. a turn with no pre-tree) — still worth reading.
      this.extractMemory(agentId, []);
      return;
    }
    this.preTurnTree.delete(agentId);
    void diffSinceSnapshot(this.agentDir(agentId), before)
      .then((diff) => {
        if (diff) {
          this.log.append({
            kind: "turn_diff",
            agentId,
            payload: {
              files: diff.files,
              added: diff.added,
              removed: diff.removed,
              patch: diff.patch,
              truncated: diff.truncated,
            },
          });
          void this.commitTurn(agentId, diff.files.map((f) => f.path));
        }
        // Learn from the turn once we know which files it touched — the files
        // sharpen candidate retrieval. Runs after the diff so recentTurnFiles
        // isn't needed; the files are right here.
        this.extractMemory(agentId, (diff?.files ?? []).map((f) => f.path));
      })
      .catch(() => this.extractMemory(agentId, []));
  }

  /**
   * Opt-in: commit a turn's changes as they land, with the agent as co-author.
   *
   * git blame on a fleet's work answered "who wrote this" with whoever ran the
   * daemon. With `git.commitPerTurn` on, each turn's changes become one commit —
   * subject from the prompt that caused them, `Co-Authored-By: <agent> via
   * Loom` so both git log and GitHub attribute the work.
   *
   * Off by default and per-project on purpose: committing is a policy, not a
   * mechanic, and half-done turns land too. Only the files THIS turn touched
   * are staged, so two agents finishing close together each commit their own
   * work rather than whoever finishes second swallowing both.
   */
  private async commitTurn(agentId: string, files: string[]): Promise<void> {
    if (!this.config.git?.commitPerTurn || !files.length) return;
    try {
      const events = this.log.list({ limit: 60 });
      const prompt =
        [...events].reverse().find((e) => e.kind === "message" && !e.agentId)?.payload.text ?? "";
      const subject = String(prompt).split("\n")[0]!.slice(0, 68) || `work by ${agentId}`;
      const cfg = this.config.agents.find((a) => a.id === agentId);
      const message =
        `${subject}\n\n` +
        `Turn by ${agentId}${cfg ? ` (${cfg.kind})` : ""} in Loom.\n` +
        `Co-Authored-By: ${agentId} <${agentId}@loom.local>`;
      await stageAndCommitFiles(this.agentDir(agentId), files, message);
      this.log.append({
        kind: "status",
        agentId,
        payload: { state: "turn_committed", files: files.length, subject },
      });
    } catch (err) {
      // A commit that can't happen (not a repo, hooks failed, nothing staged
      // after filters) is a Console line, never a failed turn.
      logbook.warn(
        "git",
        `turn commit skipped for ${agentId}`,
        err instanceof Error ? err.message : String(err),
        this.info.id,
      );
    }
  }

  /**
   * Phase 2: read a finished turn for durable memory.
   *
   * Fire-and-forget on purpose. A slow or missing extractor must never delay
   * anything — extractFromTurn already swallows engine failures, and this is
   * void-ed so even an unexpected throw can't escape into the event pipeline.
   * Off entirely when config says so; a no-op when Claude isn't available.
   */
  private extractMemory(agentId: string, files: string[]): void {
    if (this.config.brain?.extractor === "off") return;
    const chat = this.turnChat.get(agentId) ?? MAIN_CHAT;
    const turn = this.gatherTurnText(chat);
    if (turn.length < 40) return; // nothing substantial to learn from
    const model = this.config.brain?.model ?? "haiku";
    const engine: ExtractEngine = (p) =>
      claudeText(`${p.system}\n\n${p.user}`, { model, timeoutMs: 60_000 });
    void extractFromTurn(this.brain, turn, {
      engine,
      agentId,
      chat,
      ...(files.length ? { files } : {}),
      eventId: this.log.lastId(),
    })
      .then((res) => {
        const learned = res.added.length + res.updated.length + res.forgotten.length;
        if (learned > 0) {
          this.log.append({
            kind: "status",
            payload: {
              state: "brain_extract",
              agentId,
              added: res.added.length,
              updated: res.updated.length,
              forgotten: res.forgotten.length,
            },
          });
        }
      })
      .catch(() => {});
  }

  /**
   * The transcript of the most recent turn in a chat: from the last human
   * message to now — the user's ask and what the agent did in reply.
   */
  private gatherTurnText(chat: string): string {
    const events = this.log.list({ chat, limit: 40 });
    let start = 0;
    for (let i = events.length - 1; i >= 0; i--) {
      if (events[i]!.kind === "message" && !events[i]!.agentId) {
        start = i;
        break;
      }
    }
    const lines: string[] = [];
    for (const e of events.slice(start)) {
      const p = e.payload;
      if (e.kind === "message") {
        lines.push(`${e.agentId ?? "user"}: ${String(p.text ?? "").slice(0, 2000)}`);
      } else if (e.kind === "tool_call") {
        lines.push(`[${e.agentId} used ${String(p.tool ?? "a tool")}] ${String(p.summary ?? "")}`.trim());
      } else if (e.kind === "file_edit") {
        lines.push(`[${e.agentId} edited ${String(p.path ?? "")}]`);
      } else if (e.kind === "decision") {
        lines.push(`decision: ${String(p.text ?? "")}`);
      }
    }
    return lines.join("\n").trim();
  }

  workingTree(): Promise<WorkingTree> {
    return workingTree(this.info.dir);
  }

  // -------------------------------------------------------------------------
  // Unified memory — "multiple memory in one"
  // -------------------------------------------------------------------------

  /** Freshly read every connected ADE's native memory from disk. */
  private importedMemory(): ImportedBlock[] {
    return readNativeMemory(this.info.dir, this.config);
  }

  /** The merged brain: decisions + imported ADE memories + shared context. */
  unifiedMemory(): UnifiedMemory {
    return buildUnifiedMemory(this.info.name, this.log.list(), this.importedMemory());
  }

  /**
   * Phase 3: the brain brief for a handoff — the memories relevant to the work
   * in flight, compiled. Query is the recent conversation plus the files recent
   * turns touched; scoped to the incoming agent; low-confidence memories are
   * held back from injection (they stay visible in the Brain tab). Empty string
   * when there's nothing relevant, so callers append it unconditionally.
   */
  private retrieveBrief(events: LoomEvent[], agentId: string): string {
    const query = events
      .filter((e) => e.kind === "message")
      .slice(-8)
      .map((e) => String(e.payload.text ?? ""))
      .join(" ");
    const files = [
      ...new Set(
        events
          .filter((e) => e.kind === "turn_diff")
          .flatMap((e) => {
            // turn_diff stores ChangedFile[] ({status, path}); older events or
            // other shapes may carry bare strings. Normalise to paths.
            const raw = (e.payload.files as Array<string | { path?: string }> | undefined) ?? [];
            return raw.map((f) => (typeof f === "string" ? f : (f?.path ?? ""))).filter(Boolean);
          }),
      ),
    ].slice(-20);
    if (!query.trim() && !files.length) return "";
    const hits = retrieve(this.brain, {
      ...(query.trim() ? { query } : {}),
      ...(files.length ? { files } : {}),
      agent: agentId,
      minConfidence: CONFIDENCE_FLOOR,
      limit: 14,
    });
    return compileBrief(hits.map((h) => h.memory));
  }

  /**
   * Pull each ADE's native memory into the shared log. Idempotent — a source
   * whose content hasn't changed since its last import is skipped, so this is
   * safe to call on connect, on demand, or on a timer.
   */
  importMemories(): { imported: number; sources: string[] } {
    const seen = new Map<string, string>(); // file -> last imported hash
    for (const e of this.log.list({ kinds: ["memory_import"] })) {
      seen.set(String(e.payload.file), String(e.payload.hash));
    }
    const sources: string[] = [];
    let imported = 0;
    for (const block of this.importedMemory()) {
      const hash = hashContent(block.content);
      if (seen.get(block.file) === hash) continue;
      this.log.append({
        kind: "memory_import",
        agentId: block.agentId,
        payload: { file: block.file, kind: block.kind, chars: block.content.length, hash },
      });
      sources.push(block.file);
      imported += 1;
    }
    return { imported, sources };
  }

  /** Fire-and-notify hooks + routing + suggested handoffs, off the log. */
  private afterAgentEvent(event: LoomEvent): void {
    this.trackCost(event);
    this.routes.handleAgentEvent(event);
    // Accumulate the turn's prose so decisions can be mined when it completes.
    if (event.kind === "message" && event.agentId && !event.payload.reasoning) {
      const prev = this.turnText.get(event.agentId) ?? "";
      this.turnText.set(event.agentId, `${prev}\n${String(event.payload.text ?? "")}`.slice(-8000));
    }
    if (event.kind === "run_complete" && event.agentId) {
      this.captureTurnDiff(event.agentId);
      void this.captureAgentDecisions(event.agentId).catch(() => {});
    }
    if (event.kind === "needs_input") {
      notify({
        title: `Loom · ${this.info.name}`,
        body: `${event.agentId} needs input: ${String(event.payload.question ?? "")}`,
      });
    } else if (event.kind === "run_complete") {
      notify({
        title: `Loom · ${this.info.name}`,
        body: `${event.agentId} finished its turn`,
      });
    } else if (event.kind === "message") {
      if (event.agentId) this.captureDecisions(event);
      if (!this.routes.isActive()) {
        // A route drives its own handoffs — suggestions would be noise.
        const suggestion = suggestHandoff(event, this.config, this.baton.holder());
        if (suggestion) {
          this.log.append({ kind: "suggestion", payload: { ...suggestion, from: event.agentId } });
        }
      }
    }
  }

  /**
   * Convention: any agent line starting "Decision: …" is pinned into shared
   * memory automatically — it survives every future handoff projection.
   */
  private captureDecisions(event: LoomEvent): void {
    const text = String(event.payload.text ?? "");
    const matches = [...text.matchAll(/^[ \t]*decision:\s*(.+)$/gim)].slice(0, 5);
    for (const m of matches) {
      this.log.append({
        kind: "decision",
        payload: { text: m[1]!.trim(), author: event.agentId, auto: true },
      });
    }
  }

  // ── Structured agent decisions (Observatory Decision Explorer + Replay) ──

  private decisionsFile(): string {
    return path.join(projectLoomDir(this.info.dir), "decisions.json");
  }

  /** An agent's declared role from config (planner/builder/reviewer/…), else its kind. */
  agentRole(agentId: string): string {
    const cfg = this.config.agents.find((a) => a.id === agentId);
    return cfg?.role ?? cfg?.kind ?? "agent";
  }

  /** How many turns this agent has completed (for the decision's turnIndex). */
  private turnCountFor(agentId: string): number {
    return this.log.list({ kinds: ["run_complete"] }).filter((e) => e.agentId === agentId).length;
  }

  /**
   * All captured decisions for this project, newest first, in today's shape —
   * see normalizeStoredDecision for what that does to records written before
   * a decision had to say where its confidence came from.
   */
  getDecisions(): AgentDecision[] {
    try {
      const raw = fs.readFileSync(this.decisionsFile(), "utf8");
      const arr = JSON.parse(raw) as AgentDecision[];
      if (!Array.isArray(arr)) return [];
      return arr.map(normalizeStoredDecision).sort((a, b) => b.timestamp - a.timestamp);
    } catch {
      return [];
    }
  }

  decisionStats(): DecisionStats {
    return decisionStats(this.getDecisions());
  }

  /** Append decisions to the persisted store (kept oldest→newest on disk). */
  storeDecisions(decisions: AgentDecision[]): void {
    if (!decisions.length) return;
    const existing = this.getDecisions().sort((a, b) => a.timestamp - b.timestamp);
    const all = [...existing, ...decisions].slice(-1000); // bound the file
    try {
      fs.mkdirSync(projectLoomDir(this.info.dir), { recursive: true });
      fs.writeFileSync(this.decisionsFile(), JSON.stringify(all, null, 2));
    } catch {
      /* best-effort: decisions are an enrichment, never break the loop */
    }
  }

  /** Mine decisions from a completed turn, persist them, surface on the Timeline. */
  private async captureAgentDecisions(agentId: string): Promise<void> {
    const turnText = this.turnText.get(agentId) ?? "";
    this.turnText.delete(agentId);
    if (turnText.trim().length < 100) return;
    const lastTurn = this.log.list({ kinds: ["run_complete"] }).filter((e) => e.agentId === agentId).slice(-1)[0];
    const p = (lastTurn?.payload ?? {}) as Record<string, unknown>;
    let filesChanged: string[] = [];
    try {
      // stderr is dropped, not inherited: a project that isn't a repo yet, or
      // one with no commits, makes git print a usage wall on every completed
      // turn. The failure is already handled — it must not also be shouted
      // into the daemon's console.
      filesChanged = execSync("git diff --name-only HEAD", {
        cwd: this.info.dir,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      })
        .trim().split("\n").filter(Boolean);
    } catch { /* not a git repo, or nothing changed */ }
    // The trace this turn's spans went out under, when telemetry is on.
    // Undefined otherwise — see observability/index.ts#turnTraceId; a decision
    // that can't link to a trace must carry no trace id rather than "".
    const traceId = turnTraceId(agentId);
    const decisions = await extractDecisions({
      agentId,
      agentRole: this.agentRole(agentId),
      projectId: this.info.id,
      chatId: this.turnChat.get(agentId) ?? MAIN_CHAT,
      turnIndex: this.turnCountFor(agentId),
      ...(traceId ? { traceId } : {}),
      ...(lastTurn ? { turnId: String(lastTurn.id) } : {}),
      turnText,
      // The turn's totals, carried as the TURN's — not divided between the
      // decisions mined from it, and not stamped on each as if each cost this.
      turnTokensUsed: Number(p.inputTokens ?? 0) + Number(p.outputTokens ?? 0),
      turnCostUsd: Number(p.costUsd ?? 0),
      durationMs: Number(p.durationMs ?? 0),
      anthropicApiKey: process.env.ANTHROPIC_API_KEY,
      filesChanged,
    });
    if (!decisions.length) return;
    this.storeDecisions(decisions);
    // Surface each on the Timeline / snapshots via a status event (no new EventKind,
    // and no collision with the brain's memory `decision` events). `source` rides
    // along so a renderer can say where the confidence came from — or that there
    // isn't one, which is what a heuristic decision carries.
    for (const d of decisions) {
      this.log.append({
        kind: "status",
        agentId: d.agentId,
        ...(d.chatId && d.chatId !== MAIN_CHAT ? { chat: d.chatId } : {}),
        payload: {
          state: "agent_decision",
          decisionId: d.id,
          title: d.title,
          category: d.category,
          source: d.source,
          ...(d.confidence !== undefined ? { confidence: d.confidence } : {}),
        },
      });
    }
  }

  /**
   * The persisted holder, unless it refers to an agent that has since been
   * removed from the config — ghost holders are cleared, not fatal.
   */
  private validHolder(): string | null {
    const holder = this.baton.holder();
    if (holder && !this.agents.has(holder)) {
      this.baton.forceClear(`agent "${holder}" no longer in config`);
      return null;
    }
    return holder;
  }

  /**
   * Send a user message. Routing rules (decided in the design interview):
   *  - no explicit agent → goes to the baton holder (or defaultAgent/first
   *    adapter on first contact, which acquires the baton);
   *  - explicit agent that is NOT the holder → NotHolderError; surfaces
   *    prompt the user to confirm a handoff (explicit, never silent).
   */
  /**
   * Hand a prompt to a GUI agent by typing it into its own window.
   *
   * This is the road not taken by sendMessage. Antigravity and Kiro can't hold
   * the baton — they edit the tree on their own schedule and know nothing about
   * Loom's lock, so giving them the baton would be a promise Loom can't keep.
   * But they can be *driven*: Loom types into the chat panel of the app you're
   * already signed into, exactly as you would, and reads back what appeared.
   * That's what makes them reachable from your phone.
   *
   * The exchange lands in the thread like any other, because the whole point of
   * Loom is one place where you can see what was said to whom. It just never
   * touches the baton on the way, so an adapter mid-turn is undisturbed.
   *
   * Awaited, unlike sendMessage's fire-and-notify: there's no event stream to
   * follow here, only a panel that stops changing.
   */
  async askBridge(
    agentId: string,
    text: string,
    opts: { chat?: string } = {},
  ): Promise<{ agentId: string; reply: string }> {
    const chat = opts.chat ?? MAIN_CHAT;
    const agent = this.agent(agentId);
    if (isAdapter(agent)) {
      throw new Error(`agent "${agentId}" takes turns — send to it normally`);
    }
    const bridge = agent as unknown as { ask?: (t: string) => Promise<string> };
    if (typeof bridge.ask !== "function") {
      throw new Error(`agent "${agentId}" can be watched but not driven`);
    }

    await this.ensureStarted(agentId);
    this.turnChat.set(agentId, chat);
    this.log.append({ kind: "message", chat, agentId, payload: { text, author: "user" } });

    try {
      const reply = await withLoomAskTimeout(bridge.ask(text));
      return { agentId, reply };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // The bridge's own words: "signed out", "launch it with…". They're the
      // actionable part, and burying them behind "bridge failed" helps nobody.
      this.log.append({ kind: "error", chat, agentId, payload: { message } });
      throw err;
    }
  }

  async sendMessage(
    text: string,
    agentId?: string,
    opts: { source?: "user" | "route"; chat?: string } = {},
  ): Promise<{ agentId: string }> {
    const source = opts.source ?? "user";
    const chat = opts.chat ?? MAIN_CHAT;
    let target = agentId ?? this.validHolder() ?? this.defaultAdapterId();
    const agent = this.agent(target);
    if (!isAdapter(agent)) {
      throw new Error(`agent "${target}" is a bridge (read-only) — it cannot take turns`);
    }
    // Before anything is committed — the baton, the message in the thread, the
    // process — check the agent can afford the turn. Refusing after the message
    // is logged would leave a prompt in the conversation that nothing answers.
    this.enforceQuarantine(target);
    this.enforceBudget(target);

    const holder = this.validHolder();
    if (holder === null) {
      this.baton.acquire(target);
    } else if (holder !== target) {
      throw new NotHolderError(target, holder);
    }

    // A user reply to a paused route's question resumes the route.
    if (source === "user") this.routes.onUserMessage(target);

    // everything this turn produces belongs to the chat you sent from
    this.turnChat.set(target, chat);
    this.busySince.set(target, Date.now()); // the stale-session clock starts
    this.log.append({
      kind: "message",
      chat,
      payload: { text, author: source === "route" ? "loom" : "user" },
    });
    await this.ensureStarted(target);

    const pendingBriefing = this.consumePendingBriefing(target);
    // Prepend the enabled skills so every turn carries them, alongside any
    // one-shot handoff briefing. Empty when no skills are on.
    const briefing = [this.activeSkillsBlock(), pendingBriefing].filter(Boolean).join("\n").trim() || undefined;
    // The project's configured MCP servers, rendered to a temp config file the
    // adapter hands to its CLI. Null when nothing is configured — or when this
    // adapter's CLI has no flag for it, because an "MCP attached" note on a
    // turn that dropped the config would be the same lie in a new place.
    const mcp = agent.capabilities.mcp ? writeMcpSession(this.healthyMcps()) : null;
    const input: SendInput = {
      text,
      ...(briefing ? { briefing } : {}),
      ...(mcp ? { mcp: { configPath: mcp.configPath, servers: mcp.servers } } : {}),
    };
    if (mcp) {
      this.log.append({
        kind: "status",
        agentId: target,
        payload: { state: "mcp_attached", servers: mcp.servers.map((s) => s.name) },
      });
    }
    // Snapshot the tree so this prompt's changes can be attributed to it.
    this.preTurnTree.set(target, await porcelainStatus(this.agentDir(target)));
    // Fire-and-notify: the turn runs in the background; progress streams
    // into the log and completion lands as run_complete.
    void agent
      .send(input)
      .catch((err) => {
        this.appendIfOpen({
          kind: "error",
          agentId: target,
          payload: { message: String(err instanceof Error ? err.message : err) },
        });
      })
      // The config file exists for exactly this turn. Cleaned up whether the
      // turn succeeded, failed or was interrupted — a temp file per turn that
      // nothing removes is a slow leak of the project's server URLs.
      .finally(() => mcp?.cleanup());
    return { agentId: target };
  }

  // -------------------------------------------------------------------------
  // Named routes
  // -------------------------------------------------------------------------
  /**
   * Define or replace a named route.
   *
   * Routes were config you hand-edited: `ship` was built at init and everything
   * else meant opening .loom/config.json. Validated against the CURRENT roster
   * before saving — a route that names an agent this project doesn't have would
   * sit in the file looking runnable and fail at its first step. Saving through
   * here puts the team's pipeline in a version-controllable file instead of one
   * person's shell history.
   */
  saveRoute(name: string, steps: RouteStepSpec[]): Record<string, RouteStepSpec[]> {
    const clean = name.trim().slice(0, 40);
    if (!clean) throw new Error("a route needs a name");
    resolveSteps(steps, this.config, (id) => {
      const live = this.agents.get(id);
      return Boolean(live && isAdapter(live));
    });
    this.config.routes = { ...(this.config.routes ?? {}), [clean]: steps };
    this.saveConfig();
    return this.config.routes;
  }

  deleteRoute(name: string): Record<string, RouteStepSpec[]> {
    const routes = { ...(this.config.routes ?? {}) };
    if (!(name in routes)) throw new Error(`no route named "${name}"`);
    delete routes[name];
    this.config.routes = routes;
    this.saveConfig();
    return routes;
  }

  // -------------------------------------------------------------------------
  // Snapshots
  // -------------------------------------------------------------------------
  /**
   * Checkpoint the project's Loom-owned state: brain, board, config.
   *
   * For the moment before letting a fleet loose on something — a restorable
   * "before". Deliberately NOT the working tree (git owns files and does it
   * better) and NOT the event log (history is what happened; a restore that
   * rewrote history would be a lie with a timestamp). Restoring brings back
   * what the project knew, what was on the board, and how it was configured.
   */
  snapshot(): {
    format: "loom-snapshot";
    version: 1;
    project: string;
    takenAt: number;
    brain: ReturnType<Brain["export"]>;
    tasks: BoardTask[];
    config: ProjectConfig;
  } {
    return {
      format: "loom-snapshot",
      version: 1,
      project: this.info.name,
      takenAt: Date.now(),
      brain: this.brain.export(this.info.name),
      tasks: readProjectState(this.info.dir).tasks ?? [],
      config: this.config,
    };
  }

  /**
   * Restore a snapshot. Config and board are replaced (that is what "restore"
   * means for state you own); the brain is MERGED through the same dedupe as
   * import, because memory is an append-only fold — a restore that silently
   * forgot what was learned since the snapshot would be data loss wearing a
   * seatbelt. What it knew then comes back; what it learned since stays.
   */
  restore(snap: ReturnType<ProjectRuntime["snapshot"]>): {
    brain: { added: number; known: number };
    tasks: number;
  } {
    if (snap?.format !== "loom-snapshot") throw new Error("not a loom snapshot");
    const brain = this.brain.import(snap.brain, {
      agentId: "restore",
      eventId: this.log.lastId(),
      ts: Date.now(),
    });
    const state = readProjectState(this.info.dir);
    writeProjectState(this.info.dir, { ...state, tasks: snap.tasks });
    // `config` is readonly by reference and shared with every live subsystem,
    // so restore mutates its contents rather than swapping the object.
    for (const k of Object.keys(this.config)) {
      if (!(k in snap.config)) delete (this.config as unknown as Record<string, unknown>)[k];
    }
    Object.assign(this.config, snap.config);
    this.saveConfig();
    // Reconcile the live agents with the restored roster, the same way
    // addAgent/removeAgent would have: drop what's gone, spawn what's missing.
    const wanted = new Map(this.config.agents.map((a) => [a.id, a]));
    for (const [id, live] of [...this.agents]) {
      if (!wanted.has(id)) {
        void Promise.resolve(live.stop()).catch(() => {});
        this.agents.delete(id);
        this.startedAgents.delete(id);
      }
    }
    for (const cfg of this.config.agents) {
      if (!this.agents.has(cfg.id) && cfg.enabled !== false) this.spawnAgent(cfg);
    }
    this.log.append({
      kind: "status",
      payload: { state: "restored", takenAt: snap.takenAt, tasks: snap.tasks.length },
    });
    return { brain, tasks: snap.tasks.length };
  }

  // -------------------------------------------------------------------------
  // Stale sessions
  // -------------------------------------------------------------------------
  /**
   * When each adapter's current turn started. Set at dispatch, cleared when its
   * run_complete / error / interrupted lands. An entry much older than any
   * plausible turn is a hung session: the process is alive enough to hold
   * `busy` and dead enough to never finish, which blocks every dispatch with
   * "is busy" until someone notices.
   */
  private busySince = new Map<string, number>();

  /** Turns older than this are presumed hung. Generous: real turns run long. */
  static readonly STALE_TURN_MS = 10 * 60 * 1000;

  /** Adapters that look hung: busy far longer than any plausible turn. */
  staleSessions(now = Date.now()): Array<{ agentId: string; busyMs: number }> {
    const out: Array<{ agentId: string; busyMs: number }> = [];
    for (const [agentId, since] of this.busySince) {
      const live = this.agents.get(agentId);
      if (!live || !isAdapter(live) || !live.busy()) continue;
      const busyMs = now - since;
      if (busyMs >= ProjectRuntime.STALE_TURN_MS) out.push({ agentId, busyMs });
    }
    return out;
  }

  /**
   * Put a hung session out of its misery and bring up a fresh one.
   *
   * Interrupt first — a process that responds to that wasn't hung, and gets to
   * finish dying cleanly — then stop, drop, and respawn from config, exactly as
   * a cold start would. The baton is released if the corpse held it, because a
   * lock owned by a session that no longer exists refuses everyone forever.
   */
  async reapSession(agentId: string): Promise<{ respawned: boolean }> {
    const cfg = this.config.agents.find((a) => a.id === agentId);
    if (!cfg) throw new Error(`unknown agent "${agentId}" in project "${this.info.name}"`);
    const live = this.agents.get(agentId);
    if (live && isAdapter(live)) {
      await live.interrupt().catch(() => {});
      await live.stop().catch(() => {});
    }
    this.agents.delete(agentId);
    this.startedAgents.delete(agentId);
    this.busySince.delete(agentId);
    if (this.validHolder() === agentId) this.baton.release(agentId);
    this.spawnAgent(cfg);
    this.log.append({
      kind: "status",
      agentId,
      payload: { state: "session_reaped", reason: "stale or hung session respawned" },
    });
    return { respawned: true };
  }

  // -------------------------------------------------------------------------
  // Sub-agents
  // -------------------------------------------------------------------------
  /**
   * How many subtasks may run at once in this project.
   *
   * A fan-out is the point of the feature and also the way to melt the machine:
   * each child is a real CLI process with its own model calls. The cap is per
   * project rather than global so one busy project can't starve the others.
   */
  private static readonly MAX_CONCURRENT_SUBTASKS = 4;

  /** In-flight subtasks, by the id minted when they started. */
  private subtasks = new Map<
    string,
    { parent: string; agentId: string; task: string; startedAt: number }
  >();

  /** Subtasks currently running, for the status payload and the cap. */
  liveSubtasks(): Array<{ id: string; parent: string; agentId: string; task: string }> {
    return [...this.subtasks.entries()].map(([id, s]) => ({
      id,
      parent: s.parent,
      agentId: s.agentId,
      task: s.task,
    }));
  }

  /**
   * Run a subtask on a child agent, alongside the parent's turn.
   *
   * A turn used to be all-or-nothing: one agent, one prompt, one result. "Audit
   * these twelve files" wanted twelve cheap readers, and the only way to get
   * them was twelve sequential turns, each one taking the baton off the last.
   *
   * What makes a child a child rather than another turn:
   *
   *  - **It never touches the baton.** The parent still holds it, so a fan-out
   *    cannot steal the conversation from the agent that started it, and the
   *    human's next message still lands where they expect.
   *  - **Its briefing is narrowed.** It gets the task and the project's shape,
   *    not the parent's whole thread. Handing a child the full history is how
   *    you pay twice for context the parent already read.
   *  - **Its result is attributed and parented**, so the thread can indent it
   *    under the turn that asked rather than interleaving it as a peer.
   *
   * Everything it learns still lands in the one project brain — a child that
   * discovered something and took it to the grave would be worse than no child.
   */
  async spawnSubAgent(
    parentAgentId: string,
    opts: { agentId: string; task: string; chat?: string },
  ): Promise<{ id: string; agentId: string }> {
    const task = opts.task?.trim();
    if (!task) throw new Error("a subtask needs a task");

    // The parent has to be a real agent in this project, so the thread can
    // indent under something that exists.
    this.agent(parentAgentId);

    const child = this.agent(opts.agentId);
    if (!isAdapter(child)) {
      throw new Error(
        `agent "${opts.agentId}" is a bridge (read-only) — it cannot run a subtask`,
      );
    }
    if (this.subtasks.size >= ProjectRuntime.MAX_CONCURRENT_SUBTASKS) {
      throw new Error(
        `${ProjectRuntime.MAX_CONCURRENT_SUBTASKS} subtasks are already running in this project`,
      );
    }
    // Same gates as a turn. A child that ignored the budget would be a hole in
    // the ceiling the parent is standing under.
    this.enforceQuarantine(opts.agentId);
    this.enforceBudget(opts.agentId);

    const id = newId(5);
    const chat = opts.chat ?? MAIN_CHAT;
    this.subtasks.set(id, {
      parent: parentAgentId,
      agentId: opts.agentId,
      task,
      startedAt: Date.now(),
    });
    this.log.append({
      kind: "subtask_started",
      agentId: opts.agentId,
      chat,
      payload: { subtaskId: id, parent: parentAgentId, task },
    });

    await this.ensureStarted(opts.agentId);
    const mcp = child.capabilities.mcp ? writeMcpSession(this.healthyMcps()) : null;
    const input: SendInput = {
      text: task,
      briefing: this.subtaskBriefing(parentAgentId, opts.agentId, task),
      ...(mcp ? { mcp: { configPath: mcp.configPath, servers: mcp.servers } } : {}),
    };

    void child
      .send(input)
      .then(() => {
        this.subtasks.delete(id);
        this.appendIfOpen({
          kind: "subtask_done",
          agentId: opts.agentId,
          chat,
          payload: { subtaskId: id, parent: parentAgentId, task },
        });
      })
      .catch((err) => {
        this.subtasks.delete(id);
        this.appendIfOpen({
          kind: "subtask_failed",
          agentId: opts.agentId,
          chat,
          payload: {
            subtaskId: id,
            parent: parentAgentId,
            task,
            message: String(err instanceof Error ? err.message : err),
          },
        });
      })
      .finally(() => mcp?.cleanup());

    return { id, agentId: opts.agentId };
  }

  /**
   * The narrow briefing a child gets.
   *
   * Deliberately not the parent's thread. A child exists to answer one question
   * and hand back an answer; giving it the whole conversation costs tokens for
   * context it was not asked to reason about, and invites it to wander into the
   * parent's job. It gets what it is for, who asked, the rules of the project,
   * and the memories that match its own task — not the parent's.
   */
  private subtaskBriefing(parent: string, childId: string, task: string): string {
    const parts = [
      `[Loom subtask] You are "${childId}", running one scoped subtask for "${parent}" ` +
        `in project "${this.info.name}".`,
      `The subtask: ${task}`,
      "Do this one thing and report the result. Do not take over the wider task — " +
        `"${parent}" still owns the conversation and holds the baton.`,
    ];
    const skills = this.activeSkillsBlock();
    if (skills) parts.push(skills);
    // Retrieval scoped to the child's own task rather than the parent's thread.
    const hits = retrieve(this.brain, { query: task, agent: childId, limit: 6 });
    const brief = compileBrief(hits.map((h) => h.memory));
    if (brief) parts.push(brief);
    return parts.filter(Boolean).join("\n\n");
  }

  private defaultAdapterId(): string {
    const cfg =
      (this.config.defaultAgent &&
        this.config.agents.find((a) => a.id === this.config.defaultAgent)) ||
      this.config.agents.find((a) => isAdapter(this.agent(a.id)));
    if (!cfg) throw new Error(`project "${this.info.name}" has no full-duplex adapters`);
    return cfg.id;
  }

  // -------------------------------------------------------------------------
  // Handoff
  // -------------------------------------------------------------------------

  /** Briefings are injected with the first turn after a handoff. */
  private pendingBriefings = new Map<string, string>();

  private consumePendingBriefing(agentId: string): string | undefined {
    const briefing = this.pendingBriefings.get(agentId);
    this.pendingBriefings.delete(agentId);
    return briefing;
  }

  /**
   * Explicit baton pass: interrupt the current holder if mid-turn, project
   * the log into the target's namespaced memory, arm the one-shot briefing.
   * A *manual* handoff cancels any active route — the human outranks it.
   */
  /**
   * Re-run a failed turn on a different agent.
   *
   * When a turn failed, the only recovery was retyping the prompt at someone
   * else — and the someone else started cold, not knowing an attempt had been
   * made. This finds the failed turn's prompt, hands the baton to the chosen
   * agent, and re-sends the same text with the failure attached as context, so
   * the second agent knows what was tried and what it died of.
   *
   * The failure context rides the one-shot handoff briefing rather than the
   * message text, so the thread shows the same clean prompt twice rather than
   * a prompt wearing a stack trace.
   */
  async retryTurn(toAgentId: string): Promise<{ agentId: string; retried: string }> {
    const events = this.log.list({ limit: 200 });
    // The last error, and the last user message before it: that pairing is the
    // failed turn. Route-authored messages count too — a route step that died
    // is exactly what you retry somewhere else.
    let errorAt = -1;
    for (let i = events.length - 1; i >= 0; i--) {
      if (events[i]!.kind === "error") { errorAt = i; break; }
    }
    if (errorAt === -1) throw new Error("no failed turn to retry");
    const err = events[errorAt]!;
    let prompt: string | undefined;
    for (let i = errorAt - 1; i >= 0; i--) {
      const e = events[i]!;
      if (e.kind === "message" && !e.agentId) {
        prompt = String(e.payload.text ?? "");
        break;
      }
    }
    if (!prompt?.trim()) throw new Error("could not find the prompt that failed");

    await this.handoff(toAgentId, { source: "user" });
    const failedAgent = err.agentId ?? "the previous agent";
    const failure = String(err.payload.message ?? "unknown error").slice(0, 500);
    const prior = this.pendingBriefings.get(toAgentId);
    this.pendingBriefings.set(
      toAgentId,
      [
        prior,
        `[Loom retry] "${failedAgent}" attempted this and failed with: ${failure}`,
        "Do not repeat the failing approach without addressing the failure.",
      ]
        .filter(Boolean)
        .join("\n"),
    );
    await this.sendMessage(prompt, toAgentId, { chat: err.chat ?? MAIN_CHAT });
    return { agentId: toAgentId, retried: prompt };
  }

  async handoff(
    to: string,
    opts: { source?: "user" | "route" } = {},
  ): Promise<{ from: string | null }> {
    const target = this.agent(to);
    if (!isAdapter(target)) {
      throw new Error(`cannot hand the baton to "${to}" — bridges are read-only by design`);
    }
    // Handing the baton to an agent that can't afford a turn is the same
    // refusal as sending it one — and it has to be caught HERE, before the
    // current holder is interrupted, or a route would strand the baton on an
    // agent that will refuse every prompt it gets.
    this.enforceQuarantine(to);
    this.enforceBudget(to);
    if ((opts.source ?? "user") === "user") this.routes.onManualHandoff();

    // Audit trail: snapshot the outgoing holder's working-tree state into the
    // handoff event, so "who left what uncommitted" is always answerable.
    let handoffMeta: Record<string, unknown> = { projected: true };
    const holder = this.validHolder();
    if (holder && holder !== to) {
      const current = this.agent(holder);
      if (isAdapter(current)) {
        if (current.busy()) await current.interrupt();
        const diff = await current.diff().catch(() => "");
        if (diff) handoffMeta = { ...handoffMeta, dirty: true, diff: diff.slice(0, 2000) };
      }
    }

    // Refresh the shared brain from every ADE's native memory before handing
    // off, so the incoming agent inherits what the others knew.
    this.importMemories();
    const events = this.log.list({ limit: PROJECTION_WINDOW });
    const input = {
      projectName: this.info.name,
      config: this.config,
      events,
      targetAgentId: to,
      fromAgentId: holder,
    };
    // Template by default; LLM-distilled when the project opts in — always
    // falling back to the template so a broken Claude never blocks a handoff.
    const distillStart = Date.now();
    const rendered = await renderProjection(input, this.config.projection);
    // Phase 3: the memories relevant to the work in flight, retrieved and
    // compiled — this is the part the recency-window projection can't do. Query
    // is the recent conversation plus the files recent turns touched; scoped to
    // this chat and to the incoming agent; low-confidence memories are held back
    // from injection (they're still visible in the Brain tab).
    const brainBrief = this.retrieveBrief(events, to);
    // Append the unified cross-ADE memory so the incoming agent sees the
    // whole brain, not just this project's log.
    const unified = this.unifiedMemory();
    const parts = [rendered.content];
    if (brainBrief) parts.push(brainBrief);
    if (unified.sources.length > 0) parts.push(unified.document);
    const enriched = parts.join("\n\n---\n");
    await target.injectMemory(enriched);
    writeMemoryFile(this.info.dir, to, enriched); // idempotent with default impl
    this.pendingBriefings.set(to, buildBriefing(input));
    if (rendered.mode === "llm") {
      this.log.append({
        kind: "status",
        payload: { state: "projection", mode: "llm", ms: Date.now() - distillStart },
      });
    }

    // Bridges (GUI agents) are passive observers — keep their shared-context
    // files fresh on every hop so e.g. Antigravity always sees the weave.
    // (Always template views: N bridges × LLM calls per hop would be waste.)
    for (const cfg of this.config.agents) {
      const bystander = this.agents.get(cfg.id);
      if (!bystander || isAdapter(bystander) || cfg.id === to) continue;
      // Bridges get the retrieved brain brief too — they can't take a system
      // prompt, but their shared-context file is the only memory they have, so
      // it shouldn't be the one view without the learned memories in it.
      const bridgeBrief = this.retrieveBrief(events, cfg.id);
      const bridgeView = bridgeBrief
        ? `${buildProjection({ ...input, targetAgentId: cfg.id })}\n\n---\n${bridgeBrief}`
        : buildProjection({ ...input, targetAgentId: cfg.id });
      await bystander.injectMemory(bridgeView).catch(() => {});
    }

    const { from } = this.baton.handoff(to, handoffMeta);
    await this.ensureStarted(to);
    return { from };
  }

  async interrupt(
    opts: { source?: "user" | "route" } = {},
  ): Promise<{ interrupted: string | null }> {
    if ((opts.source ?? "user") === "user") this.routes.onManualInterrupt();
    const holder = this.validHolder();
    if (!holder) return { interrupted: null };
    const agent = this.agent(holder);
    if (isAdapter(agent) && agent.busy()) {
      await agent.interrupt();
      return { interrupted: holder };
    }
    return { interrupted: null };
  }

  // -------------------------------------------------------------------------
  // Routing
  // -------------------------------------------------------------------------

  /**
   * Start a multi-hop route. `spec` may be: "auto" (dynamic — a router picks
   * every hop), an array of steps, a named route from config, or a comma
   * list of agent ids/roles. Undefined → the "ship" route if defined, else
   * every adapter in config order.
   */
  async startRoute(opts: {
    task: string;
    spec?: string | RouteStepSpec[];
    router?: RouterKind;
    maxHops?: number;
  }): Promise<RouteState> {
    if (typeof opts.spec === "string" && opts.spec.trim() === "auto") {
      return this.routes.startDynamic(opts.task, {
        ...(opts.router ? { router: opts.router } : {}),
        ...(opts.maxHops ? { maxHops: opts.maxHops } : {}),
      });
    }
    let steps: RouteStepSpec[] | undefined;
    let name: string | undefined;
    if (Array.isArray(opts.spec)) {
      steps = opts.spec;
    } else if (typeof opts.spec === "string" && opts.spec.trim()) {
      const named = this.config.routes?.[opts.spec.trim()];
      if (named) {
        steps = named;
        name = opts.spec.trim();
      } else {
        steps = opts.spec.split(",").map((s) => s.trim()).filter(Boolean);
      }
    } else {
      const ship = this.config.routes?.["ship"];
      if (ship) {
        steps = ship;
        name = "ship";
      } else {
        steps = this.config.agents
          .filter((a) => {
            const agent = this.agents.get(a.id);
            return agent && isAdapter(agent);
          })
          .map((a) => a.id);
      }
    }
    return this.routes.start(steps ?? [], opts.task, name);
  }

  async abortRoute(): Promise<RouteState> {
    return this.routes.abort();
  }

  routeState(): RouteState | null {
    return this.routes.state();
  }

  // -------------------------------------------------------------------------
  // Status / board
  // -------------------------------------------------------------------------

  async status(): Promise<ProjectStatus> {
    const holder = this.validHolder();
    const agents = await Promise.all(
      this.config.agents.map(async (cfg) => {
        // The picker shows a tick next to the active model; "" means the
        // adapter's own default, which is the honest baseline.
        const model = (cfg.options?.model as string | undefined) ?? "";
        const live = this.agents.get(cfg.id);
        if (!live) {
          // Switched off: still in the roster, just not spawned. Its tier has
          // to come from somewhere other than the instance, and switching an
          // agent off must not change what it *is*. ADES first (the catalog
          // people pick from), then the factory registry for the kinds ADES
          // deliberately omits. Defaulting to "adapter" would be wrong for
          // exactly those: a disabled bridge would advertise itself as an
          // adapter to every surface that filters on this field.
          const spec = ADES.find((a) => a.kind === cfg.kind);
          const tier = spec?.tier ?? tierForKind(cfg.kind) ?? "adapter";
          return {
            id: cfg.id,
            kind: cfg.kind,
            role: cfg.role,
            tier,
            available: false,
            busy: false,
            holdsBaton: false,
            model,
            // "not spawned" is not "switched off". An agent whose CLI is missing
            // is still enabled in config, and reporting it as disabled made the
            // project-settings toggle render off — clicking it then wrote the
            // value it already had, so the agent could never be turned back on.
            enabled: cfg.enabled !== false,
          };
        }
        return {
          id: cfg.id,
          kind: cfg.kind,
          role: cfg.role,
          tier: live.capabilities.tier,
          available: await live.available().catch(() => false),
          busy: isAdapter(live) ? live.busy() : false,
          holdsBaton: holder === cfg.id,
          model,
          enabled: true,
        };
      }),
    );
    const recent = this.log.list({ limit: 50 });
    const lastEvent = recent[recent.length - 1] ?? null;
    const lastUserMsg = [...recent]
      .reverse()
      .find((e) => e.kind === "message" && !e.agentId);
    const lastNeedsInput = [...recent].reverse().find((e) => e.kind === "needs_input");
    const needsInput = Boolean(
      lastNeedsInput && (!lastUserMsg || lastNeedsInput.id > lastUserMsg.id),
    );
    return {
      id: this.info.id,
      name: this.info.name,
      dir: this.info.dir,
      holder,
      agents,
      lastEvent,
      needsInput,
      // which agent is waiting, not just that someone is — the board needs a
      // name to put on the card, and every caller already gets needsInput
      blockedAgent: needsInput ? (lastNeedsInput?.agentId ?? null) : null,
      chats: this.chats(),
      route: this.routes.state(),
      routeNames: ["auto", ...Object.keys(this.config.routes ?? {})],
      costUsd: this.costs.totalUsd,
      // Paused agents belong in the status payload, not only in state on disk.
      // Without this the UI cannot show that an alert has taken an agent out of
      // rotation — the pause was real and completely invisible, which reads as
      // "the self-heal did nothing".
      quarantine: this.quarantined(),
    };
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.mcpTimer) { clearInterval(this.mcpTimer); this.mcpTimer = null; }
    for (const id of this.startedAgents) {
      await this.agent(id).stop().catch(() => {});
    }
    this.startedAgents.clear();
    this.brain.close(); // unsubscribes before the log drops its listeners
    this.log.close();
  }

  private closed = false;

  /**
   * Append unless the runtime has been closed.
   *
   * The async tails need this: a subtask completion or a turn error can resolve
   * after close() — stopping an agent does not cancel a promise already in
   * flight — and appending then throws into an unhandled rejection against a
   * sqlite handle that no longer exists. The record is not lost so much as
   * meaningless: the project this event belonged to is gone from memory.
   */
  private appendIfOpen(event: Parameters<EventLog["append"]>[0]): void {
    if (this.closed) return;
    this.log.append(event);
  }
}

export function relativeToProject(projectDir: string, p: string): string {
  return path.isAbsolute(p) ? path.relative(projectDir, p) : p;
}

function configMtimeOf(projectDir: string): number {
  try {
    return fs.statSync(path.join(projectDir, ".loom", "config.json")).mtimeMs;
  } catch {
    return 0;
  }
}
