import { afterEach, expect, it, vi } from "vitest";
import { ProjectRuntime } from "../src/daemon/runtime.js";
import { loomToolScope, type LoomToolScope } from "../src/core/loom-tools.js";
import { consult } from "../src/core/agentic-r4/consult.js";
import { CODEX_OK, fakeCodex } from "./native-fakes.js";
import { makeProjectDir, tmpDir, waitUntil } from "./helpers.js";
import type { SendInput } from "../src/types.js";

let rt: ProjectRuntime | undefined;
afterEach(async () => { await rt?.close(); rt = undefined; vi.restoreAllMocks(); vi.unstubAllEnvs(); });

it("native continuity credentials identify the asking agent and non-main chat before any hook listener", async () => {
  vi.stubEnv("LOOM_HOME", tmpDir("r4-native-home"));
  const bin = fakeCodex({ script: [{ sleep: 1000 }, ...CODEX_OK] });
  const dir = makeProjectDir({ brain: { continuity: true, extractor: "off" }, agents: [
    { id: "codex", kind: "codex", options: { bin } }, { id: "helper", kind: "echo" },
  ] });
  rt = await ProjectRuntime.open({ id: "r4-native", name: "native", dir });
  rt.config.loomTools = true;
  rt.apiUrl = "http://127.0.0.1:1";
  const chat = rt.createChat("c2", { agentId: "codex" });
  const agent = rt.agent("codex")!, original = agent.send.bind(agent);
  let token: string | undefined, scope: LoomToolScope | undefined;
  vi.spyOn(agent, "send").mockImplementation(async (input: SendInput) => {
    token = (input.mcp?.servers.find(s => s.key === "loom")?.entry as any)?.env?.LOOM_MCP_TOKEN;
    scope = loomToolScope(token);
    return original(input);
  });
  await rt.sendMessage("native asking turn", "codex", { chat: chat.id });
  await waitUntil(() => !!scope);
  expect(scope).toMatchObject({ agent: "codex", chat: chat.id, alive: true });
  expect(rt.log.list().some(e => e.payload.state === "mcp_attached")).toBe(false);
  expect((await consult(rt, { agent: "helper", question: "side question" }, scope)).reply).toContain("side question");
  expect(rt.log.list({ chat: chat.id }).some(e => e.agentId === "codex" && e.payload.source === "consult")).toBe(true);
  expect(rt.log.list({ chat: "main" }).some(e => e.payload.consult)).toBe(false);
  await waitUntil(() => !rt!.anyBusy());
  expect(scope?.alive).toBe(false);
  expect(loomToolScope(token)).toBeUndefined();
});
