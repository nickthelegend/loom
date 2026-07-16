import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { projectChecks } from "../src/cli/doctor.js";
import { writeProjectConfig, writeProjectState } from "../src/core/registry.js";
import type { ProjectConfig } from "../src/types.js";
import { makeProjectDir, tmpDir } from "./helpers.js";

function statusOf(checks: ReturnType<typeof projectChecks>, name: string) {
  return checks.filter((c) => c.name === name).map((c) => c.status);
}

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
