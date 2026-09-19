/**
 * Areas A–C: daemon, auth, first run, projects, agents — against a real daemon
 * from dist/ in a fresh LOOM_HOME. Run: node e2e/run-core.mjs
 */

import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { Daemon, Recorder, check, expect, freshRepo, ROOT } from "./lib.mjs";

const rec = new Recorder(path.join(ROOT, "e2e/results/core.json"));
const d = new Daemon("core");
const pkgVersion = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version;
const repo = freshRepo("core", { "README.md": "# core\n", "src/app.js": "export const x = 1;\n", "CLAUDE.md": "# Notes\n\nThe service listens on port 7421.\n" });
const repo2 = freshRepo("core2");
let pid = "";
let pid2 = "";

await d.start();

await check(rec, "A1", async () => {
  const h = await d.get("/api/health", null);
  expect(h.status === 200 && h.body.ok === true && h.body.name === "loom", `health 200 ok, got ${h.status} ${h.text}`);
  expect(h.body.version === pkgVersion, `version ${pkgVersion}, got ${h.body.version}`);
  const cfgPath = path.join(d.home, "daemon.json");
  const st = fs.statSync(cfgPath);
  expect(/^[0-9a-f]{64}$/.test(d.admin), "64-hex admin token");
  expect((st.mode & 0o777) === 0o600, `daemon.json mode 0600, got ${(st.mode & 0o777).toString(8)}`);
  return `health=${h.text}; daemon.json mode=${(st.mode & 0o777).toString(8)}`;
});

await check(rec, "A2", async () => {
  const a = await d.get("/api/projects", null);
  const b = await d.get("/api/projects", "not-a-token");
  expect(a.status === 401 && b.status === 401, `401/401, got ${a.status}/${b.status}`);
  return `no token → ${a.status}, wrong token → ${b.status}`;
});

await check(rec, "A3", async () => {
  const ok = await fetch(`${d.base}/api/bootstrap`);
  const okBody = await ok.json();
  // fetch drops a custom Host header; a raw request sends it as a DNS-rebinding page would
  const evil = await new Promise((r) => http.get({ host: "127.0.0.1", port: d.port, path: "/api/bootstrap", headers: { host: "evil.example" } }, (res) => { res.resume(); r({ status: res.statusCode }); }));
  const relay = await fetch(`${d.base}/api/bootstrap`, { headers: { "x-loom-via": "relay" } });
  expect(ok.status === 200 && okBody.token === d.admin && okBody.admin === true, `loopback 200 with admin token, got ${ok.status}`);
  expect(evil.status === 403, `evil host 403, got ${evil.status}`);
  expect(relay.status === 403, `relay 403, got ${relay.status}`);
  return `loopback 200 admin, Host evil → ${evil.status}, x-loom-via → ${relay.status}`;
});

await check(rec, "A4", async () => {
  const v = await d.get("/api/version");
  const u = await d.get("/api/updates");
  expect(v.status === 200 && v.body.rev && v.body.node && v.body.platform, `version fields, got ${v.text}`);
  expect(u.status === 200 && u.body.version === pkgVersion, `updates version ${pkgVersion}, got ${u.text}`);
  return `version ${v.text.slice(0, 120)} · updates.version=${u.body.version}`;
});

// projects first (A5/A6 need them)
await check(rec, "B1", async () => {
  const r = await d.post("/api/projects", { dir: repo });
  expect(r.status === 200 && r.body.project?.id, `200 with project, got ${r.status} ${r.text.slice(0, 200)}`);
  pid = r.body.project.id;
  const cfg = JSON.parse(fs.readFileSync(path.join(repo, ".loom", "config.json"), "utf8"));
  const kinds = cfg.agents.map((a) => a.kind);
  const want = ["claude-code", "codex", "opencode", "grok-code", "antigravity-cli"];
  const missing = want.filter((k) => !kinds.includes(k));
  expect(!missing.length, `every installed CLI detected; missing ${missing.join(",")} (have ${kinds.join(",")})`);
  return `project ${pid}; agents ${kinds.join(",")}`;
});

