/**
 * Native continuity on OpenCode — the protocol and acceptance fixtures the
 * Brain release gate asks for before OpenCode is enabled (BRAIN-TODO P5).
 *
 * The real OpenCodeAdapter and ContinuityEngine run against a fake
 * `opencode serve` (test/opencode-fake.ts) whose endpoints and event shapes
 * were recorded from opencode 1.18.31. Only the model is faked.
 */

import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EventLog } from "../src/core/eventlog.js";
import { ContinuityEngine } from "../src/core/continuity/engine.js";
import { NativeDispatchRejected, NativeQuiescenceUnknown, NativeSessionMissing } from "../src/core/continuity/contracts.js";
import { HarnessMonitor, isNativeKind, NATIVE_KINDS } from "../src/core/continuity/capabilities.js";
import { OpenCodeAdapter } from "../src/adapters/opencode.js";
import { ProjectRuntime } from "../src/daemon/runtime.js";
import type { LoomEvent } from "../src/types.js";
import { makeProjectDir, waitUntil } from "./helpers.js";
import { fakeOpenCode, type FakeOpenCode } from "./opencode-fake.js";

const open: Array<{ close: () => void | Promise<void> }> = [];
afterEach(async () => { for (const item of open.splice(0).reverse()) await item.close(); });

async function setup(fakeOpts: Parameters<typeof fakeOpenCode>[0] = {}) {
  const dir = makeProjectDir(), log = await EventLog.open(path.join(dir, ".loom")); open.push(log);
  const server = await fakeOpenCode(fakeOpts); open.push(server);
  return { dir, log, brain: new ContinuityEngine(log, "project"), server };
}
const request = (brain: ContinuityEngine, text = "continue", chat = "main") => brain.capture({
  id: crypto.randomUUID(), conversationId: chat, agentInstanceId: "oc", text, source: "user", model: null, plan: false, targetAddedTokens: 6000 }).request;

/** One continuity turn through the real adapter; returns the packet and what was logged. */
async function turn(brain: ContinuityEngine, log: EventLog, dir: string, server: FakeOpenCode, text: string, options: Record<string, unknown> = {}) {
  const req = request(brain, text);
  const opts = { baseUrl: server.url, pollMs: 20, ...options };
  const prepared = await brain.prepare(req, "opencode", dir, opts);
  const continuity = await brain.submit(prepared);
  const adapter = new OpenCodeAdapter("oc", dir, opts);
  const events: LoomEvent[] = [];
  adapter.onEvent((e) => {
    const logged = log.append({ ...e, agentId: "oc", chat: req.conversationId });
    events.push(logged);
    brain.ingest(logged);
  });
  let error: unknown;
  try { await adapter.send({ text, continuity }); }
  catch (err) { error = err; }
  brain.settled(continuity.runId, error);
  const during = [...events];
  await adapter.stop();
  return { prepared, events: during, error, receipt: brain.store.receipts(req.id).at(-1)! };
}

