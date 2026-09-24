/**
 * `loom backup` — everything Loom knows, in one archive.
 *
 * What goes in: ~/.loom (settings, pairings, prompts, cloud and team config)
 * and every registered project's .loom directory (its event log, brain,
 * chats, config). What stays out: orchestra worktrees (full checkouts — their
 * branches live in your repos) and the model cache (re-downloadable).
 *
 * A log.db is copied with VACUUM INTO, which SQLite guarantees is a
 * consistent snapshot even while the daemon is writing to it. Everything
 * else is copied as-is.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { listProjects, loomHome } from "./registry.js";

const SKIP_HOME = new Set(["orchestra", "models"]);

export interface BackupResult {
  file: string;
  bytes: number;
  projects: number;
  skipped: string[];
}

function copyDir(src: string, dest: string, skipped: string[], skip?: (name: string) => boolean): void {
  fs.mkdirSync(dest, { recursive: true });
  for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
    if (skip?.(ent.name)) {
      skipped.push(path.join(src, ent.name));
      continue;
    }
    const s = path.join(src, ent.name), d = path.join(dest, ent.name);
    if (ent.isDirectory()) copyDir(s, d, skipped);
    else if (ent.isFile()) {
      if (ent.name === "log.db") snapshotDb(s, d);
      else if (/^log\.db-(wal|shm)$/.test(ent.name)) continue; // folded in by the snapshot
      else fs.copyFileSync(s, d);
    }
  }
}

function snapshotDb(src: string, dest: string): void {
  try {
    const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
    const db = new DatabaseSync(src, { readOnly: true });
    try {
      db.exec(`VACUUM INTO '${dest.replace(/'/g, "''")}'`);
    } finally {
      db.close();
    }
  } catch {
    fs.copyFileSync(src, dest); // no node:sqlite here: a plain copy beats nothing
  }
}

export function makeBackup(out?: string, now = new Date()): BackupResult {
  const stamp = now.toISOString().replace(/[:T]/g, "-").slice(0, 16);
  const file = path.resolve(out ?? path.join(os.homedir(), `loom-backup-${stamp}.tar.gz`));
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), "loom-backup-"));
  const skipped: string[] = [];
  try {
    const home = loomHome();
    if (fs.existsSync(home)) copyDir(home, path.join(stage, "loom-home"), skipped, (n) => SKIP_HOME.has(n));
    let projects = 0;
    const index: Array<{ id: string; name: string; dir: string }> = [];
    for (const p of listProjects()) {
      const dotLoom = path.join(p.dir, ".loom");
      if (!fs.existsSync(dotLoom)) continue;
      const slot = `${p.name.replace(/[^\w.-]+/g, "-")}-${p.id}`;
      copyDir(dotLoom, path.join(stage, "projects", slot, ".loom"), skipped, (n) => n === "worktrees");
      index.push({ id: p.id, name: p.name, dir: p.dir });
      projects++;
    }
    fs.writeFileSync(
      path.join(stage, "BACKUP.json"),
      JSON.stringify({ format: "loom-backup", version: 1, at: now.toISOString(), projects: index }, null, 2),
    );
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tar = spawnSync("tar", ["-czf", file, "-C", stage, "."], { encoding: "utf8" });
    if (tar.status !== 0) throw new Error(`tar failed: ${(tar.stderr || tar.error?.message || "").trim()}`);
    return { file, bytes: fs.statSync(file).size, projects, skipped };
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
}
