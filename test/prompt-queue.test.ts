/**
 * The prompt queue: what you've lined up for a project, run one at a time.
 *
 * A prompt sent while its agent is mid-turn used to reach the adapter, throw
 * "busy" into an error event, and vanish while the API had answered 200. Now it
 * waits in a queue you can see and change: edit the text, send it to someone
 * else, reorder it, drop it. Stop holds the queue rather than emptying it, and
 * a goal typed while one is still running starts itself when that one ends.
 */

import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { PromptQueue, parseTarget } from "../src/core/prompt-queue.js";
import { ProjectRuntime } from "../src/daemon/runtime.js";
import { makeProjectDir, tmpDir, waitUntil } from "./helpers.js";

let rt: ProjectRuntime | null = null;
afterEach(async () => {
  await rt?.close();
  rt = null;
});

async function open(agents = [{ id: "echo", kind: "echo" }, { id: "other", kind: "echo" }]) {
  process.env.LOOM_HOME = tmpDir("home-queue");
  const dir = makeProjectDir({ name: "q", agents });
  rt = await ProjectRuntime.open({ id: `q-${Date.now()}`, name: "q", dir });
  return rt;
}

const replies = (r: ProjectRuntime, agentId = "echo") =>
  r.log
    .list({ kinds: ["message"] })
    .filter((e) => e.agentId === agentId)
    .map((e) => String(e.payload.text));

const prompts = (r: ProjectRuntime) =>
  r.log
    .list({ kinds: ["message"] })
    .filter((e) => !e.agentId)
    .map((e) => String(e.payload.text));

