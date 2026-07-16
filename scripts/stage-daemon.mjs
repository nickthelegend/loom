/**
 * Stage the daemon for packaging: desktop/build/daemon.
 *
 * The desktop app is an Electron shell around the loom daemon, and the daemon
 * is a Node program with real dependencies. It needs three things at runtime
 * that the shell doesn't have:
 *
 *   - dist/, the compiled daemon and CLI;
 *   - its production node_modules — express and ws to serve, and @xterm/*,
 *     which the daemon serves to the browser straight off disk (the web app has
 *     no build step and no CDN, so xterm.js is read out of node_modules on
 *     every request — see daemon/server.ts);
 *   - package.json, which the CLI reads.
 *
 * None of that was in the DMG. `files: ["../dist/**\/*"]` looks like it ships
 * the daemon and ships nothing: electron-builder resolves `files` inside the
 * app directory, and a `../` escape silently matches zero files. The result
 * built, mounted, installed, and died on launch — an app that is worse than no
 * app, because it looks finished.
 *
 * This stages a clean production tree with `npm ci --omit=dev`, which is also
 * how the devDependencies (electron, vitest, jsdom — hundreds of megabytes)
 * stay out of a DMG.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const stage = path.join(root, "desktop", "build", "daemon");

const log = (m) => console.log(`  ${m}`);

fs.rmSync(stage, { recursive: true, force: true });
fs.mkdirSync(stage, { recursive: true });

// The compiled daemon. Built already — this script does not build, so a stale
// dist stays stale and visible rather than being quietly regenerated here.
const dist = path.join(root, "dist");
if (!fs.existsSync(dist)) {
  console.error("no dist/ — run `npm run build` first");
  process.exit(1);
}
fs.cpSync(dist, path.join(stage, "dist"), { recursive: true });
log(`dist → ${rel(path.join(stage, "dist"))}`);

// package.json, minus everything the daemon doesn't need at runtime. Scripts go
// too: `npm ci` would otherwise run `prepare` (which builds) inside the stage.
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const staged = {
  name: pkg.name,
  version: pkg.version,
  type: pkg.type,
  main: pkg.main,
  bin: pkg.bin,
  dependencies: pkg.dependencies,
  optionalDependencies: pkg.optionalDependencies,
};
fs.writeFileSync(path.join(stage, "package.json"), `${JSON.stringify(staged, null, 2)}\n`);
fs.copyFileSync(path.join(root, "package-lock.json"), path.join(stage, "package-lock.json"));

// Production dependencies only. `npm ci` needs the lock to agree with the
// package.json it sits next to; ours differs (no devDependencies), so install
// resolves it instead. Slower, and it can't lie about what it produced.
log("installing production dependencies…");
execFileSync("npm", ["install", "--omit=dev", "--no-audit", "--no-fund", "--silent"], {
  cwd: stage,
  stdio: ["ignore", "inherit", "inherit"],
});
fs.rmSync(path.join(stage, "package-lock.json"), { force: true });

// Prove the pieces the daemon reaches for at runtime are actually here. A stage
// that quietly lacks xterm produces an app whose terminal 404s, and you find out
// from a user.
const required = [
  "dist/cli/index.js",
  "dist/daemon/server.js",
  "node_modules/express/package.json",
  "node_modules/ws/package.json",
  "node_modules/@xterm/xterm/lib/xterm.js",
  "node_modules/@xterm/addon-fit/lib/addon-fit.js",
];
const missing = required.filter((r) => !fs.existsSync(path.join(stage, r)));
if (missing.length) {
  console.error(`\nstage is incomplete — the app would ship broken:\n${missing.map((m) => `  ✗ ${m}`).join("\n")}`);
  process.exit(1);
}
log(`verified ${required.length} runtime paths`);
log(`staged ${mb(stage)} MB → ${rel(stage)}`);

function rel(p) {
  return path.relative(root, p);
}

function mb(dir) {
  let total = 0;
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) total += fs.statSync(p).size;
    }
  };
  walk(dir);
  return (total / 1048576).toFixed(1);
}
