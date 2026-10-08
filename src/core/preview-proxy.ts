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
 * What it never does on its own: change the page. The injection is additive,
 * it runs before the app's own code only so it can see the first errors, and
 * nothing else about the response is rewritten. The one thing that does alter
 * the page is the colour-scheme toggle, and only while you hold it: it
 * re-points the page's own `prefers-color-scheme` rules and puts every one of
 * them back, exactly as it found them, when you go back to Auto.
 */

import http from "node:http";
import https from "node:https";
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
  return ascii(BRIDGE_SOURCE);
}

/**
 * Pure ASCII, so it can be spliced into a page's bytes whatever ASCII-based
 * charset the page is in (see injectBytes). Only comments and string literals
 * ever held anything else, and \uXXXX means the same thing in both.
 */
function ascii(js: string): string {
  return js.replace(/[^\x00-\x7f]/g, (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));
}

const BRIDGE_SOURCE = `<script data-${BRIDGE_MARK}="1">(function(){
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
  // ---- colour scheme -------------------------------------------------
  // No API lets a parent document set another page's prefers-color-scheme.
  // But Loom is not outside this page: the proxy served it AND its
  // stylesheets, so the rules are readable and the media queries can be
  // re-pointed. Pages theme in three ways, so forcing is three things:
  // the UA's own colour-scheme, the @media rules in the CSS, and the
  // matchMedia() a script asked. Reverting is exact — every rule remembers
  // the media text it came with, so "auto" is the page as it shipped.
  var forced = null;
  var mqls = [];
  var saved = [];
  var reading = 0;
  var unreadable = 0;
  var mmReal = window.matchMedia && window.matchMedia.bind(window);
  var wants = function(q){ return /dark/i.test(String(q)) ? "dark" : /light/i.test(String(q)) ? "light" : ""; };
  var forceMql = function(mql, q){
    var side = wants(q);
    try {
      if (forced === null || !side) { delete mql.matches; return; }
      var v = side === forced;
      Object.defineProperty(mql, "matches", { configurable: true, get: function(){ return v; } });
    } catch (e) {}
  };
  var fire = function(mql){
    try {
      var ev;
      try { ev = new MediaQueryListEvent("change", { matches: mql.matches, media: mql.media }); }
      catch (e) { ev = new Event("change"); }
      mql.dispatchEvent(ev);
    } catch (e) {}
  };
  if (mmReal) {
    window.matchMedia = function(q){
      var mql = mmReal(q);
      if (/prefers-color-scheme/i.test(String(q))) {
        mqls.push({ mql: mql, q: q });
        forceMql(mql, q);
      }
      return mql;
    };
  }
  var walk = function(rules, depth){
    if (!rules || depth > 4) return;
    for (var i = 0; i < rules.length; i++) {
      var rule = rules[i];
      var media = rule.media && rule.media.mediaText;
      if (media && /prefers-color-scheme/i.test(media)) {
        saved.push({ rule: rule, text: media });
        try { rule.media.mediaText = wants(media) === forced ? "all" : "not all"; }
        catch (e) { unreadable++; }
      }
      if (rule.cssRules) walk(rule.cssRules, depth + 1);
    }
  };
  var applyScheme = function(){
    reading = 0; unreadable = 0;
    // Always put the page back first, then force. A forced rule reads "all",
    // which no longer mentions prefers-color-scheme — so a rule rewritten once
    // can never be found again, and dark → light would have been a one-way
    // door if this went straight to forcing.
    for (var r = 0; r < saved.length; r++) {
      try { saved[r].rule.media.mediaText = saved[r].text; } catch (e) { unreadable++; }
    }
    saved = [];
    if (forced !== null) {
      var sheets = document.styleSheets || [];
      for (var i = 0; i < sheets.length; i++) {
        try { walk(sheets[i].cssRules, 0); reading++; }
        catch (e) { unreadable++; } // a stylesheet from somewhere Loom doesn't serve
      }
    }
    try {
      document.documentElement.style.colorScheme = forced || "";
    } catch (e) {}
    for (var m = 0; m < mqls.length; m++) { forceMql(mqls[m].mql, mqls[m].q); fire(mqls[m].mql); }
    send("scheme", { scheme: forced, sheets: reading, unreadable: unreadable });
  };
  // A framework that hot-reloads adds stylesheets after we've forced them.
  try {
    var pending = null;
    new MutationObserver(function(){
      if (forced === null || pending) return;
      pending = setTimeout(function(){ pending = null; applyScheme(); }, 120);
    }).observe(document.documentElement, { childList: true, subtree: true });
  } catch (e) {}

  // Back and forward, asked for by the app's own buttons: the page is another
  // origin, so its history is only reachable from in here.
  var go = function(n){ try { history.go(n); } catch (e) {} };
  window.addEventListener("message", function(e){
    // Only the window that framed this page gives it orders — never a popup
    // or a sibling frame. (A message with no source is a test harness.)
    if (e.source && e.source !== parent) return;
    var d = e.data || {};
    if (d.source !== "loom-app") return;
    if (d.kind === "pick") {
      picking = true;
      document.addEventListener("mousemove", onMove, true);
      document.addEventListener("click", onClick, true);
    } else if (d.kind === "cancel-pick") {
      stopPicking();
    } else if (d.kind === "scheme") {
      forced = d.value === "dark" ? "dark" : d.value === "light" ? "light" : null;
      applyScheme();
    } else if (d.kind === "history") {
      if (d.go === -1 || d.go === 1) go(d.go);
    }
  });
  // Does this page update itself? A dev server with hot module reload swaps
  // code in place, and a hard reload from Loom would throw its state away.
  // The bridge runs before the page's own scripts, so ask once now and again
  // when the page has loaded — the HMR client is one of those scripts.
  var hmr = function(){
    try {
      if (window.__vite_plugin_react_preamble_installed__ || window.__vite_is_modern_browser) return "vite";
      if (document.querySelector('script[src*="/@vite/client"],script[src*="@react-refresh"]')) return "vite";
      if (window.webpackHotUpdate || window.__webpack_hmr || window.__NEXT_HMR_CB || window.__NEXT_DATA__ && window.next) return "webpack";
      for (var k in window) { if (/^webpackHotUpdate/.test(k)) return "webpack"; }
    } catch (e) {}
    return "";
  };
  send("ready", { url: location.href, title: document.title, hmr: !!hmr() });
  // A single-page app moves without loading a page: say where it went, so the
  // address bar (and what Reload and Screenshot point at) follows.
  var lastHref = location.href;
  var moved = function(){
    if (location.href === lastHref) return;
    lastHref = location.href;
    send("nav", { url: location.href, title: document.title });
  };
  ["pushState", "replaceState"].forEach(function(name){
    var original = history[name];
    if (typeof original !== "function") return;
    history[name] = function(){
      var out = original.apply(this, arguments);
      try { moved(); } catch (e) {}
      return out;
    };
  });
  window.addEventListener("popstate", moved);
  window.addEventListener("hashchange", moved);
  var hmrLater = function(){ var h = hmr(); if (h) send("hmr", { hmr: true, kind: h }); };
  if (document.readyState === "complete") setTimeout(hmrLater, 0);
  else window.addEventListener("load", function(){ setTimeout(hmrLater, 300); });
})();</script>`;

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

