import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EventLog } from "../src/core/eventlog.js";
import { ContinuityEngine, renderPacket, estimateTokens } from "../src/core/continuity/engine.js";
import { ContextPacketV1, digest, parseBounded, RequestV1, NativeDispatchRejected, NativeQuiescenceUnknown, NativeSessionMissing, type ContextItem } from "../src/core/continuity/contracts.js";
import { ClaudeCodeAdapter } from "../src/providers/agent.js";
import { CodexAdapter } from "../src/providers/agent.js";
import { ProjectRuntime } from "../src/daemon/runtime.js";
import { RuntimeAgents } from "../src/daemon/runtime/agents.js";
import { AdapterBase } from "../src/adapters/base.js";
import { ContextArtifacts } from "../src/core/continuity/artifacts.js";
import { HarnessMonitor } from "../src/core/continuity/capabilities.js";
import { makeProjectDir, tmpDir, waitUntil } from "./helpers.js";
import type { SendInput } from "../src/types.js";
import { CLAUDE_OK, CODEX_OK, callsOf, claudeInit, claudeInitOf, claudePromptOf, claudeResult, claudeText, fakeClaude, fakeCodex, rpcOf, turnsOf } from "./native-fakes.js";

const open: Array<{ close: () => void | Promise<void> }> = [];
afterEach(async () => { for (const item of open.splice(0).reverse()) await item.close(); });
async function setup() {
  const dir = makeProjectDir(), log = await EventLog.open(path.join(dir, ".loom")); open.push(log);
  return { dir, log, brain: new ContinuityEngine(log, "project") };
}
const request = (brain: ContinuityEngine, text = "continue", id = crypto.randomUUID(), chat = "main", agent = "claude") => brain.capture({
  id, conversationId: chat, agentInstanceId: agent, text, source: "user", model: null, plan: false, targetAddedTokens: 6000 }).request;
/** A user message already in the conversation (sent earlier, or before native mode). */
const say = (log: EventLog, text: string, chat?: string) => log.append({ kind: "message", ...(chat ? { chat } : {}), payload: { text, author: "user" } });
/** A native harness fake that completes one ordinary turn, optionally after a delay. */
const fakeCli = (kind: "codex" | "claude", delay = 0): string => kind === "claude"
  ? fakeClaude({ script: delay ? [{ sleep: delay }, ...CLAUDE_OK] : CLAUDE_OK })
  : fakeCodex({ script: delay ? [{ sleep: delay }, ...CODEX_OK] : CODEX_OK });
const calls = callsOf;
async function runNative(brain: ContinuityEngine, log: EventLog, dir: string, req: ReturnType<typeof request>, kind: "claude-code" | "codex", bin: string) {
  const prepared = await brain.prepare(req, kind, dir, { bin });
  const continuity = await brain.submit(prepared);
  const adapter = kind === "codex" ? new CodexAdapter(req.agentInstanceId, dir, { bin }) : new ClaudeCodeAdapter(req.agentInstanceId, dir, { bin });
  adapter.onEvent(e => brain.ingest(log.append({ ...e, agentId: req.agentInstanceId, chat: req.conversationId })));
  try { await adapter.send({ text: req.text, continuity }); }
  catch (error) { brain.settled(continuity.runId, error); throw error; }
  brain.settled(continuity.runId);
  return prepared;
}

