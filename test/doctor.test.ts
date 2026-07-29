import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { doctorReport, projectChecks, type Check } from "../src/cli/doctor.js";
import { writeProjectConfig, writeProjectState } from "../src/core/registry.js";
import type { ProjectConfig } from "../src/types.js";
import { makeProjectDir, tmpDir } from "./helpers.js";

function statusOf(checks: ReturnType<typeof projectChecks>, name: string) {
  return checks.filter((c) => c.name === name).map((c) => c.status);
}

describe("loom doctor — JSON report", () => {
  it("keeps checks intact and summarizes warnings and failures", () => {
    const checks: Check[] = [
      { name: "node", status: "ok", detail: "v22.5.0" },
      { name: "daemon", status: "warn", detail: "not running" },
      { name: "project", status: "fail", detail: "missing config" },
    ];

    expect(doctorReport(checks)).toEqual({
      checks,
      summary: { ok: false, warnings: 1, failures: 1 },
    });
  });
});

describe("loom doctor — project checks", () => {
  it("healthy project: everything ok", () => {
    const dir = makeProjectDir({ routes: { ship: ["planner", "executor"] } } as Partial<ProjectConfig>);
    const checks = projectChecks(dir);
    expect(checks.every((c) => c.status === "ok")).toBe(true);
    expect(checks.find((c) => c.name === "routes")!.detail).toContain("ship");
  });

  it("accepts a role you made up — they're names, not a menu", () => {
    // Roles went free-form, but doctor kept a planner|executor|reviewer|general
    // whitelist and hard-failed anything else. Calling an agent "architect" is
    // the whole point; doctor must not tell you your project is broken for it.
    const dir = makeProjectDir({
      agents: [
        { id: "a", kind: "echo", role: "architect" },
        { id: "b", kind: "echo", role: "the one that writes docs" },
      ],
    } as Partial<ProjectConfig>);
    const checks = projectChecks(dir);
    expect(statusOf(checks, "agents")).not.toContain("fail");
  });

  it("fails on missing config, unknown kinds, bad roles, broken routes", () => {
    const empty = tmpDir("doc-empty");
    expect(statusOf(projectChecks(empty), "project")).toEqual(["fail"]);

    const dir = tmpDir("doc-bad");
    writeProjectConfig(dir, {
      name: "bad",
      agents: [
        { id: "a", kind: "no-such-kind", role: "planner" },
        { id: "b", kind: "echo", role: "" }, // blank: nothing can target it
        { id: "b", kind: "echo", role: "executor" }, // duplicate id
      ],
      defaultAgent: "ghost",
      routes: { broken: ["nobody"] },
    });
    const checks = projectChecks(dir);
    expect(statusOf(checks, "agents")).toContain("fail");
    expect(checks.some((c) => c.detail.includes('unknown kind "no-such-kind"'))).toBe(true);
    expect(checks.some((c) => c.detail.includes("has no role"))).toBe(true);
    expect(checks.some((c) => c.detail.includes('duplicate agent id "b"'))).toBe(true);
    expect(checks.some((c) => c.detail.includes('defaultAgent "ghost"'))).toBe(true);
    expect(checks.some((c) => c.name === "routes" && c.status === "fail")).toBe(true);
  });

  it("warns on a ghost baton holder", () => {
    const dir = makeProjectDir();
    writeProjectState(dir, { holder: "deleted-agent", agents: {} });
    const checks = projectChecks(dir);
    const baton = checks.find((c) => c.name === "baton")!;
    expect(baton.status).toBe("warn");
    expect(baton.detail).toContain("deleted-agent");
  });

  it("bridges don't count as baton-capable; adapter-less projects fail", () => {
    const dir = tmpDir("doc-bridge");
    writeProjectConfig(dir, {
      name: "bridges-only",
      agents: [{ id: "ag", kind: "antigravity", role: "general" }],
    });
    fs.mkdirSync(path.join(dir, ".loom"), { recursive: true });
    const checks = projectChecks(dir);
    expect(
      checks.some((c) => c.name === "agents" && c.status === "fail" && c.detail.includes("no full-duplex")),
    ).toBe(true);
  });
});

/**
 * doctor --fix.
 *
 * The line it must not cross: repair only what has exactly one safe repair.
 * Ambiguous findings (duplicate ids, unknown kinds) stay reports — a fixer
 * that guesses turns a visible problem into an invisible wrong answer.
 */
describe("loom doctor — fixes", () => {
  const brokenProject = (name: string): string => {
    const dir = tmpDir(name);
    writeProjectConfig(dir, {
      name,
      defaultAgent: "vanished",
      agents: [
        { id: "planner", kind: "echo", role: "" }, // empty role → fixable
        { id: "twin", kind: "echo", role: "a" },
        { id: "twin", kind: "echo", role: "b" }, // duplicate → not fixable
      ],
    } as ProjectConfig);
    writeProjectState(dir, { holder: "vanished", agents: {} });
    return dir;
  };

  it("repairs the unambiguous and reports the rest", async () => {
    const { fixProject } = await import("../src/cli/doctor.js");
    const dir = brokenProject("fixme");
    const { fixed, unfixable } = fixProject(dir);

    expect(fixed.some((f) => f.includes('"planner" had no role'))).toBe(true);
    expect(fixed.some((f) => f.includes('defaultAgent "vanished"'))).toBe(true);
    expect(fixed.some((f) => f.includes('stale baton holder "vanished"'))).toBe(true);
    expect(unfixable.some((u) => u.includes('duplicate agent id "twin"'))).toBe(true);
  });

  it("actually persists the repairs — doctor afterwards is quieter", async () => {
    const { fixProject } = await import("../src/cli/doctor.js");
    const dir = brokenProject("fixme2");
    const before = projectChecks(dir);
    expect(before.some((c) => c.status === "fail" && c.detail.includes("no role"))).toBe(true);

    fixProject(dir);
    const after = projectChecks(dir);
    expect(after.some((c) => c.detail.includes("no role"))).toBe(false);
    expect(after.some((c) => c.name === "config" && c.status === "fail")).toBe(false);
    expect(after.find((c) => c.name === "baton")!.status).toBe("ok");
    // The duplicate survives — deliberately.
    expect(after.some((c) => c.detail.includes("duplicate"))).toBe(true);
  });

  it("is idempotent — a second pass finds nothing to do", async () => {
    const { fixProject } = await import("../src/cli/doctor.js");
    const dir = brokenProject("fixme3");
    fixProject(dir);
    const second = fixProject(dir);
    expect(second.fixed).toHaveLength(0);
    expect(second.unfixable.length).toBeGreaterThan(0); // still reporting the duplicate
  });

  it("does not invent a project where there is none", async () => {
    const { fixProject } = await import("../src/cli/doctor.js");
    const dir = tmpDir("no-project");
    const { fixed, unfixable } = fixProject(dir);
    expect(fixed).toHaveLength(0);
    expect(unfixable[0]).toContain("loom init creates one, doctor won't");
  });
});
