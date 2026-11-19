import { test } from "node:test";
import assert from "node:assert/strict";
import { acrossMachines, defaults, morning, moveReply, notificationReply, parsePreferences, yesterday } from "../src/r4-phone/model.ts";
import { Outbox } from "../src/phone-batch-model.ts";
test("quick replies are editable, reorderable, bounded and remembered", () => {
  const p = parsePreferences(JSON.stringify({ replies: ["Test", "Ship", "Explain"], textScale: 1.3, highContrast: true, briefTime: "08:15" }));
  assert.deepEqual(moveReply(p.replies, 1, -1), ["Ship", "Test", "Explain"]);
  assert.deepEqual(moveReply(p.replies, 0, -1), p.replies);
  assert.equal(p.textScale, 1.3); assert.equal(p.highContrast, true); assert.equal(p.briefTime, "08:15");
  assert.deepEqual(parsePreferences("broken"), defaults);
  assert.equal(parsePreferences('{"textScale":99,"briefTime":"25:00"}').briefTime, null);
  assert.equal(parsePreferences('{"textScale":99}').textScale, 1);
});
test("yesterday and morning use calendar boundaries", () => {
  const now = new Date(2026, 10, 19, 8, 30), r = yesterday(now);
  assert.equal(new Date(r.start).getDate(), 18); assert.equal(new Date(r.end).getHours(), 0);
  assert.equal(new Date(morning(now)).getDate(), 20);
  assert.equal(new Date(morning(new Date(2026, 10, 19, 6))).getDate(), 19);
});
test("one offline or revoked pairing leaves every other result attached to its machine", async () => {
  const result = await acrossMachines(["a", "b", "c"], async m => { if (m === "b") throw new Error("401"); return { project: "same-id", machine: m }; });
  assert.equal(result[0].data?.machine, "a"); assert.equal(result[1].data, null); assert.match(result[1].error!, /401/); assert.equal(result[2].data?.machine, "c");
});
test("notification text replies require exact pairing identity and supported categories", () => {
  const action = { id: "12345678", text: "  Continue  ", data: { clientId: "a", projectId: "p", chat: "c", kind: "needs_input" } };
  assert.equal(notificationReply(action, "b"), null);
  assert.equal(notificationReply({ ...action, text: " " }, "a"), null);
  assert.equal(notificationReply({ ...action, data: { ...action.data, kind: "approval" } }, "a"), null);
  assert.deepEqual(notificationReply(action, "a"), { id: "notification-12345678", project: "p", chat: "c", text: "Continue" });
});
test("notification replies persist offline and wait behind lock before receipt delivery", async () => {
  let disk: string | null = null, online = false, calls = 0;
  const sent = new Set<string>();
  const send = async (i: { id: string }) => { calls++; if (!online) throw new Error("offline"); sent.add(i.id); };
  const box = new Outbox(async () => disk, async v => { disk = v; }, send);
  await box.load(); await box.add(notificationReply({ id: "abcdefgh", text: "Run tests", data: { clientId: "a", projectId: "p", kind: "run_complete" } }, "a")!);
  await box.flush(() => false); assert.equal(calls, 0);
  await box.flush(); assert.equal(box.items.length, 1);
  const restored = new Outbox(async () => disk, async v => { disk = v; }, send); await restored.load(); online = true; await restored.flush();
  assert.equal(restored.items.length, 0); assert.deepEqual([...sent], ["notification-abcdefgh"]);
});

test("wide screens use a split layout and text scaling applies to code line height", async () => {
  const { wideLayout, scaledText } = await import("../src/r4-phone/model.ts");
  assert.equal(wideLayout(390), false); assert.equal(wideLayout(844), true); assert.equal(wideLayout(1024), true);
  assert.deepEqual(scaledText({ fontSize: 12, lineHeight: 16 }, 1.5), { fontSize: 18, lineHeight: 24 });
});