await check(rec, "B2", async () => {
  const before = (await d.get("/api/projects")).body.projects.length;
  const r = await d.post("/api/projects", { dir: "/nonexistent/loom-e2e" });
  const after = (await d.get("/api/projects")).body.projects.length;
  expect(r.status >= 400 && r.status < 500 && r.body?.error, `4xx with error, got ${r.status} ${r.text}`);
  expect(before === after, "nothing registered");
  return `${r.status} ${r.body.error}`;
});

await check(rec, "B3", async () => {
  const l = await d.get("/api/projects");
  expect(l.body.projects.some((p) => p.id === pid), "listed");
  const s = await d.get(`/api/projects/${pid}`);
  expect(s.status === 200 && Array.isArray(s.body.project?.agents) && s.body.project.agents.length >= 5, `status with agents, got ${s.status}`);
  return `${s.body.project.agents.length} agents; holder=${JSON.stringify(s.body.project.holder)}`;
});

await check(rec, "B4", async () => {
  const r = await d.get("/api/projects/nope-nope/board");
  expect(r.status === 404, `404, got ${r.status} ${r.text}`);
  return `${r.status} ${r.text.slice(0, 100)}`;
});

await check(rec, "B5", async () => {
  const g = await d.get(`/api/projects/${pid}/config`);
  expect(g.status === 200, `get config 200, got ${g.status}`);
  const p = await d.patch(`/api/projects/${pid}/config`, { projection: { mode: "template" } });
  expect(p.status === 200, `patch 200, got ${p.status} ${p.text.slice(0, 200)}`);
  const onDisk = JSON.parse(fs.readFileSync(path.join(repo, ".loom", "config.json"), "utf8"));
  expect(onDisk.projection?.mode === "template", `persisted projection.mode=template, got ${JSON.stringify(onDisk.projection)}`);
  const again = await d.get(`/api/projects/${pid}/config`);
  expect(again.body.config?.projection?.mode === "template" || again.body.projection?.mode === "template", `re-read equals, got ${again.text.slice(0, 200)}`);
  return "projection.mode=template round-trips and is on disk";
});

await check(rec, "C1", async () => {
  const r = await d.get(`/api/projects/${pid}`);
  r.body.agents = r.body.project.agents;
  const unavailable = r.body.agents.filter((a) => a.tier === "adapter" && !a.available).map((a) => a.id);
  expect(!unavailable.length, `installed adapters available; not: ${unavailable.join(",")}`);
  return r.body.agents.map((a) => `${a.id}:${a.kind}:${a.available ? "up" : "down"}`).join(" ");
});

await check(rec, "C2", async () => {
  const add = await d.post(`/api/projects/${pid}/agents`, { kind: "claude-code", id: "claude2" });
  expect(add.status === 200, `add 200, got ${add.status} ${add.text}`);
  let s = await d.get(`/api/projects/${pid}`);
  expect(s.body.project.agents.some((a) => a.id === "claude2"), "claude2 listed");
  const rm = await d.del(`/api/projects/${pid}/agents/claude2`);
  expect(rm.status === 200, `remove 200, got ${rm.status}`);
  s = await d.get(`/api/projects/${pid}`);
  expect(!s.body.project.agents.some((a) => a.id === "claude2"), "claude2 gone");
  const bad = await d.post(`/api/projects/${pid}/agents`, { kind: "not-an-agent" });
  expect(bad.status === 400, `invalid kind 400, got ${bad.status}`);
  return `add→listed, remove→gone, invalid kind→${bad.status} ${bad.body.error}`;
});

