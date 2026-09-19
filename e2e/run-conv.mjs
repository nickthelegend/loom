/**
 * Areas D, E and A8: real agent conversations (cheap models, tiny prompts),
 * handoff, interrupt, queued prompts, the brain, and restart persistence —
 * against a real daemon. Run: node e2e/run-conv.mjs [--only D2,D3]
 */

import fs from "node:fs";
import path from "node:path";
import { Daemon, Recorder, check, expect, freshRepo, ROOT, sleep, until } from "./lib.mjs";

const only = (process.argv.find((a) => a.startsWith("--only=")) ?? "").slice(7).split(",").filter(Boolean);
const want = (id) => !only.length || only.includes(id);
const rec = new Recorder(path.join(ROOT, "e2e/results/conv.json"));
const d = new Daemon("conv");
const repo = freshRepo("conv", { "README.md": "# conv\n", "CLAUDE.md": "# Project notes\n\nThe service listens on port 7421.\n" });
await d.start();
const pid = (await d.post("/api/projects", { dir: repo })).body.project.id;
const P = `/api/projects/${pid}`;
const agents = (await d.get(P)).body.project.agents;
const byKind = (k) => agents.find((a) => a.kind === k)?.id;
// cheapest settings: claude on haiku; the others on their own defaults (OpenCode's is free)
await d.post(`${P}/agents/${byKind("claude-code")}/model`, { model: "haiku" });

async function events(since = 0) {
  return (await d.get(`${P}/events?since=${since}&limit=500`)).body.events;
}
async function lastId() {
  const e = await events(0);
  return e.length ? e[e.length - 1].id : 0;
}
/** Send and wait for this agent's reply message after `since`. */
async function ask(agentId, text, { timeoutMs = 180_000 } = {}) {
  // Only the baton holder takes a turn (409 not_holder otherwise); the UI hands
  // the baton over when you pick another agent, and so does this.
  const holder = (await d.get(P)).body.project.holder;
  if (holder && holder !== agentId) {
    const h = await d.post(`${P}/handoff`, { to: agentId });
    if (h.status !== 200) throw new Error(`handoff to ${agentId} → ${h.status} ${h.text}`);
  }
  const since = await lastId();
  const r = await d.post(`${P}/messages`, { text, agentId });
  if (r.status !== 200) throw new Error(`send → ${r.status} ${r.text}`);
  const reply = await until(
    async () => {
      const ev = await events(since);
      const done = ev.find((e) => e.agentId === agentId && (e.kind === "run_complete" || (e.kind === "status" && e.payload?.state === "idle")));
      const err = ev.find((e) => e.agentId === agentId && e.kind === "error");
      if (err && !done) throw new Error(`agent error: ${JSON.stringify(err.payload).slice(0, 300)}`);
      if (!done) return null;
      const msgs = ev.filter((e) => e.agentId === agentId && e.kind === "message" && !e.payload?.reasoning && e.payload?.role !== "user");
      return { text: msgs.map((m) => String(m.payload.text ?? "")).join("\n"), ev };
    },
    { timeoutMs, every: 1000, what: `${agentId} reply` },
  );
  const cost = reply.ev.filter((e) => e.agentId === agentId && e.kind === "status" && e.payload?.state === "turn_cost");
  return { ...reply, cost };
}

const pong = async (id, kind) => {
  const r = await ask(byKind(kind), "Reply with exactly the single word PONG and nothing else. Do not use any tools.");
  expect(/PONG/i.test(r.text), `${kind} replied PONG, got: ${r.text.slice(0, 200)}`);
  const usd = r.cost.map((c) => Number(c.payload.costUsd ?? 0)).reduce((a, b) => a + b, 0);
  return `${kind} → "${r.text.trim().slice(0, 60)}" · turn_cost events=${r.cost.length} usd=${usd.toFixed(4)} tokens=${JSON.stringify(r.cost[0]?.payload?.tokens ?? r.cost[0]?.payload?.usage ?? null).slice(0, 80)}`;
};

