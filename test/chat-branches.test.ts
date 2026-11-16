import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { chatLineage, branchSessionKey, branchBriefing } from "../src/core/chat-branches.js";
import { EchoAdapter } from "../src/adapters/echo.js";
import { EventLog } from "../src/core/eventlog.js";
import { readProjectState, writeProjectState } from "../src/core/registry.js";
import type { ChatInfo, LoomEvent } from "../src/types.js";
import { tmpDir } from "./helpers.js";

const chat: ChatInfo = { id: "main", title: "Main", createdAt: 0, activeBranch: "b", branches: [
  { id: "0", parent: null, forkEventId: 0, createdAt: 0 },
  { id: "a", parent: "0", forkEventId: 2, createdAt: 1 },
  { id: "b", parent: "a", forkEventId: 5, createdAt: 2 },
  { id: "c", parent: "0", forkEventId: 2, createdAt: 3 },
] };
const event = (id: number, branch?: string, chat?: string): LoomEvent => ({ id, ts: id, kind: "message", payload: { text: String(id) }, ...(branch ? { branch } : {}), ...(chat ? { chat } : {}) });

it("uses inclusive ancestor boundaries and legacy root events, without sibling or other-chat history", () => {
  const events = [event(1), event(2, "0"), event(3), event(4, "a"), event(5, "a"), event(6, "a"), event(7, "b"), event(8, "c"), event(9, "b", "other")];
  expect(events.filter(chatLineage(chat)).map(e => e.id)).toEqual([1, 2, 4, 5, 7]);
  expect(events.filter(chatLineage({ ...chat, activeBranch: "0" })).map(e => e.id)).toEqual([1, 2, 3]);
  expect(branchSessionKey("main")).toBe("main");
  expect(branchSessionKey("main", "a")).not.toBe(branchSessionKey("other", "a"));
});

for (const store of ["sqlite", "jsonl"]) describe(`branch persistence (${store})`, () => {
  afterEach(() => { delete process.env.LOOM_STORE; });
  it("filters before paging, keeps audit history, and survives reopen", async () => {
    process.env.LOOM_STORE = store;
    const dir = tmpDir("branch-log"), loom = path.join(dir, ".loom");
    let log = await EventLog.open(loom);
    try {
      for (const e of [event(1), event(2), event(3), event(4, "a"), event(5, "a"), event(6, "a"), event(7, "b"), event(8, "c")])
        log.append({ ...e, agentId: "echo" });
      writeProjectState(dir, { ...readProjectState(dir), chats: [chat] });
      expect(log.list({ chat: "main", limit: 3 }).map(e => e.id)).toEqual([4, 5, 7]);
      expect(log.list({ chat: "main", before: 7, limit: 2 }).map(e => e.id)).toEqual([4, 5]);
      expect(log.list({ chat: "main", since: 4 }).map(e => e.id)).toEqual([5, 7]);
      expect(log.count({ chat: "main", limit: 1 })).toBe(5);
      expect(log.list({ chat: "main", allBranches: true })).toHaveLength(8);
      expect(log.list()).toHaveLength(8);
      expect(log.list({ activeLineages: true, limit: 2 }).map(e => e.id)).toEqual([5, 7]);
      expect(log.lastReplyIds().get("main")).toBe(7);
      const next = log.append({ kind: "message", payload: { author: "user", text: "continued" } });
      expect(next.branch).toBe("b");
      if (store === "sqlite") {
        expect(log.continuity!.history("main", next.id).map(e => e.id)).toEqual([1, 2, 4, 5, 7, 9]);
        expect(log.continuity!.observations("main", 0, next.id, 2).map(e => e.id)).toEqual([7, 5]);
        expect(log.continuity!.countObservations("main", 0, next.id)).toBe(5);
      }
      log.close(); log = await EventLog.open(loom);
      expect(log.list({ chat: "main" }).map(e => e.id)).toEqual([1, 2, 4, 5, 7, 9]);
      expect(log.list({ chat: "main" }).at(-1)?.branch).toBe("b");
    } finally { log.close(); }
  });
});

it("preserves branch ids when importing JSONL into SQLite", async () => {
  const dir = tmpDir("branch-import"), loom = path.join(dir, ".loom");
  fs.mkdirSync(loom);
  fs.writeFileSync(path.join(loom, "log.jsonl"), [event(1), event(2, "a")].map(e => JSON.stringify(e)).join("\n") + "\n");
  await EventLog.migrateJsonl(loom);
  const log = await EventLog.open(loom);
  try { expect(log.list().map(e => e.branch)).toEqual([undefined, "a"]); }
  finally { log.close(); }
});

it("briefs only the active ancestry, without repeating the current prompt or reasoning", () => {
  const visible = { ...event(4, "a"), payload: { text: "retained" } };
  const hidden = { ...event(6, "a"), payload: { text: "discarded" } };
  const current = { ...event(8, "b"), payload: { text: "current prompt", author: "user" } };
  const privateText = { ...event(7, "b"), payload: { text: "private reasoning", reasoning: true } };
  const brief = branchBriefing(chat, [visible, hidden, privateText, current], current.id);
  expect(brief).toContain("retained");
  for (const text of ["discarded", "current prompt", "private reasoning"]) expect(brief).not.toContain(text);
});

it("isolates fallback adapter cursors by chat, branch and model while preserving the legacy main cursor", () => {
  class InspectEcho extends EchoAdapter {
    cursor(value?: string) { if (value) this.nativeState.patch({ sessionId: value }); return this.nativeState.read().sessionId; }
  }
  const dir = tmpDir("branch-cursors");
  const agent = new InspectEcho("echo", "echo", dir);
  agent.cursor("original");
  agent.scopeConversation("main", "a");
  expect(agent.cursor()).toBeUndefined();
  agent.cursor("fork-a");
  agent.scopeConversation("other", "a");
  expect(agent.cursor()).toBeUndefined();
  agent.cursor("other-chat");
  agent.scopeConversation("main", "0");
  expect(agent.cursor()).toBe("original");
  agent.scopeConversation("main", "a");
  expect(agent.cursor()).toBe("fork-a");
  agent.scopeNativeState("model-b");
  agent.scopeConversation("main", "a");
  expect(agent.cursor()).toBeUndefined();
  const reopened = new InspectEcho("echo", "echo", dir);
  reopened.scopeConversation("main", "a");
  expect(reopened.cursor()).toBe("fork-a");
});
