/**
 * Per-prompt diff attribution + working-tree endpoint — the data behind
 * "show the code changes for each prompt, per project".
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readDaemonConfig } from "../src/core/registry.js";
import { parsePorcelain } from "../src/core/worktree.js";
import { DaemonClient } from "../src/daemon/client.js";
import { LoomDaemon } from "../src/daemon/server.js";
import { makeProjectDir, tmpDir, waitUntil } from "./helpers.js";

let daemon: LoomDaemon;
let client: DaemonClient;

beforeAll(async () => {
  process.env.LOOM_HOME = tmpDir("home");
  process.env.LOOM_NO_NOTIFY = "1";
  daemon = new LoomDaemon({ host: "127.0.0.1", port: 0 });
  await daemon.listen();
  client = new DaemonClient(readDaemonConfig()!);
});

afterAll(async () => {
  await daemon.close();
});

function gitInit(dir: string): void {
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "t@t"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "t"], { cwd: dir });
  fs.writeFileSync(path.join(dir, "base.txt"), "base\n");
  execFileSync("git", ["add", "-A"], { cwd: dir });
  execFileSync("git", ["commit", "-qm", "base"], { cwd: dir });
}

describe("per-prompt diffs", () => {
  it("attributes files changed by a turn to a turn_diff event", async () => {
    const dir = makeProjectDir({ name: "diffs" });
    gitInit(dir);
    const id = (await client.addProject(dir)).project.id;

    await client.send(id, "please write:src/notes.txt for me");
    await waitUntil(async () => {
      const { events } = await client.events(id, undefined, 100);
      return events.some((e) => e.kind === "turn_diff");
    });
    const { events } = await client.events(id, undefined, 100);
    const diff = events.find((e) => e.kind === "turn_diff")!;
    expect(diff.agentId).toBe("plannerbot");
    const files = diff.payload.files as Array<{ status: string; path: string }>;
    expect(files.some((f) => f.path.includes("notes.txt"))).toBe(true);
    expect(String(diff.payload.patch)).toContain("notes.txt");
  });

  it("a turn that changes nothing produces no turn_diff", async () => {
    const dir = makeProjectDir({ name: "quiet" });
    gitInit(dir);
    const id = (await client.addProject(dir)).project.id;
    await client.send(id, "just say hello");
    await waitUntil(async () => {
      const { events } = await client.events(id, undefined, 50);
      return events.some((e) => e.kind === "run_complete");
    });
    await new Promise((r) => setTimeout(r, 300)); // diff capture is async
    const { events } = await client.events(id, undefined, 50);
    expect(events.filter((e) => e.kind === "turn_diff")).toHaveLength(0);
  });

  it("working-tree endpoint reports branch, files, and a patch", async () => {
    const dir = makeProjectDir({ name: "tree" });
    gitInit(dir);
    fs.appendFileSync(path.join(dir, "base.txt"), "edited\n");
    fs.writeFileSync(path.join(dir, "new.txt"), "brand new\n");
    const id = (await client.addProject(dir)).project.id;

    const { tree } = await client.tree(id);
    expect(tree.git).toBe(true);
    expect(tree.branch).toBeTruthy();
    const paths = tree.files.map((f) => f.path);
    expect(paths).toContain("base.txt");
    expect(paths).toContain("new.txt");
    expect(tree.patch).toContain("+edited");
    expect(tree.patch).toContain("?? new file: new.txt");
  });

  it("non-git projects degrade gracefully", async () => {
    const dir = makeProjectDir({ name: "nogit" });
    const id = (await client.addProject(dir)).project.id;
    const { tree } = await client.tree(id);
    expect(tree.git).toBe(false);
    expect(tree.files).toHaveLength(0);
  });

  it("parsePorcelain splits status codes from paths", () => {
    expect(parsePorcelain(" M src/a.ts\n?? new.txt\nA  staged.ts")).toEqual([
      { status: " M", path: "src/a.ts" },
      { status: "??", path: "new.txt" },
      { status: "A ", path: "staged.ts" },
    ]);
  });
});
