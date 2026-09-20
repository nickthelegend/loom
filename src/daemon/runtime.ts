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
import { GIT_DELIVERIES, isAdapter, MAIN_CHAT, type GitDelivery } from "../types.js";
import { createAgent, isWithdrawnKind, knownAgentKinds, tierForKind } from "../adapters/index.js";
import { ADES } from "../core/ades.js";
import { BatonManager, NotHolderError } from "../core/baton.js";
import { Brain, CONFIDENCE_FLOOR, type Memory } from "../core/brain.js";
import { compileBrief, retrieve, type Hit, type RetrieveOpts } from "../core/brain-index.js";
import { extractFromTurn, readExternalContent, type ExtractEngine } from "../core/brain-extract.js";
import { claudeText } from "../core/claude-cli.js";
import { EventLog } from "../core/eventlog.js";
import { addWorktree as gitAddWorktree, ensureBranch, push as gitPush, readOut, stageAndCommitFiles, worktreePath } from "../core/git.js";
import { logbook } from "../core/logbook.js";
import { compileTieredBrief, retrieveTiered, type TieredMemory } from "../core/team-memory.js";
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
import { OrchestraEngine, type OrchestraCoordinator } from "../core/orchestra.js";
import {
  PromptQueue,
  describeCondition,
  type QueueCondition,
  type QueueInput,
  type QueueItem,
  type QueueState,
  type QueueTarget,
} from "../core/prompt-queue.js";
import { blockedBy } from "../core/goal-lanes.js";
import { Servers, type LogLine, type ServerStatus } from "../core/servers.js";
import { startPreviewProxy, type PreviewProxy } from "../core/preview-proxy.js";
import { agentAllowed, cappedPermission, type TeamPolicy } from "../core/team-policy.js";
import { isPermissionMode, permissionFor, unsupportedReason, type PermissionMode } from "../core/permissions.js";
import { detectAdes } from "../core/ades.js";
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
  type TurnDiff,
  type WorkingTree,
} from "../core/worktree.js";
import { NO_CHANGES, type TurnFacts } from "../core/step-conditions.js";
import { SemanticIndex } from "../core/semantic.js";
import { ModelAdapter } from "../adapters/model.js";
import { describeMerge, mergeAgentWork, type MergeOutcome } from "../core/worktree-merge.js";

/** How many models one ask may go to at once. */
const MAX_FANOUT = 8;

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

/** What briefings need from the team brain (src/daemon/team-brain.ts). */
export interface TeamBrainHook {
  /** The tiered pool (canon, team, own), or null when the project isn't shared. */
  pool(own: Memory[]): TieredMemory[] | null;
  /** Live team context near these paths (D48), or "". */
  context(files: string[]): string;
}

/** The queue is holding because this agent asked the human something. */
const questionHold = (agentId: string) => `${agentId} asked you something — answer it, or resume to send what's queued`;

/** What the socket carries about a server: a state change, or a line of output. */
export type ServerFrame =
  | { kind: "state"; name: string; status: ServerStatus }
  | { kind: "line"; name: string; line: LogLine };

/** How often a time-held prompt checks the clock. */
export const CLOCK_TICK_MS = 15_000;

export class ProjectRuntime {
  readonly info: ProjectInfo;
  readonly config: ProjectConfig;
  readonly log: EventLog;
  readonly baton: BatonManager;
  readonly routes: RouteEngine;
  /** One orchestrator, many parallel workers — see core/orchestra.ts. */
  readonly orchestra: OrchestraEngine;
  /** Adapter kinds installed on this machine, probed once at open. */
  private installedKinds: string[] = [];
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
  /** What you've lined up, run one at a time — see core/prompt-queue.ts. */
  readonly queue: PromptQueue;
  /** This project's dev servers — see core/servers.ts. */
  readonly servers: Servers;
  /** One preview proxy per server — see core/preview-proxy.ts. */
  private proxies = new Map<string, PreviewProxy>();
  private serverListeners = new Set<(f: ServerFrame) => void>();
  private queueListeners = new Set<(s: QueueState) => void>();
  private draining = false;

  /**
   * The dense retrieval channel, when this project opted in (brain.semantic).
   *
   * Null is the normal state, and null costs nothing: no model is loaded, no
   * vectors are written, and retrieval is the three lexical channels. Loading
   * happens in the background — the first brief after a cold start uses
   * whatever is ready, which is the honest thing for something that takes ten
   * seconds to warm up.
   */
  private semantic: SemanticIndex | null = null;

