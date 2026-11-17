import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readDaemonConfig, readProjectConfig, writeProjectConfig } from "./registry.js";
import { ProjectCreationError, projectGit } from "./project-creation.js";
import type { AgentConfig, ProjectInfo } from "../types.js";

/** POST /api/try accepts an optional absolute dir and 1–8 agents (default 3).
 * Reusing a demo keeps its files, history and roster; agents only sizes a new demo. */
export interface TryProjectInput { dir?: string; agents?: number }
/** The project id is usable by every project endpoint; agents[].id is the name
 * to pass as agentId when sending a prompt, steering, or starting Orchestra. */
export interface TryProjectResult { project: ProjectInfo & { agents: AgentConfig[] } }

export function demoDestination(input: TryProjectInput): string {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new ProjectCreationError("expected an object");
  if (input.agents !== undefined && (!Number.isInteger(input.agents) || input.agents < 1 || input.agents > 8)) {
    throw new ProjectCreationError("agents must be an integer from 1 to 8");
  }
  if (input.dir !== undefined && (typeof input.dir !== "string" || !path.isAbsolute(input.dir) || input.dir.includes("\0"))) {
    throw new ProjectCreationError("dir must be an absolute path");
  }
  return path.resolve(input.dir ?? path.join(readDaemonConfig()?.projectsRoot ?? path.join(os.homedir(), "Loom Projects"), "loom-demo"));
}

/** Only a directory created by this flow may be reused; never overwrite a user's repo. */
export async function prepareDemoProject(dir: string, count = 3): Promise<void> {
  if (fs.existsSync(dir)) {
    for (const file of [dir, path.join(dir, ".loom"), path.join(dir, ".loom", "config.json"), path.join(dir, ".git")]) {
      if (fs.lstatSync(file, { throwIfNoEntry: false })?.isSymbolicLink()) throw new ProjectCreationError("demo paths must not be symlinks", 409);
    }
    const config = readProjectConfig(dir);
    if (!fs.existsSync(path.join(dir, ".loom", "demo.json")) || !config?.agents.length || config.agents.some(a => a.kind !== "demo")) {
      throw new ProjectCreationError(`folder already exists and is not a Loom demo: ${dir}`, 409);
    }
    return;
  }
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  fs.mkdirSync(dir);
  try {
    const template = fileURLToPath(new URL("../../templates/demo-app/", import.meta.url));
    fs.cpSync(template, dir, { recursive: true, force: false, errorOnExist: true });
    // npm omits .gitignore files from packages, so create this after copying.
    fs.writeFileSync(path.join(dir, ".gitignore"), ".loom/\n", { flag: "wx" });
    await projectGit(["init"], dir);
    await projectGit(["add", "--", "."], dir);
    await projectGit(["-c", "user.name=Loom Demo", "-c", "user.email=demo@loom.local", "-c", "commit.gpgsign=false", "commit", "-m", "Start Loom demo"], dir);
    writeProjectConfig(dir, {
      name: "Loom Demo",
      agents: Array.from({ length: count }, (_, i) => ({ id: `demo-${i + 1}`, kind: "demo", role: "demo", options: { model: i % 2 ? "demo-fast" : "demo-smart" } })),
      brain: { extractor: "off" },
    });
    fs.writeFileSync(path.join(dir, ".loom", "demo.json"), JSON.stringify({ version: 1 }));
  } catch (error) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw error;
  }
}
