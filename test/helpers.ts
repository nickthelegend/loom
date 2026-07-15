import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { writeProjectConfig } from "../src/core/registry.js";
import type { ProjectConfig } from "../src/types.js";

export function tmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `loom-test-${prefix}-`));
}

export function makeProjectDir(config?: Partial<ProjectConfig>): string {
  const dir = tmpDir("proj");
  const cfg: ProjectConfig = {
    name: config?.name ?? path.basename(dir),
    agents: config?.agents ?? [
      { id: "plannerbot", kind: "echo", role: "planner" },
      { id: "execbot", kind: "echo", role: "executor" },
    ],
    ...(config?.defaultAgent ? { defaultAgent: config.defaultAgent } : {}),
    ...(config?.routes ? { routes: config.routes } : {}),
  };
  writeProjectConfig(dir, cfg);
  return dir;
}

export async function waitUntil(
  predicate: () => Promise<boolean> | boolean,
  { timeoutMs = 8000, intervalMs = 40 } = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error("waitUntil: condition not met in time");
}
