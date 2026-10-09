/**
 * The Claude Code adapter — driven through the Claude Agent SDK against a fake
 * `claude` that speaks the CLI's stream-json control protocol (see
 * native-fakes.ts).
 *
 * This adapter's job is translating another program's messages into Loom
 * events, so the thing worth testing is what it does with messages it's given
 * — including the ones a real claude only produces when something has gone
 * wrong, which you can't summon on demand and shouldn't pay for.
 */

import { afterAll, afterEach, describe, expect, it } from "vitest";
import { ClaudeCodeAdapter, stopAllProviderSessions } from "../src/providers/agent.js";
import { setApprovalBroker, type ApprovalRequest } from "../src/core/approvals.js";
import { NativeSessionMissing } from "../src/core/continuity/contracts.js";
import type { AdapterEvent, SendInput } from "../src/types.js";
import { makeProjectDir } from "./helpers.js";
import { CLAUDE_OK, callsOf, claudeInit, claudeInitOf, claudePromptOf, claudeResult, claudeText, claudeThink, claudeTool,
  fakeClaude, stdinOf, type FakeClaudeOptions, type Step } from "./native-fakes.js";

// Provider sessions stay warm between turns; end them with the file.
afterAll(async () => { await stopAllProviderSessions(); });

afterEach(() => setApprovalBroker(null));

async function run(
  script: Step[],
  opts: Omit<FakeClaudeOptions, "script"> = {},
  input: Partial<SendInput> = {},
  agentOptions: Record<string, unknown> = {},
  dir = makeProjectDir({ name: "cc" }),
): Promise<{ events: AdapterEvent[]; dir: string; bin: string; error?: Error }> {
  const bin = fakeClaude({ script, ...opts });
  const agent = new ClaudeCodeAdapter("claude-code", dir, { bin, ...agentOptions });
  const events: AdapterEvent[] = [];
  agent.onEvent((e) => events.push(e));
  let error: Error | undefined;
  try {
    await agent.send({ text: "do the thing", ...input });
  } catch (err) {
    error = err as Error;
  }
  return { events, dir, bin, ...(error ? { error } : {}) };
}

const kinds = (events: AdapterEvent[]): string[] => events.map((e) => e.kind);
const of = (events: AdapterEvent[], kind: string): Array<Record<string, unknown>> =>
  events.filter((e) => e.kind === kind).map((e) => e.payload);
const states = (events: AdapterEvent[]): unknown[] => of(events, "status").map((p) => p.state);
/** A flag's value, in either `--name value` or `--name=value` form. */
const flag = (argv: string[], name: string): string | undefined => {
  const joined = argv.find((a) => a.startsWith(`${name}=`));
  if (joined) return joined.slice(name.length + 1);
  return argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined;
};

