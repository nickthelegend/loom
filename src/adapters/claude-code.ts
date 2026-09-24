/**
 * Claude Code adapter — drives the `claude` CLI headless, one process per
 * turn, resuming the same session id across turns.
 *
 *   claude -p "<text>" --output-format stream-json --verbose
 *          [--resume <sessionId>] [--append-system-prompt <briefing>]
 *          [--mcp-config <file>] --permission-mode <mode>
 *
 * Surface verified against claude 2.1.83 — see docs/integration-notes.md. The
 * MCP flag was re-verified against 2.1.193 (`claude --help`: "--mcp-config
 * <configs...>  Load MCP servers from JSON files or strings") by running a real
 * turn with a generated config file.
 */

import { spawn, type ChildProcess } from "node:child_process";
import readline from "node:readline";
import type { AgentCapabilities, SendInput } from "../types.js";
import { readProjectState, writeProjectState } from "../core/registry.js";
import { AdapterBase, ADAPTER_CAPABILITIES, agentEnv, cliAvailable } from "./base.js";
import { writeApprovalMcpConfig } from "../core/approvals.js";
import { permissionFor } from "../core/permissions.js";
import fs from "node:fs";

interface ClaudeOptions {
  /** claude permission mode for baton turns; default "acceptEdits". */
  permissionMode?: string;
  /** Optional model override. */
  model?: string;
  /**
   * Path to the claude binary, when it isn't `claude` on PATH.
   *
   * Same escape hatch codex and grok have, and the seam these tests drive: an
   * adapter whose job is to parse another program's output can be tested
   * properly by handing it another program.
   */
  bin?: string;
  /** Extra CLI args, escape hatch. */
  extraArgs?: string[];
}

/**
 * Where `claude` lives when it isn't on PATH.
 *
 * Anthropic's installer puts it in ~/.local/bin, which is on an interactive
 * shell's PATH and frequently not on a daemon's — Loom's daemon is spawned
 * detached, and from the desktop shell it inherits a GUI environment with a
 * minimal PATH. The result was Setup reporting "Claude Code — not installed"
 * on a machine where `which claude` answers, which is the worst kind of wrong:
 * it sends you to reinstall something you already have.
 *
 * Codex, Grok and Antigravity each already look in their known locations. This
 * is the same idea for the one that was missing it. PATH is still the last
 * word, so a `claude` earlier in PATH wins.
 */
export function claudeBin(override?: string): string | null {
  if (override) return fs.existsSync(override) ? override : null;
  const home = process.env.HOME ?? "";
  const known = [
    `${home}/.local/bin/claude`,
    "/opt/homebrew/bin/claude",
    "/usr/local/bin/claude",
    `${home}/.bun/bin/claude`,
    `${home}/.volta/bin/claude`,
  ];
  for (const p of known) {
    if (p && fs.existsSync(p)) return p;
  }
  return "claude"; // let PATH resolution (and cliAvailable) decide
}

export class ClaudeCodeAdapter extends AdapterBase {
  /** `claude --mcp-config <file>` is real, so this adapter accepts SendInput.mcp. */
  override readonly capabilities: AgentCapabilities = { ...ADAPTER_CAPABILITIES, mcp: true };
  private child: ChildProcess | null = null;
  private options: ClaudeOptions;
  // Token usage from the CLI's `result` message, stashed so it can ride the
  // run_complete event (which fires on close, after result). Cleared each turn.
  private lastUsage: { input: number; output: number } | null = null;
  // The model the CLI actually ran (from the assistant message), so the turn's
  // gen_ai span carries a real gen_ai.request.model even with no override set.
  private lastModel: string | null = null;

  constructor(id: string, projectDir: string, options: Record<string, unknown> = {}) {
    super(id, "claude-code", projectDir);
    this.options = options as ClaudeOptions;
  }

  private get sessionId(): string | undefined {
    const state = readProjectState(this.projectDir);
    return state.agents[this.id]?.sessionId as string | undefined;
  }

  private set sessionId(value: string | undefined) {
    const state = readProjectState(this.projectDir);
    state.agents[this.id] = { ...state.agents[this.id], sessionId: value };
    writeProjectState(this.projectDir, state);
  }

