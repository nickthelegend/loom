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
import { createAgent, isWithdrawnKind, knownAgentKinds, tierForKind } from "../src/adapters/index.js";
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

  /**
   * Kiro used to carry `probe: async () => false` because the type demanded a
   * probe from every entry. Nothing could ever call it — `detectAdes` filters to
   * adapters first, and a bridge's real availability is whether GuiChatDriver
   * can reach its debug port, which no probe here can answer. The spec type is
   * now a union, so a bridge has nowhere to put one; this asserts the shape at
   * runtime too, since a union is only as good as the next person's `as`.
   */
  it("gives bridges no probe — there is no question it could answer", () => {
    for (const ade of ADES) {
      if (ade.tier === "bridge") {
        expect("probe" in ade, `${ade.label} carries a probe nothing can call`).toBe(false);
      }
    }
  });

  /**
   * Registered and offered are different things, and the difference is the
   * whole fix: the CDP bridge still *builds*, so a project whose config already
   * names it still opens, but nothing advertises it and `addAgent` refuses to
   * create one (see the daemon suite).
   */
  it("still builds the withdrawn Antigravity bridge, and offers it to nobody", () => {
    const offered = ADES.map((a) => a.kind);
    expect(knownAgentKinds()).toContain("antigravity");
    expect(isWithdrawnKind("antigravity")).toBe(true);
    expect(offered).not.toContain("antigravity");
    expect(offered).toContain("antigravity-cli");
    // and every kind Loom does offer is one it will build
    for (const kind of offered) {
      expect(isWithdrawnKind(kind), `${kind} is advertised and withdrawn at once`).toBe(false);
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

describe("tier for kinds the ADES catalog omits", () => {
  // The roster has to answer "adapter or bridge?" for an agent that is switched
  // off, which is exactly when there is no instance to ask. It used to default
  // to "adapter", which is wrong for precisely the kinds ADES leaves out — the
  // withdrawn `antigravity` bridge and `echo` — so a disabled bridge advertised
  // itself as an adapter and the composer, which filters chips on that field,
  // offered it a model picker for a GUI app that takes no model flag.
  it("reports a bridge as a bridge even when it is not in ADES", () => {
    expect(tierForKind("antigravity")).toBe("bridge"); // withdrawn, still registered
    expect(tierForKind("kiro")).toBe("bridge");
  });

  it("reports adapters as adapters", () => {
    for (const kind of ["echo", "claude-code", "codex", "opencode", "grok-code", "antigravity-cli"]) {
      expect(tierForKind(kind)).toBe("adapter");
    }
  });

  it("returns null for a kind nothing registers, rather than guessing", () => {
    expect(tierForKind("not-a-real-kind")).toBeNull();
  });
});
