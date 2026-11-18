import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { agentDiffStats, chatBranch, describeChat, draftCommit, selectChatBranch, suggestChangelog } from "../src/core/git-review.js";
import { capture, restoreFile, turnDiff } from "../src/core/checkpoint.js";
import { stageAndCommitFiles, commit, stage } from "../src/core/git.js";
import { predictMerge } from "../src/core/worktrees.js";
import type { LoomEvent } from "../src/types.js";
import { tmpDir } from "./helpers.js";

const git = (dir: string, ...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
function repo() {
  const dir = tmpDir("r3-git");
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.name", "Test"); git(dir, "config", "user.email", "test@test");
  fs.writeFileSync(path.join(dir, "a.txt"), "original\n");
  git(dir, "add", "."); git(dir, "commit", "-qm", "seed");
  return dir;
}
const diff = "diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-original\n+changed\n";

describe("#420 Git and review", () => {
  it("drafts offline from prompt and diff and bounds model output", async () => {
    expect(await draftCommit("Fix the parser", diff)).toEqual({ message: "Fix the parser (a.txt)", source: "template" });
    let seen = "";
    const result = await draftCommit("Fix parser", diff, "small", async (p, opts) => { seen = p; expect(opts?.model).toBe("small"); return '"fix: parse input"\nextra'; });
    expect(seen).toContain(diff); expect(seen).toContain("Fix parser");
    expect(result).toEqual({ message: "fix: parse input", source: "model" });
    expect((await draftCommit("Fix parser", diff, "small", async () => { throw new Error("offline"); })).source).toBe("template");
    expect((await draftCommit("Fix parser", diff, "small", async () => "")).source).toBe("template");
  });

  it("deduplicates files, attributes line totals and drafts a checklist", () => {
    const events = [
      { kind: "message", payload: { text: "Fix parser" } },
      { kind: "turn_diff", agentId: "a", payload: { files: [{ path: "parser.ts" }], added: 3, removed: 1 } },
      { kind: "turn_diff", agentId: "a", payload: { files: [{ path: "parser.ts" }], added: 2, removed: 1 } },
      { kind: "turn_diff", agentId: "b", payload: { files: [{ path: "tests.ts" }], added: 7, removed: 0 } },
    ] as LoomEvent[];
    expect(agentDiffStats(events)).toEqual([{ agentId: "a", added: 5, removed: 2, files: 1, turns: 2 }, { agentId: "b", added: 7, removed: 0, files: 1, turns: 1 }]);
    const draft = describeChat(events, "security");
    expect(draft.description).toContain("Fix parser"); expect(draft.description).toContain("- [ ] Authorization is enforced");
    expect(draft.description.match(/parser.ts/g)).toHaveLength(1);
    expect(() => describeChat(events, "__proto__")).toThrow(/unknown/);
  });

  it("counts Orchestra task snapshots once rather than once per update", () => {
    const snapshot = { kind: "orchestra", payload: { phase: "task", runId: "r", task: { id: "t", agent: "worker", files: ["a"], diffStat: { insertions: 2, deletions: 1 } } } } as unknown as LoomEvent;
    expect(agentDiffStats([snapshot, snapshot])).toEqual([{ agentId: "worker", added: 2, removed: 1, files: 1, turns: 1 }]);
  });

  it("creates only on an edit, reuses a branch and refuses dirty switches", async () => {
    const dir = repo();
    expect(await selectChatBranch(dir, "one", false)).toBeNull();
    fs.writeFileSync(path.join(dir, "a.txt"), "one\n");
    expect(await selectChatBranch(dir, "one", true)).toBe(chatBranch("one"));
    await stageAndCommitFiles(dir, ["a.txt"], "one");
    git(dir, "checkout", "main");
    expect(await selectChatBranch(dir, "one", false)).toBe(chatBranch("one"));
    git(dir, "checkout", "main"); fs.writeFileSync(path.join(dir, "a.txt"), "dirty\n");
    await expect(selectChatBranch(dir, "one", false)).rejects.toThrow(/pending changes/);
    expect(chatBranch("a/b")).not.toBe(chatBranch("a-b"));
  });

  it("runs hooks for turn and manual commits, preserving unrelated staged work", async () => {
    const dir = repo();
    fs.mkdirSync(path.join(dir, "hooks"));
    git(dir, "config", "core.hooksPath", "hooks");
    fs.writeFileSync(path.join(dir, "hooks/pre-commit"), "#!/bin/sh\necho rejected-by-hook >&2\nexit 1\n", { mode: 0o755 });
    fs.writeFileSync(path.join(dir, "a.txt"), "changed\n");
    fs.writeFileSync(path.join(dir, "other.txt"), "staged\n"); git(dir, "add", "other.txt");
    const before = git(dir, "rev-parse", "HEAD");
    await expect(stageAndCommitFiles(dir, ["a.txt"], "change")).rejects.toThrow(/rejected-by-hook/);
    await expect(commit(dir, "manual")).rejects.toThrow(/rejected-by-hook/);
    expect(git(dir, "rev-parse", "HEAD")).toBe(before);
    fs.writeFileSync(path.join(dir, "hooks/pre-commit"), "#!/bin/sh\nprintf ran > hook-result\n", { mode: 0o755 });
    await stageAndCommitFiles(dir, ["a.txt"], "change");
    expect(fs.readFileSync(path.join(dir, "hook-result"), "utf8")).toBe("ran");
    expect(git(dir, "show", "--format=", "--name-only", "HEAD")).toBe("a.txt");
    expect(git(dir, "diff", "--cached", "--name-only")).toBe("other.txt");
    await stage(dir, ["other.txt"]); await commit(dir, "other");
  });

  it("restores exactly one literal file, deletes a new one, and keeps an undo", async () => {
    const dir = repo();
    // a name that is also a git pathspec glob matching its neighbour; Windows forbids "*" in file names
    const [glob, near] = process.platform === "win32" ? ["a[1].txt", "a1.txt"] : ["a*.txt", "a.txt"];
    fs.writeFileSync(path.join(dir, glob), "literal\n");
    const cp = (await capture(dir, "before edit"))!;
    fs.writeFileSync(path.join(dir, glob), "changed literal\n");
    fs.writeFileSync(path.join(dir, near), "unrelated\n");
    fs.writeFileSync(path.join(dir, "new.txt"), "new\n");
    const restored = await restoreFile(dir, cp.id, glob);
    expect(fs.readFileSync(path.join(dir, glob), "utf8")).toBe("literal\n");
    expect(fs.readFileSync(path.join(dir, near), "utf8")).toBe("unrelated\n");
    await restoreFile(dir, restored.undo.id, glob);
    expect(fs.readFileSync(path.join(dir, glob), "utf8")).toBe("changed literal\n");
    expect((await restoreFile(dir, cp.id, "new.txt")).removed).toBe(true);
    expect(fs.existsSync(path.join(dir, "new.txt"))).toBe(false);
    for (const file of ["../escape", ".git/config", ":(glob)*", path.join(dir, near)]) await expect(restoreFile(dir, cp.id, file)).rejects.toThrow();
    const outside = tmpDir("r3-outside"); fs.writeFileSync(path.join(outside, "secret"), "safe");
    fs.symlinkSync(outside, path.join(dir, "link"), "dir");
    await expect(restoreFile(dir, cp.id, "link/secret")).rejects.toThrow(/symlink/);
    expect(fs.readFileSync(path.join(outside, "secret"), "utf8")).toBe("safe");
  });

  it("attributes only this turn's changes to an already dirty file, including agent commits", async () => {
    const dir = repo();
    fs.writeFileSync(path.join(dir, "a.txt"), "previous turn\n");
    const cp = (await capture(dir, "before next turn"))!;
    fs.writeFileSync(path.join(dir, "a.txt"), "previous turn\nnew line\n");
    await stageAndCommitFiles(dir, ["a.txt"], "agent committed");
    expect(await turnDiff(dir, cp.id)).toMatchObject({ added: 1, removed: 0, files: [{ path: "a.txt" }] });
    const worktree = path.join(tmpDir("r3-worktree"), "worker");
    git(dir, "worktree", "add", "-b", "worker", worktree);
    expect(await capture(worktree, "worker checkpoint")).not.toBeNull();
  });

  it("predicts a conflicting worker merge without changing HEAD, index or files", async () => {
    const dir = repo(); git(dir, "checkout", "-b", "worker");
    fs.writeFileSync(path.join(dir, "a.txt"), "worker\n"); await stageAndCommitFiles(dir, ["a.txt"], "worker edit");
    git(dir, "checkout", "main"); fs.writeFileSync(path.join(dir, "a.txt"), "main\n"); await stageAndCommitFiles(dir, ["a.txt"], "main edit");
    const head = git(dir, "rev-parse", "HEAD");
    const prediction = await predictMerge(dir, "HEAD", "worker");
    expect(prediction.clean).toBe(false); expect(prediction.detail).toContain("a.txt");
    expect(git(dir, "rev-parse", "HEAD")).toBe(head); expect(git(dir, "status", "--porcelain")).toBe("");
    expect(fs.existsSync(path.join(dir, ".git/MERGE_HEAD"))).toBe(false);
    expect((await predictMerge(dir, "HEAD", "HEAD")).clean).toBe(true);
  });

  it.each([false, true])("suggests only merged branch commits (fast forward: %s)", async ff => {
    const dir = repo(); git(dir, "checkout", "-b", "feature");
    fs.writeFileSync(path.join(dir, "a.txt"), "feature\n"); await stageAndCommitFiles(dir, ["a.txt"], "Fix parser");
    await expect(suggestChangelog(dir, "feature", "main")).rejects.toThrow(/not been merged/);
    git(dir, "checkout", "main"); git(dir, "merge", ff ? "--ff-only" : "--no-ff", "-m", "Merge feature", "feature");
    expect(await suggestChangelog(dir, "feature", "main")).toEqual({ entry: "- Fix parser", commits: ["Fix parser"] });
    await expect(suggestChangelog(dir, "--all")).rejects.toThrow(/invalid/);
  });
});
