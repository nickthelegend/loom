import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { tmpDir } from "./helpers.js";
import { applySplit, changeHunk, conflictPrompt, hunks, proposeSplit, workingPatch, prepareConflict } from "../src/core/review-r4/git.js";
import { blameLine, summarize } from "../src/core/review-r4/records.js";
import { afterHumanReview, reviewSettings, saveReviewSettings, verifyBeforeCommit, guardReviewCommit } from "../src/core/review-r4/verify.js";
import { commit, stageAndCommitFiles } from "../src/core/git.js";
import { prTarget, checkPrRepository, pullRequestDiff } from "../src/core/review-r4/pr.js";
import { handConflictToAgent } from "../src/daemon/routes/review-r4.js";
import type { ProjectRuntime } from "../src/daemon/runtime.js";
import type { LoomEvent } from "../src/types.js";

function repo() {
  const dir = tmpDir("r4-core"), git = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init", "-q", "-b", "main"); git("config", "user.name", "Test"); git("config", "user.email", "test@example.com");
  const write = (file: string, text: string) => { fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true }); fs.writeFileSync(path.join(dir, file), text); };
  write(".gitignore", ".loom/\n"); write("a.txt", Array.from({ length: 30 }, (_, n) => `line ${n + 1}`).join("\n") + "\n"); write("other.txt", "other\n");
  git("add", "."); git("commit", "-qm", "seed");
  return { dir, git, write, read: (file: string) => fs.readFileSync(path.join(dir, file), "utf8") };
}
describe("hunks", () => {
  it("stages exactly one hunk, discards the other and undoes without disturbing staged files", async () => {
    const r = repo(); const edited = r.read("a.txt").replace("line 2\n", "second\n").replace("line 28\n", "last\n"); r.write("a.txt", edited); r.write("other.txt", "unrelated\n"); r.git("add", "other.txt");
    const h = await hunks(r.dir, "a.txt"); expect(h.hunks).toHaveLength(2);
    await changeHunk(r.dir, { action: "stage", path: "a.txt", id: h.hunks[0]!.id, version: h.version });
    expect(r.git("diff", "--cached", "--", "a.txt")).toContain("+second"); expect(r.git("diff", "--cached", "--", "a.txt")).not.toContain("+last");
    const rest = await hunks(r.dir, "a.txt");
    await changeHunk(r.dir, { action: "discard", path: "a.txt", id: rest.hunks[0]!.id, version: rest.version });
    expect(r.read("a.txt")).not.toContain("last"); expect(r.read("a.txt")).toContain("second");
    await changeHunk(r.dir, { action: "undo" }); expect(r.read("a.txt")).toBe(edited); expect(r.git("diff", "--cached", "--", "other.txt")).toContain("unrelated");
  });
  it("rejects stale hunks, later-edit undo, path traversal and symlinks", async () => {
    const r = repo(); r.write("a.txt", "first\n"); const h = await hunks(r.dir, "a.txt"); r.write("a.txt", "second\n");
    await expect(changeHunk(r.dir, { action: "discard", path: "a.txt", id: h.hunks[0]!.id, version: h.version })).rejects.toThrow("refresh");
    const fresh = await hunks(r.dir, "a.txt"); await changeHunk(r.dir, { action: "discard", path: "a.txt", id: fresh.hunks[0]!.id, version: fresh.version }); r.write("a.txt", "new work\n");
    await expect(changeHunk(r.dir, { action: "undo" })).rejects.toThrow("changed since");
    await expect(hunks(r.dir, "../outside")).rejects.toThrow(); fs.symlinkSync(tmpDir("r4-out"), path.join(r.dir, "link"), process.platform === "win32" ? "junction" : "dir"); await expect(hunks(r.dir, "link/file")).rejects.toThrow("symlink");
    await expect(hunks(r.dir, ".git/config")).rejects.toThrow();
  });
  it("supports a project nested in a repository without touching its siblings", async () => {
    const r = repo(); r.write("sub/in.txt", "old\n"); r.git("add", "."); r.git("commit", "-qm", "nested"); r.write("sub/in.txt", "new\n"); r.write("other.txt", "outside project\n");
    const h = await hunks(path.join(r.dir, "sub"), "in.txt"); await changeHunk(path.join(r.dir, "sub"), { action: "discard", path: "in.txt", id: h.hunks[0]!.id, version: h.version });
    expect(r.read("sub/in.txt")).toBe("old\n"); expect(r.read("other.txt")).toBe("outside project\n");
  });
});
it("proposes deterministic groups including untracked files and commits edited groups without unrelated staging", async () => {
  const r = repo(); r.write("src/code.ts", "export const n = 2;\n"); r.write("test/code.test.ts", "test('works', () => {});\n"); r.write("other.txt", "staged elsewhere\n"); r.git("add", "other.txt");
  const proposal = await proposeSplit(r.dir); expect(proposal.groups.flatMap(g => g.files)).toContain("src/code.ts");
  const groups = [{ subject: "Add implementation", files: ["src/code.ts"] }, { subject: "Test implementation", files: ["test/code.test.ts"] }];
  const result = await applySplit(r.dir, groups, proposal.version); expect(result.commits).toHaveLength(2); expect(r.git("diff", "--cached", "--name-only")).toBe("other.txt"); expect(r.git("log", "-2", "--format=%s")).toBe("Test implementation\nAdd implementation");
  await expect(applySplit(r.dir, groups, proposal.version)).rejects.toThrow("moved");
});
it("rejects duplicate split paths before making a commit", async () => {
  const r = repo(); r.write("a.txt", "edit\n"); const p = await proposeSplit(r.dir), head = r.git("rev-parse", "HEAD");
  await expect(applySplit(r.dir, [{ subject: "one", files: ["a.txt", "a.txt"] }], p.version)).rejects.toThrow("distinct"); expect(r.git("rev-parse", "HEAD")).toBe(head);
});
it("holds manual and automatic commits on verification failure and preserves secret checks first", async () => {
  const r = repo(); const head = r.git("rev-parse", "HEAD"); saveReviewSettings(r.dir, { verify: 'node -e "console.log(\'failed check\');process.exit(1)"' });
  r.write("a.txt", "edit\n"); r.git("add", "a.txt"); await expect(commit(r.dir, "manual")).rejects.toThrow("failed check"); await expect(commit(r.dir, "--no-commit")).rejects.toThrow("failed check");
  await expect(stageAndCommitFiles(r.dir, ["a.txt"], "automatic")).rejects.toThrow("failed check"); expect(r.git("rev-parse", "HEAD")).toBe(head); expect(reviewSettings(r.dir).last?.ok).toBe(false);
  saveReviewSettings(r.dir, { verify: 'node -e "require(\'fs\').writeFileSync(\'verified\',\'yes\')"' });
  r.write("a.txt", "token = ghp_" + "A".repeat(36) + "\n"); r.git("add", "a.txt"); await expect(commit(r.dir, "secret")).rejects.toThrow("Secret scan"); expect(fs.existsSync(path.join(r.dir, "verified"))).toBe(false);
  r.write("a.txt", "safe\n"); r.git("add", "a.txt"); await commit(r.dir, "passes"); expect(r.read("verified")).toBe("yes");
});
it("keeps resolution commits held until human review", async () => {
  const r = conflictRepo(); await prepareConflict(r.dir, "topic"); r.write("other.txt", "resolved\n"); r.git("add", "other.txt"); r.write("a.txt", "resolved\n"); r.git("add", "a.txt"); saveReviewSettings(r.dir, { hold: true });
  await expect(stageAndCommitFiles(r.dir, ["a.txt"], "auto")).rejects.toThrow("human review"); await afterHumanReview(() => commit(r.dir, "reviewed")); expect(r.git("log", "-1", "--format=%s")).toBe("reviewed");
});
it("captures both conflict sides and the base without committing", async () => {
  const r = repo(); r.git("checkout", "-qb", "topic"); r.write("other.txt", "theirs\n"); r.git("commit", "-qam", "theirs"); r.git("checkout", "main"); r.write("other.txt", "ours\n"); r.git("commit", "-qam", "ours"); try { r.git("merge", "topic"); } catch {}
  const result = await conflictPrompt(r.dir); expect(result.files).toEqual(["other.txt"]); expect(result.prompt).toContain("OURS:\nours"); expect(result.prompt).toContain("THEIRS:\ntheirs"); expect(result.prompt).toContain("BASE:\nother");
});
it("summarizes real diffs and extends existing triage with lockfile and large-file flags", async () => {
  const r = repo(); r.write("test/deleted.test.ts", "test('one', () => {});\n"); r.git("add", "."); r.git("commit", "-qm", "test"); fs.unlinkSync(path.join(r.dir, "test/deleted.test.ts")); r.write("package-lock.json", "{}\n"); r.write("config/app.json", "{}\n"); r.write("migrations/001.sql", "CREATE TABLE t(id int);\n"); r.write("big.txt", "x\n".repeat(501));
  const s = summarize(await workingPatch(r.dir));
  expect(s.find(f => f.path === "test/deleted.test.ts")?.flags.join()).toContain("test file"); expect(s.find(f => f.path === "package-lock.json")?.flags.join()).toContain("lockfile"); expect(s.find(f => f.path === "config/app.json")?.flags.join()).toContain("configuration"); expect(s.find(f => f.path === "migrations/001.sql")?.flags.length).toBeGreaterThan(0); expect(s.find(f => f.path === "big.txt")?.flags).toContain("very large file change");
});
it("attributes added lines and remaps context through subsequent turns", () => {
  const e = (id: number, kind: string, payload: object, agentId?: string) => ({ id, kind, payload, agentId, chat: "c", ts: id }) as LoomEvent;
  const events = [e(1, "message", { text: "Write alpha" }), e(2, "turn_diff", { patch: "diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -1 +1,2 @@\n base\n+alpha\n" }, "one"), e(3, "message", { text: "Insert beta" }), e(4, "turn_diff", { patch: "diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -1,2 +1,3 @@\n+beta\n base\n alpha\n" }, "two")];
  expect(blameLine(events, "a", 3)).toMatchObject({ agent: "one", prompt: "Write alpha", turn: 2, chat: "c" }); expect(blameLine(events, "a", 1)).toMatchObject({ agent: "two" }); expect(blameLine(events, "a", 2).agent).toBeNull();
});
it("parses GitHub and GitLab review targets without accepting flags or credential URLs", () => {
  expect(prTarget("12").number).toBe(12); expect(prTarget("https://gitlab.com/team/sub/repo/-/merge_requests/7")).toMatchObject({ provider: "gitlab", repo: "team/sub/repo", number: 7 }); expect(prTarget("4", "git@gitlab.com:team/repo.git")).toMatchObject({ provider: "gitlab", repo: "team/repo" }); expect(() => prTarget("--help")).toThrow(); expect(() => prTarget("https://me:secret@github.com/a/b/pull/1")).toThrow();
});
it("stages and discards newly created files as hunks with undo", async () => {
  const r = repo(); r.write("new file.ts", "new content\n"); const h = await hunks(r.dir, "new file.ts"); expect(h.hunks).toHaveLength(1);
  await changeHunk(r.dir, { action: "discard", path: "new file.ts", version: h.version, id: h.hunks[0]!.id }); expect(fs.existsSync(path.join(r.dir, "new file.ts"))).toBe(false);
  await changeHunk(r.dir, { action: "undo" }); expect(r.read("new file.ts")).toBe("new content\n");
  const fresh = await hunks(r.dir, "new file.ts"); await changeHunk(r.dir, { action: "stage", path: "new file.ts", version: fresh.version, id: fresh.hunks[0]!.id }); expect(r.git("diff", "--cached", "--name-only")).toBe("new file.ts");
});
it("accepts a valid optional model split and falls back for unsafe or incomplete proposals", async () => {
  const r = repo(); r.write("a.txt", "changed\n");
  const good = await proposeSplit(r.dir, "fake", async () => JSON.stringify([{ subject: "A meaningful subject", files: ["a.txt"] }])); expect(good.source).toBe("model");
  const bad = await proposeSplit(r.dir, "fake", async () => JSON.stringify([{ subject: "Unsafe", files: ["../outside"] }])); expect(bad.source).toBe("offline"); expect(bad.groups[0]!.files).toEqual(["a.txt"]);
});