describe("Brain continuity contracts and evidence", () => {
  it("rejects unknown versions, extra keys, coercions, oversize and deep JSON", () => {
    expect(() => parseBounded(ContextPacketV1, { version: 2 })).toThrow();
    const valid = { id: "x", conversationId: "main", agentInstanceId: "a", text: "x", source: "user", model: null, plan: false, targetAddedTokens: 6000 };
    expect(() => parseBounded(RequestV1, { ...valid, plan: "false" })).toThrow();
    expect(() => parseBounded(RequestV1, { ...valid, extra: true })).toThrow();
    expect(() => parseBounded(RequestV1, { ...valid, text: "x".repeat(4_000_001) })).toThrow(/4 MB/);
    let nested: unknown = {}; for (let i = 0; i < 40; i++) nested = { nested };
    expect(() => parseBounded(RequestV1, nested)).toThrow(/deep/);
  });
  it("captures the original request transactionally once; conflicts survive reopening", async () => {
    const { log, brain, dir } = await setup();
    let observed = 0; log.onEvent(() => observed++);
    const req = request(brain, "Keep the tiny preference: tabs.", "stable");
    expect(brain.capture(req).created).toBe(false);
    expect(log.list()).toHaveLength(1); expect(observed).toBe(1);
    expect(() => request(brain, "spaces", "stable")).toThrow(/different content/);
    log.close(); const again = await EventLog.open(path.join(dir, ".loom")); open.push(again);
    const reopened = new ContinuityEngine(again, "project");
    expect(reopened.capture(req).created).toBe(false);
  });
  it("checks project/chat hashes and exact UTF-8 byte boundaries", async () => {
    const { log, brain } = await setup(); request(brain, "a😀é", "s");
    const source = brain.store.source(log.list()[0]!, "project");
    expect(brain.readSource({ ...source, span: { start: 1, end: 5 } }, "main")).toBe("😀");
    expect(() => brain.readSource({ ...source, span: { start: 2, end: 5 } }, "main")).toThrow(/UTF-8/);
    expect(() => brain.readSource({ ...source, projectId: "other" }, "main")).toThrow(/project/);
    expect(() => brain.readSource(source, "private")).toThrow(/conversation/);
    expect(() => brain.readSource({ ...source, hash: digest("wrong") }, "main")).toThrow(/hash/);
  });
  it("keeps buried small decisions and tentative discussion regardless of retrieval rank", async () => {
    const { log, brain, dir } = await setup();
    say(log, "Maybe SQLite? Not accepted yet. Also retain keyboard focus.");
    for (let i = 0; i < 400; i++) log.append({ kind: "message", agentId: "codex", payload: { text: `output ${i}` } });
    request(brain, "Private conversation content", "private", "private");
    const prepared = await brain.prepare(request(brain), "claude-code", dir, {});
    expect(prepared.rendered.text).toContain("retain keyboard focus");
    expect(prepared.rendered.text).not.toContain("Private conversation");
    expect(prepared.rendered.text).not.toContain("authoritative");
    expect(prepared.packet.coverage.some(c => c.source.eventId === 1 && c.disposition === "exact")).toBe(true);
    const tampered = structuredClone(prepared.packet); tampered.messages = [];
    tampered.budget.estimatedAddedTokens = estimateTokens(`${renderPacket(tampered).text}\n\n${brain.store.request(prepared.packet.requestId)!.text}`);
    expect(() => brain.validate(tampered, renderPacket(tampered))).toThrow(/mandatory|coverage/);
  });
  it("never promotes helper claims and supports reviewed correction/supersession", async () => {
    const { brain, log, dir } = await setup();
    const first = request(brain, "Use JSONL", "first"), e = brain.store.requestEvent(first.id)!;
    const original: ContextItem = { id: "storage", revision: 1, conversationId: "main", kind: "decision", text: "Use JSONL",
      origin: "user", status: "accepted", sources: [brain.store.source(e, "project")], supersedes: null };
    brain.putItem(original);
    expect(() => brain.putItem({ ...original, id: "fake", origin: "derived" })).toThrow(/promote/);
    const corrected = request(brain, "Correction: SQLite now", "correction");
    brain.putItem({ ...original, id: "storage-correction", kind: "correction", text: "Use SQLite", sources: [brain.store.source(brain.store.requestEvent(corrected.id)!, "project")], supersedes: { id: "storage", revision: 1 } });
    expect(brain.store.items("main").find(i => i.id === "storage")?.status).toBe("superseded");
    const prepared = await brain.prepare(request(brain), "codex", dir, {});
    expect(prepared.rendered.text).toContain("Use SQLite");
    expect(() => brain.putItem({ ...original, revision: 4 })).toThrow(/revision/);
    const agent = log.append({ kind: "message", agentId: "codex", payload: { text: "tests passed" } });
    expect(() => brain.putItem({ ...original, id: "false-user", sources: [brain.store.source(agent, "project")] })).toThrow(/user evidence/);
  });
  it("uses explicit source-backed checkpoints without destroying originals", async () => {
    const { brain, dir } = await setup();
    request(brain, "Discussion with tiny preference: avoid telemetry.", "talk");
    const e = brain.store.requestEvent("talk")!, source = brain.store.source(e, "project");
    brain.putItem({ id: "checkpoint", revision: 1, conversationId: "main", kind: "instruction", text: "Avoid telemetry", origin: "user", status: "accepted", sources: [source], supersedes: null });
    brain.store.dispose(e.id, "main", "checkpoint");
    const prepared = await brain.prepare(request(brain), "codex", dir, {});
    expect(prepared.packet.messages.some(m => m.source.eventId === e.id)).toBe(false);
    expect(prepared.packet.coverage.find(c => c.source.eventId === e.id)?.disposition).toBe("summarized");
    expect(brain.readSource(source, "main")).toContain("tiny preference");
  });
  it("parameterizes FTS syntax and scopes evidence", async () => {
    const { brain, log } = await setup();
    log.append({ kind: "message", agentId: "a", chat: "private", payload: { text: "authentication secret" } });
    log.append({ kind: "message", agentId: "a", payload: { text: "authentication JWT" } });
    expect(brain.store.search("main", 'authentication" OR * NOT (')).toHaveLength(1);
    expect(brain.store.search("main", "' ; DROP TABLE events; --")).toBeInstanceOf(Array);
    expect(log.list()).toHaveLength(2);
  });
});