test("concurrent cloud requests retain the pairing that started them, including a late 401", async () => {
  const { pairedApi } = await import("../src/r4-phone/transport.ts");
  const managers: Array<{ token: string }> = [];
  const settled: string[] = [];
  const request = pairedApi(() => {
    const state = { token: "" }; managers.push(state);
    return {
      async routeFor(c) { state.token = c.token; await new Promise(r => setTimeout(r, c.token === "a" ? 10 : 1)); return "cloud"; },
      sawDirect() {}, async directFailed() { return "cloud"; },
      async relayClient() { return { async request(_method, _path, opts) { assert.equal(opts.auth, `Bearer ${state.token}`); return { status: state.token === "a" ? 401 : 200, body: { token: state.token } }; } }; },
    };
  }, async <T>(creds: { token: string }, status: number, body: Record<string, unknown>): Promise<T> => { settled.push(creds.token); if (status === 401) throw new Error(`revoked:${creds.token}`); return body as T; });
  const relay = { creds: { channel: "test", key: "test" }, supabaseUrl: "https://example.invalid", anonKey: "test" };
  const result = await Promise.allSettled([request({ url: "http://a", token: "a", relay }, "/now"), request({ url: "http://b", token: "b", relay }, "/now")]);
  assert.equal(managers.length, 2); assert.equal(result[0].status, "rejected"); assert.equal(result[1].status, "fulfilled"); assert.deepEqual(settled.sort(), ["a", "b"]);
});

test("swipes leave scrolling alone and read/unread changes can restore the prior mark", async () => {
  const { swipeOpensActions, readChange } = await import("../src/r4-phone/model.ts");
  assert.equal(swipeOpensActions(60, 10), true); assert.equal(swipeOpensActions(-60, 10), true);
  assert.equal(swipeOpensActions(40, 2), false); assert.equal(swipeOpensActions(60, 80), false);
  const before = { a: 10, b: 20 }, chat = { id: "a", lastReplyId: 30 };
  assert.deepEqual(readChange(before, chat, true), { a: 30, b: 20 });
  assert.deepEqual(readChange(before, chat, false), { a: -1, b: 20 }); assert.deepEqual(before, { a: 10, b: 20 });
});

test("nested text inherits its parent size and line height at every scale", async () => {
  const { textScaleStyle } = await import("../src/r4-phone/model.ts");
  assert.deepEqual(textScaleStyle({}, 1.5, true), {});
  assert.deepEqual(textScaleStyle({}, 1, true), {});
  assert.deepEqual(textScaleStyle({ lineHeight: 20 }, 1.5, true), {});
  assert.deepEqual(textScaleStyle({ fontSize: 16 }, 1.5, false), { fontSize: 24 });
  assert.deepEqual(textScaleStyle({ fontSize: 16 }, 1.5, true), { fontSize: 24 });
});
test("untouched quiet defaults use phone timezone before the first toggle", async () => {
  const { localQuiet } = await import("../src/r4-phone/model.ts");
  const q = { enabled: false, timeZone: "UTC", snoozeUntil: 0 };
  assert.equal(localQuiet(q, "Asia/Kolkata").timeZone, "Asia/Kolkata");
  assert.equal(localQuiet({ ...q, enabled: true }, "Asia/Kolkata").timeZone, "UTC");
  assert.equal(localQuiet({ ...q, snoozeUntil: 123 }, "Asia/Kolkata").timeZone, "UTC");
  assert.equal(localQuiet({ ...q, timeZone: "Europe/London" }, "Asia/Kolkata").timeZone, "Europe/London");
});
test("cold-start notifications resolve unique names safely; unmatched and failed replies rotate without loss", async () => {
  const { notificationMachine, rotateReply } = await import("../src/r4-phone/model.ts");
  const a = { name: "Laptop" }, b = { name: "Desktop" }, identities = [{ m: a, id: null }, { m: b, id: "b" }];
  assert.equal(notificationMachine(identities, { clientId: "unknown", daemon: "LAPTOP" }), a);
  assert.equal(notificationMachine(identities, { clientId: "b", daemon: "Laptop" }), b);
  assert.equal(notificationMachine(identities, { clientId: "unknown", daemon: "unknown" }), undefined);
  assert.equal(notificationMachine([{ m: a, id: null }], { clientId: "old" }, true), a);
  assert.equal(notificationMachine([{ m: a, id: null }], { clientId: "old" }), undefined);
  assert.equal(notificationMachine([{ m: a, id: null }, { m: { name: "laptop" }, id: null }], { daemon: "Laptop" }), undefined);
  assert.deepEqual(rotateReply(["failed", "ready"]), ["ready", "failed"]);
  assert.deepEqual(rotateReply(["unmatched"]), ["unmatched"]);
});

test("a sleeping background computer cannot overwrite the active push status", async () => {
  const { pushRegistration, backgroundMachines } = await import("../src/r4-phone/push-state.ts");
  const reg = pushRegistration(async (name: string) => name === "awake" ? "on" : "unavailable");
  await reg.active("awake"); assert.equal(await reg.background("asleep"), "unavailable");
  assert.equal(reg.last(), "on");
  assert.deepEqual(backgroundMachines([{ id: "awake" }, { id: "asleep" }], "awake"), [{ id: "asleep" }]);
});
