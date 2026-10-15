/**
 * Quota Relay: an agent out of quota mid-task hands its work on.
 *
 * "capbot" behaves like Claude Code at its cap — it reports its usage window
 * as reached, then parks the turn until interrupted — and echo stands in for
 * the next agent. Also: reading limits and reset times from what CLIs say.
 */

import path from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { registerAgentKind } from "../src/adapters/index.js";
import { AdapterBase } from "../src/adapters/base.js";
import { parseReset, quotaHit } from "../src/core/quota.js";
import { writeProjectConfig } from "../src/core/registry.js";
import { ProjectRuntime } from "../src/daemon/runtime.js";
import { pushCategory } from "../src/daemon/push.js";
import type { LoomEvent, SendInput } from "../src/types.js";
import { tmpDir, waitUntil } from "./helpers.js";

let resetIn = 60 * 60_000;
class CapBot extends AdapterBase {
  private stopped = false;
  async available() { return true; }
  async start() {}
  async stop() {}
  async interrupt() { this.stopped = true; }
  async diff() { return ""; }
  async send(_input: SendInput): Promise<void> {
    this._busy = true;
    this.stopped = false;
    this.emit({ kind: "status", payload: { state: "usage_limits", provider: "anthropic", reached: "five_hour",
      windows: [{ id: "five_hour", usedPercent: 100, resetsAt: Date.now() + resetIn }] } });
    // parked inside the CLI until the window resets — or until Loom stops it
    while (!this.stopped) await new Promise((r) => setTimeout(r, 10));
    this.emit({ kind: "status", payload: { state: "interrupted" } });
    this._busy = false;
  }
}
registerAgentKind("capbot", (cfg, dir) => new CapBot(cfg.id, "capbot", dir));

let rt: ProjectRuntime | undefined;
afterEach(async () => { await rt?.close(); rt = undefined; resetIn = 60 * 60_000; });
beforeAll(() => {
  process.env.LOOM_HOME = tmpDir("home-relay");
  process.env.LOOM_NO_NOTIFY = "1";
});

async function project(extra: Record<string, unknown> = {}, agents = [{ id: "claude", kind: "capbot" }, { id: "helper", kind: "echo" }]) {
  const dir = tmpDir("relay");
  writeProjectConfig(dir, { name: "relay", agents, brain: { extractor: "off" }, defaultAgent: "claude", ...extra } as never);
  rt = await ProjectRuntime.open({ id: `relay-${path.basename(dir)}`, name: "relay", dir });
  return dir;
}
const statuses = (state: string) => rt!.log.list({ kinds: ["status"] }).filter((e) => e.payload.state === state);

describe("reading a limit", () => {
  const ev = (kind: string, payload: Record<string, unknown>): LoomEvent => ({ id: 1, ts: 0, kind, agentId: "a", payload } as LoomEvent);
  const now = new Date("2026-10-15T10:00:00").getTime();

  it("knows when it resets, from the words CLIs use", () => {
    expect(parseReset("You've hit your usage limit. Upgrade to Pro or try again at 3:04 PM.", now)).toBe(new Date("2026-10-15T15:04:00").getTime());
    expect(parseReset("Claude usage limit reached — resets at 9:00 AM", now)).toBe(new Date("2026-10-16T09:00:00").getTime());
    expect(parseReset("rate limited; resets in 2 hours", now)).toBe(now + 2 * 3_600_000);
    expect(parseReset("try again in 45 minutes", now)).toBe(now + 45 * 60_000);
    expect(parseReset("try again at 19:30", now)).toBe(new Date("2026-10-15T19:30:00").getTime());
    expect(parseReset("limit reached", now)).toBeNull();
  });

  it("from a reported window, an error, or a notice — and not from a context limit or a retry", () => {
    const window = quotaHit(ev("status", { state: "usage_limits", reached: "five_hour", windows: [{ id: "five_hour", usedPercent: 100, resetsAt: now + 1000 }] }), now);
    expect(window).toMatchObject({ resetAt: now + 1000, known: true, window: "five_hour" });
    expect(quotaHit(ev("status", { state: "usage_limits", windows: [{ id: "five_hour", usedPercent: 80 }] }), now)).toBeNull();
    expect(quotaHit(ev("error", { message: "You've hit your usage limit. Try again at 3:04 PM." }), now)).toMatchObject({ known: true });
    expect(quotaHit(ev("error", { message: "429 Too Many Requests" }), now)).toMatchObject({ known: false, resetAt: now + 60 * 60_000 });
    expect(quotaHit(ev("status", { state: "notice", message: "Claude usage limit reached (five_hour)" }), now)).toBeTruthy();
    expect(quotaHit(ev("status", { state: "notice", message: "rate limited", retrying: true }), now)).toBeNull();
    expect(quotaHit(ev("error", { message: "prompt is too long: exceeds the context window limit reached" }), now)).toBeNull();
    expect(quotaHit(ev("error", { message: "ENOENT: no such file" }), now)).toBeNull();
  });
});

