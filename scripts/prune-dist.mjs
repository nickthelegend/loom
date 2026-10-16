// Remove compiled output whose source is gone.
//
// tsc writes dist/ but never deletes from it, so a renamed or deleted
// src/foo.ts leaves dist/foo.js behind. That file still ships in a
// checkout-based install, can still be imported, and changes the daemon's
// BUILD_REV — the fingerprint the desktop app and the CLI compare to decide
// whether a running daemon is current. A stale file there means two builds of
// the same commit disagree, and each restarts the other's daemon.
//
// Only compiled TypeScript is pruned (dist/web is the esbuild bundle, rebuilt
// whole). Nothing is wiped up front: a daemon running from this checkout keeps
// loading modules from dist/ while it rebuilds.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(root, "dist"), src = path.join(root, "src");
const OUT = /\.(js|d\.ts|js\.map|d\.ts\.map)$/;
let pruned = 0;

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    const rel = path.relative(dist, full);
    if (entry.isDirectory()) {
      if (rel === "web") continue;
      walk(full);
      if (!fs.readdirSync(full).length) fs.rmdirSync(full);
      continue;
    }
    if (!OUT.test(entry.name)) continue;
    const stem = rel.replace(OUT, "");
    const has = [".ts", ".tsx", ".mts", ".js", ".mjs"].some((ext) => fs.existsSync(path.join(src, stem + ext)));
    if (!has) { fs.rmSync(full); pruned++; }
  }
}

if (fs.existsSync(dist)) walk(dist);
if (pruned) console.log(`prune-dist: removed ${pruned} file${pruned === 1 ? "" : "s"} whose source is gone`);
