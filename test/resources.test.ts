/** What the agents cost the machine (core/resources.ts). */

import { describe, expect, it } from "vitest";
import { groupTree, parsePs, procName, resources } from "../src/core/resources.js";

describe("resources", () => {
  it("groups the daemon's process tree by its direct children, heaviest first", () => {
    const rows = parsePs([
      "  100     1  80000  2.0 node /usr/local/bin/loom daemon",
      "  200   100 512000 40.5 /Users/me/.local/bin/codex app-server",
      "  201   200 102400  5.0 /bin/zsh -c npm test",
      "  300   100 204800  1.0 node /x/node_modules/@modelcontextprotocol/server-github/dist/index.js",
      "  400   100   2048  0.0 ps -A -o pid=",
      "  500     1  99999  9.9 unrelated",
    ].join("\n"));
    const groups = groupTree(rows, 100);
    expect(groups.map((g) => [g.name, g.processes, g.rssMb, g.cpu])).toEqual([
      ["codex", 2, 600, 45.5],
      ["@modelcontextprotocol/server-github", 1, 200, 1],
    ]);
    expect(procName("/opt/homebrew/bin/opencode serve --port 1")).toBe("opencode");
    expect(procName("npx -y @agentclientprotocol/claude-agent-acp")).toBe("@agentclientprotocol/claude-agent-acp");
  });

  it("reads this machine (and on macOS/Linux, its own process tree)", async () => {
    const r = await resources();
    expect(r.machine.totalGb).toBeGreaterThan(0);
    expect(r.machine.freePct).toBeGreaterThanOrEqual(0);
    expect(r.daemon.rssMb).toBeGreaterThan(0);
    expect(Array.isArray(r.groups)).toBe(true);
    if (process.platform !== "win32") expect(r.note).toBeUndefined();
  });
});
