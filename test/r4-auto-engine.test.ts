import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ProjectRuntime } from "../src/daemon/runtime.js";
import { AutomationEngine } from "../src/core/auto-r4/engine.js";
import { readWatchUrl } from "../src/core/auto-r4/watch.js";
import { automationTrigger } from "../src/core/auto-r4/validation.js";
import { changeAutomation, readAutomation, writeControl, writeJson } from "../src/core/auto-r4/state.js";
import { addWebhook, queueWebhooks, WebhookSender } from "../src/core/auto-r4/webhooks.js";
import { readTriggers, writeTriggers } from "../src/core/triggers.js";
import { savePrRecord } from "../src/core/pr-feedback.js";
import { tmpDir, waitUntil } from "./helpers.js";
import path from "node:path";

vi.mock("../src/core/auto-r4/watch.js", async original => ({ ...await original<typeof import("../src/core/auto-r4/watch.js")>(), readWatchUrl: vi.fn() }));
let dir: string, rt: ProjectRuntime;
beforeEach(() => {
  process.env.LOOM_HOME = tmpDir("a4-engine-home"); dir = tmpDir("a4-engine"); writeControl({});
  rt = { info: { id: "project", dir }, log: { lastId: () => 0, list: () => [], append: vi.fn() }, queue: { snapshot: () => ({ items: [] }) }, chats: () => [], orchestra: { get: () => undefined } } as unknown as ProjectRuntime;
});
afterEach(() => { vi.restoreAllMocks(); vi.mocked(readWatchUrl).mockReset(); });
const result = (id: string, note = "queued") => ({ trigger: id, at: Date.now(), ok: note === "queued", note });

it("does not await network deliveries or URL checks and prevents overlapping URL checks", async () => {
  const t = automationTrigger({ watchUrl: "https://example.com", prompt: "url", every: "1m" });
  writeTriggers(dir, { triggers: [t], runs: [] });
  addWebhook(dir, "http://localhost/hook", ["turn_finished"]); queueWebhooks(dir, "p", "turn_finished", {}, "1");
  let release!: (value: string) => void, sent!: () => void;
  vi.mocked(readWatchUrl).mockImplementation(() => new Promise(resolve => { release = resolve; }));
  const sender = vi.spyOn(WebhookSender.prototype, "tick").mockImplementation(() => new Promise(resolve => { sent = resolve; }));
  const engine = new AutomationEngine(async (_p, _d, id) => result(id));
  await engine.tick(rt, 60_000); await engine.tick(rt, 120_000);
  expect(readWatchUrl).toHaveBeenCalledTimes(1); expect(sender).toHaveBeenCalled();
  release("baseline"); sent(); await waitUntil(() => readAutomation(dir).watches[t.id]?.value === "baseline");
});

it("retains a busy URL's previous value and combines changes on its next check", async () => {
  const t = automationTrigger({ watchUrl: "https://example.com", prompt: "url", every: "1m" });
  writeTriggers(dir, { triggers: [t], runs: [] }); changeAutomation(dir, s => { s.watches[t.id] = { value: "one" }; });
  vi.mocked(readWatchUrl).mockResolvedValueOnce("two").mockResolvedValueOnce("three");
  const fire = vi.fn(async (_p, _d, id) => result(id, "skipped: its last run is still running"));
  const engine = new AutomationEngine(fire);
  await engine.tick(rt, 60_000); await waitUntil(() => (engine as any).urlChecks.size === 0);
  expect(readAutomation(dir).watches[t.id]).toEqual({ value: "one", checkedAt: 60_000 });
  fire.mockImplementation(async (_p, _d, id) => result(id));
  await engine.tick(rt, 120_000); await waitUntil(() => readAutomation(dir).watches[t.id]?.value === "three");
  expect(fire.mock.calls.at(-1)?.[3]).toMatchObject({ body: { old: "one", new: "three" } });
});

it("keeps a held entry if a hold resumes while it is being released", async () => {
  const t = automationTrigger({ kind: "webhook", prompt: "held" });
  writeTriggers(dir, { triggers: [t], runs: [] }); changeAutomation(dir, s => { s.held.push({ trigger: t.id, at: 1, opts: { kind: "webhook" } }); });
  const engine = new AutomationEngine(async (_p, _d, id) => result(id, "held: automation paused"));
  await engine.tick(rt); expect(readAutomation(dir).held).toHaveLength(1);
});

it("bounds chains from PR facts and loads old automation state without depth", async () => {
  const origin = automationTrigger({ on: "pr_merged", prompt: "origin" }); origin.chat = "origin-chat";
  const target = automationTrigger({ on: "pr_merged", prompt: "target" });
  writeTriggers(dir, { triggers: [origin, target], runs: [] });
  writeJson(path.join(dir, ".loom/automation.json"), { cursor: 0, startedAt: 0, held: [], watches: {}, origins: {}, pending: {}, transitions: {} });
  expect(readAutomation(dir).depth).toEqual({});
  changeAutomation(dir, s => { s.origins[origin.chat!] = origin.id; s.depth[origin.chat!] = 2; });
  savePrRecord(dir, { repo: "owner/repo", prNumber: 1, chat: origin.chat, source: "delivery", openedAt: Date.now(), checkedAt: Date.now(), state: "MERGED", url: "https://example.com/pr/1", signatures: [] });
  const fire = vi.fn(async (_p, _d, id) => result(id));
  await new AutomationEngine(fire).tick(rt);
  expect(fire).not.toHaveBeenCalled();
  expect(readTriggers(dir).runs.at(-1)).toMatchObject({ trigger: target.id, note: "skipped: started by a chain of automation runs" });
});

it("filters historical journal events and PR facts for newly created outgoing hooks", async () => {
  const old = Date.now() - 10_000;
  addWebhook(dir, "http://localhost/hook", ["turn_finished", "pr_opened"]);
  changeAutomation(dir, s => { s.startedAt = 0; s.cursor = 0; });
  rt.log.list = (() => [{ id: 1, ts: old, kind: "run_complete", payload: {} }]) as typeof rt.log.list;
  savePrRecord(dir, { repo: "owner/repo", prNumber: 1, chat: "main", source: "delivery", openedAt: old, checkedAt: old, state: "OPEN", url: "https://example.com/pr/1", signatures: [] });
  await new AutomationEngine(async (_p, _d, id) => result(id)).tick(rt);
  const { readWebhooks } = await import("../src/core/auto-r4/webhooks.js");
  expect(readWebhooks(dir).deliveries).toHaveLength(0);
});
