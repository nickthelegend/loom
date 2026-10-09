/**
 * The preview, served through Loom.
 *
 * A real upstream server, a real proxy in front of it, and real requests: the
 * page must arrive intact with one script added, everything that isn't HTML
 * must arrive byte for byte, and the socket a framework's hot reload rides on
 * must still connect. A preview that changes the page it previews is worse
 * than no preview at all.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  BRIDGE_MARK,
  bridgeScript,
  frameability,
  injectBridge,
  injectBytes,
  isLoopbackHost,
  rewriteLocation,
  startPreviewProxy,
  type PreviewProxy,
} from "../src/core/preview-proxy.js";
import { tmpDir } from "./helpers.js";

let proxy: PreviewProxy | null = null;
let upstream: http.Server | https.Server | null = null;
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

  it("answers when the server accepts the connection and then says nothing", async () => {
    // the worst kind of broken server: the socket opens, the page never comes
    const target = await serve(() => {
      /* deliberately no response */
    });
    proxy = await startPreviewProxy(target);
    const res = await get(`http://127.0.0.1:${proxy.port}/`);
    expect(res.status).toBe(504);
    expect(res.body).toContain("never answered");
  }, 60_000);

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

describe("the bridge's newer duties", () => {
  it("can go back and forward, follows a single-page app, and says whether the page hot-reloads", () => {
    const js = bridgeScript();
    expect(js).toContain('d.kind === "history"');
    expect(js).toContain("history.go(n)");
    expect(js).toContain('send("nav"');
    expect(js).toContain('send("hmr"');
    expect(js).toMatch(/send\("ready", \{[^}]*hmr:/);
    // and only takes orders from the window that framed it
    expect(js).toContain("e.source !== parent");
  });

  it("is pure ASCII, so it can go into a page in any ASCII-based charset", () => {
    expect(/^[\x00-\x7f]*$/.test(bridgeScript())).toBe(true);
  });
});

describe("which hosts are this machine", () => {
  it("knows loopback by name and number, and isn't fooled by a prefix", () => {
    for (const h of ["localhost", "127.0.0.1", "127.3.2.1", "[::1]", "::1", "app.localhost"]) expect(isLoopbackHost(h), h).toBe(true);
    for (const h of ["localhost.evil.com", "127.0.0.1.nip.io", "example.com", "10.0.0.1", "0.0.0.0"]) expect(isLoopbackHost(h), h).toBe(false);
  });
});

describe("redirects", () => {
  it("points the upstream's own absolute redirects back through the proxy", () => {
    const t = "http://127.0.0.1:5173";
    expect(rewriteLocation("http://127.0.0.1:5173/login?x=1", t, "http://127.0.0.1:9000")).toBe("http://127.0.0.1:9000/login?x=1");
    // localhost and 127.0.0.1 on the same port are the same server
    expect(rewriteLocation("http://localhost:5173/a", t, "http://127.0.0.1:9000")).toBe("http://127.0.0.1:9000/a");
    expect(rewriteLocation("//127.0.0.1:5173/b", t, "http://127.0.0.1:9000")).toBe("http://127.0.0.1:9000/b");
    // somewhere else, or a path, is left alone
    expect(rewriteLocation("https://accounts.example.com/sso", t, "http://127.0.0.1:9000")).toBe("https://accounts.example.com/sso");
    expect(rewriteLocation("http://127.0.0.1:4000/x", t, "http://127.0.0.1:9000")).toBe("http://127.0.0.1:4000/x");
    expect(rewriteLocation("/relative", t, "http://127.0.0.1:9000")).toBe("/relative");
  });

  it("does it on the wire, too", async () => {
    let base = "";
    const target = await serve((req, res) => {
      if (req.url === "/old") {
        res.writeHead(302, { location: `${base}/new` });
        return res.end();
      }
      res.writeHead(302, { location: "https://elsewhere.example/" });
      res.end();
    });
    base = target;
    proxy = await startPreviewProxy(target);
    const own = await fetch(`http://127.0.0.1:${proxy.port}/old`, { redirect: "manual" });
    expect(own.headers.get("location")).toBe(`http://127.0.0.1:${proxy.port}/new`);
    const away = await fetch(`http://127.0.0.1:${proxy.port}/away`, { redirect: "manual" });
    expect(away.headers.get("location")).toBe("https://elsewhere.example/");
  });
});

describe("responses with nothing to inject into", () => {
  it("leaves HEAD, 204 and 304 alone", async () => {
    const target = await serve((req, res) => {
      if (req.url === "/204") { res.writeHead(204, { "content-type": "text/html" }); return res.end(); }
      if (req.url === "/304") { res.writeHead(304, { "content-type": "text/html", etag: '"a"' }); return res.end(); }
      res.writeHead(200, { "content-type": "text/html", "content-length": "26" });
      res.end(req.method === "HEAD" ? undefined : "<html><head></head></html>");
    });
    proxy = await startPreviewProxy(target);
    const head = await fetch(`http://127.0.0.1:${proxy.port}/`, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(head.headers.get("content-length")).toBe("26"); // the page's own length, not the injected one
    const empty = await fetch(`http://127.0.0.1:${proxy.port}/204`);
    expect(empty.status).toBe(204);
    expect(await empty.text()).toBe("");
    const same = await fetch(`http://127.0.0.1:${proxy.port}/304`);
    expect(same.status).toBe(304);
  });
});

describe("pages that aren't UTF-8", () => {
  it("keeps every byte of a latin1 page and still adds the bridge", async () => {
    // "café" in latin1 is 63 61 66 e9 — not valid UTF-8, and a decode/encode
    // round trip through utf8 would turn the é into a replacement character.
    const page = Buffer.concat([Buffer.from("<html><head></head><body>caf"), Buffer.from([0xe9]), Buffer.from("</body></html>")]);
    const target = await serve((_req, res) => {
      res.writeHead(200, { "content-type": "text/html; charset=iso-8859-1" });
      res.end(page);
    });
    proxy = await startPreviewProxy(target);
    const body = Buffer.from(await (await fetch(`http://127.0.0.1:${proxy.port}/`)).arrayBuffer());
    expect(body.toString("latin1")).toContain(BRIDGE_MARK);
    expect(body.includes(Buffer.concat([Buffer.from("caf"), Buffer.from([0xe9]), Buffer.from("</body>")]))).toBe(true);
  });

  it("leaves a UTF-16 page exactly as it was rather than corrupt it", () => {
    const utf16 = Buffer.from("﻿<html><head></head></html>", "utf16le");
    expect(injectBytes(utf16, "text/html; charset=utf-16")).toBeNull();
    expect(injectBytes(utf16, "text/html")).toBeNull(); // the BOM says so even when the header doesn't
    expect(injectBytes(Buffer.from("<head></head>"), "text/html; charset=UTF-8")!.toString()).toContain(BRIDGE_MARK);
  });
});

describe("pages that refuse to be framed", () => {
  it("reads X-Frame-Options and frame-ancestors the way a browser does", () => {
    expect(frameability("DENY", null).frameable).toBe(false);
    expect(frameability("sameorigin", null).frameable).toBe(false);
    expect(frameability(null, "default-src 'self'; frame-ancestors 'self'").frameable).toBe(false);
    expect(frameability(null, "frame-ancestors 'none'").frameable).toBe(false);
    expect(frameability(null, "frame-ancestors *").frameable).toBe(true);
    expect(frameability(null, "default-src 'self'").frameable).toBe(true);
    expect(frameability(null, null).frameable).toBe(true);
  });
});

/** A throwaway self-signed certificate, the kind a dev server's basic-ssl makes. */
function selfSigned(): { key: Buffer; cert: Buffer } | null {
  const dir = tmpDir("cert");
  try {
    execFileSync("openssl", [
      "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=localhost",
      "-keyout", path.join(dir, "key.pem"), "-out", path.join(dir, "cert.pem"),
    ], { stdio: "ignore" });
    return { key: fs.readFileSync(path.join(dir, "key.pem")), cert: fs.readFileSync(path.join(dir, "cert.pem")) };
  } catch {
    return null;
  }
}

describe("an https dev server", () => {
  const tls = selfSigned();
  it.skipIf(!tls)("is spoken to over TLS, self-signed and all, because it's on this machine", async () => {
    upstream = https.createServer({ key: tls!.key, cert: tls!.cert }, (_req, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<html><head></head><body>secure</body></html>");
    });
    const port = await new Promise<number>((resolve) => {
      upstream!.listen(0, "127.0.0.1", () => resolve((upstream!.address() as net.AddressInfo).port));
    });
    proxy = await startPreviewProxy(`https://127.0.0.1:${port}`);
    const page = await get(`http://127.0.0.1:${proxy.port}/`);
    expect(page.status).toBe(200);
    expect(page.body).toContain("secure");
    expect(page.body).toContain(BRIDGE_MARK);
  });
});
