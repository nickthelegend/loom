/**
 * Runtime ingestion: canonical provider runtime events → Loom's event log.
 *
 * Loom's log, Brain and clients speak a small vocabulary (message, tool_call,
 * file_edit, status, run_complete, needs_input, error). This projects the
 * canonical stream onto it, so a provider change never reaches them. Streamed
 * text is assembled per item and persisted once, when the item completes; the
 * deltas themselves go to an ephemeral channel for live display.
 *
 * Follows t3code's orchestration/Layers/ProviderRuntimeIngestion.ts (MIT,
 * © T3 Tools Inc.): a message's text is its streamed deltas, and the completed
 * item's `detail` only stands in when nothing was streamed.
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type {
  CommandItemData, FileChangeItemData, InstanceId, ProviderKind, ProviderRuntimeEvent, ThreadId, ToolImage, ToolItemData,
} from "./contracts.js";
import { ContextArtifacts } from "../core/continuity/artifacts.js";

/** A Loom log event, before the log assigns id and time. */
export interface IngestedEvent {
  kind: "message" | "tool_call" | "file_edit" | "status" | "run_complete" | "needs_input" | "error";
  agentId: InstanceId;
  chat: ThreadId;
  payload: Record<string, unknown>;
}

/** Brain's correlation tags for a continuity turn; stamped on every event of the turn. */
export interface TurnTags { loomRunId: string; loomBindingId: string; loomSessionEpoch: number }

export interface LiveDelta {
  agentId: InstanceId;
  chat: ThreadId;
  turnId?: string;
  itemId?: string;
  streamKind: string;
  delta: string;
}

/** A tool's progress for live display: started, updated, finished. Not persisted; the finished tool is a tool_call. */
export interface LiveItem {
  agentId: InstanceId;
  chat: ThreadId;
  turnId?: string;
  itemId: string;
  phase: "started" | "updated" | "completed";
  itemType: string;
  title?: string;
  detail?: string;
  status?: string;
}

export interface IngestionOptions {
  /** Persist one Loom event. */
  append: (event: IngestedEvent) => void;
  /** Streamed text for live display; not persisted. */
  live?: (delta: LiveDelta) => void;
  /** Tool progress for live display; not persisted. */
  liveItem?: (item: LiveItem) => void;
  /** Where large command output is written, per agent (continuity turns only). */
  artifactDir?: (instanceId: InstanceId) => string | undefined;
}

const PROVIDER_ACCOUNT: Record<ProviderKind, string> = { codex: "codex", "claude-code": "claude" };
/** Items that are the agent doing something (as opposed to saying something). */
const TOOL_ITEMS = new Set(["command_execution", "file_change", "mcp_tool_call", "dynamic_tool_call", "collab_agent_tool_call", "web_search", "image_view"]);
const ARTIFACT_THRESHOLD = 100_000;
/** What the thread keeps of a tool's output: enough to read, not a log dump. */
const OUTPUT_PREVIEW = 4_000;
const DIFF_PREVIEW = 20_000;

/** The tail of a long output (where a command's verdict is), marked as cut. */
function preview(text: string | undefined | null, max = OUTPUT_PREVIEW): string | undefined {
  if (typeof text !== "string" || !text.trim()) return undefined;
  return text.length > max ? `\u2026 (${text.length - max} characters earlier)\n${text.slice(-max)}` : text;
}

/** A tool's input for the thread: long strings cut, so a Write's whole file isn't logged twice. */
function trimInput(input: unknown): Record<string, unknown> | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input as Record<string, unknown>).slice(0, 24)) {
    out[k] = typeof v === "string" && v.length > 600 ? `${v.slice(0, 600)}\u2026 (${v.length} chars)` : v;
  }
  const json = JSON.stringify(out);
  return json.length > 6_000 ? { truncated: json.slice(0, 6_000) } : out;
}

const IMG_EXT: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/jpg": "jpg", "image/gif": "gif", "image/webp": "webp", "image/svg+xml": "svg" };

interface SessionState {
  providerThreadId?: string;
  turn?: { id?: string; startedAt: number; model?: string };
  tags?: TurnTags;
  /** Streamed text per item, until the item completes. */
  text: Map<string, { kind: "assistant" | "reasoning"; text: string }>;
  lastReply: string;
  compacting: boolean;
  /** The turn asked a structured question, so "ends on a question mark" says nothing new. */
  asked: boolean;
}

export class RuntimeIngestion {
  private readonly sessions = new Map<string, SessionState>();
  constructor(private readonly options: IngestionOptions) {}

  private state(threadId: string, instanceId: string): SessionState {
    const k = `${threadId}\u0000${instanceId}`;
    let s = this.sessions.get(k);
    if (!s) { s = { text: new Map(), lastReply: "", compacting: false, asked: false }; this.sessions.set(k, s); }
    return s;
  }

