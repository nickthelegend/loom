/**
 * Antigravity CLI adapter — drives Google's `agy` CLI headless, one process per
 * turn, resuming the same conversation across turns. This is the token-saving
 * path: a turn handed to `agy` runs on Gemini (or whatever model the agent is
 * configured with) instead of spending the orchestrator's budget.
 *
 *   agy -p "<text>" --dangerously-skip-permissions --add-dir <dir> \
 *       --model <model> --print-timeout <dur>
 *   agy -p "<text>" --conversation <id> …            (follow-up turns)
 *
 * Unlike the Antigravity *bridge* (bridges/antigravity.ts), which drives the
 * Antigravity IDE's chat panel over the DevTools protocol and can only watch,
 * this is a real adapter: it holds the baton and runs a turn to completion with
 * no GUI in the loop.
 *
 * Interface verified against agy 1.1.6 by running it, not by guessing:
 *
 *   - `-p/--print` runs one prompt non-interactively and prints ONLY the final
 *     assistant message to stdout (markdown), then exits 0. There is no JSON
 *     event stream, so this adapter reports the final message + the files it
 *     touched (parsed from the `[name](file://…)` links agy emits), and — like
 *     the Codex adapter — reports NO dollar cost, because the CLI hands us none
 *     and inventing one from a price table is how a fake number ends up in the
 *     UI presented as fact. It doesn't hand us tokens either, so turns show a
 *     model (when configured) and a duration, and honestly nothing else.
 *
 *   - conversations are keyed by working directory in
 *     ~/.gemini/antigravity-cli/cache/last_conversations.json; after a fresh
 *     turn we read the id back from there and resume it explicitly with
 *     `--conversation` on every following turn, so continuity survives even if
 *     another tool later rewrites that dir's mapping.
 */

import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { SendInput } from "../types.js";
import { readProjectState, writeProjectState } from "../core/registry.js";
import { AdapterBase, agentEnv, cliAvailable, frameBriefing } from "./base.js";

interface AntigravityOptions {
  /** Model the CLI runs, e.g. "gemini-3.6-flash-medium" or "claude-sonnet-4-6". */
  model?: string;
  /** Reasoning effort the CLI accepts: low | medium | high. */
  effort?: "low" | "medium" | "high";
  /** Absolute path to the agy binary, when it's somewhere unusual. */
  bin?: string;
  /** Per-turn wall-clock budget in ms; default 5 minutes (agy's own default). */
  timeoutMs?: number;
  /** Extra CLI args, escape hatch. */
  extraArgs?: string[];
}

/** The installer drops the binary here; it isn't always on the daemon's PATH. */
const INSTALLED = [
  path.join(os.homedir(), ".local", "bin", "agy"),
];

/**
 * Where the agy CLI is on this machine: an explicit override, then PATH, then
 * the installer's default location — the daemon may have been started from a
 * shell whose PATH predates the install, so PATH alone isn't enough.
 */
export function agyBin(override?: string): string | null {
  if (override) return fs.existsSync(override) ? override : null;
  for (const p of INSTALLED) {
    if (fs.existsSync(p)) return p;
  }
  return "agy"; // let PATH resolution (and cliAvailable) decide
}

/** agy's per-workspace conversation index; maps a working dir to its last id. */
function conversationIndexPath(): string {
  return path.join(os.homedir(), ".gemini", "antigravity-cli", "cache", "last_conversations.json");
}

/** The conversation id agy last used for `dir`, or null if it has none. */
function conversationFor(dir: string): string | null {
  try {
    const raw = fs.readFileSync(conversationIndexPath(), "utf8");
    const map = JSON.parse(raw) as Record<string, string>;
    return map[dir] ?? null;
  } catch {
    return null;
  }
}

export class AntigravityCliAdapter extends AdapterBase {
  private child: ChildProcess | null = null;
  private options: AntigravityOptions;

  constructor(id: string, projectDir: string, options: Record<string, unknown> = {}) {
    super(id, "antigravity-cli", projectDir);
    this.options = options as AntigravityOptions;
  }

  /** agy calls it a conversation; loom stores it in the same slot as any session. */
  private get conversationId(): string | undefined {
    const state = readProjectState(this.projectDir);
    return state.agents[this.id]?.sessionId as string | undefined;
  }

  private set conversationId(value: string | undefined) {
    const state = readProjectState(this.projectDir);
    state.agents[this.id] = { ...state.agents[this.id], sessionId: value };
    writeProjectState(this.projectDir, state);
  }

