/** Browser preview module. See README.md for ownership and startup. */
import { api } from './connection.js';
import { esc } from './format.js';
import { ICONS } from './icons.js';
import { toast } from './notifications.js';
import { state } from './state.js';


  // ---- Browser -------------------------------------------------------------
  // A live page and the project's Playwright specs, in the dock beside the
  // terminals. An agent writes a browser test; this is where you watch it run
  // and — when it fails — hand the failure straight back to whoever wrote it.
  //
  // All of it belongs to one project (brow.pid): resetBrowser() is called on
  // every mount, and a different project starts from nothing — another
  // project's page, specs, run and width have no business in this one's pane.
  //
  // url is what the address bar shows (the dev server's own address, the one a
  // person thinks in); src is what the frame is really on (Loom's proxy, when
  // bridged). proxy/upstream are the two origins that map one to the other.
  var brow = {
    pid: null, present: false, specs: null, running: null, stopping: false, out: [], lastFail: null, playwright: true,
    url: "", src: "", width: 0, scheme: "", relTimer: null, bridged: false,
    proxy: "", upstream: "", ready: false, hmr: false, loaded: false, readyTimer: null, ro: null, seq: 0,
  };


  // ---- dev servers (core/servers.ts) --------------------------------------
  // What this project runs, and what it's doing right now. "running" means a
  // port answered — a process that exists but never listens stays "starting",
  // which is the honest thing to say about it.
  var srv = { list: [], suggested: [], log: null, lines: [], busy: {}, err: "" };


  function loadServers(){
    var el = document.getElementById("srvlist");
    if (!state.pid) {
      if (el) el.innerHTML = '<div class="specempty">Open a project to see its servers.</div>';
      return;
    }
    var pid = state.pid;
    api("/api/projects/" + pid + "/servers").then(function(j){
      if (pid !== state.pid) return; // the project we just left
      srv.list = j.servers || [];
      srv.suggested = j.suggested || [];
      srv.err = "";
      drawServers();
    }).catch(function(e){
      if (pid !== state.pid) return;
      // A spinner that never stops is a lie: say what went wrong.
      srv.err = e.message;
      if (el) el.innerHTML = '<div class="specempty">' + esc(e.message) + "</div>";
    });
  }


  function serverUrl(s){
    if (s.url) return s.url;
    return s.port ? "http://localhost:" + s.port : null;
  }


  function drawServers(){
    var el = document.getElementById("srvlist"); if (!el) return;
    if (!srv.list.length) {
      el.innerHTML = '<div class="specempty">No dev servers configured.' +
        (srv.suggested.length
          ? "<br>package.json suggests <b>" + srv.suggested.map(function(x){ return esc(x.name); }).join("</b>, <b>") + "</b>" +
            ' — <button class="linkbtn" id="srvadopt">add them</button>'
          : '<br>Add them under <code>servers</code> in <code>.loom/config.json</code>.') +
        "</div>";
      var adopt = document.getElementById("srvadopt");
      if (adopt) adopt.onclick = function(){
        api("/api/projects/" + state.pid + "/servers", { method: "POST", body: JSON.stringify({ servers: srv.suggested }) })
          .then(function(j){ srv.list = j.servers || []; drawServers(); toast("added " + srv.list.length + " server" + (srv.list.length === 1 ? "" : "s")); })
          .catch(function(e){ toast(e.message); });
      };
      return;
    }
    el.innerHTML = srv.list.map(function(s){
      var st = s.state;
      var cls = st === "running" ? "ok" : st === "starting" ? "warn" : st === "crashed" ? "err" : "off";
      var why = st === "crashed" && s.exitCode !== null && s.exitCode !== undefined ? " · exit " + s.exitCode : "";
      var up = s.startedAt ? " · " + Math.max(1, Math.round((Date.now() - s.startedAt) / 1000)) + "s" : "";
      return '<div class="srvrow" data-srv="' + esc(s.name) + '">' +
        '<span class="sdot ' + cls + '"></span>' +
        '<span class="nm">' + esc(s.name) + "</span>" +
        '<span class="st">' + esc(st) + esc(why) + esc(up) + "</span>" +
        '<span class="acts">' +
        (st === "running" || st === "starting"
          ? '<button class="iconbtn xs" data-act="stop" title="stop">' + ICONS.stop + "</button>"
          : '<button class="iconbtn xs" data-act="start" title="start">' + ICONS.play + "</button>") +
        '<button class="iconbtn xs" data-act="restart" title="restart">' + ICONS.refresh + "</button>" +
        '<button class="iconbtn xs" data-act="log" title="output">' + ICONS.console + "</button>" +
        "</span></div>";
    }).join("");
    Array.prototype.forEach.call(el.querySelectorAll(".srvrow"), function(row){
      var name = row.getAttribute("data-srv");
      var s = srv.list.filter(function(x){ return x.name === name; })[0] || {};
      // The row itself points the preview at the server — the reason it's here.
      row.onclick = function(ev){
        if (ev.target.closest("[data-act]")) return;
        var url = serverUrl(s);
        if (!url) return toast(name + " has no port or url to preview");
        setAddress(url);
        closeRail();
        // Through Loom's own proxy: same page, plus a script that reports what
        // it logs and fetches. Falling back to the plain URL keeps the preview
        // working even when the proxy can't start.
        var seq = ++brow.seq, pid = state.pid;
        api("/api/projects/" + pid + "/servers/" + encodeURIComponent(name) + "/preview", { method: "POST", body: "{}" })
          .then(function(j){ if (current(seq, pid)) showProxied(j.url, originOf(j.target) || originOf(url), url); })
          .catch(function(){ if (current(seq, pid)) showDirect(url); });
      };
      Array.prototype.forEach.call(row.querySelectorAll("[data-act]"), function(b){
        b.onclick = function(ev){
          ev.stopPropagation();
          var act = b.getAttribute("data-act");
          if (act === "log") return showServerLog(name);
          srv.busy[name] = true;
          api("/api/projects/" + state.pid + "/servers/" + encodeURIComponent(name) + "/" + act, { method: "POST", body: "{}" })
            .then(function(){ delete srv.busy[name]; loadServers(); })
            .catch(function(e){ delete srv.busy[name]; toast(e.message); });
        };
      });
    });
  }


  /** A server's own output, under the page it serves. */
  function showServerLog(name){
    srv.log = name;
    var wrap = document.getElementById("srvlog");
    var title = document.getElementById("srvlogname");
    if (title) title.textContent = name;
    if (wrap) wrap.style.display = "flex";
    var close = document.getElementById("srvlogclose");
    if (close) close.onclick = function(){ srv.log = null; wrap.style.display = "none"; };
    api("/api/projects/" + state.pid + "/servers/" + encodeURIComponent(name) + "/log?limit=200")
      .then(function(j){ srv.lines = j.lines || []; drawServerLog(); })
      .catch(function(e){ toast(e.message); });
  }


  function drawServerLog(){
    var el = document.getElementById("srvloglines"); if (!el) return;
    var atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    el.innerHTML = srv.lines.map(function(l){
      return '<div class="' + (l.stream === "err" ? "e" : l.stream === "loom" ? "m" : "") + '">' + esc(l.text) + "</div>";
    }).join("");
    if (atBottom) el.scrollTop = el.scrollHeight;
  }


  /** Live: a state change repaints the row, a line lands in the open log. */
  function onServerFrame(f){
    if (!f || f.projectId !== state.pid) return;
    if (f.kind === "state" && f.status) {
      var found = false;
      srv.list = srv.list.map(function(x){
        if (x.name !== f.name) return x;
        found = true;
        return f.status;
      });
      if (!found) srv.list.push(f.status);
      drawServers();
      if (f.status.state === "crashed") toast(f.name + " exited (code " + f.status.exitCode + ")");
    } else if (f.kind === "line" && f.name === srv.log) {
      srv.lines.push(f.line);
      if (srv.lines.length > 500) srv.lines.shift();
      drawServerLog();
    }
  }


  function drawBrowser(){
    var stop = document.getElementById("specstop");
    if (stop) stop.style.display = brow.running ? "" : "none";
    var list = document.getElementById("speclist"); if (!list) return;
    if (brow.specs === null) { return; } // still loading — the loader is in place
    if (!brow.specs.length) {
      list.innerHTML = brow.playwright
        ? '<div class="specempty">No Playwright specs here yet.<br>' +
          "Ask an agent for one \u2014 <i>\u201cwrite a Playwright spec for the login page\u201d</i> \u2014 " +
          "and it appears in this list.</div>"
        : '<div class="specempty">This project doesn\u2019t use Playwright \u2014 no <code>playwright.config</code> and no ' +
          "<code>@playwright/test</code> in package.json.<br>Ask an agent to set it up, and its specs appear here.</div>";
      return;
    }
    list.innerHTML = brow.specs.map(function(s){
      var running = brow.running && brow.running.file === s.path;
      return '<div class="specrow' + (running ? " running" : "") + '" data-spec="' + esc(s.path) + '" title="' +
        (running ? "running \u2014 click to stop" : "run " + esc(s.path)) + '">' +
        '<span class="nm">' + esc(s.path) + "</span>" +
        (running ? '<span class="busy" style="width:8px;height:8px;color:var(--live)"></span>' +
                   '<span class="go stop" data-specstop="1">' + ICONS.stop + "</span>"
                 : '<span class="go">' + ICONS.play + "</span>") +
        "</div>";
    }).join("");
    Array.prototype.forEach.call(list.querySelectorAll("[data-spec]"), function(row){
      row.onclick = function(){
        var file = row.getAttribute("data-spec");
        if (brow.running && brow.running.file === file) stopSpec();
        else runSpec(file);
      };
    });
  }


  /**
   * A line of a spec run's output. Kept whether or not the pane is on screen —
   * a run outlives a tab switch, and its output is what you came back for.
   */
  function specPrint(line, cls){
    brow.out.push({ t: line, c: cls || "" });
    if (brow.out.length > 400) brow.out.shift();
    drawSpecOut();
  }


  /** The run's output, and — when it failed — the button that hands it back. */
  function drawSpecOut(){
    var out = document.getElementById("specout"); if (!out) return;
    if (!brow.out.length) { out.innerHTML = ""; out.style.display = "none"; return; }
    out.style.display = "";
    var atBottom = out.scrollHeight - out.scrollTop - out.clientHeight < 30;
    out.innerHTML = brow.out.map(function(l){
      return '<div class="' + l.c + '">' + esc(l.t) + "</div>";
    }).join("");
    if (brow.lastFail && !brow.running) {
      // The button that closes the loop: the failure goes back to an agent as a
      // normal message, so whoever wrote the test gets the reporter's own words.
      var b = document.createElement("button");
      b.className = "btn";
      b.style.cssText = "margin:8px 0 4px";
      b.textContent = "send failure to agent";
      b.onclick = function(){
        var box = document.getElementById("box");
        if (!box || !brow.lastFail) return;
        box.value = "The Playwright spec " + brow.lastFail.file + " is failing:\n\n```\n" +
          brow.lastFail.tail.join("\n") + "\n```\n\nFix the app or the spec, whichever is wrong.";
        box.focus();
        toast("failure staged in the composer \u2014 pick the agent and send");
      };
      out.appendChild(b);
      atBottom = true;
    }
    if (atBottom) out.scrollTop = out.scrollHeight;
  }


  function refreshSpecs(){
    if (!state.pid) return;
    var pid = state.pid;
    api("/api/projects/" + pid + "/specs").then(function(j){
      if (pid !== brow.pid) return; // a reply for the project we just left
      brow.specs = j.specs || [];
      brow.running = j.running || null;
      brow.playwright = j.playwright !== false;
      drawBrowser();
    }).catch(function(){
      if (pid !== brow.pid) return;
      brow.specs = [];
      drawBrowser();
    });
  }


  function runSpec(file){
    if (brow.running) { toast("a spec is already running"); return; }
    brow.out = [];
    brow.lastFail = null;
    brow.stopping = false;
    specPrint("\u25b6 " + file, "");
    var pid = state.pid;
    api("/api/projects/" + pid + "/specs/run", {
      method: "POST", body: JSON.stringify({ file: file }),
    }).then(function(j){
      if (pid !== brow.pid) return;
      brow.running = { id: j.run.id, file: j.run.file };
      drawBrowser();
      if (state.redrawTermTabs) state.redrawTermTabs();
    }).catch(function(e){
      // The most common refusal is Playwright not being installed in the
      // project; the reporter line from npx lands in the stream either way.
      specPrint(e.message, "fail");
    });
  }


  /** Stop the run in progress. The daemon's spec_done frame settles the row. */
  function stopSpec(){
    if (!brow.running || !state.pid) return;
    if (brow.stopping) return;
    brow.stopping = true;
    specPrint("\u25a0 stopping " + brow.running.file + "\u2026", "");
    api("/api/projects/" + state.pid + "/specs/stop", { method: "POST", body: "{}" })
      .then(function(j){
        // nothing was running after all: the list was stale
        if (!j.stopped) { brow.stopping = false; brow.running = null; drawBrowser(); }
      })
      .catch(function(e){ brow.stopping = false; toast(e.message); });
  }


  /** A spec frame from the daemon — reporter output, or the run ending. */
  function onSpecFrame(frame){
    if (frame.type === "spec") {
      specPrint(frame.line, "");
      return;
    }
    // spec_done
    var failed = frame.exitCode !== 0;
    var stopped = frame.stopped === "stop" || (brow.stopping && failed && frame.stopped !== "timeout");
    brow.running = null;
    brow.stopping = false;
    drawBrowser();
    if (state.redrawTermTabs) state.redrawTermTabs();
    if (!failed) {
      brow.lastFail = null;
      specPrint("\u2713 " + frame.file + " passed", "pass");
      return;
    }
    if (stopped) {
      brow.lastFail = null;
      specPrint("\u25a0 " + frame.file + " stopped", "");
      return;
    }
    brow.lastFail = { file: frame.file, tail: brow.out.slice(-25).map(function(l){ return l.t; }) };
    specPrint(frame.stopped === "timeout"
      ? "\u2717 " + frame.file + " timed out and was stopped"
      : "\u2717 " + frame.file + " failed (exit " + frame.exitCode + ")", "fail");
  }


  // ---- what the previewed page says (core/preview-proxy.ts) ---------------
  // The page is another origin, so it can't be read — it reports instead, over
  // postMessage, from the script Loom's proxy injects. Everything it sends is
  // one shape, so this is one reader.
  var pg = { tab: "console", console: [], network: [], picking: false };


  function pageLogTab(which){
    pg.tab = which;
    var tabs = document.getElementById("pgtabs");
    if (tabs) Array.prototype.forEach.call(tabs.querySelectorAll("[data-pg]"), function(b){
      b.classList.toggle("on", b.getAttribute("data-pg") === which);
    });
    drawPageLog();
  }


  function drawPageLog(){
    var el = document.getElementById("pglines"); if (!el) return;
    var wrap = document.getElementById("pglog");
    var rows = pg.tab === "console" ? pg.console : pg.network;
    if (wrap && rows.length && wrap.style.display === "none") wrap.style.display = "flex";
    var count = document.getElementById("pgcount");
    if (count) {
      var errs = pg.console.filter(function(r){ return r.level === "error"; }).length;
      count.textContent = pg.console.length + " log" + (pg.console.length === 1 ? "" : "s") +
        (errs ? " · " + errs + " error" + (errs === 1 ? "" : "s") : "") + " · " + pg.network.length + " request" + (pg.network.length === 1 ? "" : "s");
    }
    if (!rows.length) {
      el.innerHTML = '<div class="specempty">' +
        (pg.tab === "console" ? "Nothing logged yet." : "No requests yet.") +
        "<br>Click a line to put it in the composer.</div>";
      return;
    }
    var atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    el.innerHTML = rows.map(function(r, i){
      if (pg.tab === "console") {
        return '<div class="pgrow ' + (r.level === "error" ? "e" : r.level === "warn" ? "w" : "") + '" data-pgi="' + i + '" title="click to put this in the composer">' +
          '<span class="lv">' + esc(r.level) + "</span>" + esc(String(r.text || "").slice(0, 500)) + "</div>";
      }
      var bad = !r.status || r.status >= 400;
      return '<div class="pgrow ' + (bad ? "e" : "") + '" data-pgi="' + i + '" title="click to put this in the composer">' +
        '<span class="lv">' + esc(String(r.status || "—")) + "</span>" +
        esc(r.method + " " + String(r.url || "").slice(0, 200)) + '<span class="ms">' + (r.ms || 0) + "ms</span></div>";
    }).join("");
    Array.prototype.forEach.call(el.querySelectorAll("[data-pgi]"), function(row){
      row.onclick = function(){ pageLineToComposer(rows[Number(row.getAttribute("data-pgi"))]); };
    });
    if (atBottom) el.scrollTop = el.scrollHeight;
  }


  /** The line, as the context an agent needs — the whole point of the pane. */
  function pageLineToComposer(r){
    if (!r) return;
    var box = document.getElementById("box"); if (!box) return;
    var text;
    if (pg.tab === "console") {
      text = "From the page console (" + r.level + "):\n" + String(r.text || "") + (r.stack ? "\n" + r.stack : "");
    } else {
      text = "From the page's network: " + r.method + " " + r.url + " → " + (r.status || "failed") +
        " in " + (r.ms || 0) + "ms" + (r.error ? "\n" + r.error : "");
    }
    box.value = box.value ? box.value.replace(/\s*$/, "") + "\n\n" + text : text;
    if (state.composer) state.composer.autosize();
    box.focus();
    toast("added to the composer");
  }


  /** The frame the pane is showing, if any. */
  function browFrame(){
    return document.querySelector("#browframe iframe");
  }


  /** Tell the bridged page something — only ever to the proxy's own origin. */
  function tellPage(msg){
    var frame = browFrame();
    if (!frame || !frame.contentWindow) return false;
    try { frame.contentWindow.postMessage(msg, brow.bridged && brow.proxy ? brow.proxy : "*"); return true; }
    catch (e) { return false; }
  }


  /** Ask the page which element you mean, and take its answer. */
  function togglePick(){
    var frame = browFrame();
    if (!frame || !frame.contentWindow) return toast("open a preview first");
    if (!brow.bridged) return toast("pick works on a page previewed through Loom — click a server row, or type a localhost address");
    pg.picking = !pg.picking;
    var btn = document.getElementById("pgpick");
    if (btn) btn.classList.toggle("on", pg.picking);
    tellPage({ source: "loom-app", kind: pg.picking ? "pick" : "cancel-pick" });
    if (pg.picking) toast("click the element you mean");
  }


  /**
   * One reader for everything the injected bridge sends.
   *
   * Only from the frame in the pane, and only while it's on Loom's proxy: any
   * other window can postMessage this one, and a page that isn't ours has no
   * business writing into the composer or moving the address bar.
   */
  function onPreviewMessage(ev){
    var d = ev && ev.data;
    if (!d || d.source !== "loom-preview") return;
    var frame = browFrame();
    if (!frame || !frame.contentWindow || ev.source !== frame.contentWindow) return;
    if (!brow.bridged || !brow.proxy || ev.origin !== brow.proxy) return;
    var p = d.payload || {};
    if (d.kind === "console") {
      pg.console.push(p);
      if (pg.console.length > 300) pg.console.shift();
      drawPageLog();
    } else if (d.kind === "network") {
      pg.network.push(p);
      if (pg.network.length > 300) pg.network.shift();
      drawPageLog();
    } else if (d.kind === "picked") {
      pg.picking = false;
      var btn = document.getElementById("pgpick");
      if (btn) btn.classList.remove("on");
      var box = document.getElementById("box");
      var rect = p.rect || {};
      if (box) {
        var lines = ["About this element on " + (toUpstream(p.url) || "the page") + " (" + conditions() + "):",
          "  selector: " + p.selector,
          "  text: " + (p.text || "(none)"),
          "  box: " + rect.w + "×" + rect.h + " at " + rect.x + "," + rect.y,
          "  html: " + String(p.html || "").slice(0, 400)].join("\n");
        box.value = box.value ? box.value.replace(/\s*$/, "") + "\n\n" + lines : lines;
        if (state.composer) state.composer.autosize();
        box.focus();
      }
      toast("element added to the composer");
    } else if (d.kind === "ready") {
      brow.ready = true;
      brow.hmr = !!p.hmr;
      hideBlocked();
      follow(p.url);
      // a fresh page: its old lines belong to the page that's gone
      pg.console = [];
      pg.network = [];
      drawPageLog();
      // …and a fresh page is the page as it shipped, so the scheme you chose
      // has to be asked for again. Every reload, every hot rebuild.
      if (brow.scheme) applyBrowScheme();
    } else if (d.kind === "nav") {
      follow(p.url);
    } else if (d.kind === "hmr") {
      brow.hmr = true;
    }
  }


  // ---- where the frame is ------------------------------------------------

  function originOf(u){
    try { return new URL(String(u)).origin; } catch (e) { return ""; }
  }


  /** A host that is this machine (core/preview-proxy.ts isLoopbackHost). */
  function isLoopbackUrl(u){
    var h;
    try { h = new URL(u).hostname.replace(/^\[|\]$/g, "").toLowerCase(); } catch (e) { return false; }
    return h === "localhost" || /\.localhost$/.test(h) || h === "::1" || /^127(\.\d{1,3}){3}$/.test(h);
  }


  /** The proxy's address for a page, as the dev server's own. */
  function toUpstream(href){
    if (typeof href !== "string" || !href) return "";
    if (brow.proxy && brow.upstream && originOf(href) === brow.proxy) return brow.upstream + href.slice(brow.proxy.length);
    return href;
  }


  /** Is a reply still for the navigation (and project) that asked? */
  function current(seq, pid){
    return seq === brow.seq && pid === state.pid && pid === brow.pid;
  }


  function setAddress(u){
    var input = document.getElementById("browurl");
    // don't yank the text out from under someone typing a new address
    if (input && document.activeElement !== input) input.value = u || "";
  }


  /** The page moved (a load, a link, a pushState): the bar and Reload follow. */
  function follow(href){
    if (typeof href !== "string" || !/^https?:\/\//.test(href)) return;
    if (brow.proxy && originOf(href) !== brow.proxy) return;
    brow.src = href;
    brow.url = toUpstream(href);
    setAddress(brow.url);
  }


  /**
   * Point the preview at an address — the bar, or a server row.
   *
   * An address on this machine goes through Loom's proxy (the same one a
   * server row gets), so a typed localhost URL reports its console, can be
   * picked from and follows its own navigation. Anywhere else loads as
   * itself — and if it refuses to be framed, the pane says so.
   */
  function browseTo(u){
    u = String(u || "").trim();
    if (!u) return;
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(u)) u = "http://" + u;
    if (!/^https?:\/\//i.test(u)) return toast("only http and https pages can be previewed");
    var seq = ++brow.seq, pid = state.pid;
    setAddress(u);
    if (pid && isLoopbackUrl(u) && originOf(u) !== location.origin) {
      api("/api/projects/" + pid + "/preview/proxy", { method: "POST", body: JSON.stringify({ url: u }) })
        .then(function(j){ if (current(seq, pid)) showProxied(j.url, j.target || originOf(u), u); })
        .catch(function(){ if (current(seq, pid)) showDirect(u); });
      return;
    }
    showDirect(u);
  }


  /** The page, through the proxy at `proxy` that stands in front of `upstream`. */
  function showProxied(proxy, upstream, shown){
    brow.bridged = true;
    brow.proxy = originOf(proxy) || proxy;
    brow.upstream = upstream;
    var rest = "/";
    try { var x = new URL(shown); rest = x.pathname + x.search + x.hash; } catch (e) {}
    loadFrame(brow.proxy + rest, shown);
  }


  /** The page as itself: an address Loom doesn't stand in front of. */
  function showDirect(u){
    brow.bridged = false;
    brow.proxy = "";
    brow.upstream = "";
    loadFrame(u, u);
    if (!isLoopbackUrl(u)) watchFraming(u, brow.seq, state.pid);
  }


  function loadFrame(src, shown){
    brow.src = src;
    brow.url = shown;
    brow.ready = false;
    brow.hmr = false;
    brow.loaded = false;
    pg.picking = false;
    var pick = document.getElementById("pgpick");
    if (pick) pick.classList.remove("on");
    setAddress(shown);
    var host = document.getElementById("browframe");
    if (!host) return;
    // Popups, alerts and downloads behave as they would in a tab. Same-origin
    // stays: the bridge's page needs its own storage and cookies — and the
    // proxy is its own origin, never the app's. The one address that WOULD be
    // the app's origin (Loom itself, typed in) loads without it, so it can't
    // reach back into this window.
    var sandbox = "allow-scripts allow-forms allow-popups allow-modals allow-downloads" +
      (originOf(src) === location.origin ? "" : " allow-same-origin");
    host.innerHTML = '<iframe src="' + esc(src) + '" sandbox="' + sandbox + '"></iframe>' +
      '<div class="browblock" id="browblock" hidden></div>';
    var frame = host.querySelector("iframe");
    if (frame) {
      frame.addEventListener("load", function(){ brow.loaded = true; });
      frame.addEventListener("error", function(){ showBlocked(shown, "it didn't load"); });
    }
    applyBrowWidth();
  }


  /**
   * A site somewhere else may refuse to be framed (X-Frame-Options, CSP
   * frame-ancestors), and a refused frame is just white — the frame can't say
   * why. Ask the daemon to read the same headers the browser will; and if the
   * page simply never arrives, say that too.
   */
  function watchFraming(u, seq, pid){
    if (brow.readyTimer) clearTimeout(brow.readyTimer);
    brow.readyTimer = setTimeout(function(){
      brow.readyTimer = null;
      if (current(seq, pid) && !brow.ready && !brow.loaded) showBlocked(u, "nothing arrived after a few seconds");
    }, 4000);
    if (state.timers) state.timers.push(brow.readyTimer);
    if (!pid) return;
    api("/api/projects/" + pid + "/preview/frameable", { method: "POST", body: JSON.stringify({ url: u }) })
      .then(function(j){ if (current(seq, pid) && j && j.frameable === false) showBlocked(u, j.reason); })
      .catch(function(){});
  }


  function showBlocked(u, why){
    var el = document.getElementById("browblock");
    if (!el) return;
    el.innerHTML = "<div><b>This site doesn’t allow being shown inside Loom.</b></div>" +
      (why ? '<div class="sub">' + esc(why) + "</div>" : "") +
      '<div class="sub">' + esc(u) + "</div>" +
      '<button class="btn" id="browblockopen">Open in browser</button>';
    el.hidden = false;
    var b = document.getElementById("browblockopen");
    if (b) b.onclick = function(){ openExternal(u); };
  }


  function hideBlocked(){
    var el = document.getElementById("browblock");
    if (el) el.hidden = true;
  }


  /** The page in the real browser — the dev server's own address, not the proxy's. */
  function openExternal(u){
    u = u || brow.url;
    if (!u) return toast("point the preview at something first");
    // "loom-external" tells the desktop shell to hand it to the OS browser
    // even when it's a localhost address (desktop/main.js).
    try { window.open(u, "loom-external", "noopener"); } catch (e) { toast("couldn't open it"); }
  }


  /** Back or forward in the page's own history — only the page can do it. */
  function historyGo(n){
    if (!browFrame()) return toast("open a preview first");
    if (!brow.bridged) return toast("back and forward work on pages previewed through Loom");
    tellPage({ source: "loom-app", kind: "history", go: n });
  }


  /** Reload what the frame is on now — where its own navigation took it. */
  function reloadFrame(){
    var frame = browFrame();
    if (!brow.src) return;
    if (!frame) return loadFrame(brow.src, brow.url || brow.src);
    brow.ready = false;
    brow.loaded = false;
    frame.src = brow.src;
  }


  function closeRail(){
    var w = document.getElementById("browwrap");
    if (w) w.classList.remove("railopen");
    var b = document.getElementById("browrailbtn");
    if (b) b.classList.remove("on");
  }


  /**
   * A different project starts the pane from nothing; the same one (another
   * chat in it) keeps its page, which fillBrowserPane puts back in the frame.
   * Called by every project mount (project.js).
   */
  function resetBrowser(pid){
    if (brow.relTimer) { clearTimeout(brow.relTimer); brow.relTimer = null; }
    if (brow.readyTimer) { clearTimeout(brow.readyTimer); brow.readyTimer = null; }
    if (brow.ro) { try { brow.ro.disconnect(); } catch (e) {} brow.ro = null; }
    pg.picking = false;
    if (brow.pid === pid) return;
    brow.pid = pid;
    brow.seq++;
    brow.specs = null; brow.running = null; brow.stopping = false; brow.out = []; brow.lastFail = null; brow.playwright = true;
    brow.url = ""; brow.src = ""; brow.bridged = false; brow.proxy = ""; brow.upstream = "";
    brow.ready = false; brow.hmr = false; brow.loaded = false;
    brow.width = 0; brow.scheme = "";
    srv.list = []; srv.suggested = []; srv.log = null; srv.lines = []; srv.busy = {}; srv.err = "";
    pg.tab = "console"; pg.console = []; pg.network = [];
  }


  /** Fill the pane if this mount's markup hasn't been yet; otherwise just redraw it. */
  function ensureBrowserPane(){
    var w = document.getElementById("browwrap");
    if (w && w.getAttribute("data-filled") === String(brow.pid)) { drawBrowser(); return; }
    fillBrowserPane();
  }


  /** Load and wire whatever the Browser pane is showing right now. */
  function fillBrowserPane(){
    if (brow.pid !== state.pid) resetBrowser(state.pid);
    var wrap = document.getElementById("browwrap");
    if (wrap) wrap.setAttribute("data-filled", String(brow.pid));
    if (brow.specs === null) refreshSpecs();
    loadServers();
    var sre = document.getElementById("srvreload");
    if (sre) sre.onclick = loadServers;
    var re = document.getElementById("specreload");
    if (re) re.onclick = function(){ brow.specs = null; refreshSpecs(); };
    var ss = document.getElementById("specstop");
    if (ss) ss.onclick = stopSpec;
    var go = document.getElementById("browgo");
    var url = document.getElementById("browurl");
    var nav = function(){ if (url) url.blur(); browseTo((url && url.value || "").trim()); };
    if (go) go.onclick = nav;
    if (url) url.onkeydown = function(ev){ if (ev.key === "Enter") { ev.preventDefault(); nav(); } };
    var back = document.getElementById("browback");
    if (back) back.onclick = function(){ historyGo(-1); };
    var fwd = document.getElementById("browfwd");
    if (fwd) fwd.onclick = function(){ historyGo(1); };
    var ext = document.getElementById("browext");
    if (ext) ext.onclick = function(){ openExternal(); };
    // the narrow dock's drawer and overflow (tools.css @container brow)
    var railBtn = document.getElementById("browrailbtn");
    if (railBtn) railBtn.onclick = function(){
      var open = wrap && wrap.classList.toggle("railopen");
      railBtn.classList.toggle("on", !!open);
    };
    var railClose = document.getElementById("browrailclose");
    if (railClose) railClose.onclick = closeRail;
    var more = document.getElementById("browmore");
    if (more) more.onclick = function(){
      var open = wrap && wrap.classList.toggle("toolsopen");
      more.classList.toggle("on", !!open);
    };

    // Width presets: "it breaks on mobile" should be reproducible in the pane
    // where the work happens, not only in another window. Both the width and
    // the scheme are read back per project — and a project that never chose
    // one gets Fit and Auto, not whatever the last project was set to.
    brow.width = 0;
    brow.scheme = "";
    try {
      var savedW = localStorage.getItem("loomBrowW:" + state.pid);
      if (savedW !== null) brow.width = Number(savedW) || 0;
      var savedS = localStorage.getItem("loomBrowS:" + state.pid);
      if (savedS === "dark" || savedS === "light") brow.scheme = savedS;
    } catch (e) {}
    var sizes = document.getElementById("browsizes");
    if (sizes) Array.prototype.forEach.call(sizes.querySelectorAll("[data-w]"), function(b){
      b.classList.toggle("on", Number(b.getAttribute("data-w")) === (brow.width || 0));
      b.onclick = function(){
        brow.width = Number(b.getAttribute("data-w")) || 0;
        try { localStorage.setItem("loomBrowW:" + state.pid, String(brow.width)); } catch (e) {}
        Array.prototype.forEach.call(sizes.querySelectorAll("[data-w]"), function(x){
          x.classList.toggle("on", Number(x.getAttribute("data-w")) === brow.width);
        });
        applyBrowWidth();
      };
    });
    var schemes = document.getElementById("browscheme");
    if (schemes) Array.prototype.forEach.call(schemes.querySelectorAll("[data-s]"), function(b){
      b.classList.toggle("on", (b.getAttribute("data-s") || "") === brow.scheme);
      b.onclick = function(){
        brow.scheme = b.getAttribute("data-s") || "";
        try { localStorage.setItem("loomBrowS:" + state.pid, brow.scheme); } catch (e) {}
        Array.prototype.forEach.call(schemes.querySelectorAll("[data-s]"), function(x){
          x.classList.toggle("on", (x.getAttribute("data-s") || "") === brow.scheme);
        });
        applyBrowScheme();
      };
    });
    var rl = document.getElementById("browreload");
    if (rl) rl.onclick = reloadFrame;
    var auto = document.getElementById("browautorel");
    if (auto) {
      try { auto.checked = localStorage.getItem("loomBrowAuto") !== "0"; } catch (e) {}
      auto.onchange = function(){ try { localStorage.setItem("loomBrowAuto", auto.checked ? "1" : "0"); } catch (e) {} };
    }
    var shot = document.getElementById("browshot");
    if (shot) shot.onclick = shootPreview;
    var tabs = document.getElementById("pgtabs");
    if (tabs) Array.prototype.forEach.call(tabs.querySelectorAll("[data-pg]"), function(b){
      b.onclick = function(){ pageLogTab(b.getAttribute("data-pg")); };
    });
    var pgc = document.getElementById("pgclear");
    if (pgc) pgc.onclick = function(){ pg.console = []; pg.network = []; drawPageLog(); };
    var pick = document.getElementById("pgpick");
    if (pick) pick.onclick = togglePick;

    // The emulated width is a scale of the pane's own width: when the dock is
    // dragged, or the window resized, the scale has to follow.
    var host = document.getElementById("browframe");
    if (brow.ro) { try { brow.ro.disconnect(); } catch (e) {} brow.ro = null; }
    if (host && typeof ResizeObserver !== "undefined") {
      brow.ro = new ResizeObserver(function(){ applyBrowWidth(); });
      brow.ro.observe(host);
    }
    // Same project, fresh markup (another chat, a re-render): the page you
    // were on comes back rather than the hint.
    if (brow.src && host && !host.querySelector("iframe")) loadFrame(brow.src, brow.url || brow.src);
    else setAddress(brow.url);
    pageLogTab(pg.tab);
    drawSpecOut();
    drawBrowser();
  }


  /**
   * Reload the preview after an agent's turn changed files.
   *
   * Coalesced, because a turn lands its diff once but a rebuild takes a moment
   * — and skipped when the page updates itself: the bridge saw a hot-reload
   * client in it (vite, webpack), which gets there first, and a hard reload
   * would throw away its state.
   */
  function maybeReloadPreview(){
    if (!brow.present || !brow.src) return;
    if (brow.hmr) return;
    var auto = document.getElementById("browautorel");
    if (auto && !auto.checked) return;
    if (brow.relTimer) clearTimeout(brow.relTimer);
    var seq = brow.seq;
    brow.relTimer = setTimeout(function(){
      brow.relTimer = null;
      if (seq !== brow.seq || brow.hmr) return;
      // Re-point rather than frame.contentWindow.location.reload(): the page is
      // another origin, and touching its window from here throws. brow.src is
      // where the page's own navigation took it, not where it started.
      if (browFrame()) reloadFrame();
    }, 900);
    state.timers.push(brow.relTimer);
  }


  /** The conditions the preview is being viewed under, in words. */
  function conditions(){
    return (brow.width ? brow.width + "px wide" : "fit to the pane") +
      ", " + (brow.scheme ? brow.scheme + " mode" : "your OS colour scheme");
  }


  /** Add a line to the composer without clobbering what's already typed. */
  function noteConditions(line){
    var box = document.getElementById("box");
    if (!box) return;
    box.value = box.value ? box.value.replace(/\s*$/, "") + "\n" + line : line;
    if (state.composer) state.composer.autosize();
  }


  /**
   * Ask the previewed page to render as if the OS were set this way.
   *
   * It can only be asked — the bridge inside the page is what re-points its
   * prefers-color-scheme rules — so a page Loom isn't proxying gets told
   * that plainly instead of a switch that does nothing. The capture path
   * (screenshot) drives a real browser and honours it either way.
   */
  function applyBrowScheme(){
    var frame = browFrame();
    if (!frame || !frame.contentWindow) return;
    if (!brow.bridged && brow.scheme) {
      toast("the shot will be in " + brow.scheme + " mode — the live frame needs a page previewed through Loom");
    }
    tellPage({ source: "loom-app", kind: "scheme", value: brow.scheme || null });
  }


  /** The emulated width, scaled down when the pane is narrower than it. */
  function applyBrowWidth(){
    var host = document.getElementById("browframe");
    var frame = host && host.querySelector("iframe");
    if (!frame) return;
    if (!brow.width) {
      frame.style.width = "100%";
      frame.style.height = "100%";
      frame.style.transform = "";
      host.classList.remove("sized");
      return;
    }
    host.classList.add("sized");
    var avail = host.clientWidth - 16;
    var scale = avail > 0 ? Math.min(1, avail / brow.width) : 1;
    frame.style.width = brow.width + "px";
    frame.style.height = Math.round(host.clientHeight / scale) + "px";
    frame.style.transformOrigin = "top center";
    frame.style.transform = "scale(" + scale.toFixed(3) + ")";
  }


  /**
   * A picture of what's on screen, into the composer.
   *
   * In the desktop shell, the shell photographs the frame exactly as shown
   * (desktop/main.js loom:capture) and it's uploaded like a pasted image.
   * Anywhere else — or if that fails — the frame is another origin, so the
   * page can't photograph it: the daemon does, with the project's own
   * Playwright, at the width being previewed.
   */
  function shootPreview(){
    if (!brow.url) return toast("point the preview at something first");
    var composer = state.composer;
    if (!composer || composer.projectId !== state.pid) return toast("open a project first");
    var btn = document.getElementById("browshot");
    if (btn) btn.disabled = true;
    var host = document.getElementById("browframe");
    var pid = state.pid;
    var done = function(){ if (btn) btn.disabled = false; };
    var native = window.loomNative && typeof window.loomNative.capture === "function" && host && browFrame();
    if (native) {
      var r = host.getBoundingClientRect();
      var rect = { x: r.left, y: r.top, width: r.width, height: r.height };
      toast("taking a screenshot…");
      Promise.resolve(window.loomNative.capture(rect)).then(function(dataUrl){
        if (typeof dataUrl !== "string" || dataUrl.indexOf("data:image/") !== 0) throw new Error("no picture");
        return api("/api/projects/" + pid + "/attachments", {
          method: "POST", body: JSON.stringify({ name: "preview.png", dataUrl: dataUrl }),
        }).then(function(j){
          done();
          if (state.composer !== composer) return; // navigation replaced the recipient
          composer.addAttachment({ name: "preview.png", kind: "image", uploading: false, thumb: dataUrl, path: j.path });
          var w = Math.round(rect.width), h = Math.round(rect.height);
          noteConditions("Screenshot of the preview as shown, " + w + "×" + h + " (" + conditions() + "), of " + brow.url + ".");
          toast("added to the composer · " + w + "×" + h);
        });
      }).catch(function(){ shootWithPlaywright(composer, btn, host, pid); });
      return;
    }
    shootWithPlaywright(composer, btn, host, pid);
  }


  function shootWithPlaywright(composer, btn, host, pid){
    var w = brow.width || (host ? Math.max(320, host.clientWidth) : 1280);
    toast("taking a screenshot…");
    api("/api/projects/" + pid + "/preview/screenshot", {
      method: "POST",
      body: JSON.stringify({
        url: brow.url,
        width: w,
        height: host ? Math.max(400, host.clientHeight) : 800,
        // The capture drives a real browser, so the scheme is truthful here
        // whether or not the live frame could be asked.
        colorScheme: brow.scheme === "dark" ? "dark" : "light",
      }),
    }).then(function(j){
      if (btn) btn.disabled = false;
      // Same path a pasted image takes: a chip in the composer, sent as a path.
      if (state.composer !== composer) return; // navigation replaced the recipient
      composer.addAttachment({ name: "preview.png", kind: "image", uploading: false, thumb: null, path: j.path });
      // The conditions ride along with the picture: an agent reading "it looks
      // wrong" needs to know at what width, in which scheme.
      noteConditions("Screenshot taken at " + j.width + "×" + j.height + ", " + j.colorScheme + " mode.");
      toast("added to the composer · " + j.width + "×" + j.height + " · " + j.colorScheme);
    }).catch(function(e){
      if (btn) btn.disabled = false;
      toast(e.message);
    });
  }


  function openBrowser(){
    if (state.showBrowser) state.showBrowser();
    else fillBrowserPane();
  }


  function closeBrowser(){
    if (state.hideBrowser) state.hideBrowser();
    else brow.present = false;
  }
export { applyBrowScheme,applyBrowWidth,brow,browseTo,closeBrowser,conditions,drawBrowser,drawPageLog,drawServerLog,drawServers,drawSpecOut,ensureBrowserPane,fillBrowserPane,historyGo,isLoopbackUrl,loadServers,maybeReloadPreview,noteConditions,onPreviewMessage,onServerFrame,onSpecFrame,openBrowser,openExternal,pageLineToComposer,pageLogTab,pg,refreshSpecs,reloadFrame,resetBrowser,runSpec,serverUrl,shootPreview,showServerLog,specPrint,srv,stopSpec,togglePick,toUpstream };
