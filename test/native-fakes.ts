/**
 * Stand-ins for the two native harnesses, speaking the protocols the adapters
 * actually use: the Claude Code CLI's stream-json control protocol (what the
 * Agent SDK drives) and `codex app-server` JSON-RPC.
 *
 * The real CLIs aren't used because a turn costs money and needs an account,
 * and because the interesting cases — a lost session, a refused turn, a
 * process that dies mid-turn — are ones you can't ask a working CLI for.
 *
 * Each fake records what it was given next to itself: `calls.jsonl` (argv per
 * launch) and `stdin.jsonl` (every protocol message it received, including
 * the answers to its own permission requests).
 *
 * A script is a list of steps run when the turn starts. Any string in a step
 * containing `$SESSION` (or `$TURN` for Codex) is filled in at run time.
 *   { out: {...} }                  write one protocol message
 *   { raw: "text" }                 write a line that isn't protocol
 *   { stderr: "text" }              write to stderr
 *   { sleep: ms }                   wait
 *   { ask: {...} }                  Claude: a can_use_tool request, awaits the answer
 *   { ask: method, params }         Codex: a server request, awaits the answer
 *   { exit: code }                  exit now
 *   { spawn: "js" }                 start a child in the fake's process group
 */

import fs from "node:fs";
import path from "node:path";
import { tmpDir } from "./helpers.js";

export type Step = Record<string, unknown>;

export interface FakeClaudeOptions {
  /** The turn: steps run after each user message arrives. Defaults to CLAUDE_OK. */
  script?: Step[];
  /** Per-turn scripts (turn 1, turn 2, …); a turn past the end uses `script`. */
  scripts?: Step[][];
  /** Exit code when stdin closes (after the result). */
  code?: number;
  /** A `--resume` of any session fails as the real CLI does. */
  missingSession?: boolean;
  /** Written to stderr at launch. */
  stderr?: string;
  version?: string;
}

/** A complete, ordinary Claude turn. */
export const CLAUDE_OK: Step[] = [
  { out: { type: "system", subtype: "init", session_id: "$SESSION" } },
  { out: { type: "assistant", message: { model: "claude-test", content: [{ type: "text", text: "Did the work." }],
    usage: { input_tokens: 30, cache_read_input_tokens: 2, output_tokens: 8 } }, parent_tool_use_id: null, session_id: "$SESSION" } },
  { out: { type: "result", subtype: "success", is_error: false, result: "Did the work.", total_cost_usd: 0.0421,
    usage: { input_tokens: 32, output_tokens: 8 }, modelUsage: { "claude-test": { contextWindow: 200000 } }, session_id: "$SESSION" } },
];

export const claudeInit: Step = { out: { type: "system", subtype: "init", session_id: "$SESSION" } };
export const claudeText = (text: string, extra: Record<string, unknown> = {}): Step =>
  ({ out: { type: "assistant", message: { model: "claude-test", content: [{ type: "text", text }], ...extra }, parent_tool_use_id: null, session_id: "$SESSION" } });
export const claudeThink = (thinking: string): Step =>
  ({ out: { type: "assistant", message: { content: [{ type: "thinking", thinking }] }, parent_tool_use_id: null, session_id: "$SESSION" } });
export const claudeTool = (name: string, input: Record<string, unknown>): Step =>
  ({ out: { type: "assistant", message: { content: [{ type: "tool_use", id: `tu-${name}`, name, input }] }, parent_tool_use_id: null, session_id: "$SESSION" } });
export const claudeResult = (extra: Record<string, unknown> = {}): Step =>
  ({ out: { type: "result", subtype: "success", is_error: false, result: "", total_cost_usd: 0.0421,
    usage: { input_tokens: 0, output_tokens: 0 }, modelUsage: {}, session_id: "$SESSION", ...extra } });

const RUNNER = `
const fs = require("node:fs"), path = require("node:path");
const here = path.dirname(process.argv[1]);
const record = (file, value) => fs.appendFileSync(path.join(here, file), JSON.stringify(value) + "\\n");
const out = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fill = (value, vars) => JSON.parse(JSON.stringify(value).replace(/\\$(SESSION|TURN|THREAD)/g, (_, k) => vars[k]));
`;