  /** Stamp Brain's tags on every event until this session's current turn ends. */
  tagTurn(threadId: ThreadId, instanceId: InstanceId, tags: TurnTags): void {
    this.state(threadId, instanceId).tags = tags;
  }

  /** Drop the tags of a turn that never started. */
  untagTurn(threadId: ThreadId, instanceId: InstanceId): void {
    this.state(threadId, instanceId).tags = undefined;
  }

  /** Forget a session's state (after it stops). */
  forget(threadId: ThreadId, instanceId: InstanceId): void {
    this.sessions.delete(`${threadId}\u0000${instanceId}`);
  }

  ingest(event: ProviderRuntimeEvent): void {
    const s = this.state(event.threadId, event.instanceId);
    const emit = (kind: IngestedEvent["kind"], payload: Record<string, unknown>) =>
      this.options.append({ kind, agentId: event.instanceId, chat: event.threadId, payload: s.tags ? { ...payload, ...s.tags } : payload });
    const status = (state: string, extra: Record<string, unknown> = {}) => emit("status", { state, ...extra });

    switch (event.type) {
      case "thread.started":
        if (event.payload.providerThreadId) s.providerThreadId = event.payload.providerThreadId;
        return;
      case "turn.started":
        s.turn = { ...(event.turnId ? { id: event.turnId } : {}), startedAt: event.createdAt, ...(event.payload.model ? { model: event.payload.model } : {}) };
        s.lastReply = "";
        status("turn_started", { session: s.providerThreadId ?? null, ...(event.payload.model ? { model: event.payload.model } : {}) });
        // The provider took the turn: Brain's acceptance evidence.
        if (s.tags) status("native_turn_accepted");
        return;
      case "content.delta": {
        const k = event.payload.streamKind;
        if (k === "assistant_text" || k === "reasoning_text" || k === "reasoning_summary_text") {
          const id = event.itemId ?? `${event.turnId ?? "turn"}:${k === "assistant_text" ? "assistant" : "reasoning"}`;
          const buf = s.text.get(id) ?? { kind: k === "assistant_text" ? "assistant" as const : "reasoning" as const, text: "" };
          buf.text += event.payload.delta;
          s.text.set(id, buf);
        }
        this.options.live?.({ agentId: event.instanceId, chat: event.threadId, ...(event.turnId ? { turnId: event.turnId } : {}),
          ...(event.itemId ? { itemId: event.itemId } : {}), streamKind: k, delta: event.payload.delta });
        return;
      }
      case "item.started":
      case "item.updated":
        if (event.payload.itemType === "context_compaction" && !s.compacting) { s.compacting = true; status("compacting"); }
        this.liveItem(event, event.type === "item.started" ? "started" : "updated");
        return;
      case "item.completed":
        this.liveItem(event, "completed");
        this.item(event, s, emit, status);
        return;
      case "turn.proposed.completed":
        // A plan the agent proposes (Codex plan item, Claude ExitPlanMode): the turn's deliverable.
        emit("message", { text: event.payload.planMarkdown, proposedPlan: true });
        return;
      case "turn.plan.updated":
        status("plan_updated", { plan: event.payload.plan, ...(event.payload.explanation ? { explanation: event.payload.explanation } : {}) });
        return;
      case "user-input.resolved":
        status("question_answered", { ...(event.requestId ? { requestId: event.requestId } : {}), answers: event.payload.answers });
        return;
      case "thread.state.changed":
        if (event.payload.state === "compacted") {
          s.compacting = false;
          status("native_compacted", { trigger: event.payload.trigger ?? "auto",
            ...(event.payload.beforeTokens !== undefined ? { preTokens: event.payload.beforeTokens } : {}),
            ...(event.payload.afterTokens !== undefined ? { postTokens: event.payload.afterTokens } : {}) });
        }
        return;
      case "thread.token-usage.updated": {
        const u = event.payload.usage;
        if (u.usedTokens > 0) status("context_usage", { usedTokens: u.usedTokens, ...(u.maxTokens ? { maxTokens: u.maxTokens } : {}),
          autoCompacts: u.compactsAutomatically ?? true });
        return;
      }
      case "account.rate-limits.updated":
        if (event.payload.windows.length) status("usage_limits", { provider: PROVIDER_ACCOUNT[event.provider], windows: event.payload.windows,
          ...(event.payload.reached ? { reached: event.payload.reached } : {}) });
        return;
      case "user-input.requested": {
        s.asked = true;
        const question = event.payload.questions.map(q => q.question).join("\n");
        emit("needs_input", { question: question.slice(-500), questions: event.payload.questions, ...(event.requestId ? { requestId: event.requestId } : {}),
          responseMode: event.payload.responseMode ?? "tool" });
        return;
      }
      case "runtime.warning":
        status("notice", { message: event.payload.message, ...(event.payload.retrying ? { retrying: true } : {}) });
        return;
      case "config.warning":
        status("notice", { message: event.payload.summary });
        return;
      case "model.rerouted":
        status("notice", { message: `model rerouted from ${event.payload.fromModel} to ${event.payload.toModel}${event.payload.reason ? ` (${event.payload.reason})` : ""}` });
        return;
      case "runtime.error":
        emit("error", { message: event.payload.message });
        return;
      case "turn.completed":
        this.complete(event, s, emit, status);
        return;
      case "turn.aborted":
        emit("error", { message: event.payload.reason, ...(event.payload.detail?.stderr ? { stderr: event.payload.detail.stderr.slice(-2000) } : {}) });
        this.endTurn(s);
        return;
      default:
        // Sessions, requests (answered through the approval bridge), plans and
        // diffs have no Loom log form yet; later phases add them.
        return;
    }
  }

