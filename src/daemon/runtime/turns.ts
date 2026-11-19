import { runAttempts } from "../../core/agents-r4/attempts.js";
import { agentPolicy } from "../../core/agents-r4/store.js";
import { resolveModel, enforceModelCap } from "../../core/model-routing.js";
import { draftCommit, selectChatBranch } from "../../core/git-review.js";
import { branchBriefing } from "../../core/chat-branches.js";
import { readProjectState } from "../../core/registry.js";
import { AgentBase } from "../../adapters/base.js";
import { waitingForSlot } from "../../adapters/index.js";
import { BatonManager, NotHolderError } from "../../core/baton.js";
import path from "node:path";
import { triage } from "../../core/review-triage.js";
import * as checkpoints from "../../core/checkpoint.js";
import type { EventJournal } from "../../core/eventlog.js";
import { GitError, push as gitPush, stageAndCommitFiles } from "../../core/git.js";
import { logbook } from "../../core/logbook.js";
import { writeLoomMcpSession } from "../../core/loom-tools.js";
import {
  PromptQueue
} from "../../core/prompt-queue.js";
import { RouteEngine } from "../../core/routes.js";
import { NO_CHANGES, type TurnFacts } from "../../core/step-conditions.js";
import { agentAllowed, type TeamPolicy } from "../../core/team-policy.js";
import { type MergeOutcome } from "../../core/worktree-merge.js";
import {
  diffSinceSnapshot,
  contentSnapshot,
  type TurnDiff
} from "../../core/worktree.js";
import type {
  AdapterEvent,
  AnyAgent,
  McpServerConfig,
  ProjectConfig,
  ProjectInfo,
  SendInput
} from "../../types.js";
import { MAIN_CHAT, isAdapter } from "../../types.js";
import { planModeBriefing } from '../runtime-support.js';
import { ProviderAgent } from "../../providers/agent.js";
import { randomUUID } from "node:crypto";
import { ContinuityError, NativeDispatchRejected } from "../../core/continuity/contracts.js";
import type { ContinuityEngine } from "../../core/continuity/engine.js";
import type { HarnessHealth } from "../../core/continuity/capabilities.js";
import { isNativeKind } from "../../core/continuity/capabilities.js";

export interface TurnOptions {
  source?: "user" | "route"; chat?: string; plan?: boolean; fromQueue?: boolean;
  /** A teammate in a shared chat (Share live): their name, on the message they sent. */
  by?: string;
  /** A new native session for this chat instead of resuming the old one (#280). */
  fresh?: boolean;
  /** How long you asked this one answer to be. */
  length?: "brief" | "detailed";
  /** This turn only: nonempty values override the chat selection without saving it. */
  model?: string;
  effort?: string;
  requestId?: string; capturedModel?: string | null; capturedEffort?: string | null; resume?: boolean; contextTarget?: number;
}
/** How long you asked the answer to be, this once ("" for the usual). */
function lengthLine(length: TurnOptions["length"]): string {
  return length === "brief"
    ? "Keep this reply brief: the answer first, a few sentences at most, no preamble."
    : length === "detailed"
      ? "Give a detailed reply this time: explain your reasoning and the trade-offs, with examples where they help."
      : "";
}

export interface TurnResult { agentId: string; queued?: number; queueId?: string; answered?: boolean;
  requestId?: string; receiptId?: string; packetId?: string; continuityStatus?: string; }

/** Dependencies owned by the project coordinator, read live for each operation. */
export interface RuntimeTurnsHost {
  continuity: ContinuityEngine | null;
  /** Current reachability of a native harness CLI (see HarnessMonitor). */
  harness: (agentId: string) => Promise<HarnessHealth>;
  kickQueue: () => void;
  nativeOptions: (agentId: string) => Record<string, unknown>;
  chatExists: (chat: string) => boolean;
  assertChatWritable: (chat: string) => void;
  chatMoveBriefing: (chat: string) => string | undefined;
  clearChatMoveBriefing: (chat: string) => void;
  agentDir: (agentId: string) => string;
  log: EventJournal;
  info: ProjectInfo;
  extractMemory: (agentId: string, files: string[]) => void;
  config: ProjectConfig;
  chatBinding: (chat?: string) => { agentId?: string; model?: string; effort?: string; };
  bindable: (agentId: string, model?: string, effort?: string) => { model?: string; effort?: string };
  validHolder: () => string | null;
  defaultAdapterId: () => string;
  agent: (id: string) => AnyAgent;
  enforceQuarantine: (agentId: string) => void;
  enforceBudget: (agentId: string, now?: number) => void;
  teamPolicy: TeamPolicy | null;
  staleTurnMs: number;
  closed: boolean;
  baton: BatonManager;
  releaseQuestionHold: (agentId: string) => void;
  /** The structured question this agent's turn is blocked on, if any. */
  openQuestion: (agentId: string) => { requestId: string; chat: string; ids: string[] } | undefined;
  answerQuestion: (agentId: string, chat: string, requestId: string, answers: Record<string, unknown>) => Promise<void>;
  queue: PromptQueue;
  routes: RouteEngine;
  ensureStarted: (agentId: string) => Promise<AnyAgent>;
  isCurrentAgent: (agent: AnyAgent) => boolean;
  dispatchFailed: (agent: AnyAgent, chat: string, error: unknown) => void;
  turnMemoryBrief?: (query: string, agent: string, chat: string, turn: number, pinsOnly?: boolean) => Promise<import("../../core/brain.js").MemoryBriefing>;
  consumePendingBriefing: (agentId: string) => string | undefined;
  activeSkillsBlock: () => string;
  /** The agent's standing instructions block ("" when it has none). */
  agentInstructions: (agentId: string) => string;
  /** This conversation's standing instructions block ("" when it has none). */
  chatInstructions: (chat: string) => string;
  apiUrl: () => string;
  healthyMcps: () => McpServerConfig[];
  appendIfOpen: (event: Parameters<EventJournal["append"]>[0]) => void;
  agents: ReadonlyMap<string, AnyAgent>;
  handoff: (to: string, opts?: { source?: "user" | "route"; }) => Promise<{ from: string | null; merge?: MergeOutcome; }>;
  pendingBriefings: Map<string, string>;
}

/** Owns turns state for exactly one open project. */
export class RuntimeTurns {
  constructor(private readonly host: RuntimeTurnsHost) { }

