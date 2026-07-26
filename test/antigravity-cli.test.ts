/**
 * The Antigravity CLI adapter, driven with a fake `agy` on disk.
 *
 * `agy --print` prints only the final assistant message (markdown) and exits 0
 * — there is no JSON event stream — so the behaviours worth guarding are:
 *
 *  - the turn is spawned headless (`--dangerously-skip-permissions`) into the
 *    project dir, because every other permission mode stalls waiting on a human;
 *  - files the CLI narrates as `[name](file://…)` links surface as file_edits,
 *    since that's the only signal print mode gives about what changed;
 *  - the conversation id agy writes to its per-dir cache is captured after the
 *    first turn and replayed with `--conversation` on the next, so continuity
 *    doesn't depend on the cache still pointing at this dir later.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AntigravityCliAdapter } from "../src/adapters/antigravity-cli.js";
import { readProjectState } from "../src/core/registry.js";
import type { AdapterEvent } from "../src/types.js";
import { makeProjectDir, tmpDir } from "./helpers.js";

/** A fake `agy` that records its argv and prints a fixed message. */
function fakeAgy(stdout: string, { code = 0, stderr = "" } = {}): string {
  const dir = tmpDir("fake-agy");
  const bin = path.join(dir, "agy");
  fs.writeFileSync(
    bin,
    `#!/usr/bin/env node
require("node:fs").writeFileSync(${JSON.stringify(path.join(dir, "argv.json"))}, JSON.stringify(process.argv.slice(2)));
${stderr ? `console.error(${JSON.stringify(stderr)});` : ""}
process.stdout.write(${JSON.stringify(stdout)});
process.exit(${code});
`,
    { mode: 0o755 },
  );
  return bin;
}

const argvOf = (bin: string): string[] =>
  JSON.parse(fs.readFileSync(path.join(path.dirname(bin), "argv.json"), "utf8")) as string[];

async function run(
  bin: string,
  dir: string,
  opts: Record<string, unknown> = {},
  input: { text: string; briefing?: string } = { text: "do it" },
): Promise<{ events: AdapterEvent[]; error?: Error }> {
  const agent = new AntigravityCliAdapter("antigravity-cli", dir, { bin, ...opts });
  const events: AdapterEvent[] = [];
  agent.onEvent((e) => events.push(e));
  let error: Error | undefined;
  try {
    await agent.send(input);
  } catch (err) {
    error = err as Error;
  }
  return { events, error };
}

const HOME = process.env.HOME;
afterEach(() => {
  if (HOME === undefined) delete process.env.HOME;
  else process.env.HOME = HOME;
});

describe("AntigravityCliAdapter", () => {
  it("runs a turn headless and reports the message + the files it touched", async () => {
    const dir = makeProjectDir({ name: "ag" });
    const bin = fakeAgy("Done. Created [note.txt](file:///tmp/ag/note.txt) as asked.");
    const { events, error } = await run(bin, dir, { model: "gemini-3.6-flash-medium" });

    expect(error).toBeUndefined();
    const argv = argvOf(bin);
    expect(argv).toContain("--print");
    expect(argv).toContain("--dangerously-skip-permissions");
    expect(argv[argv.indexOf("--add-dir") + 1]).toBe(dir); // fresh turn opens the workspace
    expect(argv).toContain("--print-timeout");
    expect(argv[argv.indexOf("--model") + 1]).toBe("gemini-3.6-flash-medium");

    const msg = events.find((e) => e.kind === "message");
    expect((msg?.payload as { text: string }).text).toMatch(/Done\. Created/);

    const edit = events.find((e) => e.kind === "file_edit");
    expect((edit?.payload as { path: string }).path).toBe("/tmp/ag/note.txt");

    const done = events.find((e) => e.kind === "run_complete");
    expect((done?.payload as { model?: string }).model).toBe("gemini-3.6-flash-medium");
  });

  it("frames the briefing in front of the prompt (print mode has no system channel)", async () => {
    const dir = makeProjectDir({ name: "ag" });
    const bin = fakeAgy("ok");
    await run(bin, dir, {}, { text: "ship it", briefing: "PROJECT LAW: never touch prod" });
    const argv = argvOf(bin);
    const prompt = argv[argv.indexOf("--print") + 1] ?? "";
    expect(prompt).toContain("PROJECT LAW: never touch prod");
    expect(prompt).toContain("ship it");
    expect(prompt.indexOf("PROJECT LAW")).toBeLessThan(prompt.indexOf("ship it"));
  });

  it("captures the conversation id after a fresh turn and resumes it next time", async () => {
    // Point HOME at a temp dir and seed the cache the way agy would have.
    const home = tmpDir("ag-home");
    const cacheDir = path.join(home, ".gemini", "antigravity-cli", "cache");
    fs.mkdirSync(cacheDir, { recursive: true });
    const dir = makeProjectDir({ name: "ag" });
    fs.writeFileSync(
      path.join(cacheDir, "last_conversations.json"),
      JSON.stringify({ [dir]: "conv-abc-123" }),
    );
    process.env.HOME = home;

    const bin1 = fakeAgy("first turn done");
    await run(bin1, dir);
    // no --conversation on the first turn; it opens the workspace instead
    expect(argvOf(bin1)).not.toContain("--conversation");
    expect(argvOf(bin1)).toContain("--add-dir");
    // ...but the id agy wrote is now stashed on the agent
    expect(readProjectState(dir).agents["antigravity-cli"]?.sessionId).toBe("conv-abc-123");

    const bin2 = fakeAgy("second turn done");
    await run(bin2, dir);
    const argv2 = argvOf(bin2);
    expect(argv2[argv2.indexOf("--conversation") + 1]).toBe("conv-abc-123");
    expect(argv2).not.toContain("--add-dir"); // resume inherits the original workspace
  });

  it("flags a turn that ended on a question as needing input", async () => {
    const dir = makeProjectDir({ name: "ag" });
    const bin = fakeAgy("I can do that. Should I also update the tests?");
    const { events } = await run(bin, dir);
    expect(events.some((e) => e.kind === "needs_input")).toBe(true);
  });

  it("fails the turn on a non-zero exit with no output", async () => {
    const dir = makeProjectDir({ name: "ag" });
    const bin = fakeAgy("", { code: 1, stderr: "not signed in" });
    const { events, error } = await run(bin, dir);
    expect(error).toBeDefined();
    expect(events.some((e) => e.kind === "error")).toBe(true);
  });
});
