/**
 * Areas F–J: orchestra with real agents, git and files, prompts/board/skills/
 * MCP, observability, terminal — against a real daemon.
 * Run: node e2e/run-work.mjs [--only=F1,G1]
 */

import fs from "node:fs";
import path from "node:path";
import WebSocket from "ws";
import { Daemon, Recorder, check, expect, freshRepo, git, ROOT, sleep, until } from "./lib.mjs";

const only = (process.argv.find((a) => a.startsWith("--only=")) ?? "").slice(7).split(",").filter(Boolean);
const want = (id) => !only.length || only.includes(id);
const rec = new Recorder(path.join(ROOT, "e2e/results/work.json"));
const d = new Daemon("work");
const repo = freshRepo("work", { "README.md": "# work\n", "src/app.js": "export const answer = 42;\n", "docs/guide.md": "hello needle world\n" });
await d.start();
const pid = (await d.post("/api/projects", { dir: repo })).body.project.id;
const P = `/api/projects/${pid}`;
await d.post(`${P}/agents/claude-code/model`, { model: "haiku" });

async function waitRun(runId, statuses, timeoutMs = 600_000) {
  return until(
    async () => {
      const r = (await d.get(`${P}/orchestra/${runId}`)).body.run;
      return statuses.includes(r?.status) ? r : null;
    },
    { timeoutMs, every: 3000, what: `run ${runId} → ${statuses.join("|")}` },
  );
}

// ── F: orchestra (real claude orchestrator, free opencode worker) ──
let runF1 = null;
if (want("F1")) await check(rec, "F1", async () => {
  const r = await d.post(`${P}/orchestra`, {
    goal: "Create a file named hello.txt at the repository root containing exactly the text: hi. Assign it to the opencode worker as one task, touching only hello.txt.",
    orchestrator: "claude-code",
    workers: ["opencode"],
    maxRounds: 6,
  });
  expect(r.status === 200 && r.body.run?.id, `start 200, got ${r.status} ${r.text.slice(0, 300)}`);
  runF1 = r.body.run.id;
  const run = await waitRun(runF1, ["completed", "failed", "waiting_human", "aborted"]);
  expect(run.status === "completed", `completed, got ${run.status} ${run.error ?? run.question ?? ""}`);
  const content = git(repo, "show", `${run.branch}:hello.txt`);
  expect(content.trim() === "hi", `integration branch hello.txt = "hi", got "${content}"`);
  return `run ${runF1} completed in ${run.round} rounds; tasks ${run.tasks.map((t) => `${t.id}:${t.agent}:${t.status}`).join(",")}; ${run.branch}:hello.txt="${content.trim()}" · $${run.costUsd.toFixed(3)}`;
});

if (want("F3")) await check(rec, "F3", async () => {
  expect(runF1, "needs F1");
  const a = await d.post(`${P}/orchestra/${runF1}/apply`);
  expect(a.status === 200, `apply 200, got ${a.status} ${a.text}`);
  const onHead = fs.readFileSync(path.join(repo, "hello.txt"), "utf8").trim();
  expect(onHead === "hi", `project working tree has hello.txt, got ${onHead}`);
  return `applied into ${a.body.into ?? "?"}; hello.txt on the project branch`;
});

if (want("F2")) await check(rec, "F2", async () => {
  const r = await d.post(`${P}/orchestra`, {
    goal: "Create notes.txt containing exactly: plan works. One task for the opencode worker, touching only notes.txt.",
    orchestrator: "claude-code",
    workers: ["opencode"],
    plan: true,
    maxRounds: 6,
  });
  expect(r.status === 200, `start 200, got ${r.status} ${r.text.slice(0, 200)}`);
  const run = await waitRun(r.body.run.id, ["completed", "failed", "waiting_human", "aborted"]);
  const plan = git(repo, "show", `${run.branch}:plans/${run.id}/PLAN.md`);
  expect(/notes\.txt/i.test(plan) || /Tasks/i.test(plan), `PLAN.md written, got ${plan.slice(0, 200)}`);
  const specs = git(repo, "ls-tree", "--name-only", `${run.branch}:plans/${run.id}`).split("\n");
  expect(specs.includes("PLAN.md") && specs.length >= 2, `a task spec beside PLAN.md, got ${specs.join(",")}`);
  return `status ${run.status}; plans/${run.id}: ${specs.join(", ")}`;
});

