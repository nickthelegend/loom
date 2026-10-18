import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { AdapterBase } from "../src/adapters/base.js";
import { registerAgentKind } from "../src/adapters/index.js";
import { ProjectRuntime } from "../src/daemon/runtime.js";
import { writeProjectConfig } from "../src/core/registry.js";
import type { CrewConfig, CrewHost } from "../src/core/crew.js";
import type { SendInput } from "../src/types.js";
import { makeProjectDir, tmpDir, waitUntil } from "./helpers.js";

const block = (actions: unknown[]) => "```loom\n" + JSON.stringify({ actions }) + "\n```";
function childRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    // A killed orphan can remain a zombie until the runner's init reaps it.
    if (process.platform === "linux" && /\) Z /.test(fs.readFileSync(`/proc/${pid}/stat`, "utf8"))) return false;
    return true;
  } catch { return false; }
}
let plan: Array<Record<string, unknown>> = [];
let build: (seat: string, dir: string, input: SendInput) => void | Promise<void> = () => {};
let reviewerText = block([{ type: "review", verdict: "approve", notes: "checked" }]);
let testerText = block([{ type: "test", result: "pass", log: "checked" }]);
let entered: Array<{ seat: string; dir: string }> = [], active = 0, peak = 0;
const live = new Set<ParallelBot>();
class ParallelBot extends AdapterBase {
  private cancel?: () => void;
  private interrupted = false;
  async available() { return true; } async start() {}
  async stop() { await this.interrupt(); } async diff() { return ""; }
  async interrupt() { this.interrupted = true; this.cancel?.(); }
  async send(input: SendInput) {
    this._busy = true; this.interrupted = false; live.add(this);
    const seat = this.id.split(".")[0]!.split("-").slice(2).join("-");
    let text: string;
    if (seat === "lead") text = input.text.startsWith("New goal") ? block([{ type: "plan", cards: plan }]) : block([{ type: "done", summary: "complete" }]);
    else if (seat === "reviewer") text = reviewerText;
    else if (seat === "tester") text = testerText;
    else {
      entered.push({ seat, dir: this.projectDir }); active++; peak = Math.max(peak, active);
      try { await Promise.race([Promise.resolve(build(seat, this.projectDir, input)), new Promise<void>(resolve => { this.cancel = resolve; })]); }
      finally { active--; }
      text = block([{ type: "done", summary: seat }]);
    }
    if (!this.interrupted) this.emit({ kind: "message", payload: { text } });
    this.emit({ kind: "run_complete", payload: {} }); this._busy = false; live.delete(this);
  }
}
registerAgentKind("parallelbot", (cfg, dir) => new ParallelBot(cfg.id, "parallelbot", dir));
let rt: ProjectRuntime | undefined;
afterEach(async () => {
  await rt?.close(); rt = undefined; entered = []; active = peak = 0; plan = []; build = () => {};
  reviewerText = block([{ type: "review", verdict: "approve", notes: "checked" }]);
  testerText = block([{ type: "test", result: "pass", log: "checked" }]);
});
async function setup(play: CrewConfig["play"] = "fanout", testCommand?: string) {
  process.env.LOOM_HOME = tmpDir("crew-parallel-home");
  const dir = makeProjectDir();
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir });
  git("init", "-q", "-b", "main"); fs.writeFileSync(path.join(dir, ".gitignore"), ".loom/\n");
  fs.writeFileSync(path.join(dir, "shared.txt"), "seed\n"); git("add", "-A");
  git("-c", "user.name=test", "-c", "user.email=test@test", "commit", "-qm", "seed");
  writeProjectConfig(dir, { name: "parallel crew", brain: { extractor: "off" }, agents: [{ id: "bot", kind: "parallelbot" }] });
  rt = await ProjectRuntime.open({ id: `parallel-${path.basename(dir)}`, name: "parallel crew", dir });
  const crew = rt.crews.create({ name: "Ship", play, maxParallel: 2, planApproval: false, testCommand,
    teammates: ["lead", "a", "b", "reviewer", "tester"].map(id => ({ id, agent: "bot", role: id === "a" || id === "b" ? "builder" : id as "lead" | "reviewer" | "tester" })) });
  return { dir, id: crew.id };
}
async function finished(id: string) {
  await waitUntil(() => !rt!.crews.get(id).busy, { timeoutMs: 60_000 });
  return rt!.crews.get(id).state.goal!;
}
describe("parallel crew plays", () => {
  it("runs disjoint cards concurrently in separate worktrees, then integrates reviewed and tested commits", async () => {
    const { id, dir } = await setup();
    plan = [{ title: "A", assignee: "a", touches: ["a.txt"] }, { title: "B", assignee: "b", touches: ["b.txt"] }];
    let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
    build = async (seat, wd) => { await gate; fs.writeFileSync(path.join(wd, `${seat}.txt`), seat); };
    await rt!.crews.goal(id, "Two changes"); await waitUntil(() => entered.length === 2);
    expect(entered[0]!.dir).not.toBe(entered[1]!.dir); expect(peak).toBe(2); release();
    const goal = await finished(id); expect(goal.status, goal.error).toBe("completed");
    expect(goal.cards.every(c => c.workspace?.integrated)).toBe(true);
    await rt!.crews.apply(id);
    expect(fs.readFileSync(path.join(dir, "a.txt"), "utf8")).toBe("a");
    expect(fs.readFileSync(path.join(dir, "b.txt"), "utf8")).toBe("b");
  });
  it("holds overlapping leases and starts the second builder from the integrated result", async () => {
    const { id } = await setup();
    plan = [{ title: "A", assignee: "a", touches: ["shared.txt"] }, { title: "B", assignee: "b", touches: ["shared.txt"] }];
    build = async (seat, wd) => { await new Promise(r => setTimeout(r, 150)); fs.appendFileSync(path.join(wd, "shared.txt"), `${seat}\n`); };
    await rt!.crews.goal(id, "Overlapping changes"); const goal = await finished(id);
    expect(goal.status, goal.error).toBe("completed"); expect(peak).toBe(1);
    expect(fs.readFileSync(path.join(goal.dir, "shared.txt"), "utf8")).toBe("seed\na\nb\n");
    expect(rt!.log.list({ limit: 1000 }).some(e => e.kind === "crew" && e.payload.phase === "held")).toBe(true);
  });
  it("routes an undeclared integration conflict back to its builder and reviews/tests the repair", async () => {
    const { id } = await setup();
    plan = [{ title: "A", assignee: "a", touches: ["a.txt"] }, { title: "B", assignee: "b", touches: ["b.txt"] }];
    build = (seat, wd, input) => fs.writeFileSync(path.join(wd, "shared.txt"), input.text.startsWith("Back to you") ? "a+b\n" : `${seat}\n`);
    await rt!.crews.goal(id, "Repair conflict"); const goal = await finished(id);
    expect(goal.status, goal.error).toBe("completed");
    // a conflict repair spends its own budget, not the card's review rounds (#308)
    expect(goal.cards[1]!.conflicts).toBe(1); expect(goal.cards[1]!.rounds).toBe(0);
    expect(fs.readFileSync(path.join(goal.dir, "shared.txt"), "utf8")).toBe("a+b\n");
    expect(rt!.log.list({ limit: 1000 }).some(e => e.kind === "crew" && e.payload.phase === "integration_conflict")).toBe(true);
  });
  it("keeps race entrants separate until a human picks one, and applies only that entrant", async () => {
    const { id, dir } = await setup("race");
    build = (seat, wd) => fs.writeFileSync(path.join(wd, "winner.txt"), seat);
    await rt!.crews.goal(id, "Race implementations"); const goal = await finished(id);
    expect(goal.status).toBe("waiting_human"); expect(goal.cards.every(c => c.stage === "ready")).toBe(true);
    expect(fs.existsSync(path.join(goal.dir, "winner.txt"))).toBe(false);
    await rt!.crews.pick(id, "b"); await rt!.crews.apply(id);
    expect(fs.readFileSync(path.join(dir, "winner.txt"), "utf8")).toBe("b");
  });
  it("interrupts every parallel builder and waits for all turns to settle", async () => {
    const { id } = await setup();
    plan = [{ title: "A", assignee: "a", touches: ["a.txt"] }, { title: "B", assignee: "b", touches: ["b.txt"] }];
    build = () => new Promise<void>(() => {});
    await rt!.crews.goal(id, "Stop all"); await waitUntil(() => entered.length === 2);
    await rt!.crews.stop(id); expect(active).toBe(0); expect([...live].some(a => a.busy())).toBe(false);
    expect(rt!.crews.get(id).busy).toBe(false);
  });
  it("refuses to approve an absent review verdict", async () => {
    const { id } = await setup(); plan = [{ title: "A", touches: ["a.txt"] }]; reviewerText = "looks good";
    await rt!.crews.goal(id, "Review required"); const goal = await finished(id);
    expect(goal.status).toBe("failed"); expect(goal.cards[0]!.error).toMatch(/explicit review verdict/);
  });
  it("refuses to mark a missing tester result green", async () => {
    const { id } = await setup(); plan = [{ title: "A", touches: ["a.txt"] }]; testerText = "I think it is fine";
    await rt!.crews.goal(id, "Tests required"); const goal = await finished(id);
    expect(goal.status).toBe("failed"); expect(goal.cards[0]!.error).toMatch(/explicit test result/);
  });
  it("contains a timed-out test command and proves its detached child exited", async () => {
    const helper = path.join(tmpDir("crew-timeout-command"), "command.cjs");
    fs.writeFileSync(helper, `const fs=require('fs'),{spawn}=require('child_process');const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:process.platform==='win32',stdio:'ignore'});fs.writeFileSync('timeout-child.pid',String(child.pid));setInterval(()=>{},1000);`);
    const { id } = await setup("ship", `node "${helper}"`); plan = [{ title: "A" }];
    (rt!.crews as unknown as { host: CrewHost }).host.testTimeoutMs = 5000;
    rt!.config.crews!.find(c => c.id === id)!.maxRounds = 0;
    await rt!.crews.goal(id, "Test timeout"); const goal = await finished(id);
    expect(goal.status).toBe("failed"); expect(goal.recovery).toBeUndefined();
    const pid = Number(fs.readFileSync(path.join(goal.dir, "timeout-child.pid"), "utf8"));
    expect(childRunning(pid)).toBe(false);
    expect(rt!.log.list({ limit: 1000 }).some(e => e.payload.phase === "tested" && String(e.payload.log).includes("timed out"))).toBe(true);
  });
  it("stops configured test commands and their detached descendants before Stop returns", async () => {
    const helper = path.join(tmpDir("crew-test-command"), "command.cjs");
    fs.writeFileSync(helper, `const fs=require('fs'),{spawn}=require('child_process');const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:process.platform==='win32',stdio:'ignore'});fs.writeFileSync('test-child.pid',String(child.pid));setInterval(()=>{},1000);`);
    const { id } = await setup("ship", `node "${helper}"`); plan = [{ title: "A" }];
    await rt!.crews.goal(id, "Stop tests");
    const file = () => path.join(rt!.crews.get(id).state.goal!.dir, "test-child.pid");
    await waitUntil(() => fs.existsSync(file())); const pid = Number(fs.readFileSync(file(), "utf8"));
    await rt!.crews.stop(id); expect(childRunning(pid)).toBe(false);
  });
});
