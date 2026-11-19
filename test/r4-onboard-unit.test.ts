import fs from "node:fs";
import path from "node:path";
import { Command } from "commander";
import type { Express, Request, RequestHandler, Response } from "express";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { registerHelpRoutes } from "../src/daemon/routes/help.js";
import { registerR4Onboard } from "../src/cli/r4-onboard.js";
import { helpGuides } from "../src/core/help/catalog.js";
import { createAgent } from "../src/adapters/index.js";
import { isAdapter, type AgentConfig } from "../src/types.js";
import type { ProjectRuntime } from "../src/daemon/runtime.js";
import { readTriggers, writeTriggers } from "../src/core/triggers.js";
import { runScenario, demoMemory } from "../src/core/help/scenarios.js";
import { Brain } from "../src/core/brain.js";
import { EventLog } from "../src/core/eventlog.js";
import { makeProjectDir, tmpDir } from "./helpers.js";

beforeEach(() => { vi.stubEnv("LOOM_HOME", tmpDir("r4-unit-home")); });
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });
function routes(rt: ProjectRuntime) {
  const handlers = new Map<string, RequestHandler[]>();
  const app = { get() {}, post(route: string, ...chain: RequestHandler[]) { handlers.set(route, chain); } };
  registerHelpRoutes(app as unknown as Express, { runtime: async () => rt }, handler => (req, res) => Promise.resolve(handler(rt, req, res)));
  return async (route: string, body: object = {}, extra: object = {}) => {
    const req = { body, params: {}, ...extra } as Request;
    let status = 200, data: any;
    const res = { status(code: number) { status = code; return res; }, json(value: unknown) { data = value; return res; } } as unknown as Response;
    for (const handler of handlers.get(route)!) {
      let next = false;
      await handler(req, res, () => { next = true; });
      if (!next) break;
    }
    return { status, data };
  };
}
it('rejects scoped trigger installation, allows the owner phone, and applies the cap', async () => {
  const dir = makeProjectDir();
  const call = routes({ info: { id: 'p', dir } } as ProjectRuntime);
  const route = '/api/projects/:id/examples/:name/install', params = { id: 'p', name: 'daily-review' };
  for (const extra of [{ projectScope: ['p'] }, { guest: {} }]) expect((await call(route, {}, { params, ...extra })).status).toBe(403);
  expect((await call(route, {}, { params, projectScope: null })).data.installed).toBe(true);
  const data = readTriggers(dir); data.triggers = Array.from({ length: 50 }, (_, i) => ({ ...data.triggers[0]!, id: String(i) })); writeTriggers(dir, data);
  expect(await call(route, {}, { params, isAdmin: true })).toEqual({ status: 400, data: { error: '50 triggers per project is the limit' } });
});
it('every listed CLI id prints exactly its guide', async () => {
  const output: string[] = []; vi.spyOn(console, 'log').mockImplementation(s => { output.push(s); });
  const program = new Command();
  registerR4Onboard(program, { ensureDaemon: async () => { throw new Error('offline command must not contact daemon'); }, currentProject: async () => ({ id: 'p' }) });
  await program.parseAsync(['guide'], { from: 'user' });
  const listed = output.pop()!.split('\n').map(line => line.split(' — ')[0]);
  for (const id of listed) { await program.parseAsync(['guide', id!], { from: 'user' }); expect(output.pop()).toBe(helpGuides().find(g => g.id === id)!.body); }
});
it('the provider route creates one alias agent whose next real adapter turn uses the changed model', async () => {
  const requested: string[] = [];
  vi.stubGlobal('fetch', async (_url: string, init?: RequestInit) => {
    if (!init?.body) return new Response('{"data":[{"id":"first"},{"id":"second"}]}');
    requested.push(JSON.parse(String(init.body)).model);
    return new Response('data: {"choices":[{"delta":{"content":"fake reply"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
  });
  const dir = makeProjectDir(), config: { agents: AgentConfig[]; defaultAgent?: string } = { agents: [] };
  const runtime = { info: { id: 'p', dir }, config, addAgent(kind: string, props: object) { const agent = { id: 'model-1', kind, ...props }; config.agents.push(agent); return agent; }, patchConfig(patch: object) { Object.assign(config, patch); } } as unknown as ProjectRuntime;
  const call = routes(runtime), route = '/api/help/provider/:step';
  const guide = (step: string, body = {}) => call(route, { provider: 'r4fake', ...body }, { params: { step } });
  expect((await guide('key', { key: 'fake', baseUrl: 'http://fake.invalid' })).status).toBe(200);
  expect((await guide('test')).status).toBe(200);
  expect((await guide('default', { model: 'first' })).status).toBe(200);
  const added = await guide('agent', { project: 'p' }); expect(added.data.model).toBe('r4fake/first');
  expect(added.data.agent.options.model).toBe('default');
  const adapter = createAgent(config.agents[0]!, dir, true); if (!isAdapter(adapter)) throw new Error('expected adapter');
  try {
    await adapter.start(); await adapter.send({ text: 'first' });
    expect((await guide('default', { model: 'second' })).status).toBe(200);
    await adapter.send({ text: 'second' });
    expect(requested).toEqual(['first', 'second']);
    expect((await guide('agent', { project: 'p' })).data).toMatchObject({ model: 'r4fake/second', agent: { id: added.data.agent.id } });
    expect(config.agents).toHaveLength(1);
  } finally { await adapter.stop(); }
});
it('repeated memory scenarios leave one decision in the real log and brain', async () => {
  const dir = makeProjectDir(); fs.writeFileSync(path.join(dir, '.loom', 'demo.json'), '{}');
  const log = await EventLog.open(path.join(dir, ".loom")), brain = new Brain(log);
  const runtime = { info: { dir }, config: { agents: [1, 2, 3].map(i => ({ id: `demo-${i}`, kind: 'demo' })) }, log, brain, anyBusy: () => false, createChat: () => ({ id: 'chat' }), handoff: async () => {}, sendMessage: async () => ({}) } as unknown as ProjectRuntime;
  try {
    await runScenario(runtime, 'memory'); await runScenario(runtime, 'memory');
    expect(log.list({ kinds: ['decision'] }).filter(e => e.payload.text === demoMemory)).toHaveLength(1);
    expect(brain.list().filter(m => m.text === demoMemory)).toHaveLength(1);
  } finally { log.close(); }
});