it("prepares a predicted branch conflict without a commit and refuses dirty work", async () => {
  const r = repo(); r.git("checkout", "-qb", "topic"); r.write("other.txt", "topic\n"); r.git("commit", "-qam", "topic"); r.git("checkout", "main"); r.write("other.txt", "main\n"); r.git("commit", "-qam", "main");
  r.write("a.txt", "unrelated\n"); await expect(prepareConflict(r.dir, "topic")).rejects.toThrow("stash"); r.git("restore", "a.txt");
  const head = r.git("rev-parse", "HEAD"); await prepareConflict(r.dir, "topic"); expect(r.git("rev-parse", "HEAD")).toBe(head); expect((await conflictPrompt(r.dir)).prompt).toContain("THEIRS:\ntopic");
});
it("checks secrets again if verification modifies the files to be committed", async () => {
  const r = repo(); r.write("a.txt", "safe\n");
  const code = `require('fs').writeFileSync('a.txt', 'token = ghp_' + 'A'.repeat(36) + '\\n')`;
  saveReviewSettings(r.dir, { verify: `node -e ${JSON.stringify(code)}` });
  const head = r.git("rev-parse", "HEAD"); await expect(stageAndCommitFiles(r.dir, ["a.txt"], "unsafe verification output")).rejects.toThrow("Secret scan"); expect(r.git("rev-parse", "HEAD")).toBe(head);
});

