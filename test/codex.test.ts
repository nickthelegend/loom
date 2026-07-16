/**
 * The Codex adapter, driven with a fake `codex` on disk.
 *
 * The JSONL here is not invented — it's what codex-cli 0.142.4 actually printed
 * when asked to run a command and write a file, captured and pasted. That
 * matters: an adapter test written against a schema someone imagined is a test
 * of the imagination.
 *
 * The real CLI isn't used because a turn costs money and needs an account, and
 * because the interesting cases (a thread that fails, junk on stdout, a
 * non-zero exit) are ones you can't ask a working CLI to produce.
 */

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CodexAdapter } from "../src/adapters/codex.js";
import type { AdapterEvent } from "../src/types.js";
import { makeProjectDir, tmpDir } from "./helpers.js";

function fakeCodex(lines: string[], { code = 0, stderr = "", delayMs = 0 } = {}): string {
  const dir = tmpDir("fake-codex");
  const bin = path.join(dir, "codex");
  fs.writeFileSync(
    bin,
    `#!/usr/bin/env node
require("node:fs").writeFileSync(${JSON.stringify(path.join(dir, "argv.json"))}, JSON.stringify(process.argv.slice(2)));
${stderr ? `console.error(${JSON.stringify(stderr)});` : ""}
setTimeout(() => {
${lines.map((l) => `  console.log(${JSON.stringify(l)});`).join("\n")}
  process.exit(${code});
}, ${delayMs});
`,
    { mode: 0o755 },
  );
  return bin;
}

const argvOf = (bin: string): string[] =>
  JSON.parse(fs.readFileSync(path.join(path.dirname(bin), "argv.json"), "utf8")) as string[];

// Verbatim from a real `codex exec --json` run.
const THREAD = (id: string) => JSON.stringify({ type: "thread.started", thread_id: id });
const TURN_STARTED = JSON.stringify({ type: "turn.started" });
const MSG = (text: string) =>
  JSON.stringify({ type: "item.completed", item: { id: "i", type: "agent_message", text } });
const SHELL = (command: string, exit = 0) =>
  JSON.stringify({
    type: "item.completed",
    item: { id: "i", type: "command_execution", command, aggregated_output: "ok\n", exit_code: exit, status: "completed" },
  });
const FILES = (changes: Array<{ path: string; kind: string }>) =>
  JSON.stringify({ type: "item.completed", item: { id: "i", type: "file_change", changes } });
const TURN_DONE = JSON.stringify({
  type: "turn.completed",
  usage: { input_tokens: 52831, cached_input_tokens: 44672, output_tokens: 120, reasoning_output_tokens: 0 },
});

async function run(
  lines: string[],
  opts: { code?: number; stderr?: string } = {},
  dir = makeProjectDir({ name: "cx" }),
): Promise<{ events: AdapterEvent[]; dir: string; error?: Error }> {
  const bin = fakeCodex(lines, opts);
  const agent = new CodexAdapter("codex", dir, { bin });
  const events: AdapterEvent[] = [];
  agent.onEvent((e) => events.push(e));
  let error: Error | undefined;
  try {
    await agent.send({ text: "do it" });
  } catch (err) {
    error = err as Error;
  }
  return { events, dir, ...(error ? { error } : {}) };
}

const kinds = (e: AdapterEvent[]): string[] => e.map((x) => x.kind);
const of = (e: AdapterEvent[], kind: string): Array<Record<string, unknown>> =>
  e.filter((x) => x.kind === kind).map((x) => x.payload);

describe("codex · a normal turn", () => {
  it("reports the thread, the words, and the tokens", async () => {
    const { events } = await run([THREAD("019f-abc"), TURN_STARTED, MSG("Done."), TURN_DONE]);
    expect(of(events, "status")[0]).toMatchObject({ state: "turn_started", session: "019f-abc" });
    expect(of(events, "message")[0]).toMatchObject({ text: "Done." });
    expect(kinds(events)).toContain("run_complete");
  });

  /**
   * Codex reports tokens and never money. Loom reports what it's told: a USD
   * figure here would have to come from a price table we'd maintain and get
   * wrong, and a confident wrong number is worse than an honest absent one.
   */
  it("reports tokens, and never invents a cost", async () => {
    const { events } = await run([THREAD("t"), MSG("hi"), TURN_DONE]);
    const usage = of(events, "status").find((p) => p.state === "turn_tokens");
    expect(usage).toMatchObject({ inputTokens: 52831, outputTokens: 120, cachedInputTokens: 44672 });
    expect(of(events, "status").some((p) => "costUsd" in p)).toBe(false);
  });

  it("resumes the thread on the next turn", async () => {
    const dir = makeProjectDir({ name: "cx" });
    await run([THREAD("019f-keep"), MSG("one"), TURN_DONE], {}, dir);

    const second = fakeCodex([THREAD("019f-keep"), MSG("two"), TURN_DONE]);
    await new CodexAdapter("codex", dir, { bin: second }).send({ text: "more" });
    const argv = argvOf(second);
    expect(argv.slice(0, 3)).toEqual(["exec", "resume", "019f-keep"]);
  });

  it("runs in the project, out of git's way, with the sandbox it was given", async () => {
    const dir = makeProjectDir({ name: "cx" });
    const bin = fakeCodex([THREAD("t"), MSG("ok"), TURN_DONE]);
    await new CodexAdapter("codex", dir, { bin, sandbox: "read-only", model: "o3" }).send({ text: "go" });
    const argv = argvOf(bin);
    expect(argv[argv.indexOf("-C") + 1]).toBe(dir);
    expect(argv[argv.indexOf("-s") + 1]).toBe("read-only");
    expect(argv[argv.indexOf("-m") + 1]).toBe("o3");
    // codex refuses to run outside a repo without this, and Loom's projects
    // aren't always repos
    expect(argv).toContain("--skip-git-repo-check");
    expect(argv).toContain("--json");
  });

  /**
   * `codex exec` has no --append-system-prompt, so a handoff briefing has to
   * ride in front of the text. It must still reach the model — dropping it
   * silently would make a handoff look like it worked while the next agent
   * knows nothing.
   */
  it("carries a briefing in front of the prompt", async () => {
    const bin = fakeCodex([THREAD("t"), MSG("ok"), TURN_DONE]);
    await new CodexAdapter("codex", makeProjectDir({ name: "cx" }), { bin }).send({
      text: "fix the bug",
      briefing: "claude was here first",
    });
    const prompt = argvOf(bin).at(-1)!;
    expect(prompt).toContain("claude was here first");
    expect(prompt).toContain("fix the bug");
    expect(prompt.indexOf("claude was here")).toBeLessThan(prompt.indexOf("fix the bug"));
  });
});

