/**
 * Conditions on a route step, beyond "it errored".
 *
 * The rule these exist to keep: a condition may only read what the daemon
 * measured. A route that skips the reviewer has to be able to say, in numbers,
 * why — and a route that can't measure the turn must not guess in either
 * direction.
 */

import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { EventLog } from "../src/core/eventlog.js";
import { RouteEngine, resolveSteps } from "../src/core/routes.js";
import {
  conditionHolds,
  matchesGlob,
  NO_CHANGES,
  parseStepCondition,
  type TurnFacts,
} from "../src/core/step-conditions.js";
import type { ProjectConfig } from "../src/types.js";
import { tmpDir, waitUntil } from "./helpers.js";

const facts = (over: Partial<TurnFacts> = {}): TurnFacts => ({ ...NO_CHANGES, ...over });

describe("reading a condition", () => {
  it("understands the four shapes, spacing and all", () => {
    expect(parseStepCondition("changed>10")).toEqual({ kind: "changed", op: ">", n: 10 });
    expect(parseStepCondition("  lines < 200 ")).toEqual({ kind: "lines", op: "<", n: 200 });
    expect(parseStepCondition("touched:src/db/**")).toEqual({
      kind: "touched",
      glob: "src/db/**",
      negated: false,
    });
    expect(parseStepCondition("!touched:docs/**").negated).toBe(true);
  });

  it("refuses what it can't measure, and says what it can", () => {
    // The alternative is a condition that silently never matches.
    expect(() => parseStepCondition("the review went well")).toThrow(/don't understand/);
    expect(() => parseStepCondition("tests-pass")).toThrow(/changed>10/);
    expect(() => parseStepCondition("touched:")).toThrow();
  });
});

describe("holding against a turn", () => {
  it("counts files and lines", () => {
    const big = facts({ files: ["a", "b", "c"], added: 300, removed: 12 });
    expect(conditionHolds(parseStepCondition("changed>2"), big)).toBe(true);
    expect(conditionHolds(parseStepCondition("changed>3"), big)).toBe(false);
    expect(conditionHolds(parseStepCondition("lines>200"), big)).toBe(true); // added + removed
    expect(conditionHolds(parseStepCondition("lines<100"), big)).toBe(false);
  });

  it("a turn that changed nothing is small, not unknown", () => {
    expect(conditionHolds(parseStepCondition("changed>0"), NO_CHANGES)).toBe(false);
    expect(conditionHolds(parseStepCondition("lines<5"), NO_CHANGES)).toBe(true);
    expect(conditionHolds(parseStepCondition("!touched:src/**"), NO_CHANGES)).toBe(true);
  });

  it("matches paths the way a person means them", () => {
    expect(matchesGlob("src/db/schema.ts", "src/db/**")).toBe(true);
    expect(matchesGlob("src/db/migrations/001.sql", "src/db/**")).toBe(true);
    expect(matchesGlob("src/api/db.ts", "src/db/**")).toBe(false);
    expect(matchesGlob("src/app.ts", "src/*.ts")).toBe(true);
    expect(matchesGlob("src/a/b.ts", "src/*.ts")).toBe(false); // * stops at a slash
    expect(matchesGlob("test/x.test.ts", "**/*.test.ts")).toBe(true);
    expect(matchesGlob("x.test.ts", "**/*.test.ts")).toBe(true); // ** may match nothing
    expect(matchesGlob("./src/app.ts", "src/app.ts")).toBe(true);
    const touched = parseStepCondition("touched:src/db/**");
    expect(conditionHolds(touched, facts({ files: ["README.md", "src/db/schema.ts"] }))).toBe(true);
    expect(conditionHolds(touched, facts({ files: ["README.md"] }))).toBe(false);
  });
});

const config: ProjectConfig = {
  name: "x",
  agents: [
    { id: "plan", kind: "echo", role: "planner" },
    { id: "exec", kind: "echo", role: "executor" },
    { id: "review", kind: "echo", role: "reviewer" },
  ],
};
const isAdapter = () => true;

describe("a conditional step, as written", () => {
  it("reads inline and object forms the same way", () => {
    expect(resolveSteps(["plan", "exec?lines>200"], config, isAdapter).when).toEqual([
      null,
      "lines>200",
    ]);
    expect(
      resolveSteps(["plan", { step: "review", when: "changed>3" }], config, isAdapter),
    ).toMatchObject({ ids: ["plan", "review"], when: [null, "changed>3"] });
    // the step itself still resolves by id or role
    expect(resolveSteps(["plan", "reviewer?changed>3"], config, isAdapter).ids).toEqual([
      "plan",
      "review",
    ]);
  });

  it("refuses a condition on the first step — there's no turn to measure", () => {
    expect(() => resolveSteps(["plan?changed>1", "exec"], config, isAdapter)).toThrow(
      /first step can't be conditional/,
    );
  });

  it("refuses an unreadable condition at definition time", () => {
    expect(() => resolveSteps(["plan", "exec?vibes"], config, isAdapter)).toThrow(
      /don't understand/,
    );
  });
});

// ---------------------------------------------------------------------------
// The engine, driven directly: real state file, stubbed agents.
// ---------------------------------------------------------------------------

let cleanup: Array<() => void> = [];
afterEach(() => {
  for (const fn of cleanup) fn();
  cleanup = [];
});

async function engine(turn: TurnFacts) {
  const dir = tmpDir("route-cond");
  fs.mkdirSync(path.join(dir, ".loom"), { recursive: true });
  const log = await EventLog.open(path.join(dir, ".loom"));
  const sent: string[] = [];
  const routes = new RouteEngine({
    projectName: "x",
    projectDir: dir,
    config,
    log,
    handoff: async (to) => {
      sent.push(`handoff:${to}`);
      return {};
    },
    send: async (_text: string, agentId: string) => sent.push(`send:${agentId}`),
    interrupt: async () => {},
    isAdapterId: isAdapter,
    costTotal: () => 0,
    turnFacts: async () => turn,
  });
  cleanup.push(() => log.close?.());
  const done = (agentId: string) =>
    routes.handleAgentEvent(
      log.append({ kind: "run_complete", agentId, payload: { durationMs: 1 } }),
    );
  const steps = (skipped?: boolean) =>
    log
      .list({ kinds: ["route_step"], limit: 50 })
      .filter((e) => (skipped === undefined ? true : Boolean(e.payload.skipped) === skipped));
  return { routes, log, sent, done, steps };
}

describe("a conditional step, as it runs", () => {
  it("runs the step when the turn meets its condition", async () => {
    const h = await engine(facts({ files: ["a.ts", "b.ts", "c.ts", "d.ts"], added: 400 }));
    await h.routes.start(["plan", "exec", "review?lines>200"], "ship it");
    h.done("plan");
    await waitUntil(async () => h.sent.includes("send:exec"));
    h.done("exec");
    await waitUntil(async () => h.sent.includes("send:review"));
    expect(h.steps(true)).toHaveLength(0); // nothing was skipped
  });

  it("skips it when the turn doesn't, and says so with the numbers", async () => {
    const h = await engine(facts({ files: ["a.ts"], added: 3, removed: 1 }));
    await h.routes.start(["plan", "exec", "review?lines>200"], "tiny fix");
    h.done("plan");
    await waitUntil(async () => h.sent.includes("send:exec"));
    h.done("exec");
    await waitUntil(async () => h.routes.state()?.status === "completed");

    expect(h.sent).not.toContain("send:review"); // the reviewer was never woken
    const skipped = h.steps(true);
    expect(skipped).toHaveLength(1);
    expect(skipped[0]!.payload.agent).toBe("review");
    expect(String(skipped[0]!.payload.reason)).toContain("more than 200 lines");
    expect(String(skipped[0]!.payload.reason)).toContain("1 file, 4 lines"); // what it did change
    expect(h.routes.state()!.status).toBe("completed"); // skipping isn't failing
  });

  it("a route whose last steps all skip still completes", async () => {
    const h = await engine(NO_CHANGES);
    await h.routes.start(["plan", "exec?changed>0", "review?changed>0"], "nothing much");
    h.done("plan");
    await waitUntil(async () => h.routes.state()?.status === "completed");
    expect(h.steps(true).map((e) => e.payload.agent)).toEqual(["exec", "review"]);
    expect(h.sent.filter((s) => s.startsWith("send:"))).toEqual(["send:plan"]);
  });

  it("an unconditional route is untouched — no stepWhen, no extra events", async () => {
    const h = await engine(NO_CHANGES);
    const r = await h.routes.start(["plan", "exec"], "as before");
    expect(r.stepWhen).toBeUndefined();
    h.done("plan");
    await waitUntil(async () => h.sent.includes("send:exec"));
    expect(h.steps(true)).toHaveLength(0);
  });
});