/** A host that is this machine — the only kind the preview will stand in front of on its own. */
export function isLoopbackHost(hostname: string): boolean {
  const h = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return h === "localhost" || h.endsWith(".localhost") || h === "::1" || /^127(\.\d{1,3}){3}$/.test(h);
}

const portOf = (u: URL): string => u.port || (u.protocol === "https:" ? "443" : "80");

/** Is `loc` the upstream itself (allowing localhost ≡ 127.0.0.1 on the same port)? */
function isUpstream(loc: URL, to: URL): boolean {
  if (loc.origin === to.origin) return true;
  return loc.protocol === to.protocol && portOf(loc) === portOf(to) && isLoopbackHost(loc.hostname) && isLoopbackHost(to.hostname);
}

/**
 * A redirect the dev server sent with its own absolute address would walk the
 * frame off the proxy (and lose the bridge). Point it back through us.
 */
export function rewriteLocation(location: string, target: string, proxyOrigin: string): string {
  let loc: URL;
  try {
    loc = new URL(location, target);
  } catch {
    return location;
  }
  if (!/^([a-z][a-z0-9+.-]*:)?\/\//i.test(location)) return location; // a path: already ours
  if (!isUpstream(loc, new URL(target))) return location;
  return proxyOrigin + loc.pathname + loc.search + loc.hash;
}

/**
 * Will a browser show this page inside a frame on another origin? Read off the
 * two headers that decide it, so a page that refuses can be said to refuse
 * instead of leaving a white rectangle.
 */
export function frameability(xFrameOptions: string | null, csp: string | null): { frameable: boolean; reason: string } {
  const xfo = (xFrameOptions ?? "").trim().toLowerCase();
  if (xfo === "deny" || xfo === "sameorigin") return { frameable: false, reason: `X-Frame-Options: ${xfo.toUpperCase()}` };
  for (const policy of (csp ?? "").split(",")) {
    const directive = policy.split(";").map((d) => d.trim()).find((d) => /^frame-ancestors(\s|$)/i.test(d));
    if (!directive) continue;
    const sources = directive.split(/\s+/).slice(1);
    // only a wildcard lets an unrelated app frame it; 'self', 'none' or a list of hosts don't
    if (!sources.some((x) => x === "*" || /^https?:$/i.test(x))) {
      return { frameable: false, reason: `Content-Security-Policy: ${directive}` };
    }
  }
  return { frameable: true, reason: "" };
}

/** Charsets whose bytes for `<`, `h`, `e`… are ASCII's — the bridge can be spliced into them as bytes. */
const ASCII_BASED = /^(utf-?8|us-ascii|ascii|iso-?8859-\d+|latin-?1|windows-125\d|cp125\d|koi8-[ru]|shift_jis|sjis|euc-jp|euc-kr|gbk|gb2312|gb18030|big5)$/i;

/**
 * The bridge, in a page given as bytes. Decoding as latin1 maps every byte to
 * one code unit and back, so whatever the page's own encoding, every byte that
 * isn't the script comes out exactly as it went in.
 */
export function injectBytes(body: Buffer, contentType: string): Buffer | null {
  const charset = /charset\s*=\s*"?([^";\s]+)/i.exec(contentType)?.[1];
  if (charset && !ASCII_BASED.test(charset)) return null; // UTF-16 and friends: leave it be
  // A byte-order mark for UTF-16/32 means the same, whatever the header said.
  if (body.length >= 2 && ((body[0] === 0xfe && body[1] === 0xff) || (body[0] === 0xff && body[1] === 0xfe))) return null;
  return Buffer.from(injectBridge(body.toString("latin1")), "latin1");
}

