import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createAgent, isWithdrawnKind, knownAgentKinds, tierForKind } from "../adapters/index.js";
import { ModelAdapter } from "../adapters/model.js";
import { ADES, detectAdes } from "../core/ades.js";
import { BatonManager } from "../core/baton.js";
import { type Hit, type RetrieveOpts } from "../core/brain-index.js";
import { Brain } from "../core/brain.js";
import { claudeText } from "../core/claude-cli.js";
import { ConversationStore } from "../core/conversations.js";
import * as checkpoints from "../core/checkpoint.js";
import { renderProjection } from "../core/distill.js";
import { EventLog } from "../core/eventlog.js";
import { ensureBranch, addWorktree as gitAddWorktree, readOut, worktreePath } from "../core/git.js";
import { logbook } from "../core/logbook.js";
import { probeMcpServer, probeMcpServers, writeMcpSession } from "../core/mcp.js";
import { NativeUsage } from "./runtime/native-usage.js";
import { notify } from "../core/notify.js";
import { OrchestraEngine, type OrchestraCoordinator } from "../core/orchestra.js";
import { CrewEngine } from "../core/crew.js";
import { isPermissionMode, permissionFor, unsupportedReason, type PermissionMode } from "../core/permissions.js";
import { startPreviewProxy, type PreviewProxy } from "../core/preview-proxy.js";
import {
  PromptQueue,
  type QueueCondition,
  type QueueInput,
  type QueueItem,
  type QueueState,
  type QueueTarget
} from "../core/prompt-queue.js";
import {
  newId,
  projectLoomDir,
  readProjectConfig,
  readProjectState,
  writeMemoryFile,
  writeProjectConfig,
  writeProjectState,
  type BoardTask,
} from "../core/registry.js";
import { RouteEngine, resolveSteps } from "../core/routes.js";
import { SemanticIndex } from "../core/semantic.js";
import { Servers } from "../core/servers.js";
import {
  SkillInstallError,
  installSkillFromDir,
  installSkillFromGit,
  type SkillInstallResult,
} from "../core/skill-install.js";
import {
  buildSkillsBlock,
  discoverSkillRoots,
  loadSkills,
  type SkillCatalogEntry,
  type SkillManifest,
  type SkillRoot,
} from "../core/skills.js";
import { type TurnFacts } from "../core/step-conditions.js";
import { suggestHandoff } from "../core/suggestions.js";
import { cappedPermission, type TeamPolicy } from "../core/team-policy.js";
import { describeMerge, mergeAgentWork, type MergeOutcome } from "../core/worktree-merge.js";
import {
  workingTree,
  type WorkingTree
} from "../core/worktree.js";
import {
  decisionStats,
  extractDecisions,
  normalizeStoredDecision,
  type AgentDecision,
  type DecisionStats,
} from "../observability/decisions.js";
import { turnTraceId } from "../observability/index.js";
import type {
  AgentConfig,
  AnyAgent,
  ChatInfo,
  CostSummary,
  LoomEvent,
  McpServerConfig,
  ProjectConfig,
  ProjectInfo,
  ProjectStatus,
  RouteState, RouteStepSpec, RouterKind,
  SendInput,
  UnifiedMemory
} from "../types.js";
import { GIT_DELIVERIES, MAIN_CHAT, isAdapter, type GitDelivery } from "../types.js";
import { MAX_FANOUT, ServerFrame, TeamBrainHook, activityLine, configMtimeOf, withLoomAskTimeout } from './runtime-support.js';
import { RuntimeAccounting } from './runtime/accounting.js';
import { RuntimeAgents } from './runtime/agents.js';
import { RuntimeBriefings } from './runtime/briefings.js';
import { RuntimeQueue } from './runtime/queue.js';
import { RuntimeTurns, type TurnOptions, type TurnResult } from './runtime/turns.js';
import { ContinuityEngine } from "../core/continuity/engine.js";
import { ContinuityError } from "../core/continuity/contracts.js";
import { HarnessMonitor, isNativeKind } from "../core/continuity/capabilities.js";
import { ProviderAgent } from "../providers/agent.js";
import { LiveDeltaThrottle, type LiveFrame } from "../providers/live.js";
import { AdapterBase, type AgentCheck } from "../adapters/base.js";
import type { LiveText } from "../types.js";
export { BudgetExceededError, CLOCK_TICK_MS, LOOM_ASK_TIMEOUT_MESSAGE, LOOM_ASK_TIMEOUT_MS, LoomAskTimeoutError, QuarantinedError, type ServerFrame, type TeamBrainHook, activityLine, planModeBriefing, relativeToProject, withLoomAskTimeout } from './runtime-support.js';

/**
 * Priority and due date on a card: set when given, cleared by null, refused
 * in words when they don't make sense.
 */
function applyCardMeta(task: BoardTask, p: { priority?: string | null; due?: string | null }): void {
  if (p.priority !== undefined) {
    if (p.priority === null || p.priority === "") delete task.priority;
    else if (p.priority === "high" || p.priority === "medium" || p.priority === "low") task.priority = p.priority;
    else throw new Error("priority is high, medium or low");
  }
  if (p.due !== undefined) {
    if (p.due === null || p.due === "") delete task.due;
    else if (/^\d{4}-\d{2}-\d{2}$/.test(p.due) && !Number.isNaN(new Date(`${p.due}T00:00:00`).getTime())) task.due = p.due;
    else throw new Error("due is a date: YYYY-MM-DD");
  }
}

/** A model agent's sampling settings, for its status (empty for everything else). */
function sampling(cfg: AgentConfig): { sampling?: { temperature?: number; maxTokens?: number } } {
  if (cfg.kind !== "model") return {};
  const o = (cfg.options ?? {}) as { temperature?: unknown; maxTokens?: unknown };
  const out: { temperature?: number; maxTokens?: number } = {};
  if (typeof o.temperature === "number") out.temperature = o.temperature;
  if (typeof o.maxTokens === "number") out.maxTokens = o.maxTokens;
  return { sampling: out };
}

export class ProjectRuntime {
  private readonly accounting: RuntimeAccounting;
  private readonly briefings: RuntimeBriefings;
  private readonly queueCoordinator: RuntimeQueue;
  private readonly turns: RuntimeTurns;

  readonly info: ProjectInfo;
  readonly config: ProjectConfig;
  readonly log: EventLog;
  private readonly conversations: ConversationStore;
  readonly baton: BatonManager;
  readonly routes: RouteEngine;
  /** One orchestrator, many parallel workers — see core/orchestra.ts. */
  readonly orchestra: OrchestraEngine;
  /** Agent Teams: crews of agents with roles, one goal at a time (core/crew.ts). */
  readonly crews: CrewEngine;
  /** Adapter kinds installed on this machine, probed once at open. */
  private installedKinds: string[] = [];
  /** Memory as units — see core/brain.ts. Reads and writes through `log`. */
  readonly brain: Brain;
  continuity: ContinuityEngine | null = null;
  /** Native harness reachability, polled while native continuity is on. */
  readonly harnesses: HarnessMonitor;
  /** Latest context and usage-limit readings from native harnesses. */
  readonly nativeUsage = new NativeUsage();
  private readonly agentLifecycle = new RuntimeAgents();
  private get agents(): ReadonlyMap<string, AnyAgent> { return this.agentLifecycle.agents; }
  private configMtime = 0;
  private journalFailure: Error | null = null;
  /** What you've lined up, run one at a time — see core/prompt-queue.ts. */
  readonly queue: PromptQueue;
  /** This project's dev servers — see core/servers.ts. */
  readonly servers: Servers;
  /** One preview proxy per server — see core/preview-proxy.ts. */
  private proxies = new Map<string, PreviewProxy>();
  private serverListeners = new Set<(f: ServerFrame) => void>();
  private streamListeners = new Set<(f: LiveText) => void>();
  private liveListeners = new Set<(d: LiveFrame) => void>();
  /** Streamed text and tool progress from provider agents, coalesced for clients. Not persisted. */
  private readonly live = new LiveDeltaThrottle((d) => { for (const cb of this.liveListeners) cb(d); });

