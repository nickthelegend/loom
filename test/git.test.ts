/**
 * Source control that does something.
 *
 * Against real repositories, because git is the thing being tested — a mocked
 * git would only prove this file agrees with itself. Each test makes its own
 * repo in a temp dir and throws it away.
 *
 * The one that matters most is the path check. `discard` runs `git checkout --`
 * and `git clean -fd`, which delete work, on paths that arrived over HTTP from
 * a device somewhere on your tailnet.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { commit, discard, GitError, safeRelPath, stage, status, unstage } from "../src/core/git.js";
import { tmpDir } from "./helpers.js";

function repo(): string {
  const dir = tmpDir("git");
  const run = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });
  run("init", "-q", ".");
  // A repo with no identity can't commit, and the error would be about that
  // rather than about the thing under test.
  run("config", "user.email", "test@loom.dev");
  run("config", "user.name", "Loom Test");
  run("commit", "--allow-empty", "-qm", "root");
  return dir;
}

const write = (dir: string, rel: string, body: string): string => {
  const full = path.join(dir, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, body);
  return rel;
};

describe("git · staying inside the project", () => {
  /**
   * The reason this module has a path check at all: these paths come from an
   * HTTP body, and discard deletes files.
   */
  it("refuses a path that climbs out", () => {
    const dir = repo();
    expect(() => safeRelPath(dir, "../../etc/passwd")).toThrow(/outside the project/);
    expect(() => safeRelPath(dir, "/etc/passwd")).toThrow(/outside the project/);
  });

  it("refuses the project itself", () => {
    const dir = repo();
    expect(() => safeRelPath(dir, ".")).toThrow(/the project itself/);
  });

  it("allows an ordinary file, and normalises it", () => {
    const dir = repo();
    expect(safeRelPath(dir, "src/a.ts")).toBe("src/a.ts");
    expect(safeRelPath(dir, "./src/../src/a.ts")).toBe("src/a.ts");
  });

  it("won't discard a file outside the repo, even if git would", async () => {
    const dir = repo();
    const outside = path.join(tmpDir("victim"), "important.txt");
    fs.writeFileSync(outside, "do not delete me");
    await expect(discard(dir, [path.relative(dir, outside)])).rejects.toThrow(/outside the project/);
    expect(fs.existsSync(outside), "the file outside the repo survived").toBe(true);
  });
});

describe("git · status", () => {
  it("says nothing is happening in a clean repo", async () => {
    const s = await status(repo());
    expect(s.staged).toEqual([]);
    expect(s.unstaged).toEqual([]);
    expect(s.untracked).toEqual([]);
    expect(s.branch).toBeTruthy();
  });

  it("keeps staged and unstaged apart", async () => {
    const dir = repo();
    write(dir, "tracked.txt", "one");
    await stage(dir, ["tracked.txt"]);
    let s = await status(dir);
    expect(s.staged.map((f) => f.path)).toEqual(["tracked.txt"]);
    expect(s.unstaged).toEqual([]);

    // Edit it again after staging: now it's in BOTH, which is the truth and the
    // whole reason porcelain has two columns. A flattened list would show one
    // checkbox that lies about what the commit contains.
    write(dir, "tracked.txt", "two");
    s = await status(dir);
    expect(s.staged.map((f) => f.path)).toEqual(["tracked.txt"]);
    expect(s.unstaged.map((f) => f.path)).toEqual(["tracked.txt"]);
  });

  it("lists untracked files separately — they have no index entry", async () => {
    const dir = repo();
    write(dir, "new.txt", "hello");
    const s = await status(dir);
    expect(s.untracked).toEqual(["new.txt"]);
    expect(s.staged).toEqual([]);
  });

  it("degrades to empty outside a repo rather than throwing", async () => {
    const s = await status(tmpDir("not-a-repo"));
    expect(s.branch).toBe("");
    expect(s.staged).toEqual([]);
  });
});

describe("git · stage and unstage", () => {
  it("stages and unstages a file", async () => {
    const dir = repo();
    write(dir, "a.txt", "x");
    await stage(dir, ["a.txt"]);
    expect((await status(dir)).staged.map((f) => f.path)).toEqual(["a.txt"]);

    await unstage(dir, ["a.txt"]);
    expect((await status(dir)).staged).toEqual([]);
    expect((await status(dir)).untracked).toEqual(["a.txt"]);
  });

  /**
   * `git reset HEAD -- <path>` is the obvious unstage and it fails in a repo
   * with no commits, where HEAD doesn't resolve. `restore --staged` doesn't.
   */
  it("unstages in a repo that has no commits yet", async () => {
    const dir = tmpDir("fresh");
    execFileSync("git", ["init", "-q", "."], { cwd: dir });
    write(dir, "first.txt", "x");
    await stage(dir, ["first.txt"]);
    await expect(unstage(dir, ["first.txt"])).resolves.toBeTruthy();
    expect((await status(dir)).staged).toEqual([]);
  });

  it("refuses an empty list rather than staging everything", async () => {
    await expect(stage(repo(), [])).rejects.toThrow(/no files/);
  });
});

