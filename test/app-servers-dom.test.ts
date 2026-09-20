/**
 * The Browser tab's dev servers, actually driven.
 *
 * The real page in jsdom, a real daemon, and a real server: a node one-liner
 * that listens on a free port. Starting it from the rail starts a process;
 * the row goes running when the port answers; its output is the process's own;
 * and killing it turns the row red with the exit code — which is the whole
 * reason Loom runs these rather than asking you for a URL.
 */

import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { JSDOM, VirtualConsole } from "jsdom";
import WebSocket from "ws";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { readDaemonConfig, writeProjectConfig } from "../src/core/registry.js";
import { APP_HTML } from "../src/daemon/app-page.js";
import { DaemonClient } from "../src/daemon/client.js";
import { LoomDaemon } from "../src/daemon/server.js";
import { makeProjectDir, tmpDir, waitUntil } from "./helpers.js";

let daemon: LoomDaemon;
let baseUrl: string;
let clientToken: string;
let projectId: string;
let port: number;

const freePort = (): Promise<number> =>
  new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const { port: p } = s.address() as net.AddressInfo;
      s.close(() => resolve(p));
    });
  });

beforeAll(async () => {
  process.env.LOOM_HOME = tmpDir("home-servers-dom");
  process.env.LOOM_NO_NOTIFY = "1";
  daemon = new LoomDaemon({ host: "127.0.0.1", port: 0 });
  const { host, port: p } = await daemon.listen();
  baseUrl = `http://${host}:${p}`;

  port = await freePort();
  const dir = makeProjectDir({ name: "served" });
  // a real server, and a real crash, both as small as they can be
  writeProjectConfig(dir, {
    ...JSON.parse(fs.readFileSync(path.join(dir, ".loom", "config.json"), "utf8")),
    servers: [
      {
        name: "web",
        // a real page, so previewing it means something
        command: `node -e "console.log('serving'); require('http').createServer((q,s)=>{s.setHeader('content-type','text/html');s.end('<html><head></head><body><h1>served</h1></body></html>')}).listen(${port})"`,
        port,
      },
      { name: "doomed", command: `node -e "console.error('nope'); process.exit(7)"` },
    ],
  });

  const client = new DaemonClient(readDaemonConfig()!);
  projectId = (await client.addProject(dir)).project.id;
  const { token } = await client.newPairingToken();
  const claim = await fetch(`${baseUrl}/api/pair/claim`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token, name: "jsdom" }),
  });
  clientToken = ((await claim.json()) as { clientToken: string }).clientToken;
}, 30_000);

const live: Mounted[] = [];
afterEach(async () => {
  while (live.length) live.pop()!.close();
  // never leave a server holding a port between tests
  await rest("POST", "/servers/web/stop").catch(() => {});
});
afterAll(async () => {
  await daemon.close();
});

async function rest<T = unknown>(method: string, p: string): Promise<T> {
  const r = await fetch(`${baseUrl}/api/projects/${projectId}${p}`, {
    method,
    headers: { Authorization: `Bearer ${clientToken}`, "content-type": "application/json" },
    ...(method === "POST" ? { body: "{}" } : {}),
  });
  const j = (await r.json()) as T & { error?: string };
  if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
  return j;
}

interface Mounted {
  window: JSDOM["window"];
  errors: string[];
  seen: string[];
  close: () => void;
}

