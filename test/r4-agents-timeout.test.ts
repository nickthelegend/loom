import { expect, it, vi } from "vitest";
import { AdapterBase } from "../src/adapters/base.js";
import { RuntimeTurns } from "../src/daemon/runtime/turns.js";
import { runAttempts } from "../src/core/agents-r4/attempts.js";
import type { AdapterEvent } from "../src/types.js";
import { tmpDir, waitUntil } from "./helpers.js";

class HeldAgent extends AdapterBase {
  readonly entered = Promise.withResolvers<void>();
  readonly finished = Promise.withResolvers<void>();
  interrupts = 0;
  constructor(id: string, dir: string) { super(id, "echo", dir); }
  async available() { return true; }
  async start() {}
  async stop() {}
  async send() { this._busy = true; this.entered.resolve(); await this.finished.promise; this._busy = false; }
  async interrupt() {
    if (!this._busy) return;
    this.interrupts++;
    this.emit({ kind: "status", payload: { state: "interrupted" } });
    this.finished.resolve();
  }
}

it("times out only the named agent when another agent is first in the same chat, without pausing queues or routes", async () => {
  const dir = tmpDir("r4-exact-timeout"), a = new HeldAgent("a", dir), b = new HeldAgent("b", dir);
  const queue = { length: 1, paused: false, setPaused: vi.fn() }, routes = { onManualInterrupt: vi.fn() };
  const turns = new RuntimeTurns({ agents: new Map([["b", b], ["a", a]]), queue, routes } as unknown as ConstructorParameters<typeof RuntimeTurns>[0]);
  turns.turnChat.set("b", "main"); turns.turnChat.set("a", "main");
  const events: AdapterEvent[] = [];
  const other = b.send(); await b.entered.promise;
  try {
    await runAttempts(a, { text: "bounded", chat: "main" }, { maxTurnMinutes: 0.001 }, {
      dir, budget() {}, current: () => true, say: e => events.push(e), abandoned() {},
      interrupted: () => turns.interruptAgent("a", "main"),
    });
    expect(a.interrupts).toBe(1); expect(b.interrupts).toBe(0); expect(b.busy()).toBe(true);
    expect(queue.setPaused).not.toHaveBeenCalled(); expect(routes.onManualInterrupt).not.toHaveBeenCalled();
    expect(events.filter(e => e.kind === "needs_input")).toHaveLength(1);
    expect(await turns.interruptAgent("a", "elsewhere")).toBe(false);
    expect(await turns.interruptAgent("a", "main")).toBe(false);
  } finally { b.finished.resolve(); await other; }
});

it("does not post a time-limit card when the interrupt found no matching turn", async () => {
  const dir = tmpDir("r4-false-timeout"), agent = new HeldAgent("a", dir), events: AdapterEvent[] = [];
  const interrupted = vi.fn(async () => false);
  const run = runAttempts(agent, { text: "normal completion" }, { maxTurnMinutes: 0.001 }, {
    dir, budget() {}, current: () => true, say: e => events.push(e), abandoned() {}, interrupted,
  });
  await waitUntil(() => interrupted.mock.calls.length === 1);
  agent.finished.resolve(); await run;
  expect(events).toEqual([]);
});

it("interrupts only the matching preparation controller", async () => {
  const turns = new RuntimeTurns({ agents: new Map() } as unknown as ConstructorParameters<typeof RuntimeTurns>[0]);
  const a = new AbortController(), b = new AbortController();
  turns.turnChat.set("a", "main"); turns.turnChat.set("b", "main");
  turns["preparing"].set("a", a); turns["preparing"].set("b", b);
  expect(await turns.interruptAgent("a", "elsewhere")).toBe(false);
  expect(await turns.interruptAgent("a", "main")).toBe(true);
  expect(a.signal.aborted).toBe(true); expect(b.signal.aborted).toBe(false);
});