  private constructor(info: ProjectInfo, config: ProjectConfig, log: EventLog) {
    this.info = info;
    this.config = config;
    this.log = log;
    this.baton = new BatonManager(info.dir, log);
    if (config.brain?.semantic) {
      const index = new SemanticIndex(path.join(info.dir, ".loom"));
      void index
        .start()
        .then(async (ok) => {
          if (!ok) return; // the runtime isn't installed; logbook said so
          this.semantic = index;
          const made = await index.sync(this.brain.all());
          if (made) logbook.info("brain", `embedded ${made} memories for semantic retrieval`, "", info.id);
        })
        .catch((err) => logbook.warn("brain", "semantic retrieval didn't start", String(err), info.id));
    }
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
      turnFacts: (agentId) => this.turnFacts(agentId),
      isAdapterId: (id) => {
        const agent = this.agents.get(id);
        return Boolean(agent && isAdapter(agent));
      },
    });

    this.orchestra = new OrchestraEngine({
      projectId: info.id,
      projectName: info.name,
      projectDir: info.dir,
      roster: () =>
        this.config.agents.filter(
          (a) => a.enabled !== false && tierForKind(a.kind) === "adapter" && !isWithdrawnKind(a.kind),
        ),
      installedKinds: () => this.installedKinds,
      makeAgent: (cfg, dir) => {
        const agent = createAgent({ ...cfg, options: { ...this.policyOptions(cfg), loomProject: info.id } }, dir);
        if (!isAdapter(agent)) throw new Error(`"${cfg.id}" is a bridge — it cannot run orchestra work`);
        return agent;
      },
      append: (e) => (this.closed ? ({ ...e, id: -1, ts: Date.now() } as LoomEvent) : this.log.append(e)),
      createChat: (title) => this.createChat(title),
      briefingFor: async (query, agentId, files) =>
        [
          this.activeSkillsBlock(),
          await this.brainBriefFor({ query, agent: agentId, limit: 6 }),
          this.teamBrain?.context(files ?? []) ?? "",
        ]
          .filter(Boolean)
          .join("\n\n"),
      gate: (agentId) => {
        this.enforceQuarantine(agentId);
        this.enforceBudget(agentId);
      },
      observe: (event) => this.trackCost(event),
      gitDelivery: () => this.config.git?.delivery ?? "none",
      goalBudgetUsd: () => this.config.budgets?.perGoalUsd ?? null,
      maxConcurrentGoals: () => this.config.maxConcurrentGoals ?? null,
      member: () => this.memberLogin,
      coordinator: () => this.coordinator,
    });

    this.queue = new PromptQueue(path.join(projectLoomDir(info.dir), "queue.json"), (q) => {
      for (const cb of this.queueListeners) cb(q);
      this.watchClockConditions(q);
    });

    this.servers = new Servers({
      projectDir: info.dir,
      configs: () => this.config.servers ?? [],
      onChange: (name, status) => {
        for (const cb of this.serverListeners) cb({ kind: "state", name, status });
        // A server that died while an agent worked against it is the answer to
        // "why is the page blank?" — it belongs in the thread, not only a pane.
        if (status.state === "crashed") {
          this.appendIfOpen({
            kind: "status",
            payload: { state: "server_crashed", server: name, exitCode: status.exitCode },
          });
        }
      },
      onLine: (name, line) => {
        for (const cb of this.serverListeners) cb({ kind: "line", name, line });
      },
    });
    // a goal or a route that ends frees the head of the queue
    log.onEvent((e) => {
      if (e.kind === "orchestra" || e.kind === "route_completed" || e.kind === "route_failed") this.kickQueue();
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
    void detectAdes()
      .then((found) => (rt.installedKinds = Object.keys(found).filter((k) => found[k])))
      .catch(() => {});
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
    brain?: { extractor?: "auto" | "off"; model?: string; semantic?: boolean };
    projection?: { mode?: "template" | "llm"; model?: string; timeoutMs?: number };
    defaultAgent?: string;
    git?: {
      commitPerTurn?: boolean;
      branchPerTask?: boolean;
      worktreePerAgent?: boolean;
      mergeOnHandoff?: boolean;
      delivery?: string;
    };
    safety?: { snapshotBeforeRoutes?: boolean };
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
      if (typeof patch.brain.semantic === "boolean") {
        if (patch.brain.semantic) b.semantic = true;
        else delete b.semantic;
      }
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
    if (patch.git) {
      const g = { ...(this.config.git ?? {}) };
      for (const k of [
        "commitPerTurn",
        "branchPerTask",
        "worktreePerAgent",
        "mergeOnHandoff",
      ] as const) {
        if (typeof patch.git[k] === "boolean") {
          if (patch.git[k]) g[k] = true;
          else delete g[k];
        }
      }
      if (patch.git.delivery !== undefined) {
        if (!GIT_DELIVERIES.includes(patch.git.delivery as GitDelivery)) {
          throw new Error(`git.delivery must be one of ${GIT_DELIVERIES.join(", ")}`);
        }
        if (patch.git.delivery === "none") delete g.delivery;
        else g.delivery = patch.git.delivery as GitDelivery;
      }
      if (Object.keys(g).length) this.config.git = g;
      else delete this.config.git;
      // worktreePerAgent takes effect for agents spawned from here on; the
      // Settings screen says so rather than pretending it's instant.
    }
    if (patch.safety) {
      if (typeof patch.safety.snapshotBeforeRoutes === "boolean") {
        if (patch.safety.snapshotBeforeRoutes) this.config.safety = { snapshotBeforeRoutes: true };
        else delete this.config.safety;
      }
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
    brain: { extractor: "auto" | "off"; model: string; semantic: boolean };
    projection: { mode: "template" | "llm"; model: string };
    defaultAgent: string;
    git: {
      commitPerTurn: boolean;
      branchPerTask: boolean;
      worktreePerAgent: boolean;
      mergeOnHandoff: boolean;
      delivery: GitDelivery;
    };
    safety: { snapshotBeforeRoutes: boolean };
    agents: Array<{ id: string; kind: string; role?: string }>;
  } {
    return {
      brain: {
        extractor: this.config.brain?.extractor === "off" ? "off" : "auto",
        model: this.config.brain?.model ?? "",
        semantic: Boolean(this.config.brain?.semantic),
      },
      projection: {
        mode: this.config.projection?.mode === "llm" ? "llm" : "template",
        model: this.config.projection?.model ?? "",
      },
      git: {
        commitPerTurn: Boolean(this.config.git?.commitPerTurn),
        branchPerTask: Boolean(this.config.git?.branchPerTask),
        worktreePerAgent: Boolean(this.config.git?.worktreePerAgent),
        mergeOnHandoff: Boolean(this.config.git?.mergeOnHandoff),
        delivery: this.config.git?.delivery ?? "none",
      },
      safety: { snapshotBeforeRoutes: Boolean(this.config.safety?.snapshotBeforeRoutes) },
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
  addAgent(
    kind: string,
    opts: { id?: string; role?: string; options?: Record<string, unknown> } = {},
  ): AgentConfig {
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
    // A `model` agent with no model is an agent that refuses every turn, so
    // the options that make it work are settable as it's added rather than in
    // a second step nobody is told about.
    const cfg: AgentConfig = {
      id,
      kind,
      role: (opts.role ?? kind).trim().slice(0, 40) || kind,
      ...(opts.options && Object.keys(opts.options).length ? { options: opts.options } : {}),
    };
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
    // The project id rides along so an adapter can file approvals ("always
    // ask") against the right project — see core/approvals.ts.
    const agent = createAgent(
      { ...cfg, options: { ...this.policyOptions(cfg), loomProject: this.info.id } },
      this.agentDir(cfg.id),
    );
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
      // An agent that stops to ask you something is the whole reason Loom
      // exists: the next queued prompt would answer a question you never saw,
      // so the queue waits for you instead. Answering goes out immediately —
      // a paused queue holds what's lined up, not what you type now.
      if (e.kind === "needs_input") this.holdQueueFor(agent.id);
      // Any terminal event stops the stale-session clock — a turn that ended in
      // an error is over, not hung.
      const turnOver = e.kind === "run_complete" || e.kind === "error" || (e.kind === "status" && p.state === "interrupted");
      if (turnOver) {
        this.busySince.delete(agent.id);
        // the next queued prompt may go (a Stop paused the queue first — see interrupt)
        this.kickQueue();
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

  /**
   * Choose how much an agent may do without asking: bypass | auto | ask.
   *
   * Same shape as setAgentModel — the mode is read when the adapter is built
   * (it becomes CLI flags, or the env of opencode's server), so the agent is
   * rebuilt. Refused mid-turn for the same reason.
   */
  setAgentPermissions(agentId: string, mode: PermissionMode): AgentConfig {
    if (!isPermissionMode(mode)) throw new Error(`permissions must be bypass, auto or ask`);
    const cfg = this.config.agents.find((a) => a.id === agentId);
    if (!cfg) throw new Error(`unknown agent "${agentId}"`);
    const why = unsupportedReason(cfg.kind, mode);
    if (why) throw new Error(`"${mode}" isn't available for ${cfg.kind}: ${why}`);
    // D38: a team-shared project can't go looser than loom.team.json allows.
    if (this.teamPolicy && cappedPermission(this.teamPolicy, mode, true) !== mode) {
      throw new Error(`team policy caps permissions at "${this.teamPolicy.permissions.ceiling}" on this repo (loom.team.json)`);
    }
    const live = this.agents.get(agentId);
    if (live && isAdapter(live) && live.busy()) {
      throw new Error(`"${agentId}" is mid-turn — wait for it to finish, then change its permissions`);
    }
    cfg.options = { ...(cfg.options ?? {}), permissions: mode };
    if (live) {
      void Promise.resolve(live.stop()).catch(() => {});
      this.agents.delete(agentId);
      this.startedAgents.delete(agentId);
    }
    if (cfg.enabled !== false) this.spawnAgent(cfg);
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

  createChat(title: string, opts: { agentId?: string; model?: string } = {}): ChatInfo {
    const bound = opts.agentId ? this.bindable(opts.agentId, opts.model) : null;
    const state = readProjectState(this.info.dir);
    const chat: ChatInfo = {
      id: newId(4),
      // numbered, not "New chat" — the button already says New chat, and a
      // sidebar of identical rows tells you nothing
      title: title.trim().slice(0, 60) || `Chat ${(state.chats ?? []).length + 2}`,
      createdAt: Date.now(),
      ...(bound ? { agentId: bound.agentId } : {}),
      ...(bound?.model ? { model: bound.model } : {}),
    };
    state.chats = [...(state.chats ?? []), chat];
    writeProjectState(this.info.dir, state);
    return chat;
  }

  /**
   * May this thread be bound to this agent (and model)?
   *
   * A model bound to an agent that bakes its model into a spawned process
   * would be a setting that silently did nothing, so it is refused here —
   * where the person can act on it — rather than dropped at send time.
   */
  private bindable(agentId: string, model?: string): { agentId: string; model?: string } {
    const agent = this.agents.get(agentId);
    if (!agent) throw new Error(`no agent "${agentId}" in this project`);
    if (!isAdapter(agent)) throw new Error(`"${agentId}" is a bridge — it can't answer in a thread`);
    if (model && !this.switchesModelPerTurn(agentId)) {
      throw new Error(
        `"${agentId}" can't change model per thread — pin the model on the agent instead (loom model ${agentId} ${model}), or use a "model" agent`,
      );
    }
    return { agentId, ...(model ? { model } : {}) };
  }

  /** Can this agent be handed a different model for one turn? */
  private switchesModelPerTurn(agentId: string): boolean {
    return this.config.agents.find((a) => a.id === agentId)?.kind === "model";
  }

  /** Bind (or unbind) who answers in a thread. */
  setChatAgent(id: string, agentId: string | null, model?: string): ChatInfo | null {
    if (id === MAIN_CHAT) {
      // Main is where the baton answers; that's what makes it Main.
      throw new Error("the main thread follows the baton — make a new thread to pin an agent");
    }
    const bound = agentId ? this.bindable(agentId, model) : null;
    const state = readProjectState(this.info.dir);
    const chat = (state.chats ?? []).find((c) => c.id === id);
    if (!chat) return null;
    if (bound) {
      chat.agentId = bound.agentId;
      if (bound.model) chat.model = bound.model;
      else delete chat.model;
    } else {
      delete chat.agentId;
      delete chat.model;
    }
    writeProjectState(this.info.dir, state);
    return chat;
  }

  /**
   * Ask several models the same thing at once, each in its own thread.
   *
   * With free quota, asking five models costs what asking one costs, and
   * "which of these is right" is a judgement a person makes in ten seconds.
   * So: one prompt, one thread per model, all running at the same time.
   *
   * The agents are TRANSIENT — built for the ask, not added to the roster.
   * Adding five agents to .loom/config.json to ask five questions would leave
   * the project's roster as a record of everything anyone ever compared. What
   * stays behind is the threads, which are the part worth keeping.
   */
  async askModels(
    text: string,
    picks: Array<{ model: string; provider?: string }>,
    opts: { title?: string; briefing?: boolean } = {},
  ): Promise<Array<{ chat: string; model: string; provider: string; agentId: string }>> {
    if (!picks.length) throw new Error("name at least one model");
    if (picks.length > MAX_FANOUT) {
      throw new Error(`that's ${picks.length} models — ${MAX_FANOUT} at a time is the limit`);
    }
    const brief = opts.briefing === false ? "" : await this.brainBriefFor({ query: text, limit: 6 });
    const started: Array<{ chat: string; model: string; provider: string; agentId: string }> = [];

    for (const pick of picks) {
      const provider = pick.provider ?? "openrouter";
      // The model IS the name here: a thread labelled "ask-3" tells you
      // nothing, and this is a view where which model said what is the point.
      const short = pick.model.split("/").pop() ?? pick.model;
      const chat = this.createChat(`${opts.title ?? "ask"} · ${short}`.slice(0, 60));
      const agentId = `ask:${pick.model}`;
      this.log.append({
        kind: "message",
        chat: chat.id,
        payload: { text, author: "user", ask: { model: pick.model, provider } },
      });

      const agent = new ModelAdapter(agentId, this.info.dir, { provider, model: pick.model });
      // Its events land in the log tagged with its own thread, exactly as a
      // roster agent's do — which is what makes the answers readable later.
      const off = agent.onEvent((e) => {
        this.appendIfOpen({ ...e, agentId, chat: chat.id });
      });
      void agent
        .send({ text, ...(brief ? { briefing: brief } : {}) })
        .catch((err) => {
          this.appendIfOpen({
            kind: "error",
            agentId,
            chat: chat.id,
            payload: { message: String(err instanceof Error ? err.message : err) },
          });
        })
        .finally(() => off());
      started.push({ chat: chat.id, model: pick.model, provider, agentId });
    }
    this.log.append({
      kind: "status",
      payload: { state: "asked_models", models: picks.map((p) => p.model), chats: started.map((s) => s.chat) },
    });
    return started;
  }

  /** What a thread has pinned, if anything. */
  chatBinding(chat?: string): { agentId?: string; model?: string } {
    if (!chat || chat === MAIN_CHAT) return {};
    const found = this.chats().find((c) => c.id === chat);
    if (!found?.agentId) return {};
    // A thread pinned to an agent that has since left the roster falls back to
    // the baton rather than failing: the conversation is still readable, and
    // the alternative is a thread nobody can type in.
    if (!this.agents.has(found.agentId)) return {};
    return { agentId: found.agentId, ...(found.model ? { model: found.model } : {}) };
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
  /**
   * What opening a PR for this card would push, and what it would run.
   *
   * Asked before anything happens, because pushing publishes: the person sees
   * the branch, the commits and the exact command, and only then decides.
   */
  async taskPrPlan(id: string): Promise<{ branch: string; base: string; commits: string[]; files: string[]; command: string; ready: boolean; why?: string }> {
    const task = (readProjectState(this.info.dir).tasks ?? []).find((t) => t.id === id);
    if (!task) throw new Error(`no card "${id}"`);
    const branch = this.taskBranchName(task);
    const base = (await readOut(this.info.dir, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]))
      .replace(/^origin\//, "")
      .trim() || "main";
    const exists = await readOut(this.info.dir, ["rev-parse", "--verify", "--quiet", branch]);
    if (!exists.trim()) {
      return { branch, base, commits: [], files: [], command: "", ready: false, why: `there's no ${branch} branch yet` };
    }
    const log = await readOut(this.info.dir, ["log", "--oneline", `${base}..${branch}`]);
    const commits = log.split("\n").map((l) => l.trim()).filter(Boolean);
    const diff = await readOut(this.info.dir, ["diff", "--name-only", `${base}...${branch}`]);
    const files = diff.split("\n").map((l) => l.trim()).filter(Boolean);
    const command = `gh pr create --head ${branch} --base ${base} --title ${JSON.stringify(task.title)} --body ""`;
    return {
      branch,
      base,
      commits,
      files,
      command,
      ready: commits.length > 0,
      ...(commits.length ? {} : { why: `${branch} has nothing ${base} doesn't` }),
    };
  }

  /** Push the branch and open the PR — only ever from an explicit click. */
  async openTaskPr(id: string): Promise<{ url: string; branch: string }> {
    const task = (readProjectState(this.info.dir).tasks ?? []).find((t) => t.id === id);
    if (!task) throw new Error(`no card "${id}"`);
    const plan = await this.taskPrPlan(id);
    if (!plan.ready) throw new Error(plan.why ?? "there's nothing to open a PR for");
    await readOut(this.info.dir, ["push", "-u", "origin", plan.branch]);
    const out = await readOut(this.info.dir, [], {
      cmd: "gh",
      args: ["pr", "create", "--head", plan.branch, "--base", plan.base, "--title", task.title, "--body", ""],
    });
    const url = (out.match(/https:\/\/\S+/) ?? [""])[0];
    if (!url) throw new Error(out.trim().slice(0, 300) || "gh didn't return a PR url");
    this.appendIfOpen({ kind: "status", payload: { state: "task_pr", task: task.id, branch: plan.branch, url } });
    return { url, branch: plan.branch };
  }

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
    // A live orchestra run counts: reloading the project would close it, and
    // closing aborts the run — a config edit must not kill a fleet mid-flight.
    if (this.orchestra.active()) return true;
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

  /**
   * The diff of each agent's most recent turn, as a promise.
   *
   * A route's step conditions ("run the reviewer if more than 200 lines
   * changed") are decided the moment the turn completes, which is before the
   * diff has finished being computed. Keeping the promise lets the route wait
   * for the real numbers instead of reading the previous turn's.
   */
  private lastTurnDiff = new Map<string, Promise<TurnDiff | null>>();

  /** What an agent's last turn changed — for route step conditions. */
  async turnFacts(agentId: string): Promise<TurnFacts> {
    const diff = await (this.lastTurnDiff.get(agentId) ?? Promise.resolve(null));
    if (!diff) return NO_CHANGES;
    return { files: diff.files.map((f) => f.path), added: diff.added, removed: diff.removed };
  }

  /** After a turn: log which files that prompt changed (turn_diff), then learn. */
  private captureTurnDiff(agentId: string): void {
    const before = this.preTurnTree.get(agentId);
    if (before === undefined) {
      // No snapshot (e.g. a turn with no pre-tree) — still worth reading.
      // The previous turn's diff goes with it: a route asking what this turn
      // changed must not be handed the last one's numbers.
      this.lastTurnDiff.delete(agentId);
      this.extractMemory(agentId, []);
      return;
    }
    this.preTurnTree.delete(agentId);
    const pending = diffSinceSnapshot(this.agentDir(agentId), before).catch(() => null);
    this.lastTurnDiff.set(agentId, pending);
    void pending
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
    const delivery = this.config.git?.delivery ?? "none";
    if ((!this.config.git?.commitPerTurn && delivery === "none") || !files.length) return;
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
      // "push" delivers each committed turn; "pr" leaves pushing to the
      // orchestra's branch (a PR per turn is the flood teams complain about).
      if (delivery === "push") {
        const pushed = await gitPush(this.agentDir(agentId));
        this.log.append({ kind: "status", agentId, payload: { state: "turn_pushed", branch: pushed.branch } });
      }
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
    const recent = this.log.list({ limit: 80 }).filter((e) => (e.chat ?? MAIN_CHAT) === chat);
    void extractFromTurn(this.brain, turn, {
      engine,
      agentId,
      chat,
      ...(files.length ? { files } : {}),
      eventId: this.log.lastId(),
      ...(readExternalContent(recent) ? { untrusted: true } : {}),
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
  private async retrieveBrief(events: LoomEvent[], agentId: string): Promise<string> {
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
    const brief = await this.brainBriefFor({
      ...(query.trim() ? { query } : {}),
      ...(files.length ? { files } : {}),
      agent: agentId,
      minConfidence: CONFIDENCE_FLOOR,
      limit: 14,
    });
    const team = files.length ? (this.teamBrain?.context(files) ?? "") : "";
    return [brief, team].filter(Boolean).join("\n\n");
  }

  /**
   * The memory brief for a query. Solo: this project's brain. Shared with a
   * team: canon, confirmed, own and teammates' proposals ranked together, each
   * line labelled with how sure to be (Loom Teams D42).
   */
  private brainBrief(opts: RetrieveOpts): string {
    const pool = this.teamBrain?.pool(this.brain.all());
    if (!pool) return compileBrief(retrieve(this.brain, opts).map((h) => h.memory));
    return compileTieredBrief(retrieveTiered(pool, opts));
  }

  /**
   * The same brief, with the dense channel when this project has one.
   *
   * Embedding is real work (a millisecond, warm) and retrieval is sync, so the
   * vectors are computed here and handed in. Everything about this is
   * best-effort: no model, no network, a slow first load — the brief is the
   * one the three lexical channels produce, which is the brief Loom has always
   * produced.
   */
  private async brainBriefFor(opts: RetrieveOpts): Promise<string> {
    const dense = await this.denseFor(opts.query ?? "");
    return this.brainBrief(dense ? { ...opts, dense } : opts);
  }

  /**
   * Retrieval exactly as a briefing sees it — including the dense channel.
   *
   * The Brain tab and `loom brain:search` use this: a search that scored
   * differently from the briefing it's meant to explain would be worse than
   * no search at all.
   */
  async searchBrain(opts: RetrieveOpts): Promise<Hit[]> {
    const dense = await this.denseFor(opts.query ?? "");
    return retrieve(this.brain, dense ? { ...opts, dense } : opts);
  }

  /** Vectors for one query, or null when the channel isn't available. */
  private async denseFor(query: string): Promise<RetrieveOpts["dense"] | null> {
    if (!this.semantic || !query.trim()) return null;
    try {
      const memories = this.brain.all();
      await this.semantic.sync(memories);
      const q = await this.semantic.query(query);
      if (!q) return null;
      const byId = this.semantic.byId(memories);
      return byId.size ? { query: q, byId } : null;
    } catch (err) {
      logbook.warn("brain", "the dense channel didn't answer", String(err), this.info.id);
      return null;
    }
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
    // The turn's diff is started before routing hears the turn ended: a step
    // condition reads those numbers, and a route that advanced first would
    // read the turn before this one.
    if (event.kind === "run_complete" && event.agentId) {
      this.captureTurnDiff(event.agentId);
      void this.captureAgentDecisions(event.agentId).catch(() => {});
    }
    this.routes.handleAgentEvent(event);
    // Accumulate the turn's prose so decisions can be mined when it completes.
    if (event.kind === "message" && event.agentId && !event.payload.reasoning) {
      const prev = this.turnText.get(event.agentId) ?? "";
      this.turnText.set(event.agentId, `${prev}\n${String(event.payload.text ?? "")}`.slice(-8000));
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

  // ── the prompt queue (core/prompt-queue.ts) ──

  /**
   * A proxy in front of one server, so its page can talk to the app.
   *
   * One per server, reused while it points at the same place — restarting a
   * dev server on the same port keeps the preview URL stable, which matters
   * because the iframe is pointed at it.
   */
  async previewProxy(name: string, target: string): Promise<PreviewProxy> {
    const live = this.proxies.get(name);
    if (live && live.target === target) return live;
    if (live) await live.close().catch(() => {});
    const proxy = await startPreviewProxy(target);
    this.proxies.set(name, proxy);
    return proxy;
  }

  /** Live server state and output, for the socket. Returns unsubscribe. */
  onServerEvent(cb: (f: ServerFrame) => void): () => void {
    this.serverListeners.add(cb);
    return () => this.serverListeners.delete(cb);
  }

  /** Live queue changes, for the socket. Returns unsubscribe. */
  onQueueChange(cb: (q: QueueState) => void): () => void {
    this.queueListeners.add(cb);
    return () => this.queueListeners.delete(cb);
  }

  /** Line a prompt up; it goes as soon as nothing ahead of it is in the way. */
  enqueue(input: QueueInput): QueueItem {
    const t = input.target ?? { kind: "auto" as const };
    if (t.kind === "agent") this.mustTakeTurns(t.agentId);
    const item = this.queue.add(input);
    this.kickQueue();
    return item;
  }

  /** Change a waiting prompt. A target this project can't run is refused now,
   * not when the queue reaches it and has to stop. */
  editQueued(itemId: string, patch: { text?: string; target?: QueueTarget; plan?: boolean }): QueueItem {
    if (patch.target?.kind === "agent") this.mustTakeTurns(patch.target.agentId);
    const item = this.queue.edit(itemId, patch);
    this.kickQueue();
    return item;
  }

  /** An agent in this project that can hold the baton, or the reason it can't. */
  private mustTakeTurns(agentId: string): void {
    const agent = this.agents.get(agentId);
    if (!agent) throw new Error(`no agent "${agentId}" in this project`);
    if (!isAdapter(agent)) throw new Error(`agent "${agentId}" is a bridge (read-only) — it cannot take turns`);
  }

  /** Why the head can't go yet, or null when it can. */
  queueBlocker(item: QueueItem): string | null {
    // A condition comes first: a prompt held for 3am isn't waiting on an agent.
    const held = item.when ? this.conditionUnmet(item.when) : null;
    if (held) return held;
    const route = this.routeState();
    const routing = route && (route.status === "running" || route.status === "waiting_human");
    const holder = this.validHolder();
    if (item.target.kind === "orchestra") {
      const running = this.orchestra.runningScopes();
      if (!running.length) return null;
      const allowed = Math.max(1, this.config.maxConcurrentGoals ?? 1);
      // With lanes on, a queued goal that can't collide with what's running
      // starts beside it; the rest wait, with the overlap named.
      return blockedBy({ runId: "queued", goal: item.text, paths: [] }, running, allowed)
        ?? null;
    }
    if (routing) return "waiting for the running route";
    if (item.target.kind === "agent" && this.busySince.has(item.target.agentId)) return `waiting for ${item.target.agentId} to finish its turn`;
    if (holder && this.busySince.has(holder)) return `waiting for ${holder} to finish its turn`;
    return null;
  }

  /**
   * Is a queued prompt's condition still unmet? The reason, or null to go.
   *
   * Every branch reads a fact the daemon already has — the clock, a goal's
   * landing state, its checks — so nothing here can be wrong in an interesting
   * way. A condition about a goal that no longer exists releases the prompt
   * rather than holding it for ever.
   */
  private conditionUnmet(when: QueueCondition): string | null {
    if (when.kind === "at") {
      return Date.now() >= when.at ? null : describeCondition(when);
    }
    if (when.kind === "quiet") {
      const busy = this.busySince.size > 0 || Boolean(this.orchestra.active());
      if (busy) {
        this.quietSince = 0;
        return describeCondition(when);
      }
      if (!this.quietSince) this.quietSince = Date.now();
      return Date.now() - this.quietSince >= when.ms ? null : describeCondition(when);
    }
    const run = this.orchestra.get(when.runId);
    if (!run) return null; // the goal is gone: holding for it for ever helps nobody
    if (when.kind === "landed") {
      return run.landing?.state === "merged" ? null : describeCondition(when);
    }
    const checks = run.landing?.checks;
    const green = Boolean(checks && !checks.failing.length && !checks.pending.length && checks.passing > 0);
    return green ? null : describeCondition(when);
  }

  /** When the project last went quiet, for a "after N quiet minutes" condition. */
  private quietSince = 0;
  private clockTimer: ReturnType<typeof setInterval> | null = null;

  /**
   * A prompt held for an hour needs something to notice the hour arriving.
   *
   * Only ticks while such a prompt exists — the queue's other conditions are
   * woken by the events they wait on (a goal landing, checks going green), and
   * a timer that runs when nothing needs it is a battery someone else pays for.
   */
  private watchClockConditions(q: QueueState): void {
    const needsClock = q.items.some((i) => i.when && (i.when.kind === "at" || i.when.kind === "quiet"));
    if (needsClock && !this.clockTimer) {
      this.clockTimer = setInterval(() => this.kickQueue(), CLOCK_TICK_MS);
      this.clockTimer.unref?.();
    } else if (!needsClock && this.clockTimer) {
      clearInterval(this.clockTimer);
      this.clockTimer = null;
    }
  }

  /**
   * Hold the queue because `agentId` asked the human something — but only when
   * the queue is actually pointed at that agent. An orchestra worker's question
   * is the orchestrator's to answer (see core/orchestra.ts) and shouldn't
   * freeze a queue lined up for someone else.
   */
  private holdQueueFor(agentId: string): void {
    const head = this.queue.peek();
    if (!head || this.queue.paused) return;
    const mine = head.target.kind === "agent" ? head.target.agentId === agentId : head.target.kind === "auto";
    if (!mine) return;
    this.queue.setPaused(true, questionHold(agentId));
  }

  /**
   * You answered, so the hold is over.
   *
   * Only a hold this agent's own question put there: a queue you paused
   * yourself stays paused, and so does one stopped mid-turn. Without this, the
   * next thing you typed while the agent worked would queue behind the held
   * prompt and sit there, in a queue nothing was going to resume.
   */
  private releaseQuestionHold(agentId: string): void {
    if (!this.queue.paused || this.queue.snapshot().reason !== questionHold(agentId)) return;
    this.queue.setPaused(false);
  }

  private kickQueue(): void {
    if (this.closed || this.draining || this.queue.paused || !this.queue.length) return;
    queueMicrotask(() => void this.drainPromptQueue());
  }

  /** Send the head of the queue if it may go; then look again. */
  async drainPromptQueue(): Promise<void> {
    if (this.closed || this.draining || this.queue.paused) return;
    const head = this.queue.peek();
    if (!head || this.queueBlocker(head)) return;
    this.draining = true;
    // Out of the queue, then sent: what you can still see is what hasn't gone.
    // (Leaving it in place until the send returns would survive a crash
    // mid-dispatch, at the price of a prompt you can edit or remove after it
    // has already reached the agent — a worse thing to be wrong about.)
    const item = this.queue.shift()!;
    try {
      await this.dispatchQueued(item);
    } catch (err) {
      // refused (budget, quarantine, policy, a missing agent): keep it where it
      // was and stop, so you can edit it or send it elsewhere — never drop it
      const message = err instanceof Error ? err.message : String(err);
      if (!this.closed) {
        this.queue.unshift(item);
        this.queue.setPaused(true, `the next prompt wasn't sent: ${message}`);
        this.appendIfOpen({ kind: "error", chat: item.chat, payload: { message: `queued prompt not sent: ${message}` } });
      }
    } finally {
      this.draining = false;
    }
    this.kickQueue();
  }

  private async dispatchQueued(item: QueueItem): Promise<void> {
    const t = item.target;
    if (t.kind === "orchestra") {
      await this.orchestra.start({
        goal: item.text,
        ...(t.orchestrator ? { orchestrator: t.orchestrator } : {}),
        ...(t.workers?.length ? { workers: t.workers } : {}),
        ...(t.maxParallel ? { maxParallel: t.maxParallel } : {}),
        ...(t.maxUsd ? { maxUsd: t.maxUsd } : {}),
        ...(item.plan ? { plan: true } : {}),
      });
      return;
    }
    if (t.kind === "auto" && !item.plan) {
      await this.startRoute({ task: item.text, spec: "auto" });
      return;
    }
    // one agent: the baton moves to it first, as when you pick it and send
    const to = t.kind === "agent" ? t.agentId : undefined;
    const holder = this.validHolder();
    if (to && holder && holder !== to) await this.handoff(to, { source: item.source });
    await this.sendMessage(item.text, to, { source: item.source, chat: item.chat, fromQueue: true, ...(item.plan ? { plan: true } : {}) });
  }

  async sendMessage(
    text: string,
    agentId?: string,
    opts: { source?: "user" | "route"; chat?: string; plan?: boolean; fromQueue?: boolean } = {},
  ): Promise<{ agentId: string; queued?: number; queueId?: string }> {
    const source = opts.source ?? "user";
    const chat = opts.chat ?? MAIN_CHAT;
    // A thread that named an agent answers with that agent, whoever holds the
    // baton — which is what lets two threads talk to two agents at once. An
    // explicit target still wins: you asked for that one.
    const bound = this.chatBinding(chat);
    let target = agentId ?? bound.agentId ?? this.validHolder() ?? this.defaultAdapterId();
    const agent = this.agent(target);
    if (!isAdapter(agent)) {
      throw new Error(`agent "${target}" is a bridge (read-only) — it cannot take turns`);
    }
    // Before anything is committed — the baton, the message in the thread, the
    // process — check the agent can afford the turn. Refusing after the message
    // is logged would leave a prompt in the conversation that nothing answers.
    this.enforceQuarantine(target);
    this.enforceBudget(target);
    const kind = this.config.agents.find((a) => a.id === target)?.kind ?? "";
    if (this.teamPolicy && !agentAllowed(this.teamPolicy, kind)) {
      throw new Error(`team policy doesn't allow ${kind} on this repo (loom.team.json)`);
    }

    // The baton is the write lock for work that touches the repository. A
    // thread pinned to an agent doesn't need it to answer a question, and
    // taking it would stop the agent that IS working — so a pinned thread
    // leaves it alone, and the thread that isn't pinned behaves as it always
    // has.
    const pinned = !agentId && bound.agentId === target;
    if (!pinned) {
      const holder = this.validHolder();
      if (holder === null) {
        this.baton.acquire(target);
      } else if (holder !== target) {
        throw new NotHolderError(target, holder);
      }
    }

    // The agent is mid-turn: queue the prompt, in order, and run it when the
    // turn ends. It used to go straight to the adapter, which threw "busy" into
    // an error event — the prompt was lost while the send had said 200.
    // Answering while the agent is still busy is still answering.
    if (source === "user") this.releaseQuestionHold(target);
    // It shows in the queue, editable, and enters the thread when it's sent.
    if (!opts.fromQueue && this.busySince.has(target)) {
      const item = this.queue.add({ text, target: { kind: "agent", agentId: target }, chat, source, ...(opts.plan ? { plan: true } : {}) });
      return { agentId: target, queued: this.queue.length, queueId: item.id };
    }

    // A user reply to a paused route's question resumes the route — and to an
    // agent's own question, the queue it was holding.
    if (source === "user") {
      this.routes.onUserMessage(target);
      this.releaseQuestionHold(target);
    }

    // everything this turn produces belongs to the chat you sent from
    this.turnChat.set(target, chat);
    this.busySince.set(target, Date.now()); // the stale-session clock starts
    this.log.append({
      kind: "message",
      chat,
      payload: { text, author: source === "route" ? "loom" : "user", ...(opts.fromQueue ? { fromQueue: true } : {}) },
    });
    await this.ensureStarted(target);

    const pendingBriefing = this.consumePendingBriefing(target);
    // Prepend the enabled skills so every turn carries them, alongside any
    // one-shot handoff briefing. Empty when no skills are on.
    const briefing =
      [this.activeSkillsBlock(), pendingBriefing, opts.plan ? planModeBriefing(text) : ""]
        .filter(Boolean)
        .join("\n")
        .trim() || undefined;
    // The project's configured MCP servers, rendered to a temp config file the
    // adapter hands to its CLI. Null when nothing is configured — or when this
    // adapter's CLI has no flag for it, because an "MCP attached" note on a
    // turn that dropped the config would be the same lie in a new place.
    const mcp = agent.capabilities.mcp ? writeMcpSession(this.healthyMcps()) : null;
    // The thread's model, only ever to an adapter that can act on it — see
    // bindable(), which is where a model that couldn't be honoured is refused.
    const perTurnModel = bound.agentId === target ? bound.model : undefined;
    const input: SendInput = {
      text,
      ...(briefing ? { briefing } : {}),
      ...(perTurnModel ? { model: perTurnModel } : {}),
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
    // A child's briefing is deliberately narrow; a 100KB "task" is the parent
    // smuggling its whole context through the one field that was scoped.
    if (task.length > 10_000) {
      throw new Error("a subtask brief tops out at 10k chars — hand files, not transcripts");
    }

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
    const brief = this.brainBrief({ query: task, agent: childId, limit: 6 });
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

  /**
   * Carry the outgoing agent's branch into the incoming agent's worktree.
   *
   * Only with both `worktreePerAgent` and `mergeOnHandoff` on, only when the
   * two really are separate checkouts, and never when it would have to guess:
   * see core/worktree-merge.ts for what it refuses. The outcome is a value so
   * the handoff event and the briefing can both say what happened.
   */
  private async mergeForHandoff(from: string, to: string): Promise<MergeOutcome | null> {
    if (!this.config.git?.worktreePerAgent || !this.config.git?.mergeOnHandoff) return null;
    const into = this.agentDir(to);
    const source = this.agentDir(from);
    if (into === this.info.dir || source === into) return null;
    try {
      return await mergeAgentWork({
        into,
        branch: `agent/${from}`,
        sourceDir: source,
        message: `Loom: ${from} → ${to}`,
      });
    } catch (err) {
      // A merge that can't run must not take the handoff down with it.
      logbook.warn("git", `merge on handoff ${from} → ${to} failed`, String(err), this.info.id);
      return null;
    }
  }

  async handoff(
    to: string,
    opts: { source?: "user" | "route" } = {},
  ): Promise<{ from: string | null; merge?: MergeOutcome }> {
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
    let merge: MergeOutcome | null = null;
    if (holder && holder !== to) {
      const current = this.agent(holder);
      if (isAdapter(current)) {
        if (current.busy()) await current.interrupt();
        const diff = await current.diff().catch(() => "");
        if (diff) handoffMeta = { ...handoffMeta, dirty: true, diff: diff.slice(0, 2000) };
      }
      // After the outgoing agent has stopped (its last commit is in), before
      // the briefing is written — so the briefing can carry the result.
      merge = await this.mergeForHandoff(holder, to);
      if (merge) handoffMeta = { ...handoffMeta, merge };
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
    const brainBrief = await this.retrieveBrief(events, to);
    // Append the unified cross-ADE memory so the incoming agent sees the
    // whole brain, not just this project's log.
    const unified = this.unifiedMemory();
    const parts = [rendered.content];
    if (brainBrief) parts.push(brainBrief);
    if (unified.sources.length > 0) parts.push(unified.document);
    const enriched = parts.join("\n\n---\n");
    await target.injectMemory(enriched);
    writeMemoryFile(this.info.dir, to, enriched); // idempotent with default impl
    // The memory file above is only read by CLIs that look for it; most don't
    // (codex, opencode, grok and agy never did), so the one briefing every
    // adapter actually receives — prepended to its next turn — carries the
    // retrieved brain brief too. Without it, a handoff to codex arrived with
    // the conversation but none of what the project (or team) had learned.
    // The merge goes at the TOP of the briefing when it conflicted: an agent
    // that starts editing a tree full of conflict markers makes it worse.
    const mergeNote = merge ? describeMerge(merge, holder ?? "the previous agent", to) : "";
    this.pendingBriefings.set(
      to,
      [mergeNote, buildBriefing(input), brainBrief].filter(Boolean).join("\n\n"),
    );
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
      const bridgeBrief = await this.retrieveBrief(events, cfg.id);
      const bridgeView = bridgeBrief
        ? `${buildProjection({ ...input, targetAgentId: cfg.id })}\n\n---\n${bridgeBrief}`
        : buildProjection({ ...input, targetAgentId: cfg.id });
      await bystander.injectMemory(bridgeView).catch(() => {});
    }

    const { from } = this.baton.handoff(to, handoffMeta);
    await this.ensureStarted(to);
    return { from, ...(merge ? { merge } : {}) };
  }

  async interrupt(
    opts: { source?: "user" | "route" } = {},
  ): Promise<{ interrupted: string | null }> {
    if ((opts.source ?? "user") === "user") this.routes.onManualInterrupt();
    const holder = this.validHolder();
    if (!holder) return { interrupted: null };
    const agent = this.agent(holder);
    // Stop means stop: what's queued doesn't start after it — it waits,
    // paused, for you to resume, edit or clear it.
    if ((opts.source ?? "user") === "user" && this.queue.length && !this.queue.paused) {
      this.queue.setPaused(true, "you pressed Stop — resume to run what's queued");
      this.log.append({ kind: "status", agentId: holder, payload: { state: "queue_paused", waiting: this.queue.length } });
    }
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
  /**
   * Opt-in: checkpoint before a route starts.
   *
   * A route is exactly the moment you let a fleet loose — several agents,
   * several turns, no human between hops. With safety.snapshotBeforeRoutes on,
   * the brain+board+config land in .loom/snapshots/pre-route-<ts>.json first,
   * so `loom restore` has a "before" without anyone having remembered to take
   * one. Bounded: the newest five are kept, older ones pruned — a safety net,
   * not an archive.
   */
  private snapshotBeforeRoute(): void {
    if (!this.config.safety?.snapshotBeforeRoutes) return;
    try {
      const dir = path.join(projectLoomDir(this.info.dir), "snapshots");
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `pre-route-${Date.now()}.json`);
      fs.writeFileSync(file, JSON.stringify(this.snapshot(), null, 2) + "\n");
      const old = fs
        .readdirSync(dir)
        .filter((f) => f.startsWith("pre-route-"))
        .sort()
        .slice(0, -5);
      for (const f of old) fs.rmSync(path.join(dir, f), { force: true });
      logbook.info("routes", `snapshot taken before the route — ${path.basename(file)}`, undefined, this.info.id);
    } catch (err) {
      // A safety net that blocks the route it protects is worse than none.
      logbook.warn("routes", "pre-route snapshot failed", String(err), this.info.id);
    }
  }

  async startRoute(opts: {
    task: string;
    spec?: string | RouteStepSpec[];
    router?: RouterKind;
    maxHops?: number;
  }): Promise<RouteState> {
    this.snapshotBeforeRoute();
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
            permissions: permissionFor(cfg.kind, cfg.options),
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
          permissions: permissionFor(cfg.kind, cfg.options),
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
      orchestra: this.orchestraSummary(),
    };
  }

  /**
   * What every agent in this project is doing right now — for the fleet view.
   *
   * One row per roster agent (its thread, whether it's mid-turn, its last
   * step) and one per orchestra task (worker sessions don't live in the
   * roster). "Last step" is the newest event from that agent in that thread,
   * summarised to a line: the tool it ran, the file it touched, what it said.
   */
  activity(): Record<string, unknown> {
    const recent = this.log.list({ limit: 400 });
    const chats = new Map(this.chats().map((c) => [c.id, c.title]));
    const lastOf = (agentId: string, chat?: string) => {
      for (let i = recent.length - 1; i >= 0; i--) {
        const e = recent[i]!;
        if (e.agentId !== agentId) continue;
        if (chat !== undefined && (e.chat ?? MAIN_CHAT) !== chat) continue;
        return { kind: e.kind, ts: e.ts, chat: e.chat ?? MAIN_CHAT, line: activityLine(e) };
      }
      return null;
    };
    const agents = this.config.agents.map((cfg) => {
      const live = this.agents.get(cfg.id);
      const chat = this.turnChat.get(cfg.id);
      const last = lastOf(cfg.id, chat);
      return {
        id: cfg.id,
        kind: cfg.kind,
        role: cfg.role,
        busy: Boolean(live && isAdapter(live) && live.busy()),
        since: this.busySince.get(cfg.id) ?? null,
        permissions: permissionFor(cfg.kind, cfg.options),
        holdsBaton: this.validHolder() === cfg.id,
        chat: chat ?? last?.chat ?? null,
        chatTitle: chats.get(chat ?? last?.chat ?? "") ?? null,
        last,
      };
    });
    const run = this.orchestra.active() ?? this.orchestra.list()[0];
    const orchestra = run
      ? {
          id: run.id,
          goal: run.goal,
          status: run.status,
          chat: run.chat,
          orchestrator: run.orchestrator.agent,
          tasks: run.tasks.map((t) => ({
            id: t.id,
            title: t.title,
            agent: t.agent,
            status: t.status,
            chat: t.chat,
            attempts: t.attempts,
            files: t.files?.length ?? 0,
            last: lastOf(t.agent, t.chat),
          })),
        }
      : null;
    return {
      project: { id: this.info.id, name: this.info.name },
      agents,
      orchestra,
      subtasks: this.liveSubtasks(),
      route: this.routes.state(),
    };
  }

  /** The team member running this daemon (set by Team Link), for commit trailers. */
  memberLogin: string | null = null;
  /** Loom Teams, Phase 2: this project's team coordinator (set by Team Link). */
  coordinator: OrchestraCoordinator | null = null;
  /** Loom Teams, Phase 3: this project's share of the team brain (set by Team Link). */
  teamBrain: TeamBrainHook | null = null;
  /** The effective loom.team.json while shared with a team (D37); null when solo. */
  teamPolicy: TeamPolicy | null = null;

  /**
   * An agent's options under the team policy (D38): its permission mode capped
   * at the ceiling. Plan mode can't be known when an agent is built, so
   * `bypassRequiresPlan` treats it as off — the stricter reading.
   */
  private policyOptions(cfg: AgentConfig): Record<string, unknown> {
    const opts = { ...(cfg.options ?? {}) };
    if (this.runnerMode) {
      // A runner is its own trust tier (D70): agents bypass inside the sandbox,
      // capped by the team's runners.permissions rather than the laptop ceiling.
      const wanted = opts.permissions ? permissionFor(cfg.kind, opts) : "bypass";
      const ceiling = this.teamPolicy?.runners.permissions ?? "bypass";
      const rank = { ask: 0, auto: 1, bypass: 2 } as const;
      opts.permissions = rank[wanted] > rank[ceiling] ? ceiling : wanted;
      return opts;
    }
    if (!this.teamPolicy) return opts;
    const wanted = permissionFor(cfg.kind, opts);
    const capped = cappedPermission(this.teamPolicy, wanted, false);
    if (capped !== wanted) opts.permissions = capped;
    return opts;
  }

  /** Phase 5: this project is a runner's workspace for one goal (D70). */
  runnerMode = false;

  /** Adapter kinds usable on this machine: the roster's plus installed CLIs. */
  usableKinds(): string[] {
    const roster = this.config.agents.filter((a) => a.enabled !== false && tierForKind(a.kind) === "adapter").map((a) => a.kind);
    return [...new Set([...roster, ...this.installedKinds])];
  }

  /**
   * One question to one agent, outside any thread: the Phase 4 review (D60).
   * Runs in `dir` (a throwaway directory, so a reviewer that forgets it's
   * read-only can't touch the project), returns everything it said, and
   * counts its cost like any turn.
   */
  async askAgent(kind: string, dir: string, text: string, opts: { timeoutMs?: number } = {}): Promise<string> {
    const cfg: AgentConfig = this.config.agents.find((a) => a.kind === kind) ?? { id: `${kind}-review`, kind, role: "reviewer" };
    const agent = createAgent({ ...cfg, id: `${cfg.id}-review`, options: { ...this.policyOptions(cfg), loomProject: this.info.id } }, dir);
    if (!isAdapter(agent)) throw new Error(`"${kind}" can't answer questions headless`);
    let said = "";
    const off = agent.onEvent((e) => {
      const p = e.payload as Record<string, unknown>;
      if (e.kind === "message" && !p.reasoning && p.role !== "user") said += `\n${String(p.text ?? "")}`;
      if (e.kind === "status" && p.state === "turn_cost") {
        this.trackCost({ id: -1, ts: Date.now(), kind: e.kind, agentId: agent.id, payload: p } as LoomEvent);
      }
    });
    const timeout = opts.timeoutMs ?? 15 * 60_000;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await agent.start();
      await Promise.race([
        agent.send({ text }),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(`${kind} didn't answer within ${Math.round(timeout / 60_000)} min`)), timeout);
        }),
      ]);
      return said.trim();
    } finally {
      if (timer) clearTimeout(timer);
      off();
      if (agent.busy()) await agent.interrupt().catch(() => {});
      await agent.stop().catch(() => {});
    }
  }

  /** Share this project with a team, or record an explicit opt-out (null). */
  setTeam(share: { teamId: string; repo: string } | null): void {
    this.config.team = share ? { teamId: share.teamId, repo: share.repo } : { optOut: true };
    this.saveConfig();
  }

  /** The chat an agent's current (or last) turn belongs to, if any. */
  chatOf(agentId: string): string | undefined {
    return this.turnChat.get(agentId);
  }

  /** The live (or latest) orchestra run, compact — for status payloads. */
  orchestraSummary(): Record<string, unknown> | null {
    const run = this.orchestra.active() ?? this.orchestra.list()[0];
    if (!run) return null;
    return {
      id: run.id,
      goal: run.goal,
      status: run.status,
      chat: run.chat,
      orchestrator: run.orchestrator.agent,
      tasks: run.tasks.length,
      done: run.tasks.filter((t) => t.status === "done").length,
      running: run.tasks.filter((t) => t.status === "running").length,
      /**
       * One row per task, small enough to ride on every status poll.
       *
       * `tasks` above is a count, which is all the tab dot needed. It left
       * every other surface unable to answer questions the daemon knows the
       * answer to: which agent owns this thread (a task thread used to claim
       * to be whoever held the baton), whether a thread is still running, and
       * where a task's work went.
       */
      threads: run.tasks.map((t) => ({
        id: t.id,
        title: t.title,
        chat: t.chat,
        agent: t.agent,
        kind: t.kind,
        status: t.status,
      })),
    };
  }

  async close(): Promise<void> {
    await this.orchestra.shutdown().catch(() => {});
    this.closed = true;
    if (this.mcpTimer) { clearInterval(this.mcpTimer); this.mcpTimer = null; }
    for (const id of this.startedAgents) {
      await this.agent(id).stop().catch(() => {});
    }
    this.startedAgents.clear();
    // A dev server outlives the daemon that started it unless we say otherwise,
    // and an orphan holding port 3000 is a bad thing to leave behind.
    if (this.clockTimer) { clearInterval(this.clockTimer); this.clockTimer = null; }
    await this.servers.closeAll().catch(() => {});
    for (const proxy of this.proxies.values()) await proxy.close().catch(() => {});
    this.proxies.clear();
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

/** One event, as one line of "what is it doing". */
export function activityLine(e: LoomEvent): string {
  const p = e.payload as Record<string, unknown>;
  const cut = (v: unknown, n = 120) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, n);
  switch (e.kind) {
    case "tool_call":
      return `${cut(p.tool ?? p.name, 40)} ${cut(p.command ?? p.input ?? p.summary ?? "", 90)}`.trim();
    case "file_edit":
      return `edited ${cut(p.path, 100)}`;
    case "message":
      return cut(p.text);
    case "needs_input":
      return `asks: ${cut(p.question)}`;
    case "approval":
      return p.phase === "requested" ? `wants approval for ${cut(p.tool, 60)}` : `approval ${cut(p.behavior, 10)}`;
    case "run_complete":
      return "finished its turn";
    case "error":
      return `error: ${cut(p.message)}`;
    default:
      return e.kind.replace(/_/g, " ");
  }
}

/**
 * Plan mode for an ordinary turn: think, don't touch — and leave the plan as a
 * markdown spec any agent can execute later (or an orchestra can run).
 */
export function planModeBriefing(prompt: string): string {
  const slug =
    prompt
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 40) || "plan";
  const day = new Date().toISOString().slice(0, 10);
  return [
    "[Loom · Plan mode] Do NOT change any code in this turn. Investigate the repository, then write a",
    `complete implementation plan to plans/${day}-${slug}.md (create the plans/ folder if needed). Structure:`,
    "front matter (title, status: proposed), then ## Goal, ## Context (relevant files by path and what they do),",
    "## Approach, ## Tasks — each task self-contained with its files, steps and acceptance criteria, written so",
    "a different coding agent could execute it with no other context — ## Risks, ## Verification (exact commands).",
    "Then reply with a short summary and the file's path.",
  ].join("\n");
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
