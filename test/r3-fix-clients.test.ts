/**
 * Round 3 client fixes (#430): the web app, the CLI and the relay client.
 *
 * Each block reproduces one audit finding: it failed before its fix. The web
 * ones run the real APP_HTML in jsdom against a real daemon on an ephemeral
 * port (the harness from app-orchestra-dom.test.ts, trimmed); the CLI ones run
 * the real CLI against that daemon. Agents are `echo` — no agent CLI runs.
 */

import { execFile, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { render } from "ink";
import { JSDOM, VirtualConsole } from "jsdom";
import WebSocket from "ws";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { readDaemonConfig } from "../src/core/registry.js";
import { RelayClient } from "../src/core/relay-client.js";
import { encodeMessage, fromB64, newRelayCredentials, RelayDecoder, type RelayMessage, type RelayTransport } from "../src/core/relay-protocol.js";
import { sentTurnOutcome } from "../src/core/turn-wait.js";
import { followRoute } from "../src/cli/route-follow.js";
import { App as TuiApp } from "../src/cli/tui.js";
import { APP_HTML } from "../src/daemon/app-page.js";
import { DaemonClient } from "../src/daemon/client.js";
import { LoomDaemon } from "../src/daemon/server.js";
import type { LoomEvent, ProjectStatus, RouteState } from "../src/types.js";
import { makeProjectDir, tmpDir, waitUntil } from "./helpers.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(root, "src", "cli", "index.ts");

/** A folder name that is a command when a shell reads it as syntax. */
const EVIL_DIR = "$(printf LOOM_QUOTING_PROOF >&2)";
const EVIL_AVATAR = 'data:image/png;base64,x" onerror="window.__pwned=1';
const GOOD_AVATAR = "data:image/png;base64,iVBORw0KGgo=";

let daemon: LoomDaemon;
let admin: DaemonClient;
let baseUrl: string;
let clientToken: string;
let webId: string;
let webDir: string;
let cliDir: string;
let routeDir: string;
let routeId: string;
let cliId: string;

beforeAll(async () => {
  process.env.LOOM_HOME = tmpDir("home-r3-clients");
  process.env.LOOM_NO_NOTIFY = "1";
  daemon = new LoomDaemon({ host: "127.0.0.1", port: 0 });
  const { host, port } = await daemon.listen();
  baseUrl = `http://${host}:${port}`;
  admin = new DaemonClient(readDaemonConfig()!);

  webDir = makeProjectDir({
    name: "r3web",
    agents: [
      { id: "plannerbot", kind: "echo", role: "planner", avatar: EVIL_AVATAR },
      { id: "execbot", kind: "echo", role: "executor", avatar: GOOD_AVATAR },
    ],
  } as never);
  const git = (...a: string[]) => execFileSync("git", a, { cwd: webDir });
  git("init", "-q");
  fs.writeFileSync(path.join(webDir, ".gitignore"), ".loom/\n");
  fs.writeFileSync(path.join(webDir, "README.md"), "# r3web\n");
  git("add", "-A");
  git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "seed");
  // Windows forbids ">" in a folder name; the quoting test below is about POSIX shells anyway
  if (process.platform !== "win32") {
    fs.mkdirSync(path.join(webDir, EVIL_DIR));
    fs.writeFileSync(path.join(webDir, EVIL_DIR, "x.txt"), "x\n");
  }
  webId = (await admin.addProject(webDir)).project.id;

  cliDir = makeProjectDir({ name: "r3cli", agents: [{ id: "solo", kind: "echo" }] });
  cliId = (await admin.addProject(cliDir)).project.id;
  routeDir = makeProjectDir({ name: "r3route", agents: [{ id: "capped", kind: "echo" }] });
  routeId = (await admin.addProject(routeDir)).project.id;

  const { token } = await admin.newPairingToken();
  const claim = await fetch(`${baseUrl}/api/pair/claim`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token, name: "jsdom" }),
  });
  clientToken = ((await claim.json()) as { clientToken: string }).clientToken;
}, 30_000);

afterAll(async () => {
  await daemon.close();
});

function runCli(args: string[], cwd: string, killMs = 30_000): Promise<{ out: string; err: string; code: number | string }> {
  return new Promise((resolve) => {
    execFile(process.execPath, [path.join(root, "node_modules", "tsx", "dist", "cli.mjs"), cli, ...args],
      { cwd, timeout: killMs, env: { ...process.env, NO_COLOR: "1", OPENROUTER_API_KEY: "" } }, (err, stdout, stderr) =>
        resolve({ out: stdout, err: stderr, code: err ? ((err as { killed?: boolean }).killed ? "killed" : ((err as { code?: number }).code ?? 1)) : 0 }));
  });
}

