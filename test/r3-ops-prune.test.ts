import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LoomDaemon } from "../src/daemon/server.js";
import { readDaemonConfig, registerProject, readProjectConfig, writeProjectConfig } from "../src/core/registry.js";
import { orchestraWorktreeRoot, type OrchestraRun } from "../src/core/orchestra.js";
import { makeProjectDir, tmpDir, waitUntil } from "./helpers.js";

let daemon: LoomDaemon, base: string, token: string, dir: string, id: string;
const trees = new Map<string, string>();
const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
const post = async (body: unknown) => {
  const r = await fetch(`${base}/api/projects/${id}/worktrees/prune`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
  expect(r.status).toBe(200);
  return await r.json() as { dryRun: boolean; candidates: string[]; removed: string[]; skipped: Array<{ id: string; reason: string }> };
};
beforeAll(async () => {
  process.env.LOOM_HOME = tmpDir("r3-prune-home");
  dir = makeProjectDir({ name: "retention" });
  git("init", "-q");
  fs.writeFileSync(path.join(dir, ".gitignore"), ".loom/\n");
  fs.writeFileSync(path.join(dir, "seed"), "seed");
  git("add", "."); git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "seed");
  const info = registerProject(dir, "retention"); id = info.id;
  const root = orchestraWorktreeRoot(dir, id);
  fs.mkdirSync(path.join(dir, ".loom", "orchestra"), { recursive: true });
  for (const [index, name] of ["old", "new", "dirty", "locked", "waiting"].entries()) {
    const wt = path.join(root, name, "integration");
    git("worktree", "add", "-q", "-b", `retention-${name}`, wt, "HEAD");
    trees.set(name, wt);
    const at = Date.now() - (name === "old" ? 10 * 86_400_000 : 60_000 - index * 1000);
    const run: OrchestraRun = { id: name, goal: name, orchestrator: { agent: "plannerbot", kind: "echo" }, workers: [],
      status: name === "waiting" ? "waiting_human" : "completed", chat: "main", baseBranch: git("branch", "--show-current"), baseCommit: git("rev-parse", "HEAD"),
      branch: `retention-${name}`, dir: wt, tasks: [], round: 0, maxRounds: 1, maxParallel: 1, costUsd: 0, createdAt: at, updatedAt: at };
    fs.writeFileSync(path.join(dir, ".loom", "orchestra", `${name}.json`), JSON.stringify(run));
  }
  fs.writeFileSync(path.join(trees.get("dirty")!, "uncommitted"), "keep me");
  git("worktree", "lock", trees.get("locked")!);
  // A run folder may contain other evidence; pruning must not recursively remove it.
  fs.writeFileSync(path.join(path.dirname(trees.get("old")!), "evidence.txt"), "keep me too");
  daemon = new LoomDaemon({ host: "127.0.0.1", port: 0 });
  const addr = await daemon.listen(); base = `http://${addr.host}:${addr.port}`;
  token = readDaemonConfig()!.adminToken;
});
afterAll(async () => { await daemon.close(); });

describe("R3 worktree policy", () => {
  it("previews age and count independently without changing any files or branches", async () => {
    const age = await post({ policy: { days: 7, keep: 10000 }, dryRun: true });
    expect(age.candidates).toEqual(["old"]);
    expect(age.removed).toEqual([]);
    const count = await post({ policy: { days: 100, keep: 2 } });
    expect(count.dryRun).toBe(true);
    expect(count.candidates.sort()).toEqual(["new", "old"]);
    for (const tree of trees.values()) expect(fs.existsSync(tree)).toBe(true);
  });
  it("rechecks dirty and locked checkouts, excludes waiting runs, and removes only clean worktrees", async () => {
    const report = await post({ policy: { days: 0, keep: 0 }, dryRun: false });
    expect(report.removed.sort()).toEqual(["new", "old"]);
    expect(report.skipped.map(r => r.id).sort()).toEqual(["dirty", "locked"]);
    expect(report.candidates).not.toContain("waiting");
    for (const name of ["old", "new"]) {
      expect(fs.existsSync(trees.get(name)!)).toBe(false);
      expect(git("rev-parse", `retention-${name}`)).toMatch(/^[a-f0-9]{40}$/);
    }
    for (const name of ["dirty", "locked", "waiting"]) expect(fs.existsSync(trees.get(name)!)).toBe(true);
    expect(fs.readFileSync(path.join(path.dirname(trees.get("old")!), "evidence.txt"), "utf8")).toBe("keep me too");
  });
  it("uses the persisted policy for automatic sweeps and ignores malformed policies", async () => {
    fs.unlinkSync(path.join(trees.get("dirty")!, "uncommitted"));
    const config = readProjectConfig(dir)!;
    config.orchestra = { prune: { days: 0, keep: 0 } };
    writeProjectConfig(dir, config);
    await daemon.close();
    daemon = new LoomDaemon({ host: "127.0.0.1", port: 0 });
    await daemon.listen();
    expect(daemon["runtimes"].size).toBe(0);
    await waitUntil(() => !fs.existsSync(trees.get("dirty")!), { timeoutMs: 35_000 });
    const rt = daemon["runtimes"].get(id)!;
    expect(fs.existsSync(trees.get("dirty")!)).toBe(false);
    await expect(rt.orchestra.pruneWorktrees({ days: -1, keep: 0 }, false)).rejects.toThrow("invalid worktree policy");
    expect(fs.existsSync(trees.get("locked")!)).toBe(true);
  });
});