it("does not inherit project verification or hold across successive worktree commits", async () => {
  const r = repo(), worktree = path.join(tmpDir("r4-worktree"), "agent"); r.git("worktree", "add", "-b", "agent", worktree);
  saveReviewSettings(r.dir, { verify: 'node -e "console.log(1)"', hold: true }); fs.writeFileSync(path.join(worktree, "a.txt"), "first\n"); await stageAndCommitFiles(worktree, ["a.txt"], "first");
  saveReviewSettings(r.dir, { verify: `node -e "console.error(\'failed inherited check\');process.exit(1)"` }); fs.writeFileSync(path.join(worktree, "a.txt"), "second\n");
  await stageAndCommitFiles(worktree, ["a.txt"], "second"); expect(reviewSettings(r.dir).last).toBeUndefined(); expect(fs.existsSync(path.join(worktree, ".loom/review-r4.json"))).toBe(false);
});

it("maps lines across zero-context insertion and deletion hunks", () => {
  const first = { id: 1, kind: "turn_diff", chat: "main", agentId: "author", payload: { patch: "diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -1 +1,2 @@\n base\n+alpha\n" } } as unknown as LoomEvent;
  const remove = { id: 2, kind: "turn_diff", chat: "main", agentId: "editor", payload: { patch: "diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -1 +0,0 @@\n-base\n" } } as unknown as LoomEvent;
  const insert = { ...remove, payload: { patch: "diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -0,0 +1 @@\n+beta\n" } };
  expect(blameLine([first, remove], "a", 1).agent).toBe("author"); expect(blameLine([first, insert], "a", 3).agent).toBe("author");
});


