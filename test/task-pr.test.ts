/**
 * What opening a PR for a card would carry.
 *
 * Pushing publishes, which is why Loom has never done it implicitly. The rule
 * this keeps: the plan is read-only — asking what would happen must never push
 * anything — and what it reports has to match the repository, because a person
 * is about to decide on it.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { ProjectRuntime } from "../src/daemon/runtime.js";
import { makeProjectDir, tmpDir } from "./helpers.js";

let rt: ProjectRuntime | null = null;
afterEach(async () => {
  await rt?.close();
  rt = null;
});

const git = (dir: string, ...args: string[]) =>
  execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

/** A project on a real repo with a real origin, so base/HEAD are real. */
async function project() {
  process.env.LOOM_HOME = tmpDir("home-taskpr");
  const origin = tmpDir("origin");
  git(origin, "init", "--bare", "-q", "-b", "main");

  const dir = makeProjectDir({ name: "cards", agents: [{ id: "echo", kind: "echo" }] });
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "t@t");
  git(dir, "config", "user.name", "t");
  fs.writeFileSync(path.join(dir, ".gitignore"), ".loom/\n");
  fs.writeFileSync(path.join(dir, "README.md"), "# cards\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "seed");
  git(dir, "remote", "add", "origin", origin);
  git(dir, "push", "-q", "-u", "origin", "main");
  git(dir, "remote", "set-head", "origin", "main");

  rt = await ProjectRuntime.open({ id: `cards-${Date.now()}`, name: "cards", dir });
  return { rt: rt!, dir };
}

describe("the PR a card would open", () => {
  it("says there's no branch yet, rather than offering to push nothing", async () => {
    const { rt: r } = await project();
    const task = r.createTask({ title: "Add the login page" });
    const plan = await r.taskPrPlan(task.id);
    expect(plan.ready).toBe(false);
    expect(plan.why).toMatch(/no .* branch yet/);
    expect(plan.command).toBe(""); // nothing to offer, so nothing is shown
  });

  it("reports the commits and files the branch actually carries", async () => {
    const { rt: r, dir } = await project();
    const task = r.createTask({ title: "Add the login page" });
    const plan0 = await r.taskPrPlan(task.id);

    // real work on the card's branch
    git(dir, "checkout", "-q", "-b", plan0.branch);
    fs.mkdirSync(path.join(dir, "src"), { recursive: true });
    fs.writeFileSync(path.join(dir, "src", "login.ts"), "export const login = () => {};\n");
    git(dir, "add", "-A");
    git(dir, "commit", "-qm", "add the login page");
    fs.writeFileSync(path.join(dir, "src", "login.ts"), "export const login = async () => {};\n");
    git(dir, "commit", "-aqm", "make it async");

    const plan = await r.taskPrPlan(task.id);
    expect(plan.ready).toBe(true);
    expect(plan.base).toBe("main");
    expect(plan.commits).toHaveLength(2);
    expect(plan.commits.join(" ")).toContain("make it async");
    expect(plan.files).toEqual(["src/login.ts"]);
    expect(plan.command).toContain(`gh pr create --head ${plan.branch}`);
    expect(plan.command).toContain('--title "Add the login page"');
  });

  it("asking what would happen pushes nothing", async () => {
    const { rt: r, dir } = await project();
    const task = r.createTask({ title: "Quiet please" });
    const plan0 = await r.taskPrPlan(task.id);
    git(dir, "checkout", "-q", "-b", plan0.branch);
    fs.writeFileSync(path.join(dir, "note.md"), "hi\n");
    git(dir, "add", "-A");
    git(dir, "commit", "-qm", "a note");

    const before = git(dir, "ls-remote", "--heads", "origin");
    await r.taskPrPlan(task.id);
    await r.taskPrPlan(task.id);
    expect(git(dir, "ls-remote", "--heads", "origin")).toBe(before); // nothing published
  });

  it("refuses a card it doesn't have", async () => {
    const { rt: r } = await project();
    await expect(r.taskPrPlan("no-such-card")).rejects.toThrow(/no card/);
    await expect(r.openTaskPr("no-such-card")).rejects.toThrow(/no card/);
  });

  it("won't open a PR for a branch with nothing on it", async () => {
    const { rt: r, dir } = await project();
    const task = r.createTask({ title: "Empty" });
    const plan = await r.taskPrPlan(task.id);
    git(dir, "checkout", "-q", "-b", plan.branch); // branch exists, no commits
    await expect(r.openTaskPr(task.id)).rejects.toThrow(/nothing/);
  });
});
