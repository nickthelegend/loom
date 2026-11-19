import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { Brain, type NewMemory } from "../src/core/brain.js";
import { EventLog } from "../src/core/eventlog.js";
import { applyExtraction } from "../src/core/brain-extract.js";
import { configureSource, refreshSources, sourcePatterns } from "../src/core/brain-r4/sources.js";
import { learnMergedPr, watchMergedPrs } from "../src/core/brain-r4/pr-learning.js";
import { RuntimeBriefings } from "../src/daemon/runtime/briefings.js";
import { Command } from "commander";
import { registerR4Brain } from "../src/cli/r4-brain.js";
import { tmpDir, waitUntil } from "./helpers.js";

const closes: Array<() => void> = [];
afterEach(() => { vi.restoreAllMocks(); closes.splice(0).forEach(close => close()); });
async function setup() {
  const dir = tmpDir("r4-review"), log = await EventLog.open(path.join(dir, ".loom")), brain = new Brain(log);
  closes.push(() => { brain.close(); log.close(); });
  const add = (text: string, extra: Partial<NewMemory> = {}) => brain.add({ text, kind: "fact", provenance: { agentId: "user", eventId: 0, ts: 1 }, ...extra });
  const briefings = () => {
    const value = new RuntimeBriefings({ info: { id: "test", name: "test", dir }, config: { name: "test", agents: [] }, log, brain, teamBrain: null, activeSkillsBlock: () => "", turnChat: new Map(), extractionEngine: () => async () => "", renderProjection: async () => { throw new Error("unused"); }, createSemanticIndex: () => { throw new Error("unused"); }, noteMemoriesUsed: () => {} });
    closes.unshift(() => value.close()); return value;
  };
  return { dir, log, brain, add, briefings };
}

it("rejects bad source registration atomically and skips oversized documents after registration", async () => {
  const { brain, dir } = await setup();
  fs.mkdirSync(path.join(dir, "docs"));
  const file = path.join(dir, "docs/large.md"); fs.writeFileSync(file, "x".repeat(1_000_001));
  expect(() => configureSource(brain, "docs/**/*.md", dir)).toThrow("1 MB");
  expect(sourcePatterns(brain)).toEqual([]); expect(brain.all()).toEqual([]);
  fs.writeFileSync(file, "Database uses SQLite WAL.");
  configureSource(brain, "docs/**/*.md", dir); refreshSources(brain, dir);
  const id = brain.all()[0]!.id;
  fs.writeFileSync(file, "x".repeat(1_000_001));
  expect(refreshSources(brain, dir)).toEqual({ added: 0, removed: 0, files: 0, skipped: 1 });
  expect(brain.get(id)).toBeDefined();
});

it("bounds source file and byte counts without throwing during automatic refresh", async () => {
  const { brain, dir } = await setup();
  const docs = path.join(dir, "docs"); fs.mkdirSync(docs);
  for (let i = 0; i < 501; i++) fs.writeFileSync(path.join(docs, `${i}.md`), "");
  expect(() => configureSource(brain, "docs/*.md", dir)).toThrow("500 files");
  expect(sourcePatterns(brain)).toEqual([]);
  brain.knowledge.record("source_add", { pattern: "docs/*.md" });
  expect(refreshSources(brain, dir)).toMatchObject({ files: 500, skipped: 1 });
  fs.rmSync(docs, { recursive: true }); fs.mkdirSync(docs);
  for (let i = 0; i < 12; i++) fs.writeFileSync(path.join(docs, `${i}.md`), "x".repeat(950_000));
  expect(() => configureSource(brain, "docs/*.md", dir)).toThrow("10 MB");
  expect(refreshSources(brain, dir)).toMatchObject({ files: 10, skipped: 2 });
});

it("keeps retrieval and turn briefings working from indexed chunks when a source cannot be read", async () => {
  const { brain, dir, briefings } = await setup();
  fs.mkdirSync(path.join(dir, "docs")); fs.writeFileSync(path.join(dir, "docs/test.md"), "Database uses SQLite WAL.");
  configureSource(brain, "docs/*.md", dir); refreshSources(brain, dir);
  const runtime = briefings();
  vi.spyOn(fs, "readdirSync").mockImplementation(() => { throw new Error("EACCES"); });
  expect(() => configureSource(brain, "other/*.md", dir)).toThrow("EACCES");
  expect(sourcePatterns(brain)).toEqual(["docs/*.md"]);
  expect(() => refreshSources(brain, dir)).toThrow("EACCES");
  expect(runtime.brainBrief({ query: "SQLite WAL" })).toContain("Database uses SQLite WAL");
  expect((await runtime.searchBrain({ query: "SQLite WAL" }))[0]?.memory.source).toBeDefined();
  expect((await runtime.turnMemoryBrief("SQLite WAL", "echo", "main", 100)).briefing).toContain("Database uses SQLite WAL");
});

