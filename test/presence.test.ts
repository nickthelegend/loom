import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PRESENCE_BROADCAST_MS, PRESENCE_TTL_MS, type PresenceSnapshot } from "../src/core/presence.js";
import { ChatPresenceTracker } from "../src/daemon/presence.js";

describe("chat presence in memory", () => {
  let tracker: ChatPresenceTracker<string>;
  let frames: PresenceSnapshot[];
  const owner = { id: "socket-1", name: "you", kind: "owner" as const };
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    frames = [];
    tracker = new ChatPresenceTracker((frame) => frames.push(frame));
  });
  afterEach(() => { tracker.close(); vi.useRealTimers(); });

  it("refreshes the 45-second lease without changing since or clearing typing", () => {
    tracker.view("a", "p", "main", owner, true);
    const first = tracker.snapshot("p", "main");
    vi.advanceTimersByTime(20_000);
    tracker.view("a", "p", "main", owner);
    vi.advanceTimersByTime(PRESENCE_TTL_MS - 1);
    expect(tracker.snapshot("p", "main")).toEqual(first);
    expect(frames).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(tracker.snapshot("p", "main").people).toEqual([]);
    vi.advanceTimersByTime(PRESENCE_BROADCAST_MS);
    expect(frames.at(-1)?.people).toEqual([]);
  });

  it("coalesces typing across sockets to at most four broadcasts per second and keeps the final stop", () => {
    tracker.view("a", "p", "main", owner);
    tracker.view("b", "p", "main", { id: "socket-2", name: "Priya", kind: "guest" });
    for (let i = 0; i < 100; i++) {
      tracker.view(i % 2 ? "a" : "b", "p", "main", i % 2 ? owner : { id: "socket-2", name: "Priya", kind: "guest" }, i % 3 === 0);
      vi.advanceTimersByTime(10);
    }
    expect(frames.length).toBeLessThanOrEqual(4);
    tracker.view("a", "p", "main", owner, false);
    tracker.view("b", "p", "main", { id: "socket-2", name: "Priya", kind: "guest" }, false);
    vi.advanceTimersByTime(PRESENCE_BROADCAST_MS);
    expect(frames.at(-1)?.people.map((p) => p.typing)).toEqual([false, false]);
  });

  it("moves a socket between chats, separates projects and removes only the closed socket", () => {
    tracker.view("a", "p", "main", owner);
    tracker.view("b", "q", "main", { ...owner, id: "socket-2" });
    vi.advanceTimersByTime(500);
    tracker.view("a", "p", "side", owner);
    expect(tracker.snapshot("p", "main").people).toEqual([]);
    expect(tracker.snapshot("p", "side").people[0]?.since).toBe(1_000_500);
    tracker.remove("a");
    vi.advanceTimersByTime(PRESENCE_BROADCAST_MS);
    expect(frames.at(-1)).toMatchObject({ projectId: "p", chat: "side", people: [] });
    expect(tracker.snapshot("q", "main").people).toHaveLength(1);
    tracker.close();
    tracker.view("a", "p", "main", owner);
    vi.advanceTimersByTime(PRESENCE_TTL_MS);
    expect(tracker.snapshot("p", "main").people).toEqual([]);
    expect(tracker.snapshot("q", "main").people).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });
});