// ---------------------------------------------------------------------------
// jsdom harness (trimmed from app-orchestra-dom.test.ts)
// ---------------------------------------------------------------------------

interface Mounted {
  window: JSDOM["window"];
  errors: string[];
  /** Bodies POSTed to /term/input — the line typed into the shell. */
  termInput: string[];
  /** How many /tree answers the page has had (the Source Control poll). */
  treeLoads: () => number;
  close: () => void;
}

const live: Mounted[] = [];
afterEach(() => {
  while (live.length) live.pop()!.close();
});

/**
 * Boot the desktop app. Terminal endpoints are answered here, never by the
 * daemon: no shell is spawned. `rewrite` edits a JSON answer before the page
 * sees it.
 */
function mount(hash: string, rewrite?: (p: string, json: Record<string, unknown>) => Record<string, unknown>): Mounted {
  const errors: string[] = [];
  const termInput: string[] = [];
  let trees = 0;
  const virtualConsole = new VirtualConsole();
  virtualConsole.on("jsdomError", (e: Error) => errors.push(e.message));
  const sockets: WebSocket[] = [];
  let closed = false;
  const never = new Promise<never>(() => {});
  const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });

  const dom = new JSDOM(APP_HTML, {
    url: `${baseUrl}/app${hash}`,
    runScripts: "dangerously",
    pretendToBeVisual: true,
    virtualConsole,
    beforeParse(window) {
      window.scrollTo = () => {};
      window.HTMLElement.prototype.scrollTo = () => {};
      window.HTMLElement.prototype.scrollIntoView = () => {};
      window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof window.ResizeObserver;
      window.matchMedia = ((q: string) => ({
        matches: /min-width/.test(q),
        media: q,
        onchange: null,
        addListener() {},
        removeListener() {},
        addEventListener() {},
        removeEventListener() {},
        dispatchEvent: () => false,
      })) as typeof window.matchMedia;
      window.fetch = ((input: string, init?: RequestInit) => {
        if (closed) return never;
        const p = new URL(String(input), baseUrl).pathname;
        if (/\/term\/(open|input|signal|resize|close)$/.test(p)) {
          if (p.endsWith("/input")) termInput.push(String((JSON.parse(String(init?.body ?? "{}")) as { data?: string }).data ?? ""));
          return Promise.resolve(json(p.endsWith("/open") ? { term: "t1", cwd: webDir, mode: "pipe", reused: false, scrollback: "" } : { ok: true }));
        }
        return fetch(new URL(String(input), baseUrl), init).then(async (r) => {
          if (closed) return never;
          if (p.endsWith("/tree")) trees++;
          if (!rewrite || !(r.headers.get("content-type") ?? "").includes("json")) return r;
          const body = (await r.json()) as Record<string, unknown>;
          return new Response(JSON.stringify(rewrite(p, body)), { status: r.status, headers: { "content-type": "application/json" } });
        });
      }) as typeof window.fetch;
      window.WebSocket = class extends WebSocket {
        constructor(url: string | URL, protocols?: string | string[]) {
          super(url, protocols);
          sockets.push(this);
        }
      } as unknown as typeof window.WebSocket;
      window.localStorage.setItem("loomClientToken", clientToken);
      window.localStorage.setItem("loomDevMode", "1");
      window.confirm = () => true;
    },
  });
  const m: Mounted = {
    window: dom.window,
    errors,
    termInput,
    treeLoads: () => trees,
    close: () => {
      closed = true;
      for (const s of sockets) {
        try {
          s.removeAllListeners();
          s.on("error", () => {});
          s.terminate();
        } catch {
          /* already gone */
        }
      }
      dom.window.close();
    },
  };
  live.push(m);
  return m;
}

const $ = (m: Mounted, sel: string) => m.window.document.querySelector(sel);
const ready = (m: Mounted, sel: string) =>
  waitUntil(() => !!($(m, sel) as (HTMLElement & { onclick?: unknown }) | null)?.onclick);
const click = (el: Element | null) => {
  if (!el) throw new Error("clicked an element that isn't there");
  el.dispatchEvent(new (el.ownerDocument.defaultView as Window & typeof globalThis).MouseEvent("click", { bubbles: true }));
};

// ---------------------------------------------------------------------------
// 1. Explorer → Open in terminal
// ---------------------------------------------------------------------------