  private constructor(info: ProjectInfo, config: ProjectConfig, log: EventLog) {
    this.info = info;
    this.config = config;
    this.log = log;
    if (config.brain?.continuity === true) this.continuity = new ContinuityEngine(log, info.id);
    this.harnesses = new HarnessMonitor(
      () => this.config.agents.filter(a => a.enabled !== false && isNativeKind(a.kind)).map(a => ({ id: a.id, kind: a.kind, options: this.policyOptions(a) })),
      (id, next, previous) => {
        if (!next.available) logbook.warn("harness", `${id} CLI is not reachable — native turns are refused until it answers`, next.error, info.id);
        else if (previous && !previous.available) logbook.info("harness", `${id} CLI is reachable again (${next.version ?? "unknown version"})`, undefined, info.id);
      },
    );
    if (this.continuity) this.harnesses.start();
    // The last readings survive a restart: replay the recent reports.
    for (const e of log.list({ kinds: ["status", "run_complete", "error"], limit: 500 })) this.nativeUsage.observe(e);
    this.conversations = new ConversationStore(info.dir);
    const runtime = this;
    this.accounting = new RuntimeAccounting({
      get log() { return runtime.log; },
      appendIfOpen: (...args) => this.appendIfOpen(...args),
      get info() { return runtime.info; },
    });
    this.briefings = new RuntimeBriefings({
      get info() { return runtime.info; },
      get config() { return runtime.config; },
      get log() { return runtime.log; },
      get teamBrain() { return runtime.teamBrain; },
      get brain() { return runtime.brain; },
      activeSkillsBlock: (...args) => this.activeSkillsBlock(...args),
      get turnChat() { return runtime.turns.turnChat; },
      extractionEngine: (model) => (prompt) => claudeText(`${prompt.system}\n\n${prompt.user}`, { model, timeoutMs: 60_000 }),
      renderProjection: (input) => renderProjection(input, this.config.projection),
      createSemanticIndex: () => new SemanticIndex(path.join(this.info.dir, ".loom")),
      noteMemoriesUsed: (ids) => this.noteMemoriesUsed(ids),
    });
    this.queueCoordinator = new RuntimeQueue({
      get queue() { return runtime.queue; },
      get agents() { return runtime.agents; },
      routeState: (...args) => this.routeState(...args),
      validHolder: (...args) => this.validHolder(...args),
      get orchestra() { return runtime.orchestra; },
      get config() { return runtime.config; },
      get busySince() { return runtime.turns.busySince; },
      get closed() { return runtime.closed; },
      appendIfOpen: (...args) => this.appendIfOpen(...args),
      startRoute: (...args) => this.startRoute(...args),
      handoff: (...args) => this.handoff(...args),
      sendMessage: (...args) => this.sendMessage(...args),
    });
    this.turns = new RuntimeTurns({
      get continuity() { return runtime.continuity; },
      harness: (id) => this.harnesses.ensure(id),
      kickQueue: () => this.kickQueue(),
      nativeOptions: (id) => this.policyOptions(this.config.agents.find(a => a.id === id)!),
      chatExists: (chat) => this.chats().some(c => c.id === chat),
      staleTurnMs: ProjectRuntime.STALE_TURN_MS,
      get closed() { return runtime.closed; },
      agentDir: (...args) => this.agentDir(...args),
      get log() { return runtime.log; },
      get info() { return runtime.info; },
      extractMemory: (...args) => this.extractMemory(...args),
      get config() { return runtime.config; },
      chatBinding: (...args) => this.chatBinding(...args),
      validHolder: (...args) => this.validHolder(...args),
      defaultAdapterId: (...args) => this.defaultAdapterId(...args),
      agent: (...args) => this.agent(...args),
      enforceQuarantine: (...args) => {
        if (this.journalFailure) throw this.journalFailure;
        this.enforceQuarantine(...args);
      },
      enforceBudget: (...args) => this.enforceBudget(...args),
      get teamPolicy() { return runtime.teamPolicy; },
      get baton() { return runtime.baton; },
      releaseQuestionHold: (...args) => this.releaseQuestionHold(...args),
      openQuestion: (agentId) => this.openQuestions.get(agentId),
      answerQuestion: (...args) => this.answerQuestion(...args),
      get queue() { return runtime.queue; },
      get routes() { return runtime.routes; },
      ensureStarted: (...args) => this.ensureStarted(...args),
      isCurrentAgent: (agent) => !this.closed && this.agents.get(agent.id) === agent,
      dispatchFailed: (agent, chat, error) => {
        if (this.closed || this.agents.get(agent.id) !== agent) return;
        if (!this.continuity || !isAdapter(agent) || !agent.busy()) this.turns.busySince.delete(agent.id);
        const event = this.log.append({ kind: "error", agentId: agent.id, chat,
          payload: { message: error instanceof Error ? error.message : String(error) } });
        this.afterAgentEvent(event);
        this.kickQueue();
      },
      consumePendingBriefing: (...args) => this.consumePendingBriefing(...args),
      activeSkillsBlock: (...args) => this.activeSkillsBlock(...args),
      agentInstructions: (id) => this.agentInstructions(id),
      healthyMcps: (...args) => this.healthyMcps(...args),
      appendIfOpen: (...args) => this.appendIfOpen(...args),
      get agents() { return runtime.agents; },
      handoff: (...args) => this.handoff(...args),
      get pendingBriefings() { return runtime.briefings.pendingBriefings; },
    });

    // What each agent has typed since its last finished message, so a window
    // opened (or reloaded) mid-reply can show the reply so far, not just the
    // words that arrive after it. A finished message supersedes its typing;
    // a turn's end drops it.
    log.onEvent((e) => {
      const s = e.agentId ? this.liveSoFar.get(e.agentId) : undefined;
      if (!s || !e.agentId) return;
      const p = e.payload as { reasoning?: unknown; state?: unknown };
      if (e.kind === "message") {
        if (p.reasoning) s.think = "";
        else s.text = "";
      } else if (
        e.kind === "run_complete" || e.kind === "error" || e.kind === "needs_input" ||
        (e.kind === "status" && (p.state === "interrupted" || p.state === "stopped"))
      ) {
        this.liveSoFar.delete(e.agentId);
      }
    });
    this.baton = new BatonManager(info.dir, log);
    this.brain = new Brain(log);
    void this.briefings.configureSemantic(!this.continuity && config.brain?.semantic === true);

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
      costTotal: () => this.accounting.costs.totalUsd,
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
        if (this.continuity) throw new ContinuityError("unsupported", "parallel orchestra execution is outside sequential native continuity");
        const agent = createAgent({ ...cfg, options: { ...this.policyOptions(cfg), loomProject: info.id } }, dir);
        if (!isAdapter(agent)) throw new Error(`"${cfg.id}" is a bridge — it cannot run orchestra work`);
        return agent;
      },
      append: (e) => (this.closed ? ({ ...e, id: -1, ts: Date.now() } as LoomEvent) : this.log.append(e)),
      // A task thread is pinned to its worker, so the sidebar says who it is
      // and a reply there reaches that agent. A worker that can't be pinned
      // (none can't, today — but a roster can change mid-run) still gets its
      // thread, just unpinned.
      createChat: (title, opts) => {
        try {
          return this.createChat(title, opts?.agentId ? { agentId: opts.agentId } : {});
        } catch {
          return this.createChat(title);
        }
      },
      // Asked before a run is told to answer in a thread: an id from a client
      // is a claim about this machine, and Main is real without being stored.
      chatExists: (id) => this.chats().some((c) => c.id === id),
      briefingFor: async (query, agentId, files) =>
        [
          this.activeSkillsBlock(),
          await this.brainBriefFor({ query, agent: agentId, limit: 6 }),
          this.teamBrain?.context(files ?? []) ?? "",
        ]
          .filter(Boolean)
          .join("\n\n"),
      gate: (agentId) => {
        if (this.continuity) throw new ContinuityError("unsupported", "parallel orchestra execution is outside sequential native continuity");
        this.enforceQuarantine(agentId);
        this.enforceBudget(agentId);
      },
      observe: (event) => this.trackCost(event),
      stream: (f) => this.liveText(f),
      gitDelivery: () => this.config.git?.delivery ?? "none",
      goalBudgetUsd: () => this.config.budgets?.perGoalUsd ?? null,
      maxConcurrentGoals: () => this.config.maxConcurrentGoals ?? null,
      member: () => this.memberLogin,
      coordinator: () => this.coordinator,
    });

    this.crews = new CrewEngine({
      projectId: info.id,
      projectName: info.name,
      projectDir: info.dir,
      crews: () => this.config.crews ?? [],
      saveCrews: (crews) => {
        if (crews.length) this.config.crews = crews;
        else delete this.config.crews;
        this.saveConfig();
      },
      roster: () =>
        this.config.agents.filter(
          (a) => a.enabled !== false && tierForKind(a.kind) === "adapter" && !isWithdrawnKind(a.kind),
        ),
      makeAgent: (cfg, dir) => {
        if (this.continuity) throw new ContinuityError("unsupported", "crews run outside sequential native continuity for now");
        const agent = createAgent({ ...cfg, options: { ...this.policyOptions(cfg), loomProject: info.id } }, dir);
        if (!isAdapter(agent)) throw new Error(`"${cfg.id}" is a bridge — it can't be on a crew`);
        return agent;
      },
      append: (e) => (this.closed ? ({ ...e, id: -1, ts: Date.now() } as LoomEvent) : this.log.append(e)),
      createChat: (title, opts) => this.createChat(title, opts?.agentId ? { agentId: opts.agentId } : {}),
      chatExists: (id) => this.chats().some((c) => c.id === id),
      briefingFor: async (query, agentId) =>
        [this.activeSkillsBlock(), await this.brainBriefFor({ query, agent: agentId, limit: 6 }), this.teamBrain?.context([]) ?? ""]
          .filter(Boolean)
          .join("\n\n"),
      gate: (agentId) => {
        if (this.continuity) throw new ContinuityError("unsupported", "crews run outside sequential native continuity for now");
        this.enforceQuarantine(agentId);
        this.enforceBudget(agentId);
      },
      observe: (event) => this.trackCost(event),
      stream: (f) => this.liveText(f),
      createTask: (input) => this.createTask(input),
      updateTask: (id, patch) => this.updateTask(id, patch as Parameters<ProjectRuntime["updateTask"]>[1]),
      member: () => this.memberLogin,
    });

    this.queue = new PromptQueue(path.join(projectLoomDir(info.dir), "queue.json"), (q) => {
      for (const cb of this.queueCoordinator.queueListeners) cb(q);
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
    if (!config) {
      // Say which: a folder that's gone (moved, deleted, a temp dir a reboot
      // cleared) is a different fix from a folder that was never initialised.
      if (!fs.existsSync(info.dir)) throw new Error(`this project's folder is gone: ${info.dir} — it was moved or deleted`);
      throw new Error(`project at ${info.dir} has no .loom/config.json — run loom init`);
    }
    const log = await EventLog.open(projectLoomDir(info.dir));
    let rt: ProjectRuntime;
    try { rt = new ProjectRuntime(info, config, log); }
    catch (error) { log.close(); throw error; }
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
      .catch(() => { });
    // Worktree-per-agent: prepare each adapter's checkout and respawn it there.
    // Safe pre-start — agents are constructed lazily-started, so replacing the
    // instance before its first turn loses nothing.
    if (config.git?.worktreePerAgent) {
      for (const cfg of config.agents) {
        if (cfg.enabled === false) continue;
        const live = rt.agents.get(cfg.id);
        if (!live || live.capabilities.tier !== "adapter") continue;
        await rt.ensureAgentWorktree(cfg.id);
        await rt.agentLifecycle.retire(cfg.id);
        rt.spawnAgent(cfg);
      }
    }
    return rt;
  }
  private rehydrateCosts(): void { return this.accounting.rehydrateCosts(); }

  private trackCost(event: LoomEvent): void { return this.accounting.trackCost(event); }

  costSummary(): CostSummary { return this.accounting.costSummary(); }

  budgets(): Record<string, number> { return this.accounting.budgets(); }

  setBudget(agentId: string, usdPerDay: number): Record<string, number> { return this.accounting.setBudget(agentId, usdPerDay); }

  spendTodayFor(agentId: string, now = Date.now()): number { return this.accounting.spendTodayFor(agentId, now); }

  costSeries(days = 30, now = Date.now()): Array<{
    day: string;
    usd: number;
    turns: number;
    tokensIn: number;
    tokensOut: number;
    byAgent: Record<string, { usd: number; turns: number; tokensIn: number; tokensOut: number }>;
  }> { return this.accounting.costSeries(days, now); }

  budgetStatus(now = Date.now()): Record<string, { budgetUsd: number; spentTodayUsd: number; over: boolean }> { return this.accounting.budgetStatus(now); }

  private enforceQuarantine(agentId: string): void { return this.accounting.enforceQuarantine(agentId); }

  private enforceBudget(agentId: string, now = Date.now()): void { return this.accounting.enforceBudget(agentId, now); }

  private liftBudgetPause(agentId: string, now = Date.now()): void { return this.accounting.liftBudgetPause(agentId, now); }

  quarantined(): Record<string, { reason: string; since: number; displaced: boolean }> { return this.accounting.quarantined(); }

  quarantine(agentId: string, reason: string, displaced: boolean, now = Date.now()): void { return this.accounting.quarantine(agentId, reason, displaced, now); }

  unquarantine(agentId: string): { reason: string; since: number; displaced: boolean } | null { return this.accounting.unquarantine(agentId); }

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
  /** An agent's picture: a small PNG/JPEG/WebP data URL, or null to clear. */
  setAgentAvatar(agentId: string, dataUrl: string | null): { id: string; avatar: string | null } | null {
    const cfg = this.config.agents.find((a) => a.id === agentId);
    if (!cfg) return null;
    if (dataUrl === null || dataUrl === "") delete cfg.avatar;
    else {
      if (!/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(dataUrl)) throw new Error("a picture is a PNG, JPEG or WebP image");
      if (dataUrl.length > 120_000) throw new Error("that picture is too big — Loom keeps them small (about 96px)");
      cfg.avatar = dataUrl;
    }
    this.saveConfig();
    return { id: agentId, avatar: cfg.avatar ?? null };
  }

  /**
   * Ask an agent whether it's ready — installed, signed in, model listed —
   * without sending it a prompt (see AdapterBase.selfCheck).
   */
  async checkAgent(agentId: string): Promise<{ ok: boolean; ms: number; checks: AgentCheck[] } | null> {
    const cfg = this.config.agents.find((a) => a.id === agentId);
    if (!cfg) return null;
    const started = Date.now();
    if (cfg.enabled === false) return { ok: false, ms: 0, checks: [{ name: "switched on", ok: false, detail: "this agent is switched off in the roster" }] };
    const live = this.agents.get(agentId);
    let checks: AgentCheck[];
    if (live && live instanceof AdapterBase) checks = await live.selfCheck();
    else if (live) {
      const ok = await live.available();
      checks = [{ name: "available", ok, detail: ok ? "running" : "not available on this machine" }];
    } else checks = [{ name: "loaded", ok: false, detail: "Loom hasn't loaded this agent — is its CLI installed?" }];
    return { ok: checks.every((c) => c.ok), ms: Date.now() - started, checks };
  }

  /** Standing instructions for an agent; empty clears them. */
  setAgentInstructions(agentId: string, text: string): { id: string; instructions: string } | null {
    const cfg = this.config.agents.find((a) => a.id === agentId);
    if (!cfg) return null;
    const clean = text.trim().slice(0, 4000);
    if (clean) cfg.instructions = clean;
    else delete cfg.instructions;
    this.saveConfig();
    return { id: agentId, instructions: clean };
  }

  /** The block an agent's standing instructions ride in, ahead of its turn. */
  agentInstructions(agentId: string): string {
    const text = this.config.agents.find((a) => a.id === agentId)?.instructions?.trim();
    return text ? `Standing instructions for you in this project, from the person you work for:\n${text}\n` : "";
  }

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
    brain?: { extractor?: "auto" | "off"; model?: string; semantic?: boolean; continuity?: boolean };
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
    if (patch.git?.delivery !== undefined && !GIT_DELIVERIES.includes(patch.git.delivery as GitDelivery))
      throw new Error(`git.delivery must be one of ${GIT_DELIVERIES.join(", ")}`);
    const previousConfig = { ...this.config }, previousContinuity = this.continuity;
    const changingContinuity = typeof patch.brain?.continuity === "boolean" && patch.brain.continuity !== Boolean(this.config.brain?.continuity);
    try {
      if (patch.brain) {
        if (changingContinuity) {
          if (this.anyBusy() || this.continuity?.store.activeReceipts().length || this.queue.length)
            throw new ContinuityError("conflict", "finish or reconcile native turns before changing continuity mode; also clear queued prompts");
          if (patch.brain.continuity) { this.continuity = new ContinuityEngine(this.log, this.info.id); this.harnesses.start(); }
          else { this.continuity?.store.releaseOwner(); this.continuity = null; this.harnesses.stop(); }

        }
        const b = { ...(this.config.brain ?? {}) };
        if (typeof patch.brain.continuity === "boolean") b.continuity = patch.brain.continuity;
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
    } catch (error) {
      if (this.continuity !== previousContinuity) {
        this.continuity?.store.releaseOwner();
        this.continuity = previousContinuity;
        previousContinuity?.store.claimOwner();
        if (previousContinuity) this.harnesses.start(); else this.harnesses.stop();
      }
      for (const key of Object.keys(this.config)) delete (this.config as unknown as Record<string, unknown>)[key];
      Object.assign(this.config, previousConfig);
      throw error;
    }
    if (changingContinuity) {
      this.briefings.cancelExtraction(); this.turns.turnText.clear(); this.briefings.pendingBriefings.clear();
    }
    if (changingContinuity || typeof patch.brain?.semantic === "boolean")
      void this.briefings.configureSemantic(!this.continuity && this.config.brain?.semantic === true);
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
    brain: { extractor: "auto" | "off"; model: string; semantic: boolean; continuity: boolean };
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
        continuity: Boolean(this.config.brain?.continuity),
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
    // What this turn has typed since its last finished message. A turn that
    // is stopped (or dies) mid-reply never sends that message, and the words
    // you watched arrive would vanish — so they're kept, marked partial.
    // Provider agents keep their own buffers (see providers/ingestion.ts).
    let typed = "";
    const keepsPartial = !(agent instanceof ProviderAgent);
    agent.onStream?.((d) => {
      if (!d.reasoning) typed += d.text;
      this.liveText({ agentId: agent.id, chat: this.turns.turnChat.get(agent.id) ?? MAIN_CHAT, ...d });
    });
    this.agentLifecycle.install(agent, (e) => {
      try {
      const runId = typeof e.payload.loomRunId === "string" ? e.payload.loomRunId : undefined;
      const liveRun = runId ? this.continuity?.isLiveRun(runId) : true;
      const chat = (runId ? this.continuity?.eventChat(runId) : undefined) ?? this.turns.turnChat.get(agent.id);
      let payload = e.payload;
      // Enrich the completed turn so its gen_ai span carries system + model +
      // cost (adapters only put tokens on run_complete). The kind is known
      // here; the model prefers what the adapter actually used, else the
      // configured override; the cost is the turn_cost stashed a moment ago.
      const p = e.payload as Record<string, unknown>;
      if (liveRun && e.kind === "status" && p.state === "turn_cost") {
        const usd = Number(p.costUsd ?? 0);
        if (usd > 0) this.turns.pendingCost.set(agent.id, usd);
      } else if (liveRun && e.kind === "run_complete") {
        const model =
          (typeof p.model === "string" && p.model) ||
          (typeof cfg.options?.model === "string" ? cfg.options.model : undefined);
        const cost = this.turns.pendingCost.get(agent.id);
        this.turns.pendingCost.delete(agent.id);
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
      if (liveRun && e.kind === "needs_input") this.holdQueueFor(agent.id);
      // A question asked through the agent's tool blocks its turn until answered: remember it,
      // so a reply typed in the chat reaches it (turns.ts) and status stays honest.
      if (e.kind === "needs_input" && typeof p.requestId === "string" && p.responseMode !== "message") {
        const ids = Array.isArray(p.questions) ? (p.questions as Array<{ id?: unknown }>).map((q, i) => String(q.id ?? i)) : [];
        this.openQuestions.set(agent.id, { requestId: p.requestId, chat: chat ?? MAIN_CHAT, ids });
      }
      if (e.kind === "status" && p.state === "question_answered" && this.openQuestions.get(agent.id)?.requestId === p.requestId) {
        this.openQuestions.delete(agent.id);
      }
      // Any terminal event stops the stale-session clock — a turn that ended in
      // an error is over, not hung.
      const turnOver = e.kind === "run_complete" || e.kind === "error" || (e.kind === "status" && p.state === "interrupted");
      if (turnOver && !this.continuity) {
        this.turns.busySince.delete(agent.id);
      }
      if (turnOver) this.openQuestions.delete(agent.id);
      if (keepsPartial) {
        if (e.kind === "message" && !p.reasoning) typed = "";
        if (turnOver && typed.trim()) {
          this.log.append({ kind: "message", agentId: agent.id, ...(chat ? { chat } : {}), payload: { text: typed, partial: true } });
        }
        if (turnOver) typed = "";
      }
      const event = this.log.append({
        kind: e.kind,
        agentId: agent.id,
        ...(chat ? { chat } : {}),
        payload,
      });
      this.continuity?.ingest(event);
      this.nativeUsage.observe(event);
      if (liveRun) this.afterAgentEvent(event);
      if (liveRun && e.kind === "message" && p.proposedPlan === true) this.saveProposedPlan(agent.id, chat, String(p.text ?? ""));
      if (turnOver && !this.continuity) this.kickQueue();
      } catch {
        // A failed durable ingest is a project fault, not a disposable UI
        // observer. Stop foreground work and keep its receipt uncertain.
        this.journalFailure = new ContinuityError("recovery_required", "project journal ingest failed; native execution was interrupted; reopen and reconcile before continuing");
        if (isAdapter(agent) && agent.busy()) void agent.interrupt().catch(() => {});
      }
    });
    if (agent instanceof ProviderAgent) {
      agent.onLive((d) => {
        if (this.closed || this.agents.get(agent.id) !== agent) return;
        this.live.push(d);
        // The same text feeds the thread's live reply (the `stream` frames and
        // the reload-safe snapshot), as every other agent's does.
        if (d.streamKind === "assistant_text" || d.streamKind === "reasoning_text" || d.streamKind === "reasoning_summary_text") {
          this.liveText({ agentId: agent.id, chat: d.chat, text: d.delta, ...(d.streamKind === "assistant_text" ? {} : { reasoning: true }) });
        }
      });
      agent.onLiveItem((i) => { if (!this.closed && this.agents.get(agent.id) === agent) this.live.pushItem(i); });
    }
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
    if (live && isAdapter(live) && (live.busy() || this.turns.busySince.has(agentId))) {
      throw new Error(`"${agentId}" is mid-turn — interrupt it first`);
    }
    // Its events stay in the log: the history happened, and a roster change
    // doesn't unhappen it. Only the roster forgets.
    this.config.agents = this.config.agents.filter((a) => a.id !== agentId);
    this.saveConfig();
    if (live) {
      void this.agentLifecycle.retire(agentId);
    }
    return { removed: agentId };
  }

  /**
   * Point an agent at a different model.
   *
   * The model is read once, when the adapter is constructed (createAgent hands
   * it cfg.options), so changing it means building a fresh adapter instance.
   * Native resume data stays persisted; each adapter decides whether its harness
   * can reuse it. Refused while a turn is preparing or running, because swapping
   * the process out from under that turn would strand it.
   *
   * An empty model clears the override, so the CLI falls back to its own default
   * — the honest "Default" the picker offers.
   */
  setAgentModel(agentId: string, model: string, provider?: string): AgentConfig {
    const cfg = this.config.agents.find((a) => a.id === agentId);
    if (!cfg) throw new Error(`unknown agent "${agentId}"`);
    const live = this.agents.get(agentId);
    if (live && isAdapter(live) && (live.busy() || this.turns.busySince.has(agentId))) {
      throw new Error(`"${agentId}" is mid-turn — wait for it to finish, then switch models`);
    }
    // OpenRouter ids run long ("provider/family-size-variant:free"); 80 cut
    // real ones off mid-name.
    const next = model.trim().slice(0, 200);
    const options = { ...(cfg.options ?? {}) } as Record<string, unknown>;
    if (next) options.model = next;
    else delete options.model;
    // A model agent's pick names its provider too (the list spans them all).
    if (cfg.kind === "model" && provider?.trim()) options.provider = provider.trim().toLowerCase();
    cfg.options = options;

    // Rebuild so the new model actually takes: stop the old process, spawn a
    // replacement subscribed exactly as the constructor's loop does.
    if (live) {
      void this.agentLifecycle.retire(agentId);
    }
    this.spawnAgent(cfg);
    this.saveConfig();
    return cfg;
  }

  /**
   * A model agent's sampling: temperature (0–2) and the reply's token cap.
   * Null clears one back to the provider's default. Rebuilt like a model
   * switch, because the adapter reads them when it's built.
   */
  setAgentSampling(agentId: string, s: { temperature?: number | null; maxTokens?: number | null }): AgentConfig {
    const cfg = this.config.agents.find((a) => a.id === agentId);
    if (!cfg) throw new Error(`unknown agent "${agentId}"`);
    if (cfg.kind !== "model") throw new Error(`"${agentId}" is a ${cfg.kind} — sampling is set in its own CLI, not here`);
    const live = this.agents.get(agentId);
    if (live && isAdapter(live) && (live.busy() || this.turns.busySince.has(agentId))) throw new Error(`"${agentId}" is mid-turn — wait for it to finish`);
    const options = { ...(cfg.options ?? {}) } as Record<string, unknown>;
    if (s.temperature !== undefined) {
      if (s.temperature === null) delete options.temperature;
      else if (!Number.isFinite(s.temperature) || s.temperature < 0 || s.temperature > 2) throw new Error("temperature must be between 0 and 2");
      else options.temperature = Math.round(s.temperature * 100) / 100;
    }
    if (s.maxTokens !== undefined) {
      if (s.maxTokens === null) delete options.maxTokens;
      else if (!Number.isInteger(s.maxTokens) || s.maxTokens < 16 || s.maxTokens > 200_000) throw new Error("max tokens must be a whole number from 16 to 200000");
      else options.maxTokens = s.maxTokens;
    }
    cfg.options = options;
    if (live) void this.agentLifecycle.retire(agentId);
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
    if (live && isAdapter(live) && (live.busy() || this.turns.busySince.has(agentId))) {
      throw new Error(`"${agentId}" is mid-turn — wait for it to finish, then change its permissions`);
    }
    cfg.options = { ...(cfg.options ?? {}), permissions: mode };
    if (live) {
      void this.agentLifecycle.retire(agentId);
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
      if (live && isAdapter(live) && (live.busy() || this.turns.busySince.has(agentId))) {
        throw new Error(`"${agentId}" is mid-turn — interrupt it first`);
      }
    }
    cfg.enabled = on;
    this.saveConfig();
    const live = this.agents.get(agentId);
    if (on && !live) {
      this.spawnAgent(cfg); // bring it back to life
    } else if (!on && live) {
      void this.agentLifecycle.retire(agentId);
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
      void this.pollMcpHealth().catch(() => { });
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
    let last: Map<string, number>;
    try {
      last = this.log.lastReplyIds();
    } catch {
      last = new Map(); // an unread dot is a nicety; the list must still load
    }
    const main = stored.find((c) => c.id === MAIN_CHAT);
    return this.conversations.chats().map((c) => {
      // main is stored only once it has stars or ratings to keep
      const withMain = c.id === MAIN_CHAT && main
        ? { ...c, ...(main.starred ? { starred: main.starred } : {}), ...(main.ratings ? { ratings: main.ratings } : {}) }
        : c;
      return last.has(c.id) ? { ...withMain, lastReplyId: last.get(c.id)! } : withMain;
    });
  }

  /** Pin, archive or file a thread. Main is always first and always there. */
  setChatFlags(id: string, flags: { pinned?: boolean; archived?: boolean; folder?: string | null }): ChatInfo | null {
    if (id === MAIN_CHAT) return null;
    const state = readProjectState(this.info.dir);
    const chat = (state.chats ?? []).find((c) => c.id === id);
    if (!chat) return null;
    for (const k of ["pinned", "archived"] as const) {
      if (flags[k] === undefined) continue;
      if (flags[k]) chat[k] = true;
      else delete chat[k];
    }
    if (flags.folder !== undefined) {
      const name = String(flags.folder ?? "").replace(/\s+/g, " ").trim().slice(0, 40);
      if (name) chat.folder = name;
      else delete chat.folder;
    }
    writeProjectState(this.info.dir, state);
    return chat;
  }

  /** Rate a reply up or down (0 clears). Main included. */
  rateMessage(chatId: string, eventId: number, agent: string, v: number): Record<string, { v: 1 | -1; agent: string }> | null {
    if (!Number.isInteger(eventId) || eventId <= 0 || !agent) return null;
    const state = readProjectState(this.info.dir);
    state.chats = state.chats ?? [];
    let chat = state.chats.find((c) => c.id === chatId);
    if (!chat) {
      if (chatId !== MAIN_CHAT) return null;
      chat = { id: MAIN_CHAT, title: "Main", createdAt: 0 };
      state.chats.push(chat);
    }
    const ratings = { ...(chat.ratings ?? {}) };
    if (v === 1 || v === -1) ratings[String(eventId)] = { v, agent };
    else delete ratings[String(eventId)];
    const keys = Object.keys(ratings);
    for (const k of keys.slice(0, Math.max(0, keys.length - 500))) delete ratings[k]; // bounded
    if (Object.keys(ratings).length) chat.ratings = ratings;
    else delete chat.ratings;
    writeProjectState(this.info.dir, state);
    return chat.ratings ?? {};
  }

  /** Every rating in every thread, per agent: how many up, how many down. */
  ratingsByAgent(): Record<string, { up: number; down: number }> {
    const out: Record<string, { up: number; down: number }> = {};
    for (const c of readProjectState(this.info.dir).chats ?? []) {
      for (const r of Object.values(c.ratings ?? {})) {
        const a = (out[r.agent] ??= { up: 0, down: 0 });
        if (r.v === 1) a.up++;
        else a.down++;
      }
    }
    return out;
  }

  /** Star or unstar a message in a thread (main included). */
  starMessage(chatId: string, eventId: number, on: boolean): number[] | null {
    if (!Number.isInteger(eventId) || eventId <= 0) return null;
    const state = readProjectState(this.info.dir);
    state.chats = state.chats ?? [];
    let chat = state.chats.find((c) => c.id === chatId);
    if (!chat) {
      if (chatId !== MAIN_CHAT) return null;
      // Main isn't stored until it has something to remember
      chat = { id: MAIN_CHAT, title: "Main", createdAt: 0 };
      state.chats.push(chat);
    }
    const set = (chat.starred ?? []).filter((n) => n !== eventId);
    if (on) set.push(eventId);
    chat.starred = set.slice(-200);
    if (!chat.starred.length) delete chat.starred;
    writeProjectState(this.info.dir, state);
    return chat.starred ?? [];
  }

  createChat(title: string, opts: { agentId?: string; model?: string } = {}): ChatInfo {
    const bound = opts.agentId ? this.bindable(opts.agentId, opts.model) : {};
    return this.conversations.createChat(title, bound);
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
    const kind = this.config.agents.find((a) => a.id === agentId)?.kind;
    return kind === "model" || Boolean(this.continuity && kind && isNativeKind(kind));
  }

  /** Bind (or unbind) who answers in a thread. */
  setChatAgent(id: string, agentId: string | null, model?: string): ChatInfo | null {
    // Preserve Main's error before validating an optional target.
    if (id !== MAIN_CHAT && agentId) this.bindable(agentId, model);
    return this.conversations.setChatAgent(id, agentId, model);
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
      const offLive = agent.onStream((d) => this.liveText({ agentId, chat: chat.id, ...d }));
      const offLog = agent.onEvent((e) => {
        this.appendIfOpen({ ...e, agentId, chat: chat.id });
      });
      const off = () => {
        offLive();
        offLog();
      };
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

  renameChat(id: string, title: string): ChatInfo | null { return this.conversations.renameChat(id, title); }

  deleteChat(id: string): boolean {
    if (this.continuity && ([...this.turns.busySince.keys()].some(agent => this.turns.turnChat.get(agent) === id) ||
      this.queue.snapshot().items.some(item => item.chat === id)))
      throw new ContinuityError("conflict", "finish or remove queued/native turns before deleting their chat");
    return this.conversations.deleteChat(id);
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
    priority?: string | null;
    due?: string | null;
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
    applyCardMeta(task, input);
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
    patch: {
      title?: string; column?: string; agent?: string; blockedBy?: string[]; priority?: string | null; due?: string | null;
      crew?: string; goal?: string; stage?: string; claimedBy?: string;
    },
  ): BoardTask | null {
    const state = readProjectState(this.info.dir);
    const task = (state.tasks ?? []).find((t) => t.id === id);
    if (!task) return null;
    applyCardMeta(task, patch);
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
    for (const k of ["crew", "goal", "stage", "claimedBy"] as const) if (patch[k] !== undefined) task[k] = String(patch[k]).slice(0, 80);
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
    if (this.orchestra.active() || this.routes.isActive() || this.turns.busySince.size > 0) return true;
    return [...this.agents.values()].some((a) => isAdapter(a) && a.busy());
  }

  agent(id: string): AnyAgent {
    const agent = this.agents.get(id);
    if (!agent) throw new Error(`unknown agent "${id}" in project "${this.info.name}"`);
    return agent;
  }

  private async ensureStarted(agentId: string): Promise<AnyAgent> {
    this.agent(agentId); // preserve the public unknown-agent error
    return this.agentLifecycle.start(agentId);
  }

  checkpoints(): Promise<checkpoints.Checkpoint[]> { return this.turns.checkpoints(); }

  async rewind(id: string): Promise<checkpoints.RestoreResult> { return this.turns.rewind(id); }

  /** Put one file back as a checkpoint had it (see checkpoints.restoreFile). */
  async rewindFile(id: string, file: string): Promise<Awaited<ReturnType<typeof checkpoints.restoreFile>>> {
    const busy = [...this.turns.busySince.keys()];
    if (busy.length) {
      throw new Error(`${busy.join(", ")} ${busy.length === 1 ? "is" : "are"} mid-turn — stop the turn first, or the file changes underneath it`);
    }
    const out = await checkpoints.restoreFile(this.info.dir, id, file);
    this.log.append({
      kind: "checkpoint",
      payload: { id: out.restored.id, label: `${out.path} only`, at: Date.now(), reason: "rewound", files: 1, undo: out.undo.id, path: out.path },
    });
    return out;
  }

  async turnFacts(agentId: string): Promise<TurnFacts> { return this.turns.turnFacts(agentId); }

  private captureTurnDiff(agentId: string): void { return this.turns.captureTurnDiff(agentId); }

  private async commitTurn(agentId: string, files: string[]): Promise<void> { return this.turns.commitTurn(agentId, files); }

  private extractMemory(agentId: string, files: string[]): void {
    if (!this.continuity) this.briefings.extractMemory(agentId, files);
  }

  workingTree(): Promise<WorkingTree> {
    return workingTree(this.info.dir);
  }

  unifiedMemory(): UnifiedMemory { return this.briefings.unifiedMemory(); }

  private brainBrief(opts: RetrieveOpts): string { return this.briefings.brainBrief(opts); }

  // How often each memory made it into a prompt — the Brain tab's "most
  // used". Counted where briefs are compiled, so it's what agents actually
  // got, not what a search happened to return. Written at most every few
  // seconds; a lost count on a crash costs nothing.
  private memoryUse: Record<string, { n: number; at: number }> | null = null;
  private memoryUseTimer: NodeJS.Timeout | null = null;
  private memoryUseFile(): string {
    return path.join(this.info.dir, ".loom", "memory-usage.json");
  }
  memoryUsage(): Record<string, { n: number; at: number }> {
    if (!this.memoryUse) {
      try {
        this.memoryUse = JSON.parse(fs.readFileSync(this.memoryUseFile(), "utf8")) as Record<string, { n: number; at: number }>;
      } catch {
        this.memoryUse = {};
      }
    }
    return this.memoryUse;
  }
  private noteMemoriesUsed(ids: string[]): void {
    if (!ids.length) return;
    const use = this.memoryUsage();
    const now = Date.now();
    for (const id of new Set(ids)) use[id] = { n: (use[id]?.n ?? 0) + 1, at: now };
    if (this.memoryUseTimer) return;
    this.memoryUseTimer = setTimeout(() => {
      this.memoryUseTimer = null;
      try {
        fs.writeFileSync(this.memoryUseFile(), JSON.stringify(this.memoryUse));
      } catch {
        /* a count that didn't save is not worth a failed turn */
      }
    }, 3000);
    this.memoryUseTimer.unref?.();
  }

  private async brainBriefFor(opts: RetrieveOpts): Promise<string> { return this.briefings.brainBriefFor(opts); }

  async searchBrain(opts: RetrieveOpts): Promise<Hit[]> { return this.briefings.searchBrain(opts); }

  importMemories(): { imported: number; sources: string[] } { return this.briefings.importMemories(); }

  /** Fire-and-notify hooks + routing + suggested handoffs, off the log. */
  private afterAgentEvent(event: LoomEvent): void {
    this.trackCost(event);
    // The turn's diff is started before routing hears the turn ended: a step
    // condition reads those numbers, and a route that advanced first would
    // read the turn before this one.
    if (event.kind === "run_complete" && event.agentId) {
      this.captureTurnDiff(event.agentId);
      if (!this.continuity) void this.captureAgentDecisions(event.agentId).catch(() => { });
    }
    this.routes.handleAgentEvent(event);
    // Accumulate the turn's prose so decisions can be mined when it completes.
    if (!this.continuity && event.kind === "message" && event.agentId && !event.payload.reasoning) {
      const prev = this.turns.turnText.get(event.agentId) ?? "";
      this.turns.turnText.set(event.agentId, `${prev}\n${String(event.payload.text ?? "")}`.slice(-8000));
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
      if (event.agentId && !this.continuity) this.captureDecisions(event);
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
    const turnText = this.turns.turnText.get(agentId) ?? "";
    this.turns.turnText.delete(agentId);
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
      chatId: this.turns.turnChat.get(agentId) ?? MAIN_CHAT,
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
    if (this.closed || !decisions.length) return;
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
    this.turns.turnChat.set(agentId, chat);
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
    if (live) await live.close().catch(() => { });
    const proxy = await startPreviewProxy(target);
    this.proxies.set(name, proxy);
    return proxy;
  }

  /** Live server state and output, for the socket. Returns unsubscribe. */
  /** Replies as they're written, for the socket. Returns unsubscribe. */
  onStream(cb: (f: LiveText) => void): () => void {
    this.streamListeners.add(cb);
    return () => this.streamListeners.delete(cb);
  }

  /** The replies being typed right now in one thread (or all of them). */
  liveNow(chat?: string): { agentId: string; chat: string; text: string; think: string }[] {
    const out: { agentId: string; chat: string; text: string; think: string }[] = [];
    for (const [agentId, s] of this.liveSoFar) {
      if (chat !== undefined && s.chat !== chat) continue;
      if (s.text || s.think) out.push({ agentId, ...s });
    }
    return out;
  }

  private liveSoFar = new Map<string, { chat: string; text: string; think: string }>();

  private liveText(f: LiveText): void {
    if (this.closed) return;
    let s = this.liveSoFar.get(f.agentId);
    if (!s || s.chat !== f.chat) this.liveSoFar.set(f.agentId, (s = { chat: f.chat, text: "", think: "" }));
    const off = f.reasoning ? s.think.length : s.text.length;
    if (f.reasoning) s.think += f.text;
    else s.text += f.text;
    // a runaway reply can't grow the buffer without bound
    if (s.text.length > 400_000) s.text = "";
    if (s.think.length > 400_000) s.think = "";
    const framed: LiveText = { ...f, off };
    for (const cb of this.streamListeners) {
      try {
        cb(framed);
      } catch {
        // a viewer that breaks must not break the turn
      }
    }
  }

  /** Streamed text and tool progress as a turn produces them; what finishes lands in the log. */
  onLiveDelta(cb: (d: LiveFrame) => void): () => void {
    this.liveListeners.add(cb);
    return () => this.liveListeners.delete(cb);
  }

  /**
   * Answer a structured question an agent is waiting on (a needs_input event
   * with a requestId). The turn carries on with the answer.
   */
  async answerQuestion(agentId: string, chat: string, requestId: string, answers: Record<string, unknown>): Promise<void> {
    // a crew teammate or orchestra worker runs as its own instance; its card names that instance
    const agent = (this.agents.get(agentId) ?? this.crews?.liveAgent?.(agentId) ?? this.orchestra?.liveAgent?.(agentId)) as
      | { respondToUserInput?: (chat: string, requestId: string, answers: Record<string, unknown>) => Promise<void> }
      | undefined;
    if (!agent || typeof agent.respondToUserInput !== "function") throw new Error(`agent "${agentId}" can't take answers to questions`);
    this.releaseQuestionHold(agentId);
    await agent.respondToUserInput(chat, requestId, answers);
    if (this.openQuestions.get(agentId)?.requestId === requestId) this.openQuestions.delete(agentId);
  }

  /** Structured questions agents are blocked on, by agent. */
  private openQuestions = new Map<string, { requestId: string; chat: string; ids: string[] }>();

  /** Compact an agent's native context for a chat now, instead of waiting for the harness to. */
  async compactAgent(agentId: string, chat: string = MAIN_CHAT): Promise<void> {
    const agent = this.agents.get(agentId);
    if (!(agent instanceof ProviderAgent)) throw new Error(`agent "${agentId}" can't be compacted from Loom`);
    if (agent.busy() || this.turns.busySince.has(agentId)) throw new Error(`"${agentId}" is mid-turn — wait for it to finish, then compact`);
    await this.ensureStarted(agentId);
    this.turns.turnChat.set(agentId, chat);
    await agent.compact(chat);
  }

  /**
   * A plan turn on a provider agent runs in the agent's own plan mode, which
   * changes nothing; Loom keeps the plan it proposes under plans/, as its plan
   * mode always has.
   */
  private saveProposedPlan(agentId: string, chat: string | undefined, markdown: string): void {
    if (!markdown.trim()) return;
    try {
      const heading = /^#+\s*(.+)$/m.exec(markdown)?.[1] ?? markdown.split("\n")[0] ?? "plan";
      const slug = heading.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "plan";
      const day = new Date().toISOString().slice(0, 10);
      const dir = path.join(this.agentDir(agentId), "plans");
      fs.mkdirSync(dir, { recursive: true });
      let file = path.join(dir, `${day}-${slug}.md`);
      for (let n = 2; fs.existsSync(file); n++) file = path.join(dir, `${day}-${slug}-${n}.md`);
      fs.writeFileSync(file, `---\ntitle: ${JSON.stringify(heading.trim())}\nstatus: proposed\nagent: ${agentId}\n---\n\n${markdown.trim()}\n`);
      this.log.append({ kind: "status", agentId, ...(chat ? { chat } : {}),
        payload: { state: "plan_saved", path: path.relative(this.agentDir(agentId), file) } });
    } catch (error) {
      logbook.warn("plan", `could not save ${agentId}'s proposed plan`, String(error), this.info.id);
    }
  }

  onServerEvent(cb: (f: ServerFrame) => void): () => void {
    this.serverListeners.add(cb);
    return () => this.serverListeners.delete(cb);
  }
  onQueueChange(cb: (q: QueueState) => void): () => void { return this.queueCoordinator.onQueueChange(cb); }

  enqueue(input: QueueInput): QueueItem {
    if (this.continuity) {
      this.queue.assertCanAdd(input);
      if (!this.chats().some(c => c.id === (input.chat ?? MAIN_CHAT)))
        throw new ContinuityError("invalid", "conversation is missing or deleted");
      const bound = this.chatBinding(input.chat);
      if (input.target?.kind === "orchestra") throw new ContinuityError("unsupported", "parallel orchestra is outside sequential native continuity");
      const target = input.target?.kind === "agent" ? input.target.agentId : bound.agentId ?? this.validHolder() ?? this.defaultAdapterId();
      const cfg = this.config.agents.find(a => a.id === target);
      if (!cfg || !isNativeKind(cfg.kind)) throw new ContinuityError("unsupported", "queued native continuity needs a supported harness (Codex, Claude Code or OpenCode)");
      const captured = this.continuity.capture({ id: newId(16), text: input.text, conversationId: input.chat ?? MAIN_CHAT,
        agentInstanceId: target, source: input.source ?? "user", model: bound.agentId === target ? bound.model ?? null : null,
        plan: Boolean(input.plan), targetAddedTokens: 6000 });
      input = { ...input, target: { kind: "agent", agentId: target }, continuity: { requestId: captured.request.id, model: captured.request.model } };
    }
    return this.queueCoordinator.enqueue(input);
  }

  editQueued(itemId: string, patch: { text?: string; target?: QueueTarget; plan?: boolean; when?: QueueCondition | null }): QueueItem {
    if (this.continuity && (patch.text !== undefined || patch.target !== undefined || patch.plan !== undefined))
      throw new ContinuityError("unsupported", "native queued request revisions require durable supersession; remove the unsent entry and submit a new request instead");
    return this.queueCoordinator.editQueued(itemId, patch);
  }

  queueBlocker(item: QueueItem): string | null { return this.queueCoordinator.queueBlocker(item); }

  private watchClockConditions(q: QueueState): void { return this.queueCoordinator.watchClockConditions(q); }

  private holdQueueFor(agentId: string): void { return this.queueCoordinator.holdQueueFor(agentId); }

  private releaseQuestionHold(agentId: string): void { return this.queueCoordinator.releaseQuestionHold(agentId); }

  private kickQueue(): void { return this.queueCoordinator.kickQueue(); }

  async drainPromptQueue(): Promise<void> { return this.queueCoordinator.drainPromptQueue(); }


  async sendMessage(
    text: string,
    agentId?: string,
    opts: TurnOptions = {},
  ): Promise<TurnResult> { return this.turns.sendMessage(text, agentId, opts); }

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
        void this.agentLifecycle.retire(id);
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

  /** Turns older than this are presumed hung. Generous: real turns run long. */
  static readonly STALE_TURN_MS = 10 * 60 * 1000;
  staleSessions(now = Date.now()): Array<{ agentId: string; busyMs: number }> { return this.turns.staleSessions(now); }

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
      await live.interrupt().catch(() => { });
    }
    await this.agentLifecycle.retire(agentId);
    this.turns.busySince.delete(agentId);
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
    if (this.continuity) throw new ContinuityError("unsupported", "parallel subagents are outside sequential native continuity; finish this turn or use legacy mode");
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
      chat,
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
  private subtaskBriefing(parent: string, childId: string, task: string): string { return this.briefings.subtaskBriefing(parent, childId, task); }

  private defaultAdapterId(): string {
    const cfg =
      (this.config.defaultAgent &&
        this.config.agents.find((a) => a.id === this.config.defaultAgent)) ||
      this.config.agents.find((a) => isAdapter(this.agent(a.id)));
    if (!cfg) throw new Error(`project "${this.info.name}" has no full-duplex adapters`);
    return cfg.id;
  }
  private consumePendingBriefing(agentId: string): string | undefined { return this.briefings.consumePendingBriefing(agentId); }

  async retryTurn(toAgentId: string): Promise<{ agentId: string; retried: string }> { return this.turns.retryTurn(toAgentId); }

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
    if (this.continuity?.store.activeReceipts().some(r => r.execution === "unknown"))
      throw new ContinuityError("recovery_required", "reconcile uncertain native writers before handoff or merge");
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
        if (this.continuity && this.turns.busySince.has(holder) && !current.busy())
          throw new ContinuityError("conflict", "outgoing turn is still preparing or finalizing; wait or stop before interrupt-switching");
        if (current.busy()) await current.interrupt();
        const diff = await current.diff().catch(() => "");
        if (diff) handoffMeta = { ...handoffMeta, dirty: true, diff: diff.slice(0, 2000) };
      }
      // After the outgoing agent has stopped (its last commit is in), before
      // the briefing is written — so the briefing can carry the result.
      merge = await this.mergeForHandoff(holder, to);
      if (merge) handoffMeta = { ...handoffMeta, merge };
    }

    const bridgeIds = this.config.agents.map((cfg) => cfg.id).filter((id) => {
      const agent = this.agents.get(id);
      return agent && !isAdapter(agent) && id !== to;
    });
    const mergeNote = merge ? describeMerge(merge, holder ?? "the previous agent", to) : "";
    if (this.continuity) {
      // New context is assembled from the selected chat at dispatch, never
      // from global history or private bridge memory on a picker click.
      this.briefings.pendingBriefings.delete(to);
      const { from } = this.baton.handoff(to, { ...handoffMeta, projected: false, continuity: 1 });
      await this.ensureStarted(to);
      return { from, ...(merge ? { merge } : {}) };
    }
    const prepared = await this.briefings.prepareHandoff(to, holder, mergeNote, bridgeIds);
    if (this.closed || this.agents.get(to) !== target) throw new Error("handoff target is no longer active");
    await target.injectMemory(prepared.memory);
    if (this.closed || this.agents.get(to) !== target) throw new Error("handoff target is no longer active");
    writeMemoryFile(this.info.dir, to, prepared.memory);
    this.briefings.pendingBriefings.set(to, prepared.briefing);
    if (prepared.mode === "llm") {
      this.log.append({ kind: "status", payload: { state: "projection", mode: "llm", ms: prepared.elapsedMs } });
    }
    for (const bridge of prepared.bridges) {
      await this.agents.get(bridge.agentId)?.injectMemory(bridge.memory).catch(() => {});
    }
    if (this.closed || this.agents.get(to) !== target) throw new Error("handoff target is no longer active");

    const { from } = this.baton.handoff(to, handoffMeta);
    await this.ensureStarted(to);
    return { from, ...(merge ? { merge } : {}) };
  }
  async interrupt(
    opts: { source?: "user" | "route"; chat?: string } = {},
  ): Promise<{ interrupted: string | null }> { return this.turns.interrupt(opts); }

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
    if (this.continuity) throw new ContinuityError("unsupported", "autonomous route continuity is not verified; select a native agent directly");
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
            ...(cfg.instructions ? { instructions: cfg.instructions } : {}),
            ...sampling(cfg),
            ...(cfg.avatar ? { avatar: cfg.avatar } : {}),
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
          available: this.continuity && isNativeKind(cfg.kind)
            ? (await this.harnesses.ensure(cfg.id)).available
            : await live.available().catch(() => false),
          ...(this.continuity && isNativeKind(cfg.kind) ? { cliVersion: this.harnesses.get(cfg.id)?.version ?? null } : {}),
          busy: isAdapter(live) ? live.busy() || Boolean(this.continuity && this.turns.busySince.has(cfg.id)) : false,
          // which chat that turn is in, so a client shows Stop only where it applies
          ...(isAdapter(live) && (live.busy() || this.turns.busySince.has(cfg.id)) ? { chat: this.turns.turnChat.get(cfg.id) ?? MAIN_CHAT } : {}),
          holdsBaton: holder === cfg.id,
          model,
          permissions: permissionFor(cfg.kind, cfg.options),
          enabled: true,
          ...(cfg.instructions ? { instructions: cfg.instructions } : {}),
          ...sampling(cfg),
          ...(cfg.avatar ? { avatar: cfg.avatar } : {}),
          ...(isNativeKind(cfg.kind) ? { context: this.nativeUsage.context(cfg.id), limits: this.nativeUsage.limitsFor(cfg.kind) } : {}),
        };
      }),
    );
    const recent = this.log.list({ limit: 50 });
    const lastEvent = recent[recent.length - 1] ?? null;
    const lastUserMsg = [...recent]
      .reverse()
      .find((e) => e.kind === "message" && !e.agentId);
    const lastNeedsInput = [...recent].reverse().find((e) => e.kind === "needs_input");
    const reqId = lastNeedsInput && (lastNeedsInput.payload as { requestId?: unknown }).requestId;
    // a question answered on its card (no message typed) is answered all the same
    const answeredOnCard = Boolean(reqId && recent.some((e) => e.id > lastNeedsInput!.id && e.kind === "status" &&
      (e.payload as { state?: unknown; requestId?: unknown }).state === "question_answered" && (e.payload as { requestId?: unknown }).requestId === reqId));
    const needsInput = Boolean(
      lastNeedsInput && !answeredOnCard && (!lastUserMsg || lastNeedsInput.id > lastUserMsg.id),
    );
    return {
      id: this.info.id,
      name: this.info.name,
      dir: this.info.dir,
      ...(this.continuity ? { continuity: true } : {}),
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
      costUsd: this.accounting.costs.totalUsd,
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
      const chat = this.turns.turnChat.get(cfg.id);
      const last = lastOf(cfg.id, chat);
      return {
        id: cfg.id,
        kind: cfg.kind,
        role: cfg.role,
        busy: Boolean(live && isAdapter(live) && (live.busy() || this.turns.busySince.has(cfg.id))),
        since: this.turns.busySince.get(cfg.id) ?? null,
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
      if (agent.busy()) await agent.interrupt().catch(() => { });
      await agent.stop().catch(() => { });
    }
  }

  /** Share this project with a team, or record an explicit opt-out (null). */
  setTeam(share: { teamId: string; repo: string } | null): void {
    this.config.team = share ? { teamId: share.teamId, repo: share.repo } : { optOut: true };
    this.saveConfig();
  }
  chatOf(agentId: string): string | undefined { return this.turns.chatOf(agentId); }

  /** The live (or latest) orchestra run, compact — for status payloads. */
  orchestraSummary(): Record<string, unknown> | null {
    const run = this.orchestra.active() ?? this.orchestra.list()[0];
    if (!run) return null;
    return {
      id: run.id,
      goal: run.goal,
      status: run.status,
      chat: run.chat,
      // Whether that thread is the run's own or one it borrowed \u2014 a borrowed
      // one stops answering for the run when the run ends.
      ...(run.inPlace ? { inPlace: true } : {}),
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
    await this.orchestra.shutdown().catch(() => { });
    await this.crews.shutdown().catch(() => { });
    this.closed = true;
    this.harnesses.stop();
    this.live.close();
    this.briefings.close();
    if (this.mcpTimer) { clearInterval(this.mcpTimer); this.mcpTimer = null; }
    await this.agentLifecycle.close();
    // A dev server outlives the daemon that started it unless we say otherwise,
    // and an orphan holding port 3000 is a bad thing to leave behind.
    if (this.queueCoordinator.clockTimer) { clearInterval(this.queueCoordinator.clockTimer); this.queueCoordinator.clockTimer = null; }
    await this.servers.closeAll().catch(() => { });
    for (const proxy of this.proxies.values()) await proxy.close().catch(() => { });
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