  private attemptEvent(agent: AnyAgent, chat: string, event: AdapterEvent): void {
    if (!this.host.isCurrentAgent(agent)) return;
    if (event.kind === "error") {
      const cfg = this.host.config.agents.find(a => a.id === agent.id);
      const model = this.turnModel.get(agent.id) ?? cfg?.options?.model;
      const cost = this.pendingCost.get(agent.id);
      this.pendingCost.delete(agent.id);
      event = { ...event, payload: { ...event.payload, adapter: agent.kind,
        ...(model ? { model } : {}), ...(cost !== undefined ? { costUsd: cost } : {}) } };
    }
    this.host.appendIfOpen({ ...event, agentId: agent.id, chat });
  }

  /**
   * Which conversation each agent's current turn belongs to. Set when a turn
   * starts and left in place afterwards — an agent's trailing events (a late
   * run_complete, a diff) still belong to the chat that prompted them.
   */
  turnChat = new Map<string, string>();
  /** The requested model survives errors and interrupts that omit provider metadata. */
  turnModel = new Map<string, string | undefined>();
  private turnPrompt = new Map<string, string>();
  private branchDispatch = false;
  private editBranch = new Map<string, Promise<Error | undefined>>();

  // A turn's cost lands on a `turn_cost` status just before its `run_complete`
  // (the CLI reports it mid-stream). We hold it here so the completed turn — and
  // therefore its exported gen_ai span — carries the real cost, not just tokens.
  pendingCost = new Map<string, number>();

  // Turn text accumulated per agent (from its message events) so we can extract
  // structured decisions once the turn completes. Reset after each run_complete.
  turnText = new Map<string, string>();

  /** Pre-turn content snapshots, for per-prompt diff attribution. */
  preTurnTree = new Map<string, string>();

  /** The checkpoint taken before each agent's current turn (#101). */
  turnCheckpoint = new Map<string, string>();

  /**
   * The diff of each agent's most recent turn, as a promise.
   *
   * A route's step conditions ("run the reviewer if more than 200 lines
   * changed") are decided the moment the turn completes, which is before the
   * diff has finished being computed. Keeping the promise lets the route wait
   * for the real numbers instead of reading the previous turn's.
   */
  lastTurnDiff = new Map<string, Promise<TurnDiff | null>>();

  /** App-owned diff/commit writes finish before changing a branch or its files. */
  async settleBranches(): Promise<void> { await Promise.all([...this.postTurn.values(), ...this.editBranch.values()]); }

  private readonly postTurn = new Map<string, Promise<void>>();

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
  busySince = new Map<string, number>();
  private readonly preparing = new Map<string, AbortController>();
  /** Native requests between capture and settlement (or queueing). */
  private readonly inFlight = new Set<string>();

  /**
   * Write down what the files are, before a turn changes them (#101).
   *
   * Announced in the log so the thread can offer "put it back" on the turn
   * that follows it, and so the list survives a daemon restart with the
   * labels intact. Failing is not an error: a checkpoint is a courtesy, and
   * a project that isn't a git repo simply doesn't get one. What it must
   * never do is stop the turn.
   */
  async checkpointBefore(agentId: string, prompt: string): Promise<void> {
    this.turnPrompt.set(agentId, prompt);
    try {
      const label = prompt.replace(/\s+/g, " ").trim().slice(0, 120) || `a turn by ${agentId}`;
      const cp = await checkpoints.capture(this.host.agentDir(agentId), label);
      if (!cp || this.host.closed) return;
      // Carried onto this turn's turn_diff, so the card that shows what
      // changed also knows the point to put it back to. Working it out in the
      // client by "the checkpoint nearest above this card" would be right
      // until the day two turns interleave.
      this.turnCheckpoint.set(agentId, cp.id);
      this.host.log.append({
        kind: "checkpoint",
        chat: this.turnChat.get(agentId) ?? MAIN_CHAT,
        agentId,
        payload: { id: cp.id, label: cp.label, at: cp.at, dirty: cp.dirty, branch: cp.branch, reason: "before_turn" },
      });
    } catch {
      /* never the reason a turn doesn't run */
    }
  }

  /** Cut a new chat branch as soon as an adapter reports its first edit. */
  branchOnEdit(agentId: string): void {
    if (!this.host.config.git?.branchPerChat || !this.preTurnTree.has(agentId) || this.editBranch.has(agentId)) return;
    const chat = this.turnChat.get(agentId) ?? MAIN_CHAT;
    this.editBranch.set(agentId, selectChatBranch(this.host.agentDir(agentId), chat, true).then(branch => {
      this.host.log.append({ kind: "status", agentId, chat, payload: { state: "chat_branch", branch } });
      return undefined;
    }, error => error instanceof Error ? error : new Error(String(error))));
  }

  /** Every point this project's files can be put back to, newest first. */
  checkpoints(): Promise<checkpoints.Checkpoint[]> {
    return checkpoints.list(this.host.info.dir);
  }

  /**
   * Put the files back, and say what moved.
   *
   * Refused while an agent is mid-turn: rewinding the tree under a running
   * agent gives it a working directory that contradicts everything it has
   * read this turn, and the damage lands in whatever it writes next.
   */
  async rewind(id: string): Promise<checkpoints.RestoreResult> {
    if (this.host.continuity?.store.activeReceipts().length)
      throw new ContinuityError("recovery_required", "finish or reconcile native writers before rewinding files");
    const busy = [...this.busySince.keys()];
    if (busy.length) {
      throw new Error(
        `${busy.join(", ")} ${busy.length === 1 ? "is" : "are"} mid-turn — stop the turn first, or the rewind lands underneath it`,
      );
    }
    const out = await checkpoints.restore(this.host.info.dir, id);
    this.host.log.append({
      kind: "checkpoint",
      payload: {
        id: out.restored.id,
        label: out.restored.label,
        at: Date.now(),
        reason: "rewound",
        files: out.changed.length,
        undo: out.undo.id,
      },
    });
    return out;
  }

  /** What an agent's last turn changed — for route step conditions. */
  async turnFacts(agentId: string): Promise<TurnFacts> {
    const diff = await (this.lastTurnDiff.get(agentId) ?? Promise.resolve(null));
    if (!diff) return NO_CHANGES;
    return { files: diff.files.map((f) => f.path), added: diff.added, removed: diff.removed };
  }

