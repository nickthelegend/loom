import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";
import { BackupScheduler, backupInterval } from "../src/core/backup-schedule.js";
import { diskBytes, projectDiskUsage, rotateDaemonLog } from "../src/core/ops.js";
import { registerProject, readProjectConfig, writeProjectConfig, readProjectState, writeProjectState } from "../src/core/registry.js";
import { EventLog } from "../src/core/eventlog.js";
import { fixProject, doctorReport, projectChecks } from "../src/cli/doctor.js";
import { changelogBetween, releaseChangelog } from "../src/core/updater.js";
import { makeProjectDir, tmpDir } from "./helpers.js";

beforeEach(() => { process.env.LOOM_HOME = tmpDir("r3-core-home"); });

describe("R3 safe doctor repairs", () => {
  it("repairs unambiguous findings, reports ambiguous ones, and is idempotent", () => {
    const dir = makeProjectDir({ agents: [{ id: "a", kind: "echo", role: "" }, { id: "a", kind: "echo", role: "worker" }], defaultAgent: "missing" });
    writeProjectState(dir, { ...readProjectState(dir), holder: "missing" });
    const result = fixProject(dir);
    expect(result.fixed).toHaveLength(4);
    expect(result.unfixable).toEqual([expect.stringContaining("duplicate")]);
    expect(readProjectConfig(dir)?.defaultAgent).toBeUndefined();
    expect(readProjectState(dir).holder).toBeNull();
    expect(readProjectConfig(dir)?.agents[0]?.role).toBe("echo");
    expect(fixProject(dir).fixed).toEqual([]);
    const report = doctorReport(projectChecks(dir));
    expect(report.summary.failures).toBeGreaterThan(0);
    expect(JSON.parse(JSON.stringify({ ...report, fixes: result })).fixes).toEqual(result);
  });
});

describe("R3 daemon logs", () => {
  it("caps the retained generation and preserves a running writer's descriptor", () => {
    const file = path.join(process.env.LOOM_HOME!, "daemon.log");
    const fd = fs.openSync(file, "a");
    try {
      fs.writeSync(fd, "a".repeat(150));
      expect(rotateDaemonLog(file, 100)).toBe(true);
      expect(fs.statSync(file).size).toBe(0);
      expect(fs.readFileSync(file + ".1", "utf8")).toBe("a".repeat(100));
      fs.writeSync(fd, "b".repeat(100));
      expect(rotateDaemonLog(file, 100)).toBe(true);
      fs.writeSync(fd, "still writing");
      expect(fs.readFileSync(file, "utf8")).toBe("still writing");
      expect(fs.readFileSync(file + ".1", "utf8")).toBe("b".repeat(100));
      expect(rotateDaemonLog(file, 100)).toBe(false);
    } finally { fs.closeSync(fd); }
  });
});

describe("R3 scheduled backups", () => {
  it("validates intervals and retention without writing invalid settings", () => {
    const scheduler = new BackupScheduler();
    expect(backupInterval("1d")).toBe(86_400_000);
    for (const every of ["", "0d", "-1d", "1.5h", "366d", "Infinityh"]) expect(() => scheduler.configure(every, 7)).toThrow();
    for (const keep of [0, -1, 1.2, 366, NaN]) expect(() => scheduler.configure("1d", keep)).toThrow();
    expect(scheduler.read()).toBeNull();
  });

  it("survives restart, snapshots live SQLite, excludes archives, retains only successes", async () => {
    const dir = makeProjectDir();
    const info = registerProject(dir, "backed-up");
    const log = await EventLog.open(path.join(dir, ".loom"));
    log.append({ kind: "message", payload: { text: "durable" } });
    const scheduler = new BackupScheduler();
    const now = 1_800_000_000_000;
    scheduler.configure("1m", 2, now);
    expect((await scheduler.tick(now))?.lastAt).toBeUndefined();
    const restarted = new BackupScheduler();
    const first = (await restarted.tick(now + 60_000))!;
    expect(fs.existsSync(first.lastFile!)).toBe(true);
    const contents = execFileSync("tar", ["-tzf", first.lastFile!], { encoding: "utf8" });
    expect(contents).toContain("BACKUP.json");
    expect(contents).not.toContain("loom-home/backups");
    const extract = tmpDir("r3-backup-extract");
    execFileSync("tar", ["-xzf", first.lastFile!, "-C", extract]);
    const snapshot = await EventLog.open(path.join(extract, "projects", `backed-up-${info.id}`, ".loom"));
    expect(snapshot.list().some(e => e.payload.text === "durable")).toBe(true);
    snapshot.close(); log.close();
    await restarted.tick(now + 120_000);
    const third = (await restarted.tick(now + 600_000))!;
    expect(fs.existsSync(first.lastFile!)).toBe(false);
    expect(fs.readdirSync(path.dirname(third.lastFile!)).filter(n => n.endsWith(".tar.gz"))).toHaveLength(2);
    if (process.platform !== "win32") expect(fs.statSync(third.lastFile!).mode & 0o777).toBe(0o600);
    const oldPath = process.env.PATH;
    try {
      process.env.PATH = "/nonexistent";
      expect((await restarted.tick(now + 660_000))?.error).toContain("tar failed");
    } finally { process.env.PATH = oldPath; }
    expect(fs.readdirSync(path.dirname(third.lastFile!))).toHaveLength(2);
    expect(restarted.read()?.lastAt).toBe(now + 600_000);
    fs.writeFileSync(path.join(dir, ".loom", "log.db"), "not a database");
    expect((await restarted.tick(now + 720_000))?.error).toBeTruthy();
    expect(fs.readdirSync(path.dirname(third.lastFile!))).toHaveLength(2);
    restarted.disable();
    expect(await restarted.tick(now + 780_000)).toBeNull();
  });
});

