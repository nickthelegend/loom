/**
 * The Claude Code adapter — the one every turn goes through, and the one that
 * had 0% of its functions covered.
 *
 * It is driven with a fake `claude` on disk rather than the real one. That is
 * not a compromise, it's the right instrument: this adapter's entire job is
 * translating another program's stdout into Loom events, so the thing worth
 * testing is what it does with bytes it's given — including the bytes a real
 * claude only produces when something has gone wrong, which you can't summon on
 * demand and shouldn't pay for.
 *
 * The JSONL below is the real `--output-format stream-json` shape (claude
 * 2.1.83): a system/init carrying the session id, assistant messages holding
 * content blocks, and a final result with the cost.
 */

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ClaudeCodeAdapter } from "../src/adapters/claude-code.js";
import type { AdapterEvent } from "../src/types.js";
import { makeProjectDir, tmpDir } from "./helpers.js";

/** A stand-in `claude` that prints the given lines and exits with `code`. */
function fakeClaude(lines: string[], { code = 0, stderr = "", delayMs = 0 } = {}): string {
  const dir = tmpDir("fake-claude");
  const bin = path.join(dir, "claude");
  const body = lines.map((l) => `console.log(${JSON.stringify(l)});`).join("\n");
  fs.writeFileSync(
    bin,
    `#!/usr/bin/env node
// A fake claude. Prints a recorded stream-json transcript and exits.
const args = process.argv.slice(2);
require("node:fs").writeFileSync(${JSON.stringify(path.join(dir, "argv.json"))}, JSON.stringify(args));
${stderr ? `console.error(${JSON.stringify(stderr)});` : ""}
setTimeout(() => {
  ${body}
  process.exit(${code});
}, ${delayMs});
`,
    { mode: 0o755 },
  );
  return bin;
}

/** Where the fake wrote the argv it was called with. */
function argvOf(bin: string): string[] {
  return JSON.parse(fs.readFileSync(path.join(path.dirname(bin), "argv.json"), "utf8")) as string[];
}

const INIT = (session: string) =>
  JSON.stringify({ type: "system", subtype: "init", session_id: session });
const TEXT = (text: string) =>
  JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text }] } });
const TOOL = (name: string, input: Record<string, unknown>) =>
  JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name, input }] } });
const THINK = (thinking: string) =>
  JSON.stringify({ type: "assistant", message: { content: [{ type: "thinking", thinking }] } });
const RESULT = (extra: Record<string, unknown> = {}) =>
  JSON.stringify({ type: "result", total_cost_usd: 0.0421, ...extra });

/** Run a turn against a fake claude and collect what the adapter emitted. */
async function run(
  lines: string[],
  opts: { code?: number; stderr?: string } = {},
  dir = makeProjectDir({ name: "cc" }),
): Promise<{ events: AdapterEvent[]; dir: string; bin: string; error?: Error }> {
  const bin = fakeClaude(lines, opts);
  const agent = new ClaudeCodeAdapter("claude-code", dir, { bin });
  const events: AdapterEvent[] = [];
  agent.onEvent((e) => events.push(e));
  let error: Error | undefined;
  try {
    await agent.send({ text: "do the thing" });
  } catch (err) {
    error = err as Error;
  }
  return { events, dir, bin, ...(error ? { error } : {}) };
}

const kinds = (events: AdapterEvent[]): string[] => events.map((e) => e.kind);
const of = (events: AdapterEvent[], kind: string): Array<Record<string, unknown>> =>
  events.filter((e) => e.kind === kind).map((e) => e.payload);

