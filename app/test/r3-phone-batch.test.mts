import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Outbox, diffLocations, lineQuestion, quickAction, sharedText, type PendingMessage } from "../src/phone-batch-model.ts";
const item = (id: string, chat = "main"): PendingMessage => ({ id, project: "project", chat, text: id, agentId: "echo", plan: true });

describe("#421 offline outbox", () => {
  it("persists offline sends, reloads, and delivers in order with their chat, agent and plan", async () => {
    let disk: string | null = null, online = false;
    const delivered: PendingMessage[] = [];
    const send = async (i: PendingMessage) => { if (!online) throw new TypeError("offline"); delivered.push(i); };
    const first = new Outbox(async () => disk, async s => { disk = s; }, send);
    await first.load();
    await Promise.all([first.add(item("first")), first.add(item("second", "side"))]);
    await first.flush(); assert.equal(first.items.length, 2); assert.equal(delivered.length, 0);
    const next = new Outbox(async () => disk, async s => { disk = s; }, send);
    await next.load(); online = true;
    await Promise.all([next.flush(), next.flush()]);
    assert.deepEqual(delivered, [item("first"), item("second", "side")]);
    assert.deepEqual(JSON.parse(disk!), []);
  });
  it("retains an ambiguous delivery with the same id for retry", async () => {
    let fail = true; const ids: string[] = [];
    const box = new Outbox(async () => null, async () => {}, async i => { ids.push(i.id); if (fail) throw new Error("response lost"); });
    await box.add(item("stable-id")); await box.flush(); fail = false; await box.flush();
    assert.deepEqual(ids, ["stable-id", "stable-id"]); assert.equal(box.items.length, 0);
  });
  it("blocks permanent failures until discarded, and doesn't lose later prompts", async () => {
    const sent: string[] = [];
    const box = new Outbox(async () => null, async () => {}, async i => { if (i.id === "bad") throw Object.assign(new Error("No access"), { status: 403 }); sent.push(i.id); });
    await box.add(item("bad")); await box.add(item("good")); await box.flush();
    assert.equal(box.items[0]?.error, "No access"); await box.flush(); assert.deepEqual(sent, []);
    await box.remove("bad"); await box.flush(); assert.deepEqual(sent, ["good"]);
  });
  it("doesn't clear an unsaved message and stops between sends when locked or switched", async () => {
    const box = new Outbox(async () => null, async () => { throw new Error("disk full"); }, async () => {});
    await assert.rejects(box.add(item("x")), /disk full/); assert.equal(box.items.length, 0);
    let allowed = true; const ids: string[] = [];
    const q = new Outbox(async () => null, async () => {}, async i => { ids.push(i.id); allowed = false; });
    await q.add(item("a")); await q.add(item("b")); await q.flush(() => allowed);
    assert.deepEqual(ids, ["a"]); assert.equal(q.items[0]?.id, "b");
  });
});

describe("#421 entry points and diff questions", () => {
  it("accepts only the three shortcuts and keeps shared text literal", () => {
    assert.deepEqual(["new-chat", "approvals", "projects", "delete", null].map(quickAction), ["new-chat", "approvals", "projects", null, null]);
    assert.equal(sharedText({ text: "<script>hello</script>", webUrl: "https://example.com" }), "<script>hello</script>\nhttps://example.com");
    assert.equal(sharedText({ text: "same", webUrl: "same" }), "same");
    assert.equal(sharedText({}), "");
  });
  it("tracks old and new positions across hunks and files, never headers", () => {
    const patch = "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -3,2 +8,2 @@\n-old\n+new\n same\n\\ No newline at end of file\ndiff --git a/b.ts b/b.ts\n@@ -0,0 +1 @@\n+<tag>";
    const locations = diffLocations(patch).filter(v => v !== null);
    assert.deepEqual(locations.map(l => [l.file, l.line, l.side]), [["a.ts", 3, "old"], ["a.ts", 8, "new"], ["a.ts", 9, "new"], ["b.ts", 1, "new"]]);
    assert.equal(lineQuestion(locations[0]!), "Explain this diff line in a.ts:3 (old):\n\nold\n");
  });

});

