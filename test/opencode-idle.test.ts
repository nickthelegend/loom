/**
 * An idle `opencode serve` that Loom started is stopped (memory back), and
 * only that one: never mid-turn, never while a question waits for an answer,
 * never a server Loom was pointed at. A real child process stands in for the
 * server; the next turn starting a fresh one is the adapter's existing path.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { OpenCodeAdapter } from "../src/adapters/opencode.js";
import { tmpDir, waitUntil } from "./helpers.js";

type Internals = { child: ChildProcess | null; started: boolean; _busy: boolean; questions: Map<string, unknown>; armIdle(): void; cancelIdle(): void };
const children: ChildProcess[] = [];
afterEach(() => {
  delete process.env.LOOM_OPENCODE_IDLE_MS;
  for (const c of children.splice(0)) if (c.exitCode === null && c.signalCode === null) { try { process.kill(-c.pid!, "SIGKILL"); } catch { c.kill("SIGKILL"); } }
});

/** An adapter that believes it spawned `child` as its server. */
function adapter(options: Record<string, unknown> = {}) {
  const agent = new OpenCodeAdapter("oc", tmpDir("opencode-idle"), options);
  // its own process group, as spawnContained launches the real server (the stop signals the group)
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", detached: true });
  children.push(child);
  const inner = agent as unknown as Internals;
  inner.child = child;
  inner.started = true;
  const states: string[] = [];
  agent.onEvent((e) => { if (e.kind === "status") states.push(String(e.payload.state)); });
  return { agent, inner, child, states };
}
const exited = (c: ChildProcess) => c.exitCode !== null || c.signalCode !== null;

// Windows stops the server through its Job Object, which a stand-in child doesn't have
describe.skipIf(process.platform === "win32")("opencode serve idle stop", () => {
  it("stops the server Loom started after the idle window, quietly", async () => {
    process.env.LOOM_OPENCODE_IDLE_MS = "40";
    const { inner, child, states } = adapter();
    inner.armIdle();
    await waitUntil(() => exited(child), { timeoutMs: 5000 });
    expect(inner.started).toBe(false);
    expect(inner.child).toBeNull();
    // not "stopped" (the agent going away) and no error card
    expect(states).toEqual(["idle_stopped"]);
  });

  it("waits while a turn runs or a question is open, and a new turn cancels the timer", async () => {
    process.env.LOOM_OPENCODE_IDLE_MS = "30";
    const { inner, child } = adapter();
    inner._busy = true;
    inner.armIdle();
    await new Promise((r) => setTimeout(r, 120));
    expect(exited(child)).toBe(false);
    inner._busy = false;
    inner.questions.set("q", {});
    await new Promise((r) => setTimeout(r, 120));
    expect(exited(child)).toBe(false);
    inner.questions.clear();
    inner.cancelIdle();
    await new Promise((r) => setTimeout(r, 120));
    expect(exited(child)).toBe(false);
    inner.armIdle();
    await waitUntil(() => exited(child), { timeoutMs: 5000 });
  });

  it("never stops a server it was pointed at, and 0 keeps its own up", async () => {
    process.env.LOOM_OPENCODE_IDLE_MS = "20";
    const pointed = adapter({ baseUrl: "http://127.0.0.1:1" });
    pointed.inner.armIdle();
    delete process.env.LOOM_OPENCODE_IDLE_MS;
    const pinned = adapter({ idleMinutes: 0 });
    pinned.inner.armIdle();
    await new Promise((r) => setTimeout(r, 150));
    expect(exited(pointed.child)).toBe(false);
    expect(exited(pinned.child)).toBe(false);
  });
});
