/** Browser statusbar module. See README.md for ownership and startup. */
import { openConnectPhone } from './connect-phone.js';
import { api } from './connection.js';
import { clog } from './console.js';
import { esc,money,pageGone } from './format.js';
import { ICONS,LOADER } from './icons.js';
import { announce,toast,updateAmbient } from './notifications.js';
import { openSettingsModal } from './settings.js';
import { state } from './state.js';
import { railOpen,toggleRail } from './layout.js';


  // ---- git delivery (per project; the status bar's toggle) -----------------
  // What happens to finished work without you asking: nothing, a commit per
  // turn, a push after it, or — for an orchestra — its own branch and a PR.
  // It is project config (PATCH /config), so the CLI and a phone see the same.
  var GIT_DELIVERY = [
    { mode: "push", name: "Commit & push", short: "\u21e1 push", icon: "",
      sub: "Each turn is committed; a finished orchestra merges into your branch, then pushes." },
    { mode: "pr", name: "Commit & open PR", short: "\u21e1 PR", icon: "", menuIcon: ICONS.pr,
      sub: "Each turn is committed; a finished orchestra pushes its own branch and opens a PR through gh." },
    { mode: "commit", name: "Commit only", short: "commit", icon: ICONS.branch,
      sub: "Each turn is committed; a finished orchestra merges into your branch. Nothing leaves this machine." },
    { mode: "none", name: "No commit", short: "no commit", icon: ICONS.branch,
      sub: "Nothing is committed for you \u2014 the working tree is yours to commit." },
  ];

  function gitDeliveryInfo(mode){ return GIT_DELIVERY.filter(function(g){ return g.mode === mode; })[0] || GIT_DELIVERY[3]; }

  function loadGitDelivery(pid){
    api("/api/projects/" + pid + "/config").then(function(j){
      if (state.pid !== pid) return;
      state.gitDel = { pid: pid, mode: (j && j.git && j.git.delivery) || "none" };
      drawStatusbar();
    }).catch(function(){});
  }

  function setGitDelivery(pid, mode){
    var was = state.gitDel;
    state.gitDel = { pid: pid, mode: mode }; drawStatusbar(); // paint now; the PATCH confirms or puts it back
    api("/api/projects/" + pid + "/config", { method: "PATCH", body: JSON.stringify({ git: { delivery: mode } }) })
      .then(function(j){
        state.gitDel = { pid: pid, mode: (j && j.git && j.git.delivery) || "none" };
        drawStatusbar();
        toast("git delivery \u2192 " + gitDeliveryInfo(state.gitDel.mode).name.toLowerCase());
      })
      .catch(function(err){ state.gitDel = was; drawStatusbar(); toast(err.message); });
  }

  /** The four policies as a menu, opened upward from the status bar. */
  function openGitDeliveryMenu(anchor){
    if (document.getElementById("gdmenu")) { closeGitDeliveryMenu(); return; }
    var p = state.project, gd = state.gitDel; if (!p || !gd) return;
    var m = document.createElement("div");
    m.id = "gdmenu"; m.className = "gdmenu"; m.setAttribute("role", "menu");
    m.innerHTML = '<div class="gdh">Git delivery<span class="gdp">' + esc(p.name || p.id) + "</span></div>" +
      GIT_DELIVERY.map(function(g){
        return '<button class="gdi' + (g.mode === gd.mode ? " sel" : "") + '" type="button" role="menuitemradio" aria-checked="' + (g.mode === gd.mode) + '" data-gd="' + g.mode + '">' +
          '<span class="gic">' + (g.menuIcon || g.icon || ICONS.push) + '</span><span class="gdt"><b>' + esc(g.name) + "</b><small>" + esc(g.sub) + "</small></span>" +
          (g.mode === gd.mode ? '<span class="tick">' + ICONS.check + "</span>" : "") + "</button>";
      }).join("") +
      '<div class="gdf">Per project \u00b7 saved in its Loom config</div>';
    document.body.appendChild(m);
    var r = anchor.getBoundingClientRect();
    m.style.left = Math.max(8, Math.min(window.innerWidth - m.offsetWidth - 8, Math.round(r.left))) + "px";
    m.style.top = Math.max(8, Math.round(r.top - m.offsetHeight - 6)) + "px";
    Array.prototype.forEach.call(m.querySelectorAll("[data-gd]"), function(b){
      b.onclick = function(){ var mode = b.getAttribute("data-gd"); closeGitDeliveryMenu(); if (mode !== gd.mode) setGitDelivery(p.id, mode); };
    });
    var first = m.querySelector(".gdi.sel") || m.querySelector(".gdi"); if (first) first.focus();
    setTimeout(function(){ document.addEventListener("mousedown", gdAway); document.addEventListener("keydown", gdKey); }, 0);
  }

  function gdAway(ev){ var m = document.getElementById("gdmenu"); if (m && !m.contains(ev.target) && ev.target.id !== "gitdel" && !(ev.target.closest && ev.target.closest("#gitdel"))) closeGitDeliveryMenu(); }

  function gdKey(ev){
    var m = document.getElementById("gdmenu"); if (!m) return;
    if (ev.key === "Escape") { closeGitDeliveryMenu(); return; }
    if (ev.key !== "ArrowDown" && ev.key !== "ArrowUp") return;
    ev.preventDefault();
    var items = Array.prototype.slice.call(m.querySelectorAll(".gdi"));
    var i = items.indexOf(document.activeElement);
    items[(i + (ev.key === "ArrowDown" ? 1 : -1) + items.length) % items.length].focus();
  }

  function closeGitDeliveryMenu(){
    document.removeEventListener("mousedown", gdAway); document.removeEventListener("keydown", gdKey);
    var m = document.getElementById("gdmenu"); if (m) m.remove();
  }


  // ---- status bar (desktop shell) ------------------------------------------
  /** Per-project spend budget (USD), kept in this browser. A control plane
   *  should be able to cap, not just watch. 0 / unset = no budget. */
  function budgetFor(pid){ try { var v = parseFloat(localStorage.getItem("loomBudget:" + pid) || ""); return isFinite(v) && v > 0 ? v : 0; } catch (e) { return 0; } }

  function setBudgetFor(pid, v){ try { if (v > 0) localStorage.setItem("loomBudget:" + pid, String(v)); else localStorage.removeItem("loomBudget:" + pid); } catch (e) {} }

  var _budgetWarned = {};

  /** Toast once when a project crosses 80% and again at 100% of its budget. */
  function checkBudget(p){
    if (!p || !(p.costUsd > 0)) return;
    var b = budgetFor(p.id); if (!b) return;
    var pct = p.costUsd / b, seen = _budgetWarned[p.id] || 0;
    if (pct >= 1 && seen < 2){ _budgetWarned[p.id] = 2;
      toast("\u26a0 " + (p.name || p.id) + " is over its $" + b.toFixed(2) + " budget (" + money(p.costUsd) + ")");
      announce((p.name || p.id) + " is over its spend budget"); }
    else if (pct >= 0.8 && seen < 1){ _budgetWarned[p.id] = 1;
      toast("\u26a0 " + (p.name || p.id) + " at " + Math.round(pct * 100) + "% of its $" + b.toFixed(2) + " budget"); }
    else if (pct < 0.8){ _budgetWarned[p.id] = 0; }
  }

  function drawStatusbar(){
    // a request that settles after the page is gone (a closed tab, a torn-down test window) has nothing to draw
    if (pageGone()) return;
    var el = document.getElementById("statusbar"); if (!el) return;
    var p = state.project;
    checkBudget(p);
    var busy = 0, total = 0;
    (state.projects || []).forEach(function(pr){
      total += pr.costUsd > 0 ? pr.costUsd : 0;
      (pr.agents || []).forEach(function(a){ if (a.busy) busy++; });
    });
    updateAmbient(busy, (state.projects || []).some(function(pr){ return pr.needsInput; }));
    var share = p && p.costUsd > 0 && total > 0 ? Math.min(100, Math.round((p.costUsd / total) * 100)) : 0;
    // GitHub connection — the whole PR/Projects/review half rides on gh being
    // logged in, so it lives in the corner you glance at, with a one-click
    // Connect when it isn't.
    var gh = state.github, ghSeg = "";
    if (gh && gh.connected) ghSeg = '<span class="sit ghok" title="GitHub connected as ' + esc(gh.user || "") + '">' + ICONS.github + " " + esc(gh.user || "connected") + "</span>";
    else if (gh && gh.installed) ghSeg = '<button class="sit ghconnect" id="ghconnect" title="sign in to GitHub in a terminal">' + ICONS.github + " Connect GitHub</button>";
    // LoomPad voice backend — when it's up, the physical pad gets its spoken
    // replies. Green pill = connected; grey = offline. Click to re-check.
    var lp = state.loompad, lpUp = !!(lp && lp.up);
    var lpSeg = '<button class="sit lppill' + (lpUp ? " on" : "") + '" id="lppill" title="' +
      (lpUp
        ? "LoomPad voice backend connected" + (lp && lp.brain ? " \u00b7 brain " + esc(String(lp.brain)) : "") + " \u2014 the pad can speak"
        : "LoomPad voice backend offline \u2014 start it so the pad can speak") +
      '"><span class="sdot' + (lpUp ? "" : " off") + '"></span>LoomPad' + (lpUp ? "" : " offline") + "</button>";
    // Git delivery sits beside GitHub: both answer "where does finished work
    // go?" — this one per project, read from its config, a click to change.
    var gd = state.gitDel, gdSeg = "";
    if (p && gd && gd.pid === p.id) {
      var gi = gitDeliveryInfo(gd.mode);
      gdSeg = '<button class="sit gitdel ' + esc(gi.mode) + '" id="gitdel" type="button" aria-haspopup="menu" title="git delivery for ' +
        esc(p.name || p.id) + ": " + esc(gi.name) + ' \u2014 click to change">' + gi.icon + esc(gi.short) + "</button>";
    }
    el.innerHTML =
      // a project's live socket when one is open; otherwise whether the daemon itself answers
      (function(){
        var up = p ? state.wsLive : state.daemonUp !== false;
        return '<span class="sit"><span class="sdot' + (up ? "" : " off") + '"></span>' + (up ? "live" : "offline") + "</span>";
      })() +
      '<span class="sit">' + esc(location.host) + "</span>" +
      (p ? '<span class="sit">baton ' + esc(p.holder || "\u2014") + "</span>" : "") +
      (p && p.costUsd > 0
        ? (function(){
            // With a budget set the meter measures spend against the cap, not
            // this project's share of the fleet — a share of Σ tells you nothing
            // about whether you're about to blow through what you meant to spend.
            var b = budgetFor(p.id);
            var cls = b ? (p.costUsd >= b ? " over" : (p.costUsd >= b * 0.8 ? " warn" : "")) : "";
            var w = b ? Math.min(100, Math.round((p.costUsd / b) * 100)) : share;
            var label = b ? money(p.costUsd) + " / $" + b.toFixed(2) : money(p.costUsd) + " \u00b7 " + share + "% of \u03a3";
            var tip = b ? "spend vs budget \u2014 click to adjust" : "usage breakdown \u2014 click to set a budget";
            return '<button class="sit usagepill' + cls + '" id="usagepill" title="' + tip + '"><span class="meter"><i style="width:' + w + '%"></i></span>' + label + "</button>";
          })()
        : "") +
      '<span class="spacer"></span>' +
      // A newer Loom is worth one quiet pill, not a banner: it opens the
      // Updates section, where the button says exactly what it will run.
      (state.update && state.update.behindRelease
        ? '<button class="sit updready" id="updready" title="Loom ' + esc(state.update.latest) + ' is out — open Updates">' + ICONS.up + " " + esc(state.update.latest) + "</button>"
        : "") +
      lpSeg +
      branchSeg() +
      gdSeg +
      ghSeg +
      (busy ? '<span class="sit" style="color:var(--live)">' + busy + " working</span>" : "") +
      '<span class="sit">' + (state.projects || []).length + " project" + ((state.projects || []).length === 1 ? "" : "s") + "</span>" +
      (total > 0 ? '<span class="sit">\u03a3 ' + money(total) + "</span>" : "");
    var ur = document.getElementById("updready");
    if (ur) ur.onclick = function(){ openSettingsModal("updates"); };
    var gc = document.getElementById("ghconnect");
    if (gc) gc.onclick = connectGithub;
    var lpp = document.getElementById("lppill");
    if (lpp) lpp.onclick = openLoomPad;
    var upill = document.getElementById("usagepill");
    if (upill) upill.onclick = openUsage;
    var gdb = document.getElementById("gitdel");
    if (gdb) gdb.onclick = function(){ openGitDeliveryMenu(gdb); };
    var brb = document.getElementById("branchpill");
    if (brb) brb.onclick = function(){
      if (!state.showRail) { toast("open a project to see its changes"); return; }
      if (!railOpen()) toggleRail(); // the panel is closed on laptop widths: open it
      state.showRail("scm");
    };
  }
  /**
   * The open project's branch, where it stands against its upstream, and how
   * many files are changed — Loom's own .loom/ bookkeeping not counted.
   * Polled gently (git status in a big repo isn't free) and after each turn.
   */
  function branchSeg(){
    var g = state.gitStat, p = state.project;
    if (!g || !p || g.pid !== p.id || !g.branch) return "";
    var bits = (g.ahead ? " ↑" + g.ahead : "") + (g.behind ? " ↓" + g.behind : "");
    return '<button class="sit branchpill' + (g.changed ? " dirty" : "") + '" id="branchpill" type="button" title="' +
      esc(g.branch + (g.changed ? " · " + g.changed + " changed file" + (g.changed === 1 ? "" : "s") : " · clean") + (g.upstream ? " · tracking " + g.upstream : "") + " — open Source Control") + '">' +
      ICONS.branch + esc(g.branch) + esc(bits) + (g.changed ? '<span class="bpn">' + g.changed + "</span>" : "") + "</button>";
  }
  function loadGitStat(){
    var p = state.project; if (!state.token || !p || !p.id) return;
    var pid = p.id;
    api("/api/projects/" + pid + "/git/status").then(function(s){
      var mine = function(f){ var n = typeof f === "string" ? f : (f && (f.path || f.file)) || ""; return n.indexOf(".loom/") !== 0; };
      var changed = (s.staged || []).concat(s.unstaged || [], s.untracked || []).filter(mine);
      var seen = {}; changed.forEach(function(f){ seen[typeof f === "string" ? f : (f.path || f.file)] = 1; });
      state.gitStat = { pid: pid, branch: s.branch || "", ahead: s.ahead || 0, behind: s.behind || 0, upstream: s.upstream || null, changed: Object.keys(seen).length };
      drawStatusbar();
    }).catch(function(){ state.gitStat = { pid: pid, branch: "" }; drawStatusbar(); });
  }
  state.loadGitStat = loadGitStat;
  if (!window.__gitPoll) window.__gitPoll = setInterval(function(){ if (!document.hidden) loadGitStat(); }, 15000);


  // GitHub connection, fetched once and after a connect. Machine-wide (gh auth
  // is per-host), so it's cached on state and shown in the status bar.
  function loadGithub(){
    if (!state.token) return;
    api("/api/github/status").then(function(s){ state.github = s; drawStatusbar(); }).catch(function(){});
  }

  // LoomPad voice-backend health, shown as a pill in the status bar and polled so
  // the demo can see the pad go live the moment the backend starts.
  function loadLoomPad(){
    if (!state.token) return;
    api("/api/loompad/health")
      .then(function(s){ state.loompad = s; drawStatusbar(); })
      .catch(function(){ state.loompad = { up:false }; drawStatusbar(); });
  }

  // Is there a newer Loom? The daemon caches the answer for hours, so asking on
  // open and once an hour costs nothing and means the pill is there when it
  // matters. Never acts on what it finds — that's a button, and a confirm.
  function loadUpdate(){
    if (!state.token) return;
    api("/api/updates")
      .then(function(u){ state.update = u; drawStatusbar(); })
      .catch(function(){});
  }

  // Click the $ pill: a usage breakdown — this project's share and every
  // project's spend against the running total.
  function openUsage(){
    if (document.querySelector(".scrim")) return;
    var projs = (state.projects || []);
    var total = 0; projs.forEach(function(pr){ total += pr.costUsd > 0 ? pr.costUsd : 0; });
    var cur = state.project;
    var rows = projs.slice().sort(function(a,b){ return (b.costUsd||0)-(a.costUsd||0); });
    var body;
    if (!total){ body = '<div class="phmsg">No spend yet on this daemon.</div>'; }
    else {
      body = '<div class="usagerows">';
      rows.forEach(function(pr){
        var pct = total > 0 ? Math.round(((pr.costUsd||0)/total)*100) : 0;
        var isCur = cur && pr.id === cur.id;
        body += '<div class="usagerow' + (isCur ? " cur" : "") + '" data-usagepid="' + esc(pr.id) + '" title="open its spend and token breakdown">' +
          '<div class="usagetop"><span class="usagename">' + esc(pr.name || pr.id) + (isCur ? ' <span class="usagecur">this project</span>' : "") + '</span><span class="usageval">' + money(pr.costUsd||0) + '</span></div>' +
          '<div class="usagebar"><i style="width:' + pct + '%"></i></div>' +
          '<div class="usagepct">' + pct + '% of total</div></div>';
      });
      body += '</div>';
    }
    var curBudget = cur ? budgetFor(cur.id) : 0;
    var budgetUI = cur ? '<div class="budgetset"><label for="budgetinp">Budget for ' + esc(cur.name || cur.id) + '</label>' +
      '<div class="budgetrow"><span class="bpfx">$</span><input id="budgetinp" type="number" min="0" step="0.5" placeholder="none" value="' + (curBudget || "") + '">' +
      '<button class="btn sm" id="budgetsave">Save</button>' + (curBudget ? '<button class="btn ghost sm" id="budgetclear">Clear</button>' : "") + "</div>" +
      '<div class="phdim">Warns at 80% and 100% of budget. Stored in this browser.</div></div>' : "";
    var scrim = document.createElement("div"); scrim.className = "scrim";
    scrim.innerHTML = '<div class="modal usagemodal">' +
      '<div class="modalhead">Usage<button class="iconbtn" id="ux" aria-label="close">' + ICONS.x + '</button></div>' +
      '<div class="modalbody">' + budgetUI + body + '</div>' +
      '<div class="modalfoot"><span class="phdim">' + rows.length + ' project' + (rows.length===1?"":"s") + '</span><span class="spacer"></span><span class="sit">\u03a3 ' + money(total) + '</span></div>' +
    '</div>';
    document.body.appendChild(scrim);
    function close(){ scrim.remove(); document.removeEventListener("keydown", onKey); }
    function onKey(e){ if (e.key === "Escape"){ e.preventDefault(); close(); } }
    document.addEventListener("keydown", onKey);
    scrim.addEventListener("click", function(ev){ if (ev.target === scrim) close(); });
    document.getElementById("ux").onclick = close;
    // a project's row opens its full breakdown: Insights ▸ Spend & tokens
    Array.prototype.forEach.call(scrim.querySelectorAll("[data-usagepid]"), function(row){
      row.onclick = function(){
        var pid = row.getAttribute("data-usagepid");
        close();
        state.obView = "usage";
        var go = function(){ if (state.showTab) state.showTab("observatory"); };
        if (state.pid !== pid) { location.hash = "#p/" + pid; setTimeout(go, 400); } else go();
      };
    });
    var bsave = document.getElementById("budgetsave");
    if (bsave) bsave.onclick = function(){ var v = parseFloat((document.getElementById("budgetinp").value || "").trim());
      setBudgetFor(cur.id, isFinite(v) ? v : 0); _budgetWarned[cur.id] = 0; toast(isFinite(v) && v > 0 ? "budget set to $" + v.toFixed(2) : "budget cleared"); drawStatusbar(); close(); };
    var bclear = document.getElementById("budgetclear");
    if (bclear) bclear.onclick = function(){ setBudgetFor(cur.id, 0); _budgetWarned[cur.id] = 0; toast("budget cleared"); drawStatusbar(); close(); };
  }


  // Click the LoomPad pill: is the voice backend up, and how the physical pad
  // reaches it — on your Wi-Fi (LAN) or from anywhere (Tailscale Funnel).
  function openLoomPad(){
    if (document.querySelector(".scrim")) return;
    var scrim = document.createElement("div"); scrim.className = "scrim";
    scrim.innerHTML = '<div class="modal phonemodal lpmodal">' +
      '<div class="modalhead">LoomPad<button class="iconbtn" id="lpx" aria-label="close">' + ICONS.x + '</button></div>' +
      '<div class="modalbody">' +
        '<div class="lpstatus" id="lpstatus">' + LOADER + '</div>' +
        '<div class="phseg" id="lpseg" role="tablist" style="display:none">' +
          '<button class="pho on" data-net="local" role="tab">Local network</button>' +
          '<button class="pho" data-net="tailnet" role="tab">Tailnet</button>' +
        '</div>' +
        '<div class="phstage" id="lpstage"></div>' +
        '<div class="phlinkrow" id="lplinkrow" style="display:none">' +
          '<input id="lplink" readonly spellcheck="false" aria-label="backend URL">' +
          '<button class="btn ghost" id="lpcopy">Copy</button>' +
        '</div>' +
        '<div class="phhint" id="lphint"></div>' +
      '</div>' +
      '<div class="modalfoot"><span class="phdim" id="lpfoot"></span><span class="spacer"></span><button class="btn ghost" id="lprecheck">Re-check</button></div>' +
    '</div>';
    document.body.appendChild(scrim);
    function close(){ scrim.remove(); document.removeEventListener("keydown", onKey); }
    function onKey(e){ if (e.key === "Escape"){ e.preventDefault(); close(); } }
    document.addEventListener("keydown", onKey);
    scrim.addEventListener("click", function(ev){ if (ev.target === scrim) close(); });
    document.getElementById("lpx").onclick = close;
    function q(id){ return document.getElementById(id); }
    var data = null, current = "local";
    function setSeg(){ Array.prototype.forEach.call(scrim.querySelectorAll("#lpseg .pho"), function(b){ b.classList.toggle("on", b.getAttribute("data-net") === current); }); }
    function showLink(url){ q("lplinkrow").style.display = ""; q("lplink").value = url; }
    function render(){
      setSeg(); q("lplinkrow").style.display = "none"; q("lphint").innerHTML = "";
      if (current === "local"){
        if (data.local && data.local.url){
          q("lpstage").innerHTML = '<div class="phmsg">Point the pad here on your Wi-Fi.<div class="phdim">Enter this as the backend URL in the pad\u2019s setup portal. A blank token is fine on your own network.</div></div>';
          showLink(data.local.url);
          q("lphint").innerHTML = "The pad and this Mac must share the same Wi-Fi.";
        } else { q("lpstage").innerHTML = '<div class="phmsg">No local network address right now.</div>'; }
        return;
      }
      if (!data.tailnet.installed){
        q("lpstage").innerHTML = '<div class="phmsg">Tailscale isn\u2019t installed.<div class="phdim">Install it to reach the pad from anywhere.</div></div>';
      } else if (!data.tailnet.loggedIn){
        q("lpstage").innerHTML = '<div class="phmsg">Sign in to Tailscale to reach the pad from anywhere.<div class="phdim">Opens the same Start Tailscale flow as Connect a phone.</div><button class="btn primary" id="lptsstart">Start Tailscale</button></div>';
        q("lptsstart").onclick = function(){ close(); openConnectPhone(); };
      } else {
        q("lpstage").innerHTML = '<div class="phmsg">Expose the backend to the internet for the pad.<div class="phdim">Tailscale Funnel serves it over HTTPS at the address below. Set the same <code>PAD_TOKEN</code> on the pad and the backend.</div><button class="btn primary" id="lpfunnel">Enable tailnet access</button></div>';
        if (data.tailnet.url) showLink(data.tailnet.url);
        q("lpfunnel").onclick = function(){
          var b = this; b.disabled = true; b.textContent = "Enabling\u2026";
          api("/api/loompad/funnel", { method: "POST", body: "{}" }).then(function(r){
            q("lpstage").innerHTML = '<div class="phmsg">Live on the internet \u2014 enter this in the pad.</div>';
            showLink((r && r.url) || data.tailnet.url || "");
            q("lphint").innerHTML = "Public HTTPS via Funnel. The pad needs your PAD_TOKEN.";
          }).catch(function(e){
            b.disabled = false; b.textContent = "Enable tailnet access";
            clog("error", "loompad", "funnel failed: " + (e && e.message), e && e.stack); toast((e && e.message) || "could not enable Funnel");
          });
        };
      }
    }
    function load(){
      q("lpstatus").innerHTML = LOADER; q("lpseg").style.display = "none"; q("lpstage").innerHTML = ""; q("lplinkrow").style.display = "none"; q("lphint").textContent = ""; q("lpfoot").textContent = "";
      api("/api/loompad/connect").then(function(r){
        data = r;
        var dot = '<span class="sdot' + (r.up ? "" : " off") + '"></span>';
        q("lpstatus").innerHTML = '<div class="lpstat">' + dot + '<b>' + (r.up ? "Backend running" : "Backend offline") + '</b>' + (r.up && r.brain ? ' <span class="phdim">brain ' + esc(String(r.brain)) + '</span>' : "") + ' <span class="phdim">:' + (r.port||8080) + '</span></div>' + (r.up ? "" : '<div class="phdim" style="margin-top:6px">Start it: <code>cd orchestrator-pad/backend &amp;&amp; npm start</code></div>');
        q("lpseg").style.display = "";
        q("lpfoot").textContent = r.backend || "";
        render();
      }).catch(function(e){
        q("lpstatus").innerHTML = '<div class="phmsg">Could not read LoomPad status.</div>';
        clog("error", "loompad", "connect failed: " + (e && e.message), e && e.stack);
      });
    }
    Array.prototype.forEach.call(scrim.querySelectorAll("#lpseg .pho"), function(b){ b.onclick = function(){ current = b.getAttribute("data-net"); render(); }; });
    q("lpcopy").onclick = function(){ var v = q("lplink").value; if (!v) return; if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(v).then(function(){ toast("copied"); }).catch(function(){ toast("copy failed"); }); else toast("copy not available"); };
    q("lprecheck").onclick = load;
    load();
  }

  /**
   * Sign in to GitHub. gh's login is an interactive device flow, so the honest
   * place to run it is the real terminal you already have — Loom never touches
   * the token; gh stores it. We run it there, then poll until gh reports in and
   * light the board up.
   */
  function connectGithub(){
    if (!state.termRun) { toast("open a project first \u2014 sign-in runs in its terminal"); return; }
    toast("opening a terminal to sign in to GitHub\u2026");
    state.termRun("gh auth login --web --git-protocol https");
    var tries = 0;
    var poll = setInterval(function(){
      tries++;
      api("/api/github/status").then(function(s){
        state.github = s; drawStatusbar();
        if (s.connected) {
          clearInterval(poll);
          toast("GitHub connected \u00b7 " + (s.user || ""));
          if (state.reloadBoard) try { state.reloadBoard(); } catch (e) {}
        }
      }).catch(function(){});
      if (tries > 80) clearInterval(poll); // ~4 min ceiling; then stop polling
    }, 3000);
  }
export { _budgetWarned,budgetFor,checkBudget,closeGitDeliveryMenu,connectGithub,drawStatusbar,gdAway,gdKey,GIT_DELIVERY,gitDeliveryInfo,loadGitDelivery,loadGithub,loadLoomPad,loadUpdate,openGitDeliveryMenu,openLoomPad,openUsage,setBudgetFor,setGitDelivery };
