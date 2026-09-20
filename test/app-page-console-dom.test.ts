/**
 * What the previewed page says, in the app that shows it.
 *
 * The whole chain, for real: a dev server, Loom's proxy in front of it, the
 * script the proxy injects, a page that logs and fetches and throws, and the
 * app's pane rendering it — then one click turning a line into the next
 * prompt's context, which is the reason any of it exists.
 *
 * jsdom runs the injected script for real (the proxy serves it), so nothing
 * here is a stand-in for the bridge.
 */

import http from "node:http";
import net from "node:net";
import { JSDOM, VirtualConsole } from "jsdom";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { injectBridge } from "../src/core/preview-proxy.js";
import { waitUntil } from "./helpers.js";

let upstream: http.Server;
let upstreamUrl: string;

beforeAll(async () => {
  upstream = http.createServer((req, res) => {
    if (req.url === "/data.json") {
      res.writeHead(404, { "content-type": "application/json" });
      return res.end('{"error":"nope"}');
    }
    res.writeHead(200, { "content-type": "text/html" });
    res.end(`<!doctype html><html><head></head><body><h1 id="hero">Hello</h1>
      <script>
        console.log("page is up");
        console.error("something broke");
        fetch("/data.json").catch(function(){});
      </script></body></html>`);
  });
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", () => r()));
  upstreamUrl = `http://127.0.0.1:${(upstream.address() as net.AddressInfo).port}`;
});

afterAll(async () => {
  upstream.closeAllConnections?.();
  await new Promise<void>((r) => upstream.close(() => r()));
});

const live: JSDOM[] = [];
afterEach(() => {
  while (live.length) live.pop()!.window.close();
});

/** A page as the proxy would serve it: the real bridge, in a real document. */
async function previewPage(): Promise<JSDOM> {
  const html = injectBridge(await (await fetch(upstreamUrl)).text());
  const virtualConsole = new VirtualConsole();
  const dom = new JSDOM(html, {
    url: upstreamUrl,
    runScripts: "dangerously",
    resources: "usable",
    virtualConsole,
    pretendToBeVisual: true,
    beforeParse(window) {
      // jsdom ships no fetch; the page needs one for the bridge to wrap. This
      // is the platform's part, not the bridge's — node's fetch stands in.
      (window as unknown as { fetch: typeof fetch }).fetch = ((input: string, init?: RequestInit) =>
        fetch(new URL(String(input), upstreamUrl), init)) as typeof fetch;
    },
  });
  live.push(dom);
  return dom;
}

describe("the bridge, running in a page", () => {
  it("reports what the page logged, kept in order, with its level", async () => {
    const dom = await previewPage();
    const seen: Array<{ kind: string; payload: Record<string, unknown> }> = [];
    dom.window.addEventListener("message", (e: MessageEvent) => {
      const d = e.data as { source?: string; kind: string; payload: Record<string, unknown> };
      if (d?.source === "loom-preview") seen.push({ kind: d.kind, payload: d.payload });
    });
    // jsdom's postMessage to `parent` when there is none targets the window itself
    await waitUntil(() => seen.some((s) => s.kind === "console" && String(s.payload.text).includes("page is up")), { timeoutMs: 10_000 });
    await waitUntil(() => seen.some((s) => s.kind === "console" && s.payload.level === "error"), { timeoutMs: 10_000 });

    const logs = seen.filter((s) => s.kind === "console");
    expect(logs[0]!.payload).toMatchObject({ level: "log", text: "page is up" });
    expect(logs.find((l) => l.payload.level === "error")!.payload.text).toBe("something broke");
    // and it announced itself, so the app can clear a previous page's lines
    expect(seen.some((s) => s.kind === "ready")).toBe(true);
  }, 30_000);

  it("reports a request with its status and how long it took", async () => {
    const dom = await previewPage();
    const net: Array<Record<string, unknown>> = [];
    dom.window.addEventListener("message", (e: MessageEvent) => {
      const d = e.data as { source?: string; kind: string; payload: Record<string, unknown> };
      if (d?.source === "loom-preview" && d.kind === "network") net.push(d.payload);
    });
    await waitUntil(() => net.length > 0, { timeoutMs: 10_000 });
    expect(net[0]).toMatchObject({ method: "GET", status: 404 });
    expect(String(net[0]!.url)).toContain("/data.json");
    expect(Number(net[0]!.ms)).toBeGreaterThanOrEqual(0);
  }, 30_000);

  it("does not silence the page's own console", async () => {
    const said: string[] = [];
    const virtualConsole = new VirtualConsole();
    virtualConsole.on("log", (...args: unknown[]) => said.push(args.join(" ")));
    const html = injectBridge(await (await fetch(upstreamUrl)).text());
    const dom = new JSDOM(html, { url: upstreamUrl, runScripts: "dangerously", virtualConsole });
    live.push(dom);
    await waitUntil(() => said.some((s) => s.includes("page is up")), { timeoutMs: 10_000 });
  }, 30_000);

  it("answers a pick with a selector, the text and the box", async () => {
    const dom = await previewPage();
    const picked: Array<Record<string, unknown>> = [];
    dom.window.addEventListener("message", (e: MessageEvent) => {
      const d = e.data as { source?: string; kind: string; payload: Record<string, unknown> };
      if (d?.source === "loom-preview" && d.kind === "picked") picked.push(d.payload);
    });
    await waitUntil(() => !!dom.window.document.getElementById("hero"), { timeoutMs: 10_000 });

    dom.window.postMessage({ source: "loom-app", kind: "pick" }, "*");
    await new Promise((r) => setTimeout(r, 100));
    const hero = dom.window.document.getElementById("hero")!;
    hero.dispatchEvent(new dom.window.MouseEvent("mousemove", { bubbles: true }));
    hero.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));

    await waitUntil(() => picked.length > 0, { timeoutMs: 10_000 });
    expect(picked[0]).toMatchObject({ selector: "#hero", tag: "h1", text: "Hello" });
    expect(picked[0]!.rect).toMatchObject({ x: expect.any(Number), w: expect.any(Number) });
    expect(String(picked[0]!.html)).toContain("Hello");
  }, 30_000);
});