function conflictRepo(content = "") {
  const r = repo(); r.git("checkout", "-qb", "topic"); r.write("other.txt", "theirs" + content + "\n"); r.git("commit", "-qam", "theirs");
  r.git("checkout", "main"); r.write("other.txt", "ours" + content + "\n"); r.git("commit", "-qam", "ours"); return r;
}
function resolutionRuntime(dir: string) {
  return { info: { dir }, config: { defaultAgent: "bot", agents: [{ id: "bot" }] }, reviews: { check: vi.fn() },
    status: async () => ({ holder: "other" }), handoff: vi.fn(async () => {}), sendMessage: vi.fn(async () => {}),
    createChat: vi.fn(() => ({ id: "resolution" })), deleteChat: vi.fn() };
}
it("reviews 120000 in added, removed and context lines as ordinary hunks", async () => {
  const r = repo(); r.write("a.txt", "timeout: 60000\ncontext: 120000\nold: 120000\n"); r.git("commit", "-qam", "timeouts");
  r.write("a.txt", "timeout: 120000\ncontext: 120000\nold: 60000\n");
  const h = await hunks(r.dir, "a.txt"); expect(h.hunks).toHaveLength(1);
  await changeHunk(r.dir, { path: "a.txt", id: h.hunks[0]!.id, version: h.version, action: "stage" }); expect(r.git("diff", "--cached")).toContain("+timeout: 120000");
  r.git("reset", "--", "a.txt"); const fresh = await hunks(r.dir, "a.txt");
  await changeHunk(r.dir, { path: "a.txt", id: fresh.hunks[0]!.id, version: fresh.version, action: "discard" }); expect(r.read("a.txt")).toContain("timeout: 60000");
  await changeHunk(r.dir, { action: "undo" }); expect(r.read("a.txt")).toContain("timeout: 120000");
  // chmod cannot change executable bits on Windows; keep the hunk assertions above.
  if (process.platform !== "win32") {
    r.git("config", "core.filemode", "true"); fs.chmodSync(path.join(r.dir, "a.txt"), 0o755);
    await expect(hunks(r.dir, "a.txt")).rejects.toThrow("mode changes");
  }
});
it("does not read untracked symlinks, special files or oversized files while summarizing and proposing", async () => {
  const r = repo(); fs.symlinkSync(tmpDir("r4-link"), path.join(r.dir, "node_modules"), "dir");
  const large = path.join(r.dir, "huge.dump"), fd = fs.openSync(large, "w"); fs.ftruncateSync(fd, 3_000_000_000); fs.closeSync(fd);
  // Windows has no filesystem FIFOs; the symlink/large-file checks still run.
  if (process.platform !== "win32") execFileSync("mkfifo", [path.join(r.dir, "pipe")]);
  r.write("new.ts", "hello\n");
  const read = vi.spyOn(fs, "readFileSync");
  try {
    const patch = await workingPatch(r.dir); expect(patch).toContain("Binary files differ");
    expect(summarize(patch).map(f => f.path)).toEqual(expect.arrayContaining(["node_modules", "huge.dump", "new.ts"]));
    expect((await proposeSplit(r.dir)).groups.flatMap(g => g.files)).toContain("new.ts");
    expect((await hunks(r.dir, "new.ts")).hunks).toHaveLength(1);
    expect(read.mock.calls.some(([file]) => [large, path.join(r.dir, "node_modules"), path.join(r.dir, "pipe")].includes(String(file)))).toBe(false);
  } finally { read.mockRestore(); }
});
it("requires URL repositories to match origin unless explicitly owned", async () => {
  for (const remote of ["git@github.com:owner/repo.git", "https://github.com/owner/repo.git", "ssh://git@github.com/owner/repo.git"]) {
    expect(() => checkPrRepository(remote, "https://github.com/owner/repo/pull/3")).not.toThrow();
    expect(() => checkPrRepository(remote, "https://github.com/owner/private-other/pull/3")).toThrow("not in this project's repository");
  }
  expect(() => checkPrRepository("git@gitlab.example:team/sub/repo.git", "https://gitlab.example/team/sub/repo/-/merge_requests/4")).not.toThrow();
  expect(() => checkPrRepository("git@gitlab.example:team/sub/repo.git", "https://gitlab.com/team/sub/repo/-/merge_requests/4")).toThrow();
  expect(() => checkPrRepository("", "https://github.com/other/repo/pull/1", true)).not.toThrow();
  const r = repo(); r.git("remote", "add", "origin", "git@github.com:owner/repo.git");
  await expect(pullRequestDiff(r.dir, "https://github.com/owner/private-other/pull/3")).rejects.toThrow("not in this project's repository");
});
it("aborts a prepared conflict when prompt construction fails", async () => {
  const r = conflictRepo("x".repeat(260_000)), rt = resolutionRuntime(r.dir), head = r.git("rev-parse", "HEAD");
  await expect(handConflictToAgent(rt as unknown as ProjectRuntime, "bot", "topic")).rejects.toThrow("too large");
  expect(r.git("status", "--porcelain")).toBe(""); expect(r.git("rev-parse", "HEAD")).toBe(head); expect(rt.createChat).not.toHaveBeenCalled(); expect(reviewSettings(r.dir).hold).not.toBe(true);
});
it.each(["handoff", "sendMessage"] as const)("cleans up a prepared conflict after %s fails", async method => {
  const r = conflictRepo(), rt = resolutionRuntime(r.dir);
  rt[method].mockRejectedValue(new Error("branch change in progress"));
  await expect(handConflictToAgent(rt as unknown as ProjectRuntime, "bot", "topic")).rejects.toThrow("branch change in progress");
  expect(r.git("status", "--porcelain")).toBe(""); expect(reviewSettings(r.dir).hold).not.toBe(true);
  if (method === "sendMessage") expect(rt.deleteChat).toHaveBeenCalledWith("resolution");
});
it("preserves a pre-existing merge and hold when a hand-off fails", async () => {
  const r = conflictRepo(); await prepareConflict(r.dir, "topic"); saveReviewSettings(r.dir, { hold: true });
  const rt = resolutionRuntime(r.dir); rt.sendMessage.mockRejectedValue(new Error("busy"));
  await expect(handConflictToAgent(rt as unknown as ProjectRuntime, "bot")).rejects.toThrow("busy");
  expect(r.git("rev-parse", "MERGE_HEAD")).toBeTruthy(); expect(reviewSettings(r.dir).hold).toBe(true);
});
it.each(["abort", "commit"])("releases a stale hold after a terminal %s", async action => {
  const r = conflictRepo(); await prepareConflict(r.dir, "topic"); saveReviewSettings(r.dir, { hold: true });
  if (action === "abort") r.git("merge", "--abort"); else { r.write("other.txt", "resolved\n"); r.git("add", "other.txt"); r.git("commit", "-qm", "terminal resolution"); }
  r.write("a.txt", "next turn\n"); await stageAndCommitFiles(r.dir, ["a.txt"], "next turn"); expect(reviewSettings(r.dir).hold).toBe(false);
});
it("runs verification asynchronously, reports configurable timeouts, and leaves merges unchecked", async () => {
  const r = repo(); saveReviewSettings(r.dir, { verify: `node -e "setTimeout(() => console.log('finished'), 250)"` });
  const timer = vi.spyOn(globalThis, "setTimeout");
  let finished = false; const pending = verifyBeforeCommit(r.dir).then(result => { finished = true; return result; });
  expect(timer).toHaveBeenCalledWith(expect.any(Function), 600_000); timer.mockRestore();
  await new Promise(resolve => setTimeout(resolve, 30)); expect(finished).toBe(false); expect((await pending)?.output).toContain("finished");
  saveReviewSettings(r.dir, { verifyTimeoutMs: 40, verify: `node -e "setTimeout(() => {}, 90000)"` });
  await expect(verifyBeforeCommit(r.dir)).rejects.toThrow("timed out after 40 ms"); expect(reviewSettings(r.dir).last?.ok).toBe(false);
  saveReviewSettings(r.dir, { verify: `node -e "throw Error('must not run')"` });
  expect(() => guardReviewCommit("git", ["merge", "topic"], r.dir)).not.toThrow(); expect(() => guardReviewCommit("git", ["cherry-pick", "HEAD"], r.dir)).not.toThrow();
  expect(() => guardReviewCommit("git", ["commit", "-m", "x"], r.dir)).not.toThrow(); expect(reviewSettings(r.dir).last?.output).toContain("timed out");
});

