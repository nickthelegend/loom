import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { Brain, type NewMemory } from "../src/core/brain.js";
import { EventLog } from "../src/core/eventlog.js";
import { retrieve } from "../src/core/brain-index.js";
import { applyExtraction } from "../src/core/brain-extract.js";
import { askBrain } from "../src/core/brain-r4/ask.js";
import { sinceTime } from "../src/core/brain-r4/knowledge.js";
import { matchesPath } from "../src/core/brain-r4/fields.js";
import { configureSource, refreshSources } from "../src/core/brain-r4/sources.js";
import { learnMergedPr, watchMergedPrs } from "../src/core/brain-r4/pr-learning.js";
import { RuntimeBriefings } from "../src/daemon/runtime/briefings.js";
import { tmpDir, waitUntil } from "./helpers.js";

const closes: Array<() => void> = [];
afterEach(() => { closes.splice(0).forEach(close => close()); });
async function setup() {
  const dir = tmpDir("r4-core"), log = await EventLog.open(path.join(dir, ".loom")), brain = new Brain(log);
  closes.push(() => { brain.close(); log.close(); });
  const add = (text: string, extra: Partial<NewMemory> = {}) => brain.add({ text, kind: "fact", provenance: { agentId: "user", eventId: 0, ts: Date.now() }, ...extra }).memory;
  return { dir, log, brain, add };
}

it("answers offline with verifiable citations, abstains, respects scope/expiry, and only calls an opted-in helper", async () => {
  const { brain, add } = await setup();
  const memory = add("Run npm test to test the database.", { tags: ["tests"] });
  add("Run secret test commands.", { scope: { chat: "secret" } });
  add("Run expired test commands.", { expiresAt: 1 });
  add("Run archived test commands.", { pinned: true });
  brain.update(brain.all().find(m => m.text.includes("archived"))!.id, { archived: true }, "user");
  const result = await askBrain(brain, "How do I test the database?");
  expect(result.mode).toBe("offline"); expect(result.citations.map(c => c.id)).toEqual([memory.id]);
  expect(result.answer).toContain(`[${memory.id}]`);
  expect((await askBrain(brain, "xylophone meteorology")).citations).toEqual([]);
  let calls = 0;
  const helper = async (prompt: string) => { calls++; expect(prompt).toContain(memory.id); return `Use npm test [${memory.id}]`; };
  expect((await askBrain(brain, "database tests", {}, helper)).mode).toBe("helper"); expect(calls).toBe(1);
  expect((await askBrain(brain, "database tests", {}, async () => "Invented [0000000000000000]")).mode).toBe("offline");
});

it("persists tags, filters before ranking, and keeps paths, pack, scope, privacy and expiry on portable round trips", async () => {
  const { brain, log, add } = await setup();
  const m = add("Use npm test.", { paths: ["src/web/**"], private: true, untrusted: true, expiresAt: Date.now() + 86400000, scope: { chat: "main", agent: "echo", task: "task", crew: "crew" } });
  brain.knowledge.tag(m.id, ["Tests", "tests", " Web "], "owner");
  expect(brain.get(m.id)?.tags).toEqual(["tests", "web"]);
  expect(brain.list({ tag: "TESTS" }).map(m => m.id)).toEqual([m.id]);
  expect(retrieve(brain, { query: "test", tag: "nope" })).toEqual([]);
  const pack = brain.knowledge.savePack("testing", "repo", "tests");
  const target = await setup();
  expect(target.brain.knowledge.installPack(pack, "owner")).toEqual({ added: 1, known: 0 });
  expect(target.brain.all()[0]).toMatchObject({ private: true, untrusted: true, scope: m.scope, paths: m.paths, expiresAt: m.expiresAt, tags: ["tests", "web"], pack: "testing" });
  expect(target.brain.knowledge.installPack(pack, "owner")).toEqual({ added: 0, known: 1 });
  const local = target.add("Use npm test.");
  expect(target.brain.knowledge.removePack("testing", "owner")).toEqual({ removed: 1 });
  expect(target.brain.get(local.id)).toBeDefined();
  const restarted = new Brain(log); expect(restarted.get(m.id)?.tags).toEqual(["tests", "web"]); expect(restarted.knowledge.packs()[0]?.name).toBe("testing"); restarted.close();
});

