/**
 * Area O: the prompt queue against the real product — a real daemon, real
 * agent CLIs (claude on haiku, codex, the free opencode), real HTTP and a real
 * WebSocket. Nothing here is scripted: a prompt is queued because the agent is
 * genuinely mid-turn, and it runs because the turn genuinely ended.
 * Run: node e2e/run-queue.mjs [--only=O1,O3]
 */

import path from "node:path";
import WebSocket from "ws";
import { Daemon, Recorder, check, expect, freshRepo, git, ROOT, sleep, until } from "./lib.mjs";

const only = (process.argv.find((a) => a.startsWith("--only=")) ?? "").slice(7).split(",").filter(Boolean);
const want = (id) => !only.length || only.includes(id);
const rec = new Recorder(path.join(ROOT, "e2e/results/queue.json"));
const d = new Daemon("queue");
const repo = freshRepo("queue", { "README.md": "# queue\n" });
await d.start();
const pid = (await d.post("/api/projects", { dir: repo })).body.project.id;
const P = `/api/projects/${pid}`;
await d.post(`${P}/agents/claude-code/model`, { model: "haiku" });

/** A prompt that keeps a real CLI busy long enough to queue behind it. */
const SLOW = "Write the numbers 1 to 12, one per line, nothing else.";
const q = () => d.get(`${P}/queue`).then((r) => r.body);
const messages = async (chat = "main") =>
  (await d.get(`${P}/events?chat=${chat}&limit=300`)).body.events
    .filter((e) => e.kind === "message" && !e.agentId)
    .map((e) => String(e.payload.text));

/** Live `queue` frames, so the socket is tested the way the app uses it. */
const frames = [];
const ws = new WebSocket(`ws://127.0.0.1:${d.port}/ws?project=${pid}`, [`loom.bearer.${d.admin}`]);
ws.on("message", (raw) => {
  try {
    const f = JSON.parse(String(raw));
    if (f.type === "queue") frames.push(f);
  } catch {
    /* not ours */
  }
});
await new Promise((r, j) => { ws.on("open", r); ws.on("error", j); });

const busy = () => d.get(`${P}`).then((r) => (r.body.project.agents ?? []).some((a) => a.busy));
const waitIdle = (timeoutMs = 300_000) => until(async () => !(await busy()), { timeoutMs, every: 2000, what: "every agent idle" });

if (want("O1")) await check(rec, "O1", async () => {
  const sent = await d.post(`${P}/messages`, { text: SLOW, agentId: "claude-code" });
  expect(sent.status === 200 && !sent.body.queued, `the first prompt goes straight out, got ${sent.text.slice(0, 200)}`);
  await until(busy, { timeoutMs: 60_000, what: "claude-code busy" });

  // three behind it, one of them for a different agent
  const a = await d.post(`${P}/queue`, { text: "Reply with exactly: ONE", target: "claude-code" });
  const b = await d.post(`${P}/queue`, { text: "Reply with exactly: TWO", target: "claude-code" });
  const c = await d.post(`${P}/queue`, { text: "Reply with exactly: THREE", target: "claude-code" });
  expect(a.status === 200 && c.body.queue.length === 3, `three queued, got ${c.text.slice(0, 200)}`);
  const view = await q();
  expect(view.waitingFor && /claude-code/.test(view.waitingFor), `it says what it waits for, got ${JSON.stringify(view.waitingFor)}`);

  // a queued prompt is NOT in the conversation yet
  const said = await messages();
  expect(said.length === 1 && said[0] === SLOW, `only the sent prompt is in the thread, got ${JSON.stringify(said)}`);

  // edit the head, drop one, and move the last to the front
  const ed = await d.patch(`${P}/queue/${a.body.item.id}`, { text: "Reply with exactly: ONE-EDITED" });
  expect(ed.status === 200, `edit 200, got ${ed.text.slice(0, 200)}`);
  const rm = await d.del(`${P}/queue/${b.body.item.id}`);
  expect(rm.status === 200 && rm.body.queue.length === 2, `remove, got ${rm.text.slice(0, 200)}`);
  const mv = await d.patch(`${P}/queue/${c.body.item.id}`, { to: 0 });
  expect(mv.body.queue.map((i) => i.text).join(" | ") === "Reply with exactly: THREE | Reply with exactly: ONE-EDITED",
    `reordered, got ${mv.body.queue.map((i) => i.text).join(" | ")}`);

  // now let it run: they go in the order the queue shows, one at a time
  await until(async () => (await q()).queue.length === 0, { timeoutMs: 600_000, every: 3000, what: "the queue to empty" });
  await waitIdle();
  const after = await messages();
  expect(after.length === 3, `three prompts reached the thread, got ${JSON.stringify(after)}`);
  expect(after[1] === "Reply with exactly: THREE" && after[2] === "Reply with exactly: ONE-EDITED",
    `sent in the queued order, got ${JSON.stringify(after.slice(1))}`);
  expect(!after.includes("Reply with exactly: TWO"), "the removed one was never sent");
  expect(frames.length >= 5, `the socket carried the changes, got ${frames.length} queue frames`);
  return `3 queued behind a real turn; edited, removed and reordered; sent in queue order (${after.slice(1).join(" → ")}); ${frames.length} live frames; nothing in the thread before it was sent`;
});

