import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Worker } from "node:worker_threads";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { loomHome } from "./registry.js";

export interface BackupSchedule {
  revision: string;
  runningAt?: number;
  every: string;
  keep: number;
  nextAt: number;
  lastAt?: number;
  lastFile?: string;
  error?: string;
}

export function backupInterval(every: string): number {
  const m = /^(\d+)(m|h|d)$/.exec(every);
  const ms = m ? Number(m[1]) * ({ m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2]!] ?? 0) : 0;
  if (!Number.isSafeInteger(ms) || ms < 60_000 || ms > 365 * 86_400_000) throw new Error("every must be 1m–365d (for example 1d)");
  return ms;
}

export class BackupScheduler {
  private timer?: NodeJS.Timeout;
  private running?: Promise<BackupSchedule | null>;
  private readonly file: string;
  constructor(private readonly home = loomHome()) { this.file = path.join(home, "backup-schedule.json"); }

  read(): BackupSchedule | null {
    try { return JSON.parse(fs.readFileSync(this.file, "utf8")) as BackupSchedule; }
    catch (err) { if ((err as NodeJS.ErrnoException).code === "ENOENT") return null; throw err; }
  }

  private write(schedule: BackupSchedule): void {
    fs.mkdirSync(this.home, { recursive: true });
    fs.writeFileSync(this.file + ".tmp", JSON.stringify(schedule, null, 2), { mode: 0o600 });
    fs.renameSync(this.file + ".tmp", this.file);
  }

  configure(every: string, keep: number, now = Date.now()): BackupSchedule {
    const ms = backupInterval(every);
    if (!Number.isInteger(keep) || keep < 1 || keep > 365) throw new Error("keep must be an integer 1–365");
    const schedule = { revision: randomUUID(), every, keep, nextAt: now + ms };
    this.write(schedule);
    return schedule;
  }

  disable(): void { fs.rmSync(this.file, { force: true }); }

  /** Missed intervals produce one current snapshot, never a burst of old backups. */
  tick(now = Date.now()): Promise<BackupSchedule | null> {
    if (this.running) return this.running;
    this.running = this.run(now).finally(() => { this.running = undefined; });
    return this.running;
  }

  private async run(now: number): Promise<BackupSchedule | null> {
    const schedule = this.read();
    if (!schedule || (!schedule.runningAt && schedule.nextAt > now)) return schedule;
    const ms = backupInterval(schedule.every);
    if (!Number.isInteger(schedule.keep) || schedule.keep < 1 || schedule.keep > 365) throw new Error("invalid backup retention");
    schedule.nextAt = now + ms;
    schedule.runningAt = now;
    this.write(schedule);
    const dir = path.join(this.home, "backups");
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    // An interrupted worker leaves only a private partial file; it is never a backup.
    for (const name of fs.readdirSync(dir)) if (/^scheduled-\d+-[\w-]+\.tar\.gz\.partial$/.test(name)) fs.rmSync(path.join(dir, name), { force: true });
    const name = `scheduled-${now}-${randomUUID()}.tar.gz`;
    const file = path.join(dir, name);
    const partial = file + ".partial";
    try {
      await archiveInWorker(partial, now, this.home);
      if (this.read()?.revision !== schedule.revision) {
        fs.rmSync(partial, { force: true });
        return this.read();
      }
      fs.chmodSync(partial, 0o600);
      fs.renameSync(partial, file);
      schedule.lastAt = now;
      schedule.lastFile = file;
      delete schedule.error;
      const files = fs.readdirSync(dir).filter(n => /^scheduled-\d+-[\w-]+\.tar\.gz$/.test(n)).sort().reverse();
      for (const old of files.slice(schedule.keep)) fs.unlinkSync(path.join(dir, old));
    } catch (err) {
      schedule.error = err instanceof Error ? err.message : String(err);
      fs.rmSync(partial, { force: true });
    }
    delete schedule.runningAt;
    if (this.read()?.revision === schedule.revision) this.write(schedule);
    return this.read();
  }

  start(onError: (err: unknown) => void): void {
    const tick = () => { void this.tick().catch(onError); };
    tick();
    this.timer = setInterval(tick, 60_000);
    this.timer.unref();
  }
  async close(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    await this.running?.catch(() => {});
  }
}

/** Copying large trees and SQLite snapshots must not stop the daemon serving requests. */
function archiveInWorker(file: string, now: number, home: string): Promise<void> {
  const compiled = new URL("./backup.js", import.meta.url);
  const source = !fs.existsSync(compiled);
  const module = source ? new URL("./backup.ts", import.meta.url).href : compiled.href;
  // Source runs use the same development loader as the CLI; packaged builds need only Node.
  const loader = source ? pathToFileURL(createRequire(import.meta.url).resolve("tsx/esm/api")).href : null;
  const code = `import { parentPort, workerData } from "node:worker_threads";
    if (workerData.loader) { const { register } = await import(workerData.loader); register(); }
    const { makeBackup } = await import(workerData.module);
    makeBackup(workerData.file, new Date(workerData.now));
    parentPort.postMessage(true);`;
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL(`data:text/javascript,${encodeURIComponent(code)}`), {
      workerData: { file, now, module, loader }, env: { ...process.env, LOOM_HOME: home },
    });
    let finished = false;
    worker.once("message", () => { finished = true; });
    worker.once("error", reject);
    worker.once("exit", code => finished && code === 0 ? resolve() : reject(new Error(`backup worker exited (${code})`)));
  });
}
