/** Browser palette module. See README.md for ownership and startup. */
import { shortcutLabel } from './shortcuts.js';
import { agentLabel,brandMark } from './agents.js';
import { COMMANDS,devOnly,runCommand,recentCommands } from './commands.js';
import { devMode } from './mode.js';
import { api } from './connection.js';
import { esc } from './format.js';
import { ICONS } from './icons.js';
import { toast } from './notifications.js';
import { openSettingsModal } from './settings.js';
import { state } from './state.js';
import { editorItems } from './editors.js';
import { openScoreboard } from './project/scoreboard.js';


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
        '<input id="pq" placeholder="Search all chats, files, code, commands\u2026" autocomplete="off" spellcheck="false" aria-label="search everything">' +
        '<span class="pkbd">esc</span></div>' +
      '<div class="pbody" id="pbody"></div>' +
      '<div class="pfoot"><span><b>\u2191\u2193</b> navigate</span><span><b>\u21b5</b> open</span><span><b>esc</b> close</span></div>' +
    "</div>";
    document.body.appendChild(scrim);
    var inp = document.getElementById("pq");
    var body = document.getElementById("pbody");
    var items = [], sel = 0, reqId = 0, curQ = "", acc = {}, wt = null, to = null;

    function close(){ clearTimeout(to); reqId++; scrim.remove(); document.removeEventListener("keydown", onKey, true); }
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
      var dev = devMode();
      var C = COMMANDS.filter(function(c){ return (!c.needsProject || pid) && (dev || !devOnly(c.id)); }).map(function(c){
        return { commandId: c.id, icon: c.icon, label: c.label, sub: shortcutLabel(c), run: function(){ runCommand(c.id); } };
      });
      if (pid && state.showRail && dev) {
        C.push({ icon: ICONS.files, label: "Explorer", sub: "panel", run: function(){ state.showRail("explorer"); } });
        C.push({ icon: ICONS.search, label: "Search in files", sub: "panel", run: function(){ state.showRail("search"); } });
        C.push({ icon: ICONS.branch, label: "Source Control", sub: "panel", run: function(){ state.showRail("scm"); } });
        if (state.openSubagents) C.push({ icon: ICONS.agents, label: "Subagents", sub: "dock", run: function(){ state.openSubagents(); } });
      }
      if (pid) editorItems(pid, null, ICONS.code, 4).forEach(function(it){ C.push({ icon: it.icon, label: it.label, sub: "this project", run: it.run }); });
      C.push({ icon: ICONS.star, label: "Model scoreboard", sub: "which model wins, at what cost", run: function(){ openScoreboard(pid || null); } });
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
      var recent = recentCommands().map(function(id){ return CMDS.find(function(c){ return c.commandId === id; }); }).filter(Boolean);
      if (!q) h += section("Recent commands", recent);
      h += section("Commands", CMDS.filter(function(c){ return q || recent.indexOf(c) < 0; }).filter(function(c){ return fuzzy(c.label + " " + (c.sub || ""), q); }).slice(0, q ? 8 : 24));
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
        var pending = acc.files === undefined || acc.code === undefined;
        if (pending) h += '<div class="pmore">searching the project\u2026</div>';
      }
      if (q) {
        if (acc.chats) h += section("Chats across projects", acc.chats.map(function(c){
          return { icon: ICONS.chat, label: c.snippet || c.chatTitle, sub: c.projectName + " · " + c.chatTitle, run: function(){
            location.hash = '#p/' + encodeURIComponent(c.project) + '/c/' + encodeURIComponent(c.chat) + '/m/' + c.eventId;
          } };
        }));
        if (acc.searchError) h += '<div class="pmore" role="status">' + esc(acc.searchError) + '</div>';
        else if (acc.chats === undefined) h += '<div class="pmore">Searching all chats…</div>';
        if (acc.truncated) h += '<div class="pmore">More matches available — narrow your search.</div>';
      }
      if (!items.length && !q) h += '<div class="pmore">type to search \u2014 files, code, agents, worktrees, commands</div>';
      var still = q && (acc.chats === undefined || (pid && (acc.files === undefined || acc.code === undefined)));
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
      if (pid) api("/api/projects/" + pid + "/find?q=" + encodeURIComponent(q))
        .then(function(j){ land("files", (j.matches || []).slice(0, 6)); }).catch(function(){ land("files", []); });
      if (pid) api("/api/projects/" + pid + "/grep?q=" + encodeURIComponent(q))
        .then(function(j){ land("code", (j.hits || []).slice(0, 6)); }).catch(function(){ land("code", []); });
      api("/api/search?q=" + encodeURIComponent(q))
        .then(function(j){ land("truncated", j.truncated); land("chats", j.hits || []); }).catch(function(e){ land("searchError", e.message); land("chats", []); });
    }

    inp.oninput = function(){
      curQ = this.value.trim();
      acc = {}; reqId++;            // invalidate any in-flight async for the old query
      clearTimeout(to);
      draw();                       // instant: commands + agents + worktrees, filtered
      if (curQ) to = setTimeout(runAsync, 170);
    };
    // worktrees once, up front — few, and useful in the default (empty) menu
    if (pid) api("/api/projects/" + pid + "/worktrees").then(function(j){ wt = j.worktrees || []; draw(); }).catch(function(){});
    draw();
    setTimeout(function(){ inp.focus(); }, 20);
  }
export { openPalette };
