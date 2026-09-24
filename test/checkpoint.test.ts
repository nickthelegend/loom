/**
 * Checkpoints, against real repositories.
 *
 * Every test here makes a git repo, writes real files, captures, changes the
 * files for real, and rewinds. Nothing is mocked, because the whole feature is
 * a claim about what git does to a working directory — and the failure mode
 * being guarded against is "it deleted something it shouldn't have", which a
 * mock cannot have an opinion about.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { capture, find, forgetAll, list, prune, restore, restoreFile } from "../src/core/checkpoint.js";
import { tmpDir } from "./helpers.js";

const git = (dir: string, ...args: string[]): string => execFileSync("git", args, { cwd: dir, encoding: "utf8" });

const read = (dir: string, rel: string): string | null => {
  try {
    return fs.readFileSync(path.join(dir, rel), "utf8");
  } catch {
    return null;
  }
};
const write = (dir: string, rel: string, body: string): void => {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), body);
};

/** A repo with one commit, a .gitignore, and an ignored secret in it. */
function repo(): string {
  const dir = tmpDir("ckpt");
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "t@t");
  git(dir, "config", "user.name", "t");
  write(dir, ".gitignore", ".env\nnode_modules/\n.loom/\n");
  write(dir, "app.ts", "export const port = 3000;\n");
  write(dir, "README.md", "# a project\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "seed");
  // Things that must survive every rewind untouched.
  write(dir, ".env", "SECRET=hunter2\n");
  write(dir, "node_modules/left/index.js", "module.exports = 1;\n");
  write(dir, ".loom/events.db", "pretend this is the log\n");
  return dir;
}

describe("taking a checkpoint", () => {
  it("captures tracked changes and brand new files alike", async () => {
    const dir = repo();
    write(dir, "app.ts", "export const port = 8080;\n"); // modified
    write(dir, "notes.md", "an untracked file\n"); // never seen by git

    const cp = (await capture(dir, "before the turn"))!;
    expect(cp).toBeTruthy();
    expect(cp.label).toBe("before the turn");
    expect(cp.branch).toBe("main");
    // Two files differ from HEAD: the edit and the new file.
    expect(cp.dirty).toBe(2);

    // The captured commit really holds both, at the content they had.
    const inTree = git(dir, "ls-tree", "-r", "--name-only", cp.commit).split("\n").filter(Boolean);
    expect(inTree).toContain("app.ts");
    expect(inTree).toContain("notes.md");
    expect(git(dir, "show", `${cp.commit}:app.ts`)).toBe("export const port = 8080;\n");
    expect(git(dir, "show", `${cp.commit}:notes.md`)).toBe("an untracked file\n");
  });

  /**
   * The one that would be a security incident rather than a bug. `.env` is in
   * .gitignore, so it must never reach the object store — not on capture, and
   * therefore not on any restore either.
   */
  it("never reads an ignored file, least of all .env", async () => {
    const dir = repo();
    const cp = (await capture(dir, "seed"))!;
    const inTree = git(dir, "ls-tree", "-r", "--name-only", cp.commit).split("\n").filter(Boolean);
    expect(inTree).not.toContain(".env");
    expect(inTree.some((f) => f.startsWith("node_modules/"))).toBe(false);
    expect(inTree.some((f) => f.startsWith(".loom/"))).toBe(false);
    // And git itself agrees there is no such blob to show.
    expect(() => git(dir, "show", `${cp.commit}:.env`)).toThrow();
  });

  /**
   * A checkpoint that moved HEAD, dirtied the index or pushed onto the stash
   * would be doing something to the repository the human didn't ask for.
   */
  it("leaves HEAD, the branch, the index and the stash exactly as they were", async () => {
    const dir = repo();
    write(dir, "app.ts", "export const port = 8080;\n");
    write(dir, "staged.txt", "deliberately staged\n");
    git(dir, "add", "staged.txt");

    const headBefore = git(dir, "rev-parse", "HEAD").trim();
    const statusBefore = git(dir, "status", "--porcelain");
    const branchesBefore = git(dir, "branch", "--list");

    await capture(dir, "no side effects please");

    expect(git(dir, "rev-parse", "HEAD").trim()).toBe(headBefore);
    expect(git(dir, "status", "--porcelain")).toBe(statusBefore);
    expect(git(dir, "branch", "--list")).toBe(branchesBefore);
    expect(git(dir, "stash", "list").trim()).toBe("");
    // The checkpoint ref exists but is not a branch anyone will see.
    expect(git(dir, "branch", "--list")).not.toContain("checkpoint");
    expect(fs.readdirSync(path.join(dir, ".git")).some((f) => f.startsWith("loom-checkpoint-"))).toBe(false);
  });

  it("says no rather than lying when there is nothing to check point", async () => {
    // Not a repository at all.
    expect(await capture(tmpDir("norepo"), "x")).toBeNull();
    // A repository with no commits: no HEAD to go back to.
    const fresh = tmpDir("empty");
    git(fresh, "init", "-q", "-b", "main");
    expect(await capture(fresh, "x")).toBeNull();
  });
});