if (want("F4")) await check(rec, "F4", async () => {
  const r = await d.post(`${P}/orchestra`, { goal: "Write a 2000-word essay about looms into essay.md, in 20 separate tasks.", orchestrator: "claude-code", workers: ["opencode"], maxRounds: 3 });
  expect(r.status === 200, `start 200, got ${r.status}`);
  const id = r.body.run.id;
  await sleep(4000);
  const ab = await d.post(`${P}/orchestra/${id}/abort`);
  expect(ab.status === 200, `abort 200, got ${ab.status} ${ab.text}`);
  const run = await waitRun(id, ["aborted"], 60_000);
  const live = run.tasks.filter((t) => t.status === "running");
  expect(!live.length, `no task still running, got ${live.map((t) => t.id)}`);
  return `aborted: ${run.error}; tasks ${run.tasks.map((t) => `${t.id}:${t.status}`).join(",") || "(none yet)"}`;
});

if (want("F5")) await check(rec, "F5", async () => {
  const r = await d.post(`${P}/orchestra`, {
    goal: "Before doing anything, you MUST ask the human (with the ask action) which file name to use. Then create that file containing: ok, with one opencode task.",
    orchestrator: "claude-code",
    workers: ["opencode"],
    maxRounds: 6,
  });
  const id = r.body.run.id;
  const asked = await waitRun(id, ["waiting_human", "completed", "failed"], 300_000);
  expect(asked.status === "waiting_human" && asked.question, `asked a question, got ${asked.status}`);
  const rep = await d.post(`${P}/orchestra/${id}/reply`, { text: "Use answer.txt" });
  expect(rep.status === 200, `reply 200, got ${rep.status} ${rep.text}`);
  const done = await waitRun(id, ["completed", "failed", "waiting_human"], 400_000);
  expect(done.status === "completed", `completed after the reply, got ${done.status}`);
  const f = git(repo, "show", `${done.branch}:answer.txt`).trim();
  return `asked "${asked.question.slice(0, 80)}" → replied → completed; answer.txt="${f}"`;
});

// ── G: git and files ──
if (want("G1")) await check(rec, "G1", async () => {
  fs.writeFileSync(path.join(repo, "src/app.js"), "export const answer = 43;\n");
  const st = await d.get(`${P}/git/status`);
  expect(st.status === 200 && JSON.stringify(st.body).includes("src/app.js"), `status shows src/app.js, got ${st.text.slice(0, 300)}`);
  const diff = await d.get(`${P}/git/diff?path=src/app.js`);
  expect(diff.status === 200 && /\+export const answer = 43/.test(diff.text), `diff shows the change, got ${diff.text.slice(0, 300)}`);
  const br = await d.get(`${P}/git/branches`);
  const real = git(repo, "branch", "--format=%(refname:short)").split("\n");
  expect(real.every((b) => JSON.stringify(br.body).includes(b)), `branches match git (${real.join(",")})`);
  const log = await d.get(`${P}/git/log`);
  expect(log.status === 200 && JSON.stringify(log.body).includes("init"), "log shows the init commit");
  return `status/diff/branches(${real.length})/log match git`;
});

if (want("G2")) await check(rec, "G2", async () => {
  const dash = await d.post(`${P}/git/checkout`, { ref: "--orphan" });
  expect(dash.status >= 400, `a ref starting with - refused, got ${dash.status}`);
  const wt = await d.post(`${P}/worktrees`, { newBranch: "e2e-wt" });
  expect(wt.status === 200, `worktree 200, got ${wt.status} ${wt.text.slice(0, 200)}`);
  const list = await d.get(`${P}/worktrees`);
  const wtPath = (wt.body.worktree?.path ?? wt.body.path ?? JSON.stringify(list.body).match(/"path":"([^"]*e2e-wt[^"]*)"/)?.[1]);
  expect(JSON.stringify(list.body).includes("e2e-wt"), `listed, got ${list.text.slice(0, 300)}`);
  const real = git(repo, "worktree", "list");
  expect(real.includes("e2e-wt"), `git sees the worktree, got ${real}`);
  const rm = await d.req("DELETE", `${P}/worktrees`, { path: wtPath });
  expect(rm.status === 200, `remove 200, got ${rm.status} ${rm.text}`);
  expect(!git(repo, "worktree", "list").includes("e2e-wt"), "git no longer lists it");
  return `"-" ref → ${dash.status}; worktree e2e-wt created/listed/removed`;
});