  /** After a turn: log which files that prompt changed (turn_diff), then learn. */
  captureTurnDiff(agentId: string): void {
    this.postTurn.delete(agentId);
    const before = this.preTurnTree.get(agentId);
    if (before === undefined) {
      // No snapshot (e.g. a turn with no pre-tree) — still worth reading.
      // The previous turn's diff goes with it: a route asking what this turn
      // changed must not be handed the last one's numbers.
      this.lastTurnDiff.delete(agentId);
      this.host.extractMemory(agentId, []);
      return;
    }
    this.preTurnTree.delete(agentId);
    const checkpoint = this.turnCheckpoint.get(agentId);
    this.turnCheckpoint.delete(agentId);
    // The chat the turn ran in, read now: by the time the diff is computed the
    // agent may already be on its next turn somewhere else. Without it, every
    // "changed N files" card landed in Main whatever thread asked.
    const turnChat = this.turnChat.get(agentId);
    const turnPrompt = this.turnPrompt.get(agentId);
    this.turnPrompt.delete(agentId);
    const editBranch = this.editBranch.get(agentId);
    this.editBranch.delete(agentId);
    const pending = (checkpoint ? checkpoints.turnDiff(this.host.agentDir(agentId), checkpoint) : diffSinceSnapshot(this.host.agentDir(agentId), before)).catch(() => null);
    this.lastTurnDiff.set(agentId, pending);
    const finalized = pending
      .then(async (diff) => {
        if (this.host.closed) return;
        if (diff) {
          let branchReady = true;
          if (diff.files.length && this.host.config.git?.branchPerChat) {
            try {
              const error = await editBranch;
              if (error) throw error;
              if (!editBranch) {
                const branch = await selectChatBranch(this.host.agentDir(agentId), turnChat ?? MAIN_CHAT, true);
                this.host.log.append({ kind: "status", agentId, chat: turnChat, payload: { state: "chat_branch", branch } });
              }
            } catch (error) {
              this.host.log.append({ kind: "status", agentId, chat: turnChat, payload: { state: "git_failed", text: String(error) } });
              branchReady = false;
            }
          }
          this.host.log.append({
            kind: "turn_diff",
            ...(turnChat && turnChat !== MAIN_CHAT ? { chat: turnChat } : {}),
            agentId,
            payload: {
              files: diff.files,
              added: diff.added,
              removed: diff.removed,
              patch: diff.patch,
              truncated: diff.truncated,
              // what to read first: the files ranked by what a reviewer would want to see (core/review-triage.ts)
              triage: triage(diff.patch, diff.files).files.slice(0, 40).map(({ path, level, reasons }) => ({ path, level, reasons: reasons.slice(0, 3) })),
              // The point these changes can be put back to, when there is one
              // — a project that isn't a git repo has no checkpoint to offer.
              ...(checkpoint ? { checkpoint } : {}),
            },
          });
          // files changed through the shell (sed, a script, git apply) never came as a file_edit: log them from the diff,
          // so cards and counts match what changed (#316)
          this.backfillEdits(agentId, turnChat, diff.files.map((f) => f.path));
          if (branchReady) await this.commitTurn(agentId, diff.files.map((f) => f.path), diff.patch, turnChat, turnPrompt);
        }
        // Learn from the turn once we know which files it touched — the files
        // sharpen candidate retrieval. Runs after the diff so recentTurnFiles
        // isn't needed; the files are right here.
        this.host.extractMemory(agentId, (diff?.files ?? []).map((f) => f.path));
      })
      .catch(() => this.host.extractMemory(agentId, []));
    this.postTurn.set(agentId, finalized);
  }