it.each([false, true])("uses prior chat edits for path scope (absolute=%s) and excludes other chats and future edits", async absolute => {
  const { brain, dir, log, add, briefings } = await setup();
  const memory = add("Preserve accessibility.", { pinned: true, paths: ["src/web/**"] }).memory;
  add("Do not touch secrets.", { pinned: true, paths: ["secret/**"] });
  const runtime = briefings();
  log.append({ kind: "file_edit", chat: "elsewhere", payload: { path: "secret/file.ts" } });
  log.append({ kind: "file_edit", chat: "main", agentId: "other-agent", payload: { path: absolute ? path.join(dir, "src/web/main.js") : "src/web/main.js" } });
  const turn = log.append({ kind: "message", chat: "main", payload: { text: "keep going" } });
  log.append({ kind: "file_edit", chat: "main", payload: { path: "secret/file.ts" } });
  const selected = await runtime.turnMemoryBrief("keep going", "echo", "main", turn.id);
  expect(selected.briefing).toContain(memory.text); expect(selected.briefing).not.toContain("Do not touch secrets.");
  selected.record();
  expect(log.list({ kinds: ["status"] }).at(-1)?.payload.memories).toMatchObject([{ id: memory.id, detail: { matchedPaths: ["src/web/main.js"] } }]);
  expect(brain.get(memory.id)).toBeDefined();
});

it("dedupes without widening privacy, trust or expiry and still distinguishes pack, path and source", async () => {
  const { brain, add } = await setup();
  const protectedMemory = add("Keep credentials local.", { private: true, untrusted: true, expiresAt: 123 }).memory;
  const duplicate = add(protectedMemory.text, { tags: ["security"] });
  expect(duplicate.created).toBe(false);
  expect(duplicate.memory).toMatchObject({ id: protectedMemory.id, private: true, untrusted: true, expiresAt: 123, tags: ["security"] });
  expect(add(protectedMemory.text, { pack: "pack" }).created).toBe(true);
  expect(add(protectedMemory.text, { paths: ["src/**"] }).created).toBe(true);
  expect(add(protectedMemory.text, { source: { pattern: "*.md", file: "doc.md", line: 1, hash: "hash" } }).created).toBe(true);
  const trusted = add("Use npm test.").memory;
  expect(add(trusted.text, { untrusted: true }).memory).toEqual(trusted);
  expect(brain.all()).toHaveLength(5);
});

it("confirms already saved memories during review without proposing them again", async () => {
  const { brain, log, add } = await setup();
  const text = "Always run the database tests.";
  const saved = add(text, { scope: { chat: "main" }, private: true, expiresAt: Date.now() + 100000 }).memory;
  brain.knowledge.configure(true, "owner");
  for (let i = 0; i < 2; i++) {
    const result = applyExtraction(brain, [{ op: "ADD", kind: "fact", text, evidence: text }], text, [], { by: "echo", eventId: 10, chat: "main", untrusted: true });
    expect(result.dropped[0]?.reason).toContain("already known");
    expect(brain.knowledge.inbox()).toEqual([]);
  }
  expect(log.list({ kinds: ["memory_update"] }).filter(e => e.payload.confirm)).toHaveLength(2);
  expect(brain.get(saved.id)).toMatchObject({ private: true, expiresAt: saved.expiresAt });
  expect(brain.get(saved.id)?.untrusted).toBeUndefined();
  applyExtraction(brain, [{ op: "ADD", kind: "fact", text, evidence: text }], text, [], { by: "echo", eventId: 11, chat: "another" });
  expect(brain.knowledge.inbox()).toHaveLength(1);
});