/** A fake `claude` for the Agent SDK. Returns its path. */
export function fakeClaude(options: FakeClaudeOptions = {}): string {
  const dir = tmpDir("fake-claude"), bin = path.join(dir, "claude");
  const config = { script: options.script ?? CLAUDE_OK, scripts: options.scripts ?? [], code: options.code ?? 0, missingSession: options.missingSession ?? false,
    stderr: options.stderr ?? "", version: options.version ?? "2.1.283 (Claude Code)" };
  fs.writeFileSync(bin, `#!/usr/bin/env node
${RUNNER}
const config = ${JSON.stringify(config)};
const args = process.argv.slice(2);
record("calls.jsonl", args);
if (args.includes("--version")) { console.log(config.version); process.exit(0); }
if (config.stderr) process.stderr.write(config.stderr + "\\n");
const flag = (name) => { const i = args.findIndex((a) => a === name || a.startsWith(name + "=")); return i < 0 ? null : args[i].includes("=") ? args[i].slice(name.length + 1) : args[i + 1]; };
const resume = flag("--resume");
if (resume && config.missingSession) {
  process.stderr.write("No conversation found with session ID: " + resume + "\\n");
  process.exit(1);
}
const vars = { SESSION: resume || flag("--session-id") || require("node:crypto").randomUUID() };
const pending = new Map();
let seq = 0, turns = 0, interrupted = false, running = null;
const queued = [];
async function run(script) {
  for (const step of script) {
    if (interrupted) return;
    if ("out" in step) out(fill(step.out, vars));
    else if ("raw" in step) process.stdout.write(step.raw + "\\n");
    else if ("stderr" in step) process.stderr.write(step.stderr + "\\n");
    else if ("sleep" in step) await sleep(step.sleep);
    else if ("exit" in step) process.exit(step.exit);
    else if ("spawn" in step) require("node:child_process").spawn(process.execPath, ["-e", step.spawn], { stdio: ["ignore", "inherit", "inherit"] }).unref();
    else if ("ask" in step) {
      const request_id = "fake-" + ++seq;
      const answer = new Promise((resolve) => pending.set(request_id, resolve));
      out({ type: "control_request", request_id, request: { subtype: "can_use_tool", tool_use_id: "tu-" + seq, ...step.ask } });
      await answer;
    }
  }
}
require("node:readline").createInterface({ input: process.stdin }).on("line", (line) => {
  let m; try { m = JSON.parse(line); } catch { return; }
  record("stdin.jsonl", m);
  if (m.type === "control_request") {
    out({ type: "control_response", response: { subtype: "success", request_id: m.request_id, response: {} } });
    if (m.request.subtype === "interrupt" && !interrupted) {
      interrupted = true;
      out({ type: "result", subtype: "error_during_execution", is_error: true, errors: ["Request interrupted by user"],
        total_cost_usd: 0, usage: { input_tokens: 0, output_tokens: 0 }, modelUsage: {}, session_id: vars.SESSION });
    }
  } else if (m.type === "control_response") {
    const resolve = pending.get(m.response.request_id);
    if (resolve) { pending.delete(m.response.request_id); resolve(m.response); }
  } else if (m.type === "user") { queued.push(m); if (!running) running = drain(); }
});
// One CLI serves many turns: each user message runs the next script.
async function drain() {
  while (queued.length) {
    queued.shift();
    const script = config.scripts[turns] || config.script;
    turns++;
    interrupted = false;
    record("turns.jsonl", { turn: turns, pid: process.pid });
    await run(script);
  }
  running = null;
}
process.stdin.on("end", async () => { if (running && !interrupted) await running; process.exit(config.code); });
`, { mode: 0o755 });
  return bin;
}

