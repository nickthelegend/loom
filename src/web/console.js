/** Browser console module. See README.md for ownership and startup. */
import { api } from './connection.js';
import { esc } from './format.js';
import { ICONS } from './icons.js';
import { toast } from './notifications.js';
import { state } from './state.js';


  // ---- right rail toggle — open by default (shows the file tree) -----------
  // ---- Console ------------------------------------------------------------
  // Everything that went wrong, in the drawer with the terminals.
  //
  // Errors used to have two fates: ~/.loom/daemon.log, which you have to know
  // exists and tail, or one of the many empty catch blocks, where they stopped
  // existing. Neither reaches the person looking at the window wondering why
  // nothing happened. Records arrive live over the same socket as events.
  var con = { logs: [], level: "all", open: false, present: false, seen: 0, expanded: {}, q: "", scope: "" };


  /**
   * Level, scope and text together. With a busy fleet "errors only" stopped
   * being enough — six agents and the api all log errors, and finding the one
   * from grok meant reading. The scope menu is built from the records
   * themselves, so it always offers exactly the scopes that have spoken.
   */
  function conLevelOk(r){
    if (con.level !== "all" && r.level !== con.level) return false;
    if (con.scope && r.scope !== con.scope) return false;
    if (con.q) {
      var hay = (r.scope + " " + r.message + " " + (r.detail || "")).toLowerCase();
      if (hay.indexOf(con.q.toLowerCase()) === -1) return false;
    }
    return true;
  }


  function drawConScopes(){
    var sel = document.getElementById("conscope"); if (!sel) return;
    var scopes = {};
    con.logs.forEach(function(r){ scopes[r.scope] = true; });
    var names = Object.keys(scopes).sort();
    var cur = con.scope;
    sel.innerHTML = '<option value="">all scopes</option>' + names.map(function(s){
      return '<option value="' + esc(s) + '"' + (s === cur ? " selected" : "") + ">" + esc(s) + "</option>";
    }).join("");
  }


  function drawConsole(){
    var list = document.getElementById("conlist"); if (!list) return;
    drawConScopes();
    var rows = con.logs.filter(conLevelOk);
    var cnt = document.getElementById("concount");
    if (cnt) {
      var errs = con.logs.filter(function(r){ return r.level === "error"; }).length;
      cnt.textContent = con.logs.length
        ? con.logs.length + " record" + (con.logs.length === 1 ? "" : "s") + (errs ? " \u00b7 " + errs + " error" + (errs === 1 ? "" : "s") : "")
        : "";
    }
    if (!rows.length) {
      list.innerHTML = '<div class="conempty">' + (con.logs.length ? ICONS.search : ICONS.check) +
        "<b>" + (con.logs.length ? (con.q || con.scope ? "Nothing matches this filter" : "Nothing at this level") : "All clear") + "</b>" +
        "<span>" + (con.logs.length ? "Clear the search or pick \u201call\u201d to see every record." : "Errors and warnings from the daemon, the API and your agents show up here.") + "</span></div>";
      return;
    }
    // Pinned to the bottom unless you've scrolled up to read something: yanking
    // the view away mid-read is how a log becomes unusable.
    var atBottom = list.scrollTop + list.clientHeight >= list.scrollHeight - 24;
    list.innerHTML = rows.map(function(r){
      var t = new Date(r.at);
      var hh = String(t.getHours()).padStart(2, "0") + ":" + String(t.getMinutes()).padStart(2, "0") + ":" + String(t.getSeconds()).padStart(2, "0");
      var open = !!con.expanded[r.id];
      return '<div class="conrow ' + esc(r.level) + '" data-id="' + r.id + '">' +
        '<span class="t">' + hh + "</span>" +
        '<span class="sc">' + esc(r.scope) + "</span>" +
        '<span class="ms">' + esc(r.message) + "</span>" +
        (r.detail ? '<span class="det" data-det="' + r.id + '">' + (open ? "\u2212" : "+") + "</span>" : "") +
        "</div>" +
        (open && r.detail ? '<div class="condetail">' + esc(r.detail) + "</div>" : "");
    }).join("");
    Array.prototype.forEach.call(list.querySelectorAll("[data-det]"), function(b){
      b.onclick = function(){
        var id = b.getAttribute("data-det");
        con.expanded[id] = !con.expanded[id];
        drawConsole();
      };
    });
    if (atBottom) list.scrollTop = list.scrollHeight;
  }


  /** The dot: something went wrong that you haven't looked at. */
  function drawErrDot(){
    var dot = document.getElementById("errdot"); if (!dot) return;
    var unseen = con.logs.filter(function(r){ return r.level === "error" && r.id > con.seen; }).length;
    dot.classList.toggle("on", unseen > 0 && !con.open);
  }


  function addLogRecord(r){
    con.logs.push(r);
    if (con.logs.length > 500) con.logs.splice(0, con.logs.length - 500);
    if (state.consoleActive && state.consoleActive()) { drawConsole(); con.seen = r.id; }
    if (con.present && state.redrawTermTabs) state.redrawTermTabs(); // refresh the tab's error dot
    drawErrDot();
  }


  /**
   * Reconcile with the daemon's logbook, then redraw.
   *
   * The live socket is the fast path, not the only one. There is a window
   * between the one-shot backfill at mount and the socket actually being open,
   * and anything logged inside it reached neither: the backfill had already run,
   * and there was no subscriber yet to stream it. Those records were lost from
   * the Console for the life of the window — and a dropped error is the one kind
   * you cannot afford to drop. Merging by id makes this safe to call any time.
   */
  function refreshConsole(done){
    api("/api/logs").then(function(j){
      var fresh = j.logs || [];
      var known = {};
      con.logs.forEach(function(r){ known[r.id] = true; });
      var added = 0;
      fresh.forEach(function(r){ if (!known[r.id]) { con.logs.push(r); added++; } });
      if (added) {
        con.logs.sort(function(a, b){ return a.id - b.id; });
        if (con.logs.length > 500) con.logs.splice(0, con.logs.length - 500);
      }
    }).catch(function(){ /* old daemon with no logs route — keep what we have */ })
      .then(function(){ if (done) done(); });
  }


  function openConsole(){
    // The console is a tab in the terminal dock now; renderProject owns the tab
    // machinery and publishes state.showConsole for exactly this cross-scope
    // call. (These functions live at module scope; terms/activeTerm/drawTermTabs
    // do not.)
    if (state.showConsole) state.showConsole();
    var settle = function(){
      // Mark what's on screen as seen — the dot is about news, not history.
      con.logs.forEach(function(r){ if (r.id > con.seen) con.seen = r.id; });
      drawConsole();
      drawErrDot();
    };
    settle();                    // paint what we already have, immediately
    refreshConsole(settle);      // then fill in anything the socket missed
  }


  function closeConsole(){
    if (state.hideConsole) state.hideConsole();
    else { con.open = false; con.present = false; }
    drawErrDot();
  }


  function bindConsole(){
    var btn = document.getElementById("consolebtn");
    // Toggle: if the console is the pane you're looking at, close it; else show it.
    if (btn) btn.onclick = function(){ (state.consoleActive && state.consoleActive()) ? closeConsole() : openConsole(); };
    var clear = document.getElementById("conclear");
    if (clear) clear.onclick = function(){
      api("/api/logs", { method: "DELETE" }).then(function(){
        con.logs = []; con.seen = 0; con.expanded = {};
        drawConsole(); drawErrDot();
      }).catch(function(e){ toast(e.message); });
    };
    Array.prototype.forEach.call(document.querySelectorAll(".conbar .lvl"), function(el){
      el.onclick = function(){
        con.level = el.getAttribute("data-lvl");
        Array.prototype.forEach.call(document.querySelectorAll(".conbar .lvl"), function(o){
          o.classList.toggle("on", o === el);
        });
        drawConsole();
      };
    });
    var scopeSel = document.getElementById("conscope");
    if (scopeSel) scopeSel.onchange = function(){ con.scope = scopeSel.value; drawConsole(); };
    var search = document.getElementById("consearch");
    if (search) search.oninput = function(){ con.q = search.value; drawConsole(); };
    // Backfill: the daemon has been running longer than this window has been
    // open, and its errors are exactly the ones you want on a fresh load.
    api("/api/logs").then(function(j){
      con.logs = j.logs || [];
      // Everything from before this window opened counts as already seen —
      // a dot for yesterday's error is noise, not news.
      con.logs.forEach(function(r){ if (r.id > con.seen) con.seen = r.id; });
      drawConsole();
      drawErrDot();
    }).catch(function(){ /* no logs endpoint on an old daemon — the tab just stays empty */ });
  }


  // ---- client-side logging: the window's own errors, in the Console ---------
  /**
   * Report a client-side problem into the same Console tab as the daemon's.
   * Raw fetch on purpose (not api()) so a stray error report can never trip the
   * 401 -> logout path. The daemon streams the record straight back, and that
   * is what puts it on screen; if the post cannot get out, show it locally so
   * it is never lost.
   */
  function clog(level, scope, message, detail){
    try {
      var p = { level: level, scope: scope || "app", message: String(message == null ? "" : message).slice(0, 500) };
      if (detail != null && String(detail)) p.detail = String(detail).slice(0, 4000);
      if (state && state.token) {
        fetch("/api/logs", { method: "POST", headers: { "Authorization": "Bearer " + state.token, "Content-Type": "application/json" }, body: JSON.stringify(p) })
          .catch(function(){ localLog(p); });
      } else {
        localLog(p);
      }
    } catch (_e) { /* logging must never throw */ }
  }

  function localLog(p){
    try { addLogRecord({ id: -Date.now(), at: Date.now(), level: p.level, scope: p.scope, message: p.message, detail: p.detail }); } catch (_e) {}
    try { (console[p.level] || console.log).call(console, "[" + p.scope + "] " + p.message, p.detail || ""); } catch (_e) {}
  }
export { addLogRecord,bindConsole,clog,closeConsole,con,conLevelOk,drawConScopes,drawConsole,drawErrDot,localLog,openConsole,refreshConsole };