describe("Brain cleanup regressions", () => {
  it("includes a large current request in mandatory overflow without truncation", async () => {
    const { brain, dir } = await setup(), req = request(brain, "😀".repeat(6000));
    const prepared = await brain.prepare(req, "codex", dir, {});
    expect(prepared.packet.budget.overflow).toBe("mandatory");
    expect(prepared.packet.budget.estimatedAddedTokens).toBe(estimateTokens(`${prepared.rendered.text}\n\n${req.text}`));
    expect(brain.store.request(req.id)?.text).toBe(req.text);
    await expect(brain.submit(prepared)).rejects.toMatchObject({ code: "overflow" });
  });
  it("reactivates evidence removed from a checkpoint revision", async () => {
    const { brain, dir, log } = await setup();
    const first = brain.store.source(say(log, "Keep the original tiny preference"), "project");
    const second = brain.store.source(say(log, "second discussion"), "project");
    const item: ContextItem = { id: "review", revision: 1, conversationId: "main", kind: "topic", text: "Original preference", origin: "user", status: "tentative", sources: [first], supersedes: null };
    brain.putItem(item); brain.store.dispose(first.eventId, "main", item.id);
    brain.putItem({ ...item, revision: 2, text: "second discussion", sources: [second] });
    const prepared = await brain.prepare(request(brain), "codex", dir, {});
    expect(prepared.packet.messages.some(m => m.source.eventId === first.eventId)).toBe(true);
    expect(prepared.packet.coverage.find(c => c.source.eventId === first.eventId)?.disposition).toBe("exact");
    expect(brain.store.dispositions("main").has(first.eventId)).toBe(false);
  });
  it("rejects tentative or derived supersession of user decisions", async () => {
    const { brain } = await setup(); request(brain, "Use SQLite", "first");
    const item: ContextItem = { id: "decision", revision: 1, conversationId: "main", kind: "decision", text: "SQLite", origin: "user", status: "accepted", sources: [brain.store.source(brain.store.requestEvent("first")!, "project")], supersedes: null };
    brain.putItem(item);
    for (const origin of ["user", "derived"] as const) expect(() => brain.putItem({ ...item, id: origin, origin, status: "tentative", supersedes: { id: item.id, revision: 1 } })).toThrow(/supersession/);
    expect(brain.store.items("main")[0]?.status).toBe("accepted");
  });
  it("invalidates unsent packets on new user evidence and rejects mixed receipts", async () => {
    const { brain, dir, log } = await setup(), first = await brain.prepare(request(brain, "first"), "codex", dir, {});
    log.append({ kind: "decision", payload: { text: "Correction: preserve keyboard focus" } });
    await expect(brain.submit(first)).rejects.toMatchObject({ code: "stale" });
    const second = await brain.prepare(request(brain, "continue"), "codex", dir, {});
    expect(second.rendered.text).toContain("preserve keyboard focus");
    await expect(brain.submit({ ...second, receipt: first.receipt })).rejects.toMatchObject({ code: "invalid" });
    expect(brain.store.activeReceipts()).toHaveLength(0);
  });
  it("Stop during final submission observation cannot launch a native process", async () => {
    const bin = fakeCli("codex"), dir = makeProjectDir({ brain: { continuity: true }, agents: [{ id: "codex", kind: "codex", options: { bin } }] });
    const runtime = await ProjectRuntime.open({ id: "project", name: "test", dir }); open.push(runtime);
    const brain = runtime.continuity!, original = brain.submit.bind(brain);
    let entered = false, release!: () => void;
    const barrier = new Promise<void>(resolve => { release = resolve; });
    vi.spyOn(brain, "submit").mockImplementation(async (prepared, signal) => { entered = true; await barrier; return original(prepared, signal); });
    const sending = runtime.sendMessage("edit files", "codex", { requestId: "stopped" });
    const outcome = sending.catch(error => error);
    await waitUntil(() => entered); await runtime.interrupt(); release();
    expect(await outcome).toMatchObject({ code: "conflict" });
    expect(calls(bin)).toHaveLength(0);
    expect(brain.store.receipts("stopped").at(-1)?.status).toBe("prepared");
    expect(runtime.anyBusy()).toBe(false);
  });
  it("returns durable overflow when new governing evidence forces reassembly", async () => {
    const bin = fakeCli("codex"), dir = makeProjectDir({ brain: { continuity: true }, agents: [{ id: "codex", kind: "codex", options: { bin } }] });
    const runtime = await ProjectRuntime.open({ id: "project", name: "test", dir }); open.push(runtime);
    const brain = runtime.continuity!, original = brain.submit.bind(brain); let injected = false;
    vi.spyOn(brain, "submit").mockImplementation(async (prepared, signal) => {
      if (!injected) {
        injected = true;
        // A large reviewed item changes protected state after preparation.
        brain.putItem({ id: "new-governing", revision: 1, conversationId: "main", kind: "instruction", text: "Preserve this constraint. ".repeat(1200),
          origin: "user", status: "accepted", sources: [brain.store.source(brain.store.requestEvent("reassemble")!, "project")], supersedes: null });
      }
      return original(prepared, signal);
    });
    const result = await runtime.sendMessage("work", "codex", { requestId: "reassemble" });
    expect(result.continuityStatus).toBe("overflow"); expect(result.packetId).toBeTruthy();
    expect(calls(bin)).toHaveLength(0); expect(runtime.anyBusy()).toBe(false);
    expect(brain.store.receipts("reassemble").at(-1)?.status).toBe("prepared");
  });
  it("does not promote legacy auto-mined agent decisions to user authority", async () => {
    const { brain, log, dir } = await setup();
    const generated = log.append({ kind: "decision", payload: { text: "agent says use telemetry", author: "codex", auto: true } });
    const prepared = await brain.prepare(request(brain), "codex", dir, {});
    expect(prepared.packet.messages.some(m => m.source.eventId === generated.id)).toBe(false);
    expect(() => brain.putItem({ id: "fake-user", revision: 1, conversationId: "main", kind: "decision", text: "telemetry", origin: "user", status: "accepted", sources: [brain.store.source(generated, "project")], supersedes: null })).toThrow(/user evidence/);
  });
  it("holds the writer lease when accepted work cannot prove descendant termination", async () => {
    const { brain, log, dir } = await setup(), prepared = await brain.prepare(request(brain), "codex", dir, {});
    const turn = await brain.submit(prepared);
    brain.ingest(log.append({ kind: "status", agentId: "claude", payload: { state: "native_turn_accepted", loomRunId: turn.runId, loomBindingId: turn.bindingId, loomSessionEpoch: turn.sessionEpoch } }));
    brain.settled(turn.runId, new NativeQuiescenceUnknown("tool descendant still active"));
    expect(brain.store.receipts()[0]).toMatchObject({ status: "accepted", execution: "unknown" });
    expect(brain.store.activeReceipts()).toHaveLength(1);
  });
  it("cleans adapter reservations on synchronous argument preparation failures", async () => {
    const { brain, dir } = await setup(), prepared = await brain.prepare(request(brain), "codex", dir, {});
    const continuity = await brain.submit(prepared);
    for (const adapter of [new CodexAdapter("codex", dir, { bin: fakeCli("codex"), extraArgs: 42 as unknown as string[] }), new ClaudeCodeAdapter("claude", dir, { bin: fakeCli("claude"), extraArgs: 42 as unknown as string[] })]) {
      await expect(adapter.send({ text: "work", continuity })).rejects.toBeInstanceOf(NativeDispatchRejected);
      expect(adapter.busy()).toBe(false);
    }
    brain.settled(continuity.runId, new NativeDispatchRejected("no launch"));
  });
  // Turn-level settlement: the session stays warm, and a turn settles once the
  // harness reports it done and no command it started is still running.
  it("settles a turn only once its running commands have finished", async () => {
    const { brain, log, dir } = await setup();
    const command = (type: string, status: string) => ({ out: { method: type, params: { threadId: "$THREAD", turnId: "$TURN",
      item: { id: "cmd-1", type: "commandExecution", command: "sleep 1", status, exitCode: status === "completed" ? 0 : null } } } });
    const bin = fakeCodex({ script: [CODEX_OK[0]!, command("item/started", "inProgress"), ...CODEX_OK.slice(1), { sleep: 400 }, command("item/completed", "completed")] });
    const started = Date.now();
    await runNative(brain, log, dir, request(brain), "codex", bin);
    expect(Date.now() - started).toBeGreaterThanOrEqual(350);
    expect(log.list().some(e => e.kind === "tool_call" && e.payload.tool === "shell")).toBe(true);
    expect(brain.store.activeReceipts()).toHaveLength(0);
  }, 12_000);
  it("rejects unsupported orchestra before creating a run or conversation", async () => {
    const dir = makeProjectDir({ brain: { continuity: true }, agents: [{ id: "codex", kind: "codex", options: { bin: fakeCli("codex") } }] });
    const runtime = await ProjectRuntime.open({ id: "project", name: "test", dir }); open.push(runtime);
    const chats = runtime.chats().length;
    await expect(runtime.orchestra.start({ goal: "build it" })).rejects.toMatchObject({ code: "unsupported" });
    expect(runtime.orchestra.list()).toHaveLength(0); expect(runtime.chats()).toHaveLength(chats);
    await expect(runtime.startRoute({ task: "build it", spec: "auto" })).rejects.toMatchObject({ code: "unsupported" });
    expect(runtime.routes.read()).toBeUndefined();
  });
  it("waits for app-owned turn commits before dispatching the next native writer", async () => {
    const bin = fakeCodex({ script: [{ spawn: "" }, { sleep: 400 }, ...CODEX_OK] });
    const dir = makeProjectDir({ brain: { continuity: true }, git: { commitPerTurn: true }, agents: [{ id: "codex", kind: "codex", options: { bin } }] });
    const configFile = path.join(dir, ".loom", "config.json");
    fs.writeFileSync(configFile, JSON.stringify({ ...JSON.parse(fs.readFileSync(configFile, "utf8")), git: { commitPerTurn: true } }));
    execFileSync("git", ["init", "-q"], { cwd: dir });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: dir });
    execFileSync("git", ["config", "user.email", "test@test.invalid"], { cwd: dir });
    fs.writeFileSync(path.join(dir, ".gitignore"), ".loom/\n"); fs.writeFileSync(path.join(dir, "file"), "base");
    execFileSync("git", ["add", "."], { cwd: dir }); execFileSync("git", ["commit", "-qm", "base"], { cwd: dir });
    const marker = path.join(dir, ".git", "hook-running"), release = path.join(dir, ".git", "hook-release");
    fs.writeFileSync(path.join(dir, ".git", "hooks", "pre-commit"), `#!/bin/sh\ntouch '${marker}'\nwhile [ ! -f '${release}' ]; do sleep 0.05; done\n`, { mode: 0o755 });
    // Each turn edits the tracked file, so each turn has something to commit.
    fs.writeFileSync(bin, fs.readFileSync(bin, "utf8").replace('{"spawn":""}',
      JSON.stringify({ spawn: `require('node:fs').writeFileSync(${JSON.stringify(path.join(dir, "file"))},'change-'+Date.now())` })));
    const runtime = await ProjectRuntime.open({ id: "project", name: "test", dir }); open.push(runtime);
    try {
      await runtime.sendMessage("change first", "codex", { requestId: "commit-first" });
      await waitUntil(() => fs.existsSync(marker));
      const next = await runtime.sendMessage("change second", "codex", { requestId: "commit-next" });
      expect(next.queued).toBe(1); expect(turnsOf(bin)).toHaveLength(1);
    } finally { fs.writeFileSync(release, "go"); }
    await waitUntil(() => runtime.continuity!.store.receipts("commit-next").at(-1)?.execution === "complete" && !runtime.anyBusy());
    // Both turns ran on one warm app-server.
    expect(turnsOf(bin)).toHaveLength(2); expect(calls(bin)).toHaveLength(1);
    expect(execFileSync("git", ["log", "--oneline"], { cwd: dir, encoding: "utf8" }).trim().split("\n")).toHaveLength(3);
  }, 10_000);
  it("bounds native output records before importing oversized partial responses", async () => {
    const { brain, log, dir } = await setup();
    const oversized = `process.stdout.write('{"method":"item/completed","params":{"item":{"type":"agentMessage","text":"' + 'x'.repeat(32_000_001) + '"}}}\\n')`;
    const bin = fakeCodex({ script: [CODEX_OK[0]!, { spawn: oversized }, { sleep: 5000 }, ...CODEX_OK.slice(1)] });
    const prepared = await brain.prepare(request(brain), "codex", dir, {}), continuity = await brain.submit(prepared);
    const adapter = new CodexAdapter("claude", dir, { bin });
    adapter.onEvent(e => brain.ingest(log.append({ ...e, agentId: "claude" })));
    const error = await adapter.send({ text: "work", continuity }).catch(error => error);
    expect(error).toBeInstanceOf(Error); expect(error.message).toContain("32 MB");
    brain.settled(continuity.runId, error);
    expect(brain.store.receipts()[0]).toMatchObject({ status: "accepted", execution: "failed" });
    expect(brain.store.activeReceipts()).toHaveLength(0); expect(adapter.busy()).toBe(false);
    expect(log.list().some(e => e.kind === "message" && e.agentId)).toBe(false);
  });
  it("supports an unborn Git workspace and detects edits to staged files", async () => {
    const { brain, dir } = await setup(); execFileSync("git", ["init", "-q"], { cwd: dir });
    fs.writeFileSync(path.join(dir, ".gitignore"), ".loom/\n"); fs.writeFileSync(path.join(dir, "file"), "staged");
    execFileSync("git", ["add", "."], { cwd: dir });
    const prepared = await brain.prepare(request(brain), "codex", dir, {});
    expect(prepared.packet.snapshot.workspace.head).toBeNull(); expect(prepared.packet.snapshot.workspace.dirty).toBe(true);
    fs.writeFileSync(path.join(dir, "file"), "edited after staging");
    await expect(brain.submit(prepared)).rejects.toMatchObject({ code: "stale" });
  });
  it("rolls back mode ownership and config when validation or atomic persistence fails", async () => {
    const dir = makeProjectDir({ brain: { extractor: "off" }, agents: [{ id: "codex", kind: "codex", options: { bin: fakeCli("codex") } }] });
    const runtime = await ProjectRuntime.open({ id: "project", name: "test", dir }); open.push(runtime);
    const file = path.join(dir, ".loom", "config.json"), originalConfig = fs.readFileSync(file, "utf8");
    expect(() => runtime.patchConfig({ brain: { continuity: true }, git: { delivery: "invalid" } })).toThrow(/git.delivery/);
    expect(runtime.continuity).toBeNull(); expect(fs.readFileSync(file, "utf8")).toBe(originalConfig);
    const rename = fs.renameSync;
    const failure = vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
      if (to === file) throw new Error("simulated config commit failure");
      return rename(from, to);
    });
    try { expect(() => runtime.patchConfig({ brain: { continuity: true } })).toThrow(/config commit failure/); }
    finally { failure.mockRestore(); }
    expect(runtime.continuity).toBeNull(); expect(runtime.config.brain?.continuity).toBeUndefined();
    expect(fs.readFileSync(file, "utf8")).toBe(originalConfig);
    expect(fs.readdirSync(path.join(dir, ".loom")).some(name => name.startsWith(".config-"))).toBe(false);
    runtime.patchConfig({ brain: { continuity: true } }); expect(runtime.continuity).not.toBeNull();
  });
  it("prevents mode changes around independent writers and freezes explicit queued text", async () => {
    const bin = fakeCli("codex", 200), dir = makeProjectDir({ brain: { extractor: "off" }, agents: [{ id: "codex", kind: "codex", options: { bin } }] });
    const runtime = await ProjectRuntime.open({ id: "project", name: "test", dir }); open.push(runtime);
    const sending = (runtime.agent("codex") as CodexAdapter).send({ text: "legacy work" });
    expect(() => runtime.patchConfig({ brain: { continuity: true } })).toThrow(/finish or reconcile/);
    expect(runtime.continuity).toBeNull(); await sending;
    runtime.patchConfig({ brain: { continuity: true } });
    runtime.queue.setPaused(true);
    const queued = runtime.enqueue({ text: "  keep exact spaces\n", target: { kind: "agent", agentId: "codex" } });
    expect(queued.text).toBe("  keep exact spaces\n");
    expect(runtime.continuity!.store.request(queued.continuity!.requestId)?.text).toBe(queued.text);
    expect(() => runtime.editQueued(queued.id, { text: "changed" })).toThrow(/durable supersession/);
    expect(runtime.queue.peek()?.text).toBe(queued.text);
    expect(() => runtime.patchConfig({ brain: { continuity: false } })).toThrow(/queued prompts/);
  });
  it("reconsiders optional sources omitted by the previous accepted packet", async () => {
    const { brain, log, dir } = await setup();
    const missed = log.append({ kind: "message", agentId: "other", payload: { text: "observation ".repeat(800) } });
    const req = request(brain, "work");
    const small = await brain.prepare({ ...req, targetAddedTokens: 600 }, "codex", dir, {});
    expect(small.packet.coverage.find(c => c.source.eventId === missed.id)?.disposition).toBe("omitted");
    const turn = await brain.submit(small);
    const tags = { loomRunId: turn.runId, loomBindingId: turn.bindingId, loomSessionEpoch: turn.sessionEpoch };
    brain.ingest(log.append({ kind: "status", agentId: "claude", payload: { ...tags, state: "turn_started", session: "native" } }));
    brain.ingest(log.append({ kind: "run_complete", agentId: "claude", payload: tags }));
    const next = await brain.prepare(request(brain, "unrelated query"), "codex", dir, {});
    expect(next.packet.mode).toBe("delta");
    expect(next.packet.evidence.some(e => e.source.eventId === missed.id)).toBe(true);
  });
});

