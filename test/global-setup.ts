/**
 * Test temp dirs go when the run ends. Workers are torn down without a
 * reliable `exit`, so the per-worker cleanup in helpers.ts misses some; this
 * runs once, in the main process, after every file has finished. It removes
 * `loom-test-*` dirs created since the run began (so a run never deletes an
 * older one's). LOOM_KEEP_TEST_DIRS=1 keeps them for debugging.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { TestProject } from "vitest/node";

export default function setup(project: TestProject): () => void {
  const started = Date.now() - 1000;
  const prefix = `loom-test-${project.config.env.LOOM_TEST_RUN_ID ?? "local"}-`;
  return () => {
    if (process.env.LOOM_KEEP_TEST_DIRS) return;
    const tmp = os.tmpdir();
    for (const name of fs.readdirSync(tmp)) {
      if (!name.startsWith(prefix)) continue;
      const p = path.join(tmp, name);
      try {
        if (path.dirname(path.resolve(p)) === path.resolve(tmp) && fs.statSync(p).birthtimeMs >= started)
          fs.rmSync(p, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      } catch {
        /* gone already, or not ours to touch */
      }
    }
  };
}