if (want("G3")) await check(rec, "G3", async () => {
  const s = await d.post(`${P}/git/stage`, { paths: ["src/app.js"] });
  expect(s.status === 200, `stage 200, got ${s.status} ${s.text}`);
  const c = await d.post(`${P}/git/commit`, { message: "e2e: answer is 43" });
  expect(c.status === 200, `commit 200, got ${c.status} ${c.text}`);
  const last = git(repo, "log", "-1", "--format=%s");
  expect(last === "e2e: answer is 43", `commit landed, got ${last}`);
  // push to a real remote: a bare repo standing in for origin (the sandbox push is L-area)
  const bare = fs.mkdtempSync(path.join(path.dirname(repo), "loom-e2e-bare-"));
  git(bare, "init", "-q", "--bare");
  git(repo, "remote", "add", "origin", bare);
  const p = await d.post(`${P}/git/push`);
  expect(p.status === 200, `push 200, got ${p.status} ${p.text}`);
  expect(git(bare, "log", "-1", "--format=%s", "main") === "e2e: answer is 43", "remote has the commit");
  return `staged, committed "${last}", pushed to origin`;
});

if (want("G4")) await check(rec, "G4", async () => {
  // /tree is the live working-tree status (branch + changed files); /files is the listing
  fs.writeFileSync(path.join(repo, "scratch.txt"), "x\n");
  const tree = await d.get(`${P}/tree`);
  expect(tree.status === 200 && tree.body.tree?.branch === "main" && JSON.stringify(tree.body).includes("scratch.txt"), `tree shows branch + the changed file, got ${tree.text.slice(0, 200)}`);
  fs.rmSync(path.join(repo, "scratch.txt"));
  const f = await d.get(`${P}/file?path=src/app.js`);
  const disk = fs.readFileSync(path.join(repo, "src/app.js"), "utf8");
  expect(f.status === 200 && f.body.content === disk, `file content equals disk, got ${f.text.slice(0, 200)}`);
  const trav = await d.get(`${P}/file?path=${encodeURIComponent("../../../../etc/passwd")}`);
  expect(trav.status === 404 || trav.status === 400 || trav.status === 403, `traversal refused, got ${trav.status} ${trav.text.slice(0, 80)}`);
  expect(!trav.text.includes("root:"), "no /etc/passwd content");
  const find = await d.get(`${P}/find?q=guide`);
  expect(find.status === 200 && JSON.stringify(find.body).includes("guide.md"), `find, got ${find.text.slice(0, 200)}`);
  const grep = await d.get(`${P}/grep?q=needle`);
  expect(grep.status === 200 && JSON.stringify(grep.body).includes("guide.md"), `grep, got ${grep.text.slice(0, 200)}`);
  // /files lists one directory at a time
  const files = await d.get(`${P}/files?dir=src`);
  expect(files.status === 200 && files.body.entries?.some((e) => e.path === "src/app.js"), `files?dir=src lists src/app.js, got ${files.text.slice(0, 200)}`);
  return `tree/file/find/grep real; ../etc/passwd → ${trav.status}`;
});

// ── H: prompts, board, skills, MCP ──
if (want("H1")) await check(rec, "H1", async () => {
  const c = await d.post("/api/prompts", { title: "Review", text: "Review this diff for bugs." });
  expect(c.status === 200 && c.body.prompt?.id, `create, got ${c.text}`);
  const id = c.body.prompt.id;
  const u = await d.patch(`/api/prompts/${id}`, { pinned: true, text: "Review this diff for bugs and races." });
  expect(u.status === 200 && u.body.prompt.pinned === true, `update, got ${u.text}`);
  const l = await d.get("/api/prompts?q=races");
  expect(JSON.stringify(l.body).includes(id), "search finds it");
  const empty = await d.post("/api/prompts", { title: "x", text: "" });
  expect(empty.status === 400, `empty text 400, got ${empty.status}`);
  const del = await d.del(`/api/prompts/${id}`);
  expect(del.status === 200 && !JSON.stringify((await d.get("/api/prompts")).body).includes(id), "deleted");
  return "create/pin/search/delete; empty → 400";
});

