/**
 * A prompt sent while its agent is mid-turn is queued and run after the turn,
 * in order — found by the real-product e2e run: the second send used to reach
 * the adapter, throw "busy" into an error event, and vanish while the API had
 * answered 200. An interrupt drops what was queued (stop means stop).
 */

import { afterEach, describe, expect, it } from "vitest";

import { ProjectRuntime } from "../src/daemon/runtime.js";
import { makeProjectDir, tmpDir, waitUntil } from "./helpers.js";

let rt: ProjectRuntime | null = null;
afterEach(async () => {
  await rt?.close();
  rt = null;
});

async function open() {
  process.env.LOOM_HOME = tmpDir("home-queue");
  const dir = makeProjectDir({ name: "q", agents: [{ id: "echo", kind: "echo" }] });
  rt = await ProjectRuntime.open({ id: `q-${Date.now()}`, name: "q", dir });
  return rt;
}

const replies = (r: ProjectRuntime) =>
  r.log
    .list({ kinds: ["message"] })
    .filter((e) => e.agentId === "echo")
    .map((e) => String(e.payload.text));

describe("prompts sent to a busy agent", () => {
  it("are queued and run in order after the turn", async () => {
    const r = await open();
    const a = await r.sendMessage("sleep:600 first", "echo");
    const b = await r.sendMessage("second", "echo");
    const c = await r.sendMessage("third", "echo");
    expect(a.queued).toBeUndefined();
    expect(b.queued).toBe(1);
    expect(c.queued).toBe(2);
    await waitUntil(() => replies(r).length >= 3, { timeoutMs: 10_000 });
    const got = replies(r);
    expect(got.findIndex((t) => t.includes("first"))).toBeLessThan(got.findIndex((t) => t.includes("second")));
    expect(got.findIndex((t) => t.includes("second"))).toBeLessThan(got.findIndex((t) => t.includes("third")));
    expect(r.log.list({ kinds: ["error"] })).toHaveLength(0);
  });

  it("an interrupt drops what was queued", async () => {
    const r = await open();
    await r.sendMessage("sleep:3000 long", "echo");
    await r.sendMessage("never", "echo");
    await waitUntil(() => (r.agents.get("echo") as { busy(): boolean }).busy(), { timeoutMs: 5000 });
    await r.interrupt();
    await new Promise((res) => setTimeout(res, 800));
    expect(replies(r).some((t) => t.includes("never"))).toBe(false);
    expect(r.log.list({ kinds: ["status"] }).some((e) => e.payload.state === "queue_cleared")).toBe(true);
  });
});
