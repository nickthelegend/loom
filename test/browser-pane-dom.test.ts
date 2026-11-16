/**
 * The Browser pane, driven the way a person drives it.
 *
 * The real page in jsdom and a real daemon; a real dev server (a node http
 * server in this process) behind Loom's real proxy. What these hold the pane
 * to: a typed localhost address gets the bridge too; the pane listens only to
 * its own frame and follows where the page goes; another project starts the
 * pane from nothing; a running spec can be stopped; and a site that refuses to
 * be framed is said to refuse, not left as a white rectangle.
 */

import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { JSDOM, VirtualConsole } from "jsdom";
import WebSocket from "ws";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { readDaemonConfig } from "../src/core/registry.js";
import { APP_HTML } from "../src/daemon/app-page.js";
import { DaemonClient } from "../src/daemon/client.js";
import { LoomDaemon } from "../src/daemon/server.js";
import { makeProjectDir, tmpDir, waitUntil } from "./helpers.js";

let daemon: LoomDaemon;
let baseUrl: string;
let clientToken: string;
let projectA: string;
let projectB: string;
let devServer: http.Server;
let devPort: number;

beforeAll(async () => {
  process.env.LOOM_HOME = tmpDir("home-browser-pane");
  process.env.LOOM_NO_NOTIFY = "1";
  daemon = new LoomDaemon({ host: "127.0.0.1", port: 0 });
  const { host, port } = await daemon.listen();
  baseUrl = `http://${host}:${port}`;

  devServer = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(`<html><head></head><body><h1>dev ${req.url}</h1></body></html>`);
  });
  devPort = await new Promise<number>((resolve) => {
    devServer.listen(0, "127.0.0.1", () => resolve((devServer.address() as net.AddressInfo).port));
  });

  // A uses Playwright and has a spec; B has nothing at all.
  const a = makeProjectDir({ name: "alpha" });
  fs.writeFileSync(path.join(a, "package.json"), JSON.stringify({ devDependencies: { "@playwright/test": "^1.50.0" } }));
  fs.mkdirSync(path.join(a, "tests"), { recursive: true });
  fs.writeFileSync(path.join(a, "tests", "home.spec.ts"), "// spec");
  const b = makeProjectDir({ name: "beta" });

  const client = new DaemonClient(readDaemonConfig()!);
  projectA = (await client.addProject(a)).project.id;
  projectB = (await client.addProject(b)).project.id;
  const { token } = await client.newPairingToken();
  const claim = await fetch(`${baseUrl}/api/pair/claim`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token, name: "jsdom" }),
  });
  clientToken = ((await claim.json()) as { clientToken: string }).clientToken;
}, 30_000);

const live: Mounted[] = [];
afterEach(() => {
  while (live.length) live.pop()!.close();
  delete process.env.LOOM_SPEC_CMD;
});
afterAll(async () => {
  devServer.closeAllConnections?.();
  await new Promise<void>((r) => devServer.close(() => r()));
  await daemon.close();
});

interface Mounted {
  window: JSDOM["window"];
  errors: string[];
  close: () => void;
}

