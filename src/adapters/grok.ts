/**
 * Grok Code adapter — drives the `grok` CLI single-turn, resuming the same
 * session across turns.
 *
 *   grok -p "<text>" --output-format json --cwd <dir>
 *        --permission-mode acceptEdits [-r <sessionId>]
 *
 * Surface verified against grok 0.2.54 by running it:
 *
 *   {"text":"ok","stopReason":"EndTurn","sessionId":"019f…",
 *    "requestId":"02a6…","thought":"The user wants me to…"}
 *
 * ## What this adapter cannot show you
 *
 * Grok's turn is a black box with an answer at the end. `--output-format
 * streaming-json` sounds like it would help and doesn't: it emits `thought` and
 * `text` token deltas and a final `end`, and nothing else — no tool calls, no
 * file edits, not even when the turn demonstrably ran `echo` and wrote a file.
 * The steps simply aren't reported by the CLI.
 *
 * So Loom shows grok's answer and its reasoning, and no tool_call or file_edit
 * events, because there are none to be had. The alternative — inferring edits by
 * diffing the tree and attributing them to grok — would put guesses in the event
 * log wearing the same clothes as facts. The thread stays honest instead: with
 * grok you see what it said, and `git status` tells you what changed.
 *
 * Streaming deltas are deliberately not used. Every Loom message is an event on
 * a persisted log; one event per token would turn a paragraph into 200 rows.
 */

import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import type { SendInput } from "../types.js";
import { readProjectState, writeProjectState } from "../core/registry.js";
import { AdapterBase, agentEnv, cliAvailable } from "./base.js";

interface GrokOptions {
  /**
   * grok permission mode for baton turns; default "bypassPermissions".
   *
   * That default is not bravado, it's the only one that works. Driven headless
   * with no TTY to ask, every other mode ends the turn as `Cancelled` and
   * writes nothing — measured against grok 0.2.54:
   *
   *   acceptEdits       → Cancelled, no file
   *   auto              → Cancelled, no file
   *   dontAsk           → Cancelled, no file
   *   bypassPermissions → EndTurn,   file written
   *
   * "acceptEdits" reads safer and would give you an agent that silently does
   * nothing on every turn, which is worse than one that works: you'd trust the
   * word and never get the deed. Set it to something else if you want grok to
   * be inert, and note that a coding agent Loom hands a task to is going to
   * edit your tree — that's the job.
   */
  permissionMode?: "default" | "acceptEdits" | "auto" | "dontAsk" | "bypassPermissions" | "plan";
  /** Optional model override. */
  model?: string;
  /** Absolute path to the grok binary, when it's somewhere unusual. */
  bin?: string;
  /** Extra CLI args, escape hatch. */
  extraArgs?: string[];
}

/** grok's own installer puts it here; it isn't always on PATH. */
const INSTALLED = [`${process.env.HOME ?? ""}/.grok/bin/grok`];

export function grokBin(override?: string): string | null {
  if (override) return fs.existsSync(override) ? override : null;
  for (const p of INSTALLED) {
    if (fs.existsSync(p)) return p;
  }
  return "grok"; // let PATH resolution (and cliAvailable) decide
}

interface GrokResult {
  text?: string;
  thought?: string;
  stopReason?: string;
  sessionId?: string;
  error?: string;
  message?: string;
}

export class GrokAdapter extends AdapterBase {
  private child: ChildProcess | null = null;
  private options: GrokOptions;

  constructor(id: string, projectDir: string, options: Record<string, unknown> = {}) {
    super(id, "grok-code", projectDir);
    this.options = options as GrokOptions;
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

  async available(): Promise<boolean> {
    const bin = grokBin(this.options.bin);
    if (!bin) return false;
    return cliAvailable(bin);
  }

  async start(): Promise<void> {
    this.emit({ kind: "status", payload: { state: "ready", session: this.sessionId ?? null } });
  }

  async stop(): Promise<void> {
    await this.interrupt();
  }

  async send(input: SendInput): Promise<void> {
    if (this._busy) throw new Error(`grok agent "${this.id}" is busy`);
    const bin = grokBin(this.options.bin);
    if (!bin) throw new Error("grok CLI not found — install it from x.ai, or set options.bin");
    this._busy = true;
    const started = Date.now();

    // No --append-system-prompt on grok, so a handoff briefing rides in front
    // of the text. One prompt either way, and the handoff stays readable.
    const text = input.briefing ? `${input.briefing}\n\n---\n\n${input.text}` : input.text;

    const args = [
      "-p",
      text,
      "--output-format",
      "json",
      "--cwd",
      this.projectDir,
      "--permission-mode",
      this.options.permissionMode ?? "bypassPermissions",
    ];
    if (this.sessionId) args.push("-r", this.sessionId);
    if (this.options.model) args.push("--model", this.options.model);
    if (this.options.extraArgs) args.push(...this.options.extraArgs);

    this.emit({ kind: "status", payload: { state: "turn_started", session: this.sessionId ?? null } });

    try {
      await new Promise<void>((resolve, reject) => {
        const child = spawn(bin, args, {
          cwd: this.projectDir,
          stdio: ["ignore", "pipe", "pipe"],
          env: agentEnv(),
        });
        this.child = child;
        let stdout = "";
        let stderrTail = "";

        child.stdout!.on("data", (d: Buffer) => (stdout += d.toString()));
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

          const result = parseGrokJson(stdout);
          if (!result) {
            this.emit({
              kind: "error",
              payload: { message: `grok exited ${code} without a parsable answer`, stderr: stderrTail },
            });
            reject(new Error(`grok exited ${code}: ${stderrTail.slice(0, 200) || stdout.slice(0, 200)}`));
            return;
          }
          if (result.sessionId) this.sessionId = result.sessionId;

          const err = result.error ?? (code !== 0 ? result.message : undefined);
          if (err) this.emit({ kind: "error", payload: { message: String(err) } });

          if (result.thought?.trim()) {
            this.emit({ kind: "message", payload: { text: result.thought, reasoning: true } });
          }
          const answer = (result.text ?? "").trim();
          if (answer) this.emit({ kind: "message", payload: { text: result.text } });

          // grok reports why it stopped; a turn that ran out of room is not a
          // turn that finished, and silently pretending otherwise hides it.
          if (result.stopReason && result.stopReason !== "EndTurn") {
            this.emit({
              kind: "status",
              payload: { state: "stopped_early", reason: result.stopReason },
            });
          }
          if (/\?\s*$/.test(answer)) {
            this.emit({ kind: "needs_input", payload: { question: answer.slice(-500) } });
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

/**
 * Pull grok's result object out of stdout.
 *
 * It pretty-prints one JSON object, but anything the CLI decides to log first
 * lands on the same stream, so the object is found rather than assumed: last
 * balanced `{…}` wins.
 */
export function parseGrokJson(stdout: string): GrokResult | null {
  const trimmed = stdout.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed) as GrokResult;
  } catch {
    // fall through: something else printed to stdout too
  }
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(trimmed.slice(start, end + 1)) as GrokResult;
  } catch {
    return null;
  }
}