if (want("D1")) await check(rec, "D1", async () => {
  const c = await d.post(`${P}/chats`, { title: "e2e chat" });
  expect(c.status === 200 && c.body.chat?.id, `create, got ${c.text}`);
  const id = c.body.chat.id;
  const rn = await d.post(`${P}/chats/${id}/rename`, { title: "renamed" });
  expect(rn.status === 200 && rn.body.chat.title === "renamed", `rename, got ${rn.text}`);
  const list = (await d.get(`${P}/chats`)).body.chats;
  expect(list.some((x) => x.id === id && x.title === "renamed"), "listed renamed");
  const main = list.find((x) => x.id === "main") ?? list[0];
  const rnMain = await d.post(`${P}/chats/${main.id}/rename`, { title: "" });
  expect(rnMain.status === 400, `empty title 400, got ${rnMain.status}`);
  const delMain = await d.del(`${P}/chats/main`);
  expect(delMain.status === 400, `deleting main 400, got ${delMain.status}`);
  const keep = await d.post(`${P}/chats`, { title: "persist me" });
  const del = await d.del(`${P}/chats/${id}`);
  expect(del.status === 200, `delete 200, got ${del.status}`);
  fs.writeFileSync(path.join(d.home, "keep-chat"), keep.body.chat.id);
  return `create/rename/delete ok; main rename(empty)→${rnMain.status}, delete main→${delMain.status}`;
});

if (want("D7")) await check(rec, "D7", async () => {
  const r = await d.post(`${P}/messages`, { text: "   " });
  expect(r.status === 400 && /missing text/.test(r.text), `400 missing text, got ${r.status} ${r.text}`);
  return `${r.status} ${r.text}`;
});

if (want("D2")) await check(rec, "D2", () => pong("D2", "claude-code"));
if (want("D3")) await check(rec, "D3", () => pong("D3", "codex"));
if (want("D4a")) await check(rec, "D4a", () => pong("D4a", "opencode"));
if (want("D4b")) await check(rec, "D4b", () => pong("D4b", "grok-code"));
if (want("D4c")) await check(rec, "D4c", () => pong("D4c", "antigravity-cli"));

if (want("D5")) await check(rec, "D5", async () => {
  const secret = `ZEBRA${Math.floor(Math.random() * 9000 + 1000)}`;
  const a = await ask(byKind("claude-code"), `Remember this codeword: ${secret}. Reply with just: noted`);
  expect(/noted/i.test(a.text), `claude acknowledged, got ${a.text.slice(0, 120)}`);
  const h = await d.post(`${P}/handoff`, { to: byKind("codex") });
  expect(h.status === 200, `handoff 200, got ${h.status} ${h.text.slice(0, 200)}`);
  const holder = (await d.get(P)).body.project.holder;
  expect(holder === byKind("codex"), `baton with codex, got ${holder}`);
  const b = await ask(byKind("codex"), "What codeword did the user give earlier in this conversation? Reply with only the codeword. Do not run tools.");
  expect(b.text.includes(secret), `codex knows ${secret} from the handoff, got: ${b.text.slice(0, 200)}`);
  return `claude noted ${secret}; handoff → holder ${holder}; codex answered "${b.text.trim().slice(0, 40)}"`;
});

if (want("D6")) await check(rec, "D6", async () => {
  const id = byKind("claude-code");
  if ((await d.get(P)).body.project.holder !== id) await d.post(`${P}/handoff`, { to: id });
  const since = await lastId();
  await d.post(`${P}/messages`, { text: "Count slowly from 1 to 400, one number per line. Do not use tools.", agentId: id });
  await until(async () => (await d.get(P)).body.project.agents.find((a) => a.id === id).busy, { timeoutMs: 30_000, what: "claude busy" });
  const t0 = Date.now();
  const r = await d.post(`${P}/interrupt`);
  expect(r.status === 200, `interrupt 200, got ${r.status}`);
  await until(async () => !(await d.get(P)).body.project.agents.find((a) => a.id === id).busy, { timeoutMs: 20_000, what: "claude idle" });
  const ev = await events(since);
  return `interrupt ${r.text.slice(0, 80)}; idle after ${Date.now() - t0}ms; events ${ev.slice(-3).map((e) => `${e.kind}:${e.payload?.state ?? ""}`).join(",")}`;
});