describe("native continuity lifecycle", () => {
  it("a proven process-launch rejection is failed without an uncertain writer lease", async () => {
    const { brain, dir } = await setup();
    const prepared = await brain.prepare(request(brain), "codex", dir, {});
    const turn = await brain.submit(prepared);
    brain.settled(turn.runId, new NativeDispatchRejected("spawn ENOENT; no process"));
    expect(brain.store.receipts()[0]).toMatchObject({ status: "failed", execution: "failed" });
    await expect(brain.prepare(request(brain, "another request"), "codex", dir, {})).resolves.toHaveProperty("receipt");
  });
  it("Claude → Codex → Claude resumes the right chat after restart with a correction", async () => {
    const { brain, log, dir } = await setup(), claude = fakeCli("claude"), codex = fakeCli("codex");
    const first = await runNative(brain, log, dir, request(brain, "We may use JSONL; undecided"), "claude-code", claude);
    const second = await runNative(brain, log, dir, request(brain, "Correction: SQLite is accepted", undefined, "main", "codex"), "codex", codex);
    expect(second.rendered.text).toContain("undecided");
    const native = brain.store.bindingById(first.packet.target.id)!.nativeSessionId;
    log.close(); const again = await EventLog.open(path.join(dir, ".loom")); open.push(again);
    const resumed = new ContinuityEngine(again, "project");
    const third = await runNative(resumed, again, dir, request(resumed, "Continue the same work"), "claude-code", claude);
    expect(third.packet.mode).toBe("delta"); expect(third.packet.target.nativeSessionId).toBe(native);
    expect(third.rendered.text).toContain("SQLite is accepted");
    expect(calls(claude).at(-1)).toContain(`--resume=${native}`);
    expect(claudeInitOf(claude).appendSystemPrompt).toBeUndefined();
    expect(claudePromptOf(claude)).toContain("SQLite is accepted");
    expect(resumed.store.receipts().every(r => r.status === "accepted" && r.execution === "complete")).toBe(true);
    expect(fs.existsSync(path.join(dir, ".loom", "state.json"))).toBe(false);
  });
  it("isolates two chats using one configured adapter", async () => {
    const { brain, log, dir } = await setup(), bin = fakeCli("codex");
    const main = await runNative(brain, log, dir, request(brain, "main-only", undefined, "main", "codex"), "codex", bin);
    const privateChat = await runNative(brain, log, dir, request(brain, "private-only", undefined, "private", "codex"), "codex", bin);
    expect(privateChat.packet.target.id).not.toBe(main.packet.target.id);
    expect(rpcOf(bin, "thread/resume")).toHaveLength(0); expect(privateChat.rendered.text).not.toContain("main-only");
  });
  it("persists overflow without submitting and lets a later budget produce a new attempt", async () => {
    const { brain, dir, log } = await setup(), said = say(log, "tiny decision ".repeat(3000));
    brain.putItem({ id: "large-review", revision: 1, conversationId: "main", kind: "decision", text: "tiny decision ".repeat(3000),
      origin: "user", status: "accepted", sources: [brain.store.source(said, "project")], supersedes: null });
    const req = request(brain), prepared = await brain.prepare(req, "codex", dir, {});
    expect(prepared.packet.budget.overflow).toBe("mandatory");
    await expect(brain.submit(prepared)).rejects.toMatchObject({ code: "overflow" });
    expect(brain.store.receipts(req.id)[0]!.status).toBe("prepared");
    const expanded = await brain.prepare({ ...req, targetAddedTokens: 30_000 }, "codex", dir, {});
    expect(expanded.packet.budget.overflow).toBe("none"); expect(expanded.receipt.id).not.toBe(prepared.receipt.id);
  });
  it("keeps spawn/init separate from acceptance; uncertain sends block new writers", async () => {
    const { brain, log, dir } = await setup();
    const prepared = await brain.prepare(request(brain), "codex", dir, {}), turn = await brain.submit(prepared);
    brain.ingest(log.append({ kind: "status", agentId: "claude", payload: { state: "turn_started", session: "s", loomRunId: turn.runId, loomBindingId: turn.bindingId, loomSessionEpoch: turn.sessionEpoch } }));
    expect(brain.store.receipts()[0]!.status).toBe("submitting");
    brain.settled(turn.runId, new Error("lost response"));
    expect(brain.store.receipts()[0]!.status).toBe("outcome_unknown");
    await expect(brain.prepare(request(brain, "next"), "codex", dir, {})).rejects.toMatchObject({ code: "recovery_required" });
    brain.store.reconcile(prepared.receipt.id, "Checked and terminated native process; reviewed dirty files");
    expect(brain.store.bindingById(turn.bindingId)?.sessionEpoch).toBe(2);
    expect(brain.store.bindingById(turn.bindingId)?.nativeSessionId).toBeNull();
    expect(brain.store.request(prepared.receipt.requestId)?.text).toBe("continue");
  });
  it("restart cannot replay submitting intent and retains the workspace lock", async () => {
    const { brain, log, dir } = await setup();
    const prepared = await brain.prepare(request(brain), "codex", dir, {}); await brain.submit(prepared);
    log.close(); const again = await EventLog.open(path.join(dir, ".loom")); open.push(again);
    expect(() => again.append({ kind: "message", payload: { text: "unsafe legacy work" } })).toThrow(/unresolved Brain writers/);
    const reopened = new ContinuityEngine(again, "project");
    expect(reopened.store.receipts()[0]).toMatchObject({ status: "outcome_unknown", execution: "unknown" });
    await expect(reopened.prepare(request(reopened), "claude-code", dir, {})).rejects.toMatchObject({ code: "recovery_required" });
  });
  it("rejects a second live project owner", async () => {
    const { dir } = await setup(), log = await EventLog.open(path.join(dir, ".loom")); open.push(log);
    expect(() => new ContinuityEngine(log, "project")).toThrow(/another live project owner/);
  });
  it("invalidates packet when instructions or dirty file contents change", async () => {
    const { brain, dir } = await setup();
    execFileSync("git", ["init", "-q"], { cwd: dir });
    fs.writeFileSync(path.join(dir, ".gitignore"), ".loom/\n"); fs.writeFileSync(path.join(dir, "file"), "base");
    execFileSync("git", ["add", "."], { cwd: dir });
    execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@test.invalid", "commit", "-qm", "base"], { cwd: dir });
    fs.writeFileSync(path.join(dir, "file"), "dirty-one");
    const one = await brain.prepare(request(brain), "codex", dir, {});
    fs.writeFileSync(path.join(dir, "file"), "dirty-two");
    await expect(brain.submit(one)).rejects.toMatchObject({ code: "stale" });
    const two = await brain.prepare(request(brain), "codex", dir, {});
    fs.writeFileSync(path.join(dir, "AGENTS.md"), "new policy");
    await expect(brain.submit(two)).rejects.toMatchObject({ code: "stale" });
  });
  it("an unproven stop keeps the successor behind a rejected startup barrier", async () => {
    class Unstoppable extends AdapterBase {
      async available() { return true; } async start() {} async stop() { throw new Error("cannot stop"); }
      async interrupt() {} async send(_input: SendInput) {}
    }
    const runtime = new RuntimeAgents(), dir = makeProjectDir();
    runtime.install(new Unstoppable("a", "test", dir), () => {}); await runtime.start("a");
    runtime.install(new Unstoppable("a", "test", dir), () => {});
    await expect(runtime.start("a")).rejects.toThrow("cannot stop");
    await expect(runtime.close()).rejects.toThrow("cannot stop");
  });
  it("dispatches idempotently and queues switching to the captured target/model", async () => {
    const claude = fakeCli("claude", 150), codex = fakeCli("codex");
    const dir = makeProjectDir({ brain: { continuity: true, extractor: "off" }, agents: [
      { id: "claude", kind: "claude-code", options: { bin: claude } }, { id: "codex", kind: "codex", options: { bin: codex } }] });
    const runtime = await ProjectRuntime.open({ id: "project", name: "test", dir }); open.push(runtime);
    const chat = runtime.createChat("Switching").id;
    const one = await runtime.sendMessage("Use SQLite", "claude", { requestId: "one", chat });
    const duplicate = await runtime.sendMessage("Use SQLite", "claude", { requestId: "one", chat });
    expect(duplicate.requestId).toBe(one.requestId);
    runtime.setChatAgent(chat, "codex", "cheap-captured");
    const two = await runtime.sendMessage("  continue\n", undefined, { requestId: "two", chat });
    expect(two.queued).toBe(1);
    runtime.setChatAgent(chat, "claude");
    await waitUntil(() => runtime.continuity!.store.receipts("two").at(-1)?.execution === "complete");
    expect(rpcOf(codex, "thread/start")[0]).toMatchObject({ model: "cheap-captured" });
    expect(JSON.stringify(rpcOf(codex, "turn/start")[0]!.input)).toContain("Use SQLite");
    expect(calls(claude)).toHaveLength(1);
  });
});