describe("git · commit", () => {
  it("commits what's staged, and only that", async () => {
    const dir = repo();
    write(dir, "in.txt", "yes");
    write(dir, "out.txt", "no");
    await stage(dir, ["in.txt"]);

    const res = await commit(dir, "add the one file I staged");
    expect(res.sha).toMatch(/^[0-9a-f]{7,}$/);
    expect(res.files).toBe(1);

    const s = await status(dir);
    expect(s.staged).toEqual([]);
    // the unstaged one is untouched — nothing was swept in
    expect(s.untracked).toEqual(["out.txt"]);
  });

  it("refuses an empty message", async () => {
    await expect(commit(repo(), "   ")).rejects.toThrow(/needs a message/);
  });

  /**
   * The failure mode worth naming: a commit button that appears to work and
   * commits nothing is worse than one that refuses.
   */
  it("refuses when nothing is staged, and says what to do", async () => {
    const dir = repo();
    write(dir, "unstaged.txt", "x");
    await expect(commit(dir, "a message")).rejects.toThrow(/nothing staged/);
  });

  it("takes a message with quotes and newlines — it never touches a shell", async () => {
    const dir = repo();
    write(dir, "a.txt", "x");
    await stage(dir, ["a.txt"]);
    const res = await commit(dir, 'fix "the thing"\n\nand $(echo pwned) too');
    expect(res.subject).toBe('fix "the thing"');
    const log = execFileSync("git", ["log", "-1", "--pretty=%B"], { cwd: dir }).toString();
    expect(log).toContain("$(echo pwned)"); // literal, not executed
  });
});

describe("git · discard", () => {
  it("restores a tracked file", async () => {
    const dir = repo();
    write(dir, "t.txt", "original");
    await stage(dir, ["t.txt"]);
    await commit(dir, "add t");

    write(dir, "t.txt", "ruined");
    await discard(dir, ["t.txt"]);
    expect(fs.readFileSync(path.join(dir, "t.txt"), "utf8")).toBe("original");
  });

  /**
   * An untracked file has no index entry to restore from, so `git checkout`
   * won't remove it — it needs `clean`. Same button to a person, two commands
   * underneath, and getting it wrong means "discard" silently does nothing.
   */
  it("deletes an untracked file, which checkout can't do", async () => {
    const dir = repo();
    write(dir, "junk.txt", "x");
    await discard(dir, [], ["junk.txt"]);
    expect(fs.existsSync(path.join(dir, "junk.txt"))).toBe(false);
  });

  it("refuses an empty request rather than discarding the tree", async () => {
    await expect(discard(repo(), [], [])).rejects.toThrow(/no files/);
  });
});

describe("git · errors", () => {
  it("carries git's own words, not ours", async () => {
    const dir = repo();
    write(dir, "a.txt", "x");
    await stage(dir, ["a.txt"]);
    await commit(dir, "one");
    // committing again with nothing staged: our message, because we check first
    await expect(commit(dir, "two")).rejects.toBeInstanceOf(GitError);
  });
});

/**
 * Silence that hides a real failure.
 *
 * A corrupt .loom/config.json used to become an empty roster with no sound at
 * all — which looks exactly like "my agents disappeared" and leaves you nothing
 * to search for. It still falls back (refusing to start over one damaged file
 * helps nobody), but now it says so where you can see it.
 */
describe("config · unreadable is loud, missing is quiet", () => {
  it("says so when a config is corrupt, instead of quietly using defaults", async () => {
    const { logbook } = await import("../src/core/logbook.js");
    const { readProjectConfig } = await import("../src/core/registry.js");
    logbook.clear();

    const dir = tmpDir("corrupt");
    fs.mkdirSync(path.join(dir, ".loom"), { recursive: true });
    // a trailing comma: the most ordinary way a config gets broken
    fs.writeFileSync(path.join(dir, ".loom", "config.json"), '{"name":"x","agents":[],}');

    const cfg = readProjectConfig(dir);
    expect(cfg, "it still returns something — one bad file shouldn't stop the app").toBeTruthy();

    const said = logbook.list({ level: "warn" });
    expect(said.length, "a corrupt config must not be silent").toBeGreaterThan(0);
    expect(said.at(-1)?.message).toContain("config.json");
    expect(said.at(-1)?.message).toContain("look like data went missing");
  });

  it("stays quiet when the file simply isn't there — that's a fact, not a fault", async () => {
    const { logbook } = await import("../src/core/logbook.js");
    const { readProjectState } = await import("../src/core/registry.js");
    logbook.clear();

    const dir = tmpDir("nostate");
    const state = readProjectState(dir); // no .loom at all
    expect(state.holder).toBeNull();
    expect(logbook.list().length, "a missing file is not an event").toBe(0);
  });
});
