/**
 * The preview, served through Loom so the page can talk back.
 *
 * A dev server is a different origin from the app, and a browser will not let
 * one origin read another's console. So Loom stands in front of the server: a
 * small proxy on its own port that forwards everything — including the
 * WebSocket a framework's hot reload rides on — and injects one script into
 * HTML responses. That script reports what the page logs, what it fetches and
 * what it threw, by postMessage, which crosses origins by design.
 *
 * What it never does: change the page. The injection is additive, it runs
 * before the app's own code only so it can see the first errors, and nothing
 * else about the response is rewritten.
 */

import http from "node:http";
import net from "node:net";
import { Readable } from "node:stream";

/** How long to wait for a dev server that accepted the connection to answer. */
export const UPSTREAM_TIMEOUT_MS = 20_000;

/** Marker so an injected page is obvious in view-source. */
export const BRIDGE_MARK = "loom-preview-bridge";

/**
 * The script injected into previewed pages.
 *
 * Deliberately small, defensive and silent on failure: a preview that breaks
 * the page it is previewing is worse than no preview. Everything it sends is
 * one shape — {source:"loom-preview", kind, ...} — so the app has one reader.
 */
export function bridgeScript(): string {
  return `<script data-${BRIDGE_MARK}="1">(function(){
  if (window.__loomPreviewBridge) return;
  window.__loomPreviewBridge = 1;
  var send = function(kind, payload){
    try { parent.postMessage({ source: "loom-preview", kind: kind, at: Date.now(), payload: payload }, "*"); } catch (e) {}
  };
  var text = function(v){
    if (typeof v === "string") return v;
    if (v instanceof Error) return v.message + (v.stack ? "\\n" + v.stack : "");
    try { return JSON.stringify(v); } catch (e) { return String(v); }
  };
  ["log", "info", "warn", "error", "debug"].forEach(function(level){
    var original = console[level];
    console[level] = function(){
      try {
        send("console", { level: level, text: Array.prototype.map.call(arguments, text).join(" ").slice(0, 4000) });
      } catch (e) {}
      return original && original.apply(console, arguments);
    };
  });
  window.addEventListener("error", function(e){
    send("console", { level: "error", text: (e.message || "error") + (e.filename ? " (" + e.filename + ":" + e.lineno + ")" : ""), stack: e.error && e.error.stack });
  });
  window.addEventListener("unhandledrejection", function(e){
    send("console", { level: "error", text: "unhandled rejection: " + text(e.reason) });
  });
  var fetchImpl = window.fetch;
  if (fetchImpl) {
    window.fetch = function(input, init){
      var started = Date.now();
      var url = typeof input === "string" ? input : (input && input.url) || String(input);
      var method = (init && init.method) || (input && input.method) || "GET";
      return fetchImpl.apply(this, arguments).then(function(res){
        send("network", { method: method, url: url, status: res.status, ms: Date.now() - started });
        return res;
      }, function(err){
        send("network", { method: method, url: url, status: 0, ms: Date.now() - started, error: text(err) });
        throw err;
      });
    };
  }
  var open = XMLHttpRequest.prototype.open;
  var xhrSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function(method, url){
    this.__loom = { method: method, url: url };
    return open.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function(){
    var self = this;
    var started = Date.now();
    self.addEventListener("loadend", function(){
      var m = self.__loom || {};
      send("network", { method: m.method || "GET", url: m.url || "", status: self.status, ms: Date.now() - started });
    });
    return xhrSend.apply(this, arguments);
  };
  // The picker: Loom asks, the page answers with what's under the cursor.
  var picking = false, box = null, last = null;
  var outline = function(el){
    if (!box) {
      box = document.createElement("div");
      box.style.cssText = "position:fixed;z-index:2147483647;pointer-events:none;border:2px solid #4c8dff;background:rgba(76,141,255,.14);border-radius:2px";
      document.documentElement.appendChild(box);
    }
    var r = el.getBoundingClientRect();
    box.style.left = r.left + "px"; box.style.top = r.top + "px";
    box.style.width = r.width + "px"; box.style.height = r.height + "px";
  };
  var selectorFor = function(el){
    if (el.id) return "#" + el.id;
    var parts = [];
    var node = el;
    for (var depth = 0; node && node.nodeType === 1 && depth < 5; depth++) {
      var part = node.tagName.toLowerCase();
      var testid = node.getAttribute && (node.getAttribute("data-testid") || node.getAttribute("data-test-id"));
      if (testid) { parts.unshift(part + '[data-testid="' + testid + '"]'); break; }
      if (node.classList && node.classList.length) part += "." + Array.prototype.slice.call(node.classList, 0, 2).join(".");
      var parent = node.parentElement;
      if (parent) {
        var same = Array.prototype.filter.call(parent.children, function(c){ return c.tagName === node.tagName; });
        if (same.length > 1) part += ":nth-of-type(" + (same.indexOf(node) + 1) + ")";
      }
      parts.unshift(part);
      node = node.parentElement;
      if (node === document.body) break;
    }
    return parts.join(" > ");
  };
  var onMove = function(e){
    if (!picking) return;
    var el = e.target;
    if (!el || el === box) return;
    last = el;
    outline(el);
  };
  var onClick = function(e){
    if (!picking) return;
    e.preventDefault(); e.stopPropagation();
    var el = last || e.target;
    var r = el.getBoundingClientRect();
    send("picked", {
      selector: selectorFor(el),
      tag: el.tagName.toLowerCase(),
      // innerText is undefined on SVG elements — an icon would answer with
      // nothing at all, which is the click most likely to be about an icon.
      text: String(el.innerText || el.textContent || "").trim().slice(0, 300),
      html: (el.outerHTML || "").slice(0, 1200),
      rect: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) },
      url: location.href,
    });
    stopPicking();
  };
  var stopPicking = function(){
    picking = false;
    if (box) { box.remove(); box = null; }
    document.removeEventListener("mousemove", onMove, true);
    document.removeEventListener("click", onClick, true);
  };
  window.addEventListener("message", function(e){
    var d = e.data || {};
    if (d.source !== "loom-app") return;
    if (d.kind === "pick") {
      picking = true;
      document.addEventListener("mousemove", onMove, true);
      document.addEventListener("click", onClick, true);
    } else if (d.kind === "cancel-pick") {
      stopPicking();
    }
  });
  send("ready", { url: location.href, title: document.title });
})();</script>`;
}

