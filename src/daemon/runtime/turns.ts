import { BatonManager, NotHolderError } from "../../core/baton.js";
import * as checkpoints from "../../core/checkpoint.js";
import type { EventJournal } from "../../core/eventlog.js";
import { push as gitPush, stageAndCommitFiles } from "../../core/git.js";
import { logbook } from "../../core/logbook.js";
import { writeMcpSession } from "../../core/mcp.js";
import {
  PromptQueue
} from "../../core/prompt-queue.js";
import { RouteEngine } from "../../core/routes.js";
import { NO_CHANGES, type TurnFacts } from "../../core/step-conditions.js";
import { agentAllowed, type TeamPolicy } from "../../core/team-policy.js";
import { type MergeOutcome } from "../../core/worktree-merge.js";
import {
  diffSinceSnapshot,
  porcelainStatus,
  type TurnDiff
} from "../../core/worktree.js";
import type {
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
  /** How long you asked this one answer to be. */
  length?: "brief" | "detailed";
  requestId?: string; capturedModel?: string | null; resume?: boolean; contextTarget?: number;
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
  agentDir: (agentId: string) => string;
  log: EventJournal;
  info: ProjectInfo;
  extractMemory: (agentId: string, files: string[]) => void;
  config: ProjectConfig;
  chatBinding: (chat?: string) => { agentId?: string; model?: string; };
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
  consumePendingBriefing: (agentId: string) => string | undefined;
  activeSkillsBlock: () => string;
  /** The agent's standing instructions block ("" when it has none). */
  agentInstructions: (agentId: string) => string;
  healthyMcps: () => McpServerConfig[];
  appendIfOpen: (event: Parameters<EventJournal["append"]>[0]) => void;
  agents: ReadonlyMap<string, AnyAgent>;
  handoff: (to: string, opts?: { source?: "user" | "route"; }) => Promise<{ from: string | null; merge?: MergeOutcome; }>;
  pendingBriefings: Map<string, string>;
}

/** Owns turns state for exactly one open project. */
export class RuntimeTurns {
  constructor(private readonly host: RuntimeTurnsHost) { }

  /**
   * Which conversation each agent's current turn belongs to. Set when a turn
   * starts and left in place afterwards — an agent's trailing events (a late
   * run_complete, a diff) still belong to the chat that prompted them.
   */
  turnChat = new Map<string, string>();

  // A turn's cost lands on a `turn_cost` status just before its `run_complete`
  // (the CLI reports it mid-stream). We hold it here so the completed turn — and
  // therefore its exported gen_ai span — carries the real cost, not just tokens.
  pendingCost = new Map<string, number>();

  // Turn text accumulated per agent (from its message events) so we can extract
  // structured decisions once the turn completes. Reset after each run_complete.
  turnText = new Map<string, string>();

  /** Pre-turn porcelain snapshots, for per-prompt diff attribution. */
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

