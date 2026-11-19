import fs from "node:fs";
import path from "node:path";
import type { Express, Request, Response, RequestHandler } from "express";
import { afterEach, expect, it, vi } from "vitest";
import { Brain } from "../src/core/brain.js";
import { EventLog } from "../src/core/eventlog.js";
import { registerBrainR4Routes } from "../src/daemon/routes/brain-r4.js";
import { registerBrainRoutes } from "../src/daemon/routes/brain.js";
import type { WithRuntime } from "../src/daemon/routes/context.js";
import type { AuthManager } from "../src/daemon/auth.js";
import { DaemonClient } from "../src/daemon/client.js";
import type { DaemonConfig } from "../src/core/registry.js";
import { tmpDir } from "./helpers.js";

const { readUrl } = vi.hoisted(() => ({ readUrl: vi.fn() }));
vi.mock("../src/core/brain-markdown.js", async importOriginal => ({ ...await importOriginal<object>(), readMarkdownUrl: readUrl }));
const closes: Array<() => void> = [];
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); readUrl.mockReset(); closes.splice(0).forEach(close => close()); });

async function setup() {
  const dir = tmpDir('r4-routes'), log = await EventLog.open(path.join(dir, '.loom')), brain = new Brain(log);
  closes.push(() => { brain.close(); log.close(); });
  const runtime = { brain, log, info: { dir, id: 'project', name: 'Project' }, memoryUsage: () => ({}) };
  const handlers = new Map<string, RequestHandler>();
  const app = Object.fromEntries(['get', 'post', 'patch', 'delete'].map(method => [method, (url: string, handler: RequestHandler) => { handlers.set(`${method} ${url}`, handler); }])) as unknown as Express;
  const withRuntime: WithRuntime = handler => async (req, res) => handler(runtime as Parameters<typeof handler>[0], req, res);
  const auth = { clientFor: () => null } as unknown as AuthManager;
  registerBrainR4Routes(app, withRuntime, auth); registerBrainRoutes(app, withRuntime, auth);
  const request = async (method: string, suffix: string, body?: unknown, identity: object = { isAdmin: true }) => {
    let status = 200, result: any;
    const response = { status: (code: number) => { status = code; return response; }, json: (value: unknown) => { result = value; return response; } };
    await handlers.get(`${method} /api/projects/:id/brain${suffix}`)!({ body, query: {}, params: { id: 'project' }, headers: {}, ...identity } as unknown as Request, response as unknown as Response, () => {});
    return { status, result };
  };
  return { brain, dir, request };
}

it("refuses scoped URL installs before fetching but admits inline packs and both owner identities", async () => {
  const { brain, request } = await setup();
  const pack = { format: 'loom-brain', version: 1, pack: 'test', project: 'repo', exportedAt: 1, memories: [{ kind: 'fact', text: 'Use SQLite', private: true }] };
  const scoped = { isAdmin: false, projectScope: ['project'] };
  expect(await request('post', '/packs/install', { url: 'https://example.com/pack.json' }, scoped)).toEqual({ status: 403, result: { error: 'URL install requires the owner' } });
  expect(readUrl).not.toHaveBeenCalled();
  expect((await request('post', '/packs/install', { pack }, scoped)).status).toBe(200);
  for (const identity of [{ isAdmin: true }, { isAdmin: false, projectScope: null }]) {
    readUrl.mockResolvedValue(JSON.stringify({ ...pack, pack: `remote-${String(identity.isAdmin)}` }));
    expect((await request('post', '/packs/install', { url: 'https://example.com/pack.json' }, identity)).status).toBe(200);
  }
  expect(readUrl).toHaveBeenCalledTimes(2);
  expect(brain.all().filter(m => m.pack?.startsWith('remote')).every(m => m.private && m.untrusted)).toBe(true);
});

it("keeps GET brain, ask and source listing available on I/O failure while explicit source writes report errors", async () => {
  const { brain, dir, request } = await setup();
  fs.mkdirSync(path.join(dir, 'docs')); fs.writeFileSync(path.join(dir, 'docs/db.md'), 'Database uses SQLite WAL.');
  expect((await request('post', '/sources', { action: 'add', pattern: 'docs/*.md' })).status).toBe(200);
  const source = brain.all()[0]!;
  vi.spyOn(fs, 'readdirSync').mockImplementation(() => { throw new Error('EACCES'); });
  const listed = await request('get', ''); expect(listed.status).toBe(200); expect(listed.result.memories[0].id).toBe(source.id);
  const asked = await request('post', '/ask', { question: 'SQLite WAL' }); expect(asked.status).toBe(200); expect(asked.result.citations[0].id).toBe(source.id);
  expect((await request('get', '/sources')).status).toBe(200);
  expect((await request('post', '/sources', { action: 'add', pattern: 'other/*.md' })).status).toBe(400);
  expect(brain.knowledge.sourcePatterns()).toEqual(['docs/*.md']);
  expect((await request('post', '/sources', { action: 'refresh', pattern: 'docs/*.md' })).status).toBe(400);
});

it("forwards new CLI options through the original client methods without dropping existing filters", async () => {
  const fetcher = vi.fn(async () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }));
  vi.stubGlobal('fetch', fetcher);
  const client = new DaemonClient({ host: '127.0.0.1', port: 9999, adminToken: 'fake' } as DaemonConfig);
  await client.remember('project', 'fact', 'Use SQLite', 'main', ['src/web/**']);
  await client.searchBrain('project', 'test', { tag: 'unit tests', author: 'echo', chat: 'main', explain: true });
  await client.listBrainMemories('project', true, 'unit tests', 'usage');
  await client.exportBrain('project', 'unit tests');
  await client.exportBrainMarkdown('project', 'docs/brain.md', 'unit tests');
  const calls = fetcher.mock.calls as unknown as Array<[string, RequestInit]>;
  expect(JSON.parse(String(calls[0]![1].body))).toEqual({ kind: 'fact', text: 'Use SQLite', chat: 'main', paths: ['src/web/**'] });
  expect(Object.fromEntries(new URL(calls[1]![0]).searchParams)).toEqual({ q: 'test', author: 'echo', chat: 'main', tag: 'unit tests', explain: '1' });
  expect(Object.fromEntries(new URL(calls[2]![0]).searchParams)).toEqual({ includeArchived: '1', tag: 'unit tests', sort: 'usage' });
  expect(new URL(calls[3]![0]).searchParams.get('tag')).toBe('unit tests');
  expect(JSON.parse(String(calls[4]![1].body))).toEqual({ md: 'docs/brain.md', tag: 'unit tests' });
});
