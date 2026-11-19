import fs from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";
import { apiData, apiPath } from "../src/cli/r4-agentic.js";
import { cycleView, paletteItems, renderTabs } from "../src/cli/tui-model.js";
import { lintSkill } from "../src/core/agentic-r4/skills.js";
import { writeLoomMcpSession, loomToolScope } from "../src/core/loom-tools.js";
import { tmpDir } from "./helpers.js";

describe("CLI and TUI input models", () => {
  it("keeps API calls on the authenticated daemon and parses file JSON literally", () => {
    expect(apiPath("/r4/tools", "a b")).toBe("/api/projects/a%20b/r4/tools");
    for (const route of ["https://evil.invalid", "//evil.invalid", "/../api/test", "/api/%2e%2e/test", "/api/foo#bar"]) expect(() => apiPath(route)).toThrow();
    expect(apiData('{"text":"$(no-shell)"}')).toEqual({ text: "$(no-shell)" });
    const file = path.join(tmpDir("r4-data"), "data.json"); fs.writeFileSync(file, '{"enabled":false}');
    expect(apiData(`@${file}`)).toEqual({ enabled: false });
    expect(apiData("[]")).toEqual([]); expect(apiData("null")).toBeNull(); expect(apiData("false")).toBe(false);
    expect(() => apiData("bad-json")).toThrow();
  });
  it("includes both new tabs, view palette entries and action entries", () => {
    expect(cycleView("scoreboard")).toBe("orchestra"); expect(cycleView("orchestra")).toBe("approvals"); expect(cycleView("approvals")).toBe("thread");
    expect(renderTabs("approvals")).toContain("Approvals");
    const palette = paletteItems([], [], null);
    expect(palette[0]!.id).toBe("view:thread");
    const ids = palette.map(p => p.id);
    expect(ids.slice(ids.indexOf("view:scoreboard"), ids.indexOf("view:scoreboard") + 3)).toEqual(["view:scoreboard", "view:orchestra", "view:approvals"]);
    expect(ids.slice(-4)).toEqual(["cmd:quit", "orchestra:retry", "approvals:allow", "approvals:deny"]);
    expect(ids.filter(id => !["view:orchestra", "view:approvals", "orchestra:retry", "approvals:allow", "approvals:deny"].includes(id))).toEqual([
      "view:thread", "view:board", "view:brain", "view:scoreboard", "view:diff", "route:auto", "route:custom", "decision",
      "cmd:agents", "cmd:routes", "cmd:interrupt", "cmd:abort", "cmd:prompts", "prompt", "cmd:skills", "cmd:mcp", "cmd:pair", "cmd:help", "cmd:quit",
    ]);
    expect(palette.filter(p => /^(view:orchestra|view:approvals|orchestra:retry|approvals:allow|approvals:deny)$/.test(p.id))).toHaveLength(5);
  });
  it("binds credential identity at creation and revokes it at turn end", () => {
    const session = writeLoomMcpSession([], { project: "identity-test", api: "http://127.0.0.1:1", agent: "actual", chat: "asking-chat" })!;
    const token = (session.servers[0]!.entry as { env: Record<string, string> }).env.LOOM_MCP_TOKEN!;
    const scope = loomToolScope(token)!;
    try {
      expect(scope).toMatchObject({ agent: "actual", chat: "asking-chat", alive: true });
      expect(scope.turnId).toBeTruthy();
    } finally { session.cleanup(); }
    expect(scope.alive).toBe(false);
    expect(loomToolScope(token)).toBeUndefined();
  });
  it("lints required front matter, duplicate fields and invalid names", () => {
    const dir = tmpDir("r4-lint");
    for (const text of ["no front matter", "---\nname: a\n---\nbody", "---\nname: a\nname: b\ndescription: D\n---\nbody", "---\nname: BAD\ndescription: D\n---\nbody"]) {
      fs.writeFileSync(path.join(dir, "SKILL.md"), text); expect(lintSkill(dir).valid).toBe(false);
    }
    fs.writeFileSync(path.join(dir, "SKILL.md"), "---\nname: useful-skill\ndescription: >\n  Use for a reproducible\n  workflow.\n---\nSteps\n");
    expect(lintSkill(dir)).toEqual({ valid: true, errors: [] });
  });
});