it("folds knowledge once, follows external events, bounds feedback by id and changes by timestamp", async () => {
  const { brain, log, add } = await setup();
  const memory = add("Use SQLite.").memory;
  const list = vi.spyOn(log, "list");
  expect(brain.knowledge.settings().reviewBeforeSaving).toBe(false);
  expect(list.mock.calls.filter(([opts]) => opts?.kinds?.includes("status"))).toHaveLength(1);
  list.mockClear();
  const peer = new Brain(log); closes.unshift(() => peer.close());
  peer.knowledge.configure(true, "owner"); peer.knowledge.propose({ kind: "fact", text: "New proposal", provenance: memory.provenance });
  log.append({ kind: "status", payload: { state: "memory_injection", memories: [], text: "large unrelated payload" } });
  brain.knowledge.record("source_add", { pattern: "docs/*.md" });
  brain.knowledge.savePack("pack", "project");
  for (let i = 0; i < 10; i++) {
    expect(brain.knowledge.settings().reviewBeforeSaving).toBe(true);
    expect(brain.knowledge.inbox()).toHaveLength(1);
    expect(brain.knowledge.packs()[0]?.name).toBe("pack");
    expect(sourcePatterns(brain)).toEqual(["docs/*.md"]);
  }
  expect(list.mock.calls.filter(([opts]) => opts?.kinds?.includes("status"))).toHaveLength(1); // only the peer's first read
  list.mockClear();
  const injection = log.append({ kind: "status", payload: { state: "memory_injection", memories: [{ id: memory.id, text: memory.text }] } });
  brain.knowledge.feedback(memory.id, "helpful", injection.id, "owner");
  expect(list).toHaveBeenCalledWith({ kinds: ["status"], since: injection.id - 1, before: injection.id + 1, limit: 1 });
  list.mockClear(); brain.knowledge.changes(123);
  expect(list).toHaveBeenCalledWith({ kinds: ["memory_add", "memory_update", "memory_forget", "status"], sinceTs: 123 });
  const reloaded = new Brain(log); closes.unshift(() => reloaded.close());
  expect(reloaded.knowledge.settings()).toEqual(brain.knowledge.settings());
  expect(reloaded.knowledge.inbox()).toEqual(brain.knowledge.inbox());
  expect(reloaded.knowledge.sourcePatterns()).toEqual(sourcePatterns(brain));
  expect(reloaded.knowledge.packs()).toEqual(brain.knowledge.packs());
});

it("starts PR learning at upgrade and stops failed reads after three attempts across reopens", async () => {
  const { brain, log, dir } = await setup();
  const merge = (n: number) => log.append({ kind: "status", payload: { state: "pr_feedback", text: `PR #${n} merged`, url: `https://github.com/example/repo/pull/${n}` } });
  merge(1);
  const read = vi.fn(async (_url: string) => { throw new Error("offline"); });
  let stop = watchMergedPrs(brain, log, dir, read); closes.unshift(() => stop());
  const fresh = merge(2);
  await waitUntil(() => brain.knowledge.prFailures(String(fresh.payload.url)) === 1); stop();
  for (let count = 2; count <= 3; count++) {
    stop = watchMergedPrs(brain, log, dir, read);
    await waitUntil(() => brain.knowledge.prFailures(String(fresh.payload.url)) === count); stop();
  }
  stop = watchMergedPrs(brain, log, dir, read);
  await new Promise(resolve => setImmediate(resolve)); stop();
  expect(read).toHaveBeenCalledTimes(3);
  expect(read.mock.calls.every(args => String(args[0]).endsWith("/2"))).toBe(true);
  expect(brain.knowledge.events("pr_learning_started")).toHaveLength(1);
  expect(brain.knowledge.events("pr_learn_failed").map(e => e.payload.count)).toEqual([1, 2, 3]);
});

it("combines PR title and body, filters short feedback, caps comments, and counts actual proposals", async () => {
  const { brain, log } = await setup(); brain.knowledge.configure(true, "owner");
  const event = log.append({ kind: "status", chat: "main", payload: { url: "https://github.com/example/repo/pull/10" } });
  const data = { title: "Use SQLite WAL", body: "Readers should not block writers.", reviews: [{ body: "LGTM" }, { body: "nit: rename" }], comments: Array.from({ length: 20 }, (_, i) => ({ body: `Comment ${i}: preserve transactional integrity with concurrent writers.` })) };
  expect(learnMergedPr(brain, event, data).learned).toBe(11);
  expect(brain.knowledge.inbox()).toHaveLength(11);
  expect(brain.knowledge.inbox()[0]?.input.text).toContain("Use SQLite WAL\n\nReaders should not block writers.");
  expect(brain.knowledge.inbox().some(p => p.input.text.includes("LGTM"))).toBe(false);
  expect(brain.knowledge.events("pr_learned")[0]?.payload.learned).toBe(11);
  const retryEvent = log.append({ kind: "status", payload: { url: "https://github.com/example/repo/pull/11" } });
  const text = `Merged PR ${retryEvent.payload.url}: Already proposed`;
  brain.knowledge.propose({ kind: "decision", text, evidence: "Already proposed", untrusted: true, scope: {}, tags: ["merged-pr"], provenance: { agentId: "brain:pr", eventId: retryEvent.id, ts: retryEvent.ts } });
  expect(learnMergedPr(brain, retryEvent, { title: "Already proposed" }).learned).toBe(0);
});

