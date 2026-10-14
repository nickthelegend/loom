/**
 * Runtime ingestion: canonical events in, Loom log events out. Also the
 * reaper and the approval bridge, which sit on the same event stream.
 */

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { ApprovalRequest } from "../../src/core/approvals.js";
import type { ProviderRuntimeEvent, RuntimeEventPayloads, RuntimeEventType } from "../../src/providers/contracts.js";
import { MemorySessionDirectory } from "../../src/providers/directory.js";
import { RuntimeIngestion, type IngestedEvent, type LiveDelta } from "../../src/providers/ingestion.js";
import { SessionReaper } from "../../src/providers/reaper.js";
import { ApprovalBridge } from "../../src/providers/approvals.js";
import { ProviderService } from "../../src/providers/service.js";
import { tmpDir, waitUntil } from "../helpers.js";
import { FakeAdapter } from "./fake-adapter.js";

let clock = 1_000;
function ev<K extends RuntimeEventType>(type: K, payload: RuntimeEventPayloads[K], extra: Partial<ProviderRuntimeEvent> = {}): ProviderRuntimeEvent {
  return { eventId: `e${clock}`, provider: "codex", instanceId: "cx", threadId: "main", createdAt: clock++, turnId: "t1", ...extra, type, payload } as ProviderRuntimeEvent;
}

function ingest(events: ProviderRuntimeEvent[], artifactDir?: string) {
  const out: IngestedEvent[] = [];
  const live: LiveDelta[] = [];
  const ingestion = new RuntimeIngestion({ append: e => out.push(e), live: d => live.push(d), ...(artifactDir ? { artifactDir: () => artifactDir } : {}) });
  return { out, live, ingestion, run: (list = events) => { for (const e of list) ingestion.ingest(e); return out; } };
}
const kinds = (out: IngestedEvent[]) => out.map(e => e.kind === "status" ? `status:${e.payload.state}` : e.kind);

describe("ingestion · text", () => {
  it("assembles streamed text into one message, and streams the deltas live", () => {
    const { run, live } = ingest([]);
    const out = run([
      ev("thread.started", { providerThreadId: "native-1" }),
      ev("turn.started", { model: "gpt-x" }),
      ev("content.delta", { streamKind: "assistant_text", delta: "Hel" }, { itemId: "m1" }),
      ev("content.delta", { streamKind: "assistant_text", delta: "lo." }, { itemId: "m1" }),
      ev("item.completed", { itemType: "assistant_message", status: "completed", detail: "Hello." }, { itemId: "m1" }),
    ]);
    expect(out.find(e => e.kind === "message")!.payload).toEqual({ text: "Hello." });
    expect(out.filter(e => e.kind === "message")).toHaveLength(1);
    expect(live.map(d => d.delta)).toEqual(["Hel", "lo."]);
    expect(out[0]).toMatchObject({ kind: "status", agentId: "cx", chat: "main", payload: { state: "turn_started", session: "native-1", model: "gpt-x" } });
  });

  it("uses the completed item's text when nothing was streamed, and never both", () => {
    const { run } = ingest([]);
    const out = run([ev("item.completed", { itemType: "assistant_message", status: "completed", detail: "Whole reply." }, { itemId: "m2" })]);
    expect(out.map(e => e.payload.text)).toEqual(["Whole reply."]);
  });

  it("keeps reasoning apart from the reply", () => {
    const { run } = ingest([]);
    const out = run([
      ev("content.delta", { streamKind: "reasoning_summary_text", delta: "Weighing" }, { itemId: "r1" }),
      ev("item.completed", { itemType: "reasoning", status: "completed" }, { itemId: "r1" }),
      ev("item.completed", { itemType: "assistant_message", status: "completed", detail: "B." }, { itemId: "m1" }),
    ]);
    expect(out.map(e => e.payload)).toEqual([{ text: "Weighing", reasoning: true }, { text: "B." }]);
  });

  it("drops empty messages", () => {
    const { run } = ingest([]);
    expect(run([ev("item.completed", { itemType: "assistant_message", status: "completed", detail: "  " })])).toEqual([]);
  });
});

