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

export default function setup(): () => void {
  const started = Date.now() - 1000;
  return () => {
    if (process.env.LOOM_KEEP_TEST_DIRS) return;
    const tmp = os.tmpdir();
    for (const name of fs.readdirSync(tmp)) {
      if (!name.startsWith("loom-test-")) continue;
      const p = path.join(tmp, name);
      try {
        if (fs.statSync(p).birthtimeMs >= started) fs.rmSync(p, { recursive: true, force: true });
      } catch {
        /* gone already, or not ours to touch */
      }
    }
  };
}