describe("claude-code · a normal turn", () => {
  it("reports the session, the words, and the cost", async () => {
    const { events } = await run([claudeInit, claudeText("Done."), claudeResult()]);
    expect(of(events, "status")[0]).toMatchObject({ state: "turn_started" });
    expect(of(events, "message")).toEqual([{ text: "Done." }]);
    expect(of(events, "status").find((p) => p.state === "turn_cost")).toMatchObject({ costUsd: 0.0421 });
    expect(kinds(events).at(-1)).toBe("run_complete");
  });

  it("captures token usage from the result and rides it on run_complete", async () => {
    const { events } = await run([claudeInit, claudeText("ok"),
      claudeResult({ usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 20, cache_creation_input_tokens: 5 } })]);
    // cache reads + creations count as input tokens (100 + 20 + 5), output = 50
    expect(of(events, "run_complete")[0]).toMatchObject({ inputTokens: 125, outputTokens: 50, model: "claude-test" });
  });

  it("remembers the session so the next turn resumes it", async () => {
    const dir = makeProjectDir({ name: "cc" });
    const first = await run(CLAUDE_OK, {}, {}, {}, dir);
    const session = of(first.events, "status")[0]!.session as string;
    const second = await run(CLAUDE_OK, {}, { text: "more" }, {}, dir);
    expect(flag(callsOf(second.bin)[0]!, "--resume")).toBe(session);
  });

  /**
   * A warm session's system prompt is fixed when it starts, so a handoff
   * briefing rides in front of the turn's text, framed as authoritative.
   */
  it("puts a handoff briefing in front of the prompt, framed", async () => {
    const { bin } = await run(CLAUDE_OK, {}, { text: "go", briefing: "you are picking up from opencode" });
    expect(claudeInitOf(bin).appendSystemPrompt).toBeUndefined();
    expect(claudePromptOf(bin)).toMatch(/LOOM SESSION MEMORY[\s\S]*you are picking up from opencode[\s\S]*\n\ngo$/);
  });

  it("loads Claude Code's own settings, as an interactive claude would", async () => {
    const { bin } = await run(CLAUDE_OK);
    expect(callsOf(bin)[0]).toContain("--setting-sources=user,project,local");
  });

  it("asks for the permission mode and model it was configured with", async () => {
    const { bin } = await run(CLAUDE_OK, {}, {}, { permissionMode: "plan", model: "opus" });
    const argv = callsOf(bin)[0]!;
    expect(flag(argv, "--permission-mode")).toBe("plan");
    expect(flag(argv, "--model")).toBe("opus");
  });

  it("maps Loom's permission modes onto Claude's", async () => {
    const bypass = await run(CLAUDE_OK, {}, {}, { permissions: "bypass" });
    expect(flag(callsOf(bypass.bin)[0]!, "--permission-mode")).toBe("bypassPermissions");
    const auto = await run(CLAUDE_OK, {}, {}, { permissions: "auto" });
    expect(flag(callsOf(auto.bin)[0]!, "--permission-mode")).toBe("acceptEdits");
    // "ask" with nobody to ask degrades to plan (read-only), never to allow
    const ask = await run(CLAUDE_OK, {}, {}, { permissions: "ask" });
    expect(flag(callsOf(ask.bin)[0]!, "--permission-mode")).toBe("plan");
  });

  it("passes extra CLI args through", async () => {
    const { bin } = await run(CLAUDE_OK, {}, {}, { extraArgs: ["--max-turns", "3", "--debug"] });
    const argv = callsOf(bin)[0]!;
    expect(argv).toContain("--max-turns");
    expect(argv).toContain("--debug");
  });
});

describe("claude-code · what it did, not just what it said", () => {
  it("reports tool calls with a readable summary", async () => {
    const { events } = await run([claudeInit, claudeTool("Bash", { command: "npm test" }), claudeText("green"), claudeResult()]);
    // Commands are one canonical kind across providers.
    expect(of(events, "tool_call")[0]).toMatchObject({ tool: "shell" });
    expect(String(of(events, "tool_call")[0]?.summary)).toContain("npm test");
  });

  /**
   * file_edit is what the board and the diff attribution are built on, so it
   * must fire for the tools that write and stay quiet for the ones that don't.
   */
  it("raises file_edit for writes, and not for reads", async () => {
    const { events } = await run([claudeInit, claudeTool("Read", { file_path: "src/read-only.ts" }),
      claudeTool("Edit", { file_path: "src/changed.ts" }), claudeTool("Write", { file_path: "src/new.ts" }), claudeResult()]);
    expect(of(events, "file_edit").map((p) => p.path)).toEqual(["src/changed.ts", "src/new.ts"]);
  });

  it("surfaces extended-thinking blocks as reasoning, kept apart from the reply", async () => {
    const { events } = await run([claudeInit, claudeThink("Let me weigh the two approaches before I answer."),
      claudeText("Use the second approach."), claudeResult()]);
    const msgs = of(events, "message");
    expect(msgs.filter((p) => p.reasoning).map((p) => p.text)).toEqual(["Let me weigh the two approaches before I answer."]);
    expect(msgs.filter((p) => !p.reasoning).map((p) => p.text)).toEqual(["Use the second approach."]);
  });

  it("ignores an empty thinking block", async () => {
    const { events } = await run([claudeInit, claudeThink("   "), claudeText("done"), claudeResult()]);
    expect(of(events, "message").filter((p) => p.reasoning)).toHaveLength(0);
  });

  it("follows a notebook edit to its notebook", async () => {
    const { events } = await run([claudeInit, claudeTool("NotebookEdit", { notebook_path: "nb.ipynb" }), claudeResult()]);
    expect(of(events, "file_edit")[0]).toMatchObject({ path: "nb.ipynb", tool: "NotebookEdit" });
  });
});

