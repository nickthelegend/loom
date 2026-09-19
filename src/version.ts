/**
 * Loom's version, from package.json — one source, so the CLI, the TUI and the
 * daemon's API can't drift from the release (they each said 0.1.0 by hand).
 * dist/version.js sits one level below package.json in the repo and in the
 * desktop app's staged daemon alike.
 */

import fs from "node:fs";

export const VERSION: string = (() => {
  try {
    return String((JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version?: string }).version ?? "0.0.0");
  } catch {
    return "0.0.0";
  }
})();