describe("ingestion · tools", () => {
  it("reports a command with its exit code", () => {
    const { run } = ingest([]);
    const out = run([ev("item.completed", { itemType: "command_execution", status: "completed", data: { command: "npm   test", exitCode: 1, output: "fail" } })]);
    expect(out[0]).toMatchObject({ kind: "tool_call", payload: { tool: "shell", summary: "shell: npm test", exitCode: 1 } });
    expect(out[0]!.payload).not.toHaveProperty("output"); // outcome detail only for Brain turns
  });

  it("gives Brain turns the outcome, and puts large output in an artifact", () => {
    const dir = tmpDir("ingest-artifacts");
    const { run, ingestion } = ingest([], dir);
    ingestion.tagTurn("main", "cx", { loomRunId: "run", loomBindingId: "b", loomSessionEpoch: 1 });
    const output = "x".repeat(150_000);
    const out = run([ev("item.completed", { itemType: "command_execution", status: "completed", data: { command: "build", exitCode: 0, output } })]);
    const p = out[0]!.payload;
    expect(p).toMatchObject({ outcome: "success", outputTruncated: true, loomRunId: "run" });
    const artifact = p.outputArtifact as { relativePath: string };
    expect(JSON.parse(fs.readFileSync(path.join(dir, artifact.relativePath), "utf8")).output).toBe(output);
  });

  it("raises a file_edit per changed path, and none for a declined change", () => {
    const { run } = ingest([]);
    const out = run([
      ev("item.completed", { itemType: "file_change", status: "completed", title: "Edit", detail: "Edit: /a.ts",
        data: { changes: [{ path: "/a.ts", kind: "update" }, { path: "/b.ts", kind: "add" }] } }),
      ev("item.completed", { itemType: "file_change", status: "declined", data: { changes: [{ path: "/c.ts", kind: "update" }] } }),
    ]);
    expect(kinds(out)).toEqual(["tool_call", "file_edit", "file_edit"]);
    expect(out.slice(1).map(e => e.payload.path)).toEqual(["/a.ts", "/b.ts"]);
  });

  it("reports other tools by name", () => {
    const { run } = ingest([]);
    const out = run([ev("item.completed", { itemType: "mcp_tool_call", status: "completed", detail: "github: list issues", data: { tool: "github.list" } })]);
    expect(out[0]).toMatchObject({ kind: "tool_call", payload: { tool: "github.list", summary: "github: list issues" } });
  });
});

describe("ingestion · turns", () => {
  it("completes a turn with duration, model, tokens, cost, and flags a closing question", () => {
    const { run } = ingest([]);
    const out = run([
      ev("turn.started", { model: "gpt-x" }, { createdAt: 10_000 }),
      ev("item.completed", { itemType: "assistant_message", status: "completed", detail: "Which one?" }),
      ev("turn.completed", { state: "completed", totalCostUsd: 0.02, tokenUsage: { usageStatus: "complete", inputTokens: 100, outputTokens: 5 } }, { createdAt: 12_500 }),
    ]);
    expect(kinds(out)).toEqual(["status:turn_started", "message", "status:turn_cost", "needs_input", "run_complete"]);
    expect(out.at(-1)!.payload).toEqual({ durationMs: 2500, model: "gpt-x", inputTokens: 100, outputTokens: 5 });
  });

  it("a failed turn is an error, not a completion", () => {
    const { run } = ingest([]);
    const out = run([ev("turn.started", {}), ev("turn.completed", { state: "failed", errorMessage: "model unavailable" })]);
    expect(kinds(out)).toEqual(["status:turn_started", "error"]);
    expect(out[1]!.payload).toEqual({ message: "model unavailable" });
  });

  it("an interrupted turn says so and claims nothing", () => {
    const { run } = ingest([]);
    expect(kinds(run([ev("turn.started", {}), ev("turn.completed", { state: "interrupted" })]))).toEqual(["status:turn_started", "status:interrupted"]);
  });

  it("an aborted turn is an error", () => {
    const { run } = ingest([]);
    expect(run([ev("turn.aborted", { reason: "app-server exited" })])[0]).toMatchObject({ kind: "error", payload: { message: "app-server exited" } });
  });

  it("stamps Brain's tags on the turn's events, marks acceptance, and stops after the turn", () => {
    const { run, ingestion } = ingest([]);
    ingestion.tagTurn("main", "cx", { loomRunId: "run", loomBindingId: "b", loomSessionEpoch: 2 });
    const out = run([ev("turn.started", {}), ev("item.completed", { itemType: "assistant_message", status: "completed", detail: "ok" }),
      ev("turn.completed", { state: "completed" }), ev("thread.token-usage.updated", { usage: { usedTokens: 5 } })]);
    expect(kinds(out)).toEqual(["status:turn_started", "status:native_turn_accepted", "message", "run_complete", "status:context_usage"]);
    expect(out.slice(0, 4).every(e => e.payload.loomRunId === "run" && e.payload.loomSessionEpoch === 2)).toBe(true);
    expect(out[4]!.payload).not.toHaveProperty("loomRunId");
  });

  it("keeps two agents' sessions in one chat apart", () => {
    const { run, ingestion } = ingest([]);
    ingestion.tagTurn("main", "cx", { loomRunId: "run", loomBindingId: "b", loomSessionEpoch: 1 });
    const out = run([ev("item.completed", { itemType: "assistant_message", status: "completed", detail: "from claude" }, { instanceId: "cl", provider: "claude-code" })]);
    expect(out[0]).toMatchObject({ agentId: "cl" });
    expect(out[0]!.payload).not.toHaveProperty("loomRunId");
  });
});