describe("claude-code · a normal turn", () => {
  it("reports the session, the words, and the cost", async () => {
    const { events } = await run([INIT("sess-1"), TEXT("Done."), RESULT()]);
    expect(kinds(events)).toEqual(["status", "message", "status", "run_complete"]);
    expect(of(events, "status")[0]).toMatchObject({ state: "turn_started", session: "sess-1" });
    expect(of(events, "message")[0]).toMatchObject({ text: "Done." });
    expect(of(events, "status")[1]).toMatchObject({ state: "turn_cost", costUsd: 0.0421 });
  });

  it("remembers the session so the next turn resumes it", async () => {
    const dir = makeProjectDir({ name: "cc" });
    await run([INIT("sess-abc"), TEXT("hi"), RESULT()], {}, dir);

    // second turn, same project: --resume must carry the id from the first
    const second = fakeClaude([INIT("sess-abc"), TEXT("again"), RESULT()]);
    const agent = new ClaudeCodeAdapter("claude-code", dir, { bin: second });
    await agent.send({ text: "more" });
    const argv = argvOf(second);
    expect(argv).toContain("--resume");
    expect(argv[argv.indexOf("--resume") + 1]).toBe("sess-abc");
  });

  it("passes a handoff briefing through the system-prompt channel", async () => {
    const bin = fakeClaude([INIT("s"), TEXT("ok"), RESULT()]);
    const agent = new ClaudeCodeAdapter("claude-code", makeProjectDir({ name: "cc" }), { bin });
    await agent.send({ text: "go", briefing: "you are picking up from opencode" });
    const argv = argvOf(bin);
    // this is the channel that makes claude's memory injection strong — the
    // briefing must not silently become part of the user's prompt
    expect(argv).toContain("--append-system-prompt");
    expect(argv[argv.indexOf("--append-system-prompt") + 1]).toBe("you are picking up from opencode");
    expect(argv[argv.indexOf("-p") + 1]).toBe("go");
  });

  it("asks for the permission mode it was configured with", async () => {
    const bin = fakeClaude([INIT("s"), TEXT("ok"), RESULT()]);
    const agent = new ClaudeCodeAdapter("claude-code", makeProjectDir({ name: "cc" }), {
      bin,
      permissionMode: "plan",
      model: "opus",
    });
    await agent.send({ text: "go" });
    const argv = argvOf(bin);
    expect(argv[argv.indexOf("--permission-mode") + 1]).toBe("plan");
    expect(argv[argv.indexOf("--model") + 1]).toBe("opus");
  });
});

describe("claude-code · what it did, not just what it said", () => {
  it("reports tool calls with a readable summary", async () => {
    const { events } = await run([
      INIT("s"),
      TOOL("Bash", { command: "npm test" }),
      TEXT("green"),
      RESULT(),
    ]);
    expect(of(events, "tool_call")[0]).toMatchObject({ tool: "Bash" });
    expect(String(of(events, "tool_call")[0]?.summary)).toContain("npm test");
  });

  /**
   * file_edit is what the board and the diff attribution are built on, so it
   * must fire for the tools that write and stay quiet for the ones that don't.
   */
  it("raises file_edit for writes, and not for reads", async () => {
    const { events } = await run([
      INIT("s"),
      TOOL("Read", { file_path: "/repo/read-only.ts" }),
      TOOL("Edit", { file_path: "/repo/changed.ts" }),
      TOOL("Write", { file_path: "/repo/new.ts" }),
      RESULT(),
    ]);
    const edits = of(events, "file_edit").map((p) => p.path);
    expect(edits).toEqual(["/repo/changed.ts", "/repo/new.ts"]);
    expect(edits).not.toContain("/repo/read-only.ts");
  });

  /**
   * Extended thinking used to be dropped on the floor: the content loop only
   * matched text and tool_use. Now it surfaces as a reasoning-tagged message so
   * the thread can fold it into a "thinking" block — distinct from the reply.
   */
  it("surfaces extended-thinking blocks as reasoning, kept apart from the reply", async () => {
    const { events } = await run([
      INIT("s"),
      THINK("Let me weigh the two approaches before I answer."),
      TEXT("Use the second approach."),
      RESULT(),
    ]);
    const msgs = of(events, "message");
    const reasoning = msgs.filter((p) => p.reasoning);
    const replies = msgs.filter((p) => !p.reasoning);
    expect(reasoning).toHaveLength(1);
    expect(String(reasoning[0]!.text)).toContain("weigh the two approaches");
    // the reply is the reply — thinking never becomes the assistant's answer
    expect(replies.map((p) => p.text)).toEqual(["Use the second approach."]);
  });

  it("ignores an empty thinking block", async () => {
    const { events } = await run([INIT("s"), THINK("   "), TEXT("done"), RESULT()]);
    expect(of(events, "message").filter((p) => p.reasoning)).toHaveLength(0);
  });

  it("follows a notebook edit to its notebook", async () => {
    const { events } = await run([
      INIT("s"),
      TOOL("NotebookEdit", { notebook_path: "/repo/nb.ipynb" }),
      RESULT(),
    ]);
    expect(of(events, "file_edit")[0]).toMatchObject({ path: "/repo/nb.ipynb", tool: "NotebookEdit" });
  });
});