describe("claude-code · context, compaction and limits", () => {
  it("reports tokens in context against the model's window", async () => {
    const { events } = await run([claudeInit,
      claudeText("hi", { usage: { input_tokens: 1000, cache_read_input_tokens: 9000, cache_creation_input_tokens: 0, output_tokens: 50 } }),
      claudeResult({ modelUsage: { "claude-test": { contextWindow: 200000 } } })]);
    const usage = of(events, "status").filter((p) => p.state === "context_usage");
    expect(usage[0]).toMatchObject({ usedTokens: 10050, autoCompacts: true });
    // the window is only known once a result names it
    expect(usage.at(-1)).toMatchObject({ usedTokens: 10050, maxTokens: 200000 });
  });

  it("ignores a sub-agent's usage — that is another context", async () => {
    const { events } = await run([claudeInit,
      { out: { type: "assistant", message: { content: [], usage: { input_tokens: 99999, output_tokens: 1 } }, parent_tool_use_id: "tu-task", session_id: "$SESSION" } },
      claudeResult()]);
    expect(of(events, "status").filter((p) => p.state === "context_usage")).toHaveLength(0);
  });

  it("shows compaction as it happens, then what the context holds after", async () => {
    const { events } = await run([claudeInit,
      { out: { type: "system", subtype: "status", status: "compacting", session_id: "$SESSION" } },
      { out: { type: "system", subtype: "compact_boundary", compact_metadata: { trigger: "auto", pre_tokens: 180000, post_tokens: 12000 }, session_id: "$SESSION" } },
      { out: { type: "system", subtype: "status", status: null, compact_result: "success", session_id: "$SESSION" } },
      claudeText("carrying on"), claudeResult()]);
    expect(states(events)).toContain("compacting");
    expect(of(events, "status").find((p) => p.state === "native_compacted")).toMatchObject({ trigger: "auto", preTokens: 180000, postTokens: 12000 });
    expect(of(events, "status").find((p) => p.state === "context_usage")).toMatchObject({ usedTokens: 12000 });
    expect(states(events).indexOf("compacting")).toBeLessThan(states(events).indexOf("native_compacted"));
  });

  it("says when compaction failed", async () => {
    const { events } = await run([claudeInit,
      { out: { type: "system", subtype: "status", status: null, compact_result: "failed", compact_error: "too large", session_id: "$SESSION" } },
      claudeResult()]);
    expect(of(events, "status").find((p) => p.state === "notice")).toMatchObject({ message: "compaction failed: too large" });
  });

  it("reports usage-limit windows as percentages", async () => {
    const { events } = await run([claudeInit,
      { out: { type: "rate_limit_event", rate_limit_info: { status: "allowed_warning", rateLimitType: "five_hour", utilization: 0.873, resetsAt: 1_800_000_000 }, session_id: "$SESSION" } },
      claudeResult()]);
    expect(of(events, "status").find((p) => p.state === "usage_limits")).toEqual({ state: "usage_limits", provider: "claude",
      windows: [{ id: "five_hour", usedPercent: 87.3, windowMinutes: 300, resetsAt: 1_800_000_000_000 }] });
    expect(states(events)).not.toContain("notice");
  });

  it("says why a turn is waiting when a limit is reached", async () => {
    const { events } = await run([claudeInit,
      { out: { type: "rate_limit_event", rate_limit_info: { status: "rejected", rateLimitType: "seven_day", utilization: 1 }, session_id: "$SESSION" } },
      claudeResult()]);
    expect(of(events, "status").find((p) => p.state === "usage_limits")).toMatchObject({ reached: "seven_day" });
    expect(String(of(events, "status").find((p) => p.state === "notice")?.message)).toMatch(/usage limit reached/);
  });
});

describe("claude-code · always ask", () => {
  it("puts each permission prompt in front of a person, and relays the answer", async () => {
    const asked: ApprovalRequest[] = [];
    setApprovalBroker(async (req) => { asked.push(req); return req.tool === "Bash" ? { behavior: "allow" } : { behavior: "deny", message: "no" }; });
    const { bin, error } = await run([claudeInit,
      { ask: { tool_name: "Bash", input: { command: "rm -rf build" } } },
      { ask: { tool_name: "Write", input: { file_path: "/repo/x" } } },
      claudeResult()], {}, {}, { permissions: "ask", loomProject: "p1" });
    expect(error).toBeUndefined();
    expect(flag(callsOf(bin)[0]!, "--permission-mode")).toBe("default");
    expect(asked.map((a) => [a.project, a.tool, a.summary])).toEqual([["p1", "Bash", "Bash: rm -rf build"], ["p1", "Write", "Write: /repo/x"]]);
    const answers = stdinOf(bin).filter((m) => m.type === "control_response")
      .map((m) => ((m.response as Record<string, unknown>).response as Record<string, unknown>).behavior);
    expect(answers).toEqual(["allow", "deny"]);
  });
});

