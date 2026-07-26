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
    ...(config?.projection ? { projection: config.projection } : {}),
    ...(config?.mcps ? { mcps: config.mcps } : {}),
    // Default the phase-2 extractor OFF in tests: it would spawn a `claude`
    // process per turn, which is nondeterministic and absent in CI. Tests that
    // want it pass their own brain config.
    brain: config?.brain ?? { extractor: "off" },
  };
  writeProjectConfig(dir, cfg);
  return dir;
}

/**
 * Poll until a condition holds.
 *
 * The default was 8s, chosen for "wait for the DOM to settle". Most callers are
 * that. But app-dom.test.ts drives a real daemon inside jsdom while the other
 * test files run in parallel, and its waits are on real work: an agent turn, a
 * `/api/setup` that spawns a CLI probe per agent (4.8-6.0s on an *idle*
 * machine), a `/api/doctor` that shells out. Against 8s that is barely more
 * than 1x of headroom, so the suite produced a rotating cast of one-test
 * failures — markdown rendering, then settings, then the command palette —
 * that all looked like separate bugs and were one budget.
 *
 * 20s, because a wait that is genuinely never going to succeed still fails; it
 * just takes longer to say so. Trading a slower red for a trustworthy green is
 * the right way round when the alternative is a suite people learn to re-run.
 */
export async function waitUntil(
  predicate: () => Promise<boolean> | boolean,
  { timeoutMs = 20_000, intervalMs = 40 } = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error("waitUntil: condition not met in time");
}
