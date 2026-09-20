/**
 * The preview, served through Loom.
 *
 * A real upstream server, a real proxy in front of it, and real requests: the
 * page must arrive intact with one script added, everything that isn't HTML
 * must arrive byte for byte, and the socket a framework's hot reload rides on
 * must still connect. A preview that changes the page it previews is worse
 * than no preview at all.
 */

import http from "node:http";
import net from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import { BRIDGE_MARK, bridgeScript, injectBridge, startPreviewProxy, type PreviewProxy } from "../src/core/preview-proxy.js";

let proxy: PreviewProxy | null = null;
let upstream: http.Server | null = null;
afterEach(async () => {
  await proxy?.close();
  proxy = null;
  // A hijacked socket keeps a server open: this one is the test's own upstream,
  // which answers an upgrade and then holds it.
  upstream?.closeAllConnections?.();
  await new Promise<void>((r) => (upstream ? upstream.close(() => r()) : r()));
  upstream = null;
});

async function serve(handler: http.RequestListener): Promise<string> {
  upstream = http.createServer(handler);
  const port = await new Promise<number>((resolve) => {
    upstream!.listen(0, "127.0.0.1", () => resolve((upstream!.address() as net.AddressInfo).port));
  });
  return `http://127.0.0.1:${port}`;
}

const get = async (url: string) => {
  const res = await fetch(url);
  return { status: res.status, type: res.headers.get("content-type") ?? "", body: await res.text(), headers: res.headers };
};

describe("putting the bridge in a page", () => {
  it("goes inside head, first, so it sees what happens next", () => {
    const html = injectBridge("<!doctype html><html><head><title>x</title></head><body>hi</body></html>");
    expect(html.indexOf(BRIDGE_MARK)).toBeLessThan(html.indexOf("<title>"));
    expect(html).toContain("<body>hi</body>"); // the page itself is untouched
  });

  it("falls back to body, then to the front, and never injects twice", () => {
    expect(injectBridge("<body><p>x</p></body>")).toMatch(new RegExp(`<body>.*${BRIDGE_MARK}`, "s"));
    expect(injectBridge("<p>a fragment</p>")).toMatch(new RegExp(`^<script data-${BRIDGE_MARK}`));
    const once = injectBridge("<html><head></head></html>");
    expect(injectBridge(once)).toBe(once);
  });

  it("the script reports, and reports as one shape", () => {
    const js = bridgeScript();
    expect(js).toContain('source: "loom-preview"');
    for (const kind of ["console", "network", "picked", "ready"]) expect(js).toContain(`send("${kind}"`);
    // it must never take the page down with it
    expect(js).toContain("if (window.__loomPreviewBridge) return;");
    expect(js).toContain("return original && original.apply(console, arguments);");
  });
});

describe("standing in front of a dev server", () => {
  it("adds the bridge to HTML and leaves everything else alone", async () => {
    const target = await serve((req, res) => {
      if (req.url === "/app.js") {
        res.writeHead(200, { "content-type": "application/javascript" });
        return res.end("console.log('untouched');");
      }
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end("<!doctype html><html><head></head><body><h1>hello</h1></body></html>");
    });
    proxy = await startPreviewProxy(target);

    const page = await get(`http://127.0.0.1:${proxy.port}/`);
    expect(page.status).toBe(200);
    expect(page.body).toContain("<h1>hello</h1>");
    expect(page.body).toContain(BRIDGE_MARK);

    const js = await get(`http://127.0.0.1:${proxy.port}/app.js`);
    expect(js.body).toBe("console.log('untouched');"); // byte for byte
    expect(js.body).not.toContain(BRIDGE_MARK);
  });

  it("passes the method, the path, the query and the body through", async () => {
    const seen: Array<{ method: string; url: string; body: string }> = [];
    const target = await serve((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        seen.push({ method: req.method ?? "", url: req.url ?? "", body: Buffer.concat(chunks).toString() });
        res.writeHead(201, { "content-type": "application/json" });
        res.end('{"ok":true}');
      });
    });
    proxy = await startPreviewProxy(target);
    const res = await fetch(`http://127.0.0.1:${proxy.port}/api/thing?q=1`, { method: "POST", body: '{"a":1}' });
    expect(res.status).toBe(201);
    expect(seen[0]).toMatchObject({ method: "POST", url: "/api/thing?q=1", body: '{"a":1}' });
  });

  it("drops the headers that would stop the page being previewed", async () => {
    const target = await serve((_req, res) => {
      res.writeHead(200, {
        "content-type": "text/html",
        "x-frame-options": "DENY",
        "content-security-policy": "frame-ancestors 'none'",
      });
      res.end("<html><head></head><body>no framing</body></html>");
    });
    proxy = await startPreviewProxy(target);
    const page = await get(`http://127.0.0.1:${proxy.port}/`);
    expect(page.headers.get("x-frame-options")).toBeNull();
    expect(page.headers.get("content-security-policy")).toBeNull();
    expect(page.body).toContain("no framing");
  });

  it("says so, rather than hanging, when nothing is behind it", async () => {
    // a port nobody is on: the proxy answers 502 with words
    proxy = await startPreviewProxy("http://127.0.0.1:1");
    const res = await get(`http://127.0.0.1:${proxy.port}/`);
    expect(res.status).toBe(502);
    expect(res.body).toContain("loom preview");
  });

  it("forwards the socket hot reload rides on", async () => {
    const target = await serve((_req, res) => res.end("ok"));
    // a bare-bones upgrade handshake, the way a dev server answers one
    const held: net.Socket[] = [];
    upstream!.on("upgrade", (_req, socket) => {
      held.push(socket);
      socket.write("HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\nconnection: Upgrade\r\n\r\n");
      socket.write("hello-from-hmr");
    });
    proxy = await startPreviewProxy(target);

    const answer = await new Promise<string>((resolve, reject) => {
      const socket = net.createConnection(proxy!.port, "127.0.0.1", () => {
        socket.write(`GET /hmr HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n`);
      });
      let buf = "";
      socket.on("data", (d) => {
        buf += String(d);
        if (buf.includes("hello-from-hmr")) {
          socket.destroy();
          resolve(buf);
        }
      });
      socket.on("error", reject);
      setTimeout(() => reject(new Error("no upgrade came back")), 8000);
    });
    expect(answer).toContain("101 Switching Protocols");
    expect(answer).toContain("hello-from-hmr");
    for (const s of held) s.destroy();
  }, 20_000);
});
