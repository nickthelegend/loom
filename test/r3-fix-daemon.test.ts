/**
 * Daemon auth, scoping and robustness (#428): one regression per finding of the audit that
 * held up. Each describe brings up its own daemon (its own LOOM_HOME) so a listener on ::1, an
 * exposed extra listener and a mocked push endpoint never share state.
 */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { logbook } from "../src/core/logbook.js";
import { recordRecent } from "../src/core/prompts.js";
import { readDaemonConfig, registerProject } from "../src/core/registry.js";
import { parseCloudFragment, RelayClient } from "../src/core/relay-client.js";
import { unpackCredentials } from "../src/core/relay-protocol.js";
import type { AuthManager } from "../src/daemon/auth.js";
import { DaemonClient } from "../src/daemon/client.js";
import { MemoryRelayBus } from "../src/daemon/relay.js";
import type { ProjectRuntime } from "../src/daemon/runtime.js";
import { LoomDaemon } from "../src/daemon/server.js";
import { makeProjectDir, tmpDir, waitUntil } from "./helpers.js";

const H = (t: string) => ({ authorization: `Bearer ${t}`, "content-type": "application/json" });
type Inside = { auth: AuthManager; runtime(id: string): Promise<ProjectRuntime> };
const inside = (d: LoomDaemon) => d as unknown as Inside;

async function boot(name: string, host = "127.0.0.1", extra: ConstructorParameters<typeof LoomDaemon>[0] = {}) {
  process.env.LOOM_HOME = tmpDir(name);
  process.env.LOOM_NO_NOTIFY = "1";
  const daemon = new LoomDaemon({ host, port: 0, ...extra });
  const l = await daemon.listen();
  const base = `http://${l.host.includes(":") ? `[${l.host}]` : l.host}:${l.port}`;
  const admin = readDaemonConfig()!.adminToken;
  return { daemon, base, admin, port: l.port };
}

async function device(base: string, admin: string, body: Record<string, unknown>): Promise<{ token: string; id: string }> {
  const pair = await (await fetch(`${base}/api/pair/new`, { method: "POST", headers: H(admin), body: JSON.stringify(body) })).json() as { token: string };
  return claim(base, pair.token);
}
async function claim(base: string, token: string): Promise<{ token: string; id: string }> {
  const c = await (await fetch(`${base}/api/pair/claim`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token, name: "dev" }) })).json() as { clientToken: string; clientId: string };
  return { token: c.clientToken, id: c.clientId };
}

/** A socket that has said hello, and a promise of its close. */
async function socket(url: string, token: string): Promise<{ ws: WebSocket; frames: Array<Record<string, unknown>>; closed: Promise<number> }> {
  const ws = new WebSocket(url, [`loom.bearer.${token}`]);
  const frames: Array<Record<string, unknown>> = [];
  const closed = new Promise<number>((r) => ws.on("close", (code) => r(code)));
  await new Promise<void>((resolve, reject) => {
    ws.on("message", (raw) => {
      const f = JSON.parse(String(raw)) as Record<string, unknown>;
      frames.push(f);
      if (f.type === "hello") resolve();
    });
    ws.on("error", reject);
    void closed.then((code) => reject(new Error(`closed ${code} before hello`)));
  });
  return { ws, frames, closed };
}
const within = <T>(p: Promise<T>, ms: number) =>
  Promise.race([p, new Promise<"timeout">((r) => setTimeout(() => r("timeout"), ms))]);