/** The app, with an optional stand-in for one daemon route. */
function mount(pid: string, stub?: (pathname: string) => Promise<Response> | null, options: { webview?: boolean; pane?: string; history?: string } = {}): Mounted {
  const errors: string[] = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on("jsdomError", (e: Error) => errors.push(e.message));
  const sockets: WebSocket[] = [];
  let closed = false;
  const never = new Promise<never>(() => {});
  const dom = new JSDOM(APP_HTML, {
    url: `${baseUrl}/app${options.pane ? "?pane=" + options.pane : ""}#p/${pid}`,
    runScripts: "dangerously",
    pretendToBeVisual: true,
    virtualConsole,
    beforeParse(window) {
      if (options.webview !== undefined) (window as unknown as { loomNative: unknown }).loomNative = { webview: options.webview };
      if (options.history) window.localStorage.setItem(`loomBrowHistory:${pid}:${options.pane || "main"}`, options.history);
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
        const stubbed = stub?.(u.pathname);
        if (stubbed) return stubbed;
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
      // see app-servers-dom.test.ts: a closed window runs no animation frames
      dom.window.requestAnimationFrame = () => 0;
      dom.window.close();
    },
  };
  live.push(m);
  return m;
}

const $ = (m: Mounted, sel: string) => m.window.document.querySelector(sel);
const text = (m: Mounted, sel: string) => $(m, sel)?.textContent?.trim() ?? "";
const click = (el: Element | null) => {
  if (!el) throw new Error("clicked an element that isn't there");
  (el as HTMLElement).dispatchEvent(
    new (el.ownerDocument.defaultView as Window & typeof globalThis).MouseEvent("click", { bubbles: true }),
  );
};
const frame = (m: Mounted) => $(m, "#browframe iframe") as HTMLIFrameElement | null;
const address = (m: Mounted) => ($(m, "#browurl") as HTMLInputElement | null)?.value ?? "";

async function openBrowser(m: Mounted) {
  await waitUntil(() => !!($(m, "#browserbtn") as HTMLElement & { onclick?: unknown })?.onclick, { timeoutMs: 20_000 });
  click($(m, "#browserbtn"));
  await waitUntil(() => !!$(m, "#srvlist .specempty, #srvlist .srvrow"), { timeoutMs: 20_000 });
}

async function typeAndGo(m: Mounted, url: string) {
  ($(m, "#browurl") as HTMLInputElement).value = url;
  click($(m, "#browgo"));
  await waitUntil(() => !!$(m, "#browframe iframe, #browframe webview"), { timeoutMs: 15_000 });
}

/** A message as the browser would deliver it: with who sent it, and from where. */
function post(m: Mounted, data: unknown, source: unknown, origin: string) {
  const ev = new m.window.MessageEvent("message", { data, origin });
  Object.defineProperty(ev, "source", { value: source });
  m.window.dispatchEvent(ev);
}

describe("web app · the Browser pane", () => {
  it("sends a typed localhost address through the proxy, so it gets the bridge too", async () => {
    const m = mount(projectA);
    await openBrowser(m);
    await typeAndGo(m, `http://localhost:${devPort}/about`);
    const src = frame(m)!.src;
    expect(src).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/about$/);
    expect(src).not.toContain(String(devPort)); // the proxy's port, not the server's
    expect(address(m)).toBe(`http://localhost:${devPort}/about`); // the bar keeps the address you typed
    expect((await (await fetch(src)).text())).toContain("loom-preview-bridge");
    // popups, alerts and downloads behave as in a tab
    const sandbox = frame(m)!.getAttribute("sandbox") ?? "";
    for (const flag of ["allow-scripts", "allow-same-origin", "allow-popups", "allow-modals", "allow-downloads"]) {
      expect(sandbox).toContain(flag);
    }
    expect(m.errors).toEqual([]);
  }, 60_000);

  it("listens only to its own frame, and the address bar follows the page", async () => {
    const m = mount(projectA);
    await openBrowser(m);
    await typeAndGo(m, `http://localhost:${devPort}/`);
    const proxy = new URL(frame(m)!.src).origin;
    const win = frame(m)!.contentWindow;
    const ready = (url: string) => ({ source: "loom-preview", kind: "ready", payload: { url, title: "", hmr: false } });

    // another window, or the right window from the wrong origin: ignored
    post(m, ready(`${proxy}/spoofed`), m.window, proxy);
    post(m, ready(`${proxy}/spoofed`), win, "https://evil.example");
    await new Promise((r) => setTimeout(r, 50));
    expect(address(m)).toBe(`http://localhost:${devPort}/`);

    // the page itself, moved: the bar shows the dev server's address for it
    post(m, ready(`${proxy}/next?q=1`), win, proxy);
    await waitUntil(() => address(m) === `http://localhost:${devPort}/next?q=1`, { timeoutMs: 5_000 });
    post(m, { source: "loom-preview", kind: "nav", payload: { url: `${proxy}/spa/route` } }, win, proxy);
    await waitUntil(() => address(m) === `http://localhost:${devPort}/spa/route`, { timeoutMs: 5_000 });

    // Back asks the page — at the proxy's origin only
    const sent: Array<[unknown, string]> = [];
    (win as unknown as { postMessage: (msg: unknown, o: string) => void }).postMessage = (msg, o) => sent.push([msg, o]);
    click($(m, "#browback"));
    click($(m, "#browfwd"));
    expect(sent).toEqual([
      [{ source: "loom-app", kind: "history", go: -1 }, proxy],
      [{ source: "loom-app", kind: "history", go: 1 }, proxy],
    ]);

    // Reload goes to where the page is now, not where it started
    frame(m)!.setAttribute("src", "about:blank");
    click($(m, "#browreload"));
    expect(frame(m)!.src).toBe(`${proxy}/spa/route`);
    expect(m.errors).toEqual([]);
  }, 60_000);

  it("Design Mode: a picked element brings its computed styles and its own picture to the composer", async () => {
    const m = mount(projectA, (pathname) => pathname.endsWith("/preview/screenshot")
      ? Promise.resolve(new Response(JSON.stringify({ path: ".loom/attachments/element-abc123.png", bytes: 10, width: 120, height: 40, colorScheme: "light", fullPage: false }), { status: 200, headers: { "content-type": "application/json" } }))
      : null);
    await openBrowser(m);
    await typeAndGo(m, `http://localhost:${devPort}/`);
    const proxy = new URL(frame(m)!.src).origin;
    const win = frame(m)!.contentWindow;
    post(m, { source: "loom-preview", kind: "ready", payload: { url: `${proxy}/`, title: "", hmr: false } }, win, proxy);
    post(m, { source: "loom-preview", kind: "picked", payload: {
      selector: "button.buy", tag: "button", text: "Buy now", html: '<button class="buy">Buy now</button>',
      rect: { x: 10, y: 20, w: 120, h: 40 }, viewport: { w: 1024, h: 700 },
      styles: { "font-size": "16px", "background-color": "rgb(255, 107, 43)", "border-radius": "8px" },
      url: `${proxy}/` } }, win, proxy);
    const box = $(m, "#box") as HTMLTextAreaElement;
    await waitUntil(() => box.value.includes("computed styles:"), { timeoutMs: 5_000 });
    expect(box.value).toContain("selector: button.buy");
    expect(box.value).toContain("    background-color: rgb(255, 107, 43)");
    expect(box.value).toContain("    border-radius: 8px");
    await waitUntil(() => !!$(m, "#cchips .cchip"), { timeoutMs: 5_000 });
    expect(text(m, "#cchips .cchip .nm")).toBe(".loom/attachments/element-abc123.png");
    expect(m.errors).toEqual([]);
  }, 60_000);

  it("starts over in another project: no page, no width, that project's own servers and specs", async () => {
    const m = mount(projectA);
    await openBrowser(m);
    await waitUntil(() => !!$(m, '.specrow[data-spec="tests/home.spec.ts"]'), { timeoutMs: 20_000 });
    await typeAndGo(m, `http://localhost:${devPort}/a-page`);
    click($(m, '#browsizes [data-w="375"]'));
    await waitUntil(() => frame(m)!.style.width === "375px");

    const oldBox = $(m, "#box");
    m.window.location.hash = `p/${projectB}`;
    await waitUntil(() => !!$(m, "#box") && $(m, "#box") !== oldBox, { timeoutMs: 20_000 });
    // the dock still carries the Browser tab; it must come back alive, not as the last project's leftovers
    await waitUntil(() => !!$(m, ".termtab[data-browser]"), { timeoutMs: 20_000 });
    click($(m, ".termtab[data-browser]"));
    await waitUntil(() => text(m, "#srvlist").includes("No dev servers configured"), { timeoutMs: 20_000 });
    await waitUntil(() => text(m, "#speclist").includes("doesn’t use Playwright"), { timeoutMs: 20_000 });
    expect(frame(m)).toBeNull();
    expect(address(m)).toBe("");
    expect($(m, '#browsizes [data-w="0"]')!.classList.contains("on")).toBe(true);
    expect($(m, '#browsizes [data-w="375"]')!.classList.contains("on")).toBe(false);
    expect(m.errors).toEqual([]);
  }, 60_000);

  it("runs a spec, and stops it from the row", async () => {
    process.env.LOOM_SPEC_CMD = `node -e "console.log('hello-from-spec');setTimeout(()=>{},20000)"`;
    const m = mount(projectA);
    await openBrowser(m);
    await waitUntil(() => !!$(m, '.specrow[data-spec="tests/home.spec.ts"]'), { timeoutMs: 20_000 });
    click($(m, '.specrow[data-spec="tests/home.spec.ts"]'));
    await waitUntil(() => text(m, "#specout").includes("hello-from-spec"), { timeoutMs: 20_000 });
    await waitUntil(() => !!$(m, ".specrow.running [data-specstop]"), { timeoutMs: 10_000 });
    expect(($(m, "#specstop") as HTMLElement).style.display).toBe("");
    click($(m, ".specrow.running"));
    await waitUntil(() => text(m, "#specout").includes("tests/home.spec.ts stopped"), { timeoutMs: 20_000 });
    expect($(m, ".specrow.running")).toBeNull();
    expect(text(m, "#specout")).not.toContain("send failure to agent"); // stopped isn't failed
    expect(m.errors).toEqual([]);
  }, 60_000);

  it("says plainly when a site refuses to be framed", async () => {
    const m = mount(projectA, (p) =>
      p.endsWith("/preview/frameable")
        ? Promise.resolve(new Response(JSON.stringify({ frameable: false, reason: "X-Frame-Options: DENY" }), {
            headers: { "content-type": "application/json" },
          }))
        : null,
    );
    await openBrowser(m);
    await typeAndGo(m, "https://example.com/");
    expect(frame(m)!.src).toBe("https://example.com/"); // not proxied: it isn't this machine
    await waitUntil(() => !($(m, "#browblock") as HTMLElement).hidden, { timeoutMs: 10_000 });
    expect(text(m, "#browblock")).toContain("doesn’t allow being shown inside Loom");
    expect(text(m, "#browblock")).toContain("X-Frame-Options: DENY");
    expect($(m, "#browblockopen")).toBeTruthy();
    expect(m.errors).toEqual([]);
  }, 60_000);
});