if (want("H2")) await check(rec, "H2", async () => {
  const c = await d.post(`${P}/board/tasks`, { title: "Write the docs" });
  expect(c.status === 200 && c.body.task?.id, `create, got ${c.text}`);
  const id = c.body.task.id;
  const mv = await d.post(`${P}/board/tasks/${id}`, { column: "doing" });
  expect(mv.status === 200, `move 200, got ${mv.status} ${mv.text}`);
  const board = await d.get(`${P}/board/tasks`);
  const t = (board.body.tasks ?? []).find((x) => x.id === id);
  expect(t?.column === "doing", `moved to doing, got ${JSON.stringify(t)}`);
  const empty = await d.post(`${P}/board/tasks`, { title: " " });
  expect(empty.status === 400, `empty title 400, got ${empty.status}`);
  const del = await d.del(`${P}/board/tasks/${id}`);
  expect(del.status === 200, `delete 200, got ${del.status}`);
  return "create/move/delete; empty title → 400";
});

if (want("H3")) await check(rec, "H3", async () => {
  const s = await d.get(`${P}/skills`);
  expect(s.status === 200, `skills 200, got ${s.status}`);
  const cat = await d.get(`${P}/skills/catalog`);
  expect(cat.status === 200, `catalog 200, got ${cat.status}`);
  const a = await d.post(`${P}/skills/author`, { id: "e2e-skill", name: "e2e skill", description: "An e2e test skill.", body: "When asked about e2e, say e2e works." });
  expect(a.status === 200, `author 200, got ${a.status} ${a.text.slice(0, 200)}`);
  const s2 = await d.get(`${P}/skills`);
  const has = JSON.stringify(s2.body).includes("e2e-skill");
  expect(has, `authored skill listed, got ${s2.text.slice(0, 300)}`);
  const id = (s2.body.skills ?? []).find((k) => JSON.stringify(k).includes("e2e-skill"))?.id ?? "e2e-skill";
  const rm = await d.del(`${P}/skills/${encodeURIComponent(id)}`);
  expect(rm.status === 200, `remove 200, got ${rm.status} ${rm.text}`);
  return `skills=${(s.body.skills ?? []).length}, catalog=${(cat.body.skills ?? cat.body.catalog ?? []).length}; authored + removed e2e-skill`;
});

