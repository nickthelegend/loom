/**
 * Area P: the Update button against the real product.
 *
 * A real clone of this repository, checked out one commit back, with a real
 * daemon running from it. The update is the product's own: it runs the
 * commands the plan printed, rebuilds, and exits so whatever started it brings
 * it back on the new build. The only thing arranged for the test is the
 * remote — it's this working copy on disk rather than GitHub, so the pull is
 * the same git operation without the network in the way.
 *
 * Run: node e2e/run-update.mjs
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Daemon, Recorder, check, expect, git, ROOT, sleep, until } from "./lib.mjs";

const rec = new Recorder(path.join(ROOT, "e2e/results/update.json"));
const sh = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

/** A clone of this repo, one commit behind its remote, ready to run. */
function cloneBehind() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-e2e-update-"));
  const repo = path.join(dir, "loom");
  sh("git", ["clone", "--quiet", "--no-hardlinks", ROOT, repo]);
  sh("git", ["-c", "advice.detachedHead=false", "checkout", "--quiet", "HEAD~1"], repo);
  sh("git", ["switch", "--quiet", "-c", "behind"], repo);
  sh("git", ["branch", "--set-upstream-to=origin/HEAD", "behind"], repo);
  // node_modules is the slow part and identical to this checkout's: share it,
  // so `npm install` in the update has almost nothing to do.
  fs.symlinkSync(path.join(ROOT, "node_modules"), path.join(repo, "node_modules"), "dir");
  sh("npm", ["run", "build"], repo);
  return repo;
}

const repo = cloneBehind();
const before = sh("git", ["rev-parse", "HEAD"], repo);
const target = sh("git", ["rev-parse", "origin/HEAD"], repo);

/** A daemon running the clone's own build, not this checkout's. */
const d = new Daemon("update", { env: { LOOM_UPDATE_E2E: "1" } });
d.entry = path.join(repo, "dist", "cli", "index.js");
await d.start();

await check(rec, "P1", async () => {
  const u = (await d.get("/api/updates")).body;
  expect(u.install === "git", `a clone reads as a git install, got ${u.install}`);
  expect(u.canApply === true, "and says it can update itself");
  expect(u.steps.join(" | ") === "git pull --ff-only | npm install --no-audit --no-fund | npm run build",
    `the plan is the commands themselves, got ${JSON.stringify(u.steps)}`);
  expect(u.root && u.root.startsWith(path.dirname(repo)), `rooted at the clone, got ${u.root}`);
  expect(typeof u.behindRelease === "boolean", "and answers the release question with a boolean");
  return `install=${u.install} root=${u.root} steps=[${u.steps.join(" && ")}] version=${u.version}`;
});

await check(rec, "P2", async () => {
  // Uncommitted work is yours: the update refuses rather than rebasing over it.
  fs.writeFileSync(path.join(repo, "SCRATCH.md"), "mine\n");
  const refused = await d.post("/api/updates/apply", {});
  fs.rmSync(path.join(repo, "SCRATCH.md"));
  expect(refused.status === 400, `refused, got ${refused.status} ${refused.text.slice(0, 200)}`);
  expect(/uncommitted/.test(refused.body?.error ?? ""), `and says why, got ${refused.text.slice(0, 200)}`);
  expect(sh("git", ["rev-parse", "HEAD"], repo) === before, "the checkout didn't move");
  return `dirty checkout → 400 "${refused.body.error}"; HEAD unchanged`;
});

await check(rec, "P3", async () => {
  const started = await d.post("/api/updates/apply", {});
  expect(started.status === 200 && started.body.started, `started, got ${started.status} ${started.text.slice(0, 200)}`);

  // It runs the real commands, then exits so it can come back on the new build.
  await until(async () => {
    try {
      await d.get("/api/health");
      return null;
    } catch {
      return true; // gone: the daemon exited itself
    }
  }, { timeoutMs: 600_000, every: 2000, what: "the daemon to restart itself" });

  const after = sh("git", ["rev-parse", "HEAD"], repo);
  expect(after === target, `the clone moved to its remote's head, got ${after.slice(0, 8)} want ${target.slice(0, 8)}`);
  const built = fs.statSync(path.join(repo, "dist", "daemon", "server.js")).mtimeMs;
  expect(Date.now() - built < 10 * 60_000, "and the build is fresh");

  // And the thing that comes back is the new build.
  await d.start();
  const u = (await d.get("/api/updates")).body;
  expect(u.rev, "the daemon is up again with a build rev");
  return `pulled ${before.slice(0, 8)} → ${after.slice(0, 8)}, rebuilt, exited, and came back on rev ${u.rev.slice(0, 8)}`;
});

await d.stop();
fs.rmSync(path.dirname(repo), { recursive: true, force: true });
