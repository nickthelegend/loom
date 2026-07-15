import { describe, expect, it } from "vitest";
import {
  centerPad,
  cycleAgent,
  filterPalette,
  logoLines,
  paletteItems,
  parseSlash,
  renderInput,
  stripAnsi,
  switchableAgents,
} from "../src/cli/tui-model.js";
import type { AgentStatus } from "../src/types.js";

function agent(id: string, over: Partial<AgentStatus> = {}): AgentStatus {
  return {
    id,
    kind: "echo",
    role: "general",
    tier: "adapter",
    available: true,
    busy: false,
    holdsBaton: false,
    ...over,
  };
}

const AGENTS = [
  agent("claude-code"),
  agent("opencode"),
  agent("antigravity", { tier: "bridge" }),
  agent("broken", { available: false }),
];

describe("tui model", () => {
  it("tab cycles only through available adapters (bridges/broken skipped)", () => {
    expect(switchableAgents(AGENTS).map((a) => a.id)).toEqual(["claude-code", "opencode"]);
    expect(cycleAgent(AGENTS, "claude-code")).toBe("opencode");
    expect(cycleAgent(AGENTS, "opencode")).toBe("claude-code"); // wraps
    expect(cycleAgent(AGENTS, "opencode", -1)).toBe("claude-code");
    expect(cycleAgent(AGENTS, null)).toBe("claude-code");
    expect(cycleAgent(AGENTS, "antigravity")).toBe("claude-code"); // never lands on a bridge
    expect(cycleAgent([agent("b", { tier: "bridge" })], null)).toBeNull();
  });

  it("parses slash commands", () => {
    expect(parseSlash("/handoff opencode")).toEqual({
      cmd: "handoff",
      args: ["opencode"],
      rest: "opencode",
    });
    expect(parseSlash("/route ship add dark mode")).toMatchObject({
      cmd: "route",
      args: ["ship", "add", "dark", "mode"],
    });
    expect(parseSlash("  /HELP  ")).toMatchObject({ cmd: "help" });
    expect(parseSlash("hello there")).toBeNull();
  });

  it("renders the input with a block cursor", () => {
    const empty = renderInput("", 0, "Ask anything…");
    expect(stripAnsi(empty)).toBe("Ask anything…");
    const mid = renderInput("hello", 2, "…");
    expect(stripAnsi(mid)).toBe("hello");
    const end = renderInput("hi", 2, "…");
    expect(stripAnsi(end)).toBe("hi "); // cursor block sits after the text
  });

  it("centers with ansi-aware width math", () => {
    const line = centerPad("\x1b[1mob\x1b[0m", 10);
    expect(stripAnsi(line)).toBe("    ob");
  });

  it("logo rows are consistent width and centered", () => {
    const lines = logoLines(80);
    expect(lines).toHaveLength(6);
    const widths = lines.slice(0, 4).map((l) => stripAnsi(l).trimEnd().length);
    expect(new Set(widths).size).toBe(1);
  });
});

describe("command palette", () => {
  it("builds shift entries for other adapters only, plus routes and commands", () => {
    const items = paletteItems(AGENTS, ["ship"], "claude-code");
    const ids = items.map((i) => i.id);
    expect(ids).toContain("shift:opencode");
    expect(ids).not.toContain("shift:claude-code"); // already selected
    expect(ids).not.toContain("shift:antigravity"); // bridge
    expect(ids).toContain("route:ship");
    expect(ids).toContain("cmd:interrupt");
    const ship = items.find((i) => i.id === "route:ship")!;
    expect(ship.action).toEqual({ type: "insert", text: "/route ship " });
  });

  it("filters: substring beats subsequence, earlier match wins", () => {
    const items = paletteItems(AGENTS, ["ship"], null);
    const byQuery = (q: string) => filterPalette(items, q).map((i) => i.id);
    expect(byQuery("ship")[0]).toBe("route:ship");
    expect(byQuery("open")[0]).toBe("shift:opencode");
    expect(byQuery("")).toEqual(items.map((i) => i.id)); // no query → everything
    expect(byQuery("zzzz")).toEqual([]);
    // subsequence still matches: "abr" → "abort route"
    expect(byQuery("abr")).toContain("cmd:abort");
  });
});
