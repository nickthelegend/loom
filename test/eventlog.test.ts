import fs from "node:fs";
import path from "node:path";
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

    it("keeps chats apart but shows the brain everything", async () => {
      const log = await open();
      log.append({ kind: "message", chat: "main", payload: { text: "in main" } });
      log.append({ kind: "message", chat: "side", payload: { text: "in side" } });
      log.append({ kind: "decision", chat: "side", payload: { text: "decided in side" } });
      expect(log.list({ chat: "main" }).map((e) => e.payload.text)).toEqual(["in main"]);
      expect(log.list({ chat: "side" }).map((e) => e.payload.text)).toEqual([
        "in side",
        "decided in side",
      ]);
      // no chat filter = the whole project, which is what the brain reads
      expect(log.list()).toHaveLength(3);
      log.close();
    });

    it("reads history written before chats existed as the main chat", async () => {
      // An event with no chat is not orphaned — it predates the feature and
      // belongs to the conversation that was the only one at the time.
      const log = await open();
      log.append({ kind: "message", payload: { text: "no chat on me" } });
      log.append({ kind: "message", chat: "side", payload: { text: "elsewhere" } });
      expect(log.list({ chat: "main" }).map((e) => e.payload.text)).toEqual(["no chat on me"]);
      expect(log.list({ chat: "side" })).toHaveLength(1);
      log.close();
    });
  });
}

/**
 * The sqlite store gained a `chat` column. A log written before it must open,
 * keep every event, and read as the main chat.
 *
 * This is here because the first cut of that migration destroyed logs: the
 * chat index was created before the column was added, sqlite threw "no such
 * column", and EventLog.open swallowed it and quietly started an EMPTY jsonl
 * log next to a database full of history.
 */
describe("event log · migrating a pre-chat sqlite log", () => {
  it("adds the column without losing a single event", async () => {
    const sqlite = await import("node:sqlite");
    const dir = tmpDir("oldschema");
    const file = path.join(dir, "log.db");

    const old = new sqlite.DatabaseSync(file);
    old.exec(`CREATE TABLE events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, kind TEXT NOT NULL,
      agent_id TEXT, payload TEXT NOT NULL);
      CREATE INDEX idx_events_kind ON events(kind, id);`);
    const ins = old.prepare("INSERT INTO events (ts, kind, agent_id, payload) VALUES (?,?,?,?)");
    ins.run(1, "message", null, JSON.stringify({ text: "history one" }));
    ins.run(2, "message", "claude", JSON.stringify({ text: "history two" }));
    old.close();

    const log = await EventLog.open(dir);
    expect(log.list().map((e) => e.payload.text)).toEqual(["history one", "history two"]);
    expect(log.list({ chat: "main" })).toHaveLength(2);
    // and it still writes: the store is the db, not a fresh jsonl file
    log.append({ kind: "message", chat: "side", payload: { text: "new side" } });
    expect(log.list()).toHaveLength(3);
    log.close();
    expect(fs.existsSync(path.join(dir, "log.jsonl"))).toBe(false);

    // idempotent: opening again must not re-migrate or lose anything
    const again = await EventLog.open(dir);
    expect(again.list()).toHaveLength(3);
    again.close();
  });
});
