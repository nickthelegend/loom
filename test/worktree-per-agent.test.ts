/**
 * Worktree per agent (#20): parallel edits cannot collide in the filesystem.
 *
 * Each adapter gets a sibling checkout on branch agent/<id>. What these prove:
 * two agents writing the "same" path land in different trees on different
 * branches, the shared tree stays untouched, and turn diffs read the agent's
 * OWN tree — a diff of the shared tree would report nothing happened, which is
 * how isolation quietly breaks attribution.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ProjectRuntime } from "../src/daemon/runtime.js";
import { writeProjectConfig } from "../src/core/registry.js";
import { tmpDir, waitUntil } from "./helpers.js";

const git = (dir: string, ...args: string[]): string =>
  execFileSync("git", args, { cwd: dir, encoding: "utf8" });

let dir: string;
let rt: ProjectRuntime;

beforeAll(async () => {
  process.env.LOOM_HOME = tmpDir("home-wpa");
  process.env.LOOM_NO_NOTIFY = "1";
  dir = tmpDir("wpa");
  git(dir, "init", "-q");
  git(dir, "config", "user.email", "t@t");
  git(dir, "config", "user.name", "t");
  fs.writeFileSync(path.join(dir, "seed.txt"), "seed\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "seed");
  writeProjectConfig(dir, {
    name: "wpa",
    agents: [
      { id: "plannerbot", kind: "echo", role: "planner" },
      { id: "execbot", kind: "echo", role: "executor" },
    ],
    brain: { extractor: "off" },
    // The realistic pairing: isolation makes parallel edits safe, and
    // commit-per-turn is what makes the agent branches actually MERGEABLE —
    // an uncommitted worktree file is not on its branch.
    git: { worktreePerAgent: true, commitPerTurn: true },
  });
  rt = await ProjectRuntime.open({ id: "wpa", name: "wpa", dir });
});

afterAll(async () => {
  await rt.close();
});

describe("isolation", () => {
  it("gives each adapter its own checkout on its own branch", () => {
    const a = rt.agentDir("plannerbot");
    const b = rt.agentDir("execbot");
    expect(a).not.toBe(dir);
    expect(b).not.toBe(dir);
    expect(a).not.toBe(b);
    expect(git(a, "rev-parse", "--abbrev-ref", "HEAD").trim()).toBe("agent/plannerbot");
    expect(git(b, "rev-parse", "--abbrev-ref", "HEAD").trim()).toBe("agent/execbot");
  });

  it("two agents writing the same path don't touch each other or the shared tree", async () => {
    await rt.sendMessage("write write:collide.txt", "plannerbot");
    await waitUntil(() => fs.existsSync(path.join(rt.agentDir("plannerbot"), "collide.txt")));
    await rt.handoff("execbot");
    await rt.sendMessage("write write:collide.txt", "execbot");
    await waitUntil(() => fs.existsSync(path.join(rt.agentDir("execbot"), "collide.txt")));

    // Each file names its own author (echo writes "echo(<id>) wrote this").
    const a = fs.readFileSync(path.join(rt.agentDir("plannerbot"), "collide.txt"), "utf8");
    const b = fs.readFileSync(path.join(rt.agentDir("execbot"), "collide.txt"), "utf8");
    expect(a).toContain("plannerbot");
    expect(b).toContain("execbot");
    // The shared tree never saw it.
    expect(fs.existsSync(path.join(dir, "collide.txt"))).toBe(false);
  });

  it("turn diffs read the agent's own tree, not the shared one", async () => {
    await waitUntil(() => rt.log.list({ kinds: ["turn_diff"] }).length >= 2);
    const diffs = rt.log.list({ kinds: ["turn_diff"] });
    const files = diffs.flatMap((d) =>
      ((d.payload.files as Array<{ path: string }>) ?? []).map((f) => f.path),
    );
    expect(files).toContain("collide.txt");
  });

  it("merging stays a plain git operation — the branches are ordinary", async () => {
    // Wait for plannerbot's per-turn commit to land on its branch.
    await waitUntil(() => {
      try {
        return git(dir, "log", "--oneline", "agent/plannerbot").split("\n").filter(Boolean).length >= 2;
      } catch {
        return false;
      }
    });
    git(dir, "merge", "-q", "agent/plannerbot");
    expect(fs.readFileSync(path.join(dir, "collide.txt"), "utf8")).toContain("plannerbot");
  });
});