  /** App-owned diff/commit writes finish before the next native writer starts. */
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
        agentId,
        payload: { id: cp.id, label: cp.label, at: cp.at, dirty: cp.dirty, branch: cp.branch, reason: "before_turn" },
      });
    } catch {
      /* never the reason a turn doesn't run */
    }
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
    const pending = diffSinceSnapshot(this.host.agentDir(agentId), before).catch(() => null);
    this.lastTurnDiff.set(agentId, pending);
    const finalized = pending
      .then(async (diff) => {
        if (this.host.closed) return;
        if (diff) {
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
              // The point these changes can be put back to, when there is one
              // — a project that isn't a git repo has no checkpoint to offer.
              ...(checkpoint ? { checkpoint } : {}),
            },
          });
          await this.commitTurn(agentId, diff.files.map((f) => f.path));
        }
        // Learn from the turn once we know which files it touched — the files
        // sharpen candidate retrieval. Runs after the diff so recentTurnFiles
        // isn't needed; the files are right here.
        this.host.extractMemory(agentId, (diff?.files ?? []).map((f) => f.path));
      })
      .catch(() => this.host.extractMemory(agentId, []));
    this.postTurn.set(agentId, finalized);
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
  async commitTurn(agentId: string, files: string[]): Promise<void> {
    const delivery = this.host.config.git?.delivery ?? "none";
    if ((!this.host.config.git?.commitPerTurn && delivery === "none") || !files.length) return;
    try {
      const events = this.host.log.list({ limit: 60 });
      const prompt =
        [...events].reverse().find((e) => e.kind === "message" && !e.agentId)?.payload.text ?? "";
      const subject = String(prompt).split("\n")[0]!.slice(0, 68) || `work by ${agentId}`;
      const cfg = this.host.config.agents.find((a) => a.id === agentId);
      const message =
        `${subject}\n\n` +
        `Turn by ${agentId}${cfg ? ` (${cfg.kind})` : ""} in Loom.\n` +
        `Co-Authored-By: ${agentId} <${agentId}@loom.local>`;
      await stageAndCommitFiles(this.host.agentDir(agentId), files, message);
      this.host.log.append({
        kind: "status",
        agentId,
        payload: { state: "turn_committed", files: files.length, subject },
      });
      // "push" delivers each committed turn; "pr" leaves pushing to the
      // orchestra's branch (a PR per turn is the flood teams complain about).
      if (delivery === "push") {
        const pushed = await gitPush(this.host.agentDir(agentId));
        this.host.log.append({ kind: "status", agentId, payload: { state: "turn_pushed", branch: pushed.branch } });
      }
    } catch (err) {
      // A commit that can't happen (not a repo, hooks failed, nothing staged
      // after filters) is a Console line, never a failed turn.
      logbook.warn(
        "git",
        `turn commit skipped for ${agentId}`,
        err instanceof Error ? err.message : String(err),
        this.host.info.id,
      );
    }
  }

  async sendMessage(
    text: string,
    agentId?: string,
    opts: TurnOptions = {},
  ): Promise<TurnResult> {
    if (this.host.continuity) return this.sendContinuity(text, agentId, opts);
    const source = opts.source ?? "user";
    const chat = opts.chat ?? MAIN_CHAT;
    // A thread that named an agent answers with that agent, whoever holds the
    // baton — which is what lets two threads talk to two agents at once. An
    // explicit target still wins: you asked for that one.
    const bound = this.host.chatBinding(chat);
    let target = agentId ?? bound.agentId ?? this.host.validHolder() ?? this.host.defaultAdapterId();
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
        ...(opts.plan ? { plan: true } : {}),
        ...(opts.length ? { length: opts.length } : {}),
      });
      return { agentId: target, queued: this.host.queue.length, queueId: item.id };
    }

    // A user reply to a paused route's question resumes the route — and to an
    // agent's own question, the queue it was holding.
    if (source === "user") {
      this.host.routes.onUserMessage(target);
      this.host.releaseQuestionHold(target);
    }

    // everything this turn produces belongs to the chat you sent from
    this.turnChat.set(target, chat);
    this.busySince.set(target, Date.now()); // the stale-session clock starts
    this.host.log.append({
      kind: "message",
      chat,
      payload: { text, author: source === "route" ? "loom" : "user", ...(opts.fromQueue ? { fromQueue: true } : {}) },
    });
    let mcp: ReturnType<typeof writeMcpSession> = null;
    try {
      await this.host.ensureStarted(target);
      if (!this.host.isCurrentAgent(agent)) throw new Error(`agent "${target}" is no longer active`);

      const pendingBriefing = this.host.consumePendingBriefing(target);
      // Prepend the enabled skills so every turn carries them, alongside any
      // one-shot handoff briefing. Empty when no skills are on.
      // A provider agent plans in its own plan mode; the plan it proposes is
      // saved under plans/ by the runtime. Other agents get Loom's briefing.
      const nativePlan = Boolean(opts.plan) && agent instanceof ProviderAgent;
      const briefing =
        [this.host.agentInstructions(target), this.host.activeSkillsBlock(), pendingBriefing, opts.plan && !nativePlan ? planModeBriefing(text) : "", lengthLine(opts.length)]
          .filter(Boolean)
          .join("\n")
          .trim() || undefined;
      // The project's configured MCP servers, rendered to a temp config file the
      // adapter hands to its CLI. Null when nothing is configured — or when this
      // adapter's CLI has no flag for it, because an "MCP attached" note on a
      // turn that dropped the config would be the same lie in a new place.
      mcp = agent.capabilities.mcp ? writeMcpSession(this.host.healthyMcps()) : null;
      // The thread's model, only ever to an adapter that can act on it — see
      // bindable(), which is where a model that couldn't be honoured is refused.
      const perTurnModel = bound.agentId === target ? bound.model : undefined;
      const input: SendInput = {
        text,
        chat,
        ...(nativePlan ? { interactionMode: "plan" as const } : {}),
        ...(briefing ? { briefing } : {}),
        ...(perTurnModel ? { model: perTurnModel } : {}),
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
      this.preTurnTree.set(target, await porcelainStatus(this.host.agentDir(target)));
      // …and a checkpoint you can actually go back to. The porcelain snapshot
      // above only says *which* paths changed; this holds their content, so
      // "undo what that turn did" is a click rather than a re-typing (#101).
      await this.checkpointBefore(target, text);
      // Fire-and-notify: the turn runs in the background; progress streams
      // into the log and completion lands as run_complete.
      if (!this.host.isCurrentAgent(agent)) throw new Error(`agent "${target}" is no longer active`);
      void Promise.resolve()
        .then(() => {
          if (!this.host.isCurrentAgent(agent)) throw new Error(`agent "${target}" is no longer active`);
          return agent.send(input);
        })
        .catch((error) => this.host.dispatchFailed(agent, chat, error))
        // The config file exists for exactly this turn. Cleaned up whether the
        // turn succeeded, failed or was interrupted — a temp file per turn that
        // nothing removes is a slow leak of the project's server URLs.
        .finally(() => mcp?.cleanup());
      return { agentId: target };
    } catch (error) {
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
    const captured = brain.capture({ id: opts.requestId ?? randomUUID(), conversationId: chat, agentInstanceId: target,
      text, source, model: opts.capturedModel !== undefined ? opts.capturedModel : bound.agentId === target ? bound.model ?? null : null,
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
        ...(opts.plan ? { plan: true } : {}), ...(opts.length ? { length: opts.length } : {}), continuity: { requestId: request.id, model: request.model } });
      return { agentId: target, queued: this.host.queue.length, queueId: item.id, requestId: request.id };
    }
    this.busySince.set(target, Date.now()); this.turnChat.set(target, chat);
    this.inFlight.add(request.id);
    const preparation = new AbortController(); this.preparing.set(target, preparation);
    const assertPrepared = () => { if (preparation.signal.aborted || this.host.closed || !this.host.isCurrentAgent(agent))
      throw new ContinuityError("conflict", "native dispatch preparation was cancelled or replaced"); };
    let mcp: ReturnType<typeof writeMcpSession> = null, runId: string | undefined;
    try {
      const options = structuredClone(this.host.nativeOptions(target));
      const holder = this.host.validHolder();
      if (holder && holder !== target) await this.host.handoff(target, { source });
      else if (!holder) this.host.baton.acquire(target);
      await this.host.ensureStarted(target);
      assertPrepared();
      if (!this.host.isCurrentAgent(agent)) throw new Error("native target was replaced before dispatch");
      // Snapshot/checkpoint is complete before the frozen context is observed.
      this.preTurnTree.set(target, await porcelainStatus(this.host.agentDir(target)));
      await this.checkpointBefore(target, text);
      assertPrepared();
      const nativePlan = Boolean(opts.plan) && agent instanceof ProviderAgent;
      const supplement = [this.host.agentInstructions(target), this.host.activeSkillsBlock(), opts.plan && !nativePlan ? planModeBriefing(text) : "", lengthLine(opts.length)].filter(Boolean).join("\n");
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
      mcp = agent.capabilities.mcp ? writeMcpSession(this.host.healthyMcps()) : null;
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
      const input: SendInput = { text, chat, continuity, ...(nativePlan ? { interactionMode: "plan" as const } : {}),
        ...(request.model ? { model: request.model } : {}), ...(mcp ? { mcp: { configPath: mcp.configPath, servers: mcp.servers } } : {}) };
      // Never consume a legacy handoff briefing into the new packet path.
      this.host.pendingBriefings.delete(target);
      if (source === "user") { this.host.routes.onUserMessage(target); this.host.releaseQuestionHold(target); }
      void Promise.resolve().then(() => {
        if (preparation.signal.aborted || this.host.closed || !this.host.isCurrentAgent(agent))
          throw new NativeDispatchRejected("dispatch cancelled before native process launch");
        return agent.send(input);
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

  async interrupt(
    opts: { source?: "user" | "route"; chat?: string } = {},
  ): Promise<{ interrupted: string | null }> {
    // Stop in one chat stops that chat's turn — not whatever the baton holder
    // is doing in another thread.
    if (opts.chat) {
      for (const [id, chat] of this.turnChat) {
        if ((chat ?? "main") !== opts.chat) continue;
        const a = this.host.agent(id);
        if (isAdapter(a) && a.busy()) {
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
    // Stop means stop: what's queued doesn't start after it — it waits,
    // paused, for you to resume, edit or clear it.
    if ((opts.source ?? "user") === "user" && this.host.queue.length && !this.host.queue.paused) {
      this.host.queue.setPaused(true, "you pressed Stop — resume to run what's queued");
      this.host.log.append({ kind: "status", agentId: holder, payload: { state: "queue_paused", waiting: this.host.queue.length } });
    }
    if (isAdapter(agent) && agent.busy()) {
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
