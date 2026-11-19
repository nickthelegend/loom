import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import path from "node:path";
import { execFile, execFileSync } from "node:child_process";
import { afterAll, beforeAll, expect, it } from "vitest";
import { LoomDaemon } from "../src/daemon/server.js";
import { DaemonClient } from "../src/daemon/client.js";
import { readDaemonConfig } from "../src/core/registry.js";
import { chatBranch } from "../src/core/git-review.js";
import { makeProjectDir, tmpDir, waitUntil } from "./helpers.js";

let daemon: LoomDaemon, client: DaemonClient, url: string, token: string, id: string, dir: string;
const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
async function request(route: string, body?: unknown, auth = token, method = body === undefined ? "GET" : "POST") {
  return fetch(`${url}/api/projects/${id}${route}`, { method, headers: { Authorization: `Bearer ${auth}`, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
async function json(route: string, body?: unknown, method?: string) {
  const r = await request(route, body, token, method); const j = await r.json();
  if (!r.ok) throw new Error(JSON.stringify(j)); return j;
}
beforeAll(async () => {
  process.env.LOOM_HOME = tmpDir("r3-api-home"); process.env.LOOM_NO_NOTIFY = "1";
  daemon = new LoomDaemon({ host: "127.0.0.1", port: 0 }); const address = await daemon.listen();
  url = `http://${address.host}:${address.port}`;
  const config = readDaemonConfig()!; token = config.adminToken; client = new DaemonClient(config);
  dir = makeProjectDir({ agents: [{ id: "plannerbot", kind: "echo" }, { id: "execbot", kind: "echo" }, { id: "conductor", kind: "echo" }] }); git("init", "-q", "-b", "main");
  fs.writeFileSync(path.join(dir, ".gitignore"), ".loom/\n"); fs.writeFileSync(path.join(dir, "seed.txt"), "seed\n");
  git("add", "."); git("commit", "-qm", "seed");
  id = (await client.addProject(dir)).project.id;
});
afterAll(async () => { await daemon?.close(); });

it("creates a chat branch only after an edit, commits a diff-aware subject and exposes attribution", async () => {
  await json("/config", { git: { branchPerChat: true, commitPerTurn: true } }, "PATCH");
  await json("/messages", { text: "read only", agentId: "plannerbot", chat: "main" });
  await waitUntil(async () => (await client.events(id)).events.some(e => e.kind === "run_complete"));
  expect(git("branch", "--show-current")).toBe("main");
  await json("/messages", { text: "Fix parser write:parser.ts", agentId: "plannerbot", chat: "main" });
  await waitUntil(() => git("log", "-1", "--format=%s").includes("Fix parser"));
  expect(git("branch", "--show-current")).toBe(chatBranch("main"));
  expect(git("log", "-1", "--format=%B")).toContain("Co-Authored-By: plannerbot");
  expect((await json("/insights/diffs")).agents).toContainEqual(expect.objectContaining({ agentId: "plannerbot", files: 1, added: 1, removed: 0 }));
  expect((await json("/insights/turns")).leaderboard[0].diff.files).toBe(1);
  const draft = await client.describePr(id, "main", "security");
  expect(draft.description).toContain("Fix parser"); expect(draft.description).toContain("parser.ts"); expect(draft.checklist).toContain("Authorization is enforced");
});

it("reverts one turn file through the API, with a recoverable checkpoint", async () => {
  const events = (await client.events(id)).events;
  const turn = events.find(e => e.kind === "turn_diff" && e.payload.checkpoint)!;
  const r = await json(`/checkpoints/${turn.payload.checkpoint}/rewind-file`, { path: "parser.ts" });
  expect(r.removed).toBe(true); expect(r.undo.id).toBeTruthy(); expect(fs.existsSync(path.join(dir, "parser.ts"))).toBe(false);
  await json(`/checkpoints/${r.undo.id}/rewind-file`, { path: "parser.ts" });
  expect(fs.existsSync(path.join(dir, "parser.ts"))).toBe(true);
  expect((await request(`/checkpoints/${r.undo.id}/rewind-file`, { path: ".git/config" })).status).toBe(400);
});

it("attaches checklist snapshots and passes them to echo reviewers", async () => {
  const { review } = await json("/reviews", { agents: ["execbot"], text: "Review the parser", template: "security" });
  expect(review.checklist).toContain("Authorization is enforced");
  await waitUntil(async () => (await json(`/reviews/${review.reviewId}`)).review.status === "done");
  const done = (await json(`/reviews/${review.reviewId}`)).review;
  expect(done.checklist).toEqual(review.checklist); expect(done.results[0].reply).toContain("Secrets stay out of logs");
  expect((await request("/reviews", { agents: ["execbot"], text: "x", template: "missing" })).status).toBe(400);
});

it("reports hook failures to manual callers and the automatic turn's thread", async () => {
  const hook = path.join(dir, ".git/hooks/pre-commit");
  fs.writeFileSync(hook, "#!/bin/sh\necho check-format-failed >&2\nexit 1\n", { mode: 0o755 });
  const head = git("rev-parse", "HEAD");
  await json("/messages", { text: "Write failing change write:hooked.ts", agentId: "plannerbot" });
  await waitUntil(async () => (await client.events(id)).events.some(e => e.payload.state === "git_failed" && String(e.payload.text).includes("check-format-failed")));
  expect(git("rev-parse", "HEAD")).toBe(head);
  const r = await request("/git/commit", { message: "manual" }); expect(r.status).toBe(400); expect((await r.json()).error).toContain("check-format-failed");
  fs.unlinkSync(hook); git("reset", "--hard", "HEAD"); git("clean", "-fd");
});

it("exposes PR descriptions and statistics through the real CLI", async () => {
  const cli = fileURLToPath(new URL("../src/cli/index.ts", import.meta.url));
  const invoke = (args: string[]) => promisify(execFile)(process.execPath, ["--import", import.meta.resolve("tsx"), cli, ...args], { cwd: dir, env: process.env, timeout: 20_000 });
  const pr = await invoke(["pr:describe", "--chat", "main", "--template", "release"]);
  expect(pr.stdout).toContain("## Summary"); expect(pr.stdout).toContain("Migration and rollback are documented");
  const stats = JSON.parse((await invoke(["git:stats"])).stdout);
  expect(stats.agents.some((a: { agentId: string }) => a.agentId === "plannerbot")).toBe(true);
});

it("cuts the chat branch on the first reported edit while the turn is still streaming", async () => {
  const { chat } = await client.createChat(id, "First edit");
  await json("/messages", { text: "write:early.txt stream:120 Keep streaming after the edit for this test", agentId: "plannerbot", chat: chat.id });
  await waitUntil(() => git("branch", "--show-current") === chatBranch(chat.id));
  expect((await client.events(id)).events.some(e => e.chat === chat.id && e.kind === "run_complete")).toBe(false);
  await waitUntil(async () => (await client.events(id)).events.some(e => e.chat === chat.id && e.payload.state === "turn_committed"));
});

it("preflights parallel Orchestra conflicts and honors worker commit hooks", async () => {
  await json("/config", { git: { branchPerChat: false, commitPerTurn: false } }, "PATCH");
  const { run } = await json("/orchestra", { goal: "Exercise merge preflight", orchestrator: "conductor", workers: ["plannerbot", "execbot"], maxParallel: 2 });
  const status = async () => (await json(`/orchestra/${run.id}`)).run;
  await waitUntil(async () => (await status()).status === "waiting_human");
  const actions = [
    { type: "spawn", id: "one", title: "First worker", agent: "plannerbot", prompt: "write:shared.txt sleep:200" },
    { type: "spawn", id: "two", title: "Second worker", agent: "execbot", prompt: "write:shared.txt sleep:200" },
  ];
  // The echo conductor repeats JSON; escape the colon so only workers execute the write trick.
  const text = "```loom\n" + JSON.stringify({ actions }).replaceAll("write:", "write\\u003a") + "\n```";
  await json(`/orchestra/${run.id}/reply`, { text });
  await waitUntil(async () => (await status()).tasks.some((t: { status: string }) => t.status === "conflict"));
  const result = await status();
  expect(result.tasks.find((t: { status: string }) => t.status === "conflict").error).toContain("pre-merge conflict");
  expect(execFileSync("git", ["status", "--porcelain"], { cwd: result.dir, encoding: "utf8" })).not.toContain("UU");
  await json(`/orchestra/${run.id}/abort`, {});

  const hook = path.join(dir, ".git/hooks/pre-commit");
  fs.writeFileSync(hook, "#!/bin/sh\necho orchestra-hook-failed >&2\nexit 1\n", { mode: 0o755 });
  const race = (await json("/orchestra", { goal: "write:hook-worker.txt", orchestrator: "conductor", workers: ["plannerbot", "execbot"], race: true })).run;
  try {
    await waitUntil(async () => (await json(`/orchestra/${race.id}`)).run.tasks.every((t: { status: string }) => t.status === "failed"));
    expect((await json(`/orchestra/${race.id}`)).run.tasks[0].error).toContain("orchestra-hook-failed");
  } finally { fs.unlinkSync(hook); await json(`/orchestra/${race.id}/abort`, {}); }
});

it("refuses share-live guests across batch routes; a device scoped to this project keeps its git access", async () => {
  const pair = await fetch(url + "/api/pair/new", { method: "POST", headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ projects: [id] }) });
  expect(pair.ok).toBe(true);
  const claim = await fetch(url + "/api/pair/claim", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: (await pair.json()).token, name: "scoped" }) });
  const scoped = (await claim.json()).clientToken;
  const share = await client.shareLive({ project: id, chat: "main", name: "Guest", role: "read" });
  const guestPair = new URLSearchParams(new URL(share.link).hash.slice(1)).get("pair")!;
  const guestClaim = await fetch(url + "/api/pair/claim", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: guestPair, name: "guest" }) });
  const guest = (await guestClaim.json()).clientToken;
  // a device scoped to this project can still read its git review templates (the scope wall confines it to this project)
  expect((await request("/git/review-templates", undefined, scoped, "GET")).status).toBe(200);
  for (const auth of [guest]) {
    for (const [route, body, method] of [["/git/pr-description", { chat: "main" }, "POST"], ["/GIT/pr-description", { chat: "main" }, "POST"], ["/config/", { git: { branchPerChat: true } }, "PATCH"], ["/git/review-templates", undefined, "GET"], ["/insights/diffs", undefined, "GET"], ["/config", { git: { branchPerChat: true } }, "PATCH"], ["/reviews", { agents: ["execbot"], text: "x" }, "POST"], ["/checkpoints/cfake/rewind-file", { path: "seed.txt" }, "POST"]] as const) {
      expect((await request(route, body, auth, method)).status, `${route} guest`).toBe(403);
    }
  }
});