if (want("O2")) await check(rec, "O2", async () => {
  await waitIdle();
  await d.post(`${P}/messages`, { text: SLOW, agentId: "claude-code" });
  await until(busy, { timeoutMs: 60_000, what: "claude-code busy" });
  const item = (await d.post(`${P}/queue`, { text: "Reply with exactly: CODEX-HERE", target: "claude-code" })).body.item;
  // change your mind about who takes it, while it waits
  const moved = await d.patch(`${P}/queue/${item.id}`, { target: "codex" });
  expect(moved.body.queue[0].target.agentId === "codex", `retargeted, got ${JSON.stringify(moved.body.queue[0].target)}`);
  await until(async () => (await q()).queue.length === 0, { timeoutMs: 600_000, every: 3000, what: "the queue to empty" });
  const holder = await until(async () => {
    const p = (await d.get(P)).body.project;
    return p.holder === "codex" ? p.holder : null;
  }, { timeoutMs: 300_000, every: 2000, what: "the baton on codex" });
  await waitIdle();
  const replied = (await d.get(`${P}/events?limit=300`)).body.events.some(
    (e) => e.kind === "message" && e.agentId === "codex" && /CODEX-HERE/.test(String(e.payload.text)),
  );
  expect(replied, "codex answered the prompt that was queued for claude-code");
  return `retargeted while waiting: codex took it, baton on ${holder}, and codex's reply carries the token`;
});

if (want("O3")) await check(rec, "O3", async () => {
  await waitIdle();
  const first = await d.post(`${P}/orchestra`, {
    goal: "Create a file named one.txt at the repository root containing exactly: one. One task, touching only one.txt.",
    orchestrator: "claude-code",
    workers: ["opencode"],
    maxRounds: 6,
  });
  expect(first.status === 200, `the first goal starts, got ${first.text.slice(0, 200)}`);
  const second = await d.post(`${P}/queue`, {
    text: "Create a file named two.txt at the repository root containing exactly: two. One task, touching only two.txt.",
    target: { kind: "orchestra", orchestrator: "claude-code", workers: ["opencode"] },
  });
  expect(second.status === 200, `the second goal queues, got ${second.text.slice(0, 200)}`);
  const blocked = await q();
  expect(blocked.waitingFor && /one\.txt|goal/.test(blocked.waitingFor), `it waits for the running goal, got ${JSON.stringify(blocked.waitingFor)}`);
  // a second goal can't start while one runs — proof the queue is the only way
  const refused = await d.post(`${P}/orchestra`, { goal: "should be refused", orchestrator: "claude-code" });
  expect(refused.status === 400, `starting a second goal directly is refused, got ${refused.status}`);

  const run2 = await until(async () => {
    const runs = (await d.get(`${P}/orchestra`)).body.runs;
    return runs.find((r) => /two\.txt/.test(r.goal)) ?? null;
  }, { timeoutMs: 900_000, every: 5000, what: "the queued goal to start itself" });
  const done = await until(async () => {
    const r = (await d.get(`${P}/orchestra/${run2.id}`)).body.run;
    return ["completed", "failed", "aborted", "waiting_human"].includes(r.status) ? r : null;
  }, { timeoutMs: 900_000, every: 5000, what: `${run2.id} to finish` });
  expect(done.status === "completed", `the queued goal completed, got ${done.status} ${done.error ?? done.question ?? ""}`);
  expect((await q()).queue.length === 0, "the queue emptied itself");
  return `goal 2 waited for goal 1 (a direct second start is still refused: 400), then ran itself: ${run2.id} ${done.status} · $${(done.costUsd ?? 0).toFixed(3)}`;
});