describe("the queue itself", () => {
  it("edits, reorders and removes, and says when an item is gone", () => {
    const q = new PromptQueue(null);
    const a = q.add({ text: "first" });
    const b = q.add({ text: "second" });
    q.add({ text: "third" });
    q.move(b.id, 0);
    expect(q.snapshot().items.map((i) => i.text)).toEqual(["second", "first", "third"]);
    q.edit(a.id, { text: "  first, edited  ", target: { kind: "agent", agentId: "codex" } });
    expect(q.snapshot().items[1]).toMatchObject({ text: "first, edited", target: { kind: "agent", agentId: "codex" } });
    expect(q.snapshot().items[1]!.editedAt).toBeGreaterThan(0);
    q.remove(b.id);
    expect(q.snapshot().items.map((i) => i.text)).toEqual(["first, edited", "third"]);
    expect(() => q.remove(b.id)).toThrow(/gone/);
    expect(() => q.edit(a.id, { text: "   " })).toThrow(/can't be empty/);
    expect(q.clear()).toBe(2);
    expect(q.snapshot().items).toEqual([]);
  });

  it("reads a target from the wire, and refuses one it doesn't know", () => {
    expect(parseTarget(undefined)).toEqual({ kind: "auto" });
    expect(parseTarget("codex")).toEqual({ kind: "agent", agentId: "codex" });
    expect(parseTarget("orchestra")).toEqual({ kind: "orchestra" });
    expect(parseTarget({ kind: "orchestra", workers: ["a", "b"], maxParallel: 3 })).toEqual({
      kind: "orchestra",
      workers: ["a", "b"],
      maxParallel: 3,
    });
    expect(() => parseTarget({ kind: "nonsense" })).toThrow(/unknown target/);
    expect(() => parseTarget({ kind: "agent" })).toThrow(/agentId/);
  });

  it("survives a restart, paused — an hour-old queue doesn't start itself", () => {
    const file = path.join(tmpDir("queue-file"), "queue.json");
    const q = new PromptQueue(file);
    q.add({ text: "later" });
    expect(JSON.parse(fs.readFileSync(file, "utf8")).items).toHaveLength(1);
    const reopened = new PromptQueue(file);
    expect(reopened.snapshot().items.map((i) => i.text)).toEqual(["later"]);
    expect(reopened.paused).toBe(true);
    expect(reopened.snapshot().reason).toMatch(/restarted/);
  });
});

describe("prompts sent to a busy agent", () => {
  it("are queued and run in order after the turn", async () => {
    const r = await open();
    const a = await r.sendMessage("sleep:600 first", "echo");
    const b = await r.sendMessage("second", "echo");
    const c = await r.sendMessage("third", "echo");
    expect(a.queued).toBeUndefined();
    expect(b.queued).toBe(1);
    expect(c.queued).toBe(2);
    // queued, not in the thread: it enters the conversation when it's sent
    expect(prompts(r)).toEqual(["sleep:600 first"]);
    await waitUntil(() => replies(r).length >= 3, { timeoutMs: 10_000 });
    const got = replies(r);
    expect(got.findIndex((t) => t.includes("first"))).toBeLessThan(got.findIndex((t) => t.includes("second")));
    expect(got.findIndex((t) => t.includes("second"))).toBeLessThan(got.findIndex((t) => t.includes("third")));
    expect(r.queue.length).toBe(0);
    expect(r.log.list({ kinds: ["error"] })).toHaveLength(0);
  });

  it("can be edited, reordered and dropped before they run", async () => {
    const r = await open();
    await r.sendMessage("sleep:900 working", "echo");
    const one = r.enqueue({ text: "one", target: { kind: "agent", agentId: "echo" } });
    const two = r.enqueue({ text: "two", target: { kind: "agent", agentId: "echo" } });
    const three = r.enqueue({ text: "three", target: { kind: "agent", agentId: "echo" } });
    r.queue.edit(two.id, { text: "two, edited" });
    r.queue.move(three.id, 0);
    r.queue.remove(one.id);
    expect(r.queue.snapshot().items.map((i) => i.text)).toEqual(["three", "two, edited"]);
    await waitUntil(() => r.queue.length === 0 && replies(r).length >= 3, { timeoutMs: 15_000 });
    const asked = prompts(r);
    expect(asked).toEqual(["sleep:900 working", "three", "two, edited"]);
    expect(asked.includes("one")).toBe(false);
  });

  it("goes to whoever you point it at — the baton moves with it", async () => {
    const r = await open();
    await r.sendMessage("sleep:600 mine", "echo");
    const item = r.enqueue({ text: "yours", target: { kind: "agent", agentId: "echo" } });
    r.queue.edit(item.id, { target: { kind: "agent", agentId: "other" } });
    await waitUntil(() => replies(r, "other").some((t) => t.includes("yours")), { timeoutMs: 15_000 });
    expect(r.baton.holder()).toBe("other");
  });

  it("Stop holds the queue instead of emptying it, and resume runs it", async () => {
    const r = await open();
    await r.sendMessage("sleep:3000 long", "echo");
    r.enqueue({ text: "after the stop", target: { kind: "agent", agentId: "echo" } });
    await waitUntil(() => (r.agents.get("echo") as { busy(): boolean }).busy(), { timeoutMs: 5000 });
    await r.interrupt();
    await new Promise((res) => setTimeout(res, 600));
    expect(r.queue.paused).toBe(true);
    expect(r.queue.length).toBe(1); // still yours: resume it, edit it, or drop it
    expect(replies(r).some((t) => t.includes("after the stop"))).toBe(false);
    expect(r.log.list({ kinds: ["status"] }).some((e) => e.payload.state === "queue_paused")).toBe(true);
    r.queue.setPaused(false);
    void r.drainPromptQueue();
    await waitUntil(() => replies(r).some((t) => t.includes("after the stop")), { timeoutMs: 10_000 });
  });

  it("waits when the agent stops to ask you something", async () => {
    const r = await open();
    await r.sendMessage("sleep:400 ask: which file should I write?", "echo");
    r.enqueue({ text: "unrelated next thing", target: { kind: "agent", agentId: "echo" } });
    await waitUntil(() => r.log.list({ kinds: ["needs_input"] }).length > 0, { timeoutMs: 10_000 });
    await new Promise((res) => setTimeout(res, 800));
    // the question stands: the queued prompt would have answered it unseen
    expect(r.queue.paused).toBe(true);
    expect(r.queue.snapshot().reason).toMatch(/asked you something/);
    expect(replies(r).some((t) => t.includes("unrelated next thing"))).toBe(false);
    // and answering by hand still goes out at once, past the held queue
    await r.sendMessage("use notes.txt", "echo");
    await waitUntil(() => prompts(r).includes("use notes.txt"), { timeoutMs: 10_000 });
    expect(r.queue.length).toBe(1);
  });

  it("keeps a prompt it couldn't send, and says why it stopped", async () => {
    const r = await open();
    await r.sendMessage("sleep:600 working", "echo");
    const item = r.enqueue({ text: "to nobody", target: { kind: "agent", agentId: "echo" } });
    // the agent goes away while the prompt waits (removed from the project)
    r.queue.edit(item.id, { target: { kind: "agent", agentId: "ghost" } });
    await waitUntil(() => r.queue.paused, { timeoutMs: 15_000 });
    expect(r.queue.length).toBe(1);
    expect(r.queue.snapshot().reason).toMatch(/ghost/);
    expect(r.log.list({ kinds: ["error"] }).some((e) => /queued prompt not sent/.test(String(e.payload.message)))).toBe(true);
  });

  it("refuses an agent this project doesn't have, before it's queued", async () => {
    const r = await open();
    expect(() => r.enqueue({ text: "hi", target: { kind: "agent", agentId: "nope" } })).toThrow(/no agent "nope"/);
  });
});