describe("rewinding to a checkpoint", () => {
  it("puts back what was edited, deletes what was added, and restores what was deleted", async () => {
    const dir = repo();
    write(dir, "keep.md", "written before the checkpoint\n");
    const cp = (await capture(dir, "before the agent ran"))!;

    // Now an agent does its worst.
    write(dir, "app.ts", "export const port = 9999;\n"); // edited
    write(dir, "generated.ts", "// forty files of this\n"); // created
    fs.rmSync(path.join(dir, "README.md")); // deleted
    fs.rmSync(path.join(dir, "keep.md")); // deleted, and untracked

    const out = await restore(dir, cp.id);

    expect(read(dir, "app.ts")).toBe("export const port = 3000;\n");
    expect(read(dir, "generated.ts")).toBeNull();
    expect(read(dir, "README.md")).toBe("# a project\n");
    expect(read(dir, "keep.md")).toBe("written before the checkpoint\n");
    expect(out.restored.id).toBe(cp.id);
    expect(out.changed.sort()).toEqual(["README.md", "app.ts", "generated.ts", "keep.md"]);
  });

  /** The rule that makes rewind safe to click: it is itself rewindable. */
  it("saves the files it is about to replace, so a rewind can be rewound", async () => {
    const dir = repo();
    const before = (await capture(dir, "the start"))!;
    write(dir, "app.ts", "export const port = 9999;\n");
    write(dir, "work-i-forgot-about.ts", "an hour of typing\n");

    const first = await restore(dir, before.id);
    // The rewind did what it said.
    expect(read(dir, "work-i-forgot-about.ts")).toBeNull();
    expect(read(dir, "app.ts")).toBe("export const port = 3000;\n");

    // …and handed back the way out.
    expect(first.undo.id).not.toBe(before.id);
    expect(first.undo.label).toContain("before rewinding to");
    await restore(dir, first.undo.id);
    expect(read(dir, "work-i-forgot-about.ts")).toBe("an hour of typing\n");
    expect(read(dir, "app.ts")).toBe("export const port = 9999;\n");
  });

  it("leaves ignored files alone — .env, node_modules and the event log", async () => {
    const dir = repo();
    const cp = (await capture(dir, "before"))!;
    write(dir, "app.ts", "changed\n");
    // Things written after the checkpoint that are nobody's business.
    write(dir, ".env", "SECRET=rotated\n");
    write(dir, "node_modules/new-dep/index.js", "1\n");
    write(dir, ".loom/events.db", "a hundred more events\n");

    await restore(dir, cp.id);

    expect(read(dir, "app.ts")).toBe("export const port = 3000;\n"); // rewound
    expect(read(dir, ".env")).toBe("SECRET=rotated\n"); // untouched
    expect(read(dir, "node_modules/new-dep/index.js")).toBe("1\n"); // untouched
    expect(read(dir, ".loom/events.db")).toBe("a hundred more events\n"); // untouched
  });

  /**
   * A checkpoint restores files, not history. Moving HEAD would turn "undo
   * what the agent wrote" into "undo three of my commits", which is not what
   * anybody clicking Rewind is asking for.
   */
  it("does not move HEAD or touch the branch", async () => {
    const dir = repo();
    const cp = (await capture(dir, "before"))!;
    write(dir, "later.ts", "work worth keeping\n");
    git(dir, "add", "-A");
    git(dir, "commit", "-qm", "a commit made after the checkpoint");
    const head = git(dir, "rev-parse", "HEAD").trim();
    const log = git(dir, "log", "--oneline");

    write(dir, "app.ts", "scribble\n");
    await restore(dir, cp.id);

    expect(git(dir, "rev-parse", "HEAD").trim()).toBe(head);
    expect(git(dir, "log", "--oneline")).toBe(log);
    expect(git(dir, "rev-parse", "--abbrev-ref", "HEAD").trim()).toBe("main");
  });

  it("refuses an id it does not have, and changes nothing", async () => {
    const dir = repo();
    write(dir, "app.ts", "mine\n");
    await expect(restore(dir, "cnope")).rejects.toThrow(/no checkpoint/);
    await expect(restore(dir, "../../etc/passwd")).rejects.toThrow(/no checkpoint/);
    expect(read(dir, "app.ts")).toBe("mine\n");
  });
});