describe("desktop Browser pane", () => {
  it("uses a persistent webview for external sites without probing framing headers", async () => {
    let probes = 0;
    const m = mount(projectA, (p) => {
      if (p.endsWith("/preview/frameable")) probes++;
      return null;
    }, { webview: true });
    await openBrowser(m);
    await typeAndGo(m, "https://example.com/docs");
    const guest = $(m, "#browframe webview")!;
    expect(guest.getAttribute("partition")).toBe("persist:loom-browser");
    expect(guest.getAttribute("src")).toBe("https://example.com/docs");
    expect(guest.hasAttribute("preload")).toBe(false);
    expect(guest.hasAttribute("allowpopups")).toBe(false);
    expect(frame(m)).toBeNull();
    expect(probes).toBe(0);
    expect(($(m, "#browback") as HTMLButtonElement).disabled).toBe(true);
    await typeAndGo(m, "https://example.org/next");
    expect($(m, "#browframe webview")).toBe(guest);
    expect(guest.getAttribute("src")).toBe("https://example.org/next");
    expect(m.errors).toEqual([]);
  }, 60_000);

  it("follows guest navigation and persists bounded, deduplicated suggestions per pane", async () => {
    const m = mount(projectA, undefined, { webview: true, pane: "left", history: '["https://saved.example/"]' });
    await openBrowser(m);
    expect($(m, '#browhistory option')!.getAttribute("value")).toBe("https://saved.example/");
    await typeAndGo(m, "https://example.com/");
    const guest = $(m, "webview")!;
    const navigate = (url: string, kind = "did-navigate", isMainFrame = true) => {
      const event = new m.window.Event(kind);
      Object.assign(event, { url, isMainFrame });
      guest.dispatchEvent(event);
    };
    navigate("https://example.com/docs");
    expect(address(m)).toBe("https://example.com/docs");
    navigate("https://example.com/docs#next", "did-navigate-in-page");
    expect(address(m)).toBe("https://example.com/docs#next");
    navigate("https://subframe.example/", "did-navigate-in-page", false);
    navigate("file:///tmp/secret");
    expect(address(m)).toBe("https://example.com/docs#next");
    navigate("https://example.com/docs");
    const key = `loomBrowHistory:${projectA}:left`;
    expect(JSON.parse(m.window.localStorage.getItem(key)!)).toEqual([
      "https://example.com/docs", "https://example.com/docs#next", "https://saved.example/",
    ]);
    expect(m.window.localStorage.getItem(`loomBrowHistory:${projectA}:right`)).toBeNull();
    expect(m.window.localStorage.getItem(`loomBrowHistory:${projectB}:left`)).toBeNull();
    expect($(m, "#browurl")!.getAttribute("list")).toBe("browhistory");
    for (let i = 0; i < 105; i++) navigate(`https://example.com/${i}`);
    expect(JSON.parse(m.window.localStorage.getItem(key)!)).toHaveLength(100);
    expect($(m, "#browhistory")!.children).toHaveLength(100);
    expect(m.errors).toEqual([]);
  }, 60_000);

  it("keeps localhost on the proxy iframe and replaces a guest when switching modes", async () => {
    const m = mount(projectA, undefined, { webview: true, history: "not JSON" });
    await openBrowser(m);
    await typeAndGo(m, "https://example.com/");
    const guest = $(m, "webview")!;
    await typeAndGo(m, `http://localhost:${devPort}/about`);
    await waitUntil(() => !!frame(m), { timeoutMs: 15_000 });
    expect($(m, "webview")).toBeNull();
    expect(frame(m)!.src).not.toContain(String(devPort));
    expect(frame(m)!.getAttribute("sandbox")).toContain("allow-scripts");
    const stale = new m.window.Event("did-navigate");
    Object.assign(stale, { url: "https://stale.example/" });
    guest.dispatchEvent(stale);
    expect(address(m)).toBe(`http://localhost:${devPort}/about`);
    await typeAndGo(m, "https://example.org/");
    expect(frame(m)).toBeNull();
    expect($(m, "webview")!.getAttribute("src")).toBe("https://example.org/");
    expect(m.errors).toEqual([]);
  }, 60_000);

  it("wires native history and reload, and reports guest failures without blaming framing", async () => {
    const m = mount(projectA, undefined, { webview: true });
    await openBrowser(m);
    await typeAndGo(m, "https://example.com/");
    const guest = $(m, "webview")!;
    const calls: string[] = [];
    let back = true, forward = false;
    // jsdom has no guest process; represent only Electron's element API.
    Object.assign(guest, {
      canGoBack: () => back, canGoForward: () => forward,
      goBack: () => calls.push("back"), goForward: () => calls.push("forward"),
      reload: () => calls.push("reload"),
    });
    guest.dispatchEvent(new m.window.Event("dom-ready"));
    expect(($(m, "#browback") as HTMLButtonElement).disabled).toBe(false);
    expect(($(m, "#browfwd") as HTMLButtonElement).disabled).toBe(true);
    click($(m, "#browback"));
    back = false; forward = true;
    const nav = new m.window.Event("did-navigate");
    Object.assign(nav, { url: "https://example.com/previous" });
    guest.dispatchEvent(nav);
    expect(($(m, "#browback") as HTMLButtonElement).disabled).toBe(true);
    expect(($(m, "#browfwd") as HTMLButtonElement).disabled).toBe(false);
    click($(m, "#browfwd"));
    click($(m, "#browreload"));
    expect(calls).toEqual(["back", "forward", "reload"]);
    expect($(m, "webview")).toBe(guest);

    const fail = (errorCode: number, isMainFrame: boolean) => {
      const event = new m.window.Event("did-fail-load");
      Object.assign(event, { errorCode, isMainFrame, errorDescription: "ERR_NAME_NOT_RESOLVED" });
      guest.dispatchEvent(event);
    };
    fail(-3, true);
    fail(-105, false);
    expect(($(m, "#browblock") as HTMLElement).hidden).toBe(true);
    fail(-105, true);
    expect(text(m, "#browblock")).toContain("This page couldn’t load.");
    expect(text(m, "#browblock")).toContain("ERR_NAME_NOT_RESOLVED");
    guest.dispatchEvent(new m.window.Event("did-start-loading"));
    expect(($(m, "#browblock") as HTMLElement).hidden).toBe(true);
    expect(m.errors).toEqual([]);
  }, 60_000);

  it("keeps the iframe when the native bridge has no webview capability", async () => {
    const m = mount(projectA, undefined, { webview: false });
    await openBrowser(m);
    await typeAndGo(m, "https://example.com/");
    expect(frame(m)!.src).toBe("https://example.com/");
    expect($(m, "webview")).toBeNull();
    expect($(m, "#browhistory")).toBeNull();
    expect(m.errors).toEqual([]);
  }, 60_000);
});

