import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ProjectRuntime } from "../src/daemon/runtime.js";
import * as routing from "../src/core/model-routing.js";
import { registerProject } from "../src/core/registry.js";
import { isAdapter } from "../src/types.js";
import { makeProjectDir, tmpDir, waitUntil } from "./helpers.js";

let runtime: ProjectRuntime;
beforeEach(async () => {
  vi.stubEnv("LOOM_HOME", tmpDir("r3-regressions"));
  vi.stubEnv("LOOM_NO_NOTIFY", "1");
  const dir = makeProjectDir({ agents: [{ id: "echo", kind: "echo", options: { model: "default-model", effort: "medium" } }] });
  runtime = await ProjectRuntime.open(registerProject(dir, "routing"));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await runtime.close();
  vi.unstubAllEnvs();
});

it("resolves aliases and applies a live project effort default below turn, chat and agent choices", async () => {
  routing.writeModelRouting({ aliases: { fast: "echo-fast" }, caps: {}, mondayDigest: false });
  runtime.patchConfig({ defaultEffort: "high" });
  runtime.setAgentOptions("echo", { effort: "" });
  runtime.setAgentModel("echo", "fast");
  await runtime.sendMessage("project default");
  await waitUntil(() => runtime.log.list({ kinds: ["run_complete"] }).length === 1);
  const chat = runtime.createChat("override", { agentId: "echo", model: "fast", effort: "low" });
  await runtime.sendMessage("chat", undefined, { chat: chat.id });
  await waitUntil(() => runtime.log.list({ kinds: ["run_complete"] }).length === 2);
  await runtime.sendMessage("turn", undefined, { chat: chat.id, effort: "max" });
  await waitUntil(() => runtime.log.list({ kinds: ["run_complete"] }).length === 3);
  runtime.setAgentOptions("echo", { effort: "medium" });
  await runtime.sendMessage("agent");
  await waitUntil(() => runtime.log.list({ kinds: ["run_complete"] }).length === 4);
  expect(runtime.log.list({ kinds: ["run_complete"] }).map(e => [e.payload.model, e.payload.effort])).toEqual([
    ["echo-fast", "high"], ["echo-fast", "low"], ["echo-fast", "max"], ["echo-fast", "medium"],
  ]);
});

it("owns asynchronous cap preparation and releases a refused turn without logging its prompt", async () => {
  let reject!: (error: Error) => void;
  const check = new Promise<void>((_, no) => { reject = no; });
  vi.spyOn(routing, "enforceModelCap").mockReturnValueOnce(check);
  const pending = runtime.sendMessage("refused prompt");
  const refused = expect(pending).rejects.toThrow("daily model cap");
  expect(() => runtime.setAgentModel("echo", "replacement")).toThrow(/mid-turn/);
  expect(() => runtime.patchConfig({ brain: { continuity: true } })).toThrow(/finish or reconcile/);
  reject(new Error("daily model cap"));
  await refused;
  expect(runtime.log.list({ kinds: ["message"] })).toHaveLength(0);
  expect(() => runtime.setAgentModel("echo", "replacement")).not.toThrow();
  await runtime.sendMessage("accepted prompt");
  await waitUntil(() => runtime.log.list({ kinds: ["run_complete"] }).length === 1);
});

it("marks independent adapter sends busy during cap reads and clears a refused preparation", async () => {
  const agent = runtime.agent("echo");
  if (!isAdapter(agent)) throw new Error("expected adapter");
  let reject!: (error: Error) => void;
  vi.spyOn(routing, "enforceModelCap").mockReturnValueOnce(new Promise<void>((_, no) => { reject = no; }));
  const pending = agent.send({ text: "independent" });
  const refused = expect(pending).rejects.toThrow("daily model cap");
  expect(agent.busy()).toBe(true);
  expect(() => runtime.patchConfig({ brain: { continuity: true } })).toThrow(/finish or reconcile/);
  reject(new Error("daily model cap"));
  await refused;
  expect(agent.busy()).toBe(false);
});

it("preserves queued selections across restart and checks caps against the captured selection", async () => {
  const chat = runtime.createChat("review", { agentId: "echo", model: "chat-model", effort: "low" });
  runtime.queue.setPaused(true);
  await runtime.sendMessage("sleep:200", undefined, { chat: chat.id });
  await runtime.sendMessage("explicit", undefined, { chat: chat.id, model: "queued-model", effort: "max" });
  await runtime.sendMessage("inherited", undefined, { chat: chat.id });
  runtime.setChatAgent(chat.id, "echo");
  await runtime.sendMessage("default", undefined, { chat: chat.id });
  runtime.setChatAgent(chat.id, "echo", "new-model", "high");
  const waiting = runtime.queue.snapshot().items;
  expect(waiting.map(i => [i.model, i.effort])).toEqual([
    ["queued-model", "max"], ["chat-model", "low"], [null, null],
  ]);
  await waitUntil(() => runtime.log.list({ kinds: ["run_complete"] }).length === 1);
  const info = runtime.info;
  await runtime.close();
  runtime = await ProjectRuntime.open(info);
  expect(runtime.queue.snapshot().items).toEqual(waiting);
  // The edited chat is capped, but none of the queued prompts selected it.
  routing.recordModelUsage("new-model", { prompt_tokens: 1 });
  routing.writeModelRouting({ aliases: {}, caps: { "new-model": { tokens: 1 } }, mondayDigest: false });
  runtime.queue.setPaused(false);
  await runtime.drainPromptQueue();
  await waitUntil(() => runtime.log.list({ kinds: ["run_complete"] }).length === 4);
  expect(runtime.log.list({ kinds: ["run_complete"] }).map(e => [e.payload.model, e.payload.effort])).toEqual([
    ["chat-model", "low"], ["queued-model", "max"], ["chat-model", "low"], ["default-model", "medium"],
  ]);
  const before = runtime.log.list({ kinds: ["message"] }).length;
  await expect(runtime.sendMessage("capped", undefined, { chat: chat.id })).rejects.toThrow(/daily model cap/);
  expect(runtime.log.list({ kinds: ["message"] })).toHaveLength(before);
});
