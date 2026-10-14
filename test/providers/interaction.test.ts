/**
 * Phase 3 — interaction parity, against the protocol fakes: structured
 * questions (Codex request_user_input and async questions, Claude
 * AskUserQuestion), plan mode (Codex collaboration mode, Claude plan
 * permission mode and ExitPlanMode), approvals with "allow for this session",
 * tool progress, manual compaction and reasoning effort.
 */

import { afterAll, afterEach, describe, expect, it } from "vitest";
import { setApprovalBroker, type ApprovalRequest } from "../../src/core/approvals.js";
import { ClaudeCodeAdapter, CodexAdapter, stopAllProviderSessions } from "../../src/providers/agent.js";
import type { LiveItem } from "../../src/providers/ingestion.js";
import type { AdapterEvent } from "../../src/types.js";
import { makeProjectDir } from "../helpers.js";
import {
  CLAUDE_OK, CODEX_OK, claudeInit, claudeResult, claudeText, codexDone, codexItem, codexNotify, codexTokens, fakeClaude, fakeCodex,
  rpcOf, stdinOf, type Step,
} from "../native-fakes.js";

afterEach(async () => { setApprovalBroker(null); await stopAllProviderSessions(); });
afterAll(async () => { await stopAllProviderSessions(); });

const of = (e: AdapterEvent[], kind: string): Array<Record<string, unknown>> => e.filter((x) => x.kind === kind).map((x) => x.payload);
const until = async (check: () => boolean, ms = 5000) => {
  const end = Date.now() + ms;
  while (!check()) { if (Date.now() > end) throw new Error("timed out"); await new Promise((r) => setTimeout(r, 20)); }
};
const started: Step = codexNotify("turn/started", { turn: { id: "$TURN", items: [], status: "inProgress", error: null } });
const finish: Step[] = [codexTokens(100, 0, 10), codexDone()];

function setup<T extends CodexAdapter | ClaudeCodeAdapter>(agent: T) {
  const events: AdapterEvent[] = [];
  agent.onEvent((e) => events.push(e));
  return { agent, events };
}
const codex = (bin: string, options: Record<string, unknown> = {}) => setup(new CodexAdapter("codex", makeProjectDir({ name: "ix" }), { bin, ...options }));
const claude = (bin: string, options: Record<string, unknown> = {}) => setup(new ClaudeCodeAdapter("claude", makeProjectDir({ name: "ix" }), { bin, ...options }));

describe("codex · structured questions", () => {
  it("puts request_user_input to the person and relays the answer", async () => {
    const bin = fakeCodex({ script: [started, { ask: "item/tool/requestUserInput", params: { questions: [
      { id: "db", header: "Database", question: "Which database?", options: [{ label: "Postgres", description: "relational" }, { label: "SQLite", description: "a file" }] }] } },
    codexItem({ type: "agentMessage", text: "Going with it." }), ...finish] });
    const { agent, events } = codex(bin);
    const turn = agent.send({ text: "set up storage" });
    await until(() => of(events, "needs_input").length > 0);
    const asked = of(events, "needs_input")[0]!;
    expect(asked).toMatchObject({ question: "Which database?", responseMode: "tool", questions: [{ id: "db", options: [{ label: "Postgres" }, { label: "SQLite" }] }] });
    await agent.respondToUserInput("main", String(asked.requestId), { db: "SQLite" });
    await turn;
    const answer = stdinOf(bin).find((m) => m.method === undefined && (m.result as Record<string, unknown> | undefined)?.answers);
    expect(answer?.result).toEqual({ answers: { db: { answers: ["SQLite"] } } });
    expect(of(events, "status").find((p) => p.state === "question_answered")).toMatchObject({ answers: { db: "SQLite" } });
    // the structured question already asked; the reply's text doesn't ask again
    expect(of(events, "needs_input")).toHaveLength(1);
    await agent.stop();
  });

  it("answers an unanswered question empty when the turn is interrupted", async () => {
    const bin = fakeCodex({ script: [started, { ask: "item/tool/requestUserInput", params: { questions: [
      { id: "q", header: "Q", question: "Which?", options: [{ label: "a", description: "" }] }] } }, ...finish] });
    const { agent, events } = codex(bin);
    const turn = agent.send({ text: "go" });
    await until(() => of(events, "needs_input").length > 0);
    await agent.interrupt();
    await turn;
    expect(stdinOf(bin).some((m) => m.method === undefined && JSON.stringify(m.result) === JSON.stringify({ answers: {} }))).toBe(true);
    const received = stdinOf(bin);
    expect(received.findIndex(m => m.method === undefined && JSON.stringify(m.result) === JSON.stringify({ answers: {} })))
      .toBeLessThan(received.findIndex(m => m.method === "turn/interrupt"));
    await agent.stop();
  });

  it("surfaces an async question as one to answer with the next message", async () => {
    const bin = fakeCodex({ script: [started, codexItem({ id: "m1", type: "agentMessage", text: "Which one?", delivery: "async",
      questions: [{ title: "Which one?", options: ["left", "right"] }] }), ...finish] });
    const { agent, events } = codex(bin);
    await agent.send({ text: "pick" });
    const asked = of(events, "needs_input");
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({ responseMode: "message", questions: [{ question: "Which one?", options: [{ label: "left" }, { label: "right" }] }] });
    expect(of(events, "message")[0]).toMatchObject({ text: "Which one?" });
    await agent.stop();
  });
});

