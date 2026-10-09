/**
 * The Subagents list: every agent an orchestrator set to work, active first.
 */

import { describe, expect, it } from "vitest";

import type { CrewView } from "../src/core/crew.js";
import type { OrchestraRun } from "../src/core/orchestra.js";
import { subagents } from "../src/core/subagents.js";

const task = (id: string, status: string, extra: Record<string, unknown> = {}) =>
  ({ id, title: `task ${id}`, prompt: "", agent: "opencode", kind: "opencode", dependsOn: [], status, chat: `ch-${id}`, attempts: 1, queued: [], ...extra });
const run = (id: string, status: string, tasks: unknown[], extra: Record<string, unknown> = {}) =>
  ({ id, goal: `goal ${id}`, orchestrator: { agent: "codex", kind: "codex" }, workers: [], status, chat: "o", baseBranch: null, branch: "b", tasks, round: 1, maxRounds: 10, maxParallel: 4, createdAt: 1000, updatedAt: 1000, ...extra }) as unknown as OrchestraRun;

describe("subagents", () => {
  it("lists a live run's tasks as active and a finished run's as done, newest first", () => {
    const l = subagents(
      [
        run("live", "running", [task("a", "running", { startedAt: 5000 }), task("b", "pending"), task("c", "needs_input")]),
        run("old", "completed", [task("d", "done", { finishedAt: 3000, result: "made it" }), task("e", "pending")], { updatedAt: 500 }),
      ],
      [],
      new Map([["ch-c", 9000]]),
    );
    expect(l.active.map((s) => [s.name, s.status])).toEqual([["task c", "asks"], ["task a", "running"], ["task b", "pending"]]);
    // a task a finished run never started isn't listed
    expect(l.done.map((s) => [s.name, s.status, s.note])).toEqual([["task d", "done", "made it"]]);
  });

  it("names race entrants by agent, and lists crew teammates with the one on a card running", () => {
    const crew = {
      id: "ship", name: "Ship crew", busy: true,
      teammates: [{ id: "lead", agent: "codex", role: "lead" }, { id: "builder-1", agent: "opencode", role: "builder" }],
      state: { id: "ship", channel: "c", threads: { lead: "t-lead", "builder-1": "t-b1" }, notes: {}, history: [],
        goal: { id: "g1", text: "ship it", status: "running", branch: "b", cards: [{ id: "k1", title: "add count()", stage: "building", rounds: 0, commits: [] }],
          current: { teammate: "builder-1", card: "k1", step: "builds" }, costUsd: 0, startedAt: 100 } },
    } as unknown as CrewView;
    const l = subagents([run("r", "completed", [task("x", "done")], { race: true })], [crew], new Map(), { kindOf: (a) => (a === "codex" ? "codex" : "opencode") });
    expect(l.done[0]!.name).toBe("opencode's take");
    expect(l.active.find((s) => s.id === "c:ship:builder-1")).toMatchObject({ status: "running", note: "builds · add count()", chat: "t-b1", kind: "opencode" });
    expect(l.active.find((s) => s.id === "c:ship:lead")!.status).toBe("pending");
  });
});