describe("ingestion · context, compaction, limits, questions", () => {
  it("shows compaction running, then done with its sizes", () => {
    const { run } = ingest([]);
    const out = run([
      ev("item.started", { itemType: "context_compaction", status: "inProgress" }),
      ev("item.started", { itemType: "context_compaction", status: "inProgress" }),
      ev("thread.state.changed", { state: "compacted", beforeTokens: 180_000, afterTokens: 12_000, trigger: "auto" }),
    ]);
    expect(kinds(out)).toEqual(["status:compacting", "status:native_compacted"]);
    expect(out[1]!.payload).toEqual({ state: "native_compacted", trigger: "auto", preTokens: 180_000, postTokens: 12_000 });
  });

  it("reports context in use and account limits", () => {
    const { run } = ingest([]);
    const out = run([
      ev("thread.token-usage.updated", { usage: { usedTokens: 50_000, maxTokens: 272_000 } }),
      ev("account.rate-limits.updated", { windows: [{ id: "primary", usedPercent: 91, windowMinutes: 300 }], reached: null }),
      ev("account.rate-limits.updated", { windows: [{ id: "five_hour", usedPercent: 100 }], reached: "five_hour" }, { provider: "claude-code" }),
    ]);
    expect(out.map(e => e.payload)).toEqual([
      { state: "context_usage", usedTokens: 50_000, maxTokens: 272_000, autoCompacts: true },
      { state: "usage_limits", provider: "codex", windows: [{ id: "primary", usedPercent: 91, windowMinutes: 300 }] },
      { state: "usage_limits", provider: "claude", windows: [{ id: "five_hour", usedPercent: 100 }], reached: "five_hour" },
    ]);
  });

  it("puts a structured question in front of you", () => {
    const { run } = ingest([]);
    const out = run([ev("user-input.requested", { questions: [{ id: "q1", header: "DB", question: "Which database?", options: [{ label: "Postgres", description: "" }] }] }, { requestId: "ui-1" })]);
    expect(out[0]).toMatchObject({ kind: "needs_input", payload: { question: "Which database?", requestId: "ui-1" } });
  });

  it("turns warnings into notices and runtime errors into errors", () => {
    const { run } = ingest([]);
    const out = run([
      ev("runtime.warning", { message: "stream disconnected", retrying: true }),
      ev("config.warning", { summary: "unknown key" }),
      ev("model.rerouted", { fromModel: "a", toModel: "b" }),
      ev("runtime.error", { message: "boom" }),
    ]);
    expect(out.map(e => [e.kind, e.payload.message])).toEqual([["status", "stream disconnected"], ["status", "unknown key"], ["status", "model rerouted from a to b"], ["error", "boom"]]);
    expect(out[0]!.payload.retrying).toBe(true);
  });
});

