/**
 * Codex adapter — drives the `codex` CLI headless, one process per turn,
 * resuming the same thread across turns.
 *
 *   codex exec --json --skip-git-repo-check -C <dir> -s <sandbox> "<text>"
 *   codex exec resume <threadId> --json … "<text>"
 *
 * The CLI ships inside the desktop app as well as on PATH, so `available()`
 * looks in both places — a Mac with Codex.app installed and nothing on PATH is
 * the common case, and refusing to find it there would be wrong.
 *
 * Event surface verified against codex-cli 0.142.4 by running it and reading
 * what came out, not by guessing:
 *
 *   {"type":"thread.started","thread_id":"019f…"}
 *   {"type":"turn.started"}
 *   {"type":"item.started","item":{"id":"item_1","type":"command_execution",…}}
 *   {"type":"item.completed","item":{"id":"item_1","type":"command_execution",
 *      "command":"/bin/zsh -lc 'echo hi'","aggregated_output":"hi\n","exit_code":0}}
 *   {"type":"item.completed","item":{"id":"item_2","type":"agent_message","text":"…"}}
 *   {"type":"item.completed","item":{"id":"item_3","type":"file_change",
 *      "changes":[{"path":"/abs/note.txt","kind":"add"}]}}
 *   {"type":"turn.completed","usage":{"input_tokens":52831,"output_tokens":120,…}}
 *
 * Note what is NOT in there: money. Codex reports tokens, never a dollar
 * figure, so this adapter reports tokens and no cost. Inventing a USD number
 * from a price table we'd have to keep current is how you end up with a fake
 * $0.001 in the UI presented as fact.
 */

import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import readline from "node:readline";
import type { SendInput } from "../types.js";
import { readProjectState, writeProjectState } from "../core/registry.js";
import { AdapterBase, agentEnv, cliAvailable, frameBriefing } from "./base.js";

interface CodexOptions {
  /** Sandbox policy for model-run commands; default "workspace-write". */
  sandbox?: "read-only" | "workspace-write" | "danger-full-access";
  /** Optional model override. */
  model?: string;
  /** Absolute path to the codex binary, when it's somewhere unusual. */
  bin?: string;
  /** Extra CLI args, escape hatch. */
  extraArgs?: string[];
}

/** The CLI bundled inside the desktop app, per platform. */
const BUNDLED = [
  "/Applications/Codex.app/Contents/Resources/codex",
  `${process.env.HOME ?? ""}/Applications/Codex.app/Contents/Resources/codex`,
];

/**
 * Where the codex CLI is on this machine: an explicit override, then PATH,
 * then inside the app bundle.
 */
export function codexBin(override?: string): string | null {
  if (override) return fs.existsSync(override) ? override : null;
  for (const p of BUNDLED) {
    if (fs.existsSync(p)) return p;
  }
  return "codex"; // let PATH resolution (and cliAvailable) decide
}

export class CodexAdapter extends AdapterBase {
  private child: ChildProcess | null = null;
  private options: CodexOptions;

  constructor(id: string, projectDir: string, options: Record<string, unknown> = {}) {
    super(id, "codex", projectDir);
    this.options = options as CodexOptions;
  }

  /** Codex calls it a thread; loom stores it in the same slot as any session. */
  private get threadId(): string | undefined {
    const state = readProjectState(this.projectDir);
    return state.agents[this.id]?.sessionId as string | undefined;
  }

  private set threadId(value: string | undefined) {
    const state = readProjectState(this.projectDir);
    state.agents[this.id] = { ...state.agents[this.id], sessionId: value };
    writeProjectState(this.projectDir, state);
  }

  async available(): Promise<boolean> {
    const bin = codexBin(this.options.bin);
    if (!bin) return false;
    return cliAvailable(bin);
  }

  async start(): Promise<void> {
    this.emit({ kind: "status", payload: { state: "ready", session: this.threadId ?? null } });
  }

  async stop(): Promise<void> {
    await this.interrupt();
  }