describe("codex · plan mode", () => {
  it("plans in Codex's plan collaboration mode, then leaves it", async () => {
    const bin = fakeCodex({ scripts: [[started, codexItem({ type: "plan", text: "# Add caching\n\n1. Do it" }), ...finish]] });
    const { agent, events } = codex(bin, { model: "gpt-test", effort: "high" });
    await agent.send({ text: "plan caching", interactionMode: "plan" });
    await agent.send({ text: "now build it" });
    await agent.send({ text: "and test it" });
    const turns = rpcOf(bin, "turn/start");
    expect(turns[0]).toMatchObject({ effort: "high", collaborationMode: { mode: "plan", settings: { model: "gpt-test", reasoning_effort: "high" } } });
    expect(String((turns[0]!.collaborationMode as { settings: { developer_instructions: string } }).settings.developer_instructions)).toContain("Plan Mode");
    expect(turns[1]).toMatchObject({ collaborationMode: { mode: "default" } });
    expect(turns[2]!.collaborationMode).toBeUndefined();
    expect(of(events, "message").find((p) => p.proposedPlan)).toMatchObject({ text: "# Add caching\n\n1. Do it" });
    await agent.stop();
  });
});

describe("codex · approvals, tools, compaction", () => {
  it("offers allow-for-session and passes it to Codex", async () => {
    const asked: ApprovalRequest[] = [];
    setApprovalBroker(async (req) => { asked.push(req); return { behavior: "allow", scope: "session" }; });
    const bin = fakeCodex({ script: [started, { ask: "item/commandExecution/requestApproval", params: { command: "npm test" } }, ...finish] });
    const { agent } = codex(bin, { permissions: "ask" });
    await agent.send({ text: "test" });
    expect(asked[0]).toMatchObject({ tool: "shell", sessionOption: true });
    const answer = stdinOf(bin).find((m) => m.method === undefined && (m.result as Record<string, unknown> | undefined)?.decision);
    expect(answer?.result).toEqual({ decision: "acceptForSession" });
    await agent.stop();
  });

  it("streams a command's progress live, and settles only after it finishes", async () => {
    const cmd = (method: string, status: string) => codexNotify(method, { item: { id: "c1", type: "commandExecution", command: "npm test", status,
      ...(status === "completed" ? { exitCode: 0, aggregatedOutput: "ok" } : {}) } });
    const bin = fakeCodex({ script: [started, cmd("item/started", "inProgress"), codexNotify("item/commandExecution/outputDelta", { itemId: "c1", delta: "running…" }),
      ...finish, { sleep: 300 }, cmd("item/completed", "completed")] });
    const { agent, events } = codex(bin);
    const items: LiveItem[] = [];
    agent.onLiveItem((i) => items.push(i));
    await agent.send({ text: "test" });
    expect(items.map((i) => [i.phase, i.itemType, i.detail])).toEqual([["started", "command_execution", "npm test"], ["completed", "command_execution", "npm test"]]);
    // send() resolved only after the command completed
    expect(of(events, "tool_call")[0]).toMatchObject({ tool: "shell", exitCode: 0 });
    await agent.stop();
  });

  it("compacts on request", async () => {
    const bin = fakeCodex();
    const { agent } = codex(bin);
    await agent.send({ text: "one" });
    await agent.compact("main");
    expect(rpcOf(bin, "thread/compact/start")).toHaveLength(1);
    await agent.stop();
  });
});

const askTool = (tool_name: string, input: Record<string, unknown>): Step => ({ ask: { tool_name, input } });
const answersOf = (bin: string) => stdinOf(bin).filter((m) => m.type === "control_response")
  .map((m) => ((m.response as Record<string, unknown>).response ?? {}) as Record<string, unknown>);

