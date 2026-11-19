import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Command } from "commander";
import { tmpDir } from "./helpers.js";
import { readSettings, writeSettings } from "../src/core/agentic-r4/state.js";
import { logbook } from "../src/core/logbook.js";
import { recentToolCalls } from "../src/core/agentic-r4/call-log.js";
import type { LoomEvent } from "../src/types.js";
import { consult } from "../src/core/agentic-r4/consult.js";
import { registerAgenticCli } from "../src/cli/r4-agentic.js";
import { mcpRequest } from "../src/core/mcp-server.js";
import { DaemonError } from "../src/daemon/client.js";

const mocks = vi.hoisted(() => ({ ensureDaemon: vi.fn(), modelOptions: vi.fn() }));
vi.mock("../src/daemon/client.js", async importOriginal => ({ ...await importOriginal<object>(), ensureDaemon: mocks.ensureDaemon }));
vi.mock("../src/adapters/model.js", () => ({ ModelAdapter: class {
  constructor(_id: string, _dir: string, options: unknown) { mocks.modelOptions(options); }
  onEvent() { return () => {}; }
  async start() {}
  async send() {}
  async interrupt() {}
  async stop() {}
} }));
afterEach(() => { vi.restoreAllMocks(); mocks.ensureDaemon.mockReset(); mocks.modelOptions.mockReset(); });