describe("project scope on machine-wide routes (#428)", () => {
  let daemon: LoomDaemon, base: string, admin: string, a: string, b: string, scoped: string;
  beforeAll(async () => {
    ({ daemon, base, admin } = await boot("home-r3-scope"));
    const client = new DaemonClient(readDaemonConfig()!);
    a = (await client.addProject(makeProjectDir({ name: "alpha" }))).project.id;
    b = (await client.addProject(makeProjectDir({ name: "bravo" }))).project.id;
    scoped = (await device(base, admin, { projects: [a] })).token;
  });
  afterAll(async () => { await daemon.close(); });

  it("#6 a scoped token reads only its own projects' logs and cannot clear the book", async () => {
    logbook.error("agent:x", "bravo private detail", undefined, b);
    logbook.error("daemon", "daemon-wide private detail");
    logbook.error("agent:y", "alpha own detail", undefined, a);
    const all = await (await fetch(`${base}/api/logs`, { headers: H(scoped) })).json() as { logs: Array<{ message: string }> };
    const text = all.logs.map((l) => l.message).join("\n");
    expect(text).toContain("alpha own detail");
    expect(text).not.toContain("bravo private detail");
    expect(text).not.toContain("daemon-wide private detail");
    const other = await fetch(`${base}/api/logs?project=${b}`, { headers: H(scoped) });
    expect(JSON.stringify(await other.json())).not.toContain("bravo private detail");
    expect((await fetch(`${base}/api/logs`, { method: "DELETE", headers: H(scoped) })).status).toBe(403);
    // the owner still sees everything
    const owner = await (await fetch(`${base}/api/logs`, { headers: H(admin) })).json() as { logs: Array<{ message: string }> };
    expect(owner.logs.map((l) => l.message)).toContain("bravo private detail");
  });

  it("#7 a scoped token cannot read or clear the machine-wide prompt history", async () => {
    recordRecent("bravo secret prompt", { project: "bravo", mode: "chat" });
    expect((await fetch(`${base}/api/prompts`, { headers: H(scoped) })).status).toBe(403);
    expect((await fetch(`${base}/api/prompts/recent`, { method: "DELETE", headers: H(scoped) })).status).toBe(403);
    expect((await fetch(`${base}/api/prompts`, { method: "POST", headers: H(scoped), body: JSON.stringify({ text: "x" }) })).status).toBe(403);
    const owner = await (await fetch(`${base}/api/prompts`, { headers: H(admin) })).json();
    expect(JSON.stringify(owner)).toContain("bravo secret prompt");
  });

  it("#3 a scoped token cannot change or remove a provider", async () => {
    const set = await fetch(`${base}/api/providers/openai`, { method: "POST", headers: H(scoped), body: JSON.stringify({ baseUrl: "https://attacker.invalid" }) });
    expect(set.status).toBe(403);
    expect((await fetch(`${base}/api/providers/openai`, { method: "DELETE", headers: H(scoped) })).status).toBe(403);
    const list = await (await fetch(`${base}/api/providers`, { headers: H(admin) })).json();
    expect(JSON.stringify(list)).not.toContain("attacker.invalid");
    // the owner still configures providers
    const mine = await fetch(`${base}/api/providers/r3test`, { method: "POST", headers: H(admin), body: JSON.stringify({ baseUrl: "http://127.0.0.1:9/v1", label: "r3" }) });
    expect(mine.status).toBe(200);
  });

  it("#2 a scoped token cannot have the daemon take screenshots", async () => {
    const r = await fetch(`${base}/api/projects/${a}/preview/screenshot`, { method: "POST", headers: H(scoped), body: JSON.stringify({ url: `${base}/api/bootstrap` }) });
    expect(r.status).toBe(403);
    // the owner reaches the capture itself (a non-http url is refused there, not by the wall)
    const owner = await fetch(`${base}/api/projects/${a}/preview/screenshot`, { method: "POST", headers: H(admin), body: JSON.stringify({ url: "ftp://x" }) });
    expect(owner.status).toBe(400);
    expect(JSON.stringify(await owner.json())).toContain("http(s)");
  });

  it("#1 an alert webhook without a secret is refused when it was relayed, even on loopback", async () => {
    const body = JSON.stringify({ status: "firing", alerts: [{ labels: { "loom.project": "alpha", agent: "plannerbot" } }] });
    const relayed = await fetch(`${base}/api/webhooks/alerts`, { method: "POST", headers: { "content-type": "application/json", "x-loom-via": "relay" }, body });
    expect(relayed.status).toBe(401);
    // a same-machine sender still works without one
    const local = await fetch(`${base}/api/webhooks/alerts`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ status: "resolved", alerts: [{ labels: { "loom.project": "alpha", agent: "plannerbot" } }] }) });
    expect(local.status).toBe(200);
  });
});

