/**
 * The 1.2.0 stress test — six projects at once (#282–#297) — pinned down.
 */

import path from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { parseCrewReply } from "../src/core/crew-protocol.js";
import { seatCrew, teammatesFromTemplate } from "../src/core/crew.js";
import { digest } from "../src/core/digest.js";
import { orchestraWorktreeRoot } from "../src/core/orchestra.js";
import { writeProjectConfig } from "../src/core/registry.js";
import { outcomeOf } from "../src/core/shift.js";
import { ProjectRuntime } from "../src/daemon/runtime.js";
import type { AgentConfig, LoomEvent } from "../src/types.js";
import { tmpDir } from "./helpers.js";

let n = 0;
const ev = (kind: string, payload: Record<string, unknown> = {}, agentId?: string, ts = Date.now()): LoomEvent =>
  ({ id: ++n, ts, kind, ...(agentId ? { agentId } : {}), payload } as LoomEvent);

describe("#282 crew: a reviewer's verdict however it's spelled", () => {
  it("changes_requested (GitHub's word) in a loom block sends the card back", () => {
    const reply = 'Notes below.\n```loom\n{"actions":[{"type":"review","verdict":"changes_requested","notes":"blackbox/sim.py:192 — crush.excess_grip_force is never reset"}]}\n```';
    expect(parseCrewReply(reply, "reviewer").allowed).toEqual([{ type: "review", verdict: "changes", notes: "blackbox/sim.py:192 — crush.excess_grip_force is never reset" }]);
    for (const v of ["needs-changes", "Request Changes", "revise"]) expect(parseCrewReply(`\`\`\`loom\n{"actions":[{"type":"review","verdict":"${v}","notes":"x"}]}\n\`\`\``, "reviewer").allowed[0]).toMatchObject({ verdict: "changes" });
    expect(parseCrewReply('```loom\n{"actions":[{"type":"review","verdict":"Approved","notes":"x"}]}\n```', "reviewer").allowed[0]).toMatchObject({ verdict: "approve" });
  });
});

describe("#283 crew seats follow the project's roles", () => {
  const roster = [
    { id: "codex", kind: "codex", role: "reviewer" }, { id: "opencode", kind: "opencode", role: "reviewer" },
    { id: "claude-code", kind: "claude-code", role: "planner-executor" }, { id: "claude-2", kind: "claude-code", role: "executor" },
  ] as AgentConfig[];
  it("writers build and lead; reviewers review", () => {
    const seats = Object.fromEntries(teammatesFromTemplate("ship", roster).map((t) => [t.id, t.agent]));
    expect([seats.lead, seats["builder-1"], seats["builder-2"]].every((a) => a === "claude-code" || a === "claude-2")).toBe(true);
    expect(["codex", "opencode"]).toContain(seats.reviewer);
    expect(["codex", "opencode"]).toContain(seats.tester);
  });
  it("no roles: the same seats as before", () => {
    const plain = [{ id: "cx", kind: "codex" }, { id: "oc", kind: "opencode" }, { id: "cc", kind: "claude-code" }] as AgentConfig[];
    expect(teammatesFromTemplate("ship", plain).map((t) => t.agent)).toEqual(["cc", "cx", "oc", "cc", "oc"]);
  });
  it("--builders / --reviewer seat who you name", () => {
    const t = seatCrew(teammatesFromTemplate("ship", roster), { builders: ["claude-code", "claude-2"], reviewer: "codex", lead: "claude-code" });
    expect(t.map((x) => [x.id, x.agent])).toEqual([["lead", "claude-code"], ["builder-1", "claude-code"], ["builder-2", "claude-2"], ["reviewer", "codex"], ["tester", expect.any(String)]]);
  });
});

describe("#288 a shift task says what really stopped it", () => {
  const task = { text: "add a README", chat: "c" };
  it("the shield, the loop watch, a quota — not 'was Loom restarted?'", () => {
    const said = ev("message", { text: "add a README" });
    expect(outcomeOf(task, [said, ev("status", { state: "shield_tripped", stopped: true, what: "a recursive delete outside the project" }, "cc"), ev("status", { state: "interrupted" }, "cc")]))
      .toMatchObject({ status: "running", stopped: "the Blast-Radius Shield stopped it: it ran a recursive delete outside the project" });
    expect(outcomeOf(task, [said, ev("status", { state: "loop_detected", nudged: true, call: "npm test" }, "cc")])).toMatchObject({ stopped: expect.stringMatching(/loop watch stopped it/) });
    expect(outcomeOf(task, [said, ev("status", { state: "interrupted" }, "cc")])).toMatchObject({ stopped: "its turn was stopped" });
    expect(outcomeOf(task, [said])).not.toHaveProperty("stopped");
  });
});

describe("#297 digest", () => {
  it("collapses repeats into one line with a count", () => {
    const err = (t: number) => ev("error", { message: "Not signed in." }, "grok", t);
    const d = digest([err(1000), err(2000), err(3000), ev("needs_input", { question: "Which?" }, "cc", 4000)], 0);
    const errors = d.lines.filter((l) => l.kind === "failed");
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ count: 3, at: 3000 });
  });
});

describe("#295 orchestra worktrees", () => {
  it("live under ~/.loom on the same disk, or where config says", () => {
    const dir = tmpDir("wt-root");
    expect(orchestraWorktreeRoot(dir, "p1")).toMatch(/[\\/]orchestra[\\/]p1$/);
    expect(orchestraWorktreeRoot(dir, "p1", "../wt")).toBe(path.resolve(dir, "../wt", "p1"));
  });
});

let rt: ProjectRuntime | undefined;
afterEach(async () => { await rt?.close(); rt = undefined; });
beforeAll(() => {
  process.env.LOOM_HOME = tmpDir("home-stress");
  process.env.LOOM_NO_NOTIFY = "1";
});

describe("in a project", () => {
  it("#284 a crew budget before any goal is the next goal's budget", async () => {
    const dir = tmpDir("stress-crew");
    writeProjectConfig(dir, { name: "s", agents: [{ id: "a", kind: "echo" }, { id: "b", kind: "echo" }], brain: { extractor: "off" } });
    rt = await ProjectRuntime.open({ id: `stress-${path.basename(dir)}`, name: "s", dir });
    const crew = rt.crews.create({ template: "solo" });
    expect(rt.crews.raiseBudget(crew.id, 10)).toBeNull();
    expect(rt.config.crews!.find((c) => c.id === crew.id)!.budgetUsd).toBe(10);
    expect(() => rt!.crews.raiseBudget(crew.id, 0)).toThrow(/above 0/);
  });

  it("#294 an orchestra, crew, council or shift in flight is work, not idle", async () => {
    const dir = tmpDir("stress-status");
    writeProjectConfig(dir, { name: "s", agents: [{ id: "a", kind: "echo" }, { id: "b", kind: "echo" }], brain: { extractor: "off" } });
    rt = await ProjectRuntime.open({ id: `stress2-${path.basename(dir)}`, name: "s", dir });
    expect((await rt.status()).activity).toEqual([]);
    rt.shifts.start({ tasks: ["one sleep:400"], to: "a" });
    expect((await rt.status()).activity).toContain("night shift");
  });
});