if (want("O4")) await check(rec, "O4", async () => {
  await waitIdle();
  // whoever holds the baton after the tests above: take it back first, the way
  // the app does when you pick an agent and send
  await d.post(`${P}/handoff`, { to: "claude-code" });
  const started = await d.post(`${P}/messages`, { text: SLOW, agentId: "claude-code" });
  expect(started.status === 200, `the turn starts, got ${started.status} ${started.text.slice(0, 200)}`);
  await until(busy, { timeoutMs: 60_000, what: "claude-code busy" });
  await d.post(`${P}/queue`, { text: "Reply with exactly: AFTER-STOP", target: "claude-code" });
  const stopped = await d.post(`${P}/interrupt`, {});
  expect(stopped.status === 200, `stop 200, got ${stopped.status} ${stopped.text.slice(0, 200)}`);
  await sleep(1500);
  const held = await q();
  expect(held.paused && held.queue.length === 1, `Stop holds the queue instead of emptying it, got ${JSON.stringify(held).slice(0, 200)}`);
  expect(/Stop/i.test(held.reason ?? ""), `it says why, got ${held.reason}`);
  await sleep(4000);
  expect((await messages()).every((t) => t !== "Reply with exactly: AFTER-STOP"), "nothing ran while it was paused");
  const resumed = await d.post(`${P}/queue/pause`, { paused: false });
  expect(resumed.status === 200 && !resumed.body.paused, `resume, got ${resumed.text.slice(0, 200)}`);
  await until(async () => (await messages()).includes("Reply with exactly: AFTER-STOP"), { timeoutMs: 300_000, every: 2000, what: "the resumed prompt to be sent" });
  await waitIdle();
  return `Stop paused the queue ("${held.reason}") and kept the prompt; resume sent it`;
});

if (want("O5")) await check(rec, "O5", async () => {
  // The CLI surface, driven exactly as a person would from the project dir.
  // Paused first, so the queue can be inspected and edited without a real turn.
  const cli = (args) => d.cli(["queue", ...args], { cwd: repo }).trim();
  await waitIdle();
  cli(["clear"]);
  cli(["pause"]);
  cli(["add", "first one", "--to", "claude-code"]);
  cli(["add", "second one", "--to", "codex"]);
  cli(["add", "a whole goal", "--to", "orchestrate"]);
  let list = cli([]);
  expect(/1\s+claude-code\s+first one/.test(list), `the list numbers them and says who takes each, got:\n${list}`);
  expect(/orchestrate\s+a whole goal/.test(list), `an orchestrate item reads as one, got:\n${list}`);
  expect(/paused/.test(list), `it says it's paused, got:\n${list}`);
  cli(["edit", "1", "first one, edited"]);
  cli(["move", "3", "1"]);
  cli(["to", "2", "opencode"]);
  cli(["rm", "3"]);
  list = cli([]);
  const view = await q();
  expect(view.queue.map((i) => i.text).join(" | ") === "a whole goal | first one, edited",
    `edit/move/rm through the CLI, got ${view.queue.map((i) => i.text).join(" | ")}`);
  expect(view.queue[1].target.agentId === "opencode", `retargeted through the CLI, got ${JSON.stringify(view.queue[1].target)}`);
  expect(cli(["clear"]).includes("dropped 2"), "clear says what it dropped");
  cli(["resume"]);
  expect((await q()).paused === false, "resumed");
  return `loom queue: add/list/edit/move/to/rm/clear/pause/resume all drive the same queue (list showed:\n${list.split("\n").slice(0, 3).join(" ⏎ ")})`;
});

if (want("O6")) await check(rec, "O6", async () => {
  // The user's own ask: the orchestrator hands work to DIFFERENT agents.
  await waitIdle();
  const r = await d.post(`${P}/orchestra`, {
    goal: "Create two files at the repository root: alpha.txt containing exactly: alpha, and beta.txt containing exactly: beta. "
      + "Spawn exactly two tasks that run in parallel: give alpha.txt to the opencode worker and beta.txt to the codex worker. "
      + "Each task touches only its own file.",
    orchestrator: "claude-code",
    workers: ["opencode", "codex"],
    maxParallel: 2,
    maxRounds: 8,
  });
  expect(r.status === 200 && r.body.run?.id, `start 200, got ${r.status} ${r.text.slice(0, 300)}`);
  const run = await until(async () => {
    const x = (await d.get(`${P}/orchestra/${r.body.run.id}`)).body.run;
    return ["completed", "failed", "aborted", "waiting_human"].includes(x.status) ? x : null;
  }, { timeoutMs: 1_200_000, every: 5000, what: "the two-worker goal" });
  expect(run.status === "completed", `completed, got ${run.status} ${run.error ?? run.question ?? ""}`);
  const kinds = [...new Set(run.tasks.map((t) => t.kind ?? t.agent))];
  expect(run.tasks.length >= 2 && kinds.length >= 2, `two tasks on two different agents, got ${run.tasks.map((t) => `${t.id}:${t.agent}`).join(",")}`);
  const alpha = git(repo, "show", `${run.branch}:alpha.txt`).trim();
  const beta = git(repo, "show", `${run.branch}:beta.txt`).trim();
  expect(alpha === "alpha" && beta === "beta", `both workers' files are on the integration branch, got "${alpha}"/"${beta}"`);
  return `${run.tasks.map((t) => `${t.id}:${t.agent}:${t.status}`).join(", ")} — different vendors in parallel, both files merged onto ${run.branch} · $${(run.costUsd ?? 0).toFixed(3)}`;
});

ws.close();
await d.stop();