describe("SessionReaper", () => {
  const base = { cwd: "/repo", runtimeMode: "full-access" as const };

  it("stops idle sessions, keeps their cursors, and a later turn resumes them", async () => {
    let now = Date.now();
    const service = new ProviderService(new MemorySessionDirectory());
    const adapter = new FakeAdapter("cx");
    service.register(adapter);
    const { session } = await service.ensureSession({ threadId: "main", instanceId: "cx", ...base });
    const reaper = new SessionReaper(service, { inactivityMs: 1000, now: () => now });
    expect(await reaper.sweep()).toBe(0);
    now += 2000;
    expect(await reaper.sweep()).toBe(1);
    expect(adapter.hasSession("main")).toBe(false);
    expect(service.directory.get("main", "cx")).toMatchObject({ status: "stopped", resumeCursor: session.resumeCursor });
    expect((await service.ensureSession({ threadId: "main", instanceId: "cx", ...base })).via).toBe("resumed");
  });

  it("never stops a session with a turn running, or one the caller says is busy", async () => {
    let now = Date.now();
    const service = new ProviderService(new MemorySessionDirectory());
    service.register(new FakeAdapter("cx", { script: [{ wait: 5000 }] }));
    service.register(new FakeAdapter("cl"));
    await service.sendTurn({ threadId: "main", instanceId: "cx", input: "long", ...base });
    await service.ensureSession({ threadId: "main", instanceId: "cl", ...base });
    now += 60 * 60 * 1000;
    const reaper = new SessionReaper(service, { inactivityMs: 1000, now: () => now, busy: (_t, i) => i === "cl" });
    expect(await reaper.sweep()).toBe(0);
    await service.interruptTurn("main", "cx");
  });
});

describe("ApprovalBridge", () => {
  const base = { cwd: "/repo", runtimeMode: "approval-required" as const };

  it("puts a provider request to a person and relays the answer", async () => {
    const service = new ProviderService(new MemorySessionDirectory());
    const adapter = new FakeAdapter("cx", { script: [{ request: "r1", detail: "shell: rm -rf build", args: { command: "rm -rf build" } }, { request: "r2", requestType: "file_change_approval" }] });
    service.register(adapter);
    const asked: ApprovalRequest[] = [];
    const bridge = new ApprovalBridge(service, () => "proj", async req => { asked.push(req); return { behavior: req.tool === "shell" ? "allow" : "deny" }; });
    const events: ProviderRuntimeEvent[] = [];
    service.onEvent(e => events.push(e));
    await service.sendTurn({ threadId: "main", instanceId: "cx", input: "go", ...base });
    await waitUntil(() => events.some(e => e.type === "turn.completed"));
    expect(asked.map(a => [a.project, a.agent, a.tool, a.summary])).toEqual([["proj", "cx", "shell", "shell: rm -rf build"], ["proj", "cx", "file_change", undefined]]);
    expect(adapter.responses).toEqual([{ requestId: "r1", decision: "accept" }, { requestId: "r2", decision: "decline" }]);
    bridge.close();
  });

  it("closes a card whose turn ended before anyone answered", async () => {
    const service = new ProviderService(new MemorySessionDirectory());
    const adapter = new FakeAdapter("cx", { script: [{ request: "r1" }] });
    service.register(adapter);
    let signal: AbortSignal | undefined;
    const bridge = new ApprovalBridge(service, () => "proj", req => new Promise(resolve => {
      signal = req.signal;
      req.signal?.addEventListener("abort", () => resolve({ behavior: "deny", message: "The agent stopped waiting." }));
    }));
    await service.sendTurn({ threadId: "main", instanceId: "cx", input: "go", ...base });
    await waitUntil(() => signal !== undefined);
    await service.interruptTurn("main", "cx");
    expect(signal!.aborted).toBe(true);
    expect(adapter.responses).toEqual([]); // a closed card answers nothing
    bridge.close();
  });
});