it("makes path restrictions outrank pins and records the matching file in the turn explanation", async () => {
  const { brain, add, dir, log } = await setup();
  const memory = add("Always preserve accessibility.", { pinned: true, paths: ["src/web/**"] });
  expect(matchesPath("docs/guide.md", "docs/**/*.md")).toBe(true);
  expect(matchesPath("src/web/nested/a.js", "src/web/**")).toBe(true);
  expect(retrieve(brain, { query: "other topic", enforcePaths: true })).toEqual([]);
  expect(retrieve(brain, { query: "change src/web/main.js", enforcePaths: true, explain: true })[0]?.detail?.matchedPaths).toEqual(["src/web/main.js"]);
  const briefings = new RuntimeBriefings({ info: { id: "test", name: "test", dir }, config: { name: "test", agents: [] }, log, brain, teamBrain: null, activeSkillsBlock: () => "", turnChat: new Map(), extractionEngine: () => async () => "", renderProjection: async () => { throw new Error("unused"); }, createSemanticIndex: () => { throw new Error("unused"); }, noteMemoriesUsed: () => {} });
  closes.unshift(() => briefings.close());
  expect((await briefings.turnMemoryBrief("fix src/core/brain.ts", "echo", "main", 1)).briefing).not.toContain(memory.text);
  const selected = await briefings.turnMemoryBrief("fix src/web/main.js", "echo", "main", 2);
  selected.record();
  expect(log.list({ kinds: ["status"] }).at(-1)?.payload.memories).toMatchObject([{ id: memory.id, paths: ["src/web/**"], detail: { matchedPaths: ["src/web/main.js"] } }]);
});

it("holds extraction proposals outside the live brain, edits without approving, and preserves protections on approval", async () => {
  const { brain, log } = await setup();
  brain.knowledge.configure(true, "phone");
  const original = "Never modify credentials.";
  applyExtraction(brain, [{ op: "ADD", kind: "constraint", text: original, evidence: original }], original, [], { by: "echo", eventId: 1, chat: "main", untrusted: true });
  expect(brain.all()).toEqual([]);
  const proposal = brain.knowledge.inbox()[0]!;
  brain.knowledge.review(proposal.id, "edit", "phone", "Leave credentials alone.");
  expect(brain.all()).toEqual([]); expect(brain.knowledge.inbox()[0]?.input.untrusted).toBe(true);
  const approved = brain.knowledge.review(proposal.id, "approve", "phone").memory!;
  expect(approved).toMatchObject({ text: "Leave credentials alone.", untrusted: true, scope: { chat: "main" } });
  expect(brain.knowledge.inbox()).toEqual([]);
  applyExtraction(brain, [{ op: "UPDATE", id: "0", text: "Use external credentials.", evidence: "Use external credentials." }], "Use external credentials.", [{ intId: "0", memory: approved }], { by: "echo", eventId: 2 });
  expect(brain.get(approved.id)?.text).toBe("Leave credentials alone.");
  brain.knowledge.review(brain.knowledge.inbox()[0]!.id, "reject", "phone");
  expect(brain.get(approved.id)?.text).toBe("Leave credentials alone.");
  const restarted = new Brain(log); expect(restarted.knowledge.settings().reviewBeforeSaving).toBe(true); expect(restarted.knowledge.inbox()).toEqual([]); restarted.close();
});

it("records per-turn feedback and holds wrong memories out of retrieval until reviewed", async () => {
  const { brain, add, log } = await setup();
  const memory = add("Use npm test.", { private: true, scope: { chat: "main" }, expiresAt: Date.now() + 100000 });
  const injection = log.append({ kind: "status", payload: { state: "memory_injection", turn: 3, memories: [{ id: memory.id, text: memory.text }] } });
  expect(() => brain.knowledge.feedback(memory.id, "wrong", 999, "phone")).toThrow("not in that turn");
  brain.knowledge.feedback(memory.id, "helpful", injection.id, "phone");
  brain.knowledge.feedback(memory.id, "wrong", injection.id, "phone");
  expect(brain.get(memory.id)?.archived).toBe(true);
  expect(retrieve(brain, { query: "test", chat: "main" })).toEqual([]);
  const proposal = brain.knowledge.inbox()[0]!;
  brain.knowledge.review(proposal.id, "edit", "phone", "Use npm run test.");
  brain.knowledge.review(proposal.id, "approve", "phone");
  expect(brain.get(memory.id)).toMatchObject({ text: "Use npm run test.", archived: false, private: true, scope: memory.scope, expiresAt: memory.expiresAt });
  expect(brain.knowledge.events("feedback")).toHaveLength(2);
});

