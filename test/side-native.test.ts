import fs from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { sideDriver } from "../src/daemon/side.js";
import { CodexAdapter } from "../src/providers/agent.js";
import { makeProjectDir, waitUntil } from "./helpers.js";
import { codexDone, codexMessage, codexNotify, fakeCodex, rpcOf, stdinOf, turnsOf } from "./native-fakes.js";

it("forks a busy parent's native session in a separate process, preserving its cursor and model", async () => {
  const dir = makeProjectDir();
  // long enough that the parent is still busy when the side's own process has started, on a slow Windows runner too
  const bin = fakeCodex({ model: "parent-model", script: [{ sleep: 3000 }, codexMessage("answer"), codexDone()] });
  const parent = new CodexAdapter("parent", dir, { bin, model: "parent-model" });
  const running = parent.send({ text: "parent work", chat: "main" });
  await waitUntil(() => turnsOf(bin).length === 1);
  const source = parent.sideSource("main");
  const file = path.join(dir, ".loom/providers/sessions.json");
  const persisted = fs.readFileSync(file, "utf8");
  const driver = sideDriver({ config: { id: "parent", kind: "codex", options: { bin, sandbox: "danger-full-access", extraArgs: ["--unsafe"] } },
    ...source, context: "fallback secret" });
  try {
    const response = driver.send("side question", () => {});
    await waitUntil(() => turnsOf(bin).length === 2);
    expect(parent.busy()).toBe(true);
    expect(turnsOf(bin)[0]!.pid).not.toBe(turnsOf(bin)[1]!.pid);
    expect(turnsOf(bin)[1]!.thread).not.toBe(source.resumeCursor);
    expect(rpcOf(bin, "thread/fork")).toEqual([expect.objectContaining({ threadId: source.resumeCursor, sandbox: "read-only", approvalPolicy: "never", model: "parent-model" })]);
    expect(rpcOf(bin, "thread/resume")).toHaveLength(0);
    const turn = rpcOf(bin, "turn/start")[1]!;
    expect(turn.model).toBe("parent-model");
    expect(turn.collaborationMode).toMatchObject({ mode: "plan" });
    expect(JSON.stringify(turn.input)).not.toContain("fallback secret");
    expect(await response).toBe("answer");
    await running;
    expect(parent.sideSource("main").resumeCursor).toBe(source.resumeCursor);
    // Only the parent's normal activity timestamp may change; no side binding is persisted.
    const before = JSON.parse(persisted).bindings;
    const after = JSON.parse(fs.readFileSync(file, "utf8")).bindings;
    expect(after.map((b: { threadId: string; resumeCursor: string }) => [b.threadId, b.resumeCursor]))
      .toEqual(before.map((b: { threadId: string; resumeCursor: string }) => [b.threadId, b.resumeCursor]));
    await driver.send("follow up", () => {});
    expect(rpcOf(bin, "thread/fork")).toHaveLength(1);
    expect(turnsOf(bin)[2]!.thread).toBe(turnsOf(bin)[1]!.thread);
  } finally { await driver.close(); await running; await parent.stop(); }
});

it.each([{ unsupportedFork: true }, { missingThread: true }])("uses recent context if a native fork is unavailable: %s", async (options) => {
  const bin = fakeCodex(options);
  const driver = sideDriver({ config: { id: "parent", kind: "codex", options: { bin } }, cwd: makeProjectDir(),
    model: "pinned", resumeCursor: "parent-session", context: "user: last question\nagent: last answer" });
  try {
    expect(await driver.send("side question", () => {})).toBe("Did the work.");
    expect(rpcOf(bin, "thread/fork")).toHaveLength(1);
    expect(rpcOf(bin, "thread/start")).toHaveLength(1);
    expect(rpcOf(bin, "thread/resume")).toHaveLength(0);
    expect(JSON.stringify(rpcOf(bin, "turn/start")[0]!.input)).toContain("last answer");
  } finally { await driver.close(); }
});

it("streams text, avoids duplicate final text, and declines permission escalation", async () => {
  const bin = fakeCodex({ turnReplyDelayMs: 100, config: {
    mcp_servers: { writes: { command: "unsafe", enabled: true } }, plugins: { "local@tools": { enabled: true } },
    hooks: { SessionStart: [{ hooks: [{ command: "unsafe" }] }] },
  }, script: [
    { ask: "item/permissions/requestApproval", params: { permissions: { fileSystem: { write: ["/"] } } } },
    codexNotify("item/agentMessage/delta", { itemId: "answer", delta: "read only" }),
    codexNotify("item/completed", { item: { id: "answer", type: "agentMessage", text: "read only" } }), codexDone(),
  ] });
  const driver = sideDriver({ config: { id: "parent", kind: "codex", options: { bin } }, cwd: makeProjectDir(), context: "" });
  const chunks: string[] = [];
  try {
    expect(await driver.send("please write", text => chunks.push(text))).toBe("read only");
    expect(chunks.join("")).toBe("read only");
    expect(rpcOf(bin, "thread/start")[0]!.config).toMatchObject({
      mcp_servers: { writes: { enabled: false } }, plugins: { "local@tools": { enabled: false } },
      hooks: { SessionStart: [] }, "features.apps": false, "features.multi_agent": false,
    });
    expect(stdinOf(bin).find(m => m.id === "srv-1")?.result).toMatchObject({ permissions: {} });
  } finally { await driver.close(); }
});
