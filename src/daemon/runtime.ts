/**
 * ProjectRuntime — one live project inside the daemon: its event log, its
 * agents, and its baton. All mutations flow through here so the log stays
 * the single source of truth.
 */

import fs from "node:fs";
import path from "node:path";
import type {
  AgentConfig,
  AgentCost,
  AnyAgent,
  ChatInfo,
  CostSummary,
  LoomEvent,
  ProjectConfig,
  ProjectInfo,
  ProjectStatus,
  SendInput,
  UnifiedMemory,
} from "../types.js";
import type { RouteState, RouteStepSpec, RouterKind } from "../types.js";
import { isAdapter, MAIN_CHAT } from "../types.js";
import { createAgent, knownAgentKinds } from "../adapters/index.js";
import { BatonManager, NotHolderError } from "../core/baton.js";
import { Brain, CONFIDENCE_FLOOR } from "../core/brain.js";
import { compileBrief, retrieve } from "../core/brain-index.js";
import { extractFromTurn, type ExtractEngine } from "../core/brain-extract.js";
import { claudeText } from "../core/claude-cli.js";
import { EventLog } from "../core/eventlog.js";
import { renderProjection } from "../core/distill.js";
import {
  buildUnifiedMemory,
  hashContent,
  readNativeMemory,
  type ImportedBlock,
} from "../core/memory.js";
import { notify } from "../core/notify.js";
import { RouteEngine } from "../core/routes.js";
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
    for (const agentCfg of config.agents) this.spawnAgent(agentCfg);

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
    return rt;
  }

  // -------------------------------------------------------------------------
  // Cost telemetry — O(1) incremental, rehydrated from the log on open
  // -------------------------------------------------------------------------

  private costs = { totalUsd: 0, turns: 0, totalMs: 0 };
  private costsByAgent = new Map<string, { usd: number; turns: number; ms: number }>();

  private rehydrateCosts(): void {
    for (const event of this.log.list({ kinds: ["status", "run_complete"] })) {
      this.trackCost(event);
    }
  }

  private trackCost(event: LoomEvent): void {
    const agentId = event.agentId ?? "unknown";
    const entry =
      this.costsByAgent.get(agentId) ?? { usd: 0, turns: 0, ms: 0 };
    if (event.kind === "status" && event.payload.state === "turn_cost") {
      const usd = Number(event.payload.costUsd ?? 0);
      if (usd > 0) {
        this.costs.totalUsd += usd;
        entry.usd += usd;
        this.costsByAgent.set(agentId, entry);
      }
    } else if (event.kind === "run_complete") {
      const ms = Number(event.payload.durationMs ?? 0);
      this.costs.turns += 1;
      this.costs.totalMs += ms;
      entry.turns += 1;
      entry.ms += ms;
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
      byAgent,
    };
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
    const id = (opts.id ?? kind).trim().slice(0, 40);
    if (!id) throw new Error("an agent needs an id");
    if (this.config.agents.some((a) => a.id === id)) {
      throw new Error(`"${id}" is already in this project`);
    }
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
   * Create one agent and subscribe to it, exactly as the constructor does.
   *
   * Shared so a roster change can't drift from a cold start: an agent added at
   * runtime must stream its events into the log the same way as one that was
   * there when the project opened.
   */
  private spawnAgent(cfg: AgentConfig): AnyAgent {
    const agent = createAgent(cfg, this.info.dir);
    this.agents.set(cfg.id, agent);
    agent.onEvent((e) => {
      const chat = this.turnChat.get(agent.id);
      const event = this.log.append({
        kind: e.kind,
        agentId: agent.id,
        ...(chat ? { chat } : {}),
        payload: e.payload,
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

  createTask(input: { title: string; column?: string; agent?: string }): BoardTask {
    const state = readProjectState(this.info.dir);
    const task: BoardTask = {
      id: newId(4),
      title: input.title.trim().slice(0, 200),
      column: input.column ?? "working",
      ...(input.agent ? { agent: input.agent } : {}),
      createdAt: Date.now(),
    };
    state.tasks = [...(state.tasks ?? []), task];
    writeProjectState(this.info.dir, state);
    return task;
  }

  /** Move or retitle a card. Yours, so this is the real state — not a hint. */
  updateTask(id: string, patch: { title?: string; column?: string; agent?: string }): BoardTask | null {
    const state = readProjectState(this.info.dir);
    const task = (state.tasks ?? []).find((t) => t.id === id);
    if (!task) return null;
    if (patch.title !== undefined) task.title = patch.title.trim().slice(0, 200) || task.title;
    if (patch.column !== undefined) task.column = patch.column;
    if (patch.agent !== undefined) task.agent = patch.agent;
    writeProjectState(this.info.dir, state);
    return task;
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
    void diffSinceSnapshot(this.info.dir, before)
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
        }
        // Learn from the turn once we know which files it touched — the files
        // sharpen candidate retrieval. Runs after the diff so recentTurnFiles
        // isn't needed; the files are right here.
        this.extractMemory(agentId, (diff?.files ?? []).map((f) => f.path));
      })
      .catch(() => this.extractMemory(agentId, []));
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
    if (event.kind === "run_complete" && event.agentId) {
      this.captureTurnDiff(event.agentId);
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
      const reply = await bridge.ask(text);
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
    this.log.append({
      kind: "message",
      chat,
      payload: { text, author: source === "route" ? "loom" : "user" },
    });
    await this.ensureStarted(target);

    const pendingBriefing = this.consumePendingBriefing(target);
    const input: SendInput = pendingBriefing ? { text, briefing: pendingBriefing } : { text };
    // Snapshot the tree so this prompt's changes can be attributed to it.
    this.preTurnTree.set(target, await porcelainStatus(this.info.dir));
    // Fire-and-notify: the turn runs in the background; progress streams
    // into the log and completion lands as run_complete.
    void agent.send(input).catch((err) => {
      this.log.append({
        kind: "error",
        agentId: target,
        payload: { message: String(err instanceof Error ? err.message : err) },
      });
    });
    return { agentId: target };
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
  async handoff(
    to: string,
    opts: { source?: "user" | "route" } = {},
  ): Promise<{ from: string | null }> {
    const target = this.agent(to);
    if (!isAdapter(target)) {
      throw new Error(`cannot hand the baton to "${to}" — bridges are read-only by design`);
    }
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
        const agent = this.agent(cfg.id);
        return {
          id: cfg.id,
          kind: cfg.kind,
          role: cfg.role,
          tier: agent.capabilities.tier,
          available: await agent.available().catch(() => false),
          busy: isAdapter(agent) ? agent.busy() : false,
          holdsBaton: holder === cfg.id,
          // The picker shows a tick next to the active model; "" means the
          // adapter's own default, which is the honest baseline.
          model: (cfg.options?.model as string | undefined) ?? "",
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
    };
  }

  async close(): Promise<void> {
    for (const id of this.startedAgents) {
      await this.agent(id).stop().catch(() => {});
    }
    this.startedAgents.clear();
    this.brain.close(); // unsubscribes before the log drops its listeners
    this.log.close();
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