describe("the daemon's side of a typed address", () => {
  const rest = (p: string, body: unknown) =>
    fetch(`${baseUrl}/api/projects/${projectA}${p}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${clientToken}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  it("proxies only addresses on this machine", async () => {
    const ok = await rest("/preview/proxy", { url: `http://localhost:${devPort}/x` });
    expect(ok.status).toBe(200);
    const j = (await ok.json()) as { url: string; target: string };
    expect(j.target).toBe(`http://localhost:${devPort}`);
    // the same origin gets the same proxy
    const again = (await (await rest("/preview/proxy", { url: `http://localhost:${devPort}/y` })).json()) as { url: string };
    expect(again.url).toBe(j.url);
    for (const url of ["http://example.com", "http://localhost.evil.com:3000", "file:///etc/passwd"]) {
      expect((await rest("/preview/proxy", { url })).status, url).toBe(400);
    }
  });

  it("reads whether a page allows framing from its headers", async () => {
    const strict = http.createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/html", "x-frame-options": "DENY" });
      res.end("<p>no</p>");
    });
    const port = await new Promise<number>((resolve) => {
      strict.listen(0, "127.0.0.1", () => resolve((strict.address() as net.AddressInfo).port));
    });
    try {
      const r = (await (await rest("/preview/frameable", { url: `http://127.0.0.1:${port}/` })).json()) as { frameable: boolean };
      expect(r.frameable).toBe(false);
      const fine = (await (await rest("/preview/frameable", { url: `http://127.0.0.1:${devPort}/` })).json()) as { frameable: boolean };
      expect(fine.frameable).toBe(true);
    } finally {
      strict.closeAllConnections?.();
      await new Promise<void>((r) => strict.close(() => r()));
    }
  });
});