  /** A file_edit for each file the turn's diff shows that the agent didn't report editing (tool "shell"). */
  private backfillEdits(agentId: string, chat: string | undefined, files: string[]): void {
    if (!files.length || this.host.closed) return;
    // this turn's own reports: the file_edits since the agent's previous turn ended
    const recent = this.host.log.list({ agentId, kinds: ["file_edit", "run_complete"], limit: 400 });
    let start = recent.length - 1;
    while (start >= 0 && recent[start]!.kind === "run_complete") start--; // this turn's own end
    let from = 0;
    for (let i = start; i >= 0; i--) if (recent[i]!.kind === "run_complete") { from = i + 1; break; }
    const dir = this.host.agentDir(agentId);
    const reported = new Set(recent.slice(from).filter((e) => e.kind === "file_edit")
      .map((e) => { const p = String(e.payload.path ?? ""); return path.isAbsolute(p) ? path.relative(dir, p) : p; }).map((p) => p.split(path.sep).join("/")));
    for (const f of files) {
      if (reported.has(f)) continue;
      this.host.log.append({ kind: "file_edit", agentId, ...(chat && chat !== MAIN_CHAT ? { chat } : {}), payload: { path: f, tool: "shell", fromDiff: true } });
    }
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
  async commitTurn(agentId: string, files: string[], diff = "", chat = this.turnChat.get(agentId) ?? MAIN_CHAT, turnPrompt?: string): Promise<void> {
    const delivery = this.host.config.git?.delivery ?? "none";
    if ((!this.host.config.git?.commitPerTurn && delivery === "none") || !files.length) return;
    try {
      const events = this.host.log.list({ chat, limit: 60 });
      const prompt = turnPrompt ??
        [...events].reverse().find((e) => e.kind === "message" && !e.agentId)?.payload.text ?? "";
      const { message: subject } = await draftCommit(String(prompt), diff, this.host.config.git?.messageModel);
      const cfg = this.host.config.agents.find((a) => a.id === agentId);
      const message =
        `${subject}\n\n` +
        `Turn by ${agentId}${cfg ? ` (${cfg.kind})` : ""} in Loom.\n` +
        `Co-Authored-By: ${agentId} <${agentId}@loom.local>`;
      await stageAndCommitFiles(this.host.agentDir(agentId), files, message);
      this.host.log.append({
        kind: "status",
        agentId,
        chat,
        payload: { state: "turn_committed", files: files.length, subject },
      });
      // "push" delivers each committed turn; "pr" leaves pushing to the
      // orchestra's branch (a PR per turn is the flood teams complain about).
      if (delivery === "push") {
        const pushed = await gitPush(this.host.agentDir(agentId));
        this.host.log.append({ kind: "status", agentId, chat, payload: { state: "turn_pushed", branch: pushed.branch } });
      }
    } catch (err) {
      // A commit that can't happen (not a repo, hooks failed, nothing staged
      // after filters) is a Console line, never a failed turn.
      this.host.log.append({ kind: "status", agentId, chat, payload: { state: "git_failed", text: err instanceof GitError ? err.stderr || err.message : err instanceof Error ? err.message : String(err) } });
      logbook.warn(
        "git",
        `turn commit skipped for ${agentId}`,
        err instanceof Error ? err.message : String(err),
        this.host.info.id,
      );
    }
  }

  /** Resolve the target exactly as a normal send does, without moving the baton. */
  async steer(text: string, agentId?: string, opts: { chat?: string; by?: string } = {}): Promise<{
    agentId: string; steered: boolean; reason: string;
  }> {
    const chat = opts.chat ?? MAIN_CHAT;
    this.host.assertChatWritable(chat);
    if (!text.trim()) throw new Error("missing text");
    if (!this.host.chatExists(chat)) throw new Error("conversation is missing or deleted");
    const target = agentId ?? this.host.chatBinding(chat).agentId ?? this.host.validHolder() ?? this.host.defaultAdapterId();
    const agent = this.host.agent(target);
    if (!isAdapter(agent)) throw new Error(`agent "${target}" is a bridge (read-only) — it cannot take turns`);
    this.host.enforceQuarantine(target);
    this.host.enforceBudget(target);
    const kind = this.host.config.agents.find(a => a.id === target)?.kind ?? "";
    if (this.host.teamPolicy && !agentAllowed(this.host.teamPolicy, kind))
      throw new Error(`team policy doesn't allow ${kind} on this repo (loom.team.json)`);
    const fallback = (reason: string) => ({ agentId: target, steered: false, reason });
    if (!this.busySince.has(target) || this.turnChat.get(target) !== chat)
      return fallback("No turn is running in this chat; queued for a normal send.");
    if (!agent.capabilities.steer || !agent.steer)
      return fallback("This agent does not support steering; queued for its next turn.");
    if (!await agent.steer(chat, text))
      return fallback("The running turn did not accept steering; queued for a normal send.");
    this.host.log.append({ kind: "message", chat,
      payload: { text, author: "user", steer: true, ...(opts.by ? { by: opts.by } : {}) } });
    return { agentId: target, steered: true, reason: "" };
  }

  /** Include async dispatch preparation in a chat move's safe-point check. */
  readonly sendingChats = new Map<string, number>();

  async sendMessage(text: string, agentId?: string, opts: TurnOptions = {}): Promise<TurnResult> {
    const chat = opts.chat ?? MAIN_CHAT;
    this.host.assertChatWritable(chat);
    const branchPolicy = Boolean(this.host.config.git?.branchPerChat);
    if (branchPolicy && (this.branchDispatch || this.busySince.size)) throw new Error("finish the current turn before switching chat branches");
    if (branchPolicy) this.branchDispatch = true;
    this.sendingChats.set(chat, (this.sendingChats.get(chat) ?? 0) + 1);
    try {
      if (branchPolicy) await this.settleBranches();
      return await this.send(text, agentId, opts);
    }
    finally {
      if (branchPolicy) this.branchDispatch = false;
      const remaining = this.sendingChats.get(chat)! - 1;
      if (remaining) this.sendingChats.set(chat, remaining);
      else this.sendingChats.delete(chat);
    }
  }

  private branchInput(chat: string, agentId: string): Pick<SendInput, "branch" | "branchFork" | "briefing"> {
    const state = readProjectState(this.host.info.dir);
    const info = state.chats?.find(c => c.id === chat);
    const branch = info?.activeBranch ?? "0";
    if (!info?.branches) return {};
    const branchFork = state.branchSources?.[chat]?.[branch]?.resumes[agentId];
    const events = this.host.log.list({ chat, kinds: ["message"] });
    // The current prompt is already logged. Only earlier messages belong in the briefing.
    const prompt = events.filter(e => !e.agentId && e.payload.author === "user").at(-1);
    return { branch, ...(branchFork ? { branchFork } : {}), briefing: branchBriefing(info, events, prompt?.id ?? Infinity) };
  }

  private async send(
    text: string,
    agentId?: string,
    opts: TurnOptions = {},
  ): Promise<TurnResult> {
    if (opts.model !== undefined || opts.effort !== undefined) {
      const target = agentId ?? this.host.chatBinding(opts.chat).agentId ?? this.host.validHolder() ?? this.host.defaultAdapterId();
      try {
        const selection = this.host.bindable(target, opts.model, opts.effort);
        opts = { ...opts, model: selection.model, effort: selection.effort };
      } catch (error) {
        throw new ContinuityError("invalid", error instanceof Error ? error.message : String(error));
      }
    }
    const chosen = agentId ?? this.host.chatBinding(opts.chat).agentId ?? this.host.validHolder() ?? this.host.defaultAdapterId();
    const cfg = this.host.config.agents.find(a => a.id === chosen);
    const binding = this.host.chatBinding(opts.chat);
    // Keep explicit/chat selections separate from adapter defaults: a captured
    // null means use the agent default, even if the chat is edited while queued.
    const selectedModel = opts.capturedModel !== undefined ? opts.capturedModel
      : opts.model ?? (binding.agentId === chosen ? binding.model : undefined);
    const inheritedModel = selectedModel ?? cfg?.options?.model;
    if (opts.capturedModel === undefined && selectedModel) opts = { ...opts, model: resolveModel(selectedModel) };
    if (opts.capturedModel) opts = { ...opts, capturedModel: resolveModel(opts.capturedModel) };
    if (opts.effort === undefined && !(binding.agentId === chosen && binding.effort) && !cfg?.options?.effort && ["echo", "claude-code", "codex", "antigravity-cli"].includes(cfg?.kind ?? ""))
      opts = { ...opts, effort: this.host.config.defaultEffort };
    const capModel = typeof inheritedModel === "string" ? resolveModel(inheritedModel) : undefined;
    // Claim preparation synchronously, before an asynchronous cap read. Existing
    // turns retain their ownership; a second send will join their queue below.
    const preparingAgent = this.host.agent(chosen);
    const ownsPreparation = !this.busySince.has(chosen);
    if (ownsPreparation) this.busySince.set(chosen, Date.now());
    try {
      const cap = enforceModelCap(capModel);
      if (cap) await cap;
      const qualifiedCap = cfg?.kind === "model" && capModel
        ? enforceModelCap(`${cfg.options?.provider ?? "openrouter"}/${capModel}`) : undefined;
      if (qualifiedCap) await qualifiedCap;
      if (!this.host.isCurrentAgent(preparingAgent)) throw new Error(`agent "${chosen}" is no longer active`);
    } finally {
      if (ownsPreparation) this.busySince.delete(chosen);
    }
    if (this.host.continuity) return this.sendContinuity(text, agentId, opts);
    const source = opts.source ?? "user";
    const chat = opts.chat ?? MAIN_CHAT;
    // A thread that named an agent answers with that agent, whoever holds the
    // baton — which is what lets two threads talk to two agents at once. An
    // explicit target still wins: you asked for that one.
    const bound = this.host.chatBinding(chat);
    let target = agentId ?? bound.agentId ?? this.host.validHolder() ?? this.host.defaultAdapterId();
    const model = opts.capturedModel !== undefined ? opts.capturedModel : opts.model ?? (bound.agentId === target ? bound.model : undefined);
    const effort = opts.capturedEffort !== undefined ? opts.capturedEffort : opts.effort ?? (bound.agentId === target ? bound.effort : undefined);
    const agent = this.host.agent(target);
    if (!isAdapter(agent)) {
      throw new Error(`agent "${target}" is a bridge (read-only) — it cannot take turns`);
    }
    // Before anything is committed — the baton, the message in the thread, the
    // process — check the agent can afford the turn. Refusing after the message
    // is logged would leave a prompt in the conversation that nothing answers.
    this.host.enforceQuarantine(target);
    this.host.enforceBudget(target);
    const kind = this.host.config.agents.find((a) => a.id === target)?.kind ?? "";
    if (this.host.teamPolicy && !agentAllowed(this.host.teamPolicy, kind)) {
      throw new Error(`team policy doesn't allow ${kind} on this repo (loom.team.json)`);
    }

    // The baton is the write lock for work that touches the repository. A
    // thread pinned to an agent doesn't need it to answer a question, and
    // taking it would stop the agent that IS working — so a pinned thread
    // leaves it alone, and the thread that isn't pinned behaves as it always
    // has.
    const pinned = !agentId && bound.agentId === target;
    if (!pinned) {
      const holder = this.host.validHolder();
      if (holder === null) {
        this.host.baton.acquire(target);
      } else if (holder !== target) {
        throw new NotHolderError(target, holder);
      }
    }

    // The agent is mid-turn: queue the prompt, in order, and run it when the
    // turn ends. It used to go straight to the adapter, which threw "busy" into
    // an error event — the prompt was lost while the send had said 200.
    // Answering while the agent is still busy is still answering.
    if (source === "user") this.host.releaseQuestionHold(target);
    // A turn blocked on a question the agent asked through its tool won't end
    // until that question is answered — so a message queued behind it would
    // wait forever. What you type in that chat IS the answer: it goes to the
    // question, and the turn carries on.
    const open = source === "user" && !opts.fromQueue && this.busySince.has(target) ? this.host.openQuestion(target) : undefined;
    if (open && open.chat === chat) {
      this.host.log.append({ kind: "message", chat, payload: { text, author: "user", answers: open.requestId } });
      await this.host.answerQuestion(target, chat, open.requestId, Object.fromEntries((open.ids.length ? open.ids : ["0"]).map((id) => [id, text])));
      return { agentId: target, answered: true };
    }
    // It shows in the queue, editable, and enters the thread when it's sent.
    if (!opts.fromQueue && this.busySince.has(target)) {
      const item = this.host.queue.add({
        text,
        target: { kind: "agent", agentId: target },
        chat,
        source,
        model: model ?? null,
        effort: effort ?? null,
        ...(opts.plan ? { plan: true } : {}),
        ...(opts.length ? { length: opts.length } : {}),
        ...(opts.by ? { by: opts.by } : {}),
      });
      return { agentId: target, queued: this.host.queue.length, queueId: item.id, requestId: `queue:${item.id}` };
    }

    // A user reply to a paused route's question resumes the route — and to an
    // agent's own question, the queue it was holding.
    if (source === "user") {
      this.host.routes.onUserMessage(target, chat);
      this.host.releaseQuestionHold(target);
    }

    // everything this turn produces belongs to the chat you sent from
    this.turnChat.set(target, chat);
    this.turnModel.set(target, model ?? undefined);
    this.busySince.set(target, Date.now()); // the stale-session clock starts
    this.host.log.append({ kind: "status", agentId: target, chat, payload: { state: "turn_started", ...(opts.requestId ? { requestId: opts.requestId } : {}) } });
    const promptEvent = this.host.log.append({
      kind: "message",
      chat,
      payload: { text, author: source === "route" ? "loom" : "user", ...(opts.fromQueue ? { fromQueue: true } : {}), ...(opts.by ? { by: opts.by } : {}) },
    });
    const preparation = new AbortController();
    this.preparing.set(target, preparation);
    const assertPrepared = () => {
      if (preparation.signal.aborted || this.host.closed || !this.host.isCurrentAgent(agent)) {
        throw new Error(`dispatch preparation for "${target}" was cancelled or replaced`);
      }
    };
    let mcp: ReturnType<typeof writeLoomMcpSession> = null;
    try {
      await this.host.ensureStarted(target);
      assertPrepared();
      if (!this.host.isCurrentAgent(agent)) throw new Error(`agent "${target}" is no longer active`);

      const branchInput = this.branchInput(chat, target);
      if (agent instanceof AgentBase && !(agent instanceof ProviderAgent)) agent.scopeConversation(chat, branchInput.branch);
      const pendingBriefing = [this.host.consumePendingBriefing(target), this.host.chatMoveBriefing(chat)].filter(Boolean).join("\n\n");
      // Prepend the enabled skills so every turn carries them, alongside any
      // one-shot handoff briefing. Empty when no skills are on.
      // A provider agent plans in its own plan mode; the plan it proposes is
      // saved under plans/ by the runtime. Other agents get Loom's briefing.
      const nativePlan = Boolean(opts.plan) && agent instanceof ProviderAgent;
      const memoryQuery = this.host.log.list({ chat, kinds: ["message"], activeLineages: true, limit: 8 })
        .map(e => String(e.payload.text ?? "").slice(-2000)).join("\n");
      const memoryBrief = await this.host.turnMemoryBrief?.(memoryQuery || text, target, chat, promptEvent.id);
      const briefing =
        [memoryBrief?.briefing, this.host.agentInstructions(target), this.host.chatInstructions(chat), this.host.activeSkillsBlock(), pendingBriefing, branchInput.briefing, opts.plan && !nativePlan ? planModeBriefing(text) : "", lengthLine(opts.length)]
          .filter(Boolean)
          .join("\n")
          .trim() || undefined;
      // The project's configured MCP servers, rendered to a temp config file the
      // adapter hands to its CLI. Null when nothing is configured — or when this
      // adapter's CLI has no flag for it, because an "MCP attached" note on a
      // turn that dropped the config would be the same lie in a new place.
      mcp = agent.capabilities.mcp ? writeLoomMcpSession(this.host.healthyMcps(), this.host.config.loomTools ? { project: this.host.info.id, api: this.host.apiUrl() } : undefined) : null;
      // The thread's model, only ever to an adapter that can act on it — see
      // bindable(), which is where a model that couldn't be honoured is refused.
      const input: SendInput = {
        text,
        chat,
        ...branchInput,
        ...(nativePlan ? { interactionMode: "plan" as const } : {}),
        ...(opts.fresh ? { freshSession: true } : {}),
        ...(briefing ? { briefing } : {}),
        ...(model ? { model } : {}),
        ...(effort ? { effort } : {}),
        ...(mcp ? { mcp: { configPath: mcp.configPath, servers: mcp.servers } } : {}),
      };
      if (mcp) {
        this.host.log.append({
          kind: "status",
          agentId: target,
          payload: { state: "mcp_attached", servers: mcp.servers.map((s) => s.name) },
        });
      }
      // Snapshot the tree so this prompt's changes can be attributed to it.
      if (this.host.config.git?.branchPerChat) await selectChatBranch(this.host.agentDir(target), chat, false);
      this.preTurnTree.set(target, await contentSnapshot(this.host.agentDir(target)));
      assertPrepared();
      // The durable checkpoint also makes this turn rewindable after a restart.
      await this.checkpointBefore(target, text);
      assertPrepared();
      // Fire-and-notify: the turn runs in the background; progress streams
      // into the log and completion lands as run_complete.
      if (!this.host.isCurrentAgent(agent)) throw new Error(`agent "${target}" is no longer active`);
      void Promise.resolve()
        .then(() => {
          assertPrepared();
          this.preparing.delete(target);
          if (!this.host.isCurrentAgent(agent)) throw new Error(`agent "${target}" is no longer active`);
          this.host.clearChatMoveBriefing(chat);
          memoryBrief?.record();
          return runAttempts(agent, input, agentPolicy(this.host.info.dir, target), {
            dir: this.host.agentDir(target), budget: () => this.host.enforceBudget(target),
            current: () => this.host.isCurrentAgent(agent),
            say: e => this.attemptEvent(agent, chat, e),
            interrupted: () => this.interruptAgent(target, chat),
            abandoned: () => {
              this.host.appendIfOpen({ kind: "status", agentId: target, chat, payload: { state: "interrupted" } });
              this.busySince.delete(target);
              this.turnModel.delete(target);
              this.host.kickQueue();
            },
          });
        })
        .catch((error) => this.host.dispatchFailed(agent, chat, error))
        // The config file exists for exactly this turn. Cleaned up whether the
        // turn succeeded, failed or was interrupted — a temp file per turn that
        // nothing removes is a slow leak of the project's server URLs.
        .finally(() => {
          if (this.preparing.get(target) === preparation) this.preparing.delete(target);
          mcp?.cleanup();
          this.host.kickQueue();
        });
      return { agentId: target, ...(opts.requestId ? { requestId: opts.requestId } : {}) };
    } catch (error) {
      if (this.preparing.get(target) === preparation) this.preparing.delete(target);
      mcp?.cleanup();
      this.host.dispatchFailed(agent, chat, error);
      throw error;
    }
  }

  private async sendContinuity(text: string, agentId: string | undefined, opts: TurnOptions): Promise<TurnResult> {
    const brain = this.host.continuity!;
    const chat = opts.chat ?? MAIN_CHAT, source = opts.source ?? "user";
    if (!this.host.chatExists(chat)) throw new ContinuityError("invalid", "conversation is missing or deleted; create a chat before dispatching");
    const bound = this.host.chatBinding(chat);
    const target = agentId ?? bound.agentId ?? this.host.validHolder() ?? this.host.defaultAdapterId();
    const agent = this.host.agent(target);
    const cfg = this.host.config.agents.find(a => a.id === target)!;
    if (!isAdapter(agent) || !isNativeKind(cfg.kind))
      throw new ContinuityError("unsupported", "native continuity supports Codex, Claude Code and OpenCode; bridges and model agents use the legacy workflow");
    if (/^\[(?:image|file)\]\s/m.test(text))
      throw new ContinuityError("unsupported", "attachment continuity is not verified for these CLI protocols; use an ordinary workspace file reference or the legacy attachment workflow");
    if (Array.isArray(cfg.options?.extraArgs) && cfg.options.extraArgs.length)
      throw new ContinuityError("unsupported", "arbitrary CLI arguments have unverified session/context semantics; remove extraArgs for native continuity");
    this.host.enforceQuarantine(target); this.host.enforceBudget(target);
    if (this.host.teamPolicy && !agentAllowed(this.host.teamPolicy, cfg.kind)) throw new Error(`team policy doesn't allow ${cfg.kind}`);
    // Every check that can refuse the turn runs before the request enters the
    // conversation: a refused request must not become history.
    const health = await this.host.harness(target);
    if (!health.available) throw new ContinuityError("unsupported", health.error ?? `${cfg.kind} CLI is not reachable`);
    if (this.busySince.size && (!opts.requestId || !brain.store.request(opts.requestId))) this.host.queue.assertCanAdd({ text });
    const effort = opts.capturedEffort !== undefined ? opts.capturedEffort : opts.effort ?? (bound.agentId === target ? bound.effort : undefined);
    const captured = brain.capture({ id: opts.requestId ?? randomUUID(), conversationId: chat, agentInstanceId: target,
      text, source, ...(effort ? { effort } : {}),
      model: opts.capturedModel !== undefined ? opts.capturedModel : opts.model ?? (bound.agentId === target ? bound.model ?? null : null),
      plan: Boolean(opts.plan), targetAddedTokens: 6000 });
    const request = captured.request;
    const previous = brain.store.receipts(request.id).at(-1);
    const status = (continuityStatus: string): TurnResult => ({ agentId: target, requestId: request.id, continuityStatus,
      ...(previous ? { receiptId: previous.id, packetId: previous.packetId } : {}) });
    // A retried ID is a no-op only while that request is live or was submitted.
    // An unsent one (refused, overflowed, failed before launch) runs again.
    if (!captured.created && !opts.fromQueue &&
      (this.inFlight.has(request.id) || this.host.queue.snapshot().items.some(i => i.continuity?.requestId === request.id)))
      return status(this.inFlight.has(request.id) ? "preparing" : "queued");
    if (previous && (previous.status === "accepted" || previous.status === "submitting" || previous.status === "outcome_unknown"))
      return status(previous.status);
    // Default sequential foreground execution. A pinned chat does not bypass a
    // workspace's writer lock. The queued target/model remain those captured now.
    if (this.busySince.size) {
      if (opts.fromQueue) throw new ContinuityError("conflict", "another foreground turn is preparing or running");
      const item = this.host.queue.add({ text, target: { kind: "agent", agentId: target }, chat, source,
        model: request.model, effort: request.effort ?? null,
        ...(opts.plan ? { plan: true } : {}), ...(opts.length ? { length: opts.length } : {}), ...(opts.by ? { by: opts.by } : {}), continuity: { requestId: request.id, model: request.model, effort: request.effort } });
      return { agentId: target, queued: this.host.queue.length, queueId: item.id, requestId: request.id };
    }
    this.busySince.set(target, Date.now()); this.turnChat.set(target, chat);
    this.turnModel.set(target, request.model ?? undefined);
    this.inFlight.add(request.id);
    const preparation = new AbortController(); this.preparing.set(target, preparation);
    const assertPrepared = () => { if (preparation.signal.aborted || this.host.closed || !this.host.isCurrentAgent(agent))
      throw new ContinuityError("conflict", "native dispatch preparation was cancelled or replaced"); };
    let mcp: ReturnType<typeof writeLoomMcpSession> = null, runId: string | undefined;
    try {
      const options = structuredClone(this.host.nativeOptions(target));
      const holder = this.host.validHolder();
      if (holder && holder !== target) await this.host.handoff(target, { source });
      else if (!holder) this.host.baton.acquire(target);
      await this.host.ensureStarted(target);
      assertPrepared();
      if (!this.host.isCurrentAgent(agent)) throw new Error("native target was replaced before dispatch");
      // Snapshot/checkpoint is complete before the frozen context is observed.
      if (this.host.config.git?.branchPerChat) await selectChatBranch(this.host.agentDir(target), chat, false);
      this.preTurnTree.set(target, await contentSnapshot(this.host.agentDir(target)));
      await this.checkpointBefore(target, text);
      assertPrepared();
      const nativePlan = Boolean(opts.plan) && agent instanceof ProviderAgent;
      const memoryBrief = await this.host.turnMemoryBrief?.(text, target, chat, captured.event.id, true);
      const supplement = [memoryBrief?.briefing, this.host.chatMoveBriefing(chat), this.host.agentInstructions(target), this.host.chatInstructions(chat), this.host.activeSkillsBlock(), opts.plan && !nativePlan ? planModeBriefing(text) : "", lengthLine(opts.length)].filter(Boolean).join("\n");
      let prepared = await brain.prepare({ ...request, targetAddedTokens: opts.contextTarget ?? request.targetAddedTokens }, cfg.kind,
        this.host.agentDir(target), options, supplement);
      assertPrepared();
      const finishOverflow = (): TurnResult => {
        this.preparing.delete(target); this.busySince.delete(target); this.inFlight.delete(request.id); mcp?.cleanup();
        this.host.kickQueue();
        return { agentId: target, requestId: request.id, receiptId: prepared.receipt.id,
          packetId: prepared.packet.id, continuityStatus: "overflow" };
      };
      if (prepared.packet.budget.overflow === "mandatory") return finishOverflow();
      if (!this.host.isCurrentAgent(agent)) throw new Error("native target was replaced before submission");
      mcp = agent.capabilities.mcp ? writeLoomMcpSession(this.host.healthyMcps(), this.host.config.loomTools ? { project: this.host.info.id, api: this.host.apiUrl() } : undefined) : null;
      let continuity: NonNullable<SendInput["continuity"]>;
      // Reassembly is safe only before submission intent exists. Never retry a
      // submitted action automatically, even when its acknowledgement is lost.
      for (let attempt = 0; ; attempt++) {
        try { continuity = await brain.submit(prepared, preparation.signal); break; }
        catch (error) {
          assertPrepared();
          if (!(error instanceof ContinuityError) || error.code !== "stale" || attempt >= 2) throw error;
          prepared = await brain.prepare({ ...request, targetAddedTokens: opts.contextTarget ?? request.targetAddedTokens }, cfg.kind,
            this.host.agentDir(target), options, supplement);
          assertPrepared();
          if (prepared.packet.budget.overflow === "mandatory") return finishOverflow();
        }
      }
      runId = continuity.runId;
      this.preparing.delete(target);
      const branchInput = this.branchInput(chat, target);
      if (agent instanceof AgentBase && !(agent instanceof ProviderAgent)) agent.scopeConversation(chat, branchInput.branch);
      const input: SendInput = { text, chat, ...branchInput, continuity, ...(nativePlan ? { interactionMode: "plan" as const } : {}),
        ...(request.model ? { model: request.model } : {}), ...(request.effort ? { effort: request.effort } : {}), ...(mcp ? { mcp: { configPath: mcp.configPath, servers: mcp.servers } } : {}) };
      // Never consume a legacy handoff briefing into the new packet path.
      this.host.pendingBriefings.delete(target);
      if (source === "user") { this.host.routes.onUserMessage(target, chat); this.host.releaseQuestionHold(target); }
      this.host.log.append({ kind: "status", agentId: target, chat, payload: { state: "turn_started", requestId: request.id } });
      void Promise.resolve().then(() => {
        if (preparation.signal.aborted || this.host.closed || !this.host.isCurrentAgent(agent))
          throw new NativeDispatchRejected("dispatch cancelled before native process launch");
        this.host.clearChatMoveBriefing(chat);
        memoryBrief?.record();
        return runAttempts(agent, input, agentPolicy(this.host.info.dir, target), {
          dir: this.host.agentDir(target), budget: () => this.host.enforceBudget(target),
          current: () => this.host.isCurrentAgent(agent),
          say: e => this.attemptEvent(agent, chat, e),
          interrupted: () => this.interruptAgent(target, chat),
          abandoned: () => {
            this.host.appendIfOpen({ kind: "status", agentId: target, chat, payload: { state: "interrupted" } });
            this.busySince.delete(target);
            this.turnModel.delete(target);
            this.host.kickQueue();
          },
          retryInput: async (failure, signal) => {
            brain.settled(continuity.runId, new Error(failure));
            await this.postTurn.get(target);
            if (signal.aborted || !this.host.isCurrentAgent(agent)) throw new NativeDispatchRejected("retry cancelled");
            this.host.enforceBudget(target);
            const retry = brain.capture({ ...request, id: randomUUID() });
            const next = await brain.prepare(retry.request, cfg.kind, this.host.agentDir(target), options, supplement);
            if (next.packet.budget.overflow === "mandatory") throw new Error("retry context exceeds the model budget");
            continuity = await brain.submit(next, signal);
            runId = continuity.runId;
            this.preTurnTree.set(target, await contentSnapshot(this.host.agentDir(target)));
            return { ...input, continuity };
          },
        });
      }).then(() => {
        if (!this.host.closed) brain.settled(continuity.runId);
      }, error => {
        if (!this.host.closed) brain.settled(continuity.runId, error);
        this.host.dispatchFailed(agent, chat, error);
      }).finally(async () => {
        mcp?.cleanup();
        await this.postTurn.get(target);
        this.postTurn.delete(target);
        // Native error events may arrive before the process exits. Only this
        // settlement releases the runtime's foreground preparation barrier.
        this.inFlight.delete(request.id);
        if (!this.host.closed && this.host.isCurrentAgent(agent)) {
          this.busySince.delete(target); this.host.kickQueue();
        }
      });
      return { agentId: target, requestId: request.id, receiptId: prepared.receipt.id,
        packetId: prepared.packet.id, continuityStatus: "submitting" };
    } catch (error) {
      this.preparing.delete(target);
      this.inFlight.delete(request.id);
      mcp?.cleanup();
      if (runId) brain.settled(runId, error);
      this.host.dispatchFailed(agent, chat, error);
      throw error;
    }
  }

  /** Adapters that look hung: busy far longer than any plausible turn. */
  staleSessions(now = Date.now()): Array<{ agentId: string; busyMs: number }> {
    const out: Array<{ agentId: string; busyMs: number }> = [];
    for (const [agentId, since] of this.busySince) {
      const live = this.host.agents.get(agentId);
      if (!live || !isAdapter(live) || !live.busy()) continue;
      const busyMs = now - since;
      if (busyMs >= this.host.staleTurnMs) out.push({ agentId, busyMs });
    }
    return out;
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
    const events = this.host.log.list({ limit: 200 });
    // Pair the last error with the prompt in its own chat and turn boundary.
    // Route-authored messages count too — a failed route step can be retried elsewhere.
    let errorAt = -1;
    for (let i = events.length - 1; i >= 0; i--) {
      if (events[i]!.kind === "error") { errorAt = i; break; }
    }
    if (errorAt === -1) throw new Error("no failed turn to retry");
    const err = events[errorAt]!;
    let prompt: string | undefined;
    for (let i = errorAt - 1; i >= 0; i--) {
      const e = events[i]!;
      if ((e.chat ?? MAIN_CHAT) !== (err.chat ?? MAIN_CHAT)) continue;
      if (e.kind === "status" && e.payload.state === "turn_started" && e.agentId === err.agentId) break;
      if (e.kind === "message" && !e.agentId) {
        prompt = String(e.payload.text ?? "");
        break;
      }
    }
    if (!prompt?.trim()) throw new Error("could not find the prompt that failed");

    await this.host.handoff(toAgentId, { source: "user" });
    const failedAgent = err.agentId ?? "the previous agent";
    const failure = String(err.payload.message ?? "unknown error").slice(0, 500);
    const prior = this.host.pendingBriefings.get(toAgentId);
    this.host.pendingBriefings.set(
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

  /** Policy interruption targets one turn and never pauses user queues or routes. */
  async interruptAgent(agentId: string, chat: string): Promise<boolean> {
    if ((this.turnChat.get(agentId) ?? MAIN_CHAT) !== chat) return false;
    const pending = this.preparing.get(agentId);
    if (pending) { pending.abort(); return true; }
    const agent = this.host.agents.get(agentId);
    if (!agent || !isAdapter(agent) || !(agent.busy() || waitingForSlot(agent))) return false;
    await agent.interrupt();
    return true;
  }

  async interrupt(
    opts: { source?: "user" | "route"; chat?: string } = {},
  ): Promise<{ interrupted: string | null }> {
    // Stop in one chat stops that chat's turn — not whatever the baton holder
    // is doing in another thread.
    if ((opts.source ?? "user") === "user" && this.host.queue.length && !this.host.queue.paused) {
      this.host.queue.setPaused(true, "you pressed Stop — resume to run what's queued");
      const holder = this.host.validHolder();
      this.host.log.append({ kind: "status", ...(holder ? { agentId: holder } : {}), ...(opts.chat ? { chat: opts.chat } : {}), payload: { state: "queue_paused", waiting: this.host.queue.length } });
    }
    if (opts.chat) {
      for (const [id, chat] of this.turnChat) {
        if ((chat ?? "main") !== opts.chat) continue;
        const a = this.host.agents.get(id);
        // a turn still waiting for a daemon slot is this chat's turn too (#431)
        if (a && isAdapter(a) && (a.busy() || waitingForSlot(a))) {
          if ((opts.source ?? "user") === "user") this.host.routes.onManualInterrupt();
          await a.interrupt();
          return { interrupted: id };
        }
      }
      const pendingHere = [...this.preparing.entries()].find(([id]) => (this.turnChat.get(id) ?? "main") === opts.chat);
      if (pendingHere) { pendingHere[1].abort(); return { interrupted: pendingHere[0] }; }
      return { interrupted: null };
    }
    if ((opts.source ?? "user") === "user") this.host.routes.onManualInterrupt();
    const pending = this.preparing.entries().next().value;
    if (pending) {
      pending[1].abort();
      if ((opts.source ?? "user") === "user" && this.host.queue.length) this.host.queue.setPaused(true, "you pressed Stop during dispatch preparation");
      return { interrupted: pending[0] };
    }
    const holder = this.host.validHolder();
    if (!holder) return { interrupted: null };
    const agent = this.host.agent(holder);
    if (isAdapter(agent) && (agent.busy() || waitingForSlot(agent))) {
      await agent.interrupt();
      return { interrupted: holder };
    }
    return { interrupted: null };
  }

  /** The chat an agent's current (or last) turn belongs to, if any. */
  chatOf(agentId: string): string | undefined {
    return this.turnChat.get(agentId);
  }
}
