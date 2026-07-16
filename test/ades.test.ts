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

  it("hands the canonical roles out in order, so the ship route wires up", () => {
    const agents = defaultAgentConfigs({ "claude-code": true, codex: true, opencode: true });
    expect(agents.map((a) => a.role)).toEqual(["planner", "executor", "reviewer"]);
    expect(buildDefaultRoutes(agents)).toEqual({ ship: ["planner", "executor", "reviewer"] });
  });

  /**
   * Four ADEs, three canonical roles. The fourth gets its kind as its role
   * rather than doubling up: two agents sharing "reviewer" would make the route
   * ambiguous, and Loom has no basis for deciding Grok is the reviewer.
   */
  it("doesn't duplicate a role when there are more agents than roles", () => {
    const agents = defaultAgentConfigs({
      "claude-code": true,
      codex: true,
      opencode: true,
      "grok-code": true,
    });
    const roles = agents.map((a) => a.role);
    expect(roles).toEqual(["planner", "executor", "reviewer", "grok-code"]);
    expect(new Set(roles).size).toBe(roles.length);
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
