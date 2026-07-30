/**
 * Commit-per-turn (#19): opt-in, one commit per turn, agent as co-author,
 * staged by exactly the files that turn touched.
 *
 * The scoping rule is the feature: `git add -A` would swallow another agent's
 * uncommitted work into this agent's commit, which is precisely the
 * misattribution this exists to end.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ProjectRuntime } from "../src/daemon/runtime.js";
import { writeProjectConfig } from "../src/core/registry.js";
import type { ProjectConfig } from "../src/types.js";
import { tmpDir, waitUntil } from "./helpers.js";

const git = (dir: string, ...args: string[]): string =>
  execFileSync("git", args, { cwd: dir, encoding: "utf8" });

let dir: string;
let rt: ProjectRuntime;

beforeAll(async () => {
  process.env.LOOM_HOME = tmpDir("home-cpt");
  process.env.LOOM_NO_NOTIFY = "1";
  dir = tmpDir("cpt");
  git(dir, "init", "-q");
  git(dir, "config", "user.email", "t@t");
  git(dir, "config", "user.name", "t");
  fs.writeFileSync(path.join(dir, "seed.txt"), "seed\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "seed");

  const cfg: ProjectConfig = {
    name: "cpt",
    agents: [
      { id: "plannerbot", kind: "echo", role: "planner" },
      { id: "execbot", kind: "echo", role: "executor" },
    ],
    brain: { extractor: "off" },
    git: { commitPerTurn: true },
  };
  writeProjectConfig(dir, cfg);
  rt = await ProjectRuntime.open({ id: "cpt", name: "cpt", dir });
});

afterAll(async () => {
  await rt.close();
});

describe("commit per turn", () => {
  it("commits a turn's file with the agent as co-author and the prompt as subject", async () => {
    await rt.sendMessage("add the feature write:feature.txt", "plannerbot");
    await waitUntil(() => {
      try {
        return git(dir, "log", "--oneline").split("\n").filter(Boolean).length >= 2;
      } catch {
        return false;
      }
    });

    const body = git(dir, "log", "-1", "--format=%B");
    expect(body).toContain("add the feature");
    expect(body).toContain("Co-Authored-By: plannerbot <plannerbot@loom.local>");
    expect(body).toContain("Turn by plannerbot (echo)");

    // The tree is clean for what the turn touched — really committed.
    expect(git(dir, "status", "--porcelain")).not.toContain("feature.txt");
  });

  it("stages only that turn's files — a bystander's mess survives uncommitted", async () => {
    // Someone else's uncommitted work, sitting in the tree.
    fs.writeFileSync(path.join(dir, "bystander.txt"), "not this turn's work\n");

    await rt.handoff("execbot");
    await rt.sendMessage("second change write:second.txt", "execbot");
    await waitUntil(() => {
      try {
        return git(dir, "log", "-1", "--format=%B").includes("second change");
      } catch {
        return false;
      }
    });

    // The commit carries the turn's file and NOT the bystander.
    const files = git(dir, "show", "--name-only", "--format=", "HEAD").trim().split("\n");
    expect(files).toContain("second.txt");
    expect(files).not.toContain("bystander.txt");
    expect(git(dir, "status", "--porcelain")).toContain("bystander.txt");
  });
});

describe("off by default", () => {
  it("a project without the flag never commits", async () => {
    const dir2 = tmpDir("cpt-off");
    git(dir2, "init", "-q");
    git(dir2, "config", "user.email", "t@t");
    git(dir2, "config", "user.name", "t");
    fs.writeFileSync(path.join(dir2, "seed.txt"), "seed\n");
    git(dir2, "add", "-A");
    git(dir2, "commit", "-qm", "seed");
    writeProjectConfig(dir2, {
      name: "off",
      agents: [{ id: "plannerbot", kind: "echo", role: "planner" }],
      brain: { extractor: "off" },
    });
    const rt2 = await ProjectRuntime.open({ id: "cptoff", name: "off", dir: dir2 });
    try {
      await rt2.sendMessage("change something write:thing.txt", "plannerbot");
      await waitUntil(() =>
        rt2.log.list({ kinds: ["turn_diff"] }).length >= 1,
      );
      // The diff landed; no commit did.
      expect(git(dir2, "log", "--oneline").split("\n").filter(Boolean)).toHaveLength(1);
    } finally {
      await rt2.close();
    }
  });
});

/**
 * Branch-per-task (#12): dragging a card to Working checks out its branch.
 * Same opt-in family as commitPerTurn, same failure posture — git trouble is a
 * Console line, the drag itself always succeeds.
 */
describe("branch per task", () => {
  it("creates task/<id>-<slug> on the move to working, idempotently", async () => {
    const dir3 = tmpDir("bpt");
    git(dir3, "init", "-q");
    git(dir3, "config", "user.email", "t@t");
    git(dir3, "config", "user.name", "t");
    fs.writeFileSync(path.join(dir3, "seed.txt"), "seed\n");
    git(dir3, "add", "-A");
    git(dir3, "commit", "-qm", "seed");
    writeProjectConfig(dir3, {
      name: "bpt",
      agents: [{ id: "plannerbot", kind: "echo", role: "planner" }],
      brain: { extractor: "off" },
      git: { branchPerTask: true },
    });
    const rt3 = await ProjectRuntime.open({ id: "bpt", name: "bpt", dir: dir3 });
    try {
      const t = rt3.createTask({ title: "Ship the Login Page!", column: "needs-you" });
      rt3.updateTask(t.id, { column: "working" });
      await waitUntil(() => {
        try {
          return git(dir3, "rev-parse", "--abbrev-ref", "HEAD").trim().startsWith("task/");
        } catch {
          return false;
        }
      });
      const branch = git(dir3, "rev-parse", "--abbrev-ref", "HEAD").trim();
      expect(branch).toBe(`task/${t.id}-ship-the-login-page`);

      // Re-dragging is idempotent — same branch, nothing destroyed.
      rt3.updateTask(t.id, { column: "needs-you" });
      rt3.updateTask(t.id, { column: "working" });
      await new Promise((r) => setTimeout(r, 300));
      expect(git(dir3, "rev-parse", "--abbrev-ref", "HEAD").trim()).toBe(branch);
    } finally {
      await rt3.close();
    }
  });
});
