import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Brain, staleMemory, type Memory } from "../src/core/brain.js";
import { compileBrief, findDuplicates, retrieve } from "../src/core/brain-index.js";
import { brainMarkdown, parseBrainMarkdown, readMarkdownUrl, writeBrainMarkdown } from "../src/core/brain-markdown.js";
import { RuntimeBriefings } from "../src/daemon/runtime/briefings.js";
import { EventLog } from "../src/core/eventlog.js";
import { retrieveTiered } from "../src/core/team-memory.js";
import { shareable } from "../src/daemon/team-brain.js";
import { tmpDir } from "./helpers.js";

const opened: Array<{ brain: Brain; log: EventLog }> = [];
async function setup() {
  const dir = tmpDir("r3-brain");
  const log = await EventLog.open(dir), brain = new Brain(log);
  opened.push({ brain, log });
  const add = (text: string, opts: Partial<Memory> = {}) => brain.add({ kind: "fact", text, provenance: { agentId: "echo", eventId: 1, ts: Date.now() }, ...opts }).memory;
  return { brain, log, dir, add };
}
afterEach(async () => { for (const { brain, log } of opened.splice(0)) { brain.close(); await log.close(); } });

describe("#419 brain and memory", () => {
  it("filters before the search limit by kind, author and inclusive creation dates", async () => {
    const { brain, add } = await setup();
    const first = add("Use sqlite for durable memory.", { kind: "decision" });
    add("Use sqlite for the task cache.", { kind: "task" });
    expect(retrieve(brain, { query: "sqlite", kind: "decision", author: "echo", since: first.createdAt, until: first.createdAt, limit: 1 }).map(h => h.memory.id)).toEqual([first.id]);
    expect(retrieve(brain, { query: "sqlite", author: "someone-else" })).toEqual([]);
    expect(retrieve(brain, { query: "sqlite", until: first.createdAt - 1 })).toEqual([]);
  });

  it("keeps identical memories separate by chat, agent, task and crew", async () => {
    const { brain, add } = await setup();
    const scopes = [{}, { chat: "main" }, { chat: "other" }, { agent: "echo" }, { task: "one" }, { crew: "crew" }];
    for (const scope of scopes) add("Run the tests.", { scope });
    expect(brain.all()).toHaveLength(scopes.length);
    add("Run the tests.", { scope: { chat: "main" } });
    expect(brain.all()).toHaveLength(scopes.length);
    const hits = retrieve(brain, { query: "tests" });
    expect(hits.every(h => !h.memory.scope.chat && !h.memory.scope.agent && !h.memory.scope.crew)).toBe(true);
    expect(retrieve(brain, { query: "tests", chat: "main" }).some(h => h.memory.scope.chat === "other")).toBe(false);
  });

  it("includes every eligible pin above the limit in priority order", async () => {
    const { brain, add } = await setup();
    const a = add("Keep credentials private.", { pinned: true, priority: 5 });
    const b = add("Preserve accessibility.", { pinned: true, priority: 20 });
    add("Secret chat rule.", { pinned: true, priority: 100, scope: { chat: "secret" } });
    add("Expired rule.", { pinned: true, expiresAt: Date.now() - 1 });
    add("Uncertain rule.", { pinned: true, confidence: 0.1 });
    const hits = retrieve(brain, { query: "unrelated", limit: 1, minConfidence: 0.6, explain: true });
    expect(hits.map(h => h.memory.id)).toEqual([b.id, a.id]);
    expect(compileBrief(hits.map(h => h.memory)).indexOf(b.text)).toBeLessThan(compileBrief(hits.map(h => h.memory)).indexOf(a.text));
    brain.update(a.id, { archived: true }, "user");
    expect(retrieve(brain, { limit: 0, minConfidence: 0.6 }).map(h => h.memory.id)).toEqual([b.id]);
    const team = retrieveTiered(brain.all().map(m => ({ ...m, tier: "own" as const, updatedAt: 1 })), { limit: 1, minConfidence: 0.6 });
    expect(team.map(h => h.memory.id)).toEqual([b.id]);
  });

  it("flags unused memories at 30 days; editing does not pretend they were used", async () => {
    const { brain, add } = await setup();
    const m = add("Old but still true.");
    const month = 30 * 86400000;
    expect(staleMemory(m, undefined, m.createdAt + month - 1)).toBe(false);
    expect(staleMemory({ ...m, updatedAt: m.createdAt + month }, undefined, m.createdAt + month)).toBe(true);
    expect(staleMemory(m, m.createdAt + month, m.createdAt + month)).toBe(false);
    brain.update(m.id, { archived: true }, "reviewer");
    expect(brain.list()).toEqual([]);
    expect(brain.list({ includeArchived: true })).toHaveLength(1);
    expect(staleMemory(brain.get(m.id)!, undefined, m.createdAt + month)).toBe(false);
  });

  it("suggests near duplicates, excludes contradictions and scopes, and archives the merged copy", async () => {
    const { brain, add } = await setup();
    const a = add("The database connection always uses sqlite in this project.");
    const b = add("The database connection always uses sqlite in this project!", { pinned: true, priority: 3 });
    add("The database connection never uses sqlite in this project.");
    add(a.text, { scope: { chat: "private" } });
    expect(findDuplicates(brain.all()).map(d => [d.a.id, d.b.id].sort())).toEqual([[a.id, b.id].sort()]);
    const result = brain.merge(a.id, b.id, "Use sqlite for the database connection.", "reviewer");
    expect(result).toMatchObject({ pinned: true, priority: 3 });
    expect(brain.get(b.id)?.archived).toBe(true);
    expect(findDuplicates(brain.all())).toEqual([]);
    expect(brain.history(b.id).at(-1)?.by).toBe("reviewer");
  });

  it("records field changes, before/after values, and reverts all editable fields as a new revision", async () => {
    const { brain, add, log } = await setup();
    const m = add("Keep this original.");
    const original = brain.history(m.id)[0]!;
    brain.update(m.id, { text: "Changed wording.", scope: { chat: "main" }, pinned: true, priority: 8, archived: true }, "editor");
    const changed = brain.history(m.id).at(-1)!;
    expect(changed).toMatchObject({ by: "editor", before: { text: m.text }, after: { text: "Changed wording." }, patch: { priority: 8 } });
    brain.revert(m.id, original.eventId, "owner");
    expect(brain.get(m.id)).toMatchObject({ text: m.text, scope: {}, pinned: false, priority: 0, archived: false });
    expect(brain.history(m.id)).toHaveLength(3);
    const another = new Brain(log);
    expect(another.get(m.id)).toEqual(brain.get(m.id)); another.close();
    expect(() => brain.revert(m.id, 999999, "owner")).toThrow("revision");
  });

  it("exports readable Markdown, round trips scopes and pins, and imports plain Markdown idempotently", async () => {
    const { brain, add } = await setup();
    add("Use sqlite.\n\nKeep migrations reviewed.", { kind: "decision", scope: { chat: "main" }, pinned: true, priority: 9 });
    const md = brainMarkdown(brain.export("project"));
    expect(md).toContain("## decision");
    expect(md).toContain("Keep migrations reviewed.");
    const target = await setup();
    target.brain.import(parseBrainMarkdown(md), { agentId: "import", eventId: 1, ts: Date.now() });
    expect(target.brain.all()[0]).toMatchObject({ scope: { chat: "main" }, pinned: true, priority: 9, text: brain.all()[0]!.text });
    const plain = parseBrainMarkdown("# Notes\n\n## Constraints\n\n- Keep credentials private.\n- Use HTTPS.\n\n## Facts\n\nSQLite stores the events.");
    expect(plain.memories.map(m => m.kind)).toEqual(["constraint", "constraint", "fact"]);
    expect(target.brain.import(plain, { agentId: "import", eventId: 1, ts: 1 })).toEqual({ added: 3, known: 0 });
    expect(target.brain.import(plain, { agentId: "import", eventId: 1, ts: 1 })).toEqual({ added: 0, known: 3 });
  });

  it("confines repo exports, preserves existing files, and rejects private URL imports", async () => {
    const { brain, dir, add } = await setup(); add("Export me.");
    expect(writeBrainMarkdown(dir, "docs/BRAIN.md", brain.export("project"))).toBe("docs/BRAIN.md");
    expect(fs.readFileSync(path.join(dir, "docs/BRAIN.md"), "utf8")).toContain("Export me.");
    expect(() => writeBrainMarkdown(dir, "docs/BRAIN.md", brain.export("project"))).toThrow();
    expect(() => writeBrainMarkdown(dir, "../outside.md", brain.export("project"))).toThrow();
    fs.symlinkSync(tmpDir("outside"), path.join(dir, "escape"));
    expect(() => writeBrainMarkdown(dir, "escape/brain.md", brain.export("project"))).toThrow();
    for (const url of ["http://127.0.0.1/brain.md", "http://[::1]/brain.md", "file:///tmp/brain.md", "https://user:pass@example.com/brain.md"]) await expect(readMarkdownUrl(url)).rejects.toThrow();
  });

  it("snapshots only explicit pins for native continuity and records usage only on dispatch", async () => {
    const { brain, log, dir, add } = await setup();
    const pin = add("Native pin selected regardless of query.", { pinned: true, scope: { chat: "main" } });
    add("Relevant native query fact.");
    add("A different chat pin.", { pinned: true, scope: { chat: "other" } });
    const used: string[][] = [];
    const briefings = new RuntimeBriefings({ info: { id: "test", name: "test", dir }, config: { name: "test", agents: [{ id: "echo", kind: "echo" }] },
      log, brain, teamBrain: null, activeSkillsBlock: () => "", turnChat: new Map(),
      extractionEngine: () => async () => "", renderProjection: async () => { throw new Error("not needed for memory retrieval"); },
      createSemanticIndex: () => { throw new Error("semantic retrieval is disabled"); }, noteMemoriesUsed: ids => used.push(ids) });
    const prepared = await briefings.turnMemoryBrief("Relevant native query", "echo", "main", 123, true);
    expect(prepared.briefing).toContain(pin.text);
    expect(prepared.briefing).not.toContain("Relevant native query fact");
    expect(log.list({ kinds: ["status"] })).toEqual([]);
    expect(used).toEqual([]);
    prepared.record();
    expect(used).toEqual([[pin.id]]);
    const saved = log.list({ kinds: ["status"] })[0]!;
    brain.update(pin.id, { text: "Edited later." }, "user");
    expect(saved.payload).toMatchObject({ turn: 123, memories: [{ id: pin.id, text: pin.text, reason: "pinned" }] });
    expect(log.list({ kinds: ["status"] })[0]!.payload).toEqual(saved.payload);
    briefings.close();
  });

  it("round trips Markdown-looking metadata inside memory text without creating another memory", async () => {
    const { brain, add } = await setup();
    const text = 'A literal marker: <!-- loom-memory {"kind":"fact"} -->';
    add(text, { private: true, untrusted: true, scope: { task: "task" } });
    const parsed = parseBrainMarkdown(brainMarkdown(brain.export("markers")));
    expect(parsed.memories).toHaveLength(1);
    expect(parsed.memories[0]).toMatchObject({ text, private: true, untrusted: true, task: "task" });
    expect(parseBrainMarkdown("## Facts\nKeep the text after a heading.").memories[0]?.text).toBe("Keep the text after a heading.");
  });

  it("never shares chat-only or archived memories with a team", async () => {
    const { brain, add } = await setup();
    const m = add("Shared convention.", { kind: "convention" });
    expect(shareable(m)).toBe(true);
    expect(shareable({ ...m, scope: { chat: "main" } })).toBe(false);
    expect(shareable(brain.update(m.id, { archived: true }, "user"))).toBe(false);
  });
});