  private get bin(): string {
    return this.options.bin ?? claudeBin() ?? "claude";
  }

  async available(): Promise<boolean> {
    return cliAvailable(this.bin);
  }

  async start(): Promise<void> {
    this.emit({ kind: "status", payload: { state: "ready", session: this.sessionId ?? null } });
  }

  async stop(): Promise<void> {
    await this.interrupt();
  }

  async send(input: SendInput): Promise<void> {
    if (this._busy) throw new Error(`claude-code agent "${this.id}" is busy`);
    this._busy = true;
    const started = Date.now();

    // Permissions: an explicit legacy permissionMode wins; otherwise the
    // Loom mode (bypass/auto/ask) maps to Claude's own — see core/permissions.
    // "ask" routes every prompt to Loom's approval tool, so it needs a daemon
    // to ask; without one it degrades to plan (read-only), never to "allow".
    const mode = permissionFor("claude-code", this.options as Record<string, unknown>);
    let approvalConfig: string | null = null;
    if (mode === "ask" && !this.options.permissionMode) {
      approvalConfig = writeApprovalMcpConfig({
        project: String((this.options as Record<string, unknown>).loomProject ?? ""),
        agent: this.id,
      });
    }
    const claudeMode =
      this.options.permissionMode ??
      (mode === "bypass" ? "bypassPermissions" : mode === "ask" ? (approvalConfig ? "manual" : "plan") : "acceptEdits");
    const args = [
      "-p",
      input.text,
      "--output-format",
      "stream-json",
      "--verbose",
      // Token deltas as stream_event lines, so the thread can show the reply
      // being written instead of a blank wait and then a wall of text.
      "--include-partial-messages",
      "--permission-mode",
      claudeMode,
    ];
    if (approvalConfig) args.push("--permission-prompt-tool", "mcp__loom__approve", "--mcp-config", approvalConfig);
    if (this.sessionId) args.push("--resume", this.sessionId);
    if (input.briefing) args.push("--append-system-prompt", input.briefing);
    // The project's MCP servers, for this turn only. The flag is passed ONLY
    // when the runtime actually produced servers — an empty config file is not
    // the same as no config file, and handing one over would be a claim that
    // this project has MCP configured when it hasn't.
    if (input.mcp?.servers.length) args.push("--mcp-config", input.mcp.configPath);
    if (this.options.model) args.push("--model", this.options.model);
    if (this.options.extraArgs) args.push(...this.options.extraArgs);

    try {
      await new Promise<void>((resolve, reject) => {
        const child = spawn(this.bin, args, {
          cwd: this.projectDir,
          stdio: ["ignore", "pipe", "pipe"],
          env: agentEnv(),
        });
        this.child = child;
        let lastAssistantText = "";
        let sawResult = false;
        let stderrTail = "";

        const rl = readline.createInterface({ input: child.stdout! });
        rl.on("line", (line) => {
          const trimmed = line.trim();
          if (!trimmed.startsWith("{")) return;
          let evt: Record<string, unknown>;
          try {
            evt = JSON.parse(trimmed) as Record<string, unknown>;
          } catch {
            return;
          }
          this.handleStreamEvent(evt, (t) => (lastAssistantText = t));
          if (evt.type === "result") sawResult = true;
        });

        child.stderr!.on("data", (d: Buffer) => {
          stderrTail = (stderrTail + d.toString()).slice(-2000);
        });

        child.on("error", (err) => reject(err));
        child.on("close", (code, signal) => {
          this.child = null;
          if (signal) {
            this.emit({ kind: "status", payload: { state: "interrupted", signal } });
            resolve();
            return;
          }
          if (code !== 0 && !sawResult) {
            this.emit({
              kind: "error",
              payload: { message: `${this.bin} exited ${code}`, stderr: stderrTail },
            });
            reject(new Error(`${this.bin} exited ${code}: ${stderrTail.slice(0, 200)}`));
            return;
          }
          // Blocked-on-human heuristic: the turn ended on a question.
          if (/\?\s*$/.test(lastAssistantText.trim())) {
            this.emit({
              kind: "needs_input",
              payload: { question: lastAssistantText.slice(-500) },
            });
          }
          this.emit({
            kind: "run_complete",
            payload: {
              durationMs: Date.now() - started,
              ...(this.lastModel ? { model: this.lastModel } : {}),
              ...(this.lastUsage
                ? { inputTokens: this.lastUsage.input, outputTokens: this.lastUsage.output }
                : {}),
            },
          });
          this.lastUsage = null;
          this.lastModel = null;
          resolve();
        });
      });
    } finally {
      this._busy = false;
      this.child = null;
      if (approvalConfig) fs.rmSync(approvalConfig, { force: true });
    }
  }

