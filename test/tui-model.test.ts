import { describe, expect, it } from "vitest";
import {
  centerPad,
  cycleAgent,
  cycleView,
  filterPalette,
  formatBoard,
  formatBrain,
  formatDiff,
  logoLines,
  paletteItems,
  parseSlash,
  renderInput,
  renderTabs,
  stripAnsi,
  switchableAgents,
  VIEWS,
} from "../src/cli/tui-model.js";
import type { AgentStatus } from "../src/types.js";
import type { Memory } from "../src/core/brain.js";
import type { BoardData } from "../src/daemon/board.js";

function mem(over: Partial<Memory> = {}): Memory {
  const now = Date.now();
  return {
    id: "m",
    kind: "fact",
    text: "t",
    entities: [],
    scope: {},
    provenance: { agentId: "claude-code", eventId: 1, ts: now },
    confidence: 1,
    lemmas: "",
    hash: "",
    createdAt: now,
    updatedAt: now,
    ...over,
  };
}

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

  it("offers the four views as palette entries", () => {
    const ids = paletteItems(AGENTS, [], null).map((i) => i.id);
    expect(ids).toEqual(expect.arrayContaining(["view:thread", "view:board", "view:brain", "view:diff"]));
    const board = paletteItems(AGENTS, [], null).find((i) => i.id === "view:board")!;
    expect(board.action).toEqual({ type: "view", view: "board" });
  });
});

describe("tui views", () => {
  it("cycleView wraps through the four tabs", () => {
    expect(VIEWS).toEqual(["thread", "board", "brain", "diff"]);
    expect(cycleView("thread")).toBe("board");
    expect(cycleView("diff")).toBe("thread"); // wraps
    expect(cycleView("thread", -1)).toBe("diff");
  });

  it("renderTabs shows all four labels", () => {
    const tabs = stripAnsi(renderTabs("brain"));
    for (const label of ["1 Thread", "2 Board", "3 Brain", "4 Diff"]) expect(tabs).toContain(label);
  });

  it("formatBrain groups by kind — failures before facts — and dims low confidence", () => {
    const lines = formatBrain(
      [
        mem({ kind: "fact", text: "the daemon port is 7420" }),
        mem({ kind: "failure", text: "never rebind to 0.0.0.0" }),
        mem({ kind: "fact", text: "a shaky guess", confidence: 0.4 }),
      ],
      { total: 3, byKind: { fact: 2, failure: 1 } },
      80,
    ).map(stripAnsi);
    const text = lines.join("\n");
    expect(text).toContain("3 memories learned");
    const failIdx = lines.findIndex((l) => l.includes("Failures"));
    const factIdx = lines.findIndex((l) => l.includes("Facts"));
    expect(failIdx).toBeGreaterThanOrEqual(0);
    expect(failIdx).toBeLessThan(factIdx); // damage-preventers first
    expect(text).toContain("never rebind to 0.0.0.0");
    expect(text).toContain("~0.40"); // the low-confidence badge
  });

  it("formatBrain is honest when the brain is empty", () => {
    expect(formatBrain([], { total: 0, byKind: {} }, 80).join("\n")).toContain("nothing learned yet");
  });

  it("formatBoard lays out four columns and notes an empty board", () => {
    const board: BoardData = { available: true, repo: "me/repo", cards: [] };
    const text = formatBoard(board, 80).map(stripAnsi).join("\n");
    for (const col of ["Working", "Needs you", "In review", "Ready"]) expect(text).toContain(col);
    expect(text).toContain("nothing on the board yet");
  });

  it("formatBoard places a card under its column", () => {
    const board: BoardData = {
      available: true,
      repo: null,
      cards: [{ id: "task-1", title: "fix the flaky test", agent: "you", state: "working", column: "working", own: true }],
    };
    expect(formatBoard(board, 80).map(stripAnsi).join("\n")).toContain("fix the flaky test");
  });

  it("formatDiff lists changed files and a patch, and reads a clean/non-repo tree", () => {
    const text = formatDiff(
      { git: true, branch: "main", files: [{ status: "M", path: "a.ts" }], patch: "@@ -1 +1 @@\n-old\n+new", truncated: false },
      80,
    )
      .map(stripAnsi)
      .join("\n");
    expect(text).toContain("on main");
    expect(text).toContain("a.ts");
    expect(text).toContain("+new");
    expect(formatDiff({ git: true, files: [], patch: "", truncated: false }, 80).join("\n")).toContain(
      "working tree clean",
    );
    expect(formatDiff({ git: false, files: [], patch: "", truncated: false }, 80).join("\n")).toContain(
      "not a git repository",
    );
  });
});