  private liveItem(event: Extract<ProviderRuntimeEvent, { type: "item.started" | "item.updated" | "item.completed" }>, phase: LiveItem["phase"]): void {
    const p = event.payload;
    if (!this.options.liveItem || !event.itemId || !TOOL_ITEMS.has(p.itemType) || p.parentToolUseId) return;
    this.options.liveItem({ agentId: event.instanceId, chat: event.threadId, ...(event.turnId ? { turnId: event.turnId } : {}), itemId: event.itemId,
      phase, itemType: p.itemType, ...(p.title ? { title: p.title } : {}), ...(p.detail ? { detail: p.detail.slice(0, 300) } : {}), ...(p.status ? { status: p.status } : {}) });
  }

  private item(event: Extract<ProviderRuntimeEvent, { type: "item.completed" }>, s: SessionState,
    emit: (kind: IngestedEvent["kind"], payload: Record<string, unknown>) => void,
    status: (state: string, extra?: Record<string, unknown>) => void): void {
    const p = event.payload;
    const streamed = (kind: "assistant" | "reasoning") => {
      const id = event.itemId ?? `${event.turnId ?? "turn"}:${kind}`;
      const buf = s.text.get(id);
      s.text.delete(id);
      return buf?.text.trim() ? buf.text : p.detail ?? "";
    };
    const outcome = p.status === "completed" ? "success" : p.status === "failed" ? "failure" : p.status === "declined" ? "cancelled" : "unknown";
    switch (p.itemType) {
      case "assistant_message": {
        const text = streamed("assistant");
        if (!text.trim()) return;
        if (!p.parentToolUseId) s.lastReply = text;
        emit("message", { text });
        return;
      }
      case "reasoning": {
        const text = streamed("reasoning");
        if (text.trim()) emit("message", { text, reasoning: true });
        return;
      }
      case "command_execution": {
        const d = (p.data ?? {}) as Partial<CommandItemData>;
        const command = String(d.command ?? p.title ?? "");
        const exitCode = typeof d.exitCode === "number" ? d.exitCode : null;
        const output = typeof d.output === "string" ? d.output : null;
        const dir = s.tags && output !== null && output.length > ARTIFACT_THRESHOLD ? this.options.artifactDir?.(event.instanceId) : undefined;
        const outputArtifact = dir ? new ContextArtifacts(dir).put(JSON.stringify({ version: 1, output })) : undefined;
        const shown = preview(output);
        emit("tool_call", { tool: "shell", summary: `shell: ${command.replace(/\s+/g, " ").slice(0, 160)}`, exitCode,
          command: command.slice(0, 2_000), ...(shown ? { preview: shown } : {}),
          ok: exitCode !== null ? exitCode === 0 : p.status !== "failed" && p.status !== "declined",
          ...(p.parentToolUseId ? { parent: p.parentToolUseId } : {}),
          ...(s.tags ? { outcome: exitCode !== null ? exitCode === 0 ? "success" : "failure" : outcome,
            output: output?.slice(0, ARTIFACT_THRESHOLD) ?? null, ...(outputArtifact ? { outputArtifact } : {}),
            outputTruncated: output !== null && output.length > ARTIFACT_THRESHOLD } : {}) });
        return;
      }
      case "file_change": {
        const d = (p.data ?? {}) as Partial<FileChangeItemData>;
        if (p.title) emit("tool_call", { tool: p.title, summary: p.detail ?? p.title, ok: p.status !== "failed" && p.status !== "declined",
          ...(p.parentToolUseId ? { parent: p.parentToolUseId } : {}), ...(s.tags ? { outcome } : {}) });
        if (p.status === "failed" || p.status === "declined") return;
        for (const change of d.changes ?? []) if (change?.path)
          emit("file_edit", { path: String(change.path), tool: p.title ?? `file_change:${change.kind}`,
            ...(change.diff ? { diff: change.diff.length > DIFF_PREVIEW ? change.diff.slice(0, DIFF_PREVIEW) : change.diff } : {}) });
        return;
      }
      case "mcp_tool_call":
      case "dynamic_tool_call":
      case "collab_agent_tool_call":
      case "web_search":
      case "image_view": {
        const d = (p.data ?? {}) as Partial<ToolItemData>;
        const tool = String(d.tool ?? p.title ?? p.itemType);
        const input = trimInput(d.input);
        const out = preview(d.output);
        const err = preview(d.error, 1_500);
        const images = this.fileImages(event.instanceId, d.images);
        emit("tool_call", { tool, summary: (p.detail ?? `${tool}`).slice(0, 200), kind: p.itemType,
          ok: !err && p.status !== "failed" && p.status !== "declined",
          ...(d.server ? { server: d.server } : {}), ...(input ? { input } : {}), ...(out ? { preview: out } : {}), ...(err ? { error: err } : {}),
          ...(images.length ? { images } : {}), ...(p.parentToolUseId ? { parent: p.parentToolUseId } : {}),
          ...(s.tags ? { outcome } : {}) });
        return;
      }
      case "context_compaction":
        // Completion is reported as thread.state.changed; this only ends the "compacting" state.
        return;
      case "error":
        if (p.detail || p.title) status("notice", { message: p.detail ?? p.title });
        return;
      default:
        return;
    }
  }