if (want("D9")) await check(rec, "D9", async () => {
  const id = byKind("claude-code");
  if ((await d.get(P)).body.project.holder !== id) await d.post(`${P}/handoff`, { to: id });
  const since = await lastId();
  await d.post(`${P}/messages`, { text: "Reply with exactly: FIRST", agentId: id });
  const second = await d.post(`${P}/messages`, { text: "Reply with exactly: SECOND", agentId: id });
  expect(second.status === 200, `second accepted while busy, got ${second.status} ${second.text}`);
  const got = await until(
    async () => {
      const ev = (await events(since)).filter((e) => e.agentId === id && e.kind === "message" && !e.payload?.reasoning && e.payload?.role !== "user");
      const t = ev.map((e) => String(e.payload.text)).join("\n");
      return /FIRST/.test(t) && /SECOND/.test(t) ? t : null;
    },
    { timeoutMs: 240_000, every: 1500, what: "both replies" },
  );
  expect(got.indexOf("FIRST") < got.indexOf("SECOND"), "in order");
  return `second send → ${JSON.stringify(second.body).slice(0, 80)}; replies in order`;
});

if (want("D8")) await check(rec, "D8", async () => {
  const bad = await d.post(`${P}/retry`, {});
  expect(bad.status === 400, `missing agentId 400, got ${bad.status}`);
  const r = await d.post(`${P}/retry`, { agentId: byKind("opencode") });
  // retry needs a previously failed turn; with none, the product must say so, not fake a run
  if (r.status === 400) return `no failed turn to retry → 400 "${r.body.error}" (the honest answer); missing agentId → 400`;
  expect(r.status === 200, `retry 200, got ${r.status} ${r.text}`);
  return `retry → ${r.text.slice(0, 120)}`;
});

// ── the brain ──
let memId = "";
if (want("E1")) await check(rec, "E1", async () => {
  const add = await d.post(`${P}/brain`, { kind: "decision", text: "We deploy with blue-green releases." });
  expect(add.status === 200, `add 200, got ${add.status} ${add.text}`);
  memId = add.body.memory?.id ?? add.body.id;
  expect(memId, `an id, got ${add.text}`);
  let list = (await d.get(`${P}/brain`)).body.memories;
  expect(list.some((m) => m.id === memId), "listed");
  const up = await d.patch(`${P}/brain/${memId}`, { text: "We deploy with canary releases." });
  expect(up.status === 200, `update 200, got ${up.status} ${up.text}`);
  const hist = (await d.get(`${P}/brain/${memId}/history`)).body;
  expect(JSON.stringify(hist).includes("blue-green") && JSON.stringify(hist).includes("canary"), `history has both, got ${JSON.stringify(hist).slice(0, 300)}`);
  const keep = await d.post(`${P}/brain`, { kind: "fact", text: "The staging database is called stg-main." });
  fs.writeFileSync(path.join(d.home, "keep-mem"), keep.body.memory?.id ?? keep.body.id);
  const fg = await d.del(`${P}/brain/${memId}?reason=${encodeURIComponent("e2e forget")}`);
  expect(fg.status === 200, `forget 200, got ${fg.status} ${fg.text}`);
  list = (await d.get(`${P}/brain`)).body.memories;
  expect(!list.some((m) => m.id === memId), "gone from list");
  const hist2 = JSON.stringify((await d.get(`${P}/brain/${memId}/history`)).body);
  expect(/forget/i.test(hist2), `history keeps the forget, got ${hist2.slice(0, 200)}`);
  return `add/update/forget; history ${hist2.length} bytes`;
});

if (want("E3")) await check(rec, "E3", async () => {
  await d.post(`${P}/brain`, { kind: "convention", text: "We use tabs for indentation in TypeScript files." });
  await d.post(`${P}/brain`, { kind: "convention", text: "We do not use tabs for indentation in TypeScript files." });
  const c = await d.get(`${P}/brain/conflicts`);
  expect(c.status === 200 && (c.body.conflicts ?? []).length >= 1, `a conflict, got ${c.text.slice(0, 300)}`);
  return `${c.body.conflicts.length} conflict(s): ${c.body.conflicts[0].signal}`;
});

