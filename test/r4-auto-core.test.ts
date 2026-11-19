import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { conditionReason, renderAutomation, schedulePreview } from "../src/core/auto-r4/model.js";
import { automationHold, parseQuiet } from "../src/core/auto-r4/state.js";
import { fileSnapshot, FileChanges, publicAddress, readWatchUrl } from "../src/core/auto-r4/watch.js";
import { automationTrigger } from "../src/core/auto-r4/validation.js";
import { automationEvents } from "../src/core/auto-r4/events.js";
import { triggerInput } from "../src/cli/r4-auto.js";
import { readTriggers, writeTriggers } from "../src/core/triggers.js";
import { tmpDir } from "./helpers.js";

describe("automation models", () => {
  it("previews exactly five weekday occurrences in local time and refuses ambiguous schedules", () => {
    const p = schedulePreview("every weekday at 9am", new Date(2026, 10, 20, 10));
    expect(p.cron).toBe("0 9 * * 1-5"); expect(p.next).toHaveLength(5);
    expect(p.next.map(t => new Date(t).getDay())).toEqual([1, 2, 3, 4, 5]);
    expect(p.next.every(t => new Date(t).getHours() === 9)).toBe(true);
    expect(schedulePreview("every day at 12am").cron).toBe("0 0 * * *");
    expect(schedulePreview("every saturday at 12:30pm").cron).toBe("30 12 * * 6");
    expect(() => schedulePreview("tomorrow sometime")).toThrow();
    expect(() => schedulePreview("every day at 25:00")).toThrow();
  });
  it("holds overnight hours on the starting weekday, and resumes timed pauses", () => {
    const control = { quiet: parseQuiet("22:00-07:00", "mon-fri") };
    expect(automationHold(new Date(2026, 10, 21, 6), control)).toBe("automation quiet hours");
    expect(automationHold(new Date(2026, 10, 21, 22), control)).toBeNull();
    expect(automationHold(new Date(2026, 10, 23, 6), control)).toBeNull();
    expect(automationHold(new Date(2026, 10, 23, 22), control)).toBeTruthy();
    expect(automationHold(new Date(1000), { paused: true, resumeAt: 1000 })).toBeNull();
    expect(() => parseQuiet("24:00-07:00")).toThrow();
    expect(() => parseQuiet("22:00-07:00", "monday")).toThrow();
  });
  it("debounces creates, edits and deletes and excludes nested worktrees and machine state", () => {
    const dir = tmpDir("a4-files");
    for (const folder of ["docs", ".git", ".loom", "worktrees", "nested/.git"]) fs.mkdirSync(path.join(dir, folder), { recursive: true });
    const watcher = new FileChanges();
    expect(watcher.poll("t", dir, "**", 1000)).toEqual([]);
    for (const file of ["docs/a.md", ".git/config", ".loom/state", "worktrees/x", "nested/file"]) fs.writeFileSync(path.join(dir, file), "one");
    expect(watcher.poll("t", dir, "**", 1100)).toEqual([]);
    fs.writeFileSync(path.join(dir, "docs/a.md"), "two");
    expect(watcher.poll("t", dir, "**", 1500)).toEqual([]);
    expect(watcher.poll("t", dir, "**", 16500)).toEqual(["docs/a.md"]);
    fs.unlinkSync(path.join(dir, "docs/a.md")); watcher.poll("t", dir, "**", 16600);
    expect(watcher.poll("t", dir, "**", 31600)).toEqual(["docs/a.md"]);
  });
  it("evaluates actual git, file, clock and command conditions", async () => {
    const dir = tmpDir("a4-condition"); execFileSync("git", ["init", "-q"], { cwd: dir });
    expect(await conditionReason(dir, "clean")).toBeNull();
    fs.writeFileSync(path.join(dir, "a.md"), "x");
    expect(await conditionReason(dir, "clean")).toMatch(/did not qualify/);
    expect(await conditionReason(dir, "dirty")).toBeNull();
    expect(await conditionReason(dir, "file:*.md")).toBeNull();
    expect(await conditionReason(dir, "file:*.ts")).toMatch(/skipped/);
    expect(await conditionReason(dir, "hours:9-18", new Date(2026, 1, 1, 9))).toBeNull();
    expect(await conditionReason(dir, "hours:9-18", new Date(2026, 1, 1, 18))).toMatch(/skipped/);
    expect(await conditionReason(dir, 'cmd:"exit 0"')).toBeNull();
    expect(await conditionReason(dir, "cmd:exit 1")).toMatch(/skipped/);
  });
  it("refuses private URL watches including mapped IPv6 and credentials", async () => {
    for (const url of ["http://127.0.0.1", "http://[::1]", "http://[::ffff:127.0.0.1]", "http://10.1.1.1", "http://localhost", "https://user:pass@example.com", "file:///etc/passwd"]) await expect(readWatchUrl(url)).rejects.toThrow();
    expect(publicAddress("100.64.0.1")).toBe(false); expect(publicAddress("8.8.8.8")).toBe(true);
  });
  it("preserves 2.1 data and renders automation values literally", () => {
    const dir = tmpDir("a4-old"), trigger = { id: "old", name: "old", prompt: "hello", kind: "schedule" as const, enabled: true, createdAt: 1, everyMin: 60 };
    writeTriggers(dir, { triggers: [trigger], runs: [] }); expect(readTriggers(dir).triggers).toEqual([trigger]);
    expect(renderAutomation("{{files}} {{event.reason}} {{old}} → {{new}} {{range}}", { files: ["docs/a"], event: { reason: "$&" }, old: "a", new: "b", range: "abc..def" })).toBe('["docs/a"] $& a → b abc..def');
    expect(automationTrigger({ on: "turn_failed", prompt: "fix" })).toMatchObject({ kind: "event", enabled: true });
    expect(() => automationTrigger({ on: "arbitrary", prompt: "fix" })).toThrow();
    expect(() => automationTrigger({ every: "1h", prompt: "x", recipe: "r", orchestrate: true })).toThrow();
    expect(triggerInput(undefined, { recipe: "daily", when: "every day at 9am" })).toMatchObject({ recipe: "daily", kind: "schedule" });
    expect(triggerInput("watch", { watchUrl: "https://example.com", every: "15m", select: "a.b" })).toMatchObject({ kind: "url", every: "15m", select: "a.b" });
    expect(() => triggerInput("x", { on: "turn_failed", every: "2h" })).toThrow();
  });
  it("maps each existing event vocabulary", () => {
    const event = (kind: any, payload: Record<string, unknown>, agentId?: string) => automationEvents({ id: 1, ts: 1, kind, payload, agentId });
    expect(event("run_complete", {})).toEqual(["turn_finished"]);
    expect(event("error", { message: "bad" }, "echo")).toEqual(["turn_failed"]);
    expect(event("approval", { phase: "decided", behavior: "deny", message: "No answer within 10 minutes — denied." })).toEqual(["approval_expired"]);
    expect(event("orchestra", { phase: "completed" })).toEqual(["run_completed"]);
    expect(event("orchestra", { phase: "landing", landing: { state: "merged", checks: { failing: ["test"] } } })).toEqual(["pr_merged", "ci_failed"]);
  });
});

