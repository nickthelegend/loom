#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

// Copy a checkout or current remote main; no upstream installer is executed.
const source = process.argv[2] ?? "https://github.com/nickthelegend/loom-skills.git";
const destination = fileURLToPath(new URL("../skills/agent/", import.meta.url));
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "loom-agent-skills-"));
const git = (args, cwd) => execFileSync("git", args, {
  cwd, encoding: "utf8", timeout: 90_000,
  env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never", GIT_OPTIONAL_LOCKS: "0" },
}).trim();
try {
  let checkout;
  if (fs.existsSync(source)) checkout = path.resolve(source);
  else {
    if (!/^(https?:\/\/|ssh:\/\/|git@)[^\s]+$/.test(source)) throw new Error("expected a local checkout or git URL");
    checkout = path.join(temp, "checkout");
    git(["clone", "--depth", "1", "--branch", "main", "--", source, checkout]);
  }
  if (git(["status", "--porcelain", "--", "skills", "LICENSE"], checkout)) {
    throw new Error("commit upstream skill changes before syncing so the version identifies the copied files");
  }
  const version = {
    revision: git(["rev-parse", "HEAD"], checkout),
    committedAt: git(["show", "-s", "--format=%cI", "HEAD"], checkout),
  };
  const stage = path.join(temp, "bundle");
  fs.mkdirSync(stage);
  const dirs = fs.readdirSync(path.join(checkout, "skills"), { withFileTypes: true }).filter(d => d.isDirectory());
  if (!dirs.length) throw new Error("no skill folders found");
  for (const dir of dirs) {
    const from = path.join(checkout, "skills", dir.name);
    if (!fs.statSync(path.join(from, "SKILL.md")).isFile()) throw new Error(`missing SKILL.md: ${dir.name}`);
    fs.cpSync(from, path.join(stage, dir.name), { recursive: true });
  }
  fs.copyFileSync(path.join(checkout, "LICENSE"), path.join(stage, "LICENSE"));
  fs.writeFileSync(path.join(stage, "version.json"), JSON.stringify(version, null, 2) + "\n");
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.rmSync(destination, { recursive: true, force: true });
  fs.cpSync(stage, destination, { recursive: true });
  console.log(`Synced ${dirs.length} agent skills at ${version.revision}`);
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
