/** Browser palette module. See README.md for ownership and startup. */
import { agentLabel,brandMark } from './agents.js';
import { COMMANDS,runCommand } from './commands.js';
import { api } from './connection.js';
import { esc } from './format.js';
import { ICONS } from './icons.js';
import { toast } from './notifications.js';
import { openSettingsModal } from './settings.js';
import { state } from './state.js';


  /**
   * The command palette — one search across the whole workspace, opened with
   * \u2318K / Ctrl+K. Commands, agents and worktrees filter instantly; files,
   * code and conversations are asked of the daemon as you type. \u2191\u2193
   * move, \u21b5 acts, esc closes. A flat item list drives the keyboard, so a
   * command and a code hit navigate the same way.
   */
  function openPalette(){
    if (document.querySelector(".scrim")) return; // one overlay at a time
    var pid = state.pid;
    var scrim = document.createElement("div");
    scrim.className = "scrim pscrim";
    scrim.innerHTML = '<div class="palette" role="dialog" aria-label="Search everything">' +
      '<div class="phead">' + ICONS.search +
        '<input id="pq" placeholder="Search files, code, agents, worktrees, commands\u2026" autocomplete="off" spellcheck="false" aria-label="search everything">' +
        '<span class="pkbd">esc</span></div>' +
      '<div class="pbody" id="pbody"></div>' +
      '<div class="pfoot"><span><b>\u2191\u2193</b> navigate</span><span><b>\u21b5</b> open</span><span><b>esc</b> close</span></div>' +
    "</div>";
    document.body.appendChild(scrim);
    var inp = document.getElementById("pq");
    var body = document.getElementById("pbody");
    var items = [], sel = 0, reqId = 0, curQ = "", acc = {}, wt = null, to = null;

    function close(){ scrim.remove(); document.removeEventListener("keydown", onKey, true); }
    function onKey(e){
      if (e.key === "Escape") { e.preventDefault(); close(); return; }
      if (e.key === "ArrowDown") { e.preventDefault(); move(1); return; }
      if (e.key === "ArrowUp") { e.preventDefault(); move(-1); return; }
      if (e.key === "Enter") { e.preventDefault(); activate(sel); return; }
    }
    document.addEventListener("keydown", onKey, true);
    scrim.addEventListener("mousedown", function(ev){ if (ev.target === scrim) close(); });

    function move(d){ if (!items.length) return; sel = (sel + d + items.length) % items.length; paint(); }
    function activate(i){ var it = items[i]; if (!it || !it.run) return; close(); try { it.run(); } catch (e) { toast(String((e && e.message) || e)); } }

    // subsequence match, so "brd" finds "Board" and "apst" finds "app-page.ts"
    function fuzzy(hay, q){
      hay = String(hay).toLowerCase(); q = q.toLowerCase();
      if (!q) return true;
      var i = 0;
      for (var c = 0; c < q.length; c++){ i = hay.indexOf(q.charAt(c), i); if (i < 0) return false; i++; }
      return true;
    }
    function shq(s){ return "'" + String(s).replace(/'/g, "'\\''") + "'"; } // POSIX single-quote

    var CMDS = buildCommands();
    /**
     * Every command the menu bar has, by the same names (commands.js), with
     * its shortcut — plus the project-scoped panels and a jump to any project.
     */
    function buildCommands(){
      var C = COMMANDS.filter(function(c){ return !c.needsProject || pid; }).map(function(c){
        return { icon: c.icon, label: c.label, sub: c.keys || "", run: function(){ runCommand(c.id); } };
      });
      if (pid && state.showRail) {
        C.push({ icon: ICONS.files, label: "Explorer", sub: "panel", run: function(){ state.showRail("explorer"); } });
        C.push({ icon: ICONS.search, label: "Search in files", sub: "panel", run: function(){ state.showRail("search"); } });
        C.push({ icon: ICONS.branch, label: "Source Control", sub: "panel", run: function(){ state.showRail("scm"); } });
      }
      C.push({ icon: ICONS.console, label: "Diagnostics", sub: "loom doctor", run: function(){ openSettingsModal("diagnostics"); } });
      (state.projects || []).forEach(function(p){
        if (p.id === pid || !state.selectProject) return;
        C.push({ icon: ICONS.folder, label: "Open project " + p.name, sub: "project", run: function(){ state.selectProject(p.id); } });
      });
      return C;
    }

    function section(title, rows){
      if (!rows.length) return "";
      var h = '<div class="psec">' + esc(title) + "</div>";
      rows.forEach(function(r){
        r._i = items.length; items.push(r);
        h += '<div class="prow" data-i="' + r._i + '"><span class="pic">' +
          (r.markKind ? brandMark(r.markKind) : (r.icon || ICONS.file)) + "</span>" +
          '<span class="plabel">' + (r.html || esc(r.label)) + "</span>" +
          (r.sub ? '<span class="psub">' + esc(r.sub) + "</span>" : "") + "</div>";
      });
      return h;
    }

    function draw(){
      var q = curQ;
      items = [];
      var h = "";
      h += section("Commands", CMDS.filter(function(c){ return fuzzy(c.label + " " + (c.sub || ""), q); }).slice(0, q ? 8 : 24));
      var ags = (state.project && state.project.agents) || [];
      if (state.selectAgent) h += section("Agents", ags.filter(function(a){ return fuzzy(a.id + " " + (a.role || ""), q); }).map(function(a){
        return { markKind: a.kind, label: agentLabel(a.kind, a.id), sub: (a.id !== agentLabel(a.kind, a.id) ? a.id + " \u00b7 " : "") + (a.tier === "bridge" ? "bridge" : (a.role || "agent")) + " \u00b7 talk to", run: function(){ state.selectAgent(a.id); } };
      }));
      if (state.termRun && wt) {
        var wts = wt.filter(function(w){ return !w.main && fuzzy((w.branch || "") + " " + w.path, q); });
        h += section("Worktrees", wts.map(function(w){
          return { icon: ICONS.branch, label: w.branch || "(detached)", sub: w.path,
                   run: function(){ state.termRun("cd " + shq(w.path)); toast("cd \u2192 " + (w.branch || w.path)); } };
        }));
      }
      if (q && pid) {
        if (state.openFile && acc.files && acc.files.length) h += section("Files", acc.files.map(function(f){
          return { icon: ICONS.file, label: f, run: function(){ state.openFile(f); } };
        }));
        if (state.openFile && acc.code && acc.code.length) h += section("Code", acc.code.map(function(hit){
          return { icon: ICONS.search, label: hit.path,
                   html: '<span class="ppath">' + esc(hit.path) + ":" + hit.line + "</span> " + esc((hit.text || "").trim().slice(0, 90)),
                   run: function(){ state.openFile(hit.path); } };
        }));
        if (state.setChat && acc.chats && acc.chats.length) h += section("Conversations", acc.chats.map(function(c){
          var chatName = ((state.project && state.project.chats) || []).filter(function(x){ return x.id === c.chat; }).map(function(x){ return x.title; })[0] || (c.chat === "main" ? "Main" : "a chat");
          var eid = c.eventId || c.id;
          return { icon: ICONS.chat, label: (c.snippet || "").trim().slice(0, 72) || chatName, sub: chatName,
                   run: function(){
                     // a permalink lands on the message itself, not just the chat
                     if (eid) location.hash = "#p/" + encodeURIComponent(pid) + "/c/" + encodeURIComponent(c.chat) + "/m/" + eid;
                     else state.setChat(pid, c.chat);
                   } };
        }));
        var pending = acc.files === undefined || acc.code === undefined || acc.chats === undefined;
        if (pending) h += '<div class="pmore">searching the project\u2026</div>';
      }
      if (!items.length && !q) h += '<div class="pmore">type to search \u2014 files, code, agents, worktrees, commands</div>';
      var still = q && pid && (acc.files === undefined || acc.code === undefined || acc.chats === undefined);
      if (!items.length && q && !still) h += '<div class="pmore">Nothing matches \u201c' + esc(q) + '\u201d.</div>';
      body.innerHTML = h;
      if (sel >= items.length) sel = items.length ? items.length - 1 : 0;
      paint(); wireRows();
    }

    function paint(){
      Array.prototype.forEach.call(body.querySelectorAll(".prow"), function(el){
        el.classList.toggle("on", Number(el.getAttribute("data-i")) === sel);
      });
      var on = body.querySelector(".prow.on"); if (on && on.scrollIntoView) on.scrollIntoView({ block: "nearest" });
    }
    function wireRows(){
      Array.prototype.forEach.call(body.querySelectorAll(".prow"), function(el){
        var i = Number(el.getAttribute("data-i"));
        el.onmousemove = function(){ if (sel !== i) { sel = i; paint(); } };
        el.onclick = function(){ activate(i); };
      });
    }
    function runAsync(){
      var my = reqId, q = curQ;
      var land = function(key, val){ if (my === reqId) { acc[key] = val; draw(); } };
      api("/api/projects/" + pid + "/find?q=" + encodeURIComponent(q))
        .then(function(j){ land("files", (j.matches || []).slice(0, 6)); }).catch(function(){ land("files", []); });
      api("/api/projects/" + pid + "/grep?q=" + encodeURIComponent(q))
        .then(function(j){ land("code", (j.hits || []).slice(0, 6)); }).catch(function(){ land("code", []); });
      api("/api/projects/" + pid + "/chats/search?q=" + encodeURIComponent(q))
        .then(function(j){ land("chats", (j.hits || []).slice(0, 5)); }).catch(function(){ land("chats", []); });
    }

    inp.oninput = function(){
      curQ = this.value.trim();
      acc = {}; reqId++;            // invalidate any in-flight async for the old query
      clearTimeout(to);
      draw();                       // instant: commands + agents + worktrees, filtered
      if (curQ && pid) to = setTimeout(runAsync, 170);
    };
    // worktrees once, up front — few, and useful in the default (empty) menu
    if (pid) api("/api/projects/" + pid + "/worktrees").then(function(j){ wt = j.worktrees || []; draw(); }).catch(function(){});
    draw();
    setTimeout(function(){ inp.focus(); }, 20);
  }
export { openPalette };
