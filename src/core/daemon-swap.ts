/**
 * When a newer CLI swaps the daemon for its own build, say so where people look afterwards — the
 * daemon's log, `loom version`, a chain's progress — and let a long unattended chain opt out.
 * Field: 1.2.6 → 1.2.7 happened in the one-second gap between two chained runs; right, but
 * noticed only from "up 14m".
 */

import fs from "node:fs";
import path from "node:path";
import { loomHome } from "./registry.js";

export interface DaemonSwap {
  fromVersion?: string;
  fromRev?: string;
  toVersion: string;
  toRev: string;
  at: number;
}

const swapFile = () => path.join(loomHome(), "daemon-swap.json");
const cliFile = () => path.join(loomHome(), "cli.json");

export function writeSwapNote(s: DaemonSwap): void {
  try { fs.writeFileSync(swapFile(), JSON.stringify(s) + "\n"); } catch { /* a note, never a failure */ }
}

/** The last swap, when it brought up this build. */
export function readSwapNote(rev: string): DaemonSwap | null {
  try {
    const s = JSON.parse(fs.readFileSync(swapFile(), "utf8")) as DaemonSwap;
    return s && s.toRev === rev && typeof s.at === "number" ? s : null;
  } catch {
    return null;
  }
}

export function describeSwap(s: DaemonSwap): string {
  const from = s.fromVersion && s.fromVersion !== s.toVersion ? s.fromVersion : (s.fromRev ?? "an older build");
  const to = s.fromVersion && s.fromVersion !== s.toVersion ? s.toVersion : s.toRev;
  return `${from} → ${to}`;
}

/** Off: a CLI that finds an older daemon uses it as it is (`loom config auto-restart off`, or LOOM_AUTO_RESTART=off). */
export function autoRestartEnabled(): boolean {
  if (/^(0|off|false|no)$/i.test(process.env.LOOM_AUTO_RESTART ?? "")) return false;
  try { return (JSON.parse(fs.readFileSync(cliFile(), "utf8")) as { autoRestart?: boolean }).autoRestart !== false; } catch { return true; }
}

export function setAutoRestart(on: boolean): void {
  let cur: Record<string, unknown> = {};
  try { cur = JSON.parse(fs.readFileSync(cliFile(), "utf8")) as Record<string, unknown>; } catch { /* new file */ }
  fs.mkdirSync(loomHome(), { recursive: true });
  fs.writeFileSync(cliFile(), JSON.stringify({ ...cur, autoRestart: on }, null, 2) + "\n");
}
