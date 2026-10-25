/**
 * The daemon-wide turn gate (#339): how many agent turns may run at once across every
 * project, and how much memory must be free before another starts. Six turns at once —
 * each starting a dev server and headless Chrome — exhausted 16 GB and reset the Mac;
 * past the cap, a turn waits for a slot instead of piling on.
 *
 * Limits live in ~/.loom/limits.json (`loom limits` sets them) and are re-read every few
 * seconds, so a change applies without a restart. A turn never waits forever: some turns
 * wait on others (a parent on its subtask), so after MAX_WAIT_MS it goes ahead and says so.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loomHome } from "./registry.js";

export interface TurnLimits {
  /** Turns at once across all projects; 0 = no cap. */
  maxTurns: number;
  /** Don't start a turn while less than this % of memory is available; 0 = no memory gate. */
  minFreePct: number;
}

/** One turn per 4 GB (at least 2), and 15% of memory kept free. */
export function defaultLimits(totalBytes = os.totalmem()): TurnLimits {
  return { maxTurns: Math.max(2, Math.floor(totalBytes / 4 / 1024 ** 3)), minFreePct: 15 };
}

export const limitsFile = () => path.join(loomHome(), "limits.json");

export function readLimits(): TurnLimits {
  const base = defaultLimits();
  try {
    const raw = JSON.parse(fs.readFileSync(limitsFile(), "utf8")) as Partial<TurnLimits>;
    return {
      maxTurns: Number.isFinite(raw.maxTurns) && raw.maxTurns! >= 0 ? Math.floor(raw.maxTurns!) : base.maxTurns,
      minFreePct: Number.isFinite(raw.minFreePct) && raw.minFreePct! >= 0 && raw.minFreePct! < 100 ? raw.minFreePct! : base.minFreePct,
    };
  } catch {
    return base;
  }
}

export function writeLimits(patch: Partial<TurnLimits>): TurnLimits {
  const next = { ...readLimits(), ...patch };
  fs.mkdirSync(path.dirname(limitsFile()), { recursive: true });
  fs.writeFileSync(limitsFile(), JSON.stringify(next, null, 2) + "\n");
  return next;
}

/**
 * % of memory available to start something new. On macOS os.freemem() counts only pages
 * nobody has touched (a few % on a busy Mac), so read vm_stat: free + inactive + speculative
 * + purgeable pages are what the kernel hands out without swapping.
 */
export function availableMemoryPct(): number {
  if (process.platform === "darwin") {
    try {
      const out = execFileSync("vm_stat", { encoding: "utf8", timeout: 2000 });
      const size = Number(/page size of (\d+) bytes/.exec(out)?.[1] ?? 16384);
      const pages = (name: string) => Number(new RegExp(`Pages ${name}:\\s+(\\d+)`).exec(out)?.[1] ?? 0);
      const free = (pages("free") + pages("inactive") + pages("speculative") + pages("purgeable")) * size;
      return Math.min(100, (free / os.totalmem()) * 100);
    } catch { /* fall through */ }
  }
  return (os.freemem() / os.totalmem()) * 100;
}

const MAX_WAIT_MS = Number(process.env.LOOM_TURN_GATE_MAX_WAIT_MS) || 10 * 60_000;
const POLL_MS = Number(process.env.LOOM_TURN_GATE_POLL_MS) || 1000;

export interface GateDeps {
  limits(): TurnLimits;
  freePct(): number;
  now(): number;
  sleep(ms: number): Promise<void>;
}

/** A counting gate with a memory check; one per daemon process (turnGate below). */
export class TurnGate {
  private running = new Set<string>();
  private seq = 0;
  private cache: { at: number; limits: TurnLimits } | null = null;

  constructor(private deps: GateDeps = {
    limits: readLimits, freePct: availableMemoryPct, now: Date.now, sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  }) {}

  private limits(): TurnLimits {
    const now = this.deps.now();
    if (!this.cache || now - this.cache.at > 5000) this.cache = { at: now, limits: this.deps.limits() };
    return this.cache.limits;
  }

  /** What's running now (labels), for status. */
  active(): string[] {
    return [...this.running].map((k) => k.slice(k.indexOf(":") + 1));
  }

  /** Why a turn can't start right now, or null when it can. */
  private blocker(): string | null {
    const { maxTurns, minFreePct } = this.limits();
    if (maxTurns > 0 && this.running.size >= maxTurns) return `${this.running.size} turns are running (the cap is ${maxTurns})`;
    if (minFreePct > 0) {
      const free = this.deps.freePct();
      // the first turn always runs: a gate that blocks everything on a full machine is a hang
      if (free < minFreePct && this.running.size > 0) return `only ${Math.round(free)}% of memory is free (Loom keeps ${minFreePct}%)`;
    }
    return null;
  }

  /**
   * Wait for a slot; resolves with release(). `onWait` hears why it's waiting (once, and
   * again if the reason changes), so the thread can say "waiting for a free slot".
   */
  async acquire(label: string, onWait?: (why: string) => void): Promise<() => void> {
    const started = this.deps.now();
    let said: string | null = null;
    for (;;) {
      const why = this.blocker();
      if (!why) break;
      if (this.deps.now() - started > MAX_WAIT_MS) {
        onWait?.(`waited ${Math.round(MAX_WAIT_MS / 60_000)} min for a free slot — starting anyway`);
        break;
      }
      if (why.replace(/\d+%/, "") !== said?.replace(/\d+%/, "")) { said = why; onWait?.(why); }
      await this.deps.sleep(POLL_MS);
    }
    const key = `${++this.seq}:${label}`;
    this.running.add(key);
    let released = false;
    return () => { if (!released) { released = true; this.running.delete(key); } };
  }
}

/** The daemon's gate: every adapter turn passes through it (adapters/index.ts). */
export const turnGate = new TurnGate();
