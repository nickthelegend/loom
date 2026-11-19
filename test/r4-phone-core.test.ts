import { beforeEach, describe, expect, it, vi } from "vitest";
import { tmpDir } from "./helpers.js";
import { chatKey, defaultQuiet, permitsPush, preferences, quietNow, setLevel, setQuiet, validateQuiet } from "../src/core/phone-r4/preferences.js";
import { briefTotals, waitingQuestions } from "../src/core/phone-r4/activity.js";
import type { LoomEvent } from "../src/types.js";
const ev = (id: number, kind: LoomEvent["kind"], chat: string, payload: Record<string, unknown> = {}, agentId?: string): LoomEvent => ({ id, ts: id * 1000, kind, chat, payload, ...(agentId ? { agentId } : {}) });
beforeEach(() => { process.env.LOOM_HOME = tmpDir("r4-phone-core"); });
describe("phone notification policy", () => {
  it("stores quiet hours and chat levels per device and project without collisions", () => {
    setQuiet("a", { ...defaultQuiet, enabled: true, timeZone: "Asia/Kolkata" });
    setLevel("a", "p/a", "b", "none"); setLevel("a", "p", "a/b", "needs-you");
    expect(preferences("b").quiet.enabled).toBe(false);
    expect(preferences("a").chats[chatKey("p/a", "b")]).toBe("none");
    expect(preferences("a").chats[chatKey("p", "a/b")]).toBe("needs-you");
    expect(preferences("a").quiet.timeZone).toBe("Asia/Kolkata");
  });
  it("handles overnight and daytime windows, timezones, boundaries and DST", () => {
    const q = { ...defaultQuiet, enabled: true, timeZone: "America/New_York" };
    for (const at of ["2026-03-08T06:30Z", "2026-03-08T07:30Z", "2026-11-01T05:30Z", "2026-11-01T06:30Z"]) expect(quietNow(q, Date.parse(at))).toBe(true);
    expect(quietNow(q, Date.parse("2026-03-08T11:00Z"))).toBe(false);
    expect(quietNow({ ...q, timeZone: "UTC" }, Date.parse("2026-01-01T22:00Z"))).toBe(true);
    expect(quietNow({ ...q, timeZone: "UTC", start: "09:00", end: "17:00" }, Date.parse("2026-01-01T12:00Z"))).toBe(true);
    expect(quietNow({ ...q, start: "07:00", end: "07:00" })).toBe(false);
  });
  it("snoozes and allows approvals only when explicitly selected; chat mute never suppresses approvals", () => {
    const p = { quiet: { ...defaultQuiet, snoozeUntil: 2000 }, chats: {} };
    expect(permitsPush(p, "done", "p", "main", 1000)).toBe(false);
    expect(permitsPush(p, "approvals", "p", "main", 1000)).toBe(true);
    expect(permitsPush(p, "done", "p", "main", 2000)).toBe(true);
    expect(permitsPush({ ...p, quiet: { ...p.quiet, allowApprovals: false } }, "approvals", "p", "main", 1000)).toBe(false);
    expect(permitsPush({ ...p, chats: { [chatKey("p", "main")]: "none" } }, "approvals", "p", "main", 1000)).toBe(true);
    for (const category of ["done", "goals", "updates"]) expect(permitsPush({ quiet: defaultQuiet, chats: { [chatKey("p", "main")]: "needs-you" } }, category, "p")).toBe(false);
  });
  it("rejects malformed settings without overwriting saved preferences", () => {
    for (const patch of [{ start: "25:00" }, { end: "7:00" }, { timeZone: "Nowhere/Invalid" }, { enabled: "true" }, { snoozeUntil: -1 }, { snoozeUntil: Infinity }]) expect(() => validateQuiet({ ...defaultQuiet, ...patch })).toThrow();
    expect(() => setLevel("a", "p", "main", "sometimes")).toThrow();
    expect(preferences("a")).toEqual({ quiet: defaultQuiet, chats: {} });
  });
});
it("keeps questions independent across chats and handles card answers", () => {
  const events = [ev(1, "needs_input", "a", { requestId: "q1" }), ev(2, "needs_input", "b", { requestId: "q2" }), ev(3, "message", "b", { text: "yes" }), ev(4, "message", "a", {}, "echo")];
  expect(waitingQuestions(events).map(e => e.chat)).toEqual(["a"]);
  expect(waitingQuestions([...events, ev(5, "status", "a", { state: "question_answered", requestId: "q2" })])).toHaveLength(1);
  expect(waitingQuestions([...events, ev(5, "status", "a", { state: "question_answered", requestId: "q1" })])).toHaveLength(0);
});
it("counts yesterday's successful turns and money once, using an exclusive end", () => {
  expect(briefTotals([ev(1, "run_complete", "a", { costUsd: 2 }), ev(2, "status", "a", { state: "turn_cost", costUsd: 2 }), ev(3, "run_complete", "b", { error: "failed" }), ev(4, "run_complete", "a")], 1000, 4000)).toEqual({ finishedTurns: 1, spend: 2 });
});

it("includes non-roster goal workers, crew approvals and waiting goals, and drops terminal runs", async () => {
  const { goalRows } = await import("../src/core/phone-r4/activity.js");
  const run = { id: "r", goal: "Build", status: "waiting_human", chat: "goal-chat", question: "Ship?", tasks: [{ id: "t", title: "Test", status: "running", chat: "worker-chat" }] };
  const crew = { id: "c", name: "Team", state: { channel: "crew-channel", threads: {}, goal: { status: "awaiting_approval", text: "Plan" } } };
  const rows = goalRows("p", "Project", [run], [crew]);
  expect(rows.map(r => [r.kind, r.chat])).toEqual([["needs-you", "goal-chat"], ["running", "worker-chat"], ["approval", "crew-channel"]]);
  expect(goalRows("p", "Project", [{ ...run, status: "completed" }], [])).toEqual([]);
});

it("held pushes retry once when permitted, discard settled requests and use an automatic timer", async () => {
  const { HeldApprovals } = await import("../src/core/phone-r4/held-approvals.js");
  vi.useFakeTimers();
  try {
    const held = new HeldApprovals(), send = vi.fn(async () => {});
    let quiet = true, pending = true;
    held.hold("one", { pending: () => pending, permitted: () => !quiet, send });
    await vi.advanceTimersByTimeAsync(1000); expect(send).not.toHaveBeenCalled();
    quiet = false; await vi.advanceTimersByTimeAsync(1000); expect(send).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000); expect(send).toHaveBeenCalledTimes(1);
    quiet = true; held.hold("two", { pending: () => pending, permitted: () => !quiet, send });
    pending = false; quiet = false; await vi.advanceTimersByTimeAsync(1000); expect(send).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  } finally { vi.useRealTimers(); }
});