describe("files and previews (#428)", () => {
  let daemon: LoomDaemon, base: string, admin: string, id: string, dir: string;
  beforeAll(async () => {
    ({ daemon, base, admin } = await boot("home-r3-files"));
    dir = makeProjectDir({ name: "files" });
    id = (await new DaemonClient(readDaemonConfig()!).addProject(dir)).project.id;
  });
  afterAll(async () => { await daemon.close(); });

  it("#8 an attachment write does not follow a symlinked folder out of the project", async () => {
    const outside = tmpDir("r3-outside");
    fs.mkdirSync(path.join(dir, ".loom"), { recursive: true });
    fs.rmSync(path.join(dir, ".loom", "attachments"), { recursive: true, force: true });
    fs.symlinkSync(outside, path.join(dir, ".loom", "attachments"));
    try {
      const r = await fetch(`${base}/api/projects/${id}/attachments`, {
        method: "POST", headers: H(admin),
        body: JSON.stringify({ name: "a.txt", dataUrl: `data:text/plain;base64,${Buffer.from(`r3 ${Date.now()}`).toString("base64")}` }),
      });
      expect(r.status).toBe(400);
      expect(fs.readdirSync(outside)).toEqual([]);
    } finally {
      fs.rmSync(path.join(dir, ".loom", "attachments"));
    }
    // a dangling final-component link is refused too
    const target = path.join(tmpDir("r3-outside2"), "landed.txt");
    const data = Buffer.from("dangling");
    const hash = (await import("node:crypto")).createHash("sha1").update(data).digest("hex").slice(0, 12);
    fs.mkdirSync(path.join(dir, ".loom", "attachments"), { recursive: true });
    fs.symlinkSync(target, path.join(dir, ".loom", "attachments", `${hash}.txt`));
    const r2 = await fetch(`${base}/api/projects/${id}/attachments`, {
      method: "POST", headers: H(admin), body: JSON.stringify({ name: "b.txt", dataUrl: `data:text/plain;base64,${data.toString("base64")}` }),
    });
    expect(r2.status).toBe(400);
    expect(fs.existsSync(target)).toBe(false);
    // and an ordinary attachment still lands
    const ok = await fetch(`${base}/api/projects/${id}/attachments`, {
      method: "POST", headers: H(admin), body: JSON.stringify({ name: "c.txt", dataUrl: `data:text/plain;base64,${Buffer.from("fine").toString("base64")}` }),
    });
    expect(ok.status).toBe(200);
  });

  it("#10 reading an empty file answers with empty content", async () => {
    fs.writeFileSync(path.join(dir, "empty.txt"), "");
    const r = await within(fetch(`${base}/api/projects/${id}/file?path=empty.txt`, { headers: H(admin) }), 3000);
    expect(r).not.toBe("timeout");
    const res = r as Response;
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ content: "", size: 0, truncated: false });
  });

  it("#13 a directory preview's URL serves its index.html", async () => {
    fs.mkdirSync(path.join(dir, "site"), { recursive: true });
    fs.writeFileSync(path.join(dir, "site", "index.html"), "<h1>r3 site</h1>");
    const minted = await (await fetch(`${base}/api/projects/${id}/preview`, { method: "POST", headers: H(admin), body: JSON.stringify({ path: "site" }) })).json() as { url: string };
    expect(minted.url).toMatch(/\/$/);
    const page = await fetch(base + minted.url);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("r3 site");
  });
});

describe("runtimes (#428)", () => {
  let daemon: LoomDaemon;
  beforeAll(async () => { ({ daemon } = await boot("home-r3-runtime")); });
  afterAll(async () => { await daemon.close(); });

  it("#9 concurrent first opens share one runtime", async () => {
    const info = registerProject(makeProjectDir({ name: "cold" }), "cold");
    const [x, y] = await Promise.all([inside(daemon).runtime(info.id), inside(daemon).runtime(info.id)]);
    expect(x).toBe(y);
  });
});

describe("sockets keep to their credential (#428)", () => {
  let daemon: LoomDaemon, base: string, admin: string, port: number, id: string;
  beforeAll(async () => {
    ({ daemon, base, admin, port } = await boot("home-r3-ws"));
    id = (await new DaemonClient(readDaemonConfig()!).addProject(makeProjectDir({ name: "sock" }))).project.id;
  });
  afterAll(async () => { await daemon.close(); });

  it("#4 revoking a device closes its open sockets", async () => {
    const phone = await device(base, admin, {});
    const s = await socket(`ws://127.0.0.1:${port}/ws?project=${id}`, phone.token);
    const del = await fetch(`${base}/api/pair/clients/${phone.id}`, { method: "DELETE", headers: H(admin) });
    expect(del.status).toBe(200);
    expect(await within(s.closed, 3000)).not.toBe("timeout");
  });

  it("#4 a guest's socket ends when its link expires", async () => {
    const minted = inside(daemon).auth.newPairingToken([id], { guest: { project: id, chat: "main", role: "view", name: "g", expiresAt: Date.now() + 1500 } });
    const guest = await claim(base, minted.token);
    const s = await socket(`ws://127.0.0.1:${port}/ws?project=${id}`, guest.token);
    expect(await within(s.closed, 5000)).not.toBe("timeout");
  });

  it("#4 a socket that stays open keeps working for a device still paired", async () => {
    const phone = await device(base, admin, {});
    const s = await socket(`ws://127.0.0.1:${port}/ws?project=${id}`, phone.token);
    const rt = await inside(daemon).runtime(id);
    rt.log.append({ kind: "status", payload: { state: "r3-ping" } });
    await waitUntil(() => s.frames.some((f) => f.type === "event" && JSON.stringify(f).includes("r3-ping")), { timeoutMs: 3000 });
    s.ws.close();
  });
});