describe("OpenCode native continuity", () => {
  it("is a native harness with a pinned protocol profile", () => {
    expect(isNativeKind("opencode")).toBe(true);
    expect(NATIVE_KINDS).toEqual(expect.arrayContaining(["codex", "claude-code", "opencode"]));
  });

  it("starts a session, reports it, and is accepted on admission", async () => {
    const { dir, log, brain, server } = await setup({ reply: "pong" });
    const { prepared, events, error, receipt } = await turn(brain, log, dir, server, "Reply with pong");
    expect(error).toBeUndefined();
    expect(server.created).toHaveLength(1); // the chat's — starting the adapter leaves no empty session behind
    const session = server.prompts[0]!.session;
    expect(events.find((e) => e.kind === "status" && e.payload.state === "turn_started")!.payload.session).toBe(session);
    expect(events.some((e) => e.kind === "status" && e.payload.state === "native_turn_accepted")).toBe(true);
    // the packet rides in front of the prompt, the request text last
    expect(server.prompts[0]!.text).toContain(prepared.rendered.text);
    expect(server.prompts[0]!.text.endsWith("Reply with pong")).toBe(true);
    expect(events.find((e) => e.kind === "message")!.payload.text).toBe("pong");
    // every event of the run carries its correlation
    expect(events.every((e) => e.payload.loomRunId === receipt.runId)).toBe(true);
    expect(receipt).toMatchObject({ status: "accepted", execution: "complete" });
    expect(brain.store.bindingById(prepared.packet.target.id)!.nativeSessionId).toBe(session);
  });

  it("resumes the bound session with only what it lacks", async () => {
    const { dir, log, brain, server } = await setup();
    const first = await turn(brain, log, dir, server, "Use SQLite for the store");
    const second = await turn(brain, log, dir, server, "Now add an index");
    expect(second.prepared.packet.mode).toBe("delta");
    expect(server.prompts.map((p) => p.session)).toEqual([server.prompts[0]!.session, server.prompts[0]!.session]);
    expect(second.prepared.packet.target.nativeSessionId).toBe(server.prompts[0]!.session);
    expect(second.prepared.packet.target.id).toBe(first.prepared.packet.target.id);
    expect(second.receipt).toMatchObject({ status: "accepted", execution: "complete" });
  });

  it("switches the session's model in place rather than starting over", async () => {
    const { dir, log, brain, server } = await setup();
    await turn(brain, log, dir, server, "first", { model: "opencode/big-pickle" });
    await turn(brain, log, dir, server, "second", { model: "opencode/other-free" });
    const session = server.prompts[0]!.session;
    expect(server.prompts[1]!.session).toBe(session);
    expect(server.modelSwitches).toEqual([{ session, model: { providerID: "opencode", id: "other-free" } }]);
  });

  it("a session opencode forgot is NativeSessionMissing, and the next turn rebuilds in a new one", async () => {
    const { dir, log, brain, server } = await setup();
    const first = await turn(brain, log, dir, server, "Remember: tabs, not spaces");
    const session = server.prompts[0]!.session;
    server.forget(session);
    const lost = await turn(brain, log, dir, server, "carry on");
    expect(lost.error).toBeInstanceOf(NativeSessionMissing);
    expect(server.prompts).toHaveLength(1); // nothing was sent to a session that isn't there
    expect(lost.receipt).toMatchObject({ status: "failed" });
    const binding = brain.store.bindingById(first.prepared.packet.target.id)!;
    expect(binding).toMatchObject({ nativeSessionId: null, sessionEpoch: 2 });
    const rebuilt = await turn(brain, log, dir, server, "carry on");
    expect(rebuilt.prepared.packet.mode).toBe("reconstruction");
    expect(rebuilt.prepared.rendered.text).toContain("tabs, not spaces");
    expect(server.prompts.at(-1)!.session).not.toBe(session);
    expect(rebuilt.receipt).toMatchObject({ status: "accepted", execution: "complete" });
  });

  it("a refused prompt is a proven non-launch, and leaves no writer lease behind", async () => {
    const { dir, log, brain, server } = await setup({ refusePrompt: 500 });
    const refused = await turn(brain, log, dir, server, "try");
    expect(refused.error).toBeInstanceOf(NativeDispatchRejected);
    expect(refused.receipt).toMatchObject({ status: "failed", execution: "failed" });
    server.opts.refusePrompt = undefined;
    const next = await turn(brain, log, dir, server, "try again");
    expect(next.receipt).toMatchObject({ status: "accepted", execution: "complete" });
  });

  it("a session opencode still lists as active is accepted but its quiescence is unknown", async () => {
    const { dir, log, brain, server } = await setup({ stuck: true });
    const stuck = await turn(brain, log, dir, server, "long job", { turnTimeoutMs: 300 });
    expect(stuck.error).toBeInstanceOf(NativeQuiescenceUnknown);
    expect(stuck.receipt).toMatchObject({ status: "accepted", execution: "unknown" });
  });

  it("a failed turn is accepted work that failed, with the provider's reason", async () => {
    const { dir, log, brain, server } = await setup({ fail: "Model is unavailable" });
    const failed = await turn(brain, log, dir, server, "go");
    expect(failed.events.find((e) => e.kind === "error")!.payload.message).toBe("Model is unavailable");
    expect(failed.receipt).toMatchObject({ status: "accepted", execution: "failed" });
  });

  it("reports tool calls and compaction, and a compacted session gets a full rebuild next", async () => {
    const { dir, log, brain, server } = await setup({ compact: true, tool: { tool: "bash", input: { command: "npm test", description: "Run tests" } } });
    const first = await turn(brain, log, dir, server, "run the tests");
    expect(first.events.find((e) => e.kind === "tool_call")!.payload).toMatchObject({ tool: "bash", summary: "Run tests", loomRunId: first.receipt.runId });
    expect(first.events.filter((e) => e.kind === "status" && e.payload.state === "native_compacted")).toHaveLength(1);
    expect(brain.store.bindingById(first.prepared.packet.target.id)!.retention).toBe("compacted");
    server.opts.compact = false;
    const next = await turn(brain, log, dir, server, "and now?");
    expect(next.prepared.packet.mode).toBe("reconstruction");
    expect(server.prompts[1]!.session).toBe(server.prompts[0]!.session); // same session, rebuilt state
  });

  it("probes an opencode agent pointed at a running server by that server's health", async () => {
    const server = await fakeOpenCode(); open.push(server);
    const monitor = new HarnessMonitor(() => [{ id: "oc", kind: "opencode", options: { baseUrl: server.url } }]);
    expect(await monitor.ensure("oc")).toMatchObject({ kind: "opencode", available: true });
    await server.close(); open.pop();
    const down = new HarnessMonitor(() => [{ id: "oc", kind: "opencode", options: { baseUrl: server.url } }]);
    expect(await down.ensure("oc")).toMatchObject({ available: false });
  });
});