describe("relaying the work", () => {
  it("a parked turn is stopped and the next agent carries on with the request, briefed", async () => {
    await project();
    await rt!.sendMessage("Refactor the queue to use Postgres LISTEN");
    await waitUntil(() => rt!.log.list({ kinds: ["message"] }).some((e) => e.agentId === "helper"), { timeoutMs: 10_000 });
    const relay = statuses("quota_relay")[0]!;
    expect(relay.payload).toMatchObject({ from: "claude", to: "helper", known: true });
    expect(String(relay.payload.text)).toMatch(/claude hit its usage limit — helper carries on; claude is back around/);
    const reply = rt!.log.list({ kinds: ["message"] }).find((e) => e.agentId === "helper")!;
    // the same request, re-sent; echo reports the relay briefing arrived with it
    expect(String(reply.payload.text)).toContain("Refactor the queue to use Postgres LISTEN");
    expect(String(reply.payload.text)).toMatch(/briefed: \d+ chars/);
    expect(rt!.relay.cappedUntil("claude")).toBeGreaterThan(Date.now());
    expect(pushCategory(relay)).toBe("done");
  });

  it("while it's out, a prompt for it goes to the stand-in; when it resets, the baton goes back", async () => {
    resetIn = 1500;
    await project();
    await rt!.sendMessage("first task");
    await waitUntil(() => statuses("quota_relay").length === 1 && rt!.log.list({ kinds: ["run_complete"] }).some((e) => e.agentId === "helper"), { timeoutMs: 10_000 });
    await rt!.sendMessage("second task", "claude");
    await waitUntil(() => statuses("quota_redirect").length === 1, { timeoutMs: 5000 });
    expect(statuses("quota_redirect")[0]!.payload).toMatchObject({ from: "claude", to: "helper" });
    await waitUntil(() => rt!.log.list({ kinds: ["message"] }).filter((e) => e.agentId === "helper").length === 2, { timeoutMs: 10_000 });
    await waitUntil(() => statuses("quota_reset").length === 1, { timeoutMs: 10_000 });
    expect(String(statuses("quota_reset")[0]!.payload.text)).toMatch(/claude's usage limit reset/);
    expect(rt!.relay.cappedUntil("claude")).toBeNull();
  });

  it("with nobody to hand to, the request is queued for the reset", async () => {
    await project({}, [{ id: "claude", kind: "capbot" }]);
    await rt!.sendMessage("lonely task");
    await waitUntil(() => statuses("quota_relay").length === 1, { timeoutMs: 10_000 });
    expect(statuses("quota_relay")[0]!.payload).toMatchObject({ from: "claude", to: null });
    const queued = rt!.queue.snapshot().items;
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({ text: "lonely task", target: { kind: "agent", agentId: "claude" }, when: { kind: "at" } });
  });

  it("relay off: the limit is reported and the work waits; relay.to picks who carries on", async () => {
    await project({ relay: { auto: false } });
    await rt!.sendMessage("wait for me");
    await waitUntil(() => statuses("quota_limit").length === 1, { timeoutMs: 10_000 });
    expect(String(statuses("quota_limit")[0]!.payload.text)).toMatch(/relay is off/);
    expect(statuses("quota_relay")).toHaveLength(0);
    await rt!.close();
    rt = undefined;

    await project({ relay: { to: ["second"] } }, [{ id: "claude", kind: "capbot" }, { id: "helper", kind: "echo" }, { id: "second", kind: "echo" }]);
    await rt!.sendMessage("pick second");
    await waitUntil(() => statuses("quota_relay").length === 1, { timeoutMs: 10_000 });
    expect(statuses("quota_relay")[0]!.payload).toMatchObject({ to: "second" });
  });
});

