/**
 * The Grok Code adapter, driven with a fake `grok` on disk.
 *
 * The JSON is what grok 0.2.54 really prints for `-p --output-format json`: one
 * object with the answer, the reasoning, why it stopped, and a session id.
 *
 * The two behaviours worth guarding here are both things the real CLI taught us
 * the hard way, by doing them quietly:
 *
 *  - `bypassPermissions` is the only mode that works headless. Every other one
 *    ends the turn `Cancelled` having written nothing, and reads like success.
 *  - `stopReason` is the only warning you get. A cancelled turn returns a
 *    perfectly well-formed object with an answer in it.
 */

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { GrokAdapter } from "../src/adapters/grok.js";
import type { AdapterEvent } from "../src/types.js";
import { makeProjectDir, tmpDir } from "./helpers.js";

function fakeGrok(stdout: string, { code = 0, stderr = "", delayMs = 0 } = {}): string {
  const dir = tmpDir("fake-grok");
  const bin = path.join(dir, "grok");
  fs.writeFileSync(
    bin,
    `#!/usr/bin/env node
require("node:fs").writeFileSync(${JSON.stringify(path.join(dir, "argv.json"))}, JSON.stringify(process.argv.slice(2)));
${stderr ? `console.error(${JSON.stringify(stderr)});` : ""}
setTimeout(() => {
  process.stdout.write(${JSON.stringify(stdout)});
  process.exit(${code});
}, ${delayMs});
`,
    { mode: 0o755 },
  );
  return bin;
}

const argvOf = (bin: string): string[] =>
  JSON.parse(fs.readFileSync(path.join(path.dirname(bin), "argv.json"), "utf8")) as string[];

/** The real shape, pretty-printed the way grok prints it. */
const reply = (o: Record<string, unknown>): string =>
  JSON.stringify({ stopReason: "EndTurn", sessionId: "019f-sess", ...o }, null, 2);

async function run(
  stdout: string,
  opts: { code?: number; stderr?: string } = {},
  dir = makeProjectDir({ name: "gk" }),
): Promise<{ events: AdapterEvent[]; dir: string; error?: Error }> {
  const bin = fakeGrok(stdout, opts);
  const agent = new GrokAdapter("grok-code", dir, { bin });
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

describe("grok · a normal turn", () => {
  it("reports the answer and the reasoning separately", async () => {
    const { events } = await run(reply({ text: "Created hi.txt.", thought: "Simple file task." }));
    const messages = of(events, "message");
    expect(messages.find((m) => m.reasoning)).toMatchObject({ text: "Simple file task." });
    expect(messages.find((m) => !m.reasoning)).toMatchObject({ text: "Created hi.txt." });
    expect(kinds(events)).toContain("run_complete");
  });

  it("remembers the session so the next turn resumes it", async () => {
    const dir = makeProjectDir({ name: "gk" });
    await run(reply({ text: "one", sessionId: "019f-keep" }), {}, dir);

    const second = fakeGrok(reply({ text: "two" }));
    await new GrokAdapter("grok-code", dir, { bin: second }).send({ text: "more" });
    const argv = argvOf(second);
    expect(argv[argv.indexOf("-r") + 1]).toBe("019f-keep");
  });

  /**
   * Measured against grok 0.2.54: acceptEdits, auto and dontAsk each end the
   * turn "Cancelled" with nothing written, because there's no TTY to approve
   * with. bypassPermissions is the only one that does the job. A safer-sounding
   * default here would give you an agent that silently does nothing, forever.
   */
  it("defaults to the only permission mode that works headless", async () => {
    const bin = fakeGrok(reply({ text: "ok" }));
    await new GrokAdapter("grok-code", makeProjectDir({ name: "gk" }), { bin }).send({ text: "go" });
    const argv = argvOf(bin);
    expect(argv[argv.indexOf("--permission-mode") + 1]).toBe("bypassPermissions");
  });

  it("lets you choose a different one, and runs in the project", async () => {
    const dir = makeProjectDir({ name: "gk" });
    const bin = fakeGrok(reply({ text: "ok" }));
    await new GrokAdapter("grok-code", dir, { bin, permissionMode: "plan" }).send({ text: "go" });
    const argv = argvOf(bin);
    expect(argv[argv.indexOf("--permission-mode") + 1]).toBe("plan");
    expect(argv[argv.indexOf("--cwd") + 1]).toBe(dir);
    expect(argv[argv.indexOf("--output-format") + 1]).toBe("json");
  });

  it("puts the briefing in --rules (grok's system prompt), not the user turn", async () => {
    const bin = fakeGrok(reply({ text: "ok" }));
    await new GrokAdapter("grok-code", makeProjectDir({ name: "gk" }), { bin }).send({
      text: "fix it",
      briefing: "codex was here first",
    });
    const argv = argvOf(bin);
    // the handoff memory rides in --rules — a real system channel
    const rules = argv[argv.indexOf("--rules") + 1]!;
    expect(rules).toContain("codex was here first");
    // and the user's turn (-p) stays clean, not polluted with the briefing
    const prompt = argv[argv.indexOf("-p") + 1]!;
    expect(prompt).toBe("fix it");
    expect(prompt).not.toContain("codex was here first");
  });
});

describe("grok · the quiet failure", () => {
  /**
   * The bug this exists for: a cancelled turn returns a well-formed object with
   * an answer in it and writes nothing to disk. Without this event the thread
   * shows a reply and the work never happened.
   */
  it("says so when the turn stopped early instead of finishing", async () => {
    const { events } = await run(reply({ text: "I'll create the file.", stopReason: "Cancelled" }));
    const early = of(events, "status").find((p) => p.state === "stopped_early");
    expect(early, "a Cancelled turn must not look like a finished one").toMatchObject({
      reason: "Cancelled",
    });
  });

  it("stays quiet when it ended properly", async () => {
    const { events } = await run(reply({ text: "done", stopReason: "EndTurn" }));
    expect(of(events, "status").some((p) => p.state === "stopped_early")).toBe(false);
  });

  it("flags a turn that ended on a question", async () => {
    const { events } = await run(reply({ text: "Which file did you mean?" }));
    expect(kinds(events)).toContain("needs_input");
  });
});

describe("grok · when it goes wrong", () => {
  it("throws when stdout has no answer in it", async () => {
    const { error } = await run("total gibberish", { code: 1, stderr: "auth required" });
    expect(error).toBeDefined();
    expect(String(error?.message)).toContain("auth required");
  });

  it("finds the object even when something logged first", async () => {
    const { events, error } = await run(`warming up...\n${reply({ text: "still fine" })}`);
    expect(error).toBeUndefined();
    expect(of(events, "message").find((m) => !m.reasoning)).toMatchObject({ text: "still fine" });
  });

  it("passes an error field through", async () => {
    const { events } = await run(reply({ text: "", error: "model overloaded" }), { code: 1 });
    expect(of(events, "error")[0]).toMatchObject({ message: "model overloaded" });
  });

  it("refuses a second turn while one is running", async () => {
    const bin = fakeGrok(reply({ text: "ok" }), { delayMs: 400 });
    const agent = new GrokAdapter("grok-code", makeProjectDir({ name: "gk" }), { bin });
    const first = agent.send({ text: "one" });
    await expect(agent.send({ text: "two" })).rejects.toThrow(/busy/);
    await first;
  });

  it("is unavailable when there's no binary", async () => {
    const agent = new GrokAdapter("grok-code", makeProjectDir({ name: "gk" }), { bin: "/nope/grok" });
    expect(await agent.available()).toBe(false);
  });
});