await check(rec, "C3", async () => {
  const claude = (await d.get(`/api/projects/${pid}`)).body.project.agents.find((a) => a.kind === "claude-code");
  const m = await d.post(`/api/projects/${pid}/agents/${claude.id}/model`, { model: "haiku" });
  expect(m.status === 200 && m.body.agent?.options?.model === "haiku", `model set, got ${m.text}`);
  const shown = (await d.get(`/api/projects/${pid}`)).body.project.agents.find((a) => a.id === claude.id);
  expect(shown.model === "haiku", `status shows model haiku, got ${shown.model}`);
  const onDisk = JSON.parse(fs.readFileSync(path.join(repo, ".loom", "config.json"), "utf8"));
  const cfg = onDisk.agents.find((a) => a.id === claude.id);
  expect(cfg.model === "haiku" || cfg.options?.model === "haiku", `persisted, got ${JSON.stringify(cfg)}`);
  const list = await d.get(`/api/projects/${pid}/agents/${claude.id}/models`);
  expect(list.status === 200, `models list 200, got ${list.status}`);
  return `claude model=haiku persisted; models source=${list.body.source ?? "?"} n=${(list.body.models ?? []).length} (turn-level use verified in D2)`;
});

await check(rec, "C4", async () => {
  const profiles = await d.get("/api/permissions");
  expect(profiles.status === 200 && profiles.body.profiles, "profiles listed");
  const agents = (await d.get(`/api/projects/${pid}`)).body.project.agents.filter((a) => a.tier === "adapter");
  const out = [];
  for (const a of agents) {
    for (const mode of ["bypass", "auto", "ask"]) {
      const r = await d.post(`/api/projects/${pid}/agents/${a.id}/permissions`, { permissions: mode });
      out.push(`${a.kind}:${mode}=${r.status}`);
    }
  }
  const bad = await d.post(`/api/projects/${pid}/agents/${agents[0].id}/permissions`, { permissions: "yolo" });
  expect(bad.status === 400, `invalid mode 400, got ${bad.status}`);
  await d.post(`/api/projects/${pid}/agents/${agents[0].id}/permissions`, { permissions: "bypass" });
  const onDisk = JSON.parse(fs.readFileSync(path.join(repo, ".loom", "config.json"), "utf8"));
  const cfg = onDisk.agents.find((a) => a.id === agents[0].id);
  expect(JSON.stringify(cfg).includes("bypass"), `bypass persisted, got ${JSON.stringify(cfg)}`);
  return `${out.join(" ")} · invalid→400`;
});

await check(rec, "C5", async () => {
  const a = (await d.get(`/api/projects/${pid}`)).body.project.agents.find((x) => x.kind === "grok-code");
  const off = await d.req("PUT", `/api/projects/${pid}/agents/${a.id}/enabled`, { enabled: false });
  expect(off.status === 200, `disable 200, got ${off.status} ${off.text}`);
  const s1 = (await d.get(`/api/projects/${pid}`)).body.project.agents.find((x) => x.id === a.id);
  const on = await d.req("PUT", `/api/projects/${pid}/agents/${a.id}/enabled`, { enabled: true });
  const s2 = (await d.get(`/api/projects/${pid}`)).body.project.agents.find((x) => x.id === a.id);
  expect(on.status === 200, "enable 200");
  expect(s1?.enabled === false || !s1, `disabled reflected, got ${JSON.stringify(s1)}`);
  expect(s2?.enabled !== false, `enabled reflected, got ${JSON.stringify(s2)}`);
  return `disabled → ${JSON.stringify(s1?.enabled)}, enabled → ${JSON.stringify(s2?.enabled)}`;
});

