/**
 * The Loom phone app — a single-file mobile web app served by the daemon at
 * /app. Reachable over the tailnet, paired via the `loom pair` QR deep link
 * (…/app#pair=<one-time-token>), installable to the Android home screen.
 *
 * Served publicly (it's just a shell); every API call it makes carries the
 * paired client's bearer token. No frameworks, no build step, no CDN.
 */

export const APP_MANIFEST = {
  name: "Loom",
  short_name: "Loom",
  start_url: "/app",
  display: "standalone",
  background_color: "#0b0e14",
  theme_color: "#0b0e14",
  icons: [
    {
      src:
        "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Crect width='100' height='100' rx='22' fill='%230b0e14'/%3E%3Ctext x='50' y='66' font-size='44' text-anchor='middle' fill='%2367e8f9' font-family='monospace' font-weight='bold'%3Elo%3C/text%3E%3C/svg%3E",
      sizes: "any",
      type: "image/svg+xml",
      purpose: "any",
    },
  ],
};

export const APP_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#0b0e14">
<link rel="manifest" href="/app/manifest.webmanifest">
<title>Loom</title>
<style>
  :root{--bg:#0b0e14;--panel:#131826;--line:#1e2436;--text:#dbe2f0;--dim:#7c88a1;--accent:#67e8f9;--warn:#fbbf24;--err:#f87171;--ok:#4ade80;--mag:#e879f9;}
  *{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
  body{margin:0;background:var(--bg);color:var(--text);font:15px/1.45 -apple-system,Roboto,"Segoe UI",sans-serif;padding-bottom:env(safe-area-inset-bottom)}
  #root{max-width:720px;margin:0 auto;min-height:100vh;display:flex;flex-direction:column}
  header{position:sticky;top:0;z-index:5;background:rgba(11,14,20,.94);backdrop-filter:blur(8px);border-bottom:1px solid var(--line);padding:calc(10px + env(safe-area-inset-top)) 14px 10px;display:flex;align-items:center;gap:10px}
  header .logo{font-family:ui-monospace,Menlo,monospace;font-weight:700;letter-spacing:1px}
  header .logo b{color:var(--accent)}
  header .sub{color:var(--dim);font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  header button{margin-left:auto}
  main{flex:1;padding:12px 14px 90px}
  button{background:var(--panel);color:var(--text);border:1px solid var(--line);border-radius:10px;padding:8px 12px;font:inherit}
  button.primary{background:var(--accent);color:#06121a;border-color:var(--accent);font-weight:600}
  button:active{opacity:.75}
  .card{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:12px 14px;margin-bottom:10px}
  .card .row1{display:flex;align-items:center;gap:8px;font-weight:600}
  .card .row2{color:var(--dim);font-size:12.5px;margin-top:3px}
  .dot{width:8px;height:8px;border-radius:50%;background:#3d475d;flex:none}
  .dot.hot{background:var(--warn);box-shadow:0 0 8px var(--warn)}
  .badge{font-size:11px;color:var(--accent);border:1px solid var(--line);border-radius:999px;padding:1px 8px;margin-left:auto}
  .chips{display:flex;gap:8px;overflow-x:auto;padding:10px 14px;border-bottom:1px solid var(--line);position:sticky;top:53px;background:rgba(11,14,20,.94);backdrop-filter:blur(8px);z-index:4}
  .chip{flex:none;font-size:13px;padding:5px 12px;border-radius:999px;border:1px solid var(--line);color:var(--dim);background:var(--panel)}
  .chip.sel{color:#06121a;background:var(--accent);border-color:var(--accent);font-weight:600}
  .chip .role{opacity:.7;font-size:11px}
  .msg{margin:8px 0;display:flex;flex-direction:column}
  .msg .who{font-size:11px;color:var(--dim);margin:0 6px 2px}
  .msg .bubble{max-width:86%;padding:8px 12px;border-radius:14px;white-space:pre-wrap;word-break:break-word}
  .msg.user{align-items:flex-end}
  .msg.user .bubble{background:#1b2a3a;border:1px solid #24405c;border-bottom-right-radius:4px}
  .msg.agent{align-items:flex-start}
  .msg.agent .bubble{background:var(--panel);border:1px solid var(--line);border-bottom-left-radius:4px}
  .sys{color:var(--dim);font-size:12px;text-align:center;margin:8px 0}
  .sys.warn{color:var(--warn)}
  .sys.err{color:var(--err)}
  .sys.mag{color:var(--mag)}
  .tool{color:var(--dim);font-size:12px;font-family:ui-monospace,Menlo,monospace;margin:2px 0 2px 12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .routebar{position:sticky;top:97px;z-index:3;background:#122032;border:1px solid #1d3a55;border-radius:12px;padding:8px 12px;margin:10px 0;font-size:13px}
  .routebar .q{color:var(--warn);margin-top:4px}
  .routebar .abort{float:right;font-size:11px;padding:3px 10px}
  .sheet{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:12px;margin:10px 0;display:flex;flex-direction:column;gap:8px}
  .sheet select,.sheet input{background:#0e1420;border:1px solid var(--line);border-radius:10px;color:var(--text);padding:9px 10px;font:inherit;width:100%}
  .sheet .row{display:flex;gap:8px}
  .sheet .row button{flex:1}
  .sheet label{font-size:11px;color:var(--dim)}
  .composer{position:fixed;bottom:0;left:0;right:0;background:rgba(11,14,20,.96);backdrop-filter:blur(8px);border-top:1px solid var(--line);padding:10px 12px calc(10px + env(safe-area-inset-bottom))}
  .composer .inner{max-width:720px;margin:0 auto;display:flex;gap:8px}
  .composer input{flex:1;background:var(--panel);border:1px solid var(--line);border-radius:12px;color:var(--text);padding:10px 12px;font:inherit;outline:none}
  .composer input:focus{border-color:var(--accent)}
  .hint{color:var(--dim);font-size:11px;max-width:720px;margin:6px auto 0;text-align:center}
  #toast{position:fixed;left:50%;transform:translateX(-50%);bottom:96px;background:#2a1620;color:#ffb4c0;border:1px solid #572436;border-radius:10px;padding:8px 14px;font-size:13px;opacity:0;transition:opacity .2s;pointer-events:none;z-index:20;max-width:86%}
  .pairwrap{display:flex;flex-direction:column;gap:14px;align-items:center;justify-content:center;min-height:70vh;padding:24px;text-align:center}
  .pairwrap .biglogo{font-family:ui-monospace,Menlo,monospace;font-size:34px;font-weight:700;letter-spacing:2px}
  .pairwrap input{width:100%;max-width:420px;background:var(--panel);border:1px solid var(--line);border-radius:12px;color:var(--text);padding:12px;font:inherit;text-align:center}
  .spin{display:inline-block;width:10px;text-align:center;color:var(--warn)}
</style>
</head>
<body id="loom-app">
<div id="root"></div>
<div id="toast"></div>
<script>
(function(){
  "use strict";
  var TOKEN_KEY = "loomClientToken";
  var state = { token: localStorage.getItem(TOKEN_KEY) || "", projects: [], pid: null,
                project: null, selected: null, lastId: 0, ws: null, timers: [] };
  var root = document.getElementById("root");

  function esc(s){ return String(s == null ? "" : s).replace(/[&<>"']/g, function(c){
    return {"&":"&amp;","<":"&lt;",">":"&gt;","\\"":"&quot;","'":"&#39;"}[c]; }); }
  function toast(msg){ var t = document.getElementById("toast"); t.textContent = msg;
    t.style.opacity = "1"; setTimeout(function(){ t.style.opacity = "0"; }, 2600); }
  function hue(id){ var h = 0; for (var i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) % 360; return h; }
  function clearTimers(){ state.timers.forEach(clearInterval); state.timers = [];
    if (state.ws) { try { state.ws.close(); } catch (e) {} state.ws = null; } }

  function api(path, opts){
    opts = opts || {};
    opts.headers = opts.headers || {};
    opts.headers["Authorization"] = "Bearer " + state.token;
    if (opts.body) opts.headers["Content-Type"] = "application/json";
    return fetch(path, opts).then(function(r){
      if (r.status === 401) { logout(); throw new Error("session revoked — pair again"); }
      return r.json().then(function(j){
        if (!r.ok) throw new Error(j.message || j.error || ("HTTP " + r.status));
        return j;
      });
    });
  }
  function logout(){ state.token = ""; localStorage.removeItem(TOKEN_KEY); route(); }

  // ---- pairing -------------------------------------------------------------
  function pairFromHash(){
    var m = location.hash.match(/pair=([A-Za-z0-9]+)/);
    if (!m) return Promise.resolve(false);
    history.replaceState(null, "", location.pathname);
    return claim(m[1]);
  }
  function claim(tok){
    return fetch("/api/pair/claim", { method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: tok, name: "phone" }) })
    .then(function(r){ return r.json().then(function(j){
      if (!r.ok) throw new Error(j.error || "pairing failed");
      state.token = j.clientToken; localStorage.setItem(TOKEN_KEY, state.token);
      return true; }); });
  }
  function renderPair(){
    clearTimers();
    root.innerHTML =
      '<div class="pairwrap">' +
      '<div class="biglogo">lo<b style="color:var(--accent)">om</b></div>' +
      '<div style="color:var(--dim)">one thread &middot; every agent</div>' +
      '<div style="color:var(--dim);font-size:13px">On your computer run <b>loom pair</b> and scan the QR &mdash; or paste the pairing token:</div>' +
      '<input id="ptok" placeholder="pairing token" autocomplete="off">' +
      '<button class="primary" id="pgo">Pair this phone</button>' +
      '</div>';
    document.getElementById("pgo").onclick = function(){
      var v = (document.getElementById("ptok").value || "").trim();
      if (!v) return toast("paste the token from loom pair");
      try { var j = JSON.parse(v); if (j && j.token) v = j.token; } catch (e) {}
      var m = v.match(/pair=([A-Za-z0-9]+)/); if (m) v = m[1];
      claim(v).then(route).catch(function(err){ toast(err.message); });
    };
  }

  // ---- board ---------------------------------------------------------------
  function renderBoard(){
    clearTimers();
    root.innerHTML =
      '<header><span class="logo">lo<b>om</b></span><span class="sub">projects</span>' +
      '<button id="unpair" style="font-size:12px">unpair</button></header>' +
      '<main id="list"><div class="sys">loading&hellip;</div></main>';
    document.getElementById("unpair").onclick = logout;
    function refresh(){
      api("/api/projects").then(function(j){
        state.projects = j.projects || [];
        var el = document.getElementById("list");
        if (!el) return;
        if (!state.projects.length) { el.innerHTML = '<div class="sys">no projects yet &mdash; run <b>loom init</b> on your computer</div>'; return; }
        el.innerHTML = state.projects.map(function(p){
          var r = p.route, act = r && (r.status === "running" || r.status === "waiting_human");
          return '<div class="card" data-id="' + esc(p.id) + '">' +
            '<div class="row1"><span class="dot' + (p.needsInput ? " hot" : "") + '"></span>' +
            esc(p.name) +
            (act ? '<span class="badge">&#10148; ' + esc(r.name || "route") + " " + (r.current + 1) + "/" + r.steps.length + (r.status === "waiting_human" ? " &#9208;" : "") + "</span>" : "") +
            '</div>' +
            '<div class="row2">baton: ' + esc(p.holder || "\\u2014") +
            (p.costUsd > 0 ? " &middot; $" + (p.costUsd >= 0.01 ? p.costUsd.toFixed(2) : p.costUsd.toFixed(4)) : "") +
            (p.needsInput ? ' &middot; <span style="color:var(--warn)">needs input</span>' : "") + "</div></div>";
        }).join("");
        Array.prototype.forEach.call(el.querySelectorAll(".card"), function(card){
          card.onclick = function(){ location.hash = "#p/" + card.getAttribute("data-id"); };
        });
      }).catch(function(err){ toast(err.message); });
    }
    refresh();
    state.timers.push(setInterval(refresh, 5000));
  }

  // ---- thread --------------------------------------------------------------
  function lineFor(e){
    var p = e.payload || {};
    if (e.kind === "message") {
      if (!e.agentId) {
        if (p.author === "loom") return '<div class="sys">&#10148; ' + esc(String(p.text).split("\\n")[0]) + "</div>";
        return '<div class="msg user"><div class="bubble">' + esc(p.text) + "</div></div>";
      }
      return '<div class="msg agent"><div class="who" style="color:hsl(' + hue(e.agentId) + ',60%,70%)">' + esc(e.agentId) + '</div><div class="bubble">' + esc(p.text) + "</div></div>";
    }
    if (e.kind === "tool_call") return '<div class="tool">&#9881; ' + esc(p.summary || p.tool) + "</div>";
    if (e.kind === "file_edit") return '<div class="tool">&#9998; ' + esc(p.path) + "</div>";
    if (e.kind === "turn_diff") {
      var fl = (p.files || []).map(function(f){ return f.path; });
      return '<div class="sys">&#9998; changed ' + fl.length + " file" + (fl.length === 1 ? "" : "s") +
        " (+" + Number(p.added || 0) + " &minus;" + Number(p.removed || 0) + "): " +
        esc(fl.slice(0, 3).join(", ")) + (fl.length > 3 ? " &hellip;" : "") + "</div>";
    }
    if (e.kind === "handoff") return '<div class="sys mag">&#10230; baton: ' + esc(p.from || "\\u2014") + " &rarr; " + esc(p.to || "\\u2014") + "</div>";
    if (e.kind === "suggestion") return '<div class="sys warn">&#128161; ' + esc(p.reason || "handoff suggested") + "</div>";
    if (e.kind === "needs_input") return '<div class="sys warn">&#9208; ' + esc(e.agentId) + " asks: " + esc(p.question) + "</div>";
    if (e.kind === "decision") return '<div class="sys">&#9733; ' + esc(p.text) + "</div>";
    if (e.kind === "memory_import") return '<div class="sys" style="color:var(--accent)">&#129504; imported ' + esc(p.file) + " into the shared brain</div>";
    if (e.kind === "error") return '<div class="sys err">&#10007; ' + esc(p.message) + "</div>";
    if (e.kind === "route_started") {
      if (p.mode === "dynamic") return '<div class="sys">&#10148; route "auto" started &mdash; ' + esc(p.router) + " picks each hop</div>";
      return '<div class="sys">&#10148; route started: ' + esc((p.steps || []).join(" \\u2192 ")) + "</div>";
    }
    if (e.kind === "route_step") {
      var pos = p.of ? "step " + (Number(p.step) + 1) + "/" + Number(p.of) : "hop " + (Number(p.step) + 1);
      return '<div class="sys">&#10148; ' + pos + " \\u2192 " + esc(p.agent) +
        (p.reason ? ' <span style="opacity:.7">(' + esc(p.reason) + ")</span>" : "") + "</div>";
    }
    if (e.kind === "route_paused") return '<div class="sys warn">&#9208; route paused &mdash; ' + esc(p.agent) + " asks: " + esc(p.question) + "</div>";
    if (e.kind === "route_resumed") return '<div class="sys">&#10148; route resumed</div>';
    if (e.kind === "route_completed") return '<div class="sys" style="color:var(--ok)">&#10004; route completed</div>';
    if (e.kind === "route_failed") return '<div class="sys ' + (p.aborted ? "warn" : "err") + '">&#8856; ' + esc(p.reason || "route ended") + "</div>";
    if (e.kind === "run_complete") return '<div class="tool">&#10003; ' + esc(e.agentId) + " done</div>";
    return "";
  }

  function renderThread(pid){
    clearTimers();
    state.pid = pid; state.lastId = 0; state.selected = null;
    root.innerHTML =
      '<header><button id="back">&larr;</button>' +
      '<span class="logo" id="pname">&hellip;</span><span class="sub" id="pstat"></span>' +
      '<button id="brainbtn" title="unified memory" style="margin-left:auto">&#129504;</button>' +
      '<button id="treebtn" title="working tree" style="margin-left:8px">&plusmn;</button>' +
      '<button id="routebtn" title="routes" style="margin-left:8px">&#10148;</button>' +
      '<button id="stop" title="interrupt" style="margin-left:8px">&#9632;</button></header>' +
      '<div class="chips" id="chips"></div>' +
      '<main><div id="routesheet"></div><div id="routebar"></div><div id="feed"><div class="sys">loading&hellip;</div></div></main>' +
      '<div class="composer"><form class="inner" id="cform">' +
      '<input id="box" placeholder="Message&hellip;" autocomplete="off">' +
      '<button class="primary" id="send" type="submit">&#10148;</button></form>' +
      '<div class="hint" id="hint"></div></div>';
    document.getElementById("back").onclick = function(){ location.hash = ""; };
    document.getElementById("stop").onclick = function(){
      api("/api/projects/" + pid + "/interrupt", { method: "POST", body: "{}" })
        .then(function(j){ toast(j.interrupted ? "interrupted " + j.interrupted : "nothing running"); })
        .catch(function(err){ toast(err.message); });
    };

    var brainOpen = false;
    document.getElementById("brainbtn").onclick = function(){
      brainOpen = !brainOpen; treeOpen = false;
      var el = document.getElementById("routesheet");
      if (!brainOpen) { el.innerHTML = ""; return; }
      el.innerHTML = '<div class="sheet"><label>unified memory</label><div class="sys">loading&hellip;</div></div>';
      api("/api/projects/" + pid + "/memory").then(function(j){
        if (!brainOpen) return;
        var m = j.memory || {};
        var head = '<label>&#129504; one brain &middot; ' + (m.sources || []).length +
          ' ADE source(s) &middot; ' + (m.decisions || []).length + ' decision(s)</label>';
        var src = (m.sources || []).map(function(s){
          return '<div class="tool">' + esc(s.agentId) + " \\u2190 " + esc(s.file) + "</div>";
        }).join("");
        var body = esc(m.document || "").split("\\n").map(function(line){
          var c = line.charAt(0) === "#" ? "var(--accent)" : line.slice(0,3) === "###" ? "var(--mag)" : "var(--text)";
          return '<div style="color:' + c + ';white-space:pre-wrap;word-break:break-word;font-size:12px">' + (line||" ") + "</div>";
        }).join("");
        el.innerHTML = '<div class="sheet">' + head + src +
          '<div style="max-height:46vh;overflow:auto;border-top:1px solid var(--line);padding-top:8px">' + body + "</div>" +
          '<button class="primary" id="reimport">re-import ADE memory</button></div>';
        document.getElementById("reimport").onclick = function(){
          api("/api/projects/" + pid + "/memory/import", { method: "POST", body: "{}" })
            .then(function(r){ toast(r.imported ? "imported " + r.imported + " source(s)" : "brain already current"); brainOpen=false; document.getElementById("brainbtn").click(); })
            .catch(function(err){ toast(err.message); });
        };
      }).catch(function(err){ toast(err.message); });
    };

    var treeOpen = false;
    document.getElementById("treebtn").onclick = function(){
      treeOpen = !treeOpen; brainOpen = false;
      var el = document.getElementById("routesheet");
      if (!treeOpen) { el.innerHTML = ""; return; }
      el.innerHTML = '<div class="sheet"><label>working tree</label><div class="sys">loading&hellip;</div></div>';
      api("/api/projects/" + pid + "/tree").then(function(j){
        if (!treeOpen) return;
        var t = j.tree || {};
        if (!t.git) { el.innerHTML = '<div class="sheet"><label>working tree</label><div class="sys">not a git repository</div></div>'; return; }
        var head = "<label>working tree &middot; " + esc(t.branch || "") + " &middot; " +
          (t.files || []).length + " changed</label>";
        var list = (t.files || []).map(function(f){
          return '<div class="tool">' + esc(f.status) + " " + esc(f.path) + "</div>";
        }).join("");
        var patch = (t.patch || "").split("\\n").map(function(line){
          var c = line.charAt(0) === "+" ? "var(--ok)" : line.charAt(0) === "-" ? "var(--err)" : "var(--dim)";
          return '<div style="color:' + c + ';white-space:pre-wrap;word-break:break-all">' + esc(line) + "</div>";
        }).join("");
        el.innerHTML = '<div class="sheet">' + head + list +
          '<div style="font-family:ui-monospace,Menlo,monospace;font-size:11px;max-height:40vh;overflow:auto;border-top:1px solid var(--line);padding-top:8px">' +
          (patch || '<div class="sys">clean</div>') + "</div></div>";
      }).catch(function(err){ toast(err.message); });
    };

    var sheetOpen = false;
    document.getElementById("routebtn").onclick = function(){ sheetOpen = !sheetOpen; treeOpen = false; drawSheet(); };
    function drawSheet(){
      var el = document.getElementById("routesheet"); if (!el) return;
      if (!sheetOpen) { el.innerHTML = ""; return; }
      var names = (state.project && state.project.routeNames) || ["auto"];
      el.innerHTML = '<div class="sheet">' +
        "<label>pipeline</label>" +
        '<select id="rsel">' +
        names.map(function(n){
          return '<option value="' + esc(n) + '">' + esc(n === "auto" ? "auto \\u2014 LLM picks each hop" : n) + "</option>";
        }).join("") +
        '<option value="__custom">custom steps&hellip;</option></select>' +
        '<input id="rsteps" placeholder="steps e.g. planner,executor" style="display:none">' +
        '<input id="rtask" placeholder="what should they do?">' +
        '<div class="row"><button class="primary" id="rgo">Start route</button></div></div>';
      document.getElementById("rsel").onchange = function(){
        document.getElementById("rsteps").style.display = this.value === "__custom" ? "" : "none";
      };
      document.getElementById("rgo").onclick = function(){
        var sel = document.getElementById("rsel").value;
        var task = (document.getElementById("rtask").value || "").trim();
        if (!task) return toast("describe the task first");
        var spec = sel === "__custom" ? (document.getElementById("rsteps").value || "").trim() : sel;
        if (!spec) return toast("give steps like planner,executor");
        api("/api/projects/" + pid + "/route", { method: "POST", body: JSON.stringify({ task: task, spec: spec }) })
          .then(function(){ sheetOpen = false; drawSheet(); refresh(); toast("route started"); })
          .catch(function(err){ toast(err.message); });
      };
    }

    function drawChips(){
      var p = state.project; if (!p) return;
      var chips = document.getElementById("chips"); if (!chips) return;
      var adapters = p.agents.filter(function(a){ return a.tier === "adapter"; });
      if (state.selected === null) state.selected = p.holder || (adapters[0] && adapters[0].id) || null;
      chips.innerHTML = adapters.map(function(a){
        var sel = a.id === state.selected;
        return '<button class="chip' + (sel ? " sel" : "") + '" data-id="' + esc(a.id) + '">' +
          esc(a.id) + ' <span class="role">' + esc(a.role) + (a.id === p.holder ? " &#10229;" : "") +
          (a.busy ? ' <span class="spin">&#9881;</span>' : "") + "</span></button>";
      }).join("");
      Array.prototype.forEach.call(chips.querySelectorAll(".chip"), function(chip){
        chip.onclick = function(){ state.selected = chip.getAttribute("data-id"); drawChips(); };
      });
      var hint = document.getElementById("hint");
      hint.textContent = state.selected && state.selected !== p.holder
        ? "send will shift the baton to " + state.selected
        : "tap a chip to shift agents \\u00b7 baton: " + (p.holder || "\\u2014");
      var bar = document.getElementById("routebar");
      var r = p.route;
      if (r && (r.status === "running" || r.status === "waiting_human")) {
        var pos = r.mode === "dynamic"
          ? "hop " + (r.current + 1) + (r.maxHops ? " of \\u2264" + r.maxHops : "")
          : "step " + (r.current + 1) + "/" + r.steps.length;
        bar.innerHTML = '<div class="routebar"><button class="abort" id="rabort">abort</button>&#10148; ' +
          esc(r.name || "route") + " " + pos + " &middot; " + esc(r.steps[r.current]) +
          (r.mode === "dynamic" && r.reason ? '<span style="opacity:.7"> &mdash; ' + esc(r.reason) + "</span>" : "") +
          (r.status === "waiting_human" ? '<div class="q">&#9208; ' + esc(r.pendingQuestion || "waiting for you") + " &mdash; reply below to resume</div>" : "") + "</div>";
        var ab = document.getElementById("rabort");
        if (ab) ab.onclick = function(){
          api("/api/projects/" + pid + "/route", { method: "DELETE" })
            .then(function(){ toast("route aborted"); refresh(); })
            .catch(function(err){ toast(err.message); });
        };
      } else { bar.innerHTML = ""; }
      var stat = document.getElementById("pstat");
      stat.textContent = p.needsInput
        ? "needs input"
        : p.costUsd > 0
          ? "$" + (p.costUsd >= 0.01 ? p.costUsd.toFixed(2) : p.costUsd.toFixed(4))
          : "";
    }

    function refresh(){
      api("/api/projects/" + pid).then(function(j){
        state.project = j.project;
        var nm = document.getElementById("pname"); if (nm) nm.textContent = j.project.name;
        drawChips();
      }).catch(function(err){ toast(err.message); });
    }

    function append(events){
      var feed = document.getElementById("feed"); if (!feed) return;
      if (feed.firstChild && feed.firstChild.className === "sys") feed.innerHTML = "";
      var html = "";
      events.forEach(function(e){
        if (e.id <= state.lastId) return;
        state.lastId = e.id;
        html += lineFor(e);
      });
      if (html) { feed.insertAdjacentHTML("beforeend", html);
        window.scrollTo(0, document.body.scrollHeight); }
    }

    api("/api/projects/" + pid + "/events?limit=60")
      .then(function(j){ append(j.events || []); })
      .catch(function(err){ toast(err.message); });
    refresh();
    state.timers.push(setInterval(refresh, 4000));

    function connect(){
      var proto = location.protocol === "https:" ? "wss://" : "ws://";
      var ws = new WebSocket(proto + location.host + "/ws?token=" + encodeURIComponent(state.token) + "&project=" + encodeURIComponent(pid));
      state.ws = ws;
      ws.onmessage = function(ev){
        try {
          var frame = JSON.parse(ev.data);
          if (frame.type === "event" && frame.event) append([frame.event]);
        } catch (e) {}
      };
      ws.onclose = function(){
        if (state.pid === pid) state.timers.push(setTimeout(connect, 3000));
      };
    }
    connect();

    function send(){
      var box = document.getElementById("box");
      var text = (box.value || "").trim();
      if (!text) return;
      box.value = "";
      var p = state.project || {};
      var chain = Promise.resolve();
      if (state.selected && state.selected !== p.holder) {
        chain = api("/api/projects/" + pid + "/handoff", { method: "POST", body: JSON.stringify({ to: state.selected }) });
      }
      chain.then(function(){
        return api("/api/projects/" + pid + "/messages", { method: "POST", body: JSON.stringify({ text: text, agentId: state.selected || undefined }) });
      }).then(refresh).catch(function(err){ toast(err.message); });
    }
    document.getElementById("cform").addEventListener("submit", function(ev){
      ev.preventDefault(); send();
    });
  }

  // ---- router ----------------------------------------------------------
  function route(){
    if (!state.token) return renderPair();
    var m = location.hash.match(/^#p\\/(.+)$/);
    if (m) return renderThread(m[1]);
    renderBoard();
  }
  window.addEventListener("hashchange", route);
  pairFromHash().then(function(paired){
    if (paired) toast("paired \\u2713");
    route();
  }).catch(function(err){ toast(err.message); route(); });
})();
</script>
</body>
</html>`;
