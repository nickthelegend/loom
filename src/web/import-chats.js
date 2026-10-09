/** Import chats you had with your agents outside Loom (GET/POST /imports, core/chat-import.ts). */
import { brandMark } from './agents.js';
import { api } from './connection.js';
import { esc } from './format.js';
import { ICONS,LOADER } from './icons.js';
import { toast } from './notifications.js';
import { state } from './state.js';

  function ago(ts){
    var s = Math.max(0, (Date.now() - ts) / 1000);
    if (s < 3600) return Math.max(1, Math.round(s / 60)) + "m ago";
    if (s < 86400) return Math.round(s / 3600) + "h ago";
    if (s < 86400 * 30) return Math.round(s / 86400) + "d ago";
    return new Date(ts).toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" });
  }
  function size(b){ return !b ? "" : b > 1048576 ? (b / 1048576).toFixed(1) + " MB" : Math.max(1, Math.round(b / 1024)) + " KB"; }

  /**
   * Every chat Claude Code, Codex and OpenCode kept for this project's folder,
   * newest first, each one a click from being a Loom chat. The ones Loom ran
   * itself are already in the thread, so they stay folded away.
   */
  function openImportChats(pid){
    if (document.querySelector(".scrim")) return;
    var proj = (state.projects || []).filter(function(p){ return p.id === pid; })[0] || {};
    var scrim = document.createElement("div"); scrim.className = "scrim";
    scrim.innerHTML = '<div class="modal impmodal" role="dialog" aria-label="Import chats"><div class="modalhead">Import chats · ' + esc(proj.name || "") +
      '<button class="iconbtn" id="impx" aria-label="close">' + ICONS.x + "</button></div>" +
      '<div class="impsub">Chats you had with your agents in this folder, read from their own history on this machine. Nothing leaves it, and their files aren’t changed.</div>' +
      '<div class="impbar"><div class="impseg" role="group" aria-label="agent">' +
        [["", "All"], ["claude-code", "Claude Code"], ["codex", "Codex"], ["opencode", "OpenCode"]].map(function(o, i){
          return '<button type="button" data-impsrc="' + o[0] + '" class="' + (i ? "" : "on") + '">' + esc(o[1]) + "</button>";
        }).join("") + '</div><input id="impq" type="search" placeholder="Filter…" autocomplete="off"></div>' +
      '<div class="modalbody" id="impbody">' + LOADER + "</div></div>";
    document.body.appendChild(scrim);
    function close(){ scrim.remove(); document.removeEventListener("keydown", onKey); }
    function onKey(e){ if (e.key === "Escape") close(); }
    document.addEventListener("keydown", onKey);
    scrim.addEventListener("click", function(ev){ if (ev.target === scrim) close(); });
    document.getElementById("impx").onclick = close;
    var body = document.getElementById("impbody");
    var chats = [], src = "", showLoom = false;
    function draw(){
      var q = (document.getElementById("impq").value || "").trim().toLowerCase();
      var mine = chats.filter(function(c){ return !c.fromLoom; }), loom = chats.length - mine.length;
      var list = (showLoom ? chats : mine).filter(function(c){ return (!src || c.source === src) && (!q || c.title.toLowerCase().indexOf(q) >= 0); });
      if (!chats.length) { body.innerHTML = '<div class="impempty">No chats from Claude Code, Codex or OpenCode ran in ' + esc(proj.dir || "this folder") + ".</div>"; return; }
      body.innerHTML = (list.length ? list.map(function(c){
        var key = c.source + ":" + c.id;
        return '<div class="improw">' + '<span class="impic">' + brandMark(c.source) + "</span>" +
          '<div class="imptxt"><div class="imptitle">' + esc(c.title) + "</div>" +
          '<div class="impmeta">' + esc(c.label) + " · " + esc(ago(c.updatedAt)) + (c.bytes ? " · " + esc(size(c.bytes)) : "") +
          (c.automated ? ' · <span title="started by a program, not typed in the agent’s own app">by a tool</span>' : "") +
          (c.fromLoom ? " · Loom ran this" : "") +
          (proj.dir && c.cwd !== proj.dir ? " · " + esc(c.cwd.slice((proj.dir || "").length + 1)) : "") + "</div></div>" +
          (c.chat
            ? '<button type="button" class="btn xs outline" data-impopen="' + esc(c.chat) + '">Open</button>'
            : '<button type="button" class="btn xs primary" data-impgo="' + esc(key) + '">Import</button>') + "</div>";
      }).join("") : '<div class="impempty">Nothing matches.</div>') +
        (loom ? '<button type="button" class="impmore" id="imploom">' + (showLoom ? "Hide" : "Show") + " the " + loom + " Loom ran itself</button>" : "");
      Array.prototype.forEach.call(body.querySelectorAll("[data-impgo]"), function(b){
        b.onclick = function(){
          var k = b.getAttribute("data-impgo"), i = k.indexOf(":");
          b.disabled = true; b.textContent = "Importing…";
          api("/api/projects/" + pid + "/imports", { method: "POST", body: JSON.stringify({ source: k.slice(0, i), id: k.slice(i + 1) }) })
            .then(function(r){
              chats.forEach(function(c){ if (c.source + ":" + c.id === k) c.chat = r.chat.id; });
              toast(r.already ? "already imported — opening it" : "imported " + r.items + " messages and tool calls" + (r.dropped ? " (the oldest " + r.dropped + " left out)" : ""));
              close(); openChat(r.chat.id);
            })
            .catch(function(e){ b.disabled = false; b.textContent = "Import"; toast(e.message); });
        };
      });
      Array.prototype.forEach.call(body.querySelectorAll("[data-impopen]"), function(b){
        b.onclick = function(){ close(); openChat(b.getAttribute("data-impopen")); };
      });
      var ml = document.getElementById("imploom"); if (ml) ml.onclick = function(){ showLoom = !showLoom; draw(); };
    }
    function openChat(chat){
      if (state.pid !== pid) location.hash = "#p/" + pid;
      setTimeout(function(){
        if (state.refreshProjects) state.refreshProjects();
        if (state.setChat) state.setChat(pid, chat);
        if (state.showTab) state.showTab("thread");
      }, state.pid !== pid ? 400 : 0);
    }
    Array.prototype.forEach.call(scrim.querySelectorAll("[data-impsrc]"), function(b){
      b.onclick = function(){
        src = b.getAttribute("data-impsrc");
        Array.prototype.forEach.call(scrim.querySelectorAll("[data-impsrc]"), function(x){ x.classList.toggle("on", x === b); });
        draw();
      };
    });
    document.getElementById("impq").oninput = draw;
    api("/api/projects/" + pid + "/imports").then(function(r){ chats = r.chats || []; draw(); })
      .catch(function(e){ body.innerHTML = '<div class="impempty">' + esc(e.message) + "</div>"; });
  }
export { openImportChats };