describe("claude-code · when it needs you", () => {
  it("flags a turn that ended on a question", async () => {
    const { events } = await run([
      INIT("s"),
      TEXT("Which database should I use?"),
      RESULT(),
    ]);
    expect(kinds(events)).toContain("needs_input");
    expect(String(of(events, "needs_input")[0]?.question)).toContain("Which database");
  });

  it("doesn't flag a turn that merely mentions a question", async () => {
    const { events } = await run([
      INIT("s"),
      TEXT("You asked which database? I picked postgres."),
      RESULT(),
    ]);
    expect(kinds(events)).not.toContain("needs_input");
  });
});

describe("claude-code · when it goes wrong", () => {
  it("surfaces an error result and still finishes the turn", async () => {
    const { events, error } = await run([
      INIT("s"),
      RESULT({ is_error: true, result: "rate limited" }),
    ]);
    expect(of(events, "error")[0]).toMatchObject({ message: "rate limited" });
    // a reported error is a completed turn, not a crashed adapter
    expect(kinds(events)).toContain("run_complete");
    expect(error).toBeUndefined();
  });

  /**
   * A non-zero exit with no result at all is different: nothing was reported,
   * so the turn genuinely failed and the caller has to hear about it.
   */
  it("throws when the CLI dies without saying anything", async () => {
    const { events, error } = await run([], { code: 1, stderr: "not logged in" });
    expect(error).toBeDefined();
    expect(String(error?.message)).toContain("not logged in");
    expect(of(events, "error")[0]?.stderr).toContain("not logged in");
  });

  it("ignores noise on stdout that isn't JSON", async () => {
    const { events, error } = await run([
      "Warning: something cosmetic",
      INIT("s"),
      "not json either",
      TEXT("fine"),
      RESULT(),
    ]);
    expect(error).toBeUndefined();
    expect(of(events, "message")[0]).toMatchObject({ text: "fine" });
  });

  it("reports itself unavailable when the binary isn't there", async () => {
    const agent = new ClaudeCodeAdapter("claude-code", makeProjectDir({ name: "cc" }), {
      bin: "/nope/claude",
    });
    expect(await agent.available()).toBe(false);
  });

  it("refuses a second turn while one is running", async () => {
    const bin = fakeClaude([INIT("s"), TEXT("ok"), RESULT()], { delayMs: 400 });
    const agent = new ClaudeCodeAdapter("claude-code", makeProjectDir({ name: "cc" }), { bin });
    const first = agent.send({ text: "one" });
    expect(agent.busy()).toBe(true);
    await expect(agent.send({ text: "two" })).rejects.toThrow(/busy/);
    await first;
    expect(agent.busy()).toBe(false);
  });
});

describe("claude-code · interrupt", () => {
  it("stops a running turn and says it was interrupted", async () => {
    const bin = fakeClaude([INIT("s"), TEXT("never gets here"), RESULT()], { delayMs: 10_000 });
    const agent = new ClaudeCodeAdapter("claude-code", makeProjectDir({ name: "cc" }), { bin });
    const events: AdapterEvent[] = [];
    agent.onEvent((e) => events.push(e));

    const turn = agent.send({ text: "long one" });
    await new Promise((r) => setTimeout(r, 250)); // let it actually start
    await agent.interrupt();
    await turn;

    expect(kinds(events)).toContain("status");
    expect(of(events, "status").some((p) => p.state === "interrupted")).toBe(true);
    // interrupted is not completed: the turn didn't finish, and saying it did
    // would put a lie in the thread
    expect(kinds(events)).not.toContain("run_complete");
    expect(agent.busy()).toBe(false);
  }, 20_000);

  it("is a no-op when nothing is running", async () => {
    const agent = new ClaudeCodeAdapter("claude-code", makeProjectDir({ name: "cc" }), {});
    await expect(agent.interrupt()).resolves.toBeUndefined();
  });
});