describe("usage-aware switching and validation fixes", () => {
  const accept = (brain: ContinuityEngine, log: EventLog, turn: { runId: string; bindingId: string; sessionEpoch: number }, agent: string, session: string) => {
    const tags = { loomRunId: turn.runId, loomBindingId: turn.bindingId, loomSessionEpoch: turn.sessionEpoch };
    brain.ingest(log.append({ kind: "status", agentId: agent, payload: { ...tags, state: "turn_started", session } }));
    brain.ingest(log.append({ kind: "run_complete", agentId: agent, payload: tags }));
  };
  it("a return delta covers every observation since its basis, not a recent window", async () => {
    const { brain, log, dir } = await setup();
    accept(brain, log, await brain.submit(await brain.prepare(request(brain, "start"), "claude-code", dir, {})), "claude", "s1");
    const work = Array.from({ length: 120 }, (_, i) => log.append({ kind: "message", agentId: "codex", payload: { text: `codex step ${i}` } }));
    const back = await brain.prepare(request(brain, "zzz"), "claude-code", dir, {});
    expect(back.packet.mode).toBe("delta");
    const covered = new Set(back.packet.coverage.map(c => c.source.eventId));
    expect(work.filter(e => !covered.has(e.id))).toHaveLength(0);
    expect(back.packet.evidence).toHaveLength(120);
  });
  it("a queued request is neither history for the running turn nor a reason to reassemble it", async () => {
    const { brain, dir } = await setup();
    const a = request(brain, "A: refactor the parser");
    request(brain, "B: delete the old parser tests");
    const prepared = await brain.prepare(a, "claude-code", dir, {});
    expect(prepared.rendered.text).not.toContain("old parser tests");
    request(brain, "C: queued while A prepares");
    await expect(brain.submit(prepared)).resolves.toHaveProperty("runId");
  });
  it("does not resend what a resumed session already holds; sends what another agent was told", async () => {
    const { brain, log, dir } = await setup(), claude = fakeCli("claude"), codex = fakeCli("codex");
    await runNative(brain, log, dir, request(brain, "Claude-only instruction: keep tabs"), "claude-code", claude);
    await runNative(brain, log, dir, request(brain, "Codex-only instruction: add an index", undefined, "main", "codex"), "codex", codex);
    const back = await runNative(brain, log, dir, request(brain, "continue"), "claude-code", claude);
    expect(back.packet.mode).toBe("delta");
    expect(back.rendered.text).not.toContain("keep tabs");
    expect(back.rendered.text).toContain("add an index");
    const again = await brain.prepare(request(brain, "and again"), "claude-code", dir, { bin: claude });
    expect(again.rendered.text).not.toContain("add an index");
    expect(again.packet.items).toHaveLength(0);
  });
  it("a new session gets a bounded packet: recent exact, older headlines, full text on file", async () => {
    const { brain, log, dir } = await setup();
    const said = Array.from({ length: 300 }, (_, i) => say(log, `Message ${i}: ${"keep the layout stable and tests green. ".repeat(4)}`));
    const prepared = await brain.prepare(request(brain, "switch to a fresh agent"), "claude-code", dir, {});
    expect(prepared.packet.mode).toBe("reconstruction");
    expect(prepared.packet.budget.overflow).toBe("none");
    expect(prepared.packet.budget.estimatedAddedTokens).toBeLessThanOrEqual(6000);
    expect(prepared.packet.messages.map(m => m.source.eventId)).toContain(said.at(-1)!.id);
    const covered = new Map(prepared.packet.coverage.map(c => [c.source.eventId, c.disposition]));
    for (const e of said) expect(["exact", "referenced"]).toContain(covered.get(e.id));
    expect(covered.get(said[0]!.id)).toBe("referenced");
    const archive = JSON.parse(new ContextArtifacts(dir).read(prepared.packet.retrieval!.hash));
    expect(archive.sources.map((s: { source: { eventId: number } }) => s.source.eventId)).toContain(said[0]!.id);
    expect(prepared.rendered.text).toContain("full text in the evidence file");
  });
  it("superseding a checkpoint restores the originals it replaced", async () => {
    const { brain, log, dir } = await setup();
    const original = say(log, "Use two-space indentation in YAML only"), source = brain.store.source(original, "project");
    brain.putItem({ id: "cp", revision: 1, conversationId: "main", kind: "instruction", text: "Use two-space indentation", origin: "user", status: "accepted", sources: [source], supersedes: null });
    brain.store.dispose(original.id, "main", "cp");
    expect((await brain.prepare(request(brain), "codex", dir, {})).packet.messages).toHaveLength(0);
    const fix = say(log, "That summary was wrong: YAML only");
    brain.putItem({ id: "fix", revision: 1, conversationId: "main", kind: "correction", text: "Two spaces in YAML files only", origin: "user", status: "accepted",
      sources: [brain.store.source(fix, "project")], supersedes: { id: "cp", revision: 1 } });
    const after = await brain.prepare(request(brain), "codex", dir, {});
    expect(after.packet.messages.some(m => m.source.eventId === original.id)).toBe(true);
    expect(after.packet.items.map(i => i.id)).toEqual(["fix"]);
  });
  it("switching model within a harness keeps its native session", async () => {
    const { brain, log, dir } = await setup();
    const first = await brain.prepare(request(brain, "one"), "claude-code", dir, { model: "sonnet" });
    accept(brain, log, await brain.submit(first), "claude", "native-1");
    const second = await brain.prepare({ ...request(brain, "two"), model: "opus" }, "claude-code", dir, { model: "opus" });
    expect(second.packet.target.id).toBe(first.packet.target.id);
    expect(second.packet.mode).toBe("delta"); expect(second.packet.target.nativeSessionId).toBe("native-1");
  });
  it("native compaction rebuilds state into the same session, then returns to deltas", async () => {
    const { brain, log, dir } = await setup();
    const bin = fakeClaude({ script: [claudeInit,
      { out: { type: "system", subtype: "compact_boundary", compact_metadata: { trigger: "auto", pre_tokens: 190000 }, session_id: "$SESSION" } },
      claudeText("ok"), claudeResult()] });
    const first = await runNative(brain, log, dir, request(brain, "Keep the tiny preference: tabs"), "claude-code", bin);
    const native = brain.store.bindingById(first.packet.target.id)!;
    expect(native.retention).toBe("compacted");
    const rebuilt = await brain.prepare(request(brain, "continue"), "claude-code", dir, { bin });
    expect(rebuilt.packet.mode).toBe("reconstruction");
    expect(rebuilt.packet.target.nativeSessionId).toBe(native.nativeSessionId);
    expect(rebuilt.rendered.text).toContain("tabs");
    accept(brain, log, await brain.submit(rebuilt), "claude", native.nativeSessionId!);
    expect(brain.store.bindingById(first.packet.target.id)?.retention).toBe("unknown");
    expect((await brain.prepare(request(brain, "next"), "claude-code", dir, { bin })).packet.mode).toBe("delta");
  });
  it("a lost native session moves the binding to a new epoch and reconstructs", async () => {
    for (const kind of ["claude-code", "codex"] as const) {
      const { brain, log, dir } = await setup();
      const bin = kind === "codex" ? fakeCli("codex") : fakeCli("claude");
      const first = await runNative(brain, log, dir, request(brain, "Remember: tabs, not spaces", undefined, "main", kind), kind, bin);
      const bound = brain.store.bindingById(first.packet.target.id)!;
      const again = await brain.prepare(request(brain, "continue", undefined, "main", kind), kind, dir, { bin });
      expect(again.packet.mode).toBe("delta");
      const turn = await brain.submit(again);
      brain.settled(turn.runId, new NativeSessionMissing("gone"));
      expect(brain.store.receipts().at(-1)).toMatchObject({ status: "failed", execution: "failed" });
      expect(brain.store.bindingById(bound.id)).toMatchObject({ nativeSessionId: null, sessionEpoch: bound.sessionEpoch + 1, retention: "unknown" });
      const rebuilt = await brain.prepare(request(brain, "continue once more", undefined, "main", kind), kind, dir, { bin });
      expect(rebuilt.packet.mode).toBe("reconstruction");
      expect(rebuilt.rendered.text).toContain("tabs, not spaces");
    }
  });
  it("adapters report a lost session as NativeSessionMissing through a real turn", async () => {
    for (const kind of ["claude-code", "codex"] as const) {
      const { brain, log, dir } = await setup();
      const bin = kind === "codex" ? fakeCli("codex") : fakeCli("claude");
      await runNative(brain, log, dir, request(brain, "first", undefined, "main", kind), kind, bin);
      const gone = kind === "codex" ? fakeCodex({ missingThread: true }) : fakeClaude({ missingSession: true });
      // Point the same binding at a harness that lost the session: same path, new behaviour.
      fs.copyFileSync(gone, bin);
      await expect(runNative(brain, log, dir, request(brain, "second", undefined, "main", kind), kind, bin)).rejects.toBeInstanceOf(NativeSessionMissing);
      expect(brain.store.receipts().at(-1)).toMatchObject({ status: "failed" });
      expect(brain.store.activeReceipts()).toHaveLength(0);
    }
  });
  it("HarnessMonitor reports reachability transitions and serves cached results", async () => {
    const bin = path.join(tmpDir("monitor"), "codex");
    fs.writeFileSync(bin, "#!/usr/bin/env node\nconsole.log('codex-cli 9.9.9')\n", { mode: 0o755 });
    const changes: boolean[] = [];
    const monitor = new HarnessMonitor(() => [{ id: "codex", kind: "codex", options: { bin } }], (_id, next) => changes.push(next.available), 60_000);
    const up = await monitor.ensure("codex");
    expect(up).toMatchObject({ available: true, version: "9.9.9", tested: false });
    fs.writeFileSync(bin, "#!/usr/bin/env node\nprocess.exit(3)\n");
    expect((await monitor.ensure("codex")).available).toBe(true); // cached within the interval
    await monitor.pollAll();
    expect(monitor.get("codex")?.available).toBe(false);
    expect(changes).toEqual([true, false]);
  });
  it("refuses an unreachable harness before capture; a retry runs any reachable version", async () => {
    const bin = path.join(tmpDir("cli"), "claude"), good = fakeCli("claude");
    fs.writeFileSync(bin, "#!/usr/bin/env node\nprocess.exit(1)\n", { mode: 0o755 });
    const dir = makeProjectDir({ brain: { continuity: true, extractor: "off" }, agents: [{ id: "claude", kind: "claude-code", options: { bin } }] });
    const runtime = await ProjectRuntime.open({ id: "project", name: "test", dir }); open.push(runtime);
    const chat = runtime.createChat("c").id;
    await expect(runtime.sendMessage("Do the thing", "claude", { requestId: "r", chat })).rejects.toMatchObject({ code: "unsupported" });
    expect(runtime.log.list({ chat }).some(e => e.kind === "message" && !e.agentId)).toBe(false);
    fs.writeFileSync(bin, fs.readFileSync(good, "utf8").replace("2.1.283", "2.9.999"), { mode: 0o755 });
    await runtime.harnesses.pollAll();
    const retry = await runtime.sendMessage("Do the thing", "claude", { requestId: "r", chat });
    expect(retry.continuityStatus).toBe("submitting");
    await waitUntil(() => runtime.continuity!.store.receipts("r").at(-1)?.execution === "complete");
  });
  it("re-runs an unsent request when its ID is retried after a pre-launch failure", async () => {
    const bin = fakeCli("codex"), dir = makeProjectDir({ brain: { continuity: true, extractor: "off" }, agents: [{ id: "codex", kind: "codex", options: { bin } }] });
    const runtime = await ProjectRuntime.open({ id: "project", name: "test", dir }); open.push(runtime);
    const brain = runtime.continuity!, original = brain.prepare.bind(brain);
    const failing = vi.spyOn(brain, "prepare").mockRejectedValueOnce(new Error("transient observation failure"));
    await expect(runtime.sendMessage("work", "codex", { requestId: "again" })).rejects.toThrow(/transient/);
    failing.mockImplementation(original);
    expect((await runtime.sendMessage("work", "codex", { requestId: "again" })).continuityStatus).toBe("submitting");
    await waitUntil(() => brain.store.receipts("again").at(-1)?.execution === "complete");
    expect(calls(bin)).toHaveLength(1);
  });
});