describe("claude-code · when it needs you", () => {
  it("flags a turn that ended on a question", async () => {
    const { events } = await run([claudeInit, claudeText("Which database should I use?"), claudeResult()]);
    expect(String(of(events, "needs_input")[0]?.question)).toContain("Which database");
  });

  it("doesn't flag a turn that merely mentions a question", async () => {
    const { events } = await run([claudeInit, claudeText("You asked which database? I picked postgres."), claudeResult()]);
    expect(kinds(events)).not.toContain("needs_input");
  });
});

describe("claude-code · when it goes wrong", () => {
  it("surfaces an error result as the turn's end", async () => {
    const { events, error } = await run([claudeInit,
      claudeResult({ subtype: "error_during_execution", is_error: true, errors: ["rate limited"] })]);
    expect(of(events, "error")[0]).toMatchObject({ message: "rate limited" });
    // a failed turn is an error, not a completion (t3code's rule); the error
    // event ends it, so send() does not report it a second time
    expect(kinds(events)).not.toContain("run_complete");
    expect(error).toBeUndefined();
  });

  it("fails a continuity turn whose result is an error", async () => {
    const { error } = await run([claudeInit, claudeResult({ subtype: "error_during_execution", is_error: true, errors: ["boom"] })], {},
      { continuity: { runId: "r", bindingId: "b", sessionEpoch: 1, nativeSessionId: null, context: "ctx" } });
    expect(error?.message).toMatch(/failed turn/);
  });

  /**
   * A non-zero exit with no result at all is different: nothing was reported,
   * so the turn genuinely failed and the caller has to hear about it.
   */
  it("throws when the CLI dies without saying anything", async () => {
    const { events, error } = await run([{ stderr: "not logged in" }, { exit: 1 }]);
    expect(String(error?.message)).toContain("not logged in");
    expect(of(events, "error")[0]?.stderr).toContain("not logged in");
  });

  it("explains a signed-out account", async () => {
    const { events } = await run([claudeInit, claudeText("Invalid API key", { usage: { input_tokens: 0, output_tokens: 0 } }),
      { out: { type: "assistant", error: "authentication_failed", message: { content: [] }, parent_tool_use_id: null, session_id: "$SESSION" } },
      claudeResult()]);
    expect(of(events, "error").some((p) => /not signed in/.test(String(p.message)))).toBe(true);
  });

  it("ignores noise on stdout that isn't JSON", async () => {
    const { events, error } = await run([{ raw: "Warning: something cosmetic" }, claudeInit, { raw: "not json either" },
      claudeText("fine"), claudeResult()]);
    expect(error).toBeUndefined();
    expect(of(events, "message")[0]).toMatchObject({ text: "fine" });
  });

  it("starts a new session when the stored one is gone", async () => {
    const dir = makeProjectDir({ name: "cc" });
    await run(CLAUDE_OK, {}, {}, {}, dir);
    const { events, error, bin } = await run(CLAUDE_OK, { missingSession: true }, {}, {}, dir);
    expect(error).toBeUndefined();
    expect(callsOf(bin).map((argv) => flag(argv, "--resume") !== undefined)).toEqual([true, false]);
    expect(kinds(events)).toContain("run_complete");
  });

  it("reports a lost native session to Brain instead of starting over", async () => {
    const { error, events } = await run(CLAUDE_OK, { missingSession: true },
      { continuity: { runId: "r", bindingId: "b", sessionEpoch: 1, nativeSessionId: "6f1c2a4e-0000-4000-8000-000000000000", context: "ctx" } });
    expect(error).toBeInstanceOf(NativeSessionMissing);
    expect(states(events)).not.toContain("native_turn_accepted");
  });

  it("reports itself unavailable when the binary isn't there", async () => {
    const agent = new ClaudeCodeAdapter("claude-code", makeProjectDir({ name: "cc" }), { bin: "/nope/claude" });
    expect(await agent.available()).toBe(false);
  });

  it("refuses a second turn while one is running", async () => {
    const bin = fakeClaude({ script: [{ sleep: 400 }, ...CLAUDE_OK] });
    const agent = new ClaudeCodeAdapter("claude-code", makeProjectDir({ name: "cc" }), { bin });
    const first = agent.send({ text: "one" });
    expect(agent.busy()).toBe(true);
    await expect(agent.send({ text: "two" })).rejects.toThrow(/busy/);
    await first;
    expect(agent.busy()).toBe(false);
  });
});