it("retains chunk ids and usage when lines move, pairing repeated chunks by occurrence", async () => {
  const { brain, log, dir } = await setup();
  const file = path.join(dir, "guide.md"), repeated = "Repeat this database convention. ".repeat(24);
  const content = [repeated, "Another section of repository knowledge. ".repeat(20), repeated].join("\n\n");
  fs.writeFileSync(file, content); configureSource(brain, "guide.md", dir); refreshSources(brain, dir);
  const originals = brain.all(); expect(originals).toHaveLength(3);
  const injection = log.append({ kind: "status", payload: { state: "memory_injection", memories: originals.map(m => ({ id: m.id, text: m.text })) } });
  const last = log.lastId(); fs.writeFileSync(file, "\n" + content);
  expect(refreshSources(brain, dir)).toEqual({ added: 0, removed: 0, files: 1, skipped: 0 });
  expect(brain.all()).toEqual(originals); expect(log.lastId()).toBe(last);
  expect(log.list({ since: injection.id - 1, limit: 1 })[0]?.payload.memories).toHaveLength(3);
});

it("extends CLI flags without replacing any original action, including later flags", async () => {
  for (const [name, flags] of [["brain:list", ["--tag", "tests", "--sort", "usage"]], ["brain:search", ["--tag", "tests"]], ["brain:export", ["--tag", "tests"]], ["brain:add", ["--paths", "src/**"]]] as const) {
    const program = new Command(), original = vi.fn(); program.command(name).option("--json").action(original);
    registerR4Brain(program, async () => { throw new Error("replacement action ran"); }, async () => ({ id: "project" }));
    await program.parseAsync(["node", "loom", name, "--json", ...flags]);
    expect(original).toHaveBeenCalledOnce(); expect(original.mock.calls[0]?.[0]).toMatchObject({ json: true });
  }
});


it("waits for ProjectRuntime to assign its brain before initializing the PR watcher", async () => {
  const { brain, log, dir } = await setup();
  let assigned: Brain;
  const read = vi.fn(async () => ({ title: "Future merged decision" }));
  const stop = watchMergedPrs(() => assigned, log, dir, read); closes.unshift(stop);
  assigned = brain;
  await waitUntil(() => brain.knowledge.prLearningStarted() !== undefined);
  log.append({ kind: 'status', payload: { state: 'pr_feedback', text: 'PR #21 merged', url: 'https://github.com/example/repo/pull/21' } });
  await waitUntil(() => brain.knowledge.hasLearnedPr('https://github.com/example/repo/pull/21'));
  expect(read).toHaveBeenCalledOnce();
});


it("adds repeated chunks even when their current lines coincide with preserved stale lines", async () => {
  const { brain, dir } = await setup();
  const file = path.join(dir, 'repeats.md');
  const a = 'Keep this repeated convention. '.repeat(25), b = 'First introductory section. '.repeat(30), c = 'Second introductory section. '.repeat(30);
  fs.writeFileSync(file, [b, c, a, a].join('\n\n'));
  configureSource(brain, 'repeats.md', dir); refreshSources(brain, dir);
  const ids = brain.all().filter(m => m.text === a.trim()).map(m => m.id);
  fs.writeFileSync(file, [a, a].join('\n\n')); refreshSources(brain, dir);
  fs.writeFileSync(file, [a, a, a, a].join('\n\n'));
  expect(refreshSources(brain, dir)).toMatchObject({ added: 2, removed: 0 });
  expect(brain.all()).toHaveLength(4);
  expect(ids.every(id => brain.get(id))).toBe(true);
  expect(refreshSources(brain, dir)).toMatchObject({ added: 0, removed: 0 });
});