export interface FakeCodexOptions {
  /** Notifications and requests after each turn/start. Defaults to CODEX_OK. */
  script?: Step[];
  /** Per-turn scripts (turn 1, turn 2, …); a turn past the end uses `script`. */
  scripts?: Step[][];
  /** thread/resume answers "no rollout found". */
  missingThread?: boolean;
  /** turn/start is refused with an error response. */
  refuseTurn?: string;
  /** Exit before answering initialize, with this stderr. */
  dieAtStart?: { code: number; stderr: string };
  /** The model thread/start reports. */
  model?: string;
  /** What model/list answers (the sign-in's models); unset, it's an unknown method like an old codex. */
  models?: Array<{ id: string; model?: string; isDefault?: boolean }>;
  version?: string;
}

const usage = (input: number, cached: number, output: number, reasoning = 0) =>
  ({ totalTokens: input + output, inputTokens: input, cachedInputTokens: cached, outputTokens: output, reasoningOutputTokens: reasoning });

export const codexNotify = (method: string, params: Record<string, unknown>): Step => ({ out: { method, params: { threadId: "$THREAD", turnId: "$TURN", ...params } } });
export const codexItem = (item: Record<string, unknown>): Step => codexNotify("item/completed", { item: { id: `i-${Math.random().toString(36).slice(2)}`, ...item } });
export const codexMessage = (text: string): Step => codexItem({ type: "agentMessage", text });
export const codexTokens = (input: number, cached: number, output: number, window = 272000): Step =>
  codexNotify("thread/tokenUsage/updated", { tokenUsage: { total: usage(input, cached, output), last: usage(input, cached, output), modelContextWindow: window } });
export const codexDone = (status = "completed", error: string | null = null): Step =>
  codexNotify("turn/completed", { turn: { id: "$TURN", items: [], status, error: error ? { message: error } : null } });

/** A complete, ordinary Codex turn. */
export const CODEX_OK: Step[] = [
  codexNotify("turn/started", { turn: { id: "$TURN", items: [], status: "inProgress", error: null } }),
  codexMessage("Did the work."),
  codexTokens(52831, 44672, 120),
  codexDone(),
];