// A5/A6/A7 pairing
let clientToken = "";
let clientId = "";
await check(rec, "A5", async () => {
  const n = await d.post("/api/pair/new", {});
  expect(n.status === 200 && n.body.token && n.body.link, `pair/new, got ${n.status} ${n.text.slice(0, 200)}`);
  const c = await d.post("/api/pair/claim", { token: n.body.token, name: "e2e-phone" }, null);
  expect(c.status === 200, `claim 200, got ${c.status} ${c.text}`);
  clientToken = c.body.token ?? c.body.clientToken;
  clientId = c.body.id ?? c.body.clientId;
  expect(clientToken, `a client token, got ${c.text}`);
  const use = await d.get("/api/projects", clientToken);
  expect(use.status === 200, `client token works, got ${use.status}`);
  const again = await d.post("/api/pair/claim", { token: n.body.token, name: "x" }, null);
  expect(again.status === 403, `second claim 403, got ${again.status}`);
  const notAdmin = await d.post("/api/pair/new", {}, clientToken);
  expect(notAdmin.status === 403, `client can't mint, got ${notAdmin.status}`);
  const cfg = JSON.parse(fs.readFileSync(path.join(d.home, "daemon.json"), "utf8"));
  expect(cfg.clients.some((x) => x.name === "e2e-phone"), "client recorded");
  return `claim→token, reuse→403, client mint→403, recorded in daemon.json; link=${n.body.link.replace(/#.*/, "#…")}`;
});

await check(rec, "A6", async () => {
  pid2 = (await d.post("/api/projects", { dir: repo2 })).body.project.id;
  const n = await d.post("/api/pair/new", { projects: [pid] });
  expect(n.status === 200, `scoped pair/new 200, got ${n.status} ${n.text}`);
  const c = await d.post("/api/pair/claim", { token: n.body.token, name: "scoped" }, null);
  const t = c.body.token ?? c.body.clientToken;
  const list = await d.get("/api/projects", t);
  const ids = (list.body.projects ?? []).map((p) => p.id);
  const other = await d.get(`/api/projects/${pid2}/board`, t);
  const own = await d.get(`/api/projects/${pid}/board`, t);
  expect(ids.includes(pid) && !ids.includes(pid2), `sees only its project, got ${ids.join(",")}`);
  expect(other.status === 403 || other.status === 404, `other project refused, got ${other.status}`);
  expect(own.status === 200, `own project ok, got ${own.status}`);
  return `lists [${ids.join(",")}], other → ${other.status}, own → ${own.status}`;
});

await check(rec, "A7", async () => {
  const list = await d.get("/api/pair/clients");
  const c = (list.body.clients ?? []).find((x) => x.name === "e2e-phone");
  expect(c, `client listed, got ${list.text.slice(0, 200)}`);
  const del = await d.del(`/api/pair/clients/${c.id}`);
  expect(del.status === 200, `delete 200, got ${del.status}`);
  const use = await d.get("/api/projects", clientToken);
  expect(use.status === 401, `revoked token 401, got ${use.status}`);
  return `revoked ${c.id}; its token → ${use.status}`;
});

await check(rec, "A9", async () => {
  const doc = await d.get("/api/doctor");
  expect(doc.status === 200, `doctor 200, got ${doc.status}`);
  const setup = await d.get("/api/setup");
  expect(setup.status === 200, `setup 200, got ${setup.status}`);
  let out = "";
  try {
    out = d.cli(["doctor"], { cwd: repo });
  } catch (e) {
    out = String(e.stdout ?? "") + String(e.stderr ?? "");
    throw new Error(`loom doctor exited non-zero:\n${out.slice(-600)}`);
  }
  for (const k of ["claude", "codex", "opencode", "grok"]) expect(new RegExp(k, "i").test(out), `doctor names ${k}`);
  return out.split("\n").slice(0, 12).join(" | ");
});

// B6 last (removes the second project)
await check(rec, "B6", async () => {
  const before = fs.readdirSync(repo2).sort().join(",");
  const r = await d.del(`/api/projects/${pid2}`);
  expect(r.status === 200, `delete 200, got ${r.status} ${r.text}`);
  const list = (await d.get("/api/projects")).body.projects.map((p) => p.id);
  expect(!list.includes(pid2), "unlisted");
  const after = fs.readdirSync(repo2).sort().join(",");
  expect(before === after, `repo files untouched (${before} vs ${after})`);
  return `removed; files untouched: ${after}`;
});

fs.writeFileSync(path.join(ROOT, "e2e/results/core-state.json"), JSON.stringify({ home: d.home, port: d.port, pid, repo }, null, 2));
await d.stop();
