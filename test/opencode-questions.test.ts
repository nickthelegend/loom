/**
 * OpenCode asking you things: its question tool becomes the same answerable
 * card Claude's and Codex's do, and its permission asks become approval cards
 * whose answer reaches opencode as once / always / reject. Against the fake
 * `opencode serve` (opencode-fake.ts), shapes from opencode 1.18's OpenAPI.
 */

import { afterEach, describe, expect, it } from "vitest";

import { OpenCodeAdapter } from "../src/adapters/opencode.js";
import { setApprovalBroker, type ApprovalRequest } from "../src/core/approvals.js";
import type { AdapterEvent } from "../src/types.js";
import { fakeOpenCode, type FakeOpenCode } from "./opencode-fake.js";
import { makeProjectDir, waitUntil } from "./helpers.js";

let server: FakeOpenCode | null = null;
afterEach(async () => { setApprovalBroker(null); await server?.close(); server = null; });

const QUESTIONS = [
  { header: "Stack", question: "Which database?", options: [{ label: "Postgres", description: "relational" }, { label: "SQLite", description: "a file" }], multiple: false, custom: true },
  { header: "Extras", question: "Which extras?", options: [{ label: "Auth", description: "" }, { label: "Billing", description: "" }], multiple: true, custom: false },
];

describe("opencode's question tool", () => {
  it("asks with options in the thread, and the answer goes back to that question", async () => {
    server = await fakeOpenCode({ ask: QUESTIONS, reply: "ok, Postgres with auth and billing" });
    const adapter = new OpenCodeAdapter("oc", makeProjectDir({ name: "ocq" }), { baseUrl: server.url, pollMs: 30 });
    const events: AdapterEvent[] = [];
    adapter.onEvent((e) => events.push(e));
    await adapter.start();
    const turn = adapter.send({ text: "set it up" });
    await waitUntil(() => events.some((e) => e.kind === "needs_input"));
    const asked = events.find((e) => e.kind === "needs_input")!.payload as { requestId: string; responseMode: string; questions: Array<Record<string, unknown>> };
    expect(asked.responseMode).toBe("tool");
    expect(asked.requestId).toMatch(/^oc-q:que_/);
    expect(asked.questions).toMatchObject([
      { id: "0", header: "Stack", question: "Which database?", multiSelect: false, allowCustomAnswer: true, options: [{ label: "Postgres", description: "relational" }, { label: "SQLite", description: "a file" }] },
      { id: "1", multiSelect: true, allowCustomAnswer: false },
    ]);
    await adapter.respondToUserInput("main", asked.requestId, { 0: "Postgres", 1: ["Auth", "Billing"] });
    await turn;
    expect(server.replies[0]!.path).toMatch(/\/question\/que_[^/]+\/reply$/);
    expect(server.replies[0]!.body).toEqual({ answers: [["Postgres"], ["Auth", "Billing"]] });
    expect(events.some((e) => e.kind === "status" && e.payload.state === "question_answered")).toBe(true);
    await expect(adapter.respondToUserInput("main", asked.requestId, { 0: "x" })).rejects.toThrow(/no open opencode question/);
    await adapter.stop();
  });

  it("no answer at all dismisses the question", async () => {
    server = await fakeOpenCode({ ask: QUESTIONS.slice(0, 1) });
    const adapter = new OpenCodeAdapter("oc", makeProjectDir({ name: "ocq2" }), { baseUrl: server.url, pollMs: 30 });
    const events: AdapterEvent[] = [];
    adapter.onEvent((e) => events.push(e));
    await adapter.start();
    const turn = adapter.send({ text: "go" });
    await waitUntil(() => events.some((e) => e.kind === "needs_input"));
    await adapter.respondToUserInput("main", String(events.find((e) => e.kind === "needs_input")!.payload.requestId), {});
    await turn;
    expect(server.replies[0]!.path).toMatch(/\/reject$/);
    await adapter.stop();
  });
});

describe("opencode's permission asks", () => {
  it("become an approval card, and opencode hears once, always or reject", async () => {
    for (const [decision, reply] of [[{ behavior: "allow" }, "once"], [{ behavior: "allow", scope: "session" }, "always"], [{ behavior: "deny", message: "not now" }, "reject"]] as const) {
      server = await fakeOpenCode({ permission: { permission: "bash", patterns: ["npm test"], metadata: { command: "npm test" } } });
      const asked: ApprovalRequest[] = [];
      setApprovalBroker(async (req) => { asked.push(req); return decision; });
      const adapter = new OpenCodeAdapter("oc", makeProjectDir({ name: "ocp" }), { baseUrl: server.url, pollMs: 30, loomProject: "p1" });
      await adapter.start();
      await adapter.send({ text: "test it" });
      expect(asked[0]).toMatchObject({ project: "p1", agent: "oc", tool: "bash", summary: "npm test", sessionOption: true });
      expect(server.replies[0]!.path).toMatch(/\/permission\/per_[^/]+\/reply$/);
      expect(server.replies[0]!.body).toMatchObject({ reply });
      await adapter.stop();
      await server.close(); server = null;
    }
  });
});

describe("answering in the chat", () => {
  it("a message typed while the agent waits on its question answers it, instead of queueing behind it", async () => {
    const { writeProjectConfig } = await import("../src/core/registry.js");
    const { ProjectRuntime } = await import("../src/daemon/runtime.js");
    const { tmpDir } = await import("./helpers.js");
    process.env.LOOM_HOME = tmpDir("home-ocq-rt");
    server = await fakeOpenCode({ ask: QUESTIONS.slice(0, 1), reply: "Postgres it is" });
    const dir = makeProjectDir({ name: "ocq-rt" });
    writeProjectConfig(dir, { name: "ocq-rt", agents: [{ id: "oc", kind: "opencode", options: { baseUrl: server.url, pollMs: 30 } }], brain: { extractor: "off" } });
    const rt = await ProjectRuntime.open({ id: "ocq-rt", name: "ocq-rt", dir });
    try {
      await rt.sendMessage("set it up", "oc");
      await waitUntil(() => rt.log.list({ limit: 50 }).some((e) => e.kind === "needs_input"));
      expect((await rt.status()).needsInput).toBe(true);
      const res = await rt.sendMessage("Postgres", "oc");
      expect(res).toMatchObject({ answered: true });
      expect(rt.queue.length).toBe(0);
      await waitUntil(() => server!.replies.length > 0);
      expect(server!.replies[0]!.body).toEqual({ answers: [["Postgres"]] });
      await waitUntil(() => rt.log.list({ limit: 50 }).some((e) => e.kind === "message" && e.agentId === "oc" && String(e.payload.text).includes("Postgres it is")));
      expect((await rt.status()).needsInput).toBe(false);
    } finally {
      await rt.close();
    }
  });
});