describe("putting back one file", () => {
  it("restores that file, removes one the turn created, and leaves everything else as it is", async () => {
    const dir = repo();
    const cp = (await capture(dir, "before the turn"))!;
    write(dir, "app.ts", "export const port = 9999;\n");
    write(dir, "README.md", "# rewritten\n");
    write(dir, "added.ts", "new\n");
    const one = await restoreFile(dir, cp.id, "app.ts");
    expect(one.removed).toBe(false);
    expect(read(dir, "app.ts")).toBe("export const port = 3000;\n");
    expect(read(dir, "README.md")).toBe("# rewritten\n"); // untouched
    const gone = await restoreFile(dir, cp.id, "added.ts");
    expect(gone.removed).toBe(true);
    expect(read(dir, "added.ts")).toBeNull();
    // it reads as a plain edit, not staged
    expect(git(dir, "diff", "--cached", "--name-only").trim()).toBe("");
    // and the version it replaced was saved first
    expect(await find(dir, one.undo.id)).not.toBeNull();
    expect(read(dir, ".env")).toBe("SECRET=hunter2\n");
  });

  it("refuses a path outside the project", async () => {
    const dir = repo();
    const cp = (await capture(dir, "x"))!;
    await expect(restoreFile(dir, cp.id, "../outside.txt")).rejects.toThrow(/isn't a path inside/);
  });
});

describe("keeping the list short", () => {
  it("lists newest first, finds one by id, and prunes the rest away", async () => {
    const dir = repo();
    const made = [];
    for (const n of [1, 2, 3, 4, 5]) {
      write(dir, "app.ts", `step ${n}\n`);
      made.push((await capture(dir, `step ${n}`))!);
    }
    const all = await list(dir);
    expect(all).toHaveLength(5);
    expect(all[0]!.id).toBe(made[4]!.id); // newest first
    expect(all[0]!.label).toBe("step 5");
    expect((await find(dir, made[0]!.id))!.label).toBe("step 1");

    expect(await prune(dir, 2)).toBe(3);
    const kept = await list(dir);
    expect(kept.map((c) => c.label)).toEqual(["step 5", "step 4"]);
    // A pruned checkpoint is gone from the answer, not silently still there.
    expect(await find(dir, made[0]!.id)).toBeNull();

    expect(await forgetAll(dir)).toBe(2);
    expect(await list(dir)).toEqual([]);
  });

  /**
   * Two captures in the same millisecond used to collide — which is exactly
   * what a restore does, since it checkpoints the current tree immediately
   * before restoring another one.
   */
  it("gives two checkpoints taken in the same tick different ids", async () => {
    const dir = repo();
    const a = (await capture(dir, "a"))!;
    const b = (await capture(dir, "b"))!;
    expect(a.id).not.toBe(b.id);
    expect((await list(dir)).map((c) => c.label)).toEqual(["b", "a"]);
  });
});

/**
 * `read-tree --reset` moves the index as well as the files, which left every
 * restored change reading as staged — a rewind that had quietly run `git add`
 * over your repository.
 */
describe("what git status says afterwards", () => {
  it("leaves changes unstaged and new files untracked, as if you had typed them", async () => {
    const dir = repo();
    write(dir, "app.ts", "export const port = 8080;\n");
    write(dir, "extra.ts", "new and untracked\n");
    const cp = (await capture(dir, "before"))!;

    // Wander off, then come back.
    write(dir, "app.ts", "export const port = 1;\n");
    fs.rmSync(path.join(dir, "extra.ts"));
    await restore(dir, cp.id);

    const status = git(dir, "status", "--porcelain").split("\n").filter(Boolean).sort();
    expect(status).toEqual([" M app.ts", "?? extra.ts"]);
    // Nothing staged: the first column is a space or a ?, never M or A.
    expect(status.every((l) => l[0] === " " || l[0] === "?")).toBe(true);
    expect(git(dir, "diff", "--cached", "--name-only").trim()).toBe("");
  });
});
