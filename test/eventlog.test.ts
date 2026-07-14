import { afterEach, describe, expect, it } from "vitest";
import { EventLog } from "../src/core/eventlog.js";
import { tmpDir } from "./helpers.js";

const stores = ["sqlite", "jsonl"] as const;

for (const store of stores) {
  describe(`event log (${store})`, () => {
    afterEach(() => {
      delete process.env.LOOM_STORE;
    });

    async function open() {
      if (store === "jsonl") process.env.LOOM_STORE = "jsonl";
      return EventLog.open(tmpDir(`log-${store}`));
    }

    it("appends and lists in order with ids", async () => {
      const log = await open();
      log.append({ kind: "message", payload: { text: "one", author: "user" } });
      log.append({ kind: "message", agentId: "a1", payload: { text: "two" } });
      log.append({ kind: "run_complete", agentId: "a1", payload: {} });
      const events = log.list();
      expect(events.map((e) => e.id)).toEqual([1, 2, 3]);
      expect(events[0]!.payload.text).toBe("one");
      expect(events[1]!.agentId).toBe("a1");
      expect(log.lastId()).toBe(3);
      log.close();
    });

    it("filters by since, kind and limit (most recent, ascending)", async () => {
      const log = await open();
      for (let i = 0; i < 10; i++) {
        log.append({ kind: i % 2 ? "message" : "tool_call", payload: { i } });
      }
      expect(log.list({ since: 8 }).map((e) => e.id)).toEqual([9, 10]);
      expect(log.list({ kinds: ["message"] })).toHaveLength(5);
      const limited = log.list({ limit: 3 });
      expect(limited.map((e) => e.id)).toEqual([8, 9, 10]);
      log.close();
    });

    it("notifies live subscribers", async () => {
      const log = await open();
      const seen: number[] = [];
      const unsub = log.onEvent((e) => seen.push(e.id));
      log.append({ kind: "message", payload: {} });
      log.append({ kind: "message", payload: {} });
      unsub();
      log.append({ kind: "message", payload: {} });
      expect(seen).toEqual([1, 2]);
      log.close();
    });

    it("persists across reopen", async () => {
      if (store === "jsonl") process.env.LOOM_STORE = "jsonl";
      const dir = tmpDir(`reopen-${store}`);
      const log1 = await EventLog.open(dir);
      log1.append({ kind: "decision", payload: { text: "keep it" } });
      log1.close();
      const log2 = await EventLog.open(dir);
      expect(log2.list()).toHaveLength(1);
      expect(log2.list()[0]!.payload.text).toBe("keep it");
      log2.close();
    });
  });
}