describe("claude · questions, plans and approvals", () => {
  it("puts AskUserQuestion to the person and answers it by question text", async () => {
    const bin = fakeClaude({ script: [claudeInit, askTool("AskUserQuestion", { questions: [
      { header: "Stack", question: "Which framework?", multiSelect: false, options: [{ label: "React", description: "" }, { label: "Vue", description: "" }] }] }),
    claudeText("OK."), claudeResult()] });
    const { agent, events } = claude(bin);
    const turn = agent.send({ text: "build a UI" });
    await until(() => of(events, "needs_input").length > 0);
    const asked = of(events, "needs_input")[0]!;
    expect(asked).toMatchObject({ questions: [{ id: "Which framework?", header: "Stack" }] });
    await agent.respondToUserInput("main", String(asked.requestId), { "Which framework?": "Vue" });
    await turn;
    expect(answersOf(bin)[0]).toMatchObject({ behavior: "allow", updatedInput: { answers: { "Which framework?": "Vue" } } });
    await agent.stop();
  });

  it("plans in Claude's plan mode and captures the plan ExitPlanMode proposes", async () => {
    const bin = fakeClaude({ scripts: [[claudeInit, askTool("ExitPlanMode", { plan: "# Cache\n\nSteps" }), claudeText("Proposed."), claudeResult()]], script: CLAUDE_OK });
    const { agent, events } = claude(bin);
    await agent.send({ text: "plan caching", interactionMode: "plan" });
    await agent.send({ text: "go" });
    const modes = stdinOf(bin).filter((m) => (m.request as Record<string, unknown> | undefined)?.subtype === "set_permission_mode")
      .map((m) => (m.request as Record<string, unknown>).mode);
    expect(modes).toEqual(["plan", "acceptEdits"]);
    expect(of(events, "message").find((p) => p.proposedPlan)).toMatchObject({ text: "# Cache\n\nSteps" });
    expect(answersOf(bin)[0]).toMatchObject({ behavior: "deny" });
    await agent.stop();
  });

  it("denies an unlisted tool in auto without asking anyone", async () => {
    const asked: ApprovalRequest[] = [];
    setApprovalBroker(async (req) => { asked.push(req); return { behavior: "allow" }; });
    const bin = fakeClaude({ script: [claudeInit, askTool("Bash", { command: "rm -rf /tmp/x" }), claudeResult()] });
    const { agent } = claude(bin);
    await agent.send({ text: "clean" });
    expect(asked).toHaveLength(0);
    expect(answersOf(bin)[0]).toMatchObject({ behavior: "deny" });
    await agent.stop();
  });

  it("allows a tool for the session with the CLI's own suggestions", async () => {
    setApprovalBroker(async () => ({ behavior: "allow", scope: "session" }));
    const suggestion = { type: "addRules", rules: [{ toolName: "Bash", ruleContent: "npm test" }], behavior: "allow", destination: "localSettings" };
    const bin = fakeClaude({ script: [claudeInit, { ask: { tool_name: "Bash", input: { command: "npm test" }, permission_suggestions: [suggestion] } }, claudeResult()] });
    const { agent } = claude(bin, { permissions: "ask" });
    await agent.send({ text: "test" });
    expect(answersOf(bin)[0]).toMatchObject({ behavior: "allow", updatedPermissions: [{ ...suggestion, destination: "session" }] });
    await agent.stop();
  });

  it("compacts with /compact, as a turn", async () => {
    const bin = fakeClaude();
    const { agent } = claude(bin);
    await agent.compact("main");
    const prompt = stdinOf(bin).filter((m) => m.type === "user").at(-1) as { message: { content: Array<{ text: string }> } };
    expect(prompt.message.content[0]!.text).toBe("/compact");
    await agent.stop();
  });
});

describe("claude · plan files", () => {
  it("doesn't count plan mode's own plan file as a project edit", async () => {
    const bin = fakeClaude({ script: [claudeInit, { out: { type: "assistant", message: { content: [
      { type: "tool_use", id: "tu-w", name: "Write", input: { file_path: "/Users/someone/.claude/plans/x.md", content: "# plan" } }] }, parent_tool_use_id: null, session_id: "$SESSION" } },
    { out: { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tu-w", content: "ok" }] }, parent_tool_use_id: null, session_id: "$SESSION" } },
    claudeResult()] });
    const { agent, events } = claude(bin);
    await agent.send({ text: "plan", interactionMode: "plan" });
    expect(of(events, "file_edit")).toHaveLength(0);
    expect(of(events, "tool_call")[0]).toMatchObject({ tool: "Write" });
    await agent.stop();
  });
});
