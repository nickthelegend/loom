import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { logbook } from "../src/core/logbook.js";
import { LoomDaemon } from "../src/daemon/server.js";
import { DaemonClient } from "../src/daemon/client.js";
import { readDaemonConfig } from "../src/core/registry.js";
import type { Memory } from "../src/core/brain.js";
import type { Proposal } from "../src/core/brain-r4/knowledge.js";
import { makeProjectDir, tmpDir, waitUntil } from "./helpers.js";

let daemon: LoomDaemon, base: string, token: string, project: string, dir: string, client: DaemonClient;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
beforeAll(async () => {
  process.env.LOOM_HOME = tmpDir("r4-http-home"); process.env.LOOM_NO_NOTIFY = "1";
  daemon = new LoomDaemon({ host: "127.0.0.1", port: 0 }); const address = await daemon.listen(); base = `http://${address.host}:${address.port}`;
  token = readDaemonConfig()!.adminToken; client = new DaemonClient(readDaemonConfig()!);
  dir = makeProjectDir({ agents: [{ id: "echo", kind: "echo", role: "worker" }] }); project = (await client.addProject(dir)).project.id;
});
afterAll(async () => { await daemon.close(); });
function request(route: string, method = "GET", body?: unknown, bearer = token) {
  return fetch(base + route, { method, headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
async function brain<T = Record<string, unknown>>(route = "", method = "GET", body?: unknown, bearer = token): Promise<T> {
  const response = await request(`/api/projects/${project}/brain${route}`, method, body, bearer), result = await response.json();
  expect(response.status, JSON.stringify(result)).toBe(200); return result as T;
}
async function add(text: string, extra: object = {}) { return (await brain<{ memory: Memory }>("", "POST", { text, kind: "fact", ...extra })).memory; }
function cli(args: string[]) {
  return new Promise<{ code: number; stdout: string; stderr: string }>(resolve => {
    execFile(process.execPath, [path.join(root, "node_modules/tsx/dist/cli.mjs"), path.join(root, "src/cli/index.ts"), ...args], { cwd: dir, env: { ...process.env, NO_COLOR: "1" }, timeout: 60_000 }, (error, stdout, stderr) => resolve({ code: error ? 1 : 0, stdout, stderr }));
  });
}
async function run(args: string[]) { const result = await cli(args); expect(result.code, result.stdout + result.stderr).toBe(0); return result.stdout; }

it("combines ask, tags, interview answers and change history across the API", async () => {
  const m = await add("r4451 Run npm test for database tests.", { paths: ["src/web/**"], private: true, untrusted: true, tags: ["Tests"] });
  await brain(`/${m.id}/tags`, "POST", { tags: ["Database", "tests"] });
  const result = await brain<{ answer: string; citations: Array<{ id: string }>; mode: string }>("/ask", "POST", { question: "How do I run database tests?", tag: "tests" });
  expect(result.mode).toBe("offline"); expect(result.citations.map(c => c.id)).toContain(m.id); expect(result.answer).toContain(m.id);
  expect((await brain<{ memories: Memory[] }>("?tag=DATABASE")).memories.map(m => m.id)).toEqual([m.id]);
  expect((await brain<{ hits: Array<{ memory: Memory }> }>("/search?q=database&tag=absent")).hits).toEqual([]);
  const exported = await brain<{ memories: Memory[] }>("/export?tag=tests"); expect(exported.memories[0]).toMatchObject({ private: true, untrusted: true, paths: ["src/web/**"] });
  const taught = await brain<{ memories: Memory[] }>("/teach", "POST", { tests: "npm run test:unit", conventions: "Use ESM", avoid: "hardware/" });
  expect(taught.memories.map(m => m.kind)).toEqual(["fact", "convention", "constraint"]);
  expect((await brain<{ changes: Array<{ action: string; id: string }> }>("/changes?since=7d")).changes.some(c => c.action === "edited" && c.id === m.id)).toBe(true);
  for (const [route, method, input] of [["/ask", "POST", { question: "" }], ["/settings", "PATCH", { reviewBeforeSaving: "yes" }], ["/teach", "POST", {}], ["/changes?since=invalid", "GET", undefined], [`/${m.id}`, "PATCH", { paths: ["../outside/**"] }]] as const) {
    expect((await request(`/api/projects/${project}/brain${route}`, method, input)).status).toBe(400);
  }
});

it("counts actual echo dispatches, validates feedback, and reviews wrong memories through the API", async () => {
  const m = await add("r4451 Always keep test fixtures.", { pinned: true, tags: ["feedback"], scope: { chat: "main" } });
  await request(`/api/projects/${project}/messages`, "POST", { text: "test fixtures", agentId: "echo" });
  let injection = 0;
  await waitUntil(async () => {
    const r = await brain<{ injections: Array<{ id: number; payload: { memories: Array<{ id: string }> } }> }>("/injections");
    injection = r.injections.find(e => e.payload.memories.some(row => row.id === m.id))?.id ?? 0; return injection > 0;
  });
  const stats = await brain<{ timesBriefed: number; usage: Record<string, { n: number; at: number }> }>("/stats");
  expect(stats.usage[m.id]?.n).toBeGreaterThan(0); expect(stats.usage[m.id]?.at).toBeGreaterThan(0);
  const listed = await brain<{ memories: Array<Memory & { timesBriefed: number }> }>("?sort=usage"); expect(listed.memories[0]?.timesBriefed).toBeGreaterThan(0);
  await brain(`/${m.id}/feedback`, "POST", { value: "helpful", injection });
  await brain(`/${m.id}/feedback`, "POST", { value: "wrong", injection });
  expect((await brain<{ memories: Memory[] }>("?tag=feedback")).memories).toEqual([]);
  const proposal = (await brain<{ proposals: Proposal[] }>("/inbox")).proposals.find(p => p.target === m.id)!;
  await brain(`/inbox/${proposal.id}`, "POST", { action: "edit", text: "Keep only current test fixtures." });
  await brain(`/inbox/${proposal.id}`, "POST", { action: "approve" });
  expect((await brain<{ memories: Memory[] }>("?tag=feedback")).memories[0]).toMatchObject({ text: "Keep only current test fixtures.", scope: { chat: "main" } });
  await brain(`/${m.id}`, "PATCH", { pinned: false });
});

it("installs removable packs without stripping trust, privacy, paths, expiry or scope", async () => {
  const expiresAt = Date.now() + 86400000;
  const doc = { format: "loom-brain", version: 1, project: "portable", exportedAt: Date.now(), pack: "web-pack", memories: [{ text: "r4451 Pack convention", kind: "convention", private: true, untrusted: true, paths: ["src/web/**"], tags: ["pack"], chat: "main", expiresAt }] };
  expect(await brain("/packs/install", "POST", { pack: doc })).toEqual({ added: 1, known: 0 });
  expect(await brain("/packs/install", "POST", { pack: doc })).toEqual({ added: 0, known: 1 });
  const memory = (await brain<{ memories: Memory[] }>("?tag=pack")).memories[0]!;
  expect(memory).toMatchObject({ pack: "web-pack", private: true, untrusted: true, expiresAt, paths: ["src/web/**"], scope: { chat: "main" } });
  await brain("/packs", "POST", { name: "saved", tag: "pack" });
  expect((await brain<{ packs: Array<{ name: string }> }>("/packs")).packs.map(p => p.name)).toContain("saved");
  await brain("/packs/web-pack", "DELETE");
  expect((await brain<{ memories: Memory[] }>("?tag=pack")).memories).toEqual([]);
  expect((await request(`/api/projects/${project}/brain/packs/install`, "POST", { pack: { ...doc, memories: [{ ...doc.memories[0], untrusted: "no" }] } })).status).toBe(400);
  expect((await request(`/api/projects/${project}/brain/packs/install`, "POST", { url: "http://127.0.0.1/private" })).status).toBe(400);
});

it("refreshes repo knowledge on search and includes file citations in ask and per-turn explanations", async () => {
  fs.mkdirSync(path.join(dir, "docs"), { recursive: true }); fs.writeFileSync(path.join(dir, "docs/database.md"), "r4451 database uses SQLite WAL journals.");
  await brain("/sources", "POST", { action: "add", pattern: "docs/**/*.md" });
  const result = await brain<{ answer: string; citations: Array<{ id: string; source?: { file: string } }> }>("/ask", "POST", { question: "database journals" });
  const source = result.citations.find(c => c.source?.file === "docs/database.md")!; expect(source).toBeTruthy();
  expect((await request(`/api/projects/${project}/brain/${source.id}`, "PATCH", { text: "editable?" })).status).toBe(400);
  fs.writeFileSync(path.join(dir, "docs/database.md"), "r4451 database uses PostgreSQL transactions.");
  const changed = await brain<{ hits: Array<{ memory: Memory }> }>("/search?q=PostgreSQL"); expect(changed.hits.some(h => h.memory.source?.file === "docs/database.md")).toBe(true);
  await request(`/api/projects/${project}/messages`, "POST", { text: "database PostgreSQL transactions", agentId: "echo" });
  await waitUntil(async () => (await brain<{ injections: Array<{ payload: { memories: Array<{ source?: { file: string } }> } }> }>("/injections")).injections.some(e => e.payload.memories.some(m => m.source?.file === "docs/database.md")));
  await brain("/sources", "POST", { action: "rm", pattern: "docs/**/*.md" });
  expect((await brain<{ sources: unknown[] }>("/sources")).sources).toEqual([]);
});

it("permits owner phones and project-scoped devices, confines projects, and refuses share-live guests", async () => {
  const pair = async (options: object) => {
    const response = await request('/api/pair/new', 'POST', options), { token: pairing } = await response.json() as { token: string };
    const claimed = await request('/api/pair/claim', 'POST', { token: pairing, name: 'r4 phone' }); return ((await claimed.json()) as { clientToken: string }).clientToken;
  };
  const phone = await pair({}), scoped = await pair({ projects: [project] }), guest = await pair({ guest: { project, chat: 'main', role: 'reply' } });
  const routes: Array<[string, string, unknown?]> = [['/ask', 'POST', { question: 'test' }], ['/settings', 'PATCH', { reviewBeforeSaving: true }], ['/inbox', 'GET'], ['/packs', 'POST', { name: 'phone-pack' }], ['/packs', 'GET'], ['/stats', 'GET'], ['/sources', 'GET'], ['/changes', 'GET'], ['/teach', 'POST', { tests: 'npm test' }]];
  for (const [route, method, body] of routes) {
    for (const bearer of [phone, scoped]) await brain(route, method, body, bearer);
    expect((await request(`/api/projects/${project}/brain${route}`, method, body, guest)).status).toBe(403);
  }
  const pack = { format: 'loom-brain', version: 1, pack: 'scoped-inline', project: 'repo', exportedAt: Date.now(), memories: [{ kind: 'fact', text: 'Scoped inline pack remains usable.' }] };
  await brain('/packs/install', 'POST', { pack }, scoped);
  const denied = await request(`/api/projects/${project}/brain/packs/install`, 'POST', { url: 'https://example.com/pack.json' }, scoped);
  expect(denied.status).toBe(403); expect(await denied.json()).toEqual({ error: 'URL install requires the owner' });
  // Invalid URLs prove both owner credentials passed authorization without network access.
  for (const bearer of [phone, token]) {
    const response = await request(`/api/projects/${project}/brain/packs/install`, 'POST', { url: 'file:///tmp/pack.json' }, bearer);
    expect(response.status).toBe(400); expect((await response.json() as { error: string }).error).not.toContain('requires the owner');
  }
  const other = (await client.addProject(makeProjectDir())).project.id;
  expect((await request(`/api/projects/${other}/brain/ask`, 'POST', { question: 'test' }, scoped)).status).toBe(403);
  await brain('/settings', 'PATCH', { reviewBeforeSaving: false });
});

it("runs every new CLI workflow and extends old commands without changing their output", async () => {
  const created = await run(['brain:add', 'r4451 cli convention', '--paths', 'src/web/**']); const id = created.split(' ')[0]!;
  await run(['brain:tag', id, 'cli']);
  expect(await run(['brain:list', '--tag', 'cli', '--sort', 'usage'])).toContain('r4451 cli convention');
  expect(await run(['brain:search', 'r4451 cli', '--tag', 'cli', '--explain'])).toContain('matchedPaths');
  const exported = JSON.parse(await run(['brain:export', '--tag', 'cli'])); expect(exported.memories).toHaveLength(1);
  expect(JSON.parse(await run(['brain:ask', 'cli convention', '--tag', 'cli'])).citations[0].id).toBe(id);
  const file = path.join(dir, 'cli-pack.json'); await run(['brain:pack', 'save', 'cli-pack', '--tag', 'cli', '--file', file]);
  await run(['brain:pack', 'install', file]); expect(await run(['brain:pack', 'list'])).toContain('cli-pack'); await run(['brain:pack', 'rm', 'cli-pack']);
  expect(await run(['brain:stats'])).toContain('timesBriefed'); expect(await run(['brain:diff', '--since', '7d'])).toContain('added');
  expect(await run(['brain:teach', '--tests', 'npm test', '--conventions', 'ESM', '--avoid', 'hardware/'])).toContain('interview');
  await run(['brain:inbox', '--review', 'on']); expect(await run(['brain:inbox'])).toContain('proposals'); await run(['brain:inbox', '--review', 'off']);
  await run(['brain:sources', 'add', 'docs/**/*.md']); expect(await run(['brain:sources', 'list'])).toContain('docs/**/*.md'); await run(['brain:sources', 'refresh', 'docs/**/*.md']); await run(['brain:sources', 'rm', 'docs/**/*.md']);
}, 120_000);

it("learns from the real tracked-PR merge event using a fake gh executable, including inline reviews", async () => {
  const previousPath = process.env.PATH, bin = tmpDir('r4-fake-gh'), fixture = path.join(bin, 'pr.json');
  const view = { state: 'OPEN', mergeable: 'MERGEABLE', headRefOid: 'head', url: 'https://github.com/example/repo/pull/451',
    title: 'r4451 merged SQLite WAL', body: 'Database readers no longer block writers.', reviews: [{ body: 'Keep write transactions short to avoid blocking other database writers.' }], comments: [] };
  fs.writeFileSync(fixture, JSON.stringify(view));
  fs.writeFileSync(path.join(bin, 'gh'), `#!${process.execPath}\nconst fs = require('node:fs');\nconst args = process.argv.slice(2);\nconsole.log(JSON.stringify(args[0] === 'api' ? [[{ body: 'Always test busy retries when concurrent transactions compete for a lock.' }]] : JSON.parse(fs.readFileSync(${JSON.stringify(fixture)}, 'utf8'))));\n`, { mode: 0o755 });
  process.env.PATH = bin + path.delimiter + previousPath;
  try {
    await brain('/settings', 'PATCH', { reviewBeforeSaving: true });
    const rt = await (daemon as unknown as { runtime(id: string): Promise<import('../src/daemon/runtime.js').ProjectRuntime> }).runtime(project);
    await rt.prFeedback.attach(451, 'main');
    fs.writeFileSync(fixture, JSON.stringify({ ...view, state: 'MERGED' }));
    await rt.prFeedback.pollNow();
    await waitUntil(async () => {
      const failure = logbook.list().find(row => row.scope === 'brain' && row.message.includes('PR knowledge'));
      if (failure) throw new Error(failure.detail);
      return (await brain<{ proposals: Proposal[] }>('/inbox')).proposals.filter(p => p.input.tags?.includes('merged-pr')).length === 3;
    });
    const proposals = (await brain<{ proposals: Proposal[] }>('/inbox')).proposals.filter(p => p.input.tags?.includes('merged-pr'));
    expect(proposals.every(p => p.input.untrusted && p.input.scope?.chat === 'main')).toBe(true);
    expect(proposals.some(p => p.input.text.includes('Always test busy retries when concurrent transactions compete for a lock.'))).toBe(true);
    await rt.prFeedback.pollNow();
    expect((await brain<{ proposals: Proposal[] }>('/inbox')).proposals.filter(p => p.input.tags?.includes('merged-pr'))).toHaveLength(3);
    for (const proposal of proposals) await brain('/inbox/' + proposal.id, 'POST', { action: 'reject' });
  } finally {
    process.env.PATH = previousPath;
    await brain('/settings', 'PATCH', { reviewBeforeSaving: false });
  }
});


it("keeps list, ask, search and echo sends available after documents grow or become unreadable", async () => {
  const docs = path.join(dir, 'review-docs'); fs.mkdirSync(docs);
  const file = path.join(docs, 'database.md'); fs.writeFileSync(file, 'r4review SQLite maintains reliable database transactions.');
  await brain('/sources', 'POST', { action: 'add', pattern: 'review-docs/*.md' });
  const source = (await brain<{ memories: Memory[] }>('')).memories.find(m => m.source?.file === 'review-docs/database.md')!;
  fs.writeFileSync(file, 'x'.repeat(1_000_001));
  expect(await brain('/sources', 'POST', { action: 'refresh', pattern: 'review-docs/*.md' })).toMatchObject({ skipped: 1 });
  // The scanner resolves the repo root; temp paths can contain symlinks (e.g. /var on macOS).
  const realDocs = fs.realpathSync(docs);
  const original = fs.readdirSync;
  const fault = vi.spyOn(fs, 'readdirSync').mockImplementation(((folder: fs.PathLike, options: unknown) => {
    if (String(folder) === realDocs) throw new Error('EACCES source directory');
    return original(folder, options as never);
  }) as typeof fs.readdirSync);
  try {
    expect((await brain<{ memories: Memory[] }>('')).memories.some(m => m.id === source.id)).toBe(true);
    expect((await brain<{ citations: Array<{ id: string }> }>('/ask', 'POST', { question: 'r4review SQLite reliable database' })).citations.some(m => m.id === source.id)).toBe(true);
    expect((await brain<{ hits: Array<{ memory: Memory }> }>('/search?q=r4review')).hits.some(h => h.memory.id === source.id)).toBe(true);
    expect((await request(`/api/projects/${project}/messages`, 'POST', { text: 'r4review SQLite reliable database', agentId: 'echo' })).status).toBeLessThan(300);
    await waitUntil(async () => (await brain<{ injections: Array<{ payload: { memories: Array<{ id: string }> } }> }>('/injections')).injections.some(e => e.payload.memories.some(m => m.id === source.id)));
    const refreshed = await request(`/api/projects/${project}/brain/sources`, 'POST', { action: 'refresh', pattern: 'review-docs/*.md' });
    expect(refreshed.status).toBe(400);
    expect(await refreshed.json()).toEqual({ error: 'EACCES source directory' });
  } finally { fault.mockRestore(); await brain('/sources', 'POST', { action: 'rm', pattern: 'review-docs/*.md' }); }
});