it("requires existing CLI handler changes to be ported to the automation override", () => {
  const source = fs.readFileSync("src/cli/index.ts", "utf8");
  for (const [start, end, digest] of [
    ['.command("triggers")', '.command("triggers:calendar")', "840b11c0028f85ee5d74c9edf334c5170f77daa606fbe4f1033f6c974d6c2cd5"],
    ['.command("triggers:add <prompt>")', '.command("triggers:rm <id>")', "3fc695fae72772af6a312e50ef2cb7dacd4043e322e6eff5e857a1226c9db3af"],
  ]) {
    const from = source.indexOf(start!), to = source.indexOf(end!, from);
    expect(from).toBeGreaterThanOrEqual(0); expect(to).toBeGreaterThan(from);
    expect(createHash("sha256").update(source.slice(from, to)).digest("hex"),
      "Port changes to the existing triggers/triggers:add handlers into src/cli/r4-auto.ts, then update this guard.").toBe(digest);
  }
});

it("walks only the literal glob directory, while respecting exclusions and missing paths", () => {
  const dir = tmpDir("a4-prefix");
  for (const folder of ["docs/sub", "unrelated", "nested/.git", ".loom"]) fs.mkdirSync(path.join(dir, folder), { recursive: true });
  fs.writeFileSync(path.join(dir, "docs/sub/a.md"), "a");
  fs.symlinkSync(path.join(dir, "docs"), path.join(dir, "linked"));
  const reads = vi.spyOn(fs, "readdirSync");
  try {
    expect([...fileSnapshot(dir, "docs/**/*.md").keys()]).toEqual(["docs/sub/a.md"]);
    expect(reads.mock.calls.map(call => String(call[0]))).toEqual([path.join(dir, "docs"), path.join(dir, "docs/sub")]);
    for (const glob of ["missing/**", "linked/**", "nested/**", ".loom/**"]) expect(fileSnapshot(dir, glob).size).toBe(0);
    expect([...fileSnapshot(dir, "docs/sub/a.md").keys()]).toEqual(["docs/sub/a.md"]);
  } finally { reads.mockRestore(); }
});