/** Put the bridge first, so it sees what the page does on its way up. */
export function injectBridge(html: string): string {
  const script = bridgeScript();
  if (html.includes(`data-${BRIDGE_MARK}`)) return html;
  const head = html.search(/<head[^>]*>/i);
  if (head >= 0) {
    const end = html.indexOf(">", head) + 1;
    return html.slice(0, end) + script + html.slice(end);
  }
  const body = html.search(/<body[^>]*>/i);
  if (body >= 0) {
    const end = html.indexOf(">", body) + 1;
    return html.slice(0, end) + script + html.slice(end);
  }
  // A fragment, or a page with neither: prepend rather than lose it.
  return script + html;
}

export interface PreviewProxy {
  port: number;
  target: string;
  close: () => Promise<void>;
}

/**
 * Stand in front of `target` (http://host:port) on a port of our own.
 *
 * Everything is forwarded as-is except HTML, which gets the bridge. The
 * WebSocket upgrade is forwarded too — a framework's hot reload rides on it,
 * and a preview that kills HMR would be a downgrade from an iframe.
 */
export async function startPreviewProxy(target: string, host = "127.0.0.1"): Promise<PreviewProxy> {
  const to = new URL(target);
  const server = http.createServer((req, res) => {
    const upstream = http.request(
      {
        host: to.hostname,
        port: to.port || 80,
        method: req.method,
        path: req.url,
        headers: { ...req.headers, host: to.host, "accept-encoding": "identity" },
      },
      (up) => {
        const type = String(up.headers["content-type"] ?? "");
        if (!/text\/html/i.test(type)) {
          res.writeHead(up.statusCode ?? 200, up.headers);
          up.pipe(res);
          return;
        }
        const chunks: Buffer[] = [];
        up.on("data", (c: Buffer) => chunks.push(c));
        up.on("end", () => {
          const body = injectBridge(Buffer.concat(chunks).toString("utf8"));
          const headers = { ...up.headers };
          // We buffered it to inject, so the framing is ours now: a chunked
          // header kept beside a content-length is an invalid response, and
          // the browser drops the page rather than showing it.
          delete headers["content-length"];
          delete headers["transfer-encoding"];
          // The page must not be embedded-blocked by its own dev server.
          delete headers["x-frame-options"];
          delete headers["content-security-policy"];
          res.writeHead(up.statusCode ?? 200, { ...headers, "content-length": Buffer.byteLength(body) });
          res.end(body);
        });
      },
    );
    upstream.on("error", (err) => {
      if (res.headersSent) return void res.end();
      res.writeHead(502, { "content-type": "text/plain" });
      res.end(`loom preview: the server didn't answer (${err.message})`);
    });
    // A server that accepts the connection and then says nothing would hold
    // the preview open for ever. Say so instead.
    upstream.setTimeout(UPSTREAM_TIMEOUT_MS, () => {
      upstream.destroy();
      if (res.headersSent) return void res.end();
      res.writeHead(504, { "content-type": "text/plain" });
      res.end("loom preview: the server accepted the connection but never answered");
    });
    Readable.from(req).pipe(upstream);
  });

  // An upgraded socket is nobody's connection once it's hijacked: server.close()
  // waits for it for ever unless we keep the pair and end them ourselves.
  const upgraded = new Set<import("node:stream").Duplex>();

  // HMR and anything else the page opens a socket for.
  server.on("upgrade", (req, socket, head) => {
    upgraded.add(socket);
    socket.on("close", () => upgraded.delete(socket));
    const up = http.request({
      host: to.hostname,
      port: to.port || 80,
      method: req.method,
      path: req.url,
      headers: { ...req.headers, host: to.host },
      // A pooled agent never surfaces the upgrade — the socket has to be ours.
      agent: false,
    });
    up.on("upgrade", (upRes, upSocket, upHead) => {
      socket.write(
        `HTTP/1.1 101 Switching Protocols\r\n${Object.entries(upRes.headers)
          .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(", ") : v}`)
          .join("\r\n")}\r\n\r\n`,
      );
      // Whatever the server sent in the same packet as its 101 goes OUT to the
      // client — unshifting it would feed the server's bytes back in as if the
      // client had sent them, and the first hot-reload message would vanish.
      if (upHead?.length) socket.write(upHead);
      upgraded.add(upSocket);
      upSocket.on("close", () => upgraded.delete(upSocket));
      upSocket.pipe(socket);
      socket.pipe(upSocket);
      upSocket.on("error", () => socket.destroy());
      socket.on("error", () => upSocket.destroy());
    });
    up.on("error", () => socket.destroy());
    if (head?.length) up.write(head);
    up.end();
  });

  const port = await new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, host, () => resolve((server.address() as net.AddressInfo).port));
  });

  return {
    port,
    target,
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of upgraded) s.destroy();
        upgraded.clear();
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}
