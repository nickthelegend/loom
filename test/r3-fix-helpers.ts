import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { makeProjectDir, tmpDir } from "./helpers.js";
import { writeProjectConfig } from "../src/core/registry.js";
import { ProjectRuntime } from "../src/daemon/runtime.js";
import type { ProjectConfig } from "../src/types.js";

export const git = (dir: string, ...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
export function deferred() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}
export async function open(config: Partial<ProjectConfig> = {}) {
  process.env.LOOM_HOME = tmpDir("r3-home");
  process.env.LOOM_NO_NOTIFY = "1";
  const dir = makeProjectDir();
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "test@example.com");
  git(dir, "config", "user.name", "Test");
  fs.writeFileSync(path.join(dir, ".gitignore"), ".loom/\n");
  fs.writeFileSync(path.join(dir, "seed.txt"), "seed\n");
  git(dir, "add", ".");
  git(dir, "commit", "-qm", "seed");
  writeProjectConfig(dir, { name: "r3", agents: [{ id: "a", kind: "echo" }, { id: "b", kind: "echo" }], brain: { extractor: "off" }, ...config });
  return ProjectRuntime.open({ id: path.basename(dir), name: "r3", dir });
}