/** A fake `codex` that serves `app-server`. Returns its path. */
export function fakeCodex(options: FakeCodexOptions = {}): string {
  const dir = tmpDir("fake-codex"), bin = path.join(dir, "codex");
  const config = { script: options.script ?? CODEX_OK, scripts: options.scripts ?? [], missingThread: options.missingThread ?? false,
    refuseTurn: options.refuseTurn ?? null, dieAtStart: options.dieAtStart ?? null, model: options.model ?? "gpt-test",
    version: options.version ?? "codex-cli 0.155.0", models: options.models ?? null };
  fs.writeFileSync(bin, `#!/usr/bin/env node
${RUNNER}
const config = ${JSON.stringify(config)};
const args = process.argv.slice(2);
record("calls.jsonl", args);
if (args.includes("--version")) { console.log(config.version); process.exit(0); }
if (args[0] !== "app-server") { console.error("unexpected args"); process.exit(2); }
if (config.dieAtStart) { process.stderr.write(config.dieAtStart.stderr + "\\n"); process.exit(config.dieAtStart.code); }
const vars = { THREAD: "", TURN: "", SESSION: "" };
const pending = new Map();
let seq = 0, turns = 0, interrupted = false;
const reply = (id, result) => out({ id, result });
async function run(script) {
  for (const step of script) {
    if (interrupted) return;
    if ("out" in step) out(fill(step.out, vars));
    else if ("raw" in step) process.stdout.write(step.raw + "\\n");
    else if ("stderr" in step) process.stderr.write(step.stderr + "\\n");
    else if ("sleep" in step) await sleep(step.sleep);
    else if ("exit" in step) process.exit(step.exit);
    else if ("spawn" in step) require("node:child_process").spawn(process.execPath, ["-e", step.spawn], { stdio: ["ignore", "inherit", "inherit"] }).unref();
    else if ("ask" in step) {
      const id = "srv-" + ++seq;
      const answer = new Promise((resolve) => pending.set(id, resolve));
      out({ id, method: step.ask, params: fill({ threadId: "$THREAD", turnId: "$TURN", itemId: "item-" + seq, ...(step.params || {}) }, vars) });
      await answer;
    }
  }
}
require("node:readline").createInterface({ input: process.stdin }).on("line", (line) => {
  let m; try { m = JSON.parse(line); } catch { return; }
  record("stdin.jsonl", m);
  if (m.method === undefined) { const resolve = pending.get(m.id); if (resolve) { pending.delete(m.id); resolve(m); } return; }
  if (m.id === undefined) return; // a notification ("initialized")
  switch (m.method) {
    case "initialize": return reply(m.id, { userAgent: "fake-codex" });
    case "thread/start":
      vars.THREAD = "thread-" + process.pid + "-" + Date.now();
      return reply(m.id, { thread: { id: vars.THREAD }, model: config.model });
    case "thread/resume":
      if (config.missingThread) return out({ id: m.id, error: { code: -32600, message: "no rollout found for thread id " + m.params.threadId } });
      vars.THREAD = m.params.threadId;
      return reply(m.id, { thread: { id: vars.THREAD }, model: config.model });
    case "turn/start":
      if (config.refuseTurn) return out({ id: m.id, error: { code: -32600, message: config.refuseTurn } });
      // One app-server serves many turns on the same thread.
      turns++;
      vars.TURN = "turn-" + process.pid + "-" + turns;
      interrupted = false;
      record("turns.jsonl", { turn: turns, pid: process.pid, thread: vars.THREAD });
      reply(m.id, { turn: { id: vars.TURN, items: [], status: "inProgress", error: null } });
      void run(config.scripts[turns - 1] || config.script);
      return;
    case "model/list":
      if (!config.models) return out({ id: m.id, error: { code: -32601, message: "unknown method model/list" } });
      return reply(m.id, { data: config.models.map((x) => ({ model: x.id, ...x })), nextCursor: null });
    case "thread/compact/start":
      reply(m.id, {});
      return;
    case "turn/interrupt":
      interrupted = true;
      reply(m.id, {});
      out({ method: "turn/completed", params: { threadId: vars.THREAD, turn: { id: vars.TURN, items: [], status: "interrupted", error: null } } });
      return;
    default:
      return out({ id: m.id, error: { code: -32601, message: "unknown method " + m.method } });
  }
});
process.stdin.on("end", () => process.exit(0));
`, { mode: 0o755 });
  return bin;
}

/** argv of every launch except version probes. */
export const callsOf = (bin: string): string[][] => {
  const file = path.join(path.dirname(bin), "calls.jsonl");
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean)
    .map((line) => JSON.parse(line) as string[]).filter((args) => !args.includes("--version"));
};

/** Every protocol message the fake received, in order. */
export const stdinOf = (bin: string): Array<Record<string, unknown>> => {
  const file = path.join(path.dirname(bin), "stdin.jsonl");
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
};

/** The JSON-RPC requests a fake codex received, by method. */
export const rpcOf = (bin: string, method: string): Array<Record<string, unknown>> =>
  stdinOf(bin).filter((m) => m.method === method).map((m) => (m.params ?? {}) as Record<string, unknown>);

/** The prompt text a fake claude was sent (the SDK's user message). */
export const claudePromptOf = (bin: string): string => {
  const user = stdinOf(bin).filter((m) => m.type === "user").at(-1) as { message?: { content?: Array<{ text?: string }> | string } } | undefined;
  const content = user?.message?.content;
  return typeof content === "string" ? content : (content ?? []).map((c) => c.text ?? "").join("");
};

/** The last SDK initialize request a fake claude received. */
export const claudeInitOf = (bin: string): Record<string, unknown> =>
  ((stdinOf(bin).filter((m) => m.type === "control_request" && (m.request as Record<string, unknown>)?.subtype === "initialize").at(-1)?.request) ?? {}) as Record<string, unknown>;

/** Every turn a fake served: `{ turn, pid }` per turn, in order. */
export const turnsOf = (bin: string): Array<{ turn: number; pid: number; thread?: string }> => {
  const file = path.join(path.dirname(bin), "turns.jsonl");
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as { turn: number; pid: number; thread?: string });
};
