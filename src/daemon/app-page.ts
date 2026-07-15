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
  background_color: "#0a0d13",
  theme_color: "#0a0d13",
  icons: [
    {
      src:
        "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Crect width='100' height='100' rx='22' fill='%230a0d13'/%3E%3Ctext x='50' y='66' font-size='42' text-anchor='middle' fill='%2367e8f9' font-family='monospace' font-weight='bold'%3Elo%3C/text%3E%3C/svg%3E",
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
<meta name="theme-color" content="#0a0d13">
<link rel="manifest" href="/app/manifest.webmanifest">
<title>Loom</title>
<style>
  :root{
    --ink:#0a0d13;--ink-2:#0c1017;--panel:#111725;--panel-2:#161d2c;
    --line:#1f2838;--line-2:#2a3446;
    --text:#e6ecf6;--dim:#8a97ad;--faint:#57627a;
    --thread:#67e8f9;--thread-2:#2b525e;
    --shuttle:#e879f9;
    --ok:#4ade80;--warn:#fbbf24;--err:#fb7185;
    --r:14px;--r-sm:10px;
    --mono:ui-monospace,"SF Mono","JetBrains Mono",Menlo,monospace;
    --sans:-apple-system,"Inter",system-ui,"Segoe UI",Roboto,sans-serif;
    /* legacy aliases so inline var(--accent)/(--mag) styles keep working */
    --accent:var(--thread);--mag:var(--shuttle);--bg:var(--ink);
  }
  *{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
  html,body{margin:0}
  body{background:var(--ink);color:var(--text);font:15px/1.5 var(--sans);
    padding-bottom:env(safe-area-inset-bottom);min-height:100vh}
  body::before{content:"";position:fixed;inset:0;z-index:-1;pointer-events:none;
    background:
      radial-gradient(120% 55% at 50% -12%, rgba(103,232,249,.06), transparent 60%),
      repeating-linear-gradient(90deg, rgba(255,255,255,.015) 0 1px, transparent 1px 27px)}
  ::selection{background:rgba(103,232,249,.24)}
  #root{max-width:760px;margin:0 auto;min-height:100vh;display:flex;flex-direction:column}
  header{position:sticky;top:0;z-index:5;
    background:linear-gradient(180deg,rgba(10,13,19,.92),rgba(10,13,19,.72));
    backdrop-filter:blur(14px) saturate(1.2);
    border-bottom:1px solid transparent;border-image:linear-gradient(90deg,transparent,var(--line-2),transparent) 1;
    padding:calc(12px + env(safe-area-inset-top)) 16px 12px;display:flex;align-items:center;gap:11px}
  .logo{font-family:var(--mono);font-weight:700;font-size:19px;letter-spacing:.5px;position:relative;color:var(--text)}
  .logo b{color:var(--thread)}
  .logo::after{content:"";position:absolute;left:0;right:0;bottom:-3px;height:2px;
    background:linear-gradient(90deg,transparent,var(--thread-2),transparent);opacity:.7}
  .sub{color:var(--faint);font-size:11px;font-family:var(--mono);letter-spacing:.08em;text-transform:uppercase;
    overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .spacer{margin-left:auto}
  main{flex:1;padding:16px 16px 100px}
  button{background:var(--panel-2);color:var(--text);border:1px solid var(--line);border-radius:var(--r-sm);
    padding:9px 13px;font:inherit;font-size:14px;cursor:pointer;transition:border-color .15s,background .15s,transform .1s}
  button:hover{border-color:var(--line-2)}
  button:active{transform:translateY(1px)}
  button.primary{background:linear-gradient(180deg,#7bedfb,#4fd6ea);color:#04141a;border-color:transparent;font-weight:650;
    box-shadow:inset 0 1px 0 rgba(255,255,255,.18),0 5px 18px -7px rgba(103,232,249,.55)}
  button.primary:hover{filter:brightness(1.05)}
  .iconbtn{width:37px;height:37px;padding:0;display:inline-flex;align-items:center;justify-content:center;font-size:15px;color:var(--dim);background:transparent;border-color:transparent}
  .iconbtn:hover{color:var(--text);background:var(--panel-2);border-color:var(--line)}
  :focus-visible{outline:2px solid var(--thread);outline-offset:2px}
  .card{position:relative;background:linear-gradient(180deg,var(--panel),var(--ink-2));
    border:1px solid var(--line);border-radius:var(--r);padding:15px 16px 14px;margin-bottom:12px;
    overflow:hidden;transition:border-color .15s,transform .12s;cursor:pointer}
  .card:hover{border-color:var(--line-2);transform:translateY(-1px)}
  .card::before{content:"";position:absolute;top:0;left:16px;right:16px;height:1px;
    background:linear-gradient(90deg,transparent,var(--thread-2),transparent);opacity:.6}
  .card .row1{display:flex;align-items:center;gap:10px;font-weight:600;font-size:15.5px}
  .card .row2{color:var(--dim);font-size:12.5px;margin-top:5px;font-family:var(--mono);letter-spacing:.02em}
  .dot{width:8px;height:8px;border-radius:50%;background:#3a4557;flex:none;position:relative}
  .dot.hot{background:var(--warn)}
  .dot.hot::after{content:"";position:absolute;inset:-4px;border-radius:50%;border:1px solid var(--warn);opacity:.5;animation:pulse 1.8s ease-out infinite}
  @keyframes pulse{0%{transform:scale(.6);opacity:.6}100%{transform:scale(1.7);opacity:0}}
  .badge{font-family:var(--mono);font-size:11px;color:var(--thread);background:rgba(103,232,249,.08);
    border:1px solid var(--thread-2);border-radius:999px;padding:2px 9px;margin-left:auto;letter-spacing:.02em}
  .chips{display:flex;gap:8px;overflow-x:auto;padding:12px 16px;position:sticky;top:60px;z-index:4;
    background:linear-gradient(180deg,rgba(10,13,19,.92),rgba(10,13,19,.68));backdrop-filter:blur(14px);
    border-bottom:1px solid var(--line);scrollbar-width:none}
  .chips::-webkit-scrollbar{display:none}
  .chip{flex:none;font-family:var(--mono);font-size:12.5px;padding:6px 13px;border-radius:999px;
    border:1px solid var(--line);color:var(--dim);background:var(--panel-2);transition:all .15s;cursor:pointer}
  .chip:hover{border-color:var(--line-2);color:var(--text)}
  .chip.sel{color:#04141a;background:linear-gradient(180deg,#7bedfb,#4fd6ea);border-color:transparent;font-weight:650;
    box-shadow:0 3px 14px -6px rgba(103,232,249,.6)}
  .chip .role{opacity:.72;font-size:11px}
  .msg{margin:10px 0;display:flex;flex-direction:column}
  .msg .who{font-family:var(--mono);font-size:11px;color:var(--dim);margin:0 2px 3px;letter-spacing:.04em}
  .msg .bubble{max-width:88%;padding:10px 13px;border-radius:13px;white-space:pre-wrap;word-break:break-word;font-size:14.5px;line-height:1.5}
  .msg.user{align-items:flex-end}
  .msg.user .bubble{background:linear-gradient(180deg,rgba(103,232,249,.12),rgba(103,232,249,.05));
    border:1px solid var(--thread-2);border-bottom-right-radius:4px;color:#eafaff}
  .msg.agent{align-items:flex-start}
  .msg.agent .bubble{background:var(--panel);border:1px solid var(--line);border-left:2px solid var(--line-2);border-bottom-left-radius:4px}
  .sys{color:var(--dim);font-size:12.5px;text-align:center;margin:10px 0;font-family:var(--mono);letter-spacing:.02em}
  .sys.warn{color:var(--warn)}
  .sys.err{color:var(--err)}
  .sys.mag{color:var(--shuttle)}
  .tool{color:var(--faint);font-size:11.5px;font-family:var(--mono);margin:3px 0 3px 14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .handoff{display:flex;align-items:center;justify-content:center;gap:10px;margin:13px 0;font-family:var(--mono);font-size:12px}
  .handoff .a{color:var(--dim)}
  .handoff .shuttle{color:var(--shuttle);font-size:16px;filter:drop-shadow(0 0 6px rgba(232,121,249,.5));animation:glide .5s ease}
  .handoff .b{color:var(--shuttle)}
  @keyframes glide{from{transform:translateX(-10px);opacity:0}to{transform:translateX(0);opacity:1}}
  .loader{display:flex;flex-direction:column;gap:5px;align-items:center;padding:28px 0}
  .loader i{display:block;width:54px;height:2px;border-radius:2px;background:var(--line-2);position:relative;overflow:hidden}
  .loader i::after{content:"";position:absolute;left:-40%;top:0;width:40%;height:100%;
    background:linear-gradient(90deg,transparent,var(--thread),transparent);animation:weave 1.15s ease-in-out infinite}
  .loader i:nth-child(2)::after{animation-delay:.14s}
  .loader i:nth-child(3)::after{animation-delay:.28s}
  .loader i:nth-child(4)::after{animation-delay:.42s}
  @keyframes weave{0%{left:-40%}100%{left:100%}}
  .routebar{position:sticky;top:110px;z-index:3;background:linear-gradient(180deg,#122536,#0e1a28);
    border:1px solid var(--thread-2);border-radius:12px;padding:10px 13px;margin:12px 0;font-size:13px;
    box-shadow:0 8px 24px -14px rgba(103,232,249,.4)}
  .routebar .q{color:var(--warn);margin-top:5px}
  .routebar .abort{float:right;font-size:11px;padding:3px 10px}
  .sheet{background:linear-gradient(180deg,var(--panel),var(--ink-2));border:1px solid var(--line);border-radius:var(--r);
    padding:14px;margin:12px 0;display:flex;flex-direction:column;gap:10px;animation:sheetin .2s ease}
  @keyframes sheetin{from{opacity:0;transform:translateY(-4px)}to{opacity:1;transform:none}}
  .sheet select,.sheet input{background:var(--ink-2);border:1px solid var(--line);border-radius:var(--r-sm);color:var(--text);padding:10px 11px;font:inherit;width:100%}
  .sheet .row{display:flex;gap:8px}
  .sheet .row button{flex:1}
  .sheet label{font-family:var(--mono);font-size:10.5px;color:var(--faint);letter-spacing:.12em;text-transform:uppercase}
  .composer{z-index:6;
    background:linear-gradient(180deg,rgba(10,13,19,.65),rgba(10,13,19,.97));backdrop-filter:blur(14px);
    border-top:1px solid var(--line);padding:12px 14px calc(12px + env(safe-area-inset-bottom))}
  .composer .inner{max-width:900px;margin:0 auto;display:flex;gap:9px;align-items:center}
  .composer input{flex:1;background:var(--panel-2);border:1px solid var(--line);border-radius:12px;color:var(--text);padding:12px 14px;font:inherit;font-size:15px;outline:none;transition:border-color .15s,box-shadow .15s}
  .composer input:focus{border-color:var(--thread);box-shadow:0 0 0 3px rgba(103,232,249,.12)}
  .hint{color:var(--faint);font-size:11px;font-family:var(--mono);letter-spacing:.02em;max-width:760px;margin:7px auto 0;text-align:center}
  #toast{position:fixed;left:50%;transform:translateX(-50%) translateY(6px);bottom:94px;z-index:20;
    background:rgba(18,24,36,.96);color:var(--text);border:1px solid var(--line-2);border-radius:11px;
    padding:9px 15px;font-size:13px;opacity:0;transition:opacity .2s,transform .2s;pointer-events:none;max-width:86%;
    box-shadow:0 12px 30px -12px rgba(0,0,0,.7)}
  #toast.show{opacity:1;transform:translateX(-50%) translateY(0)}
  .pairwrap{display:flex;flex-direction:column;gap:16px;align-items:center;justify-content:center;
    min-height:84vh;padding:28px;text-align:center;max-width:440px;margin:0 auto}
  .pairwrap .biglogo{font-family:var(--mono);font-size:44px;font-weight:700;letter-spacing:2px;position:relative}
  .pairwrap .biglogo b{color:var(--thread)}
  .pairwrap .tag{color:var(--dim);font-size:14px;line-height:1.5}
  .pairwrap .hair{width:64px;height:2px;background:linear-gradient(90deg,transparent,var(--thread),transparent)}
  .pairwrap input{width:100%;background:var(--panel-2);border:1px solid var(--line);border-radius:12px;color:var(--text);padding:13px;font:inherit;text-align:center;outline:none}
  .pairwrap input:focus{border-color:var(--thread);box-shadow:0 0 0 3px rgba(103,232,249,.12)}
  .pairwrap button.primary{width:100%;padding:13px}
  .pairwrap .help{color:var(--faint);font-size:12px;line-height:1.6}
  .pairwrap .help b{color:var(--dim);font-weight:600}
  .spin{display:inline-block;animation:spin 1s linear infinite}
  @keyframes spin{to{transform:rotate(360deg)}}
  /* thread as a self-contained flex panel: header/chips fixed rows, feed scrolls, composer docked */
  .panel{display:flex;flex-direction:column;height:100dvh;min-height:0}
  .panel .scroll{flex:1;min-height:0;overflow-y:auto;padding:16px 16px 20px}
  .panel .scroll::-webkit-scrollbar{width:9px}
  .panel .scroll::-webkit-scrollbar-thumb{background:var(--line-2);border-radius:9px;border:3px solid transparent;background-clip:content-box}
  .panel > .chips{position:static;top:auto}
  .panel > header{position:static}
  /* desktop workspace shell: projects rail + conversation */
  .dshell{display:grid;grid-template-columns:304px 1fr;height:100dvh}
  .sidebar{border-right:1px solid var(--line);display:flex;flex-direction:column;min-width:0;
    background:linear-gradient(180deg,var(--ink-2),var(--ink))}
  .sidebar .shead{display:flex;align-items:center;gap:11px;padding:18px 16px 14px;border-bottom:1px solid var(--line)}
  .sidebar .slist{flex:1;overflow-y:auto;padding:10px}
  .sidebar .stitle{font-family:var(--mono);font-size:10.5px;color:var(--faint);letter-spacing:.14em;text-transform:uppercase;padding:6px 8px 8px}
  .srow{padding:11px 12px;border-radius:10px;border:1px solid transparent;cursor:pointer;margin-bottom:4px;transition:background .12s,border-color .12s}
  .srow:hover{background:var(--panel-2)}
  .srow.sel{background:var(--panel);border-color:var(--line-2)}
  .srow .n{font-weight:600;font-size:14px;display:flex;align-items:center;gap:8px}
  .srow .m{color:var(--dim);font-family:var(--mono);font-size:11.5px;margin-top:4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .dmain{min-width:0;display:flex;flex-direction:column;position:relative}
  .dmain .panel{height:100%}
  .dmain .composer .inner,.dmain .hint{max-width:none}
  .dempty{flex:1;display:flex;flex-direction:column;gap:10px;align-items:center;justify-content:center;color:var(--faint);font-family:var(--mono);font-size:13px}
  .dempty .biglogo{font-size:40px;font-weight:700;letter-spacing:2px;color:var(--text)}
  .dempty .biglogo b{color:var(--thread)}
  /* on wide screens the app-shell fills the window and owns the height */
  @media (min-width:900px){
    #root{max-width:none;height:100dvh;display:block}
    /* readable, centered conversation column — messages never stretch full width */
    .dmain .scroll > #feed,.dmain .scroll > #routesheet,.dmain .scroll > #routebar{max-width:840px;margin-inline:auto}
    .dmain .composer .inner{max-width:840px}
    .dmain .msg .bubble{max-width:82%}
    .dmain > .panel > header{padding-left:20px;padding-right:18px}
    .srow .badge{font-size:10px;padding:1px 7px}
  }
  @media (prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}
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
    t.classList.add("show"); clearTimeout(t._t); t._t = setTimeout(function(){ t.classList.remove("show"); }, 2600); }
  function hue(id){ var h = 0; for (var i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) % 360; return h; }
  var LOADER = '<div class="loader"><i></i><i></i><i></i><i></i></div>';
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
    clearShell();
    root.innerHTML =
      '<div class="pairwrap">' +
      '<div class="biglogo">lo<b>om</b></div>' +
      '<div class="tag">the shared-memory layer for your AI dev environments</div>' +
      '<div class="hair"></div>' +
      '<input id="ptok" placeholder="pairing token or link" autocomplete="off" autocapitalize="off" spellcheck="false">' +
      '<button class="primary" id="pgo">Pair this device</button>' +
      '<div class="help">On your computer: <b>loom up --tailnet</b>, then <b>loom pair</b>.<br>Scan the QR, or paste the token or whole link above.</div>' +
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
    clearShell();
    root.innerHTML =
      '<header><span class="logo">lo<b>om</b></span><span class="sub">projects</span>' +
      '<span class="spacer"></span>' +
      '<button id="unpair" class="iconbtn" title="unpair this device" style="width:auto;padding:0 12px;font-size:12px">unpair</button></header>' +
      '<main id="list">' + LOADER + '</main>';
    document.getElementById("unpair").onclick = logout;
    function refresh(){
      api("/api/projects").then(function(j){
        state.projects = j.projects || [];
        var el = document.getElementById("list");
        if (!el) return;
        if (!state.projects.length) { el.innerHTML = '<div class="sys" style="padding:40px 0;line-height:1.7">no projects woven yet<br><span style="color:var(--faint)">run <b style="color:var(--dim)">loom init</b> in a repo on your computer</span></div>'; return; }
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
      var h = hue(e.agentId);
      return '<div class="msg agent"><div class="who" style="color:hsl(' + h + ',65%,72%)">' + esc(e.agentId) + '</div><div class="bubble" style="border-left-color:hsl(' + h + ',50%,52%)">' + esc(p.text) + "</div></div>";
    }
    if (e.kind === "tool_call") return '<div class="tool">&#9881; ' + esc(p.summary || p.tool) + "</div>";
    if (e.kind === "file_edit") return '<div class="tool">&#9998; ' + esc(p.path) + "</div>";
    if (e.kind === "turn_diff") {
      var fl = (p.files || []).map(function(f){ return f.path; });
      return '<div class="sys">&#9998; changed ' + fl.length + " file" + (fl.length === 1 ? "" : "s") +
        " (+" + Number(p.added || 0) + " &minus;" + Number(p.removed || 0) + "): " +
        esc(fl.slice(0, 3).join(", ")) + (fl.length > 3 ? " &hellip;" : "") + "</div>";
    }
    if (e.kind === "handoff") return '<div class="handoff"><span class="a">' + esc(p.from || "\\u2014") + '</span><span class="shuttle">&#10239;</span><span class="b">' + esc(p.to || "\\u2014") + "</span></div>";
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

  function renderThread(pid, mount){
    mount = mount || root;
    clearTimers();
    state.pid = pid; state.lastId = 0; state.selected = null;
    mount.innerHTML =
      '<div class="panel">' +
      '<header>' + (isDesktop() ? "" : '<button id="back" class="iconbtn">&larr;</button>') +
      '<span class="logo" id="pname" style="font-size:16px">&hellip;</span><span class="sub" id="pstat"></span>' +
      '<span class="spacer"></span>' +
      '<button id="brainbtn" class="iconbtn" title="unified memory">&#129504;</button>' +
      '<button id="treebtn" class="iconbtn" title="working tree">&plusmn;</button>' +
      '<button id="routebtn" class="iconbtn" title="routes">&#10148;</button>' +
      '<button id="stop" class="iconbtn" title="interrupt">&#9632;</button></header>' +
      '<div class="chips" id="chips"></div>' +
      '<div class="scroll"><div id="routesheet"></div><div id="routebar"></div><div id="feed">' + LOADER + '</div></div>' +
      '<div class="composer"><form class="inner" id="cform">' +
      '<input id="box" placeholder="Message&hellip;" autocomplete="off">' +
      '<button class="primary" id="send" type="submit">&#10148;</button></form>' +
      '<div class="hint" id="hint"></div></div>' +
      '</div>';
    var backBtn = document.getElementById("back");
    if (backBtn) backBtn.onclick = function(){ location.hash = ""; };
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
      el.innerHTML = '<div class="sheet"><label>unified memory</label>' + LOADER + '</div>';
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
      el.innerHTML = '<div class="sheet"><label>working tree</label>' + LOADER + '</div>';
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
      if (feed.firstChild && (feed.firstChild.className === "sys" || feed.firstChild.className === "loader")) feed.innerHTML = "";
      var html = "";
      events.forEach(function(e){
        if (e.id <= state.lastId) return;
        state.lastId = e.id;
        html += lineFor(e);
      });
      if (html) { feed.insertAdjacentHTML("beforeend", html);
        var sc = feed.parentNode;
        if (sc && sc.scrollHeight) sc.scrollTop = sc.scrollHeight;
        else window.scrollTo(0, document.body.scrollHeight); }
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
  var mq = window.matchMedia("(min-width:900px)");
  function isDesktop(){ return mq.matches; }
  function clearShell(){ if (state.shellTimer) { clearInterval(state.shellTimer); state.shellTimer = null; } }

  // Desktop workspace: projects rail + live conversation, side by side.
  function renderShell(){
    clearTimers();
    clearShell();
    var m = location.hash.match(/^#p\\/(.+)$/);
    var cur = m ? m[1] : null;
    root.innerHTML =
      '<div class="dshell">' +
      '<aside class="sidebar">' +
        '<div class="shead"><span class="logo">lo<b>om</b></span><span class="spacer"></span>' +
        '<button id="unpair" class="iconbtn" title="unpair this device" style="width:auto;padding:0 12px;font-size:12px">unpair</button></div>' +
        '<div class="stitle">projects</div>' +
        '<div class="slist" id="slist">' + LOADER + '</div>' +
      '</aside>' +
      '<section class="dmain" id="dmain"></section>' +
      '</div>';
    document.getElementById("unpair").onclick = logout;
    var dmain = document.getElementById("dmain");
    function drawEmpty(){
      dmain.innerHTML = '<div class="dempty"><div class="biglogo">lo<b>om</b></div>' +
        "<div>select a project to open its thread</div></div>";
    }
    function markSel(){
      Array.prototype.forEach.call(document.querySelectorAll("#slist .srow"), function(row){
        row.className = "srow" + (row.getAttribute("data-id") === cur ? " sel" : "");
      });
    }
    function select(pid){
      cur = pid;
      history.replaceState(null, "", "#p/" + pid);
      renderThread(pid, dmain);
      markSel();
    }
    function refresh(){
      api("/api/projects").then(function(j){
        state.projects = j.projects || [];
        var el = document.getElementById("slist"); if (!el) return;
        if (!state.projects.length) {
          el.innerHTML = '<div class="sys" style="padding:24px 8px;line-height:1.6">no projects yet<br><span style="color:var(--faint)">run <b style="color:var(--dim)">loom init</b></span></div>';
          drawEmpty(); return;
        }
        el.innerHTML = state.projects.map(function(p){
          var r = p.route, act = r && (r.status === "running" || r.status === "waiting_human");
          return '<div class="srow" data-id="' + esc(p.id) + '">' +
            '<div class="n"><span class="dot' + (p.needsInput ? " hot" : "") + '"></span>' + esc(p.name) +
            (act ? '<span class="badge" style="margin-left:auto">&#10148; ' + (r.current + 1) + "</span>" : "") + "</div>" +
            '<div class="m">baton ' + esc(p.holder || "\\u2014") +
            (p.costUsd > 0 ? " \\u00b7 $" + (p.costUsd >= 0.01 ? p.costUsd.toFixed(2) : p.costUsd.toFixed(4)) : "") + "</div></div>";
        }).join("");
        Array.prototype.forEach.call(el.querySelectorAll(".srow"), function(row){
          row.onclick = function(){ select(row.getAttribute("data-id")); };
        });
        var exists = state.projects.some(function(p){ return p.id === cur; });
        if ((!cur || !exists) && !document.getElementById("feed")) select(state.projects[0].id);
        else markSel();
      }).catch(function(err){ toast(err.message); });
    }
    if (!cur) drawEmpty();
    refresh();
    state.shellTimer = setInterval(refresh, 5000);
  }

  function route(){
    if (!state.token) return renderPair();
    if (isDesktop()) return renderShell();
    var m = location.hash.match(/^#p\\/(.+)$/);
    if (m) return renderThread(m[1]);
    renderBoard();
  }
  window.addEventListener("hashchange", function(){ if (!isDesktop()) route(); });
  mq.addEventListener("change", function(){ clearShell(); route(); });
  pairFromHash().then(function(paired){
    if (paired) toast("paired \\u2713");
    route();
  }).catch(function(err){ toast(err.message); route(); });
})();
</script>
</body>
</html>`;