describe("review regressions", () => {
  it("preserves model provider, fallbacks and system options while enforcing read-only limits", async () => {
    const options = { provider: "agentrouter", model: "glm-4.6", fallbacks: ["glm-4.5"], system: "Consultant system", tools: true, write: true, run: ["shell"], maxTokens: 99999 };
    const rt = {
      config: { agents: [{ id: "glm", kind: "model", options }] }, info: { dir: tmpDir("r4-model") },
      status: async () => ({ agents: [{ id: "other", busy: true, chat: "c2" }, { id: "asker", busy: true, chat: "c2" }] }), budgetStatus: () => ({}),
      log: { list: () => [], append: vi.fn(), onEvent: () => () => {} },
    } as any;
    for (const override of [undefined, "glm-4.7"]) {
      await consult(rt, { agent: "glm", model: override, question: "read only?" }, { project: "p", api: "local", agent: "asker", chat: "c2" });
      expect(mocks.modelOptions).toHaveBeenLastCalledWith({ ...options, model: override ?? options.model, readOnly: true, tools: false, write: false, run: [], maxTokens: 4096 });
    }
    expect(rt.log.append.mock.calls.filter(([event]: any[]) => event.payload.state === "turn_cost").every(([event]: any[]) => event.agentId === "asker" && event.chat === "c2")).toBe(true);
  });

  it("recovers invalid settings and validates fields independently", () => {
    vi.stubEnv("LOOM_HOME", tmpDir("r4-settings"));
    const file = path.join(process.env.LOOM_HOME!, "agentic-p.json");
    const warning = vi.spyOn(logbook, "warn").mockImplementation(() => ({} as any));
    try {
      expect(readSettings("p")).toEqual({ disabledTools: [], hooks: false });
      fs.writeFileSync(file, '{"hooks":');
      expect(readSettings("p")).toEqual({ disabledTools: [], hooks: false });
      expect(warning).toHaveBeenCalledWith("agentic", expect.any(String), expect.any(String), "p");
      for (const [input, expected] of [
        [null, { disabledTools: [], hooks: false }],
        [{ disabledTools: "loom_costs", hooks: true }, { disabledTools: [], hooks: true }],
        [{ disabledTools: ["loom_costs", 12, null], hooks: "true" }, { disabledTools: ["loom_costs"], hooks: false }],
      ]) {
        fs.writeFileSync(file, JSON.stringify(input));
        expect(readSettings("p")).toEqual(expected);
      }
      fs.writeFileSync(file, "{");
      expect(writeSettings("p", { disabledTools: ["loom_review"] })).toEqual({ disabledTools: ["loom_review"], hooks: false });
      expect(readSettings("p").disabledTools).toEqual(["loom_review"]);
    } finally { vi.unstubAllEnvs(); }
  });

  it("pages recent calls backwards, returns chronological rows and stops at the requested count", () => {
    const events: LoomEvent[] = Array.from({ length: 6000 }, (_, i) => ({ id: i + 1, ts: i, kind: "status", payload: { state: [1999, 3999, 5999].includes(i) ? "mcp_call" : "turn_cost", actor: "agent" } }));
    const list = vi.fn((opts: any) => events.filter(e => opts.before === undefined || e.id < opts.before).slice(-opts.limit));
    expect(recentToolCalls({ list }, 2).map(c => c.id)).toEqual([4000, 6000]);
    expect(list.mock.calls).toEqual([[{ kinds: ["status"], limit: 2000 }], [{ kinds: ["status"], limit: 2000, before: 4001 }]]);
    list.mockClear();
    expect(recentToolCalls({ list }, 10).map(c => c.id)).toEqual([2000, 4000, 6000]);
    expect(list).toHaveBeenCalledTimes(4);
  });

  it("caps sparse history scans at ten chunks", () => {
    const list = vi.fn((opts: any) => Array.from({ length: 2000 }, (_, i) => ({ id: (opts.before ?? 100001) - 2000 + i, ts: 0, kind: "status" as const, payload: { state: "turn_cost" } })));
    expect(recentToolCalls({ list }, 100)).toEqual([]);
    expect(list).toHaveBeenCalledTimes(10);
    expect(list.mock.calls.every(([opts]) => opts.limit === 2000)).toBe(true);
  });

  it.each([
    ["api", "GET", "/api/projects"], ["mcp:log", "--project", "p"],
    ["hooks", "list", "--project", "p"], ["hooks", "enable", "--project", "p"],
    ["hooks", "disable", "--project", "p"], ["hooks", "test", "turn-finished", "--project", "p"],
    ["skill:from-chat", "main", "draft", "--project", "p"], ["wait", "main", "--project", "p", "--json"],
  ])("awaits daemon readiness for %s %s", async (...args: string[]) => {
    const api = vi.fn(async (_method: string, route: string) => route.endsWith("/chats") ? { chats: [{ id: "main" }] }
      : route.endsWith("/orchestra") ? { runs: [] } : route.includes("/events?") ? { events: [] }
      : route.endsWith("/queue") ? { queue: [] } : route === "/api/projects/p" ? { project: { agents: [] } } : { code: 0 });
    let ready!: (value: unknown) => void;
    mocks.ensureDaemon.mockReturnValue(new Promise(resolve => { ready = resolve; }));
    const output = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = new Command(); registerAgenticCli(program);
    const previous = process.exitCode;
    try {
      const pending = program.parseAsync(args, { from: "user" });
      expect(mocks.ensureDaemon).toHaveBeenCalledOnce();
      expect(api).not.toHaveBeenCalled();
      ready({ api, project: async () => ({ project: { id: "p" } }) });
      await pending;
      expect(api).toHaveBeenCalled(); expect(output).toHaveBeenCalledOnce();
    } finally { process.exitCode = previous; }
  });

  it("keeps skill lint local without starting a daemon", async () => {
    const dir = tmpDir("r4-local-lint");
    fs.writeFileSync(path.join(dir, "SKILL.md"), "---\nname: local\ndescription: Local skill\n---\nSteps\n");
    vi.spyOn(console, "log").mockImplementation(() => {});
    const program = new Command(); registerAgenticCli(program);
    await program.parseAsync(["skill:lint", dir], { from: "user" });
    expect(mocks.ensureDaemon).not.toHaveBeenCalled();
  });

  it("does not hide prompt errors other than forbidden", async () => {
    const client = { api: vi.fn().mockRejectedValue(new DaemonError("broken", 500, { error: "broken" })) } as any;
    expect(await mcpRequest(client, { jsonrpc: "2.0", id: 1, method: "prompts/list" })).toMatchObject({ error: { code: -32602 } });
  });
});