  async available(): Promise<boolean> {
    const bin = agyBin(this.options.bin);
    if (!bin) return false;
    return cliAvailable(bin);
  }

  async start(): Promise<void> {
    this.emit({ kind: "status", payload: { state: "ready", session: this.conversationId ?? null } });
  }

  async stop(): Promise<void> {
    await this.interrupt();
  }

  /** agy wants a Go-style duration; ms → "<n>s". */
  private timeoutArg(): string {
    const ms = this.options.timeoutMs ?? 300_000;
    return `${Math.max(1, Math.round(ms / 1000))}s`;
  }

  async send(input: SendInput): Promise<void> {
    if (this._busy) throw new Error(`antigravity agent "${this.id}" is busy`);
    const bin = agyBin(this.options.bin);
    if (!bin) throw new Error("agy CLI not found — install it: curl -fsSL https://antigravity.google/cli/install.sh | bash");
    this._busy = true;
    const started = Date.now();

    // `agy --print` has no system channel, so the handoff briefing rides in
    // front of the text as an unmissable authoritative block (see frameBriefing),
    // exactly as the Codex and OpenCode adapters do.
    const text = input.briefing ? `${frameBriefing(input.briefing)}\n\n${input.text}` : input.text;

    const resume = this.conversationId;
    const args = ["--print", text, "--dangerously-skip-permissions", "--print-timeout", this.timeoutArg()];
    if (resume) {
      // A resumed conversation keeps its original workspace; --add-dir is only
      // meaningful (and only needed) when opening a fresh one.
      args.push("--conversation", resume);
    } else {
      args.push("--add-dir", this.projectDir);
    }
    if (this.options.model) args.push("--model", this.options.model);
    if (this.options.effort) args.push("--effort", this.options.effort);
    if (this.options.extraArgs) args.push(...this.options.extraArgs);

    // The binary may resolve by absolute path while its own PATH lookups (git,
    // node, …) still need the login shell's dirs, so make sure agy's own bin dir
    // is reachable to whatever it shells out to.
    const env = agentEnv();
    const binDir = path.dirname(bin === "agy" ? INSTALLED[0]! : bin);
    env.PATH = `${binDir}:${env.PATH ?? ""}`;

    try {
      await new Promise<void>((resolve, reject) => {
        const child = spawn(bin, args, {
          cwd: this.projectDir,
          // stdin closed: with a pipe open agy waits on it and print mode stalls.
          stdio: ["ignore", "pipe", "pipe"],
          env,
        });
        this.child = child;
        let out = "";
        let stderrTail = "";

        child.stdout!.on("data", (d: Buffer) => {
          out += d.toString();
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
          const message = out.trim();
          if (code !== 0 && !message) {
            this.emit({ kind: "error", payload: { message: `agy exited ${code}`, stderr: stderrTail } });
            reject(new Error(`agy exited ${code}: ${stderrTail.slice(0, 200)}`));
            return;
          }

          if (message) {
            this.emit({ kind: "message", payload: { text: message } });
            this.emitFileEdits(message);
          }

          // Capture the conversation id agy just wrote for this dir, so the next
          // turn resumes it explicitly. Only on the first turn — after that we
          // already hold it and keep passing the same one.
          if (!resume) {
            const id = conversationFor(this.projectDir);
            if (id) this.conversationId = id;
          }

          // Same blocked-on-human heuristic the other adapters use: a turn that
          // ended on a question means the baton is really back with you.
          if (/\?\s*$/.test(message)) {
            this.emit({ kind: "needs_input", payload: { question: message.slice(-500) } });
          }

          this.emit({
            kind: "run_complete",
            payload: {
              durationMs: Date.now() - started,
              ...(this.options.model ? { model: this.options.model } : {}),
            },
          });
          resolve();
        });
      });
    } finally {
      this._busy = false;
      this.child = null;
    }
  }

  /**
   * agy narrates file writes as markdown links — "Created [hello.txt](file:///…)"
   * — so the paths it touched are recoverable from the final message even
   * without a structured stream. Surface each once as a file_edit so the diff
   * view and activity feed aren't blind to what changed.
   */
  private emitFileEdits(message: string): void {
    const seen = new Set<string>();
    const re = /\[[^\]]+\]\(file:\/\/([^)\s]+)\)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(message)) !== null) {
      let p = m[1]!;
      try {
        p = decodeURIComponent(p);
      } catch {
        // leave it as-is if it isn't valid percent-encoding
      }
      if (seen.has(p)) continue;
      seen.add(p);
      this.emit({ kind: "file_edit", payload: { path: p, tool: "agy" } });
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