it("aborts a prepared symlink conflict when its prompt cannot safely read the path", async () => {
  const r = repo(); r.git("checkout", "-qb", "topic"); fs.unlinkSync(path.join(r.dir, "other.txt")); fs.symlinkSync("a.txt", path.join(r.dir, "other.txt")); r.git("add", "other.txt"); r.git("commit", "-qm", "theirs");
  r.git("checkout", "main"); fs.unlinkSync(path.join(r.dir, "other.txt")); fs.symlinkSync(".gitignore", path.join(r.dir, "other.txt")); r.git("add", "other.txt"); r.git("commit", "-qm", "ours");
  const rt = resolutionRuntime(r.dir);
  await expect(handConflictToAgent(rt as unknown as ProjectRuntime, "bot", "topic")).rejects.toThrow("symlink");
  expect(r.git("status", "--porcelain")).toBe(""); expect(rt.sendMessage).not.toHaveBeenCalled();
});

it("holds split commits on verification failure without committing any group", async () => {
  const r = repo(); r.write("a.txt", "split change\n"); const head = r.git("rev-parse", "HEAD");
  saveReviewSettings(r.dir, { verify: `node -e "console.error('split check failed'); process.exit(1)"` });
  const proposal = await proposeSplit(r.dir);
  await expect(applySplit(r.dir, proposal.groups, proposal.version)).rejects.toThrow("0 group(s) committed; remaining groups held: Verify before commit failed");
  expect(r.git("rev-parse", "HEAD")).toBe(head); expect(reviewSettings(r.dir).last?.output).toContain("split check failed");
});
