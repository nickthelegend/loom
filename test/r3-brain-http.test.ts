import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, it } from "vitest";
import { LoomDaemon } from "../src/daemon/server.js";
import { DaemonClient } from "../src/daemon/client.js";
import { readDaemonConfig } from "../src/core/registry.js";
import type { Memory, MemoryHistoryEntry } from "../src/core/brain.js";
import { makeProjectDir, tmpDir, waitUntil } from "./helpers.js";

let daemon: LoomDaemon, client: DaemonClient, base: string, token: string, project: string, dir: string;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
async function request(route: string, method = "GET", body?: unknown, bearer = token) {
  return fetch(base + route, { method, headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
async function brain<T = Record<string, unknown>>(route = "", method = "GET", body?: unknown): Promise<T> {
  const res = await request(`/api/projects/${project}/brain${route}`, method, body);
  const result = await res.json(); expect(res.status, JSON.stringify(result)).toBe(200); return result as T;
}
async function add(text: string, extra: object = {}) { return (await brain<{ memory: Memory }>("", "POST", { text, kind: "fact", ...extra })).memory; }
function cli(args: string[]) {
  return new Promise<{ code: number; text: string }>(resolve => {
    execFile(process.execPath, [path.join(root, "node_modules/tsx/dist/cli.mjs"), path.join(root, "src/cli/index.ts"), ...args], { cwd: dir, env: { ...process.env, NO_COLOR: "1" } }, (error, stdout, stderr) => resolve({ code: error ? 1 : 0, text: stdout + stderr }));
  });
}
beforeAll(async () => {
  process.env.LOOM_HOME = tmpDir("r3-brain-home"); process.env.LOOM_NO_NOTIFY = "1";
  daemon = new LoomDaemon({ host: "127.0.0.1", port: 0 });
  const address = await daemon.listen(); base = `http://${address.host}:${address.port}`;
  token = readDaemonConfig()!.adminToken; client = new DaemonClient(readDaemonConfig()!);
  dir = makeProjectDir({ agents: [{ id: "echo", kind: "echo", role: "worker" }, { id: "helper", kind: "echo", role: "worker" }] });
  project = (await client.addProject(dir)).project.id;
});
afterAll(async () => { await daemon.close(); });

it("validates filter and mutation input, filters by author/kind/date, and reports stale state", async () => {
  const memory = await add("filter419 sqlite storage", { kind: "decision" });
  await add("filter419 sqlite task", { kind: "task" });
  const date = new Date().toISOString().slice(0, 10);
  const result = await brain<{ hits: Array<{ memory: Memory }> }>(`/search?q=filter419&kind=decision&agent=user&since=${date}&until=${date}`);
  expect(result.hits.map(h => h.memory.id)).toEqual([memory.id]);
  const list = await brain<{ memories: Array<Memory & { stale: boolean }> }>("?kind=decision&agent=user");
  expect(list.memories.find(m => m.id === memory.id)?.stale).toBe(false);
  for (const query of ["kind=unknown", "since=wrong", "since=2026-12-31&until=2026-01-01"]) expect((await request(`/api/projects/${project}/brain?${query}`)).status).toBe(400);
  for (const patch of [{ priority: 1.5 }, { priority: 1001 }, { pinned: "yes" }, { archived: "false" }, { scope: { chat: "missing" } }]) {
    expect((await request(`/api/projects/${project}/brain/${memory.id}`, "PATCH", patch)).status).toBe(400);
  }
});

it("merges a reviewed duplicate, exposes full history, reverts, and restores archived memories", async () => {
  const a = await add("merge419 The database connections always use the shared sqlite file.");
  const b = await add("merge419 The database connections always use the shared sqlite file!", { pinned: true, priority: 7 });
  const suggestions = await brain<{ duplicates: Array<{ a: Memory; b: Memory }> }>("/duplicates");
  expect(suggestions.duplicates.some(d => [d.a.id, d.b.id].includes(a.id) && [d.a.id, d.b.id].includes(b.id))).toBe(true);
  const history = await brain<{ history: MemoryHistoryEntry[] }>(`/${a.id}/history`);
  await brain("/merge", "POST", { keep: a.id, other: b.id, text: "merge419 Use shared sqlite connections." });
  const changed = await brain<{ history: MemoryHistoryEntry[] }>(`/${a.id}/history`);
  expect(changed.history.at(-1)).toMatchObject({ by: "user", before: { text: a.text }, patch: { pinned: true, priority: 7 } });
  expect((await brain<{ memories: Memory[] }>("")).memories.some(m => m.id === b.id)).toBe(false);
  await brain(`/${a.id}/revert`, "POST", { eventId: history.history[0]!.eventId });
  await brain(`/${b.id}`, "PATCH", { archived: false });
  expect((await brain<{ memories: Memory[] }>("?includeArchived=1")).memories.find(m => m.id === a.id)?.text).toBe(a.text);
  await brain(`/${b.id}`, "PATCH", { pinned: false });
});

it("exports Markdown to the repo, imports Markdown, and runs CLI filters and Markdown commands", async () => {
  const file = "docs/BRAIN.md";
  expect((await cli(["brain:export", "--md", file])).code).toBe(0);
  expect(fs.readFileSync(path.join(dir, file), "utf8")).toContain("# ");
  const res = await request(`/api/projects/${project}/brain/export?format=md`);
  expect(res.headers.get("content-type")).toContain("text/markdown");
  expect(await res.text()).toContain("filter419 sqlite storage");
  expect((await request(`/api/projects/${project}/brain/export`, "POST", { md: "../escape.md" })).status).toBe(400);
  fs.writeFileSync(path.join(dir, "notes.md"), "# Notes\n\n## Decisions\n\n- cli419 Choose sqlite for the cache.\n");
  expect((await cli(["brain:import", "notes.md"])).text).toContain("1 learned");
  expect((await cli(["brain:import", "notes.md"])).text).toContain("already known");
  const date = new Date().toISOString().slice(0, 10);
  const found = await cli(["brain:search", "cli419", "--kind", "decision", "--agent", "user", "--since", date, "--until", date, "--explain"]);
  expect(found.code, found.text).toBe(0); expect(found.text).toContain("cli419 Choose sqlite"); expect(found.text).toContain("bm25");
  const invalid = await request(`/api/projects/${project}/brain/import`, "POST", { markdown: "" }); expect(invalid.status).toBe(400);
  expect((await request(`/api/projects/${project}/brain/import`, "POST", { url: "http://127.0.0.1/private.md" })).status).toBe(400);
});

it("records exact per-turn memories and scores, honors chat pins, and keeps the record after editing", async () => {
  const pin = await add("turn419 Pinned unrelated zebra rule.", { pinned: true, priority: 100, chat: "main" });
  const response = await request(`/api/projects/${project}/chats`, "POST", { title: "Other chat" });
  expect(response.status).toBe(200);
  const chat = ((await response.json()) as { chat: { id: string } }).chat.id;
  const secret = await add("turn419 Secret in another chat.", { pinned: true, chat });
  await request(`/api/projects/${project}/messages`, "POST", { text: "hello turn419", agentId: "echo", chat: "main" });
  type InjectionRecord = { payload: { turn: number; briefing: string; memories: Array<{ id: string; text: string; score: number; detail: object }> } };
  let records: InjectionRecord[] = [];
  await waitUntil(async () => { records = (await brain<{ injections: InjectionRecord[] }>("/injections?chat=main")).injections; return records.length > 0; });
  const record = records.at(-1)!;
  expect(record.payload.memories.some(m => m.id === pin.id)).toBe(true);
  expect(record.payload.memories.some(m => m.id === secret.id)).toBe(false);
  expect(record.payload.memories.find(m => m.id === pin.id)?.score).toEqual(expect.any(Number));
  expect(record.payload.memories.find(m => m.id === pin.id)?.detail).toBeTruthy();
  expect(record.payload.briefing).toContain(pin.text);
  await brain(`/${pin.id}`, "PATCH", { text: "Changed after injection.", pinned: false });
  expect((await brain<{ injections: InjectionRecord[] }>(`/injections?turn=${record.payload.turn}`)).injections[0]!.payload.memories.find(m => m.id === pin.id)?.text).toBe(pin.text);
  expect((await brain<{ usage: Record<string, { n: number }> }>("/usage")).usage[pin.id]?.n).toBeGreaterThan(0);
});

it("refuses share-live guests, keeps scoped devices to their project's memory, and restricts disk/URL actions to owners", async () => {
  async function pair(options: object) {
    const paired = await request("/api/pair/new", "POST", options);
    const { token: pairing } = await paired.json() as { token: string };
    const claimed = await request("/api/pair/claim", "POST", { token: pairing, name: "r3 phone" });
    return ((await claimed.json()) as { clientToken: string }).clientToken;
  }
  const scoped = await pair({ projects: [project] });
  const guest = await pair({ guest: { project, chat: "main", role: "reply" } });
  const phone = await pair({});
  for (const [route, method, body] of [["", "GET", undefined], ["", "POST", { text: "Forbidden", kind: "fact" }], ["/export", "POST", { md: "forbidden.md" }], ["/import", "POST", { markdown: "Forbidden" }], ["/injections", "GET", undefined]] as const) {
    expect((await request(`/api/projects/${project}/brain${route}`, method, body, guest)).status).toBe(403);
  }
  // a device scoped to this project works with this project's memory, but not the disk or the network
  expect((await request(`/api/projects/${project}/brain`, "GET", undefined, scoped)).status).toBe(200);
  for (const [route, body] of [["/export", { md: "scoped.md" }], ["/import", { url: "https://example.com/brain.md" }]] as const) expect((await request(`/api/projects/${project}/brain${route}`, "POST", body, scoped)).status).toBe(403);
  for (const [route, body] of [["/export", { md: "phone.md" }], ["/import", { url: "https://example.com/brain.md" }]] as const) expect((await request(`/api/projects/${project}/brain${route}`, "POST", body, phone)).status).toBe(403);
  const added = await request(`/api/projects/${project}/brain`, "POST", { text: "Phone-created fact.", kind: "fact" }, phone);
  expect(added.status).toBe(200);
  const memory = ((await added.json()) as { memory: Memory }).memory;
  expect((await brain<{ history: MemoryHistoryEntry[] }>(`/${memory.id}/history`)).history[0]!.by).toContain("r3 phone");
});


it("uses CLI management commands without losing history", async () => {
  const created = await cli(["brain:add", "cli419 scoped management memory", "--chat", "main"]);
  expect(created.code, created.text).toBe(0);
  const id = created.text.split(" ")[0]!;
  expect((await cli(["brain:pin", id, "--priority", "12"])).code).toBe(0);
  expect((await cli(["brain:list"])).text).toContain("priority=12");
  const history = JSON.parse((await cli(["brain:history", id])).text) as { history: MemoryHistoryEntry[] };
  expect(history.history.at(-1)?.patch).toMatchObject({ pinned: true, priority: 12 });
  expect((await cli(["brain:archive", id])).code).toBe(0);
  expect((await cli(["brain:list", "--archived"])).text).toContain(`${id} fact pinned priority=12 archived`);
  expect((await cli(["brain:archive", id, "--restore"])).code).toBe(0);
  expect((await cli(["brain:history", id, "--revert", String(history.history[0]!.eventId)])).code).toBe(0);
  expect(JSON.parse((await cli(["brain:why"])).text).injections.length).toBeGreaterThan(0);
  expect((await cli(["brain:duplicates"])).code).toBe(0);
});

it("captures chat-scoped pins on a subtask's actual dispatch", async () => {
  const pin = await add("subtask419 use the remembered convention", { chat: "main", pinned: true });
  const started = await request(`/api/projects/${project}/subtasks`, "POST", { parent: "echo", agentId: "helper", task: "unrelated helper work", chat: "main" });
  expect(started.status, await started.text()).toBe(200);
  await waitUntil(async () => (await brain<{ injections: Array<{ agentId: string; payload: { memories: Array<{ id: string }> } }> }>("/injections")).injections.some(i => i.agentId === "helper" && i.payload.memories.some(m => m.id === pin.id)));
});