describe("#430.1 Explorer's Open in terminal", () => {
  it.skipIf(process.platform === "win32")("types a cd whose directory name is data, not shell syntax", async () => {
    const m = mount(`#p/${webId}`);
    await ready(m, '.railbar .rvbtn[data-view="explorer"]');
    click($(m, '.railbar .rvbtn[data-view="explorer"]'));
    const row = () => [...m.window.document.querySelectorAll(".trow.dir")].find((r) => (r.getAttribute("data-dir") ?? "").includes("LOOM_QUOTING_PROOF"));
    await waitUntil(() => !!row());
    await waitUntil(() => !!(row() as HTMLElement & { oncontextmenu?: unknown }).oncontextmenu);
    row()!.dispatchEvent(new m.window.MouseEvent("contextmenu", { bubbles: true, clientX: 10, clientY: 10 }));
    const item = () => [...m.window.document.querySelectorAll("#loommenu .pickrow")].find((b) => b.textContent?.includes("Open in terminal"));
    await waitUntil(() => !!item());
    click(item()!);
    await waitUntil(() => m.termInput.some((d) => d.includes("LOOM_QUOTING_PROOF")), { timeoutMs: 10_000 });
    const typed = m.termInput.find((d) => d.includes("LOOM_QUOTING_PROOF"))!.replace(/\r$/, "");

    // What the real shell does with that line: it changes into the folder and runs nothing.
    const out = execFileSync("/bin/sh", ["-c", `${typed} && pwd`], { cwd: tmpDir("r3-sh"), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    expect(path.basename(out.trim())).toBe(EVIL_DIR);
    const err = execFileSync("/bin/sh", ["-c", `${typed} 2>&1 >/dev/null; true`], { cwd: tmpDir("r3-sh"), encoding: "utf8" });
    expect(err).not.toContain("LOOM_QUOTING_PROOF");
    expect(m.errors.join("\n")).toBe("");
  });
});

// ---------------------------------------------------------------------------
// 2. Agent avatars from .loom/config.json
// ---------------------------------------------------------------------------

describe("#430.2 a config-written agent avatar", () => {
  it("the daemon only reports a picture that is a whole PNG/JPEG/WebP data URL", async () => {
    const { project } = await admin.project(webId);
    expect(project.agents.find((a) => a.id === "plannerbot")?.avatar).toBeUndefined();
    expect(project.agents.find((a) => a.id === "execbot")?.avatar).toBe(GOOD_AVATAR);
  });

  it("the web app never writes one into HTML as markup, whatever the daemon sends", async () => {
    // an older daemon (or any other path) still sending the raw value
    const evil = (p: string, body: Record<string, unknown>) => {
      const proj = body.project as ProjectStatus | undefined;
      if (p === `/api/projects/${webId}` && proj?.agents) {
        for (const a of proj.agents) if (a.id === "plannerbot") a.avatar = EVIL_AVATAR;
      }
      return body;
    };
    const m = mount(`#p/${webId}`, evil);
    await waitUntil(() => !!$(m, `[data-pset="${webId}"]`));
    await ready(m, `[data-pset="${webId}"]`);
    click($(m, `[data-pset="${webId}"]`));
    await waitUntil(() => m.window.document.querySelectorAll("#psbody .psrow [data-avatar]").length === 2);
    expect(m.window.document.querySelectorAll("[onerror]").length).toBe(0);
    // the good one is still shown; the bad one falls back to the camera icon
    const pics = [...m.window.document.querySelectorAll("#psbody img.psav")] as HTMLImageElement[];
    expect(pics.map((i) => i.getAttribute("src"))).toEqual([GOOD_AVATAR]);
    expect((m.window as unknown as { __pwned?: number }).__pwned).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 6. Source Control's commit message survives the working-tree poll
// ---------------------------------------------------------------------------

describe("#430.6 Source Control redraws", () => {
  it("keep the commit message being written, and its focus", async () => {
    const m = mount(`#p/${webId}`);
    await ready(m, '.railbar .rvbtn[data-view="scm"]');
    click($(m, '.railbar .rvbtn[data-view="scm"]'));
    await waitUntil(() => !!$(m, "#gmsg") && !!$(m, "#gcommitbtn"));
    const box = $(m, "#gmsg") as HTMLTextAreaElement;
    box.focus();
    box.value = "half a thought";
    box.dispatchEvent(new m.window.Event("input", { bubbles: true }));
    // the 5s working-tree poll redraws the rail: wait for one to land after typing
    const before = m.treeLoads();
    await waitUntil(() => m.treeLoads() > before, { timeoutMs: 15_000 });
    await waitUntil(() => $(m, "#gmsg") !== box);
    const now = $(m, "#gmsg") as HTMLTextAreaElement;
    expect(now.value).toBe("half a thought");
    expect(m.window.document.activeElement).toBe(now);
    // switching away and back keeps it too
    click($(m, '.railbar .rvbtn[data-view="explorer"]'));
    click($(m, '.railbar .rvbtn[data-view="scm"]'));
    expect(($(m, "#gmsg") as HTMLTextAreaElement).value).toBe("half a thought");
  });
});

// ---------------------------------------------------------------------------
// 3. loom send --wait behind a running turn
// ---------------------------------------------------------------------------

describe("#430.3 loom send --wait to a busy agent", () => {
  it("waits for its own queued turn, not the one already running", async () => {
    const client = new DaemonClient(readDaemonConfig()!);
    const id = cliId;
    await client.send(id, "first sleep:3000", "solo");
    await waitUntil(async () => (await client.project(id)).project.agents.find((a) => a.id === "solo")?.busy === true);
    const r = await runCli(["send", "--wait", "--json", "-a", "solo", "second"], cliDir);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toMatchObject({ status: "ok", agent: "solo", reply: "echo(solo): second" });
  });

  it("reads a queued turn from its turn_started (an edited item runs as <id>:edit:<ts>)", () => {
    let n = 100;
    const ev = (kind: string, payload: Record<string, unknown> = {}, chat?: string): LoomEvent =>
      ({ id: ++n, ts: 0, kind, agentId: "a", ...(chat ? { chat } : {}), payload } as LoomEvent);
    const running = [ev("message", { text: "first" }), ev("run_complete", {})];
    const sent = { agentId: "a", queueId: "q1", requestId: "queue:q1" };
    expect(sentTurnOutcome(running, sent, 100)).toBeNull();
    const mine = [ev("status", { state: "turn_started", requestId: "queue:q1:edit:9" }), ev("message", { text: "second" }), ev("run_complete", {})];
    expect(sentTurnOutcome([...running, ...mine], sent, 100)).toMatchObject({ status: "ok", reply: "second" });
    // ran at once, or answered a question: read from the send on, as before
    expect(sentTurnOutcome(running, { agentId: "a" }, 100)).toMatchObject({ reply: "first" });
    expect(sentTurnOutcome(running, { agentId: "a", answered: true }, 100)).toMatchObject({ reply: "first" });
  });
});

// ---------------------------------------------------------------------------
// 4. loom route whose first step can't start
// ---------------------------------------------------------------------------

describe("#430.4 loom route that failed at start", () => {
  it("exits 1 with the reason instead of following forever", async () => {
    const client = new DaemonClient(readDaemonConfig()!);
    await client.send(routeId, "spend a little", "capped"); // echo costs $0.001 a turn
    await waitUntil(async () => (await client.events(routeId)).events.some((e) => e.kind === "run_complete"));
    const put = await fetch(`${baseUrl}/api/projects/${routeId}/budgets/capped`, {
      method: "PUT",
      headers: { authorization: `Bearer ${readDaemonConfig()!.adminToken}`, "content-type": "application/json" },
      body: JSON.stringify({ usdPerDay: 0.0001 }),
    });
    expect(put.ok).toBe(true);
    const r = await runCli(["route", "capped", "do the thing"], routeDir, 20_000);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/could not start/);
  });

  it("a route that ends between starting it and subscribing is caught by its state", async () => {
    const started = { id: "r1", status: "running" } as RouteState;
    let state: RouteState = started;
    const client = { subscribe: () => () => {}, routeState: async () => ({ route: state }) };
    const done = followRoute(client, "p", started, () => {}, 20);
    state = { ...started, status: "failed", reason: "step 1 could not start" };
    await expect(done).resolves.toMatchObject({ status: "failed" });
    await expect(followRoute(client, "p", { ...started, status: "failed" } as RouteState, () => {})).resolves.toMatchObject({ status: "failed" });
  });
});

// ---------------------------------------------------------------------------
// 5. TUI /prompt after switching agents
// ---------------------------------------------------------------------------

describe("#430.5 TUI /prompt", () => {
  it("sends to the agent selected now, not the one selected at start", async () => {
    const agent = (id: string) => ({ id, kind: "echo", role: "general", tier: "adapter", available: true, busy: false, holdsBaton: id === "A", model: "", capabilities: { steer: false } });
    const initial = { id: "p", name: "tuiproj", dir: "/nowhere", holder: "A", agents: [agent("A"), agent("B")], lastEvent: null, needsInput: false } as unknown as ProjectStatus;
    const sends: Array<{ text: string; to?: string }> = [];
    const handoffs: string[] = [];
    const client = {
      events: async () => ({ events: [] }),
      subscribe: () => () => {},
      project: async () => ({ project: initial }),
      prompts: async () => ({ saved: [{ id: "p1", title: "daily", text: "hi {{agent}}", pinned: false }] }),
      handoff: async (_p: string, to: string) => void handoffs.push(to),
      send: async (_p: string, text: string, to?: string) => { sends.push({ text, ...(to ? { to } : {}) }); return { agentId: to ?? "A" }; },
      updatePrompt: async () => ({}),
    };
    const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode: () => {}, ref: () => {}, unref: () => {} });
    const stdout = Object.assign(new PassThrough(), { isTTY: true, columns: 100, rows: 30 });
    stdout.resume();
    const app = render(createElement(TuiApp, { client: client as never, initial }), {
      stdin: stdin as never, stdout: stdout as never, stderr: stdout as never, debug: true, exitOnCtrlC: false, patchConsole: false,
    });
    try {
      const press = async (s: string) => { stdin.write(s); await new Promise((r) => setTimeout(r, 60)); };
      await press("\t"); // select B
      for (const ch of "/prompt daily") await press(ch);
      await press("\r");
      await waitUntil(() => sends.length > 0, { timeoutMs: 5000 });
      expect(sends[0]).toEqual({ text: "hi B", to: "B" });
      expect(handoffs).toEqual(["B"]);
    } finally {
      app.unmount();
    }
  });
});

// ---------------------------------------------------------------------------
// 7 & 8. The relay client (src/core/relay-client.ts; the phone runs a copy)
// ---------------------------------------------------------------------------

function fakeRelay() {
  const creds = newRelayCredentials();
  const key = fromB64(creds.key);
  let deliver: (env: unknown) => void = () => {};
  const sent: RelayMessage[] = [];
  const dec = new RelayDecoder(key, "c");
  const transport: RelayTransport = {
    async send(env) {
      const m = dec.push(JSON.parse(JSON.stringify(env)));
      if (m) sent.push(m);
    },
    onEnvelope(cb) {
      deliver = cb;
    },
    async ready() {},
    async close() {},
  };
  const client = new RelayClient(transport, creds, { clientId: "phone" });
  const fromDaemon = (msg: RelayMessage) => {
    for (const env of encodeMessage(key, "d", msg)) deliver(JSON.parse(JSON.stringify(env)));
  };
  return { client, sent, fromDaemon };
}
const tick = () => new Promise((r) => setTimeout(r, 10));

describe("#430.7 two readers of one relay stream", () => {
  it("closing the Terminal's leaves the chat's feed subscribed and delivering", async () => {
    const { client, sent, fromDaemon } = fakeRelay();
    const chat: unknown[] = [], term: unknown[] = [];
    client.openStream("Bearer t", { onFrame: (f) => chat.push(f) }, "p1");
    await tick();
    fromDaemon({ t: "stream", to: "phone", open: true });
    const closeTerm = client.openStream("Bearer t", { onFrame: (f) => term.push(f) }, "p1");
    await tick();
    fromDaemon({ t: "evs", to: "phone", frames: [{ n: 1 }] });
    expect(chat).toEqual([{ n: 1 }]);
    expect(term).toEqual([{ n: 1 }]);
    closeTerm();
    await tick();
    expect(sent.filter((m) => m.t === "unsub")).toEqual([]);
    expect(client.isStreaming()).toBe(true);
    fromDaemon({ t: "evs", to: "phone", frames: [{ n: 2 }] });
    expect(chat).toEqual([{ n: 1 }, { n: 2 }]);
    expect(term).toEqual([{ n: 1 }]);
  });

  it("a reader of another feed takes it over, and the one left gets its feed back", async () => {
    const { client, sent } = fakeRelay();
    const closeChat = client.openStream("Bearer t", { onFrame: () => {} }, "p1");
    const closeTeam = client.openStream("Bearer t", { onFrame: () => {} });
    closeTeam();
    await tick();
    const subs = sent.filter((m) => m.t === "sub") as Array<{ project?: string }>;
    expect(subs.map((s) => s.project ?? null)).toEqual(["p1", null, "p1"]);
    closeChat();
    await tick();
    expect(sent.at(-1)?.t).toBe("unsub");
  });
});

describe("#430.8 closing the relay client", () => {
  it("settles a request in flight, and refuses new ones", async () => {
    const { client } = fakeRelay();
    const pending = client.request("GET", "/api/projects");
    await client.close();
    const r = await Promise.race([pending, new Promise((res) => setTimeout(() => res("still pending"), 500))]);
    expect(r).toMatchObject({ status: 503 });
    await expect(client.request("GET", "/api/projects")).resolves.toMatchObject({ status: 503 });
  });
});
