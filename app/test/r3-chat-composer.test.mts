import assert from "node:assert/strict";
import { it } from "node:test";
import { DraftSession, firstUnread, variables, fillVariables } from "../src/chat-composer-model.ts";

it("serializes draft revisions and does not replace typing with a late load", async () => {
  let release!: (d: { draft: string; revision: number }) => void;
  const loaded: string[] = [], written: Array<{ draft: string; revision: number }> = [], errors: unknown[] = [];
  const session = new DraftSession(() => new Promise(resolve => { release = resolve; }), async d => {
    written.push(d); return { draft: d.draft, revision: d.revision + 1 };
  }, t => loaded.push(t), e => errors.push(e));
  const first = session.save("typing"), last = session.save("typing more");
  release({ draft: "old draft", revision: 8 }); await first; await last;
  assert.deepEqual(loaded, []); assert.deepEqual(written, [{ draft: "typing", revision: 8 }, { draft: "typing more", revision: 9 }]); assert.deepEqual(errors, []);
});
it("restores a daemon draft and stops writes after a conflict", async () => {
  const loaded: string[] = [], errors: unknown[] = []; let writes = 0;
  const session = new DraftSession(async () => ({ draft: "desktop", revision: 2 }), async () => { writes++; throw new Error("conflict"); }, t => loaded.push(t), e => errors.push(e));
  await new Promise(resolve => setTimeout(resolve, 0));
  await session.save("phone"); await session.save("phone later");
  assert.deepEqual(loaded, ["desktop"]); assert.equal(writes, 1); assert.equal(errors.length, 1);
});
it("finds the first unread reply, excluding tools, reasoning and first visits", () => {
  const events = [
    { id: 2, kind: "message", payload: { author: "user" } },
    { id: 3, kind: "tool_call", agentId: "echo", payload: {} },
    { id: 4, kind: "message", agentId: "echo", payload: { reasoning: true } },
    { id: 5, kind: "message", agentId: "echo", payload: { text: "reply" } },
  ];
  assert.equal(firstUnread(events, 2), 5); assert.equal(firstUnread(events), null); assert.equal(firstUnread(events, 5), null);
});
it("fills repeated named template variables literally", () => {
  assert.deepEqual(variables("{{ file }} {{file}} {{topic-name}}"), ["file", "topic-name"]);
  assert.equal(fillVariables("{{ file }} {{file}}", { file: "$& <b>" }), "$& <b> $& <b>");
  assert.equal(fillVariables("{{toString}}", {}), "");
});
