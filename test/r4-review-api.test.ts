import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, it } from "vitest";
import { LoomDaemon } from "../src/daemon/server.js";
import { DaemonClient } from "../src/daemon/client.js";
import { readDaemonConfig } from "../src/core/registry.js";
import { setProvider } from "../src/core/providers.js";
import { makeProjectDir, tmpDir, waitUntil } from "./helpers.js";
let daemon: LoomDaemon, client: DaemonClient, url: string, token: string, id: string, dir: string;
const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
async function raw(route: string, body?: unknown, auth = token, method = body === undefined ? "GET" : "POST") {
  return fetch(url + (route.startsWith("/api/") ? route : `/api/projects/${id}${route}`), { method, headers: { authorization: `Bearer ${auth}`, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
async function json(route: string, body?: unknown, method?: string) { const r = await raw(route, body, token, method), j = await r.json(); if (!r.ok) throw new Error(JSON.stringify(j)); return j; }
beforeAll(async () => {
  process.env.LOOM_HOME = tmpDir("r4-api-home"); process.env.LOOM_NO_NOTIFY = "1";
  daemon = new LoomDaemon({ host: "127.0.0.1", port: 0 }); const a = await daemon.listen(); url = `http://${a.host}:${a.port}`;
  token = readDaemonConfig()!.adminToken; client = new DaemonClient(readDaemonConfig()!);
  dir = makeProjectDir({ agents: [{ id: "bot", kind: "echo" }, { id: "reviewer", kind: "echo" }], defaultAgent: "bot" });
  git("init", "-q", "-b", "main"); fs.writeFileSync(path.join(dir, ".gitignore"), ".loom/\n"); fs.writeFileSync(path.join(dir, "seed.txt"), "seed\n"); git("add", "."); git("commit", "-qm", "seed"); id = (await client.addProject(dir)).project.id;
});
afterAll(async () => { await daemon?.close(); });
it("tracks echo turn attribution, summaries and viewed versions through the inbox", async () => {
  await json("/messages", { text: "Add a module write:module.ts", agentId: "bot", chat: "main" });
  await waitUntil(async () => (await json("/review/viewed?chat=main")).total === 1);
  const inbox = await json("/api/review/inbox"); expect(inbox.items).toContainEqual(expect.objectContaining({ project: id, chat: "main", total: 1, viewed: 0 }));
  expect((await json("/review/summary?chat=main")).files[0].summary).toContain("module.ts");
  const blame = await json("/review/blame?path=module.ts&line=1"); expect(blame).toMatchObject({ agent: "bot", chat: "main", prompt: "Add a module write:module.ts" });
  const view = await json("/review/viewed?chat=main"), file = view.files[0];
  expect((await json("/review/viewed", { chat: "main", path: file.path, version: file.version, viewed: true })).viewed).toBe(1);
  expect((await json("/api/review/inbox")).items.some((x: any) => x.project === id && x.chat === "main")).toBe(false);
  fs.appendFileSync(path.join(dir, "module.ts"), "later edit\n");
  expect((await json("/review/viewed?chat=main")).viewed).toBe(0);
  expect((await raw("/review/viewed", { chat: "main", path: file.path, version: file.version, viewed: true })).status).toBe(400);
});
it("runs hunk stage, discard and undo through project routes", async () => {
  fs.writeFileSync(path.join(dir, "seed.txt"), "new seed\n"); const h = await json("/git/hunks?path=seed.txt");
  await json("/git/hunks", { path: "seed.txt", version: h.version, id: h.hunks[0].id, action: "discard" }); expect(fs.readFileSync(path.join(dir, "seed.txt"), "utf8")).toBe("seed\n");
  await json("/git/hunks", { action: "undo" }); expect(fs.readFileSync(path.join(dir, "seed.txt"), "utf8")).toBe("new seed\n");
  await json("/git/hunks", { path: "seed.txt", version: h.version, id: h.hunks[0].id, action: "stage" }); expect(git("diff", "--cached")).toContain("new seed");
});
it("holds commits with output, sends failure to echo, and lets a passing command commit", async () => {
  await json("/git/verify", { command: 'node -e "console.log(\'check failed\');process.exit(1)"' }, "PUT");
  const head = git("rev-parse", "HEAD"), result = await raw("/git/commit", { message: "held" }); expect(result.status).toBe(409); expect((await result.json()).verify.output).toContain("check failed"); expect(git("rev-parse", "HEAD")).toBe(head);
  const fix = await json("/git/verify/agent", { agent: "reviewer" }); await waitUntil(async () => (await client.events(id)).events.some(e => e.chat === fix.chat && e.kind === "run_complete"));
  expect((await client.events(id)).events.some(e => e.chat === fix.chat && e.kind === "message" && String(e.payload.text).includes("check failed"))).toBe(true);
  await json("/config", { git: { commitPerTurn: true } }, "PATCH");
  await json("/messages", { text: "write:automatic.ts", agentId: "reviewer" });
  await waitUntil(async () => (await client.events(id)).events.some(e => e.payload.state === "git_failed" && String(e.payload.text).includes("check failed")));
  expect(git("rev-parse", "HEAD")).toBe(head);
  await json("/config", { git: { commitPerTurn: false } }, "PATCH"); await json("/git/verify", { command: 'node -e "console.log(\'passed\')"' }, "PUT");
  await json("/git/commit", { message: "verified" }); expect(git("log", "-1", "--format=%s")).toBe("verified"); await json("/git/verify", { command: "" }, "PUT");
});
it("applies edited split groups through the API", async () => {
  fs.writeFileSync(path.join(dir, "one.md"), "one\n"); fs.writeFileSync(path.join(dir, "two.ts"), "two\n");
  const p = await json("/git/split"); const result = await json("/git/split", { version: p.version, groups: [{ subject: "First group", files: ["one.md"] }, { subject: "Second group", files: ["two.ts"] }] }); expect(result.commits).toHaveLength(2); expect(git("log", "-1", "--format=%s")).toBe("Second group");
});
it("hands real merge conflicts to echo with both sides and leaves HEAD unchanged", async () => {
  git("add", "."); git("commit", "-qm", "remaining"); git("checkout", "-qb", "conflicting"); fs.writeFileSync(path.join(dir, "seed.txt"), "theirs\n"); git("commit", "-qam", "theirs"); git("checkout", "main"); fs.writeFileSync(path.join(dir, "seed.txt"), "ours\n"); git("commit", "-qam", "ours");
  const head = git("rev-parse", "HEAD"); expect((await json("/git/conflicts")).files).toEqual([]);
  const r = await json("/git/resolve", { agent: "reviewer", branch: "conflicting" }); expect(r.waitingForReview).toBe(true); expect((await json("/git/conflicts")).files).toEqual(["seed.txt"]);
  await waitUntil(async () => (await client.events(id)).events.some(e => e.chat === r.chat && e.kind === "run_complete"));
  const text = (await client.events(id)).events.filter(e => e.chat === r.chat && !e.agentId && e.kind === "message").map(e => e.payload.text).join(); expect(text).toContain("OURS:\nours"); expect(text).toContain("THEIRS:\ntheirs"); expect(git("rev-parse", "HEAD")).toBe(head);
  fs.writeFileSync(path.join(dir, "seed.txt"), "resolved\n"); git("add", "seed.txt"); await json("/git/commit", { message: "Reviewed resolution" }); expect((await json("/git/conflicts")).waitingForReview).toBe(false);
});
it("reviews GitHub PR diffs with echo and saves editable comments without posting", async () => {
  const bin = tmpDir("r4-gh"), oldPath = process.env.PATH;
  fs.writeFileSync(path.join(bin, "gh"), '#!/bin/sh\n[ "$1 $2" = "pr diff" ] || exit 9\nprintf "diff --git a/remote.ts b/remote.ts\\n--- a/remote.ts\\n+++ b/remote.ts\\n@@ -1 +1 @@\\n-old\\n+new\\n"\n', { mode: 0o755 }); process.env.PATH = bin + path.delimiter + oldPath;
  try {
    const r = await json("/review/pr", { pr: "https://github.com/example/repo/pull/12", agents: ["reviewer"] });
    await waitUntil(async () => (await json("/review/pr/" + r.review.reviewId)).review.status === "done");
    const result = await json("/review/pr/" + r.review.reviewId); expect(result.target.provider).toBe("github"); expect(result.review.results[0].reply).toContain("Read the whole file");
    const stored = fs.readdirSync(path.join(dir, ".loom/review-r4")); expect(fs.readFileSync(path.join(dir, ".loom/review-r4", stored[0]!), "utf8")).toContain("+new");
    await json("/review/pr/" + r.review.reviewId, { text: "My edited comment" }, "PUT"); expect((await json("/review/pr/" + r.review.reviewId)).draft).toBe("My edited comment");
  } finally { process.env.PATH = oldPath; }
});
it("fetches GitLab MR diff pages with configured credentials, never posts", async () => {
  const calls: string[] = [];
  const server = http.createServer((req, res) => { calls.push(req.method + " " + req.url); expect(req.headers["private-token"]).toBe("fixture-token"); res.setHeader("content-type", "application/json"); if (new URL(req.url!, "http://localhost").searchParams.get("page") === "1") res.setHeader("x-next-page", "2"); res.end(JSON.stringify([{ old_path: "remote.ts", new_path: "remote.ts", diff: "@@ -1 +1 @@\n-old\n+new\n" }])); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  setProvider("gitlab", { key: "fixture-token", baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}` });
  try { const r = await json("/review/pr", { pr: "https://127.0.0.1/team/repo/-/merge_requests/7", agents: ["reviewer"] }); expect(r.target.provider).toBe("gitlab"); expect(calls).toHaveLength(2); expect(calls.every(c => c.startsWith("GET "))).toBe(true); await waitUntil(async () => (await json("/review/pr/" + r.review.reviewId)).review.status === "done"); }
  finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
it("exposes the commands through the real CLI without changing send JSON", async () => {
  const cli = fileURLToPath(new URL("../src/cli/index.ts", import.meta.url));
  const invoke = async (args: string[]) => JSON.parse((await promisify(execFile)(process.execPath, ["--import", import.meta.resolve("tsx"), cli, ...args], { cwd: dir, env: process.env, timeout: 30_000 })).stdout);
  await json("/git/verify", { command: `node -e "console.log('CLI verification')"` }, "PUT");
  expect((await invoke(["git:verify", "--run"])).result.output).toContain("CLI verification");
  await json("/git/verify", { command: "" }, "PUT");
  expect((await invoke(["review:inbox"])).items.length).toBeGreaterThan(0); expect((await invoke(["review:summary", "--chat", "main"])).files.length).toBeGreaterThan(0); expect((await invoke(["blame", "module.ts:1"])).agent).toBe("bot"); expect((await invoke(["git:split"])).groups).toBeInstanceOf(Array); expect((await invoke(["send", "hello", "--wait", "--json"]))).toBeTypeOf("object");
});
it("honors owner phones and project-scoped devices and refuses share-live guests", async () => {
  async function paired(projects?: string[]) { const pair = await raw("/api/pair/new", projects ? { projects } : {}); const claim = await raw("/api/pair/claim", { token: (await pair.json()).token, name: "phone" }); return (await claim.json()).clientToken; }
  const owner = await paired(), scoped = await paired([id]);
  const other = (await client.addProject(makeProjectDir())).project.id;
  for (const auth of [owner, scoped]) {
    expect((await raw("/review/viewed", undefined, auth)).status).toBe(200);
    expect((await raw("/git/verify", { command: "" }, auth, "PUT")).status).toBe(auth === owner ? 200 : 403);
    expect((await raw("/git/verify", undefined, auth)).status).toBe(200);
    expect((await raw("/git/verify", {}, auth)).status).toBe(200);
    expect((await raw("/api/review/inbox", undefined, auth)).status).toBe(200);
  }
  git("remote", "add", "origin", "git@github.com:example/repo.git");
  const forbidden = await raw("/review/pr", { pr: "https://github.com/owner/private-other/pull/3", agents: ["reviewer"] }, scoped);
  expect(forbidden.status).toBe(400); expect((await forbidden.json()).error).toBe("that pull request is not in this project's repository");
  expect((await raw("/git/resolve", undefined, scoped, "DELETE")).status).toBe(200);
  expect((await raw(`/api/projects/${other}/review/viewed`, undefined, scoped)).status).toBe(403);
  const shared = await client.shareLive({ project: id, chat: "main", name: "Guest", role: "read" }); const pair = new URLSearchParams(new URL(shared.link).hash.slice(1)).get("pair"); const guest = (await (await raw("/api/pair/claim", { token: pair, name: "guest" })).json()).clientToken;
  for (const route of ["/api/review/inbox", "/review/viewed", "/review/summary", "/review/blame?path=seed.txt", "/git/hunks?path=seed.txt", "/git/split", "/git/verify"]) expect((await raw(route, undefined, guest)).status, route).toBe(403);
});
it("includes unmerged run task branches in inbox and records viewed files per run", async () => {
  const { run } = await json("/orchestra", { goal: "write:run-review.txt", orchestrator: "bot", workers: ["bot", "reviewer"], race: true });
  try {
    await waitUntil(async () => (await json(`/orchestra/${run.id}`)).run.tasks.every((t: any) => t.status === "done"));
    const view = await json("/review/viewed?run=" + run.id); expect(view.total).toBeGreaterThan(0);
    expect((await json("/api/review/inbox")).items.some((item: any) => item.run === run.id)).toBe(true);
    for (const file of view.files) await json("/review/viewed", { run: run.id, chat: run.chat, path: file.path, version: file.version, viewed: true });
    expect((await json("/review/viewed?run=" + run.id)).viewed).toBe(view.total);
    expect((await json("/api/review/inbox")).items.some((item: any) => item.run === run.id)).toBe(false);
  } finally { await json(`/orchestra/${run.id}/abort`, {}); }
});

it("serves other requests while a verification is running and reports its timeout", async () => {
  await json("/git/verify", { command: `node -e "setTimeout(() => console.log('done'), 900)"`, verifyTimeoutMs: 3000 }, "PUT");
  let settled = false; const pending = raw("/git/verify", {}).then(r => { settled = true; return r; });
  await new Promise(resolve => setTimeout(resolve, 80));
  expect((await raw("/git/conflicts")).status).toBe(200); expect(settled).toBe(false); expect((await pending).status).toBe(200);
  await json("/git/verify", { command: `node -e "setTimeout(() => {}, 90000)"`, verifyTimeoutMs: 40 }, "PUT");
  const failed = await raw("/git/verify", {}); expect(failed.status).toBe(409); expect((await failed.json()).verify.output).toContain("timed out after 40 ms");
  await json("/git/verify", { command: "", verifyTimeoutMs: 600000 }, "PUT");
});
