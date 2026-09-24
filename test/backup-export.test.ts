/** loom backup and loom export: what goes in the archive, and a chat as Markdown. */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { makeBackup } from "../src/core/backup.js";
import { EventLog } from "../src/core/eventlog.js";
import { threadMarkdown } from "../src/core/thread-md.js";
import type { LoomEvent } from "../src/types.js";
import { tmpDir } from "./helpers.js";

describe("loom backup", () => {
  it("archives ~/.loom and each project's .loom, without worktrees or the model cache", async () => {
    const home = tmpDir("backup-home");
    process.env.LOOM_HOME = home;
    const proj = tmpDir("backup-proj");
    const log = await EventLog.open(path.join(proj, ".loom"));
    log.append({ kind: "message", payload: { text: "remember me" } });
    log.close();
    fs.writeFileSync(path.join(home, "registry.json"), JSON.stringify({ projects: [{ id: "abc123", name: "demo", dir: proj }] }));
    fs.mkdirSync(path.join(home, "orchestra", "abc123", "wt"), { recursive: true });
    fs.writeFileSync(path.join(home, "orchestra", "abc123", "wt", "big.txt"), "x");
    fs.mkdirSync(path.join(home, "models"), { recursive: true });
    fs.writeFileSync(path.join(home, "models", "m.bin"), "x");
    fs.writeFileSync(path.join(home, "prompts.json"), "{}");

    const out = path.join(tmpDir("backup-out"), "b.tar.gz");
    const r = makeBackup(out);
    expect(r.projects).toBe(1);
    const list = spawnSync("tar", ["-tzf", out], { encoding: "utf8" }).stdout;
    expect(list).toContain("./loom-home/prompts.json");
    expect(list).toContain("./projects/demo-abc123/.loom/log.db");
    expect(list).not.toContain("big.txt");
    expect(list).not.toContain("m.bin");

    const x = tmpDir("backup-x");
    spawnSync("tar", ["-xzf", out, "-C", x]);
    const back = await EventLog.open(path.join(x, "projects", "demo-abc123", ".loom"));
    expect(back.list().map((e) => e.payload.text)).toContain("remember me");
    back.close();
  });
});

describe("a chat as Markdown", () => {
  it("writes prompts, replies, tools, diffs, errors and turn ends", () => {
    const at = new Date(2026, 8, 24, 10, 5).getTime();
    const ev = (kind: string, payload: Record<string, unknown>, agentId?: string) =>
      ({ id: 1, ts: at, kind, payload, ...(agentId ? { agentId } : {}) }) as LoomEvent;
    const md = threadMarkdown([
      ev("message", { text: "add a test" }),
      ev("tool_call", { summary: "npm test\nmore" }, "codex"),
      ev("turn_diff", { files: [{ path: "a.ts" }], added: 3, removed: 1 }, "codex"),
      ev("message", { text: "Done." }, "codex"),
      ev("error", { message: "quota\nstack" }, "codex"),
      ev("run_complete", { durationMs: 65000, costUsd: 0.12 }, "codex"),
    ], "demo — Main");
    expect(md).toContain("# demo — Main");
    expect(md).toMatch(/### You · /);
    expect(md).toContain("- ⚙ npm test");
    expect(md).toContain("> Edited 1 file(s) · +3 −1: a.ts");
    expect(md).toMatch(/### codex · .*\n\nDone\./);
    expect(md).toContain("> **Error** (codex): quota");
    expect(md).toContain("_codex finished in 1m 5s · $0.1200_");
  });
});