describe("push follows project scope (#428)", () => {
  let daemon: LoomDaemon, base: string, admin: string, a: string, b: string, mock: http.Server;
  const delivered: Array<{ to: string; data?: { projectId?: string } }> = [];
  beforeAll(async () => {
    delete process.env.LOOM_NO_PUSH;
    mock = http.createServer((req, res) => {
      let body = "";
      req.on("data", (d) => (body += d));
      req.on("end", () => {
        try { delivered.push(...(JSON.parse(body) as typeof delivered)); } catch { /* ignore */ }
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ data: [] }));
      });
    });
    await new Promise<void>((r) => mock.listen(0, "127.0.0.1", r));
    process.env.LOOM_EXPO_PUSH_URL = `http://127.0.0.1:${(mock.address() as { port: number }).port}/push`;
    ({ daemon, base, admin } = await boot("home-r3-push"));
    const client = new DaemonClient(readDaemonConfig()!);
    a = (await client.addProject(makeProjectDir({ name: "pa" }))).project.id;
    b = (await client.addProject(makeProjectDir({ name: "pb" }))).project.id;
    const scoped = await device(base, admin, { projects: [a] });
    const phone = await device(base, admin, {});
    for (const [t, push] of [[scoped.token, "ExponentPushToken[scoped-a]"], [phone.token, "ExponentPushToken[owner]"]] as const) {
      const r = await fetch(`${base}/api/push/register`, { method: "POST", headers: H(t), body: JSON.stringify({ token: push }) });
      expect(r.status).toBe(200);
    }
  });
  afterAll(async () => {
    await daemon.close();
    mock.close();
    delete process.env.LOOM_EXPO_PUSH_URL;
  });

  it("#5 a device scoped to one project gets no push for another", async () => {
    (await inside(daemon).runtime(b)).log.append({ kind: "needs_input", agentId: "plannerbot", payload: { question: "bravo secret?" } });
    await waitUntil(() => delivered.some((d) => d.data?.projectId === b));
    expect(delivered.filter((d) => d.data?.projectId === b).map((d) => d.to)).toEqual(["ExponentPushToken[owner]"]);
    (await inside(daemon).runtime(a)).log.append({ kind: "needs_input", agentId: "plannerbot", payload: { question: "alpha?" } });
    await waitUntil(() => delivered.some((d) => d.data?.projectId === a));
    expect(delivered.filter((d) => d.data?.projectId === a).map((d) => d.to).sort()).toEqual(["ExponentPushToken[owner]", "ExponentPushToken[scoped-a]"]);
  });
});

describe("listeners (#428)", () => {
  it("#11 close() ends sockets on an extra listener instead of waiting on them", async () => {
    const { daemon, admin, port } = await boot("home-r3-extra");
    await daemon.expose("::1");
    const s = await socket(`ws://[::1]:${port}/ws`, admin);
    const done = await within(daemon.close(), 4000);
    expect(done).not.toBe("timeout");
    expect(await within(s.closed, 1000)).not.toBe("timeout");
  });

  describe("a daemon bound to one address that isn't 127.0.0.1 (::1 here, as a tailnet IP would be)", () => {
    let daemon: LoomDaemon, base: string, admin: string, port: number;
    const bus = new MemoryRelayBus();
    beforeAll(async () => {
      process.env.LOOM_SUPABASE_URL = "https://example.supabase.co";
      process.env.LOOM_SUPABASE_ANON_KEY = "anon-test-key";
      ({ daemon, base, admin, port } = await boot("home-r3-v6", "::1", { relayTransport: async () => bus.connect() }));
    });
    afterAll(async () => {
      await daemon.close();
      delete process.env.LOOM_SUPABASE_URL;
      delete process.env.LOOM_SUPABASE_ANON_KEY;
    });

    it("#12 accepts WebSocket connections on an IPv6 listener", async () => {
      const s = await socket(`ws://[::1]:${port}/ws`, admin);
      expect(s.frames[0]).toMatchObject({ type: "hello" });
      s.ws.close();
    });

    it("#14 the cloud relay forwards to the address the daemon listens on", async () => {
      const enabled = await (await fetch(`${base}/api/cloud/enable`, { method: "POST", headers: H(admin) })).json() as { connected?: boolean };
      expect(enabled.connected).toBe(true);
      const pair = await (await fetch(`${base}/api/pair/new`, { method: "POST", headers: H(admin), body: "{}" })).json() as { link: string };
      const creds = unpackCredentials(parseCloudFragment(pair.link.split("#")[1]!)!.relay)!;
      const phone = new RelayClient(bus.connect(), creds);
      try {
        const r = await phone.request("GET", "/api/projects", { auth: `Bearer ${admin}` });
        expect(r.status).toBe(200);
      } finally {
        await phone.close();
      }
    });
  });
});
