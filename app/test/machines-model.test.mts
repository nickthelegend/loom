/** Several computers on one phone (machines-model.ts). */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { activeMachine, credsOf, machineForPush, nextAfter, removeMachine, renameMachine, upsertMachine } from "../src/machines-model.ts";

describe("machines", () => {
  it("adds computers, and re-pairing one refreshes it instead of adding a twin", () => {
    let { list, id: a } = upsertMachine([], { url: "http://100.1.1.1:7420", token: "t1" }, { name: "desk", now: 1, id: "a" });
    ({ list } = upsertMachine(list, { url: "http://100.2.2.2:7420", token: "t2", relay: { creds: 1 } }, { now: 2, id: "b" }));
    assert.deepEqual(list.map((m) => m.name), ["desk", "100.2.2.2:7420"]);
    const again = upsertMachine(list, { url: "http://100.1.1.1:7420", token: "t1-new" });
    assert.equal(again.id, a);
    assert.equal(again.list.length, 2);
    assert.equal(again.list[0]!.token, "t1-new");
    assert.deepEqual(credsOf(again.list[1]!), { url: "http://100.2.2.2:7420", token: "t2", relay: { creds: 1 } });
  });

  it("picks the active one, falls back to the first, and knows who's next", () => {
    const { list } = upsertMachine(upsertMachine([], { url: "http://a", token: "1" }, { id: "a" }).list, { url: "http://b", token: "2" }, { id: "b" });
    assert.equal(activeMachine(list, "b")!.id, "b");
    assert.equal(activeMachine(list, "gone")!.id, "a");
    assert.equal(activeMachine([], null), undefined);
    assert.equal(nextAfter(list, "a")!.id, "b");
    assert.equal(nextAfter(removeMachine(list, "b"), "a"), undefined);
    assert.equal(renameMachine(list, "a", "  studio mac ")[0]!.name, "studio mac");
    assert.equal(renameMachine(list, "a", "   ")[0]!.name, list[0]!.name);
  });

  it("a push finds the computer that sent it by hostname, else the active one", () => {
    let { list } = upsertMachine([], { url: "http://a", token: "1" }, { id: "a", name: "Nivesh-MacBook" });
    ({ list } = upsertMachine(list, { url: "http://b", token: "2" }, { id: "b", name: "build-box" }));
    assert.equal(machineForPush(list, "build-box", "a")!.id, "b");
    assert.equal(machineForPush(list, "nivesh-macbook", "b")!.id, "a");
    assert.equal(machineForPush(list, "unknown", "b")!.id, "b");
    assert.equal(machineForPush(list, undefined, "a")!.id, "a");
  });
});