if (want("H4")) await check(rec, "H4", async () => {
  const cat = await d.get("/api/mcp/catalog");
  expect(cat.status === 200 && (cat.body.servers ?? cat.body.catalog ?? []).length > 0, `catalog rows, got ${cat.text.slice(0, 200)}`);
  const add = await d.patch(`${P}/mcps`, { mcp: { name: "e2e-fs", command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", repo] } });
  expect(add.status === 200, `add 200, got ${add.status} ${add.text.slice(0, 200)}`);
  const cfg = JSON.parse(fs.readFileSync(path.join(repo, ".loom", "config.json"), "utf8"));
  expect(JSON.stringify(cfg).includes("e2e-fs"), "written to config");
  const rm = await d.del(`${P}/mcps/e2e-fs`);
  expect(rm.status === 200, `remove 200, got ${rm.status} ${rm.text}`);
  const cfg2 = JSON.parse(fs.readFileSync(path.join(repo, ".loom", "config.json"), "utf8"));
  expect(!JSON.stringify(cfg2).includes("e2e-fs"), "removed from config");
  return `catalog ${(cat.body.servers ?? cat.body.catalog).length} rows; add/remove e2e-fs in config`;
});

// ── I: observability ──
if (want("I1")) await check(rec, "I1", async () => {
  const m = await d.get(`${P}/metrics`);
  const c = await d.get(`${P}/costs`);
  const h = await d.get(`${P}/insights/health`);
  expect(m.status === 200 && c.status === 200 && h.status === 200, `200s, got ${m.status}/${c.status}/${h.status}`);
  expect(c.body.costs.turns > 0, `turns counted, got ${c.text.slice(0, 200)}`);
  return `turns=${c.body.costs.turns} usd=${c.body.costs.totalUsd.toFixed(4)} agents=${c.body.costs.byAgent.map((a) => a.agentId).join(",")}`;
});

if (want("I2")) await check(rec, "I2", async () => {
  const b = await d.req("PUT", `${P}/budgets/claude-code`, { usdPerDay: 0.0001 });
  expect(b.status === 200, `set budget 200, got ${b.status} ${b.text}`);
  if ((await d.get(P)).body.project.holder !== "claude-code") await d.post(`${P}/handoff`, { to: "claude-code" });
  const s = await d.post(`${P}/messages`, { text: "hi", agentId: "claude-code" });
  expect(s.status >= 400 && /budget/i.test(s.text), `refused over budget, got ${s.status} ${s.text}`);
  await d.req("PUT", `${P}/budgets/claude-code`, { usdPerDay: 0 });
  return `over budget → ${s.status} ${s.text.slice(0, 120)}`;
});

if (want("I3")) await check(rec, "I3", async () => {
  const l = await d.get("/api/logs");
  const a = await d.get("/api/activity");
  expect(l.status === 200 && a.status === 200, `200s, got ${l.status}/${a.status}`);
  expect(JSON.stringify(a.body).includes(pid), "activity has the project");
  return `logs ${(l.body.logs ?? l.body.records ?? []).length} records; activity lists the project`;
});

if (want("I4")) await check(rec, "I4", async () => {
  const fire = await d.post(`/api/webhooks/alerts?project=${pid}`, { status: "firing", labels: { alertname: "HighErrorRate", agent: "codex" } }, null);
  expect(fire.status === 200, `firing 200, got ${fire.status} ${fire.text}`);
  const q = (await d.get(P)).body.project.agents.find((a) => a.id === "codex");
  const quarantined = JSON.stringify(fire.body).includes("quarantin") || q.quarantined;
  expect(quarantined, `codex quarantined, got ${fire.text} / ${JSON.stringify(q)}`);
  const res = await d.post(`/api/webhooks/alerts?project=${pid}`, { status: "resolved", labels: { alertname: "HighErrorRate", agent: "codex" } }, null);
  expect(res.status === 200, `resolved 200, got ${res.status}`);
  return `firing → ${fire.text.slice(0, 120)} · resolved → ${res.text.slice(0, 120)}`;
});

// ── J: terminal over the real WebSocket ──
if (want("J1")) await check(rec, "J1", async () => {
  const o = await d.post(`/api/projects/${pid}/term/open`, { term: "e2e", cols: 80, rows: 24 });
  expect(o.status === 200, `open 200, got ${o.status} ${o.text}`);
  const ws = new WebSocket(`ws://127.0.0.1:${d.port}/ws?project=${pid}`, [`loom.bearer.${d.admin}`]);
  let out = "";
  ws.on("message", (m) => {
    const f = JSON.parse(String(m));
    if (f.type === "term" && f.term === "e2e" && f.chunk) out += f.chunk;
  });
  await new Promise((r, j) => { ws.on("open", r); ws.on("error", j); });
  ws.send(JSON.stringify({ type: "term-input", term: "e2e", data: "echo loom-$((40+2))\r" }));
  await until(() => out.includes("loom-42"), { timeoutMs: 15_000, what: "echo output" });
  const rs = await d.post(`/api/projects/${pid}/term/resize`, { term: "e2e", cols: 100, rows: 30 });
  const sig = await d.post(`/api/projects/${pid}/term/signal`, { term: "e2e", signal: "SIGINT" });
  const cl = await d.post(`/api/projects/${pid}/term/close`, { term: "e2e" });
  ws.close();
  expect(rs.status === 200 && sig.status === 200 && cl.status === 200, `resize/signal/close 200, got ${rs.status}/${sig.status}/${cl.status}`);
  return `mode=${o.body.mode}; typed echo → "loom-42" came back over WS; resize/signal/close 200`;
});

fs.writeFileSync(path.join(ROOT, "e2e/results/work-state.json"), JSON.stringify({ home: d.home, port: d.port, pid, repo }, null, 2));
await d.stop();
