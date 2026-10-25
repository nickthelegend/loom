/**
 * OpenCode asking you things: its question tool becomes the same answerable
 * card Claude's and Codex's do, and its permission asks become approval cards
 * whose answer reaches opencode as once / always / reject. Against the fake
 * `opencode serve` (opencode-fake.ts), shapes from opencode 1.18's OpenAPI.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
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

describe("opencode's tool results", () => {
  it("shows a tool's input and output from the 1.18 events, once", async () => {
    server = await fakeOpenCode({ tool: { tool: "bash", input: { command: "ls -la demo2", description: "list demo2" } } });
    const adapter = new OpenCodeAdapter("oc", makeProjectDir({ name: "oct" }), { baseUrl: server.url, pollMs: 30 });
    const events: AdapterEvent[] = [];
    adapter.onEvent((e) => events.push(e));
    await adapter.start();
    await adapter.send({ text: "list it" });
    const tools = events.filter((e) => e.kind === "tool_call").map((e) => e.payload);
    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({ tool: "bash", ok: true, command: "ls -la demo2", input: { command: "ls -la demo2" }, preview: "total 8\nhello.html" });
    await adapter.stop();
  });

  it("a bash command that ran but failed is a failure, with its exit code — what Proof and the loop watch read", async () => {
    server = await fakeOpenCode({ tool: { tool: "bash", input: { command: "npm test" }, structured: { metadata: { exit: 1, output: "1 failed" } } } });
    const adapter = new OpenCodeAdapter("oc", makeProjectDir({ name: "octf" }), { baseUrl: server.url, pollMs: 30 });
    const events: AdapterEvent[] = [];
    adapter.onEvent((e) => events.push(e));
    await adapter.start();
    await adapter.send({ text: "test it" });
    expect(events.filter((e) => e.kind === "tool_call").map((e) => e.payload)).toEqual([expect.objectContaining({ tool: "bash", command: "npm test", exitCode: 1, ok: false })]);
    await adapter.stop();
  });
});

describe("a session opencode can't run (field: big-pickle on 1.18 swallowed every prompt)", () => {
  let broken: FakeOpenCode | null = null;
  afterEach(async () => { await broken?.close(); broken = null; });

  it("a prompt that never reaches the session is retried once in a fresh session", async () => {
    broken = await fakeOpenCode({ brokenSessions: "first", reply: "OK" });
    const adapter = new OpenCodeAdapter("oc", makeProjectDir({ name: "ocb" }), { baseUrl: broken.url, pollMs: 20, startTimeoutMs: 400 } as never);
    const events: AdapterEvent[] = [];
    adapter.onEvent((e) => events.push(e));
    await adapter.start();
    await adapter.send({ text: "Reply OK" });
    expect(events.some((e) => e.kind === "status" && e.payload.state === "session_reset" && /never took the prompt/.test(String(e.payload.reason)))).toBe(true);
    expect(new Set(broken.prompts.map((p) => p.session)).size).toBe(2);
    expect(events.some((e) => e.kind === "error")).toBe(false);
    await adapter.stop();
  }, 15_000);

  it("when a fresh session can't take it either, the error names the model and where to look", async () => {
    broken = await fakeOpenCode({ brokenSessions: "all" });
    const adapter = new OpenCodeAdapter("oc", makeProjectDir({ name: "ocb2" }), { baseUrl: broken.url, pollMs: 20, startTimeoutMs: 400 } as never);
    const events: AdapterEvent[] = [];
    adapter.onEvent((e) => events.push(e));
    await adapter.start();
    await adapter.send({ text: "Reply OK" });
    const err = events.find((e) => e.kind === "error");
    expect(String(err?.payload.message)).toMatch(/never started the turn.*opencode\.log/);
    await adapter.stop();
  }, 15_000);
});


describe("opencode serve dying mid-turn (field: a serve killed mid-start left the agent busy)", () => {
  // the stand-in `opencode` is a POSIX shell script; Windows starts opencode through a Job Object
  it.skipIf(process.platform === "win32")("ends the turn at once with why, and the next send starts a new server", async () => {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    const bin = makeProjectDir({ name: "ocbin" });
    fs.writeFileSync(path.join(bin, "opencode"),
      `#!/bin/sh\nexec "${process.execPath}" "${path.join(root, "node_modules", "tsx", "dist", "cli.mjs")}" "${path.join(root, "test", "opencode-fake-serve.mts")}" "$@"\n`, { mode: 0o755 });
    const oldPath = process.env.PATH;
    process.env.PATH = `${bin}${path.delimiter}${oldPath}`;
    const adapter = new OpenCodeAdapter("oc", makeProjectDir({ name: "ocdie" }), { pollMs: 20 });
    try {
      const events: AdapterEvent[] = [];
      adapter.onEvent((e) => events.push(e));
      await adapter.start();
      const turn = adapter.send({ text: "a long job" });
      await new Promise((r) => setTimeout(r, 400));
      const t0 = Date.now();
      (adapter as unknown as { child: { kill(s: string): void } }).child.kill("SIGTERM");
      await turn;
      expect(Date.now() - t0).toBeLessThan(5_000);
      expect(String(events.find((e) => e.kind === "error")?.payload.message)).toMatch(/opencode serve (exited|was stopped) \(\w+\) mid-turn — the next send starts it again/);
      expect(events.filter((e) => e.kind === "error")).toHaveLength(1);
      expect(adapter.busy()).toBe(false);
    } finally {
      await adapter.stop().catch(() => {});
      process.env.PATH = oldPath;
    }
  }, 30_000);
});