/**
 * Stand in front of `target` (http(s)://host:port) on a port of our own.
 *
 * Everything is forwarded as-is except HTML, which gets the bridge. The
 * WebSocket upgrade is forwarded too — a framework's hot reload rides on it,
 * and a preview that kills HMR would be a downgrade from an iframe.
 *
 * An https upstream is spoken to over TLS; a self-signed certificate is
 * accepted only from this machine (a dev server's mkcert or vite's basic-ssl),
 * never from anywhere else.
 */
export async function startPreviewProxy(target: string, host = "127.0.0.1"): Promise<PreviewProxy> {
  const to = new URL(target);
  const secure = to.protocol === "https:";
  if (!secure && to.protocol !== "http:") throw new Error(`can't preview ${to.protocol} — only http and https`);
  const lib: typeof http | typeof https = secure ? https : http;
  const upstreamHost = to.hostname.replace(/^\[|\]$/g, "");
  const upstreamPort = Number(portOf(to));
  const tls = secure ? { rejectUnauthorized: !isLoopbackHost(to.hostname), servername: net.isIP(upstreamHost) ? undefined : upstreamHost } : {};
  let ownPort = 0;
  const proxyOrigin = (req: http.IncomingMessage) => `http://${req.headers.host ?? `${host}:${ownPort}`}`;

  /** The browser's headers, as the upstream expects to see them. */
  const forwardHeaders = (req: http.IncomingMessage): http.OutgoingHttpHeaders => {
    const headers: http.OutgoingHttpHeaders = { ...req.headers, host: to.host };
    // A server checking Origin/Referer (CSRF, CORS) should see itself, not us.
    const self = proxyOrigin(req);
    for (const k of ["origin", "referer"] as const) {
      const v = req.headers[k];
      if (typeof v === "string" && v.startsWith(self)) headers[k] = to.origin + v.slice(self.length);
    }
    return headers;
  };

  const server = http.createServer((req, res) => {
    const upstream = lib.request(
      {
        host: upstreamHost,
        port: upstreamPort,
        method: req.method,
        path: req.url,
        headers: { ...forwardHeaders(req), "accept-encoding": "identity" },
        ...tls,
      },
      (up) => {
        const status = up.statusCode ?? 200;
        const headers = { ...up.headers };
        if (typeof headers.location === "string") headers.location = rewriteLocation(headers.location, to.href, proxyOrigin(req));
        const type = String(headers["content-type"] ?? "");
        const html = /text\/html/i.test(type);
        if (html) {
          // The page must not be embedded-blocked by its own dev server.
          delete headers["x-frame-options"];
          delete headers["content-security-policy"];
        }
        const encoded = !!headers["content-encoding"] && headers["content-encoding"] !== "identity";
        // Nothing to put a script into: not a page, no body, or one we can't read.
        if (!html || encoded || req.method === "HEAD" || status === 204 || status === 304 || (status >= 100 && status < 200)) {
          res.writeHead(status, headers);
          up.pipe(res);
          return;
        }
        const chunks: Buffer[] = [];
        up.on("data", (c: Buffer) => chunks.push(c));
        up.on("end", () => {
          const raw = Buffer.concat(chunks);
          const body = injectBytes(raw, type) ?? raw;
          // We buffered it to inject, so the framing is ours now: a chunked
          // header kept beside a content-length is an invalid response, and
          // the browser drops the page rather than showing it.
          delete headers["content-length"];
          delete headers["transfer-encoding"];
          res.writeHead(status, { ...headers, "content-length": body.length });
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
    const up = lib.request({
      host: upstreamHost,
      port: upstreamPort,
      method: req.method,
      path: req.url,
      headers: forwardHeaders(req),
      // A pooled agent never surfaces the upgrade — the socket has to be ours.
      agent: false,
      ...tls,
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
    // Refused the upgrade: hand its answer back rather than hanging up mute.
    up.on("response", (upRes) => {
      socket.end(`HTTP/1.1 ${upRes.statusCode ?? 502} ${upRes.statusMessage ?? ""}\r\nconnection: close\r\n\r\n`);
      upRes.resume();
    });
    up.on("error", () => socket.destroy());
    if (head?.length) up.write(head);
    up.end();
  });

  const port = await new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, host, () => resolve((server.address() as net.AddressInfo).port));
  });
  ownPort = port;

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