function mount(): Mounted {
  const errors: string[] = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on("jsdomError", (e: Error) => errors.push(e.message));
  const sockets: WebSocket[] = [];
  const seen: string[] = [];
  let closed = false;
  const never = new Promise<never>(() => {});

  const dom = new JSDOM(APP_HTML, {
    url: `${baseUrl}/app#p/${projectId}`,
    runScripts: "dangerously",
    pretendToBeVisual: true,
    virtualConsole,
    beforeParse(window) {
      window.scrollTo = () => {};
      window.HTMLElement.prototype.scrollTo = () => {};
      window.HTMLElement.prototype.scrollIntoView = () => {};
      window.ResizeObserver = class {
        observe() {}
        unobserve() {}
        disconnect() {}
      } as unknown as typeof window.ResizeObserver;
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
        const u = new URL(String(input), baseUrl);
        if (u.pathname.includes("/servers")) seen.push(u.pathname + " " + (init?.method ?? "GET"));
        return fetch(u, init).then((r) => (closed ? never : r));
      }) as typeof window.fetch;
      window.WebSocket = class extends WebSocket {
        constructor(url: string | URL, protocols?: string | string[]) {
          super(url, protocols);
          sockets.push(this);
        }
      } as unknown as typeof window.WebSocket;
      window.localStorage.setItem("loomClientToken", clientToken);
      window.confirm = () => true;
    },
  });

  const m: Mounted = {
    window: dom.window,
    errors,
    seen,
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
const all = (m: Mounted, sel: string) => [...m.window.document.querySelectorAll(sel)];
const text = (m: Mounted, sel: string) => $(m, sel)?.textContent?.trim() ?? "";
const click = (el: Element | null) => {
  if (!el) throw new Error("clicked an element that isn't there");
  (el as HTMLElement).dispatchEvent(
    new (el.ownerDocument.defaultView as Window & typeof globalThis).MouseEvent("click", { bubbles: true }),
  );
};
const row = (m: Mounted, name: string) => $(m, `.srvrow[data-srv="${name}"]`);

async function openBrowserTab(m: Mounted) {
  await waitUntil(() => !!($(m, "#browserbtn") as HTMLElement & { onclick?: unknown })?.onclick, { timeoutMs: 20_000 });
  click($(m, "#browserbtn"));
  await waitUntil(() => all(m, ".srvrow").length >= 2, { timeoutMs: 20_000 });
  // the pane asked the daemon for them rather than drawing from nothing
  expect(m.seen.some((r) => r.endsWith("/servers GET"))).toBe(true);
}

describe("web app · dev servers in the Browser tab", () => {
  it("lists them, starts one for real, and says running only when the port answers", async () => {
    const m = mount();
    await openBrowserTab(m);
    expect(text(m, '.srvrow[data-srv="web"]')).toContain("stopped");

    click(row(m, "web")!.querySelector('[data-act="start"]'));
    // a real process, then a real listening port — live over the socket
    await waitUntil(() => text(m, '.srvrow[data-srv="web"]').includes("running"), { timeoutMs: 30_000 });
    const listening = await new Promise<boolean>((resolve) => {
      const s = net.createConnection(port, "127.0.0.1");
      s.once("connect", () => (s.destroy(), resolve(true)));
      s.once("error", () => resolve(false));
    });
    expect(listening, "the port really answers").toBe(true);

    // Clicking the row previews it — through Loom's own proxy, so the page can
    // report its console back. The address bar still shows the server's own
    // url, because that's the one a person thinks in.
    click(row(m, "web"));
    await waitUntil(() => (($(m, "#browurl") as HTMLInputElement | null)?.value ?? "").includes(String(port)), { timeoutMs: 10_000 });
    await waitUntil(() => !!$(m, "#browframe iframe"), { timeoutMs: 15_000 });
    const src = ($(m, "#browframe iframe") as HTMLIFrameElement).src;
    expect(src).toMatch(/^http:\/\/127\.0\.0\.1:\d+/);
    expect(src).not.toContain(String(port)); // the proxy's port, not the server's
    // and what it serves really is the page, with the bridge added
    const served = await (await fetch(src)).text();
    expect(served).toContain("loom-preview-bridge");

    click(row(m, "web")!.querySelector('[data-act="stop"]'));
    await waitUntil(() => text(m, '.srvrow[data-srv="web"]').includes("stopped"), { timeoutMs: 30_000 });
    expect(m.errors).toEqual([]);
  }, 90_000);

  it("emulates a width, and remembers it per project", async () => {
    const m = mount();
    await openBrowserTab(m);
    // point it somewhere so there's a frame to size
    const url = $(m, "#browurl") as HTMLInputElement;
    url.value = `http://127.0.0.1:${port}`;
    click($(m, "#browgo"));
    await waitUntil(() => !!$(m, "#browframe iframe"), { timeoutMs: 10_000 });
    const frame = () => $(m, "#browframe iframe") as HTMLIFrameElement;
    expect(frame().style.width).toBe("100%"); // Fit, by default

    click($(m, '#browsizes [data-w="375"]'));
    await waitUntil(() => frame().style.width === "375px", { timeoutMs: 10_000 });
    expect($(m, "#browframe")!.classList.contains("sized")).toBe(true);
    expect(frame().style.transform).toMatch(/scale\(/); // scaled down to fit the dock
    expect(m.window.localStorage.getItem(`loomBrowW:${projectId}`)).toBe("375");

    click($(m, '#browsizes [data-w="0"]'));
    await waitUntil(() => frame().style.width === "100%", { timeoutMs: 10_000 });
    expect($(m, "#browframe")!.classList.contains("sized")).toBe(false);
    expect(m.errors).toEqual([]);
  }, 60_000);

  it("remembers the width and the scheme, and reads them back next time", async () => {
    const m = mount();
    await openBrowserTab(m);
    const url = $(m, "#browurl") as HTMLInputElement;
    url.value = `http://127.0.0.1:${port}`;
    click($(m, "#browgo"));
    await waitUntil(() => !!$(m, "#browframe iframe"), { timeoutMs: 10_000 });

    click($(m, '#browsizes [data-w="768"]'));
    click($(m, '#browscheme [data-s="dark"]'));
    await waitUntil(() => m.window.localStorage.getItem(`loomBrowS:${projectId}`) === "dark", {
      timeoutMs: 10_000,
    });
    expect($(m, '#browscheme [data-s="dark"]')!.classList.contains("on")).toBe(true);
    expect($(m, '#browscheme [data-s=""]')!.classList.contains("on")).toBe(false);

    // A second window carrying the same stored preferences: both come back.
    // (They were being saved and never read, which is the same as not
    // remembering them. jsdom gives each window its own storage, so the
    // saved values are handed over explicitly.)
    const again = mount();
    again.window.localStorage.setItem(`loomBrowW:${projectId}`, "768");
    again.window.localStorage.setItem(`loomBrowS:${projectId}`, "dark");
    await openBrowserTab(again);
    await waitUntil(() => !!$(again, '#browscheme [data-s="dark"]'), { timeoutMs: 10_000 });
    expect($(again, '#browscheme [data-s="dark"]')!.classList.contains("on")).toBe(true);
    expect($(again, '#browsizes [data-w="768"]')!.classList.contains("on")).toBe(true);
    expect(again.errors).toEqual([]);

    expect(m.errors).toEqual([]);
  }, 60_000);

  it("shows a server's own output, and turns red with the exit code when it dies", async () => {
    const m = mount();
    await openBrowserTab(m);

    click(row(m, "doomed")!.querySelector('[data-act="start"]'));
    // it exits immediately: crashed, with the code, not "stopped"
    await waitUntil(() => text(m, '.srvrow[data-srv="doomed"]').includes("crashed"), { timeoutMs: 30_000 });
    expect(text(m, '.srvrow[data-srv="doomed"]')).toContain("exit 7");
    expect(row(m, "doomed")!.querySelector(".sdot.err")).toBeTruthy();

    click(row(m, "doomed")!.querySelector('[data-act="log"]'));
    await waitUntil(() => text(m, "#srvloglines").includes("nope"), { timeoutMs: 20_000 });
    expect(text(m, "#srvlogname")).toBe("doomed");
    expect(text(m, "#srvloglines")).toContain("code 7");
    expect(m.errors).toEqual([]);
  }, 90_000);
});
