/**
 * Which ADEs are real, and what a new project gets.
 *
 * These don't run any agent: probing spawns CLIs and a turn costs money. What
 * they lock is the wiring — that every kind Loom advertises can be constructed,
 * that the roster is built from the list rather than from two hardcoded names,
 * and that the binary lookups find a CLI hiding inside a .app bundle.
 */

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ADES, adapterKinds, buildDefaultRoutes, defaultAgentConfigs } from "../src/core/ades.js";
import { codexBin } from "../src/adapters/codex.js";
import { grokBin } from "../src/adapters/grok.js";
import { parseGrokJson } from "../src/adapters/grok.js";
import { createAgent, knownAgentKinds } from "../src/adapters/index.js";
import { isAdapter } from "../src/types.js";
import { tmpDir } from "./helpers.js";

describe("ades · the list is the truth", () => {
  /**
   * The bug this prevents: the web app shipped Codex and Kiro logos for kinds
   * `loom` would reject, because "what we support" lived in a sprite and in a
   * factory and they disagreed. Every advertised ADE must be constructible.
   */
  it("every advertised ADE is a registered kind", () => {
    const known = knownAgentKinds();
    for (const ade of ADES) {
      expect(known, `${ade.label} is advertised but not registered`).toContain(ade.kind);
    }
  });

  it("builds each one, and each lands on the right side of the baton", () => {
    const dir = tmpDir("ade-build");
    for (const ade of ADES) {
      const agent = createAgent({ id: ade.kind, kind: ade.kind, role: "x" }, dir);
      expect(agent.kind).toBe(ade.kind);
      // tier is what decides who may hold the baton; a bridge never may
      expect(isAdapter(agent)).toBe(ade.tier === "adapter");
    }
  });

  it("only counts adapters as baton-holders", () => {
    expect(adapterKinds()).toContain("claude-code");
    expect(adapterKinds()).toContain("codex");
    expect(adapterKinds()).toContain("grok-code");
    expect(adapterKinds()).not.toContain("antigravity"); // a GUI app, driven not routed
    expect(adapterKinds()).not.toContain("kiro");
  });
});

describe("ades · the roster a new project gets", () => {
  it("takes only what's installed, and nothing when nothing is", () => {
    expect(defaultAgentConfigs({})).toEqual([]);
    expect(defaultAgentConfigs({ "claude-code": false, codex: false })).toEqual([]);
  });

  /**
   * These two used to assert the opposite — that the first three ADEs got
   * planner/executor/reviewer and that a "ship" route was built from them. They
   * passed the whole time, which is the point worth remembering: a test only
   * proves the code does what it does, never that it should. The behaviour was
   * an accident of list order that read like Loom's advice, and it was wrong
   * from the first day it worked.
   */
  it("gives every agent its own kind as its role, in order", () => {
    const agents = defaultAgentConfigs({
      "claude-code": true,
      codex: true,
      opencode: true,
      "grok-code": true,
    });
    expect(agents.map((a) => a.role)).toEqual(["claude-code", "codex", "opencode", "grok-code"]);
    // and every role is distinct, so nothing a route targets is ambiguous
    expect(new Set(agents.map((a) => a.role)).size).toBe(agents.length);
  });

  it("never seeds a bridge — it needs a GUI running with a debug port", () => {
    const agents = defaultAgentConfigs({ antigravity: true, kiro: true, "claude-code": true });
    expect(agents.map((a) => a.kind)).toEqual(["claude-code"]);
  });

  it("skips the route when one agent can't make a pipeline", () => {
    expect(buildDefaultRoutes(defaultAgentConfigs({ "claude-code": true }))).toBeUndefined();
  });
});

describe("ades · finding the CLI", () => {
  /**
   * On a Mac the codex CLI usually isn't on PATH at all — it ships inside
   * Codex.app. Looking only at PATH would report "not installed" to someone
   * with it installed.
   */
  it("finds codex inside the app bundle when it isn't on PATH", () => {
    const bundled = "/Applications/Codex.app/Contents/Resources/codex";
    if (!fs.existsSync(bundled)) return; // not this machine's problem
    expect(codexBin()).toBe(bundled);
  });

  it("takes an explicit path, and rejects one that isn't there", () => {
    const real = path.join(tmpDir("bin"), "codex");
    fs.writeFileSync(real, "#!/bin/sh\n");
    expect(codexBin(real)).toBe(real);
    expect(codexBin("/nope/codex")).toBeNull();
    expect(grokBin("/nope/grok")).toBeNull();
  });

  it("falls back to PATH resolution rather than giving up", () => {
    // no override, nothing installed at the known spots → let PATH decide
    expect(typeof codexBin()).toBe("string");
    expect(typeof grokBin()).toBe("string");
  });
});

describe("grok · reading its answer", () => {
  it("parses the object it prints", () => {
    const r = parseGrokJson('{"text":"ok","stopReason":"EndTurn","sessionId":"019f"}');
    expect(r?.text).toBe("ok");
    expect(r?.sessionId).toBe("019f");
  });

  it("finds the object even when something else printed first", () => {
    const r = parseGrokJson('warming up...\n{"text":"ok","stopReason":"EndTurn"}\n');
    expect(r?.text).toBe("ok");
  });

  it("returns null rather than throwing on junk", () => {
    expect(parseGrokJson("")).toBeNull();
    expect(parseGrokJson("not json at all")).toBeNull();
    expect(parseGrokJson("{ truncated")).toBeNull();
  });
});

/**
 * Roles are yours, not Loom's.
 *
 * This used to hand out planner / executor / reviewer by detection order, so
 * Claude Code was "the planner" and OpenCode "the executor" because of where
 * they sat in a list. Nobody decided that; it read like advice Loom had earned.
 */
describe("ades · nobody is the planner by default", () => {
  it("gives every agent its own kind as its role", () => {
    const agents = defaultAgentConfigs({
      "claude-code": true,
      codex: true,
      opencode: true,
      "grok-code": true,
    });
    expect(agents.map((a) => a.role)).toEqual(["claude-code", "codex", "opencode", "grok-code"]);
  });

  it("never invents planner/executor/reviewer", () => {
    const roles = defaultAgentConfigs({ "claude-code": true, codex: true, opencode: true }).map(
      (a) => a.role,
    );
    for (const invented of ["planner", "executor", "reviewer"]) {
      expect(roles, `"${invented}" is an opinion Loom hasn't earned`).not.toContain(invented);
    }
  });

  /**
   * And so no route is conjured either: buildDefaultRoutes wires "ship" from
   * planner→executor→reviewer, and with none of those names in play there is
   * nothing to build. A pipeline you didn't ask for isn't a default, it's a
   * guess about your workflow.
   */
  it("doesn't conjure a ship route out of names nobody chose", () => {
    const agents = defaultAgentConfigs({ "claude-code": true, codex: true, opencode: true });
    expect(buildDefaultRoutes(agents)).toBeUndefined();
  });
});