describe("claude-code · continuity", () => {
  it("sends the context packet in the prompt and marks acceptance", async () => {
    const { bin, events } = await run(CLAUDE_OK, {}, { text: "go", briefing: "skills",
      continuity: { runId: "run", bindingId: "b", sessionEpoch: 1, nativeSessionId: null, context: "PACKET" } });
    expect(claudePromptOf(bin)).toBe("PACKET\n\nskills\n\ngo");
    expect(claudeInitOf(bin).appendSystemPrompt).toBeUndefined();
    expect(of(events, "status").find((p) => p.state === "native_turn_accepted")).toMatchObject({ loomRunId: "run" });
    expect(kinds(events).at(-1)).toBe("run_complete");
  });

  it("a process exit with no result cannot manufacture run_complete", async () => {
    const { events, error } = await run([claudeInit, claudeText("partial"), { exit: 0 }], {},
      { continuity: { runId: "r", bindingId: "b", sessionEpoch: 1, nativeSessionId: null, context: "ctx" } });
    expect(error?.message).toMatch(/outcome is unknown/);
    expect(kinds(events)).not.toContain("run_complete");
  });
});

describe("claude-code · interrupt", () => {
  it("stops a running turn and says it was interrupted", async () => {
    const bin = fakeClaude({ scripts: [[claudeInit, { sleep: 10_000 }, claudeText("never gets here"), claudeResult()]], script: CLAUDE_OK });
    const agent = new ClaudeCodeAdapter("claude-code", makeProjectDir({ name: "cc" }), { bin });
    const events: AdapterEvent[] = [];
    agent.onEvent((e) => events.push(e));
    const turn = agent.send({ text: "long one" });
    await new Promise((r) => setTimeout(r, 500)); // let it actually start
    await agent.interrupt();
    await turn;
    expect(states(events)).toContain("interrupted");
    // interrupted is not completed, and the interrupt's own error result is not an error
    expect(kinds(events)).not.toContain("run_complete");
    expect(kinds(events)).not.toContain("error");
    // A hard boundary, as t3code has it: the session's process is gone, and the
    // next turn resumes the same native session.
    expect(agent.busy()).toBe(false);
    await agent.send({ text: "again" });
    const launches = callsOf(bin);
    expect(launches).toHaveLength(2);
    expect(flag(launches[1]!, "--resume")).toBe(flag(launches[0]!, "--session-id"));
  }, 20_000);

  it("is a no-op when nothing is running", async () => {
    const agent = new ClaudeCodeAdapter("claude-code", makeProjectDir({ name: "cc" }), {});
    await expect(agent.interrupt()).resolves.toBeUndefined();
  });
});

describe("claude-code · what its tools did", () => {
  const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
  const result = (id: string, content: unknown, isError = false): Step =>
    ({ out: { type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content, ...(isError ? { is_error: true } : {}) }] }, parent_tool_use_id: null, session_id: "$SESSION" } });

  it("shows an image a tool returned, files it, and keeps an error as an error", async () => {
    const { events, dir } = await run([claudeInit,
      claudeTool("mcp__playwright__screenshot", { url: "http://localhost:3000" }),
      result("tu-mcp__playwright__screenshot", [{ type: "text", text: "captured" }, { type: "image", source: { type: "base64", media_type: "image/png", data: PNG } }]),
      claudeTool("Read", { file_path: "missing.ts" }),
      result("tu-Read", "File does not exist.", true),
      claudeText("Done."), claudeResult()]);
    const [shot, read] = of(events, "tool_call");
    expect(shot).toMatchObject({ tool: "screenshot", server: "playwright", ok: true, preview: "captured" });
    const img = (shot!.images as Array<{ path: string }>)[0]!.path;
    expect(img).toMatch(/^\.loom\/attachments\/[0-9a-f]{12}\.png$/);
    expect((await import("node:fs")).existsSync(`${dir}/${img}`)).toBe(true);
    expect(read).toMatchObject({ tool: "Read", ok: false, error: "File does not exist." });
  });

  it("turns TodoWrite into the plan checklist", async () => {
    const { events } = await run([claudeInit,
      claudeTool("TodoWrite", { todos: [{ content: "Write tests", status: "completed", activeForm: "Writing tests" }, { content: "Fix the bug", status: "in_progress", activeForm: "Fixing" }] }),
      result("tu-TodoWrite", "ok"), claudeText("Working."), claudeResult()]);
    expect(of(events, "status").find((p) => p.state === "plan_updated")).toMatchObject({ plan: [
      { step: "Write tests", status: "completed" }, { step: "Fix the bug", status: "inProgress" }] });
    expect(of(events, "tool_call")[0]!.summary).toBe("TodoWrite: 1/2 done");
  });
});
