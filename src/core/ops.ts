import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { loomHome, readProjectConfig } from "./registry.js";
import type { ProjectInfo } from "../types.js";
import { orchestraWorktreeRoot } from "./orchestra.js";

export const LOG_MAX_BYTES = 5 * 1024 * 1024;

/** Keep the inode: a detached daemon still holds its stdout/stderr descriptors. */
export function rotateDaemonLog(file = path.join(loomHome(), "daemon.log"), cap = LOG_MAX_BYTES): boolean {
  if (!fs.existsSync(file) || fs.lstatSync(file).isSymbolicLink() || fs.statSync(file).size < cap) return false;
  const fd = fs.openSync(file, "r+");
  try {
    const size = fs.fstatSync(fd).size;
    const tail = Buffer.alloc(Math.min(cap, size));
    fs.readSync(fd, tail, 0, tail.length, size - tail.length);
    const tmp = `${file}.${randomUUID()}.tmp`;
    fs.writeFileSync(tmp, tail, { mode: 0o600 });
    fs.renameSync(tmp, `${file}.1`);
    fs.ftruncateSync(fd, 0);
    return true;
  } finally { fs.closeSync(fd); }
}

/** Logical bytes, without following links into another project or disk. */
export function diskBytes(file: string, skipped: string[] = []): number {
  try {
    const st = fs.lstatSync(file);
    if (st.isSymbolicLink()) return 0;
    if (st.isFile()) return st.size;
    if (!st.isDirectory()) return 0;
    return fs.readdirSync(file).reduce((n, name) => n + diskBytes(path.join(file, name), skipped), 0);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") skipped.push(file);
    return 0;
  }
}

export function projectDiskUsage(project: ProjectInfo) {
  const base = path.join(project.dir, ".loom");
  const config = readProjectConfig(project.dir);
  const skipped: string[] = [];
  const roots = [orchestraWorktreeRoot(project.dir, project.id, config?.orchestra?.worktreeDir),
    ...["orchestra", "crews", "proof"].map(name => path.join(loomHome(), name, project.id)), path.join(base, "worktrees")];
  const unique = roots.filter((root, i) => !roots.some((other, j) => j !== i && (root.startsWith(other + path.sep) || (root === other && j < i))));
  const worktrees = unique.reduce((n, root) => n + diskBytes(root, skipped), 0);
  const logs = ["log.db", "log.db-wal", "log.db-shm", "log.jsonl", "logs"].reduce((n, name) => n + diskBytes(path.join(base, name), skipped), 0);
  const attachments = diskBytes(path.join(base, "attachments"), skipped);
  return { project: project.id, name: project.name, worktrees, logs, attachments, total: worktrees + logs + attachments, skipped };
}

export interface PrunePolicy { days: number; keep: number }
export function prunePolicy(input: unknown): PrunePolicy {
  const b = input as Partial<PrunePolicy> | undefined;
  if (!b || !Number.isFinite(b.days) || b.days! < 0 || b.days! > 36500 || !Number.isInteger(b.keep) || b.keep! < 0 || b.keep! > 10000) {
    throw new Error("days must be 0–36500 and keep must be an integer 0–10000");
  }
  return { days: b.days!, keep: b.keep! };
}
