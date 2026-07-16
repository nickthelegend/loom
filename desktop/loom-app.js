// Desktop bootstrap logic, kept separate from Electron so it's node-testable.
// Ensures a loom daemon is running, mints a one-time pairing token via the
// admin API, and returns the /app URL the desktop window should load.
//
// Reuses the exact same daemon + pairing flow as the CLI and phone app —
// the desktop window is just another paired client, on the same machine.

import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const CLI_ENTRY = path.resolve(here, "..", "dist", "cli", "index.js");
const DIST_DAEMON = path.resolve(here, "..", "dist", "daemon");

function loomHome() {
  return process.env.LOOM_HOME ?? path.join(os.homedir(), ".loom");
}

function readDaemonConfig() {
  try {
    return JSON.parse(fs.readFileSync(path.join(loomHome(), "daemon.json"), "utf8"));
  } catch {
    return null;
  }
}

async function health(cfg) {
  try {
    const res = await fetch(`http://${cfg.host}:${cfg.port}/api/health`, {
      signal: AbortSignal.timeout(1500),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/**
 * Mirror of the daemon's BUILD_REV (content hash of the compiled server
 * module + the served web app), so the shell can tell when a running daemon
 * is serving yesterday's UI. Content-based, not mtime — exFAT volumes report
 * different mtimes to different runtimes, which made mtime revs lie.
 * `daemonDir` is a parameter so tests can hash a fixture instead of dist.
 */
export function localBuildRev(daemonDir = DIST_DAEMON) {
  try {
    const hash = crypto
      .createHash("sha256")
      .update(fs.readFileSync(path.join(daemonDir, "server.js")));
    try {
      hash.update(fs.readFileSync(path.join(daemonDir, "app-page.js")));
    } catch {
      /* app page missing — the server hash alone still fingerprints */
    }
    return hash.digest("hex").slice(0, 16);
  } catch {
    return null;
  }
}

/**
 * A live daemon from an older build serves yesterday's UI, so the shell has to
 * restart it. Unknown on either side means "assume current": we'd rather load a
 * possibly-stale app than kill a daemon we can't fingerprint.
 */
export function isStaleDaemon(aliveRev, localRev) {
  if (!aliveRev || !localRev) return false;
  return aliveRev !== localRev;
}

async function ensureDaemon() {
  let cfg = readDaemonConfig();
  const alive = cfg ? await health(cfg) : null;
  if (alive) {
    if (!isStaleDaemon(alive.rev, localBuildRev())) return cfg;
    // A healthy daemon from an older build would serve the old app — restart
    // it (same auto-restart `loom up` performs on a stale rev).
    if (cfg.pid) {
      try {
        process.kill(cfg.pid);
      } catch {
        /* already gone or not ours — fall through and race the port */
      }
      const gone = Date.now() + 5_000;
      while (Date.now() < gone && (await health(cfg))) {
        await new Promise((r) => setTimeout(r, 200));
      }
    }
  }
  // Start the daemon from the built CLI (same entry the `loom` command uses).
  await spawnDaemon();
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 300));
    cfg = readDaemonConfig();
    if (cfg && (await health(cfg))) return cfg;
  }
  throw new Error("loom daemon did not start");
}

const LOG_MAX_BYTES = 5 * 1024 * 1024;

/**
 * Open ~/.loom/daemon.log for append, rolling it once it gets big.
 *
 * `loom up` has a twin of this (src/cli/index.ts). The daemon has to leave a
 * trace whichever of the two started it, and the desktop app is the one most
 * people use — a crash here used to go to stdio:"ignore" and vanish. Kept
 * local rather than imported from dist because this file stays dependency-free
 * on purpose, the same way it re-implements loomHome() above.
 *
 * Falls back to "ignore" if the log can't be opened: no log is bad, but a
 * desktop app that won't start because of it is worse.
 */
export function openDaemonLog() {
  const file = path.join(loomHome(), "daemon.log");
  try {
    fs.mkdirSync(loomHome(), { recursive: true });
    if (fs.statSync(file).size > LOG_MAX_BYTES) fs.renameSync(file, `${file}.1`);
  } catch {
    /* no log yet, or it vanished — open a fresh one below */
  }
  try {
    return fs.openSync(file, "a");
  } catch {
    return "ignore";
  }
}

/**
 * Spawn the daemon under a real Node runtime. Electron's bundled Node is too
 * old for node:sqlite (Loom needs >=22.5), so a daemon spawned with the
 * Electron binary silently degrades to the JSONL event store and serves no
 * history. Preference order: $LOOM_NODE, well-known install paths, `node`
 * from PATH, and only then Electron-as-Node as a last resort.
 */
async function spawnDaemon() {
  const attempts = [];
  if (process.env.LOOM_NODE) attempts.push([process.env.LOOM_NODE, process.env]);
  const known =
    process.platform === "win32"
      ? [path.join(process.env.ProgramFiles ?? "C:\\Program Files", "nodejs", "node.exe")]
      : ["/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node"];
  for (const c of known) {
    if (fs.existsSync(c)) {
      attempts.push([c, process.env]);
      break;
    }
  }
  attempts.push(["node", process.env]);
  attempts.push([process.execPath, { ...process.env, ELECTRON_RUN_AS_NODE: "1" }]);
  const log = openDaemonLog();
  try {
    for (const [cmd, env] of attempts) {
      const ok = await new Promise((resolve) => {
        let child;
        try {
          child = spawn(cmd, [CLI_ENTRY, "daemon"], { detached: true, stdio: ["ignore", log, log], env });
        } catch {
          return resolve(false);
        }
        child.once("spawn", () => {
          child.unref();
          resolve(true);
        });
        child.once("error", () => resolve(false));
      });
      if (ok) return;
    }
  } finally {
    // The child dup'd the fd at spawn; this one is ours to let go of. Electron
    // main outlives the spawn, so leaving it open would leak a descriptor.
    if (typeof log === "number") {
      try {
        fs.closeSync(log);
      } catch {
        /* already gone */
      }
    }
  }
  throw new Error("could not find a Node runtime to start the loom daemon");
}

/**
 * Ensure a daemon, mint a single-use pairing token, and return the deep-linked
 * /app URL. The web app claims the token and stores its client token in the
 * Electron partition, so subsequent launches load already-paired.
 */
export async function prepareAppUrl() {
  const cfg = await ensureDaemon();
  const base = `http://${cfg.host}:${cfg.port}`;
  const res = await fetch(`${base}/api/pair/new`, {
    method: "POST",
    headers: { authorization: `Bearer ${cfg.adminToken}` },
  });
  if (!res.ok) throw new Error(`could not mint pairing token (${res.status})`);
  const { token } = await res.json();
  return { url: `${base}/app#pair=${token}`, base, port: cfg.port };
}