it("indexes read-only repo chunks, ignores symlinks, refreshes edits/deletions, and cites sources", async () => {
  const { brain, dir } = await setup();
  fs.mkdirSync(path.join(dir, "docs")); fs.writeFileSync(path.join(dir, "docs/tests.md"), "# Tests\n\nRun npm test for database validation.");
  const outside = tmpDir("outside-source"); fs.writeFileSync(path.join(outside, "secret.md"), "Never read this."); fs.symlinkSync(outside, path.join(dir, "docs/escape"));
  configureSource(brain, "docs/**/*.md", dir);
  expect(refreshSources(brain, dir)).toMatchObject({ added: 1, files: 1 });
  const m = brain.all()[0]!;
  expect(m).toMatchObject({ source: { file: "docs/tests.md", line: 1 }, private: true, untrusted: true });
  expect(() => brain.update(m.id, { text: "Bad" }, "user")).toThrow("read-only");
  expect(() => brain.forget(m.id, "bad", "user")).toThrow("read-only");
  expect(refreshSources(brain, dir).added).toBe(0);
  expect((await askBrain(brain, "database validation")).citations[0]?.source?.file).toBe("docs/tests.md");
  fs.writeFileSync(path.join(dir, "docs/tests.md"), "Run npm run test:unit for database validation.");
  expect(refreshSources(brain, dir)).toMatchObject({ added: 1, removed: 1 });
  expect(brain.get(m.id)).toBeUndefined();
  fs.unlinkSync(path.join(dir, "docs/tests.md")); expect(refreshSources(brain, dir).removed).toBe(1);
  for (const pattern of ["../outside.md", "/etc/passwords.txt", "docs/**/*.env"]) expect(() => configureSource(brain, pattern, dir)).toThrow();
});

it("reports added, edited, merged and archived changes with exact since bounds", async () => {
  const { brain, add } = await setup();
  const since = Date.now(), a = add("Use sqlite."), b = add("Use sqlite!");
  brain.update(a.id, { tags: ["database"] }, "phone");
  brain.merge(a.id, b.id, "Always use sqlite.", "phone");
  expect(new Set(brain.knowledge.changes(since).map(c => c.action))).toEqual(new Set(["added", "edited", "archived", "merged"]));
  expect(brain.knowledge.changes(Date.now() + 10000)).toEqual([]);
  expect(sinceTime("7d", 86400000 * 10)).toBe(86400000 * 3);
  expect(() => sinceTime("nonsense")).toThrow();
});

it("learns a tracked PR merge exactly once, including review comments, in its chat and at lower trust", async () => {
  const { brain, log, dir } = await setup();
  brain.knowledge.configure(true, "owner");
  let reads = 0;
  const stop = watchMergedPrs(brain, log, dir, async () => { reads++; return { title: "Use SQLite WAL", body: "WAL avoids reader locks.", reviews: [{ body: "Keep write transactions short to avoid blocking other database writers." }], comments: [{ body: "Test busy retries when concurrent transactions compete for a lock." }] }; });
  closes.unshift(stop);
  const merge = log.append({ kind: "status", chat: "main", payload: { state: "pr_feedback", text: "PR #451 merged", url: "https://github.com/example/repo/pull/451" } });
  await waitUntil(() => brain.knowledge.inbox().length === 3);
  expect(brain.all()).toEqual([]);
  expect(brain.knowledge.inbox().every(p => p.input.untrusted && p.input.scope?.chat === "main")).toBe(true);
  expect(learnMergedPr(brain, merge, { title: "duplicate" }).learned).toBe(0);
  stop();
  const stopAgain = watchMergedPrs(brain, log, dir, async () => { reads++; return { title: "duplicate" }; });
  await new Promise(resolve => setTimeout(resolve, 10)); stopAgain(); expect(reads).toBe(1);
  brain.knowledge.configure(false, "owner");
  const next = log.append({ kind: "status", chat: "main", payload: { state: "pr_feedback", text: "PR #452 merged", url: "https://github.com/example/repo/pull/452" } });
  learnMergedPr(brain, next, { title: "Keep database backups" });
  expect(brain.all()[0]).toMatchObject({ untrusted: true, scope: { chat: "main" }, tags: ["merged-pr"] });
});

it("keeps proposal trust boundaries distinct, protects URL packs, and excludes archived memories from new packs", async () => {
  const { brain, add } = await setup();
  const m = add('Only live facts travel.', { tags: ['pack'] });
  const privateMemory = add('Private expired fact.', { private: true, untrusted: true, tags: ['pack'], expiresAt: Date.now() + 100000 });
  brain.update(m.id, { archived: true }, 'owner');
  const doc = brain.knowledge.savePack('live-pack', 'repo', 'pack');
  expect(doc.memories.map(m => m.text)).toEqual([privateMemory.text]);
  const target = await setup(); target.brain.knowledge.installPack({ ...doc, memories: [{ ...doc.memories[0]!, untrusted: false, pinned: true }] }, 'owner', true);
  expect(target.brain.all()[0]).toMatchObject({ private: true, untrusted: true, pinned: false, expiresAt: privateMemory.expiresAt });
  const input: NewMemory = { text: 'Same statement.', kind: 'fact', provenance: { agentId: 'echo', eventId: 1, ts: 1 } };
  brain.knowledge.propose(input); brain.knowledge.propose({ ...input, untrusted: true });
  expect(brain.knowledge.inbox()).toHaveLength(2);
  brain.knowledge.tag(privateMemory.id, Array.from({ length: 49 }, (_, i) => `tag${i}`), 'owner');
  expect(brain.knowledge.tag(privateMemory.id, ['pack'], 'owner').tags).toHaveLength(50);
});