describe("#421 lock and feedback preferences", () => {
  it("requires biometrics on cold start and resume, keeps cancellation locked, and ignores the prompt's inactive event", async () => {
    const { PhoneLock } = await import("../src/phone-lock-model.ts");
    let ok = false, calls = 0;
    const lock = new PhoneLock(async () => true, async () => {}, async () => true, async () => {
      calls++; lock.activity("inactive"); lock.activity("active"); return ok;
    }, () => {});
    await lock.start(); assert.equal(lock.state.locked, true);
    ok = true; await lock.unlock(); assert.equal(lock.state.locked, false);
    lock.activity("background"); assert.equal(lock.state.locked, true);
    lock.activity("active"); await new Promise(r => setImmediate(r));
    assert.equal(lock.state.locked, false); assert.equal(calls, 3);
  });
  it("never accepts an authentication that completes after backgrounding", async () => {
    const { PhoneLock } = await import("../src/phone-lock-model.ts");
    let answer!: (ok: boolean) => void;
    const lock = new PhoneLock(async () => true, async () => {}, async () => true, () => new Promise(r => { answer = r; }), () => {});
    const start = lock.start(); await new Promise(r => setImmediate(r));
    lock.activity("background"); answer(true); await start; assert.equal(lock.state.locked, true);
  });
  it("only persists lock changes after enrolled biometrics succeed", async () => {
    const { PhoneLock, Feedback } = await import("../src/phone-lock-model.ts");
    let supported = false, authenticated = false; const saved: boolean[] = [];
    const lock = new PhoneLock(async () => false, async on => { saved.push(on); }, async () => supported, async () => authenticated, () => {});
    await lock.start(); assert.equal(lock.state.locked, false);
    await assert.rejects(lock.toggle(true), /Set up/); supported = true;
    await lock.toggle(true); assert.deepEqual(saved, []);
    authenticated = true; await lock.toggle(true); assert.deepEqual(saved, [true]);
    let persisted = false, ticks = 0;
    const feedback = new Feedback(async () => persisted, async on => { persisted = on; });
    await feedback.hydrate(); feedback.run(() => ticks++); assert.equal(ticks, 0);
    await feedback.choose(true); feedback.run(() => ticks++); assert.equal(ticks, 1);
    await feedback.choose(false); feedback.run(() => ticks++); assert.equal(ticks, 1); assert.equal(persisted, false);
  });
});

it("#421 persists a new prompt immediately during a slow delivery and coalesces reconnect checks", async () => {
  let finish!: () => void, disk = "[]", calls = 0;
  const q = new Outbox(async () => disk, async value => { disk = value; }, async () => { calls++; await new Promise<void>(resolve => { finish = resolve; }); });
  await q.add(item("first"));
  const sending = q.flush(); await new Promise(r => setImmediate(r));
  assert.equal(q.flush(), sending);
  await q.add(item("second")); assert.equal(JSON.parse(disk).length, 2);
  await assert.rejects(q.remove("first"), /being sent/);
  await q.remove("second"); finish(); await sending;
  assert.equal(calls, 1); assert.deepEqual(JSON.parse(disk), []);
});

it("#421 searches cached chat messages literally and shows the matching passage", async () => {
  const { cachedChatHits } = await import("../src/phone-batch-model.ts");
  const events = [
    { id: 1, kind: "message", payload: { text: "x".repeat(400) + " foo(BAR) here" } },
    { id: 2, kind: "message", chat: "side", payload: { text: "foo(bar) elsewhere" } },
    { id: 3, kind: "tool_call", payload: { text: "foo(bar) in a tool" } },
    { id: 4, kind: "message", payload: { text: "Newest foo(bar)" } },
  ];
  const hits = cachedChatHits(events, "main", "foo(bar)");
  assert.deepEqual(hits.map(h => h.eventId), [4, 1]);
  assert.match(hits[1]!.snippet, /foo\(BAR\)/);
  assert.deepEqual(cachedChatHits(events, "main", "  "), []);
});