describe("LiveDeltaThrottle", () => {
  it("joins an item's deltas and flushes them together", async () => {
    const { LiveDeltaThrottle } = await import("../../src/providers/live.js");
    const sent: Array<{ itemId?: string; delta: string }> = [];
    const t = new LiveDeltaThrottle((d) => sent.push({ ...(d.itemId ? { itemId: d.itemId } : {}), delta: d.delta }), 20);
    const d = (itemId: string, delta: string) => ({ agentId: "a", chat: "main", itemId, streamKind: "assistant_text", delta });
    t.push(d("m1", "Hel")); t.push(d("m1", "lo")); t.push(d("m2", "x"));
    expect(sent).toEqual([]);
    await new Promise((r) => setTimeout(r, 40));
    expect(sent).toEqual([{ itemId: "m1", delta: "Hello" }, { itemId: "m2", delta: "x" }]);
    t.close();
  });
});

describe("ingestion · what a tool did", () => {
  const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

  it("keeps a command's output (its tail) and exit code, and marks a non-zero exit as failed", () => {
    const { run } = ingest([]);
    const long = "x".repeat(5000) + "\nFAIL tests/a.test.ts";
    const out = run([ev("item.completed", { itemType: "command_execution", status: "completed", data: { command: "npm test", exitCode: 1, output: long } }, { itemId: "c1" })]);
    const t = out.find(e => e.kind === "tool_call")!.payload;
    expect(t).toMatchObject({ tool: "shell", exitCode: 1, ok: false, command: "npm test" });
    expect(String(t.preview)).toMatch(/characters earlier/);
    expect(String(t.preview).endsWith("FAIL tests/a.test.ts")).toBe(true);
  });

  it("files a tool's base64 images under .loom/attachments, logs only the path, and carries server, input, output and errors", () => {
    const dir = tmpDir("ingest-images");
    const { run } = ingest([], dir);
    const out = run([
      ev("item.completed", { itemType: "mcp_tool_call", status: "completed", detail: "playwright · screenshot",
        data: { tool: "screenshot", server: "playwright", input: { url: "http://localhost:3000", big: "y".repeat(2000) }, output: "saved", images: [{ data: PNG, mime: "image/png" }] } }, { itemId: "t1" }),
      ev("item.completed", { itemType: "dynamic_tool_call", status: "failed", title: "Read", detail: "Read: nope.ts", data: { tool: "Read", error: "ENOENT: no such file" } }, { itemId: "t2" }),
    ]);
    const [shot, read] = out.filter(e => e.kind === "tool_call").map(e => e.payload);
    expect(shot).toMatchObject({ tool: "screenshot", server: "playwright", ok: true, preview: "saved", kind: "mcp_tool_call" });
    expect(String((shot!.input as Record<string, string>).big)).toMatch(/2000 chars/);
    const img = (shot!.images as Array<{ path: string }>)[0]!;
    expect(img.path).toMatch(/^\.loom\/attachments\/[0-9a-f]{12}\.png$/);
    expect(fs.readFileSync(path.join(dir, img.path)).length).toBeGreaterThan(20);
    expect(JSON.stringify(out)).not.toContain(PNG.slice(0, 30)); // base64 never reaches the log
    expect(read).toMatchObject({ tool: "Read", ok: false, error: "ENOENT: no such file" });
  });

  it("keeps each edit's diff on its file_edit row", () => {
    const { run } = ingest([]);
    const out = run([ev("item.completed", { itemType: "file_change", status: "completed", data: { changes: [{ path: "a.ts", kind: "update", diff: "@@ -1 +1 @@\n-a\n+b" }] } }, { itemId: "f1" })]);
    expect(out.find(e => e.kind === "file_edit")!.payload).toMatchObject({ path: "a.ts", diff: "@@ -1 +1 @@\n-a\n+b" });
  });

  it("a todo list is the plan", () => {
    const { run } = ingest([]);
    const out = run([ev("turn.plan.updated", { plan: [{ step: "write tests", status: "completed" }, { step: "fix bug", status: "inProgress" }] })]);
    expect(out.find(e => e.kind === "status")!.payload).toMatchObject({ state: "plan_updated", plan: [{ step: "write tests" }, { step: "fix bug", status: "inProgress" }] });
  });
});
