/**
 * What the agents are costing this machine right now: every process the daemon started (and
 * theirs), grouped by the agent command at the top of each tree, with memory and CPU — beside
 * how much memory is free and the turn cap. A Mac that ran out of memory under a pile of agent
 * CLIs is what this is for. Approach credit: Nuphos ("runtime resource usage").
 *
 * macOS and Linux read `ps`; elsewhere the process list is empty and says why.
 */

import os from "node:os";
import { promisify } from "node:util";
import { execFile as execFileCb } from "./process.js";
import { availableMemoryPct, readLimits } from "./turn-gate.js";

export interface ProcRow { pid: number; ppid: number; rssKb: number; cpu: number; command: string }

export interface ProcessGroup {
  /** The daemon's direct child: an agent CLI, an MCP server, a dev server, a terminal. */
  pid: number;
  name: string;
  command: string;
  /** It and everything it started. */
  processes: number;
  rssMb: number;
  cpu: number;
}

/** Parse `ps -A -o pid=,ppid=,rss=,%cpu=,command=`. */
export function parsePs(out: string): ProcRow[] {
  const rows: ProcRow[] = [];
  for (const line of out.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+([\d.]+)\s+(.*)$/.exec(line);
    if (m) rows.push({ pid: Number(m[1]), ppid: Number(m[2]), rssKb: Number(m[3]), cpu: Number(m[4]), command: m[5]!.trim() });
  }
  return rows;
}

/** A short name for a command line: the program, or the script a runtime runs. */
export function procName(command: string): string {
  const words = command.split(/\s+/);
  const base = (w: string) => w.split(/[\\/]/).pop() ?? w;
  const first = base(words[0] ?? "");
  // node / bun / python running something: name the something
  if (/^(node|bun|deno|python3?|npx|tsx)$/.test(first)) {
    const script = words.slice(1).find((w) => !w.startsWith("-"));
    if (script) {
      const pkg = /node_modules\/((?:@[^/]+\/)?[^/]+)/.exec(script)?.[1];
      // npx @scope/name — a package name, not a path
      return pkg ?? (/^@[^/]+\/[^/]+$/.test(script) ? script : base(script));
    }
  }
  return first || command.slice(0, 40);
}

/** The daemon's process tree as one group per direct child, heaviest first. */
export function groupTree(rows: ProcRow[], root: number): ProcessGroup[] {
  const kids = new Map<number, ProcRow[]>();
  for (const r of rows) kids.set(r.ppid, [...(kids.get(r.ppid) ?? []), r]);
  const groups: ProcessGroup[] = [];
  for (const top of kids.get(root) ?? []) {
    let rss = 0, cpu = 0, n = 0;
    const stack = [top];
    const seen = new Set<number>();
    while (stack.length) {
      const p = stack.pop()!;
      if (seen.has(p.pid)) continue;
      seen.add(p.pid);
      rss += p.rssKb; cpu += p.cpu; n++;
      stack.push(...(kids.get(p.pid) ?? []));
    }
    if (top.command.startsWith("ps ")) continue; // our own look
    groups.push({ pid: top.pid, name: procName(top.command), command: top.command.slice(0, 200), processes: n, rssMb: Math.round(rss / 1024), cpu: Math.round(cpu * 10) / 10 });
  }
  return groups.sort((a, b) => b.rssMb - a.rssMb);
}

export interface Resources {
  machine: { totalGb: number; freePct: number; cpus: number; load1: number };
  limits: { maxTurns: number; minFreePct: number };
  daemon: { pid: number; rssMb: number };
  groups: ProcessGroup[];
  note?: string;
}

export async function resources(root = process.pid): Promise<Resources> {
  const base: Resources = {
    machine: { totalGb: Math.round((os.totalmem() / 2 ** 30) * 10) / 10, freePct: Math.round(availableMemoryPct()), cpus: os.cpus().length, load1: Math.round(os.loadavg()[0]! * 100) / 100 },
    limits: readLimits(),
    daemon: { pid: root, rssMb: Math.round(process.memoryUsage().rss / 2 ** 20) },
    groups: [],
  };
  if (process.platform === "win32") return { ...base, note: "per-process figures need ps (macOS, Linux)" };
  try {
    const { stdout } = await promisify(execFileCb)("ps", ["-A", "-o", "pid=,ppid=,rss=,%cpu=,command="], { maxBuffer: 16 * 1024 * 1024, timeout: 5000 });
    return { ...base, groups: groupTree(parsePs(String(stdout)), root) };
  } catch (e) {
    return { ...base, note: `couldn't read the process list: ${(e as Error).message}` };
  }
}
