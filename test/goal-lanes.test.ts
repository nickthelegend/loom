/**
 * Two goals at once, when they can't collide.
 *
 * The asymmetry here is the whole design: a wrong "they collide" costs you a
 * queued goal, and a wrong "they're fine" costs you a merge nobody can
 * explain. So every case that can't be proven disjoint must come back as an
 * overlap — including the case where a goal hasn't said what it touches.
 */

import { describe, expect, it } from "vitest";

import { blockedBy, fixedPrefix, globsIntersect, overlapReason, overlaps } from "../src/core/goal-lanes.js";

describe("what a glob reaches", () => {
  it("takes everything before the first wildcard, as a path", () => {
    expect(fixedPrefix("src/auth/**")).toBe("src/auth/");
    expect(fixedPrefix("src/a*.ts")).toBe("src/");
    expect(fixedPrefix("src/app.ts")).toBe("src/app.ts");
    expect(fixedPrefix("./src/auth/**")).toBe("src/auth/");
    expect(fixedPrefix("/src/auth/**")).toBe("src/auth/");
    expect(fixedPrefix("**/*.test.ts")).toBe(""); // reaches anything
    expect(fixedPrefix("{a,b}/x")).toBe("");
  });

  it("intersects when one prefix contains the other", () => {
    expect(globsIntersect("src/auth/**", "src/auth/login.ts")).toBe(true);
    expect(globsIntersect("src/auth/**", "src/**")).toBe(true);
    expect(globsIntersect("src/auth/**", "src/billing/**")).toBe(false);
    expect(globsIntersect("docs/**", "src/**")).toBe(false);
    // a leading wildcard reaches everything, so it collides with everything
    expect(globsIntersect("**/*.ts", "docs/**")).toBe(true);
  });
});

describe("two goals", () => {
  it("are disjoint only when every pair of paths is", () => {
    expect(overlaps(["src/auth/**"], ["src/billing/**"])).toBe(false);
    expect(overlaps(["src/auth/**", "docs/**"], ["src/billing/**", "docs/api.md"])).toBe(true);
    expect(overlapReason(["src/auth/**"], ["src/auth/login.ts"])).toBe("src/auth/** and src/auth/login.ts");
    expect(overlapReason(["src/auth/**"], ["src/billing/**"])).toBeNull();
  });

  it("a goal that hasn't said what it touches collides with everything", () => {
    expect(overlaps([], ["src/billing/**"])).toBe(true);
    expect(overlaps(["src/auth/**"], [])).toBe(true);
    expect(overlapReason([], ["x"])).toMatch(/doesn't say what it touches/);
  });
});

describe("may it start", () => {
  const running = [{ runId: "o1", goal: "rework billing", paths: ["src/billing/**"] }];

  it("goes when nothing is running", () => {
    expect(blockedBy({ runId: "n", goal: "x", paths: [] }, [], 1)).toBeNull();
  });

  it("waits while another goal runs, by default — and names it", () => {
    expect(blockedBy({ runId: "n", goal: "x", paths: ["src/auth/**"] }, running, 1)).toBe(
      'waiting for the goal "rework billing" to finish',
    );
  });

  it("with lanes on, disjoint goals run together and overlapping ones wait", () => {
    expect(blockedBy({ runId: "n", goal: "auth", paths: ["src/auth/**"] }, running, 2)).toBeNull();
    const clash = blockedBy({ runId: "n", goal: "billing tweak", paths: ["src/billing/tax.ts"] }, running, 2);
    expect(clash).toMatch(/rework billing/);
    expect(clash).toMatch(/both touch/);
  });

  it("never exceeds the cap, however disjoint the work is", () => {
    const two = [
      { runId: "o1", goal: "a", paths: ["src/a/**"] },
      { runId: "o2", goal: "b", paths: ["src/b/**"] },
    ];
    expect(blockedBy({ runId: "n", goal: "c", paths: ["src/c/**"] }, two, 2)).toMatch(/2 goals already running/);
    expect(blockedBy({ runId: "n", goal: "c", paths: ["src/c/**"] }, two, 3)).toBeNull();
  });

  it("an unscoped goal waits for anything in flight, even with lanes on", () => {
    expect(blockedBy({ runId: "n", goal: "vague", paths: [] }, running, 4)).toMatch(/both touch/);
  });
});