  /**
   * A tool's images, as files the thread can show: base64 is written once
   * under the project's .loom/attachments (named by its hash), a path inside
   * the project is kept as it is. Base64 never goes into the event log.
   */
  private fileImages(instanceId: string, images: ToolImage[] | undefined): Array<{ path: string; mime?: string }> {
    if (!images?.length) return [];
    const dir = this.options.artifactDir?.(instanceId);
    const out: Array<{ path: string; mime?: string }> = [];
    for (const img of images.slice(0, 8)) {
      if (img.data && dir) {
        try {
          const buf = Buffer.from(img.data, "base64");
          if (!buf.length || buf.length > 12 * 1024 * 1024) continue;
          const ext = IMG_EXT[String(img.mime ?? "").toLowerCase()] ?? "png";
          const rel = path.join(".loom", "attachments", `${createHash("sha1").update(buf).digest("hex").slice(0, 12)}.${ext}`);
          const abs = path.join(dir, rel);
          if (!fs.existsSync(abs)) { fs.mkdirSync(path.dirname(abs), { recursive: true }); fs.writeFileSync(abs, buf); }
          out.push({ path: rel.split(path.sep).join("/"), ...(img.mime ? { mime: img.mime } : {}) });
        } catch { /* an image we couldn't keep is not worth failing a turn over */ }
      } else if (img.path) {
        const rel = dir && path.isAbsolute(img.path) && !path.relative(dir, img.path).startsWith("..") ? path.relative(dir, img.path) : img.path;
        out.push({ path: rel.split(path.sep).join("/") });
      }
    }
    return out;
  }

  private complete(event: Extract<ProviderRuntimeEvent, { type: "turn.completed" }>, s: SessionState,
    emit: (kind: IngestedEvent["kind"], payload: Record<string, unknown>) => void,
    status: (state: string, extra?: Record<string, unknown>) => void): void {
    const p = event.payload;
    if (p.totalCostUsd !== undefined) status("turn_cost", { costUsd: p.totalCostUsd });
    if (p.state === "completed") {
      // Blocked-on-human heuristic: the turn ended on a question.
      if (!s.asked && /\?\s*$/.test(s.lastReply.trim())) emit("needs_input", { question: s.lastReply.slice(-500) });
      const usage = p.tokenUsage;
      emit("run_complete", { durationMs: Math.max(0, event.createdAt - (s.turn?.startedAt ?? event.createdAt)),
        ...((p.model ?? s.turn?.model) ? { model: p.model ?? s.turn?.model } : {}),
        ...(usage?.inputTokens !== undefined ? { inputTokens: usage.inputTokens } : {}),
        ...(usage?.outputTokens !== undefined ? { outputTokens: usage.outputTokens } : {}),
        ...(usage?.cachedInputTokens ? { cachedInputTokens: usage.cachedInputTokens } : {}),
        ...(usage?.reasoningTokens ? { reasoningTokens: usage.reasoningTokens } : {}) });
    } else if (p.state === "failed") {
      emit("error", { message: p.errorMessage ?? "the turn failed" });
    } else {
      status("interrupted");
    }
    this.endTurn(s);
  }

  private endTurn(s: SessionState): void {
    s.turn = undefined;
    s.tags = undefined;
    s.text.clear();
    s.compacting = false;
    s.asked = false;
  }
}
