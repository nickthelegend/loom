/**
 * Area K: the phone's connection — push registration, and Loom Cloud over the
 * real Supabase Realtime (the hosted project), driven with the same relay
 * client the phone app uses. Run: node e2e/run-phone.mjs
 */

import fs from "node:fs";
import path from "node:path";
import { Blocked, Daemon, Recorder, check, expect, freshRepo, ROOT, until } from "./lib.mjs";

const rec = new Recorder(path.join(ROOT, "e2e/results/phone.json"));
const env = Object.fromEntries(
  fs.readFileSync(path.join(ROOT, ".env"), "utf8").split("\n").filter((l) => l.includes("=")).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
);
const { RelayClient, parseCloudFragment } = await import(path.join(ROOT, "dist/core/relay-client.js"));
const { unpackCredentials } = await import(path.join(ROOT, "dist/core/relay-protocol.js"));
const { supabaseTransport } = await import(path.join(ROOT, "dist/daemon/relay.js"));

const d = new Daemon("phone");
await d.start();
const pid = (await d.post("/api/projects", { dir: freshRepo("phone") })).body.project.id;

await check(rec, "K1", async () => {
  const n = await d.post("/api/pair/new", {});
  const c = await d.post("/api/pair/claim", { token: n.body.token, name: "e2e-phone" }, null);
  const tok = c.body.clientToken;
  expect(tok, `a client token, got ${c.text}`);
  const adminTry = await d.post("/api/push/register", { token: "ExponentPushToken[e2e-test]" });
  expect(adminTry.status === 403, `admin (not a device) refused, got ${adminTry.status}`);
  const empty = await d.post("/api/push/register", { token: " " }, tok);
  expect(empty.status === 400, `empty token 400, got ${empty.status}`);
  const r = await d.post("/api/push/register", { token: "ExponentPushToken[e2e-test]", platform: "android" }, tok);
  expect(r.status === 200 && r.body.registered === true, `register 200, got ${r.status} ${r.text}`);
  let cfg = JSON.parse(fs.readFileSync(path.join(d.home, "daemon.json"), "utf8"));
  expect(cfg.clients.find((x) => x.name === "e2e-phone")?.pushToken === "ExponentPushToken[e2e-test]", "stored on the device record");
  const del = await d.del("/api/push/register", tok);
  expect(del.status === 200 && del.body.registered === false, `unregister, got ${del.text}`);
  cfg = JSON.parse(fs.readFileSync(path.join(d.home, "daemon.json"), "utf8"));
  expect(!cfg.clients.find((x) => x.name === "e2e-phone")?.pushToken, "removed");
  return "device-only; empty→400; stored on the client record; removed on DELETE (delivery to a phone: see N6)";
});

await check(rec, "K2", async () => {
  if (!env.SUPABASE_URL || !env.SUPABASE_PUBLISHABLE_KEY) throw new Blocked("no Supabase URL/key in .env");
  const en = await d.post("/api/cloud/enable", { supabaseUrl: env.SUPABASE_URL, anonKey: env.SUPABASE_PUBLISHABLE_KEY });
  expect(en.status === 200, `enable 200, got ${en.status} ${en.text.slice(0, 300)}`);
  const st = await until(async () => {
    const s = (await d.get("/api/cloud")).body;
    return s.connected ? s : null;
  }, { timeoutMs: 30_000, what: "cloud connected" });
  const n = await d.post("/api/pair/new", {});
  const frag = n.body.link.slice(n.body.link.indexOf("#") + 1);
  const cloud = parseCloudFragment(frag);
  expect(cloud, `the pairing link carries the cloud part, got ${n.body.link.replace(/#.*/, "#…")}`);
  const creds = unpackCredentials(cloud.relay);
  const pairToken = new URLSearchParams(frag).get("pair");
  const transport = await supabaseTransport(cloud.supabaseUrl, cloud.anonKey, creds.channel);
  await transport.ready(); // the phone waits for its channel before speaking, as this does
  const phone = new RelayClient(transport, creds);
  const ms = await phone.ping(15_000);
  expect(ms !== null, "the daemon answers a ping over the relay");
  const claim = await phone.request("POST", "/api/pair/claim", { body: { token: pairToken, name: "relay-phone" }, timeoutMs: 20_000 });
  expect(claim.status === 200 && claim.body.clientToken, `claim over the relay, got ${claim.status} ${JSON.stringify(claim.body).slice(0, 200)}`);
  const auth = `Bearer ${claim.body.clientToken}`; // the protocol carries the header value, as the phone sends it
  const list = await phone.request("GET", "/api/projects", { auth, timeoutMs: 20_000 });
  expect(list.status === 200 && list.body.projects.some((p) => p.id === pid), `projects over the relay, got ${list.status}`);
  const boot = await phone.request("GET", "/api/bootstrap", { auth, timeoutMs: 20_000 });
  expect(boot.status === 403, `bootstrap refused over the relay, got ${boot.status}`);
  const noAuth = await phone.request("GET", "/api/projects", { timeoutMs: 20_000 });
  expect(noAuth.status === 401, `no token → 401 over the relay, got ${noAuth.status}`);
  await phone.close();
  await d.post("/api/cloud/disable", {});
  return `connected via ${st.supabaseUrl}; ping ${ms}ms; claim over relay → token; /api/projects 200 (${list.body.projects.length}); /api/bootstrap → 403; no token → 401 (all end-to-end encrypted through Supabase Realtime)`;
});

await d.stop();