  private handleStreamEvent(
    evt: Record<string, unknown>,
    setLastText: (t: string) => void,
  ): void {
    const type = evt.type as string;
    if (type === "stream_event") {
      // A sub-agent's own typing (parent_tool_use_id set) isn't this reply.
      if (evt.parent_tool_use_id) return;
      const inner = (evt.event ?? {}) as { type?: string; delta?: { type?: string; text?: string; thinking?: string } };
      if (inner.type !== "content_block_delta" || !inner.delta) return;
      if (inner.delta.type === "text_delta") this.streamText(String(inner.delta.text ?? ""));
      else if (inner.delta.type === "thinking_delta") this.streamText(String(inner.delta.thinking ?? ""), true);
      return;
    }
    if (type === "system" && (evt as { subtype?: string }).subtype === "init") {
      const sid = evt.session_id as string | undefined;
      if (sid) this.sessionId = sid;
      this.emit({ kind: "status", payload: { state: "turn_started", session: sid ?? null } });
      return;
    }
    if (type === "assistant") {
      const message = evt.message as { content?: Array<Record<string, unknown>>; model?: string } | undefined;
      if (typeof message?.model === "string" && message.model) this.lastModel = message.model;
      for (const block of message?.content ?? []) {
        if (block.type === "text" && typeof block.text === "string" && block.text.trim()) {
          setLastText(block.text);
          this.emit({ kind: "message", payload: { text: block.text } });
        } else if (block.type === "thinking" && typeof block.thinking === "string" && block.thinking.trim()) {
          // Extended thinking. Emitted as a reasoning-tagged message so the UI
          // can fold it into its "thinking" block, the same shape codex and
          // grok use. It never becomes lastAssistantText (that's the reply).
          this.emit({ kind: "message", payload: { text: block.thinking, reasoning: true } });
        } else if (block.type === "tool_use") {
          const name = String(block.name ?? "tool");
          const input = (block.input ?? {}) as Record<string, unknown>;
          this.emit({
            kind: "tool_call",
            payload: { tool: name, summary: summarizeToolInput(name, input) },
          });
          const path = input.file_path ?? input.notebook_path;
          if (["Edit", "Write", "NotebookEdit", "MultiEdit"].includes(name) && path) {
            this.emit({ kind: "file_edit", payload: { path: String(path), tool: name } });
          }
        }
      }
      return;
    }
    if (type === "result") {
      const cost = evt.total_cost_usd as number | undefined;
      // The Claude Code CLI reports token usage on the result message; capture
      // it (cache reads/creations count as input) so tokens aren't lost.
      const usage = (evt.usage ?? {}) as Record<string, number>;
      this.lastUsage = {
        input: (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0),
        output: usage.output_tokens ?? 0,
      };
      const isError = Boolean(evt.is_error);
      if (isError) {
        this.emit({
          kind: "error",
          payload: { message: String(evt.result ?? evt.subtype ?? "unknown error") },
        });
      }
      if (cost !== undefined) {
        this.emit({ kind: "status", payload: { state: "turn_cost", costUsd: cost } });
      }
    }
  }

  async interrupt(): Promise<void> {
    const child = this.child;
    if (!child) return;
    child.kill("SIGINT");
    await new Promise<void>((resolve) => {
      const t = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          // already gone
        }
        resolve();
      }, 3000);
      child.on("close", () => {
        clearTimeout(t);
        resolve();
      });
    });
  }
}

function summarizeToolInput(name: string, input: Record<string, unknown>): string {
  const interesting =
    input.file_path ?? input.command ?? input.pattern ?? input.url ?? input.prompt ?? "";
  const text = String(interesting).replace(/\s+/g, " ");
  return `${name}: ${text.slice(0, 160)}`;
}
