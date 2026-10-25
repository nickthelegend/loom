/**
 * The daemon-wide turn gate (#339): a cap on turns at once across projects and a free-memory
 * floor, so separate sends and orchestras queue instead of exhausting the machine.
 */

import { describe, expect, it } from "vitest";
import { createAgent } from "../src/adapters/index.js";
import { TurnGate, availableMemoryPct, defaultLimits, writeLimits, type TurnLimits } from "../src/core/turn-gate.js";
import type { AdapterEvent } from "../src/types.js";
import { tmpDir } from "./helpers.js";

function gate(limits: TurnLimits, free: { pct: number }) {
  let t = 0;
  return new TurnGate({ limits: () => limits, freePct: () => free.pct, now: () => t, sleep: async (ms) => { t += ms; await new Promise((r) => setTimeout(r, 1)); } });
}

describe("the turn gate", () => {
  it("lets the cap's worth run and queues the rest until a slot frees", async () => {
    const g = gate({ maxTurns: 2, minFreePct: 0 }, { pct: 80 });
    const a = await g.acquire("p: a");
    const b = await g.acquire("p: b");
    const waits: string[] = [];
    let started = false;
    const c = g.acquire("p: c", (why) => waits.push(why)).then((r) => { started = true; return r; });
    await new Promise((r) => setTimeout(r, 20));
    expect(started).toBe(false);
    expect(waits[0]).toMatch(/2 turns are running \(the cap is 2\)/);
    a();
    const releaseC = await c;
    expect(g.active().sort()).toEqual(["p: b", "p: c"]);
    b(); releaseC();
    expect(g.active()).toEqual([]);
  });

  it("holds new turns while memory is short, but never the first one", async () => {
    const free = { pct: 8 };
    const g = gate({ maxTurns: 0, minFreePct: 15 }, free);
    const first = await g.acquire("p: first"); // nothing running: it always starts
    const waits: string[] = [];
    let started = false;
    const second = g.acquire("p: second", (why) => waits.push(why)).then((r) => { started = true; return r; });
    await new Promise((r) => setTimeout(r, 20));
    expect(started).toBe(false);
    expect(waits[0]).toMatch(/only 8% of memory is free \(Loom keeps 15%\)/);
    free.pct = 40;
    (await second)(); first();
  });

  it("never waits forever: past the limit it starts anyway and says so", async () => {
    const g = gate({ maxTurns: 1, minFreePct: 0 }, { pct: 90 });
    const held = await g.acquire("p: parent"); // e.g. a parent turn waiting on its subtask
    const waits: string[] = [];
    const child = await g.acquire("p: child", (why) => waits.push(why));
    expect(waits.at(-1)).toMatch(/starting anyway/);
    child(); held();
  });

  it("a cap of 0 means no cap; defaults scale with memory", async () => {
    const g = gate({ maxTurns: 0, minFreePct: 0 }, { pct: 50 });
    const all = await Promise.all(Array.from({ length: 8 }, (_, i) => g.acquire(`p: ${i}`)));
    expect(g.active()).toHaveLength(8);
    for (const r of all) r();
    expect(defaultLimits(16 * 1024 ** 3)).toEqual({ maxTurns: 4, minFreePct: 15 });
    expect(defaultLimits(4 * 1024 ** 3).maxTurns).toBe(2);
    const pct = availableMemoryPct();
    expect(pct).toBeGreaterThan(0);
    expect(pct).toBeLessThanOrEqual(100);
  });
});

describe("every adapter turn passes the gate", () => {
  it("with a cap of 1, a second agent's turn says it's waiting and runs after the first", async () => {
    process.env.LOOM_HOME = tmpDir("home-turn-gate");
    writeLimits({ maxTurns: 1, minFreePct: 0 });
    const was = process.env.LOOM_TURN_GATE;
    delete process.env.LOOM_TURN_GATE;
    try {
      const a = createAgent({ id: "a", kind: "echo", role: "worker" }, tmpDir("tg-a"));
      const b = createAgent({ id: "b", kind: "echo", role: "worker" }, tmpDir("tg-b"));
      const order: string[] = [];
      const seen: AdapterEvent[] = [];
      b.onEvent((e) => seen.push(e));
      if (!("send" in a) || !("send" in b)) throw new Error("echo is an adapter");
      const first = a.send({ text: "sleep:600 one" }).then(() => order.push("a"));
      await new Promise((r) => setTimeout(r, 50));
      const second = b.send({ text: "two" }).then(() => order.push("b"));
      await Promise.all([first, second]);
      expect(order).toEqual(["a", "b"]);
      expect(seen.some((e) => e.kind === "status" && e.payload.state === "queued_for_slot" && /the cap is 1/.test(String(e.payload.text)))).toBe(true);
    } finally {
      if (was !== undefined) process.env.LOOM_TURN_GATE = was;
    }
  }, 20_000);
});