describe("codex · what it did", () => {
  it("reports a shell command with its exit code", async () => {
    const { events } = await run([THREAD("t"), SHELL("/bin/zsh -lc 'echo hi'"), TURN_DONE]);
    expect(of(events, "tool_call")[0]).toMatchObject({ tool: "shell", exitCode: 0 });
    expect(String(of(events, "tool_call")[0]?.summary)).toContain("echo hi");
  });

  it("keeps a failing command's exit code rather than rounding it to fine", async () => {
    const { events } = await run([THREAD("t"), SHELL("npm test", 1), TURN_DONE]);
    expect(of(events, "tool_call")[0]).toMatchObject({ exitCode: 1 });
  });

  it("raises a file_edit per changed path", async () => {
    const { events } = await run([
      THREAD("t"),
      FILES([
        { path: "/repo/a.ts", kind: "add" },
        { path: "/repo/b.ts", kind: "modify" },
      ]),
      TURN_DONE,
    ]);
    expect(of(events, "file_edit").map((p) => p.path)).toEqual(["/repo/a.ts", "/repo/b.ts"]);
    expect(of(events, "file_edit")[0]).toMatchObject({ tool: "file_change:add" });
  });

  it("stays quiet about item types it doesn't understand", async () => {
    const { events } = await run([
      THREAD("t"),
      JSON.stringify({ type: "item.completed", item: { type: "todo_list", items: [] } }),
      MSG("done"),
      TURN_DONE,
    ]);
    // inventing a rendering for something we don't understand is worse than silence
    expect(kinds(events).filter((k) => k === "message")).toHaveLength(1);
  });

  it("ignores an item that only started — nothing has happened yet", async () => {
    const { events } = await run([
      THREAD("t"),
      JSON.stringify({ type: "item.started", item: { type: "command_execution", command: "sleep 1", exit_code: null } }),
      TURN_DONE,
    ]);
    expect(kinds(events)).not.toContain("tool_call");
  });
});

describe("codex · when it goes wrong", () => {
  it("passes an error item through", async () => {
    const { events } = await run([
      THREAD("t"),
      JSON.stringify({ type: "item.completed", item: { type: "error", message: "skills budget exceeded" } }),
      MSG("carrying on"),
      TURN_DONE,
    ]);
    expect(of(events, "error")[0]).toMatchObject({ message: "skills budget exceeded" });
    expect(kinds(events)).toContain("run_complete"); // reported, not fatal
  });

  it("throws when it dies without completing a turn", async () => {
    const { events, error } = await run([], { code: 1, stderr: "not logged in" });
    expect(error).toBeDefined();
    expect(of(events, "error")[0]?.stderr).toContain("not logged in");
  });

  it("flags a turn that ended on a question", async () => {
    const { events } = await run([THREAD("t"), MSG("Which one should I pick?"), TURN_DONE]);
    expect(kinds(events)).toContain("needs_input");
  });

  it("refuses a second turn while one is running", async () => {
    const bin = fakeCodex([THREAD("t"), MSG("ok"), TURN_DONE], { delayMs: 400 });
    const agent = new CodexAdapter("codex", makeProjectDir({ name: "cx" }), { bin });
    const first = agent.send({ text: "one" });
    await expect(agent.send({ text: "two" })).rejects.toThrow(/busy/);
    await first;
  });

  it("is unavailable when there's no binary anywhere", async () => {
    const agent = new CodexAdapter("codex", makeProjectDir({ name: "cx" }), { bin: "/nope/codex" });
    expect(await agent.available()).toBe(false);
  });
});