describe("OpenCode without continuity", () => {
  it("waits out a step that ended in tool calls instead of ending the turn there", async () => {
    const dir = makeProjectDir();
    const server = await fakeOpenCode({ reply: "the real answer", stepGapMs: 400 }); open.push(server);
    const adapter = new OpenCodeAdapter("oc", dir, { baseUrl: server.url, pollMs: 50 });
    const events: Array<{ kind: string; payload: Record<string, unknown> }> = [];
    adapter.onEvent((e) => events.push(e));
    await adapter.send({ text: "look around, then answer" });
    const during = [...events];
    await adapter.stop();
    expect(during.filter((e) => e.kind === "message").map((e) => e.payload.text)).toContain("the real answer");
    expect(during.at(-1)!.kind).toBe("run_complete");
  });
});

describe("OpenCode without continuity: interrupting a turn that never answered", () => {
  it("ends the turn as interrupted instead of waiting out the hour", async () => {
    const dir = makeProjectDir();
    const server = await fakeOpenCode({ stuck: true }); open.push(server);
    const adapter = new OpenCodeAdapter("oc", dir, { baseUrl: server.url, pollMs: 30 });
    const events: Array<{ kind: string; payload: Record<string, unknown> }> = [];
    adapter.onEvent((e) => events.push(e));
    const sending = adapter.send({ text: "hello?" });
    await waitUntil(() => server.prompts.length === 1);
    const t0 = Date.now();
    await adapter.interrupt();
    await sending;
    expect(Date.now() - t0).toBeLessThan(3000);
    expect(events.some((e) => e.kind === "status" && e.payload.state === "interrupted")).toBe(true);
    expect(events.some((e) => e.kind === "error")).toBe(false);
    await adapter.stop();
  });
});

describe("OpenCode through the project runtime with continuity on", () => {
  it("sends a continuity turn to OpenCode instead of refusing it", async () => {
    const server = await fakeOpenCode({ reply: "from the runtime" }); open.push(server);
    const dir = makeProjectDir({
      brain: { continuity: true, extractor: "off" },
      agents: [{ id: "oc", kind: "opencode", options: { baseUrl: server.url, pollMs: 20 } }],
    });
    const rt = await ProjectRuntime.open({ id: `oc-${path.basename(dir)}`, name: "oc", dir });
    open.push(rt);
    const sent = await rt.sendMessage("hello opencode", "oc");
    expect(sent.continuityStatus).toBe("submitting");
    await waitUntil(() => rt.log.list({ kinds: ["run_complete"] }).some((e) => e.agentId === "oc"), { timeoutMs: 10_000 });
    const reply = rt.log.list({ kinds: ["message"] }).find((e) => e.agentId === "oc");
    expect(reply?.payload.text).toBe("from the runtime");
    await waitUntil(() => rt.continuity!.store.receipts().at(-1)?.execution === "complete", { timeoutMs: 10_000 });
    expect(rt.continuity!.store.receipts().at(-1)).toMatchObject({ status: "accepted", execution: "complete" });
  });
});
