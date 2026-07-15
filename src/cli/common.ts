/**
 * Shared CLI plumbing: resolving "the project I'm standing in".
 */

import fs from "node:fs";
import path from "node:path";
import type { ProjectStatus } from "../types.js";
import { findProject } from "../core/registry.js";
import type { DaemonClient } from "../daemon/client.js";

/** Walk up from cwd to the nearest directory containing .loom/config.json. */
export function currentProjectDir(): string | null {
  let dir = process.cwd();
  for (;;) {
    if (fs.existsSync(path.join(dir, ".loom", "config.json"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export class NoProjectError extends Error {
  constructor() {
    super("no Loom project here — run `loom init` in your project directory");
    this.name = "NoProjectError";
  }
}

export async function resolveCurrentProject(client: DaemonClient): Promise<ProjectStatus> {
  const dir = currentProjectDir();
  if (!dir) throw new NoProjectError();
  let info = findProject(dir);
  if (!info) {
    // Has .loom but isn't registered (e.g. a cloned repo) — register it.
    await client.addProject(dir);
    info = findProject(dir);
  }
  if (!info) throw new Error(`could not register project at ${dir}`);
  const { project } = await client.project(info.id);
  return project;
}
