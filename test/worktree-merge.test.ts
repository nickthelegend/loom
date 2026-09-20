/**
 * Work that travels with the baton — and the cases where it must not.
 *
 * Merging on handoff is the feature; refusing to merge is most of the value.
 * Each of these is a state where a merge would produce something nobody can
 * unpick, and the rule is that Loom says so instead of trying.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { describeMerge, mergeAgentWork } from "../src/core/worktree-merge.js";
import { tmpDir } from "./helpers.js";

const git = (dir: string, ...args: string[]) =>
  execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

const write = (dir: string, rel: string, body: string) => {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), body);
};

/** A repo with two agent worktrees, exactly as worktreePerAgent makes them. */
function fleet() {
  const root = tmpDir("fleet");
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.email", "t@t");
  git(root, "config", "user.name", "t");
  write(root, "app.ts", "export const app = 1;\n");
  git(root, "add", "-A");
  git(root, "commit", "-qm", "seed");
  const a = path.join(root, "..", `${path.basename(root)}-a`);
  const b = path.join(root, "..", `${path.basename(root)}-b`);
  git(root, "worktree", "add", "-q", "-b", "agent/a", a, "main");
  git(root, "worktree", "add", "-q", "-b", "agent/b", b, "main");
  for (const wt of [a, b]) {
    git(wt, "config", "user.email", "t@t");
    git(wt, "config", "user.name", "t");
  }
  return { root, a, b };
}

const merge = (into: string, from = "agent/a", sourceDir?: string) =>
  mergeAgentWork({ into, branch: from, ...(sourceDir ? { sourceDir } : {}), message: "Loom: a → b" });

describe("carrying work across the baton", () => {
  it("brings committed work into the next agent's checkout", async () => {
    const { a, b } = fleet();
    write(a, "src/login.ts", "export const login = () => {};\n");
    git(a, "add", "-A");
    git(a, "commit", "-qm", "add login");

    const out = await merge(b, "agent/a", a);
    expect(out.state).toBe("merged");
    if (out.state !== "merged") return;
    expect(out.commits).toBe(1);
    expect(out.files).toEqual(["src/login.ts"]);
    expect(fs.existsSync(path.join(b, "src/login.ts"))).toBe(true); // it's really there
    expect(describeMerge(out, "a", "b")).toContain("src/login.ts");
  });

  it("does nothing when there's nothing new, and says which", async () => {
    const { a, b } = fleet();
    expect((await merge(b, "agent/a", a)).state).toBe("up-to-date");
    const missing = await merge(b, "agent/ghost");
    expect(missing).toMatchObject({ state: "up-to-date" });
    expect(String((missing as { detail?: string }).detail)).toContain("agent/ghost");
  });

  it("refuses while the outgoing agent's work is uncommitted — it isn't on the branch", async () => {
    const { a, b } = fleet();
    write(a, "src/half.ts", "// written, never committed\n");

    const out = await merge(b, "agent/a", a);
    expect(out.state).toBe("blocked");
    if (out.state !== "blocked") return;
    expect(out.reason).toMatch(/uncommitted/);
    expect(out.files).toContain("src/half.ts");
    expect(fs.existsSync(path.join(b, "src/half.ts"))).toBe(false); // nothing half-delivered
  });

  it("ignores .loom when deciding whether the outgoing tree is clean", async () => {
    const { a, b } = fleet();
    write(a, ".loom/queue.json", "[]\n"); // Loom's own bookkeeping, not the agent's work
    write(a, "src/ok.ts", "export const ok = 1;\n");
    git(a, "add", "src/ok.ts");
    git(a, "commit", "-qm", "ok");
    expect((await merge(b, "agent/a", a)).state).toBe("merged");
  });

  it("refuses to merge on top of the incoming agent's uncommitted work", async () => {
    const { a, b } = fleet();
    write(a, "src/login.ts", "export const login = () => {};\n");
    git(a, "add", "-A");
    git(a, "commit", "-qm", "add login");
    write(b, "notes.md", "mid-thought\n");

    const out = await merge(b, "agent/a", a);
    expect(out.state).toBe("blocked");
    if (out.state !== "blocked") return;
    expect(out.reason).toMatch(/uncommitted/);
    expect(fs.readFileSync(path.join(b, "notes.md"), "utf8")).toBe("mid-thought\n"); // untouched
  });

  it("reports a conflict with the files, and leaves it there to be resolved", async () => {
    const { a, b } = fleet();
    write(a, "app.ts", "export const app = 2;\n");
    git(a, "add", "-A");
    git(a, "commit", "-qm", "a says 2");
    write(b, "app.ts", "export const app = 3;\n");
    git(b, "add", "-A");
    git(b, "commit", "-qm", "b says 3");

    const out = await merge(b, "agent/a", a);
    expect(out.state).toBe("conflict");
    if (out.state !== "conflict") return;
    expect(out.files).toEqual(["app.ts"]);
    // The conflict is in the tree — that's the thing to resolve, not to hide.
    expect(fs.readFileSync(path.join(b, "app.ts"), "utf8")).toContain("<<<<<<<");
    expect(describeMerge(out, "a", "b")).toMatch(/merge --abort/);

    // And a second handoff doesn't stack another merge on top of it.
    const again = await merge(b, "agent/a", a);
    expect(again.state).toBe("blocked");
    if (again.state !== "blocked") return;
    expect(again.reason).toMatch(/already in progress/);
  });

  it("is a no-op outside a git repository", async () => {
    const plain = tmpDir("plain");
    expect((await merge(plain)).state).toBe("up-to-date");
  });
});