describe("R3 asynchronous scheduling", () => {
  it("does not overlap runs or overwrite a schedule changed while copying", async () => {
    const scheduler = new BackupScheduler();
    const now = Date.now();
    scheduler.configure("1m", 2, now - 60_000);
    const copying = scheduler.tick(now);
    expect(scheduler.tick(now)).toBe(copying);
    const replacement = scheduler.configure("2d", 4, now);
    await copying;
    expect(scheduler.read()).toEqual(replacement);
    expect(fs.readdirSync(path.join(process.env.LOOM_HOME!, "backups"))).toEqual([]);
    await scheduler.close();
  });
  it("a disabled schedule stays disabled after an in-flight copy finishes", async () => {
    const scheduler = new BackupScheduler();
    scheduler.configure("1m", 2, Date.now() - 60_000);
    const copying = scheduler.tick();
    scheduler.disable();
    expect(await copying).toBeNull();
    expect(scheduler.read()).toBeNull();
    expect(fs.readdirSync(path.join(process.env.LOOM_HOME!, "backups"))).toEqual([]);
  });
});

describe("R3 disk usage", () => {
  it("counts the configured worktree root, log files and attachments without following links", () => {
    const dir = makeProjectDir();
    const info = registerProject(dir, "usage");
    const config = readProjectConfig(dir)!;
    config.orchestra = { worktreeDir: "custom-trees" };
    writeProjectConfig(dir, config);
    const roots = [[path.join(dir, "custom-trees", info.id), 101], [path.join(dir, ".loom", "attachments"), 203], [path.join(dir, ".loom", "logs"), 307]] as const;
    for (const [root, size] of roots) { fs.mkdirSync(root, { recursive: true }); fs.writeFileSync(path.join(root, "data"), Buffer.alloc(size)); }
    fs.writeFileSync(path.join(dir, ".loom", "log.jsonl"), "hello");
    fs.symlinkSync(roots[0][0], path.join(roots[1][0], "link"), "dir");
    expect(projectDiskUsage(info)).toMatchObject({ worktrees: 101, attachments: 203, logs: 312, total: 616, skipped: [] });
    expect(diskBytes(path.join(dir, "missing"))).toBe(0);
    for (const name of ["orchestra", "crews", "proof"]) {
      const root = path.join(process.env.LOOM_HOME!, name, info.id);
      fs.mkdirSync(root, { recursive: true }); fs.writeFileSync(path.join(root, "data"), "123");
    }
    expect(projectDiskUsage(info).worktrees).toBe(110);
  });
});

describe("R3 crash bundle", () => {
  it("writes a private redacted bundle from a real uncaught exception", () => {
    const home = process.env.LOOM_HOME!;
    const guards = pathToFileURL(path.resolve("src/daemon/guards.ts")).href;
    execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", `
      import { installCrashGuards } from ${JSON.stringify(guards)};
      installCrashGuards();
      setTimeout(() => { throw new Error('token=secret-value Bearer auth-value ' + process.env.R3_API_KEY); }, 5);
      setTimeout(() => process.exit(0), 100);
    `], { env: { ...process.env, LOOM_HOME: home, R3_API_KEY: "private-provider-value" }, stdio: "pipe" });
    const files = fs.readdirSync(path.join(home, "crashes"));
    expect(files).toHaveLength(1);
    const file = path.join(home, "crashes", files[0]!);
    const text = fs.readFileSync(file, "utf8");
    expect(JSON.parse(text)).toMatchObject({ format: "loom-crash", kind: "uncaught exception" });
    expect(text).toContain("[REDACTED]");
    for (const secret of ["secret-value", "auth-value", "private-provider-value"]) expect(text).not.toContain(secret);
    if (process.platform !== "win32") expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });
});

describe("R3 update changelog", () => {
  const markdown = "## [Unreleased]\nfuture\n## [2.3.0] - date\nnewest\n## [2.2.0]\nmiddle\n## [2.1.0]\ninstalled\n";
  it("includes all intervening versions, excluding installed and unreleased", () => {
    expect(changelogBetween(markdown, "2.1.0", "2.3.0")).toEqual([{ version: "2.3.0", notes: "newest" }, { version: "2.2.0", notes: "middle" }]);
    expect(changelogBetween(markdown, "2.3.0", "2.3.0")).toEqual([]);
  });
  it("reads the tagged changelog and reports network failure without claiming empty notes", async () => {
    const release = { version: "2.3.0", tag: "v2.3.0", url: "https://example.com", publishedAt: null };
    const response = (async (url: string) => { expect(url).toContain("/v2.3.0/CHANGELOG.md"); return new Response(markdown); }) as typeof fetch;
    expect((await releaseChangelog("2.1.0", release, response)).entries).toHaveLength(2);
    expect(await releaseChangelog("2.1.0", release, (async () => new Response("", { status: 503 })) as typeof fetch)).toEqual({ available: false, entries: [] });
  });
});
