// Desktop bootstrap logic, kept separate from Electron so it's node-testable.
// Ensures a loom daemon is running, mints a one-time pairing token via the
// admin API, and returns the /app URL the desktop window should load.
//
// Reuses the exact same daemon + pairing flow as the CLI and phone app —
// the desktop window is just another paired client, on the same machine.

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const CLI_ENTRY = path.resolve(here, "..", "dist", "cli", "index.js");

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
    return res.ok;
  } catch {
    return false;
  }
}

async function ensureDaemon() {
  let cfg = readDaemonConfig();
  if (cfg && (await health(cfg))) return cfg;
  // Start the daemon from the built CLI (same entry the `loom` command uses).
  const child = spawn(process.execPath, [CLI_ENTRY, "daemon"], {
    detached: true,
    stdio: "ignore",
    env: process.env,
  });
  child.unref();
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 300));
    cfg = readDaemonConfig();
    if (cfg && (await health(cfg))) return cfg;
  }
  throw new Error("loom daemon did not start");
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