  async send(input: SendInput): Promise<void> {
    if (this._busy) throw new Error(`codex agent "${this.id}" is busy`);
    const bin = codexBin(this.options.bin);
    if (!bin) throw new Error("codex CLI not found — install it or open Codex.app once");
    this._busy = true;
    const started = Date.now();

    // Codex exec has no --append-system-prompt, so the briefing rides in front
    // of the text — but framed as an unmissable authoritative block (see
    // frameBriefing), not a loose preamble the model skims past.
    const text = input.briefing ? `${frameBriefing(input.briefing)}\n\n${input.text}` : input.text;

    const args = this.threadId
      ? ["exec", "resume", this.threadId]
      : ["exec"];
    args.push(
      "--json",
      "--skip-git-repo-check",
      "-C",
      this.projectDir,
      "-s",
      this.options.sandbox ?? "workspace-write",
    );
    if (this.options.model) args.push("-m", this.options.model);
    if (this.options.extraArgs) args.push(...this.options.extraArgs);
    args.push(text);

    try {
      await new Promise<void>((resolve, reject) => {
        const child = spawn(bin, args, {
          cwd: this.projectDir,
          // stdin closed: with a pipe open, `codex exec` waits on stdin for
          // additional input and the turn never starts.
          stdio: ["ignore", "pipe", "pipe"],
          env: agentEnv(),
        });
        this.child = child;
        let lastMessage = "";
        let sawTurn = false;
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
          this.handleEvent(evt, (t) => (lastMessage = t));
          if (evt.type === "turn.completed") sawTurn = true;
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
          if (code !== 0 && !sawTurn) {
            this.emit({
              kind: "error",
              payload: { message: `codex exited ${code}`, stderr: stderrTail },
            });
            reject(new Error(`codex exited ${code}: ${stderrTail.slice(0, 200)}`));
            return;
          }
          // Same blocked-on-human heuristic the other adapters use: the turn
          // ended on a question, so the baton is really with you.
          if (/\?\s*$/.test(lastMessage.trim())) {
            this.emit({ kind: "needs_input", payload: { question: lastMessage.slice(-500) } });
          }
          this.emit({ kind: "run_complete", payload: { durationMs: Date.now() - started } });
          resolve();
        });
      });
    } finally {
      this._busy = false;
      this.child = null;
    }
  }

  private handleEvent(evt: Record<string, unknown>, setLast: (t: string) => void): void {
    const type = evt.type as string;

    if (type === "thread.started") {
      const id = evt.thread_id as string | undefined;
      if (id) this.threadId = id;
      this.emit({ kind: "status", payload: { state: "turn_started", session: id ?? null } });
      return;
    }

    if (type === "item.completed" || type === "item.started") {
      const item = (evt.item ?? {}) as Record<string, unknown>;
      // Only completed items are reported: an in_progress command has no exit
      // code yet, and a half-written file_change has nothing useful to say.
      if (type !== "item.completed") return;
      this.handleItem(item, setLast);
      return;
    }

    if (type === "turn.completed") {
      const usage = (evt.usage ?? {}) as Record<string, number>;
      this.emit({
        kind: "status",
        payload: {
          state: "turn_tokens",
          inputTokens: usage.input_tokens ?? 0,
          cachedInputTokens: usage.cached_input_tokens ?? 0,
          outputTokens: usage.output_tokens ?? 0,
          reasoningTokens: usage.reasoning_output_tokens ?? 0,
        },
      });
      return;
    }

    if (type === "turn.failed" || type === "error") {
      const err = (evt.error ?? evt) as Record<string, unknown>;
      this.emit({ kind: "error", payload: { message: String(err.message ?? "codex failed") } });
    }
  }

  private handleItem(item: Record<string, unknown>, setLast: (t: string) => void): void {
    switch (item.type) {
      case "agent_message": {
        const text = String(item.text ?? "");
        if (!text.trim()) return;
        setLast(text);
        this.emit({ kind: "message", payload: { text } });
        return;
      }
      case "reasoning": {
        const text = String(item.text ?? "").trim();
        if (text) this.emit({ kind: "message", payload: { text, reasoning: true } });
        return;
      }
      case "command_execution": {
        const command = String(item.command ?? "");
        const exit = item.exit_code;
        this.emit({
          kind: "tool_call",
          payload: {
            tool: "shell",
            summary: `shell: ${command.replace(/\s+/g, " ").slice(0, 160)}`,
            exitCode: typeof exit === "number" ? exit : null,
          },
        });
        return;
      }
      case "file_change": {
        const changes = (item.changes ?? []) as Array<{ path?: string; kind?: string }>;
        for (const c of changes) {
          if (!c.path) continue;
          this.emit({
            kind: "file_edit",
            payload: { path: String(c.path), tool: `file_change:${c.kind ?? "edit"}` },
          });
        }
        return;
      }
      case "mcp_tool_call": {
        this.emit({
          kind: "tool_call",
          payload: { tool: String(item.tool ?? "mcp"), summary: `mcp: ${String(item.tool ?? "")}` },
        });
        return;
      }
      case "web_search": {
        this.emit({
          kind: "tool_call",
          payload: { tool: "web_search", summary: `search: ${String(item.query ?? "")}`.slice(0, 160) },
        });
        return;
      }
      case "error": {
        this.emit({ kind: "error", payload: { message: String(item.message ?? "codex error") } });
        return;
      }
      default:
        // todo_list and whatever Codex adds next: not every item is worth an
        // event, and inventing a rendering for one we don't understand is worse
        // than staying quiet.
        return;
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
