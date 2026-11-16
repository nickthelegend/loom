import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { EventLog } from "../src/core/eventlog.js";
import { ContinuityEngine } from "../src/core/continuity/engine.js";
import { tmpDir } from "./helpers.js";

const logs: EventLog[] = [];
afterEach(() => { for (const log of logs.splice(0)) log.close(); delete process.env.LOOM_STORE; });
const capture = (brain: ContinuityEngine, id = "one") => brain.capture({ id, conversationId: "main", agentInstanceId: "codex", text: "retain focus", source: "user", model: null, plan: false, targetAddedTokens: 6000 });
async function setup() { const dir = tmpDir("continuity-storage"), log = await EventLog.open(dir); logs.push(log); return { dir, log, brain: new ContinuityEngine(log, "project") }; }

describe("Brain migration and persistence failures", () => {
  it("persists request effort and keeps old requests without it readable and retryable", async () => {
    const { dir, log, brain } = await setup();
    const old = capture(brain).request;
    const selected = { ...old, id: "selected", model: "reasoner", effort: "high" };
    brain.capture(selected);
    expect(() => brain.capture({ ...selected, effort: "low" })).toThrow(/different content/);
    log.close();
    const again = await EventLog.open(dir); logs.push(again);
    const reopened = new ContinuityEngine(again, "project");
    expect(reopened.store.request("selected")).toEqual(selected);
    expect(reopened.capture(selected).created).toBe(false);
    expect(reopened.store.request(old.id)).toEqual(old);
    expect(reopened.capture(old).created).toBe(false);
  });

  it("imports backed-up JSONL with original IDs and Main history and restarts idempotently", async () => {
    const dir = tmpDir("jsonl-migrate"), file = path.join(dir, "log.jsonl");
    const original = [{ id: 2, ts: 1, kind: "message", payload: { text: "before chats" } },
      { id: 7, ts: 2, kind: "message", chat: "private", agentId: "claude", payload: { text: "private history" } }];
    fs.writeFileSync(file, original.map(e => JSON.stringify(e)).join("\n") + "\n");
    await expect(EventLog.open(dir)).rejects.toThrow(/explicit migration/);
    expect(fs.existsSync(path.join(dir, "log.db"))).toBe(false);
    const out = await EventLog.migrateJsonl(dir);
    expect(out.imported).toBe(2); expect(fs.readFileSync(out.backup, "utf8")).toBe(fs.readFileSync(file, "utf8"));
    const log = await EventLog.open(dir); logs.push(log);
    expect(log.list()).toEqual(original); expect(log.list({ chat: "main" })).toHaveLength(1);
    expect(log.append({ kind: "message", payload: { text: "new" } }).id).toBe(8);
    log.close();
    const repeat = await EventLog.migrateJsonl(dir); expect(repeat).toMatchObject({ imported: 0, known: 2 });
  });
  it("distinct stores and conflicting event IDs never merge silently; imports roll back", async () => {
    const dir = tmpDir("conflicting-history"), log = await EventLog.open(dir); logs.push(log);
    log.append({ kind: "message", ts: 1, payload: { text: "SQLite original" } }); log.close();
    const file = path.join(dir, "log.jsonl");
    fs.writeFileSync(file, JSON.stringify({ id: 1, ts: 1, kind: "message", payload: { text: "different JSONL" } }) + "\n");
    await expect(EventLog.open(dir)).rejects.toThrow(/distinct histories/);
    await expect(EventLog.migrateJsonl(dir)).rejects.toThrow(/conflicts/);
    process.env.LOOM_STORE = "jsonl";
    const jsonl = await EventLog.open(dir); logs.push(jsonl); expect(jsonl.list()[0]?.payload.text).toBe("different JSONL");
    const db = new DatabaseSync(path.join(dir, "log.db"));
    expect(db.prepare("SELECT payload FROM events").get()).toMatchObject({ payload: JSON.stringify({ text: "SQLite original" }) }); db.close();
  });
  it("malformed interior/trailing records are explicit errors during migration", async () => {
    const dir = tmpDir("torn-jsonl"); fs.writeFileSync(path.join(dir, "log.jsonl"), '{"id":1,');
    await expect(EventLog.migrateJsonl(dir)).rejects.toThrow(/malformed/);
    expect(fs.readFileSync(path.join(dir, "log.jsonl"), "utf8")).toBe('{"id":1,');
  });
  it("SQLite busy does not publish, acknowledge or partially capture a request", async () => {
    const { dir, log, brain } = await setup(); let observed = 0; log.onEvent(() => observed++);
    const competing = new DatabaseSync(path.join(dir, "log.db")); competing.exec("BEGIN IMMEDIATE");
    try { expect(() => capture(brain)).toThrow(/locked/); }
    finally { competing.exec("ROLLBACK"); competing.close(); }
    expect(brain.store.request("one")).toBeUndefined(); expect(log.lastId()).toBe(0); expect(observed).toBe(0);
    capture(brain); expect(observed).toBe(1);
  });
  it("foreign-key/transaction failure rolls back the original event and publication", async () => {
    const { dir, log, brain } = await setup(); let observed = 0; log.onEvent(() => observed++);
    const db = new DatabaseSync(path.join(dir, "log.db"));
    db.exec("CREATE TRIGGER reject_brain_request BEFORE INSERT ON continuity_requests BEGIN SELECT RAISE(ABORT,'simulated storage failure'); END;");
    expect(() => capture(brain)).toThrow(/simulated storage failure/);
    expect(log.lastId()).toBe(0); expect(observed).toBe(0); expect(brain.store.request("one")).toBeUndefined();
    db.exec("DROP TRIGGER reject_brain_request"); db.close(); capture(brain); expect(log.lastId()).toBe(1);
  });
  it("unknown schema version aborts activation without fallback or history loss", async () => {
    const { dir, log, brain } = await setup(); capture(brain); log.close();
    const db = new DatabaseSync(path.join(dir, "log.db")); db.prepare("UPDATE continuity_meta SET value='99' WHERE key='version'").run(); db.close();
    const again = await EventLog.open(dir); logs.push(again);
    expect(() => new ContinuityEngine(again, "project")).toThrow(/version 99/);
    expect(again.list()).toHaveLength(1); expect(fs.existsSync(path.join(dir, "log.jsonl"))).toBe(false);
  });
  it("reconciliation rolls back lease release with epoch failure, addresses old receipts, and cannot repeat", async () => {
    const { dir, brain } = await setup(), workspace = tmpDir("reconcile-workspace");
    const req = capture(brain).request, prepared = await brain.prepare(req, "codex", workspace, {});
    const turn = await brain.submit(prepared); brain.settled(turn.runId);
    const db = new DatabaseSync(path.join(dir, "log.db"));
    try {
      db.exec("CREATE TRIGGER reject_epoch BEFORE UPDATE ON continuity_bindings BEGIN SELECT RAISE(ABORT,'epoch failure'); END");
      expect(() => brain.store.reconcile(prepared.receipt.id, "checked processes")).toThrow(/epoch failure/);
      expect(brain.store.activeReceipts()).toHaveLength(1);
      expect(brain.store.bindingById(turn.bindingId)?.sessionEpoch).toBe(1);
      db.exec("DROP TRIGGER reject_epoch");
      for (let i = 0; i < 101; i++) {
        const receipt = { ...prepared.receipt, id: `other-${i}`, runId: `other-run-${i}` };
        db.prepare("INSERT INTO continuity_receipts VALUES (?,?,?,?,?,?,?)").run(receipt.id, req.id, turn.bindingId, prepared.packet.id, prepared.packet.snapshot.workspace.id, 0, JSON.stringify(receipt));
      }
      expect(brain.store.receipts().some(r => r.id === prepared.receipt.id)).toBe(false);
      brain.store.reconcile(prepared.receipt.id, "verified descendants and workspace");
      expect(brain.store.activeReceipts()).toHaveLength(0);
      expect(brain.store.bindingById(turn.bindingId)?.sessionEpoch).toBe(2);
      expect(() => brain.store.reconcile(prepared.receipt.id, "again")).toThrow(/only uncertain/);
      expect(brain.store.bindingById(turn.bindingId)?.sessionEpoch).toBe(2);
    } finally { db.close(); }
  });
  it("maintains FTS on updates/deletes and rebuilds from canonical events", async () => {
    const { dir, log, brain } = await setup();
    const event = log.append({ kind: "message", agentId: "a", payload: { text: "oldterm" } });
    const db = new DatabaseSync(path.join(dir, "log.db"));
    try {
      db.prepare("UPDATE events SET payload=? WHERE id=?").run(JSON.stringify({ text: "newterm" }), event.id);
      expect(brain.store.search("main", "oldterm")).toHaveLength(0);
      expect(brain.store.search("main", "newterm")).toHaveLength(1);
      if (brain.store.searchMode === "fts5") {
        db.prepare("DELETE FROM continuity_search WHERE rowid=?").run(event.id);
        expect(brain.store.search("main", "newterm")).toHaveLength(0);
        brain.store.rebuildSearch(); expect(brain.store.search("main", "newterm")).toHaveLength(1);
      }
      db.prepare("DELETE FROM events WHERE id=?").run(event.id);
      expect(brain.store.search("main", "newterm")).toHaveLength(0);
    } finally { db.close(); }
  });
  it("checkpoint batches cannot partially hide unreviewed source text", async () => {
    const { brain, log } = await setup(); capture(brain);
    const source = brain.store.source(log.list()[0]!, "project");
    brain.putItem({ id: "review", revision: 1, conversationId: "main", text: "retain focus", kind: "instruction", origin: "user", status: "accepted", sources: [source], supersedes: null });
    expect(() => brain.store.disposeMany([source.eventId, 999], "main", "review")).toThrow(/evidence/);
    expect(brain.store.dispositions("main").size).toBe(0);
  });
});
