/**
 * Claude Code adapter — drives the `claude` CLI headless, one process per
 * turn, resuming the same session id across turns.
 *
 *   claude -p "<text>" --output-format stream-json --verbose
 *          [--resume <sessionId>] [--append-system-prompt <briefing>]
 *          --permission-mode <mode>
 *
 * Surface verified against claude 2.1.83 — see docs/integration-notes.md.
 */

import { spawn, type ChildProcess } from "node:child_process";
import readline from "node:readline";
import type { SendInput } from "../types.js";
import { readProjectState, writeProjectState } from "../core/registry.js";
import { AdapterBase, agentEnv, cliAvailable } from "./base.js";

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

export class ClaudeCodeAdapter extends AdapterBase {
  private child: ChildProcess | null = null;
  private options: ClaudeOptions;

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
    return this.options.bin ?? "claude";
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

    const args = [
      "-p",
      input.text,
      "--output-format",
      "stream-json",
      "--verbose",
      "--permission-mode",
      this.options.permissionMode ?? "acceptEdits",
    ];
    if (this.sessionId) args.push("--resume", this.sessionId);
    if (input.briefing) args.push("--append-system-prompt", input.briefing);
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
            payload: { durationMs: Date.now() - started },
          });
          resolve();
        });
      });
    } finally {
      this._busy = false;
      this.child = null;
    }
  }

  private handleStreamEvent(
    evt: Record<string, unknown>,
    setLastText: (t: string) => void,
  ): void {
    const type = evt.type as string;
    if (type === "system" && (evt as { subtype?: string }).subtype === "init") {
      const sid = evt.session_id as string | undefined;
      if (sid) this.sessionId = sid;
      this.emit({ kind: "status", payload: { state: "turn_started", session: sid ?? null } });
      return;
    }
    if (type === "assistant") {
      const message = evt.message as { content?: Array<Record<string, unknown>> } | undefined;
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