if (want("E4")) await check(rec, "E4", async () => {
  const r = await d.post(`${P}/decisions`, { text: "Feature flags live in LaunchDarkly." });
  expect(r.status === 200 && r.body.event?.kind === "decision", `decision event, got ${r.text.slice(0, 200)}`);
  const list = (await d.get(`${P}/brain`)).body.memories;
  expect(list.some((m) => m.text.includes("LaunchDarkly")), "also a memory");
  return `event ${r.body.event.id} + memory`;
});

if (want("E5")) await check(rec, "E5", async () => {
  const a = await d.post(`${P}/memory/import`);
  expect(a.status === 200, `import 200, got ${a.status} ${a.text}`);
  const b = await d.post(`${P}/memory/import`);
  const m = await d.get(`${P}/memory`);
  expect(JSON.stringify(m.body).includes("7421"), `native CLAUDE.md imported, got ${m.text.slice(0, 300)}`);
  const imports = (await events(0)).filter((e) => e.kind === "memory_import");
  expect(imports.some((e) => String(e.payload.file).endsWith("CLAUDE.md")), `a memory_import event for CLAUDE.md (done on open), got ${JSON.stringify(imports.map((e) => e.payload.file))}`);
  expect(b.body.imported === 0, "re-import is idempotent");
  return `imported on open (${imports.length} import event(s), ${imports.map((e) => path.basename(String(e.payload.file))).join(",")}); manual re-import → ${b.text}`;
});

if (want("E2")) await check(rec, "E2", async () => {
  // The fact lives only in the brain (no file says it), so the only way the
  // next agent can know it is the retrieved brief injected on handoff.
  const port = 8000 + Math.floor(Math.random() * 900);
  await d.post(`${P}/brain`, { kind: "fact", text: `The billing service listens on port ${port}.` });
  const claude = byKind("claude-code");
  if ((await d.get(P)).body.project.holder !== claude) await d.post(`${P}/handoff`, { to: claude });
  await ask(claude, "We are about to work on the billing service. Reply with just: ok");
  const h = await d.post(`${P}/handoff`, { to: byKind("codex") });
  expect(h.status === 200, `handoff 200, got ${h.status}`);
  const r = await ask(byKind("codex"), "Which port does the billing service listen on? Answer with just the number. Do not run commands or read files.");
  expect(r.text.includes(String(port)), `codex answered ${port} from the handoff brief, got: ${r.text.slice(0, 200)}`);
  return `memory "port ${port}" → handoff brief → codex answered "${r.text.trim().slice(0, 40)}"`;
});

if (want("A8")) await check(rec, "A8", async () => {
  const chats = (await d.get(`${P}/chats`)).body.chats.map((c) => c.id).sort().join(",");
  const mems = (await d.get(`${P}/brain`)).body.memories.map((m) => m.id).sort().join(",");
  await d.post("/api/prompts", { title: "e2e prompt", text: "hello" });
  const prompts = JSON.stringify((await d.get("/api/prompts")).body).length;
  const evs = (await events(0)).length;
  await d.restart();
  const chats2 = (await d.get(`${P}/chats`)).body.chats.map((c) => c.id).sort().join(",");
  const mems2 = (await d.get(`${P}/brain`)).body.memories.map((m) => m.id).sort().join(",");
  const prompts2 = JSON.stringify((await d.get("/api/prompts")).body).length;
  const evs2 = (await events(0)).length;
  expect(chats === chats2, `chats identical (${chats} vs ${chats2})`);
  expect(mems === mems2, "memories identical");
  expect(prompts === prompts2, "prompts identical");
  expect(evs2 >= evs, `events kept (${evs} → ${evs2})`);
  return `after restart: ${chats2.split(",").length} chats, ${mems2.split(",").length} memories, ${evs2} events, prompts equal`;
});

fs.writeFileSync(path.join(ROOT, "e2e/results/conv-state.json"), JSON.stringify({ home: d.home, port: d.port, pid, repo }, null, 2));
const costs = await d.get(`${P}/costs`);
console.log("costs:", costs.text.slice(0, 400));
await d.stop();
