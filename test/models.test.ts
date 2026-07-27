/**
 * Where the model picker's list comes from — and whether Loom asked the tool or
 * remembered something.
 *
 * The route that serves this used to describe itself as "every real model this
 * agent can run, asked of the underlying tool — not a hardcoded list", while
 * two of the five kinds returned a constant. The list is now asked wherever the
 * tool can answer, and every answer carries `source`, so the difference is
 * something a caller can render rather than something only the server knows.
 *
 * These drive a fake `opencode` rather than the real CLIs: the real ones need an
 * account, take seconds, and can't be asked to reproduce the failure that
 * matters here — a CLI whose output arrives before it lets go of stdout.
 */

import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { listModelsForKind } from "../src/daemon/server.js";
import { tmpDir } from "./helpers.js";

const REAL_PATH = process.env.PATH;
afterEach(() => {
  process.env.PATH = REAL_PATH;
});

/** Put an executable of this name in front of everything on PATH. */
function fakeOnPath(name: string, script: string): void {
  const dir = tmpDir("fake-bin");
  fs.writeFileSync(path.join(dir, name), script, { mode: 0o755 });
  process.env.PATH = `${dir}${path.delimiter}${process.env.PATH}`;
}

describe("model lists · asked, or remembered, and it says which", () => {
  /**
   * Claude Code is the one kind that genuinely cannot be asked. `claude --help`
   * has no models subcommand, and `claude models` is worse than an error — it
   * takes "models" as a prompt and bills a turn of an LLM writing prose. So the
   * list is aliases, and the response says `builtin` rather than implying a
   * lookup that never happened.
   */
  it("labels Claude Code's list builtin, and keeps it to aliases", async () => {
    const r = await listModelsForKind("claude-code");
    expect(r.source).toBe("builtin");
    expect(r.models).toContain("opus");
    expect(r.models).toContain("sonnet");
    // No pinned snapshot ids. One of these was "claude-sonnet-5", which has
    // never been a model — the failure mode of remembering ids is inventing
    // them, and an alias can't be invented because the CLI resolves it.
    for (const m of r.models) {
      expect(m, `${m} is a pinned id in a list nobody can refresh`).not.toMatch(/^claude-/);
    }
  });

  it("says `none` for a kind with no model surface, rather than an empty guess", async () => {
    const r = await listModelsForKind("echo");
    expect(r).toEqual({ models: [], source: "none" });
  });

  /**
   * The regression this exists for.
   *
   * `agy models` prints its eleven models and then leaves a language server
   * holding stdout open. `execFile` — which the reader used to be — calls back
   * when the *streams* close, so it waited out its full 20s timeout and
   * returned nothing: the picker showed an empty list for a CLI that had
   * already answered. Measured on one machine, one fresh process per attempt:
   * execFile 25s and 0 lines, spawn 5.3s and 11 lines.
   *
   * The noise lines are real too — `grok models` prints "You are not
   * authenticated." and "Default model: grok-4.5" above its list, and neither
   * is a model.
   */
  it("reads a CLI that answers and then holds stdout open", async () => {
    fakeOnPath(
      "opencode",
      `#!/bin/sh
# a grandchild that outlives us, still holding stdout — this is agy's shape
sleep 20 &
echo "You are not authenticated."
echo "Default model: anthropic/claude-sonnet-4"
echo "  * anthropic/claude-sonnet-4 (default)"
echo "openai/gpt-5"
echo "openai/gpt-5"
exit 0
`,
    );
    const t0 = Date.now();
    const r = await listModelsForKind("opencode");
    const elapsed = Date.now() - t0;

    expect(r.source).toBe("cli");
    expect(r.models).toEqual(["anthropic/claude-sonnet-4", "openai/gpt-5"]);
    // it came back on the child's exit, not on the 20s stream timeout
    expect(elapsed, "waited for a pipe the CLI had already finished with").toBeLessThan(5_000);
  });
});
