/** Browser home module. See README.md for ownership and startup. */
import { api,clearTimers,logout } from './connection.js';
import { esc,money } from './format.js';
import { ICONS,LOADER } from './icons.js';
import { toast } from './notifications.js';
import { clearShell } from './shell.js';
import { root,state } from './state.js';
import { THEME_BTN,bindTheme } from './theme.js';


  // ---- board (mobile) ------------------------------------------------------
  function renderBoard(){
    clearTimers();
    clearShell();
    root.innerHTML =
      '<header class="appbar"><span class="wordmark">lo<b>om</b></span><span class="sub">projects</span>' +
      '<span class="spacer"></span>' + THEME_BTN +
      '<button id="unpair" class="iconbtn" title="unpair this device">' + ICONS.unpair + "</button></header>" +
      '<main id="list">' + LOADER + "</main>";
    bindTheme();
    document.getElementById("unpair").onclick = logout;
    function refresh(){
      api("/api/projects").then(function(j){
        state.projects = j.projects || [];
        var el = document.getElementById("list");
        if (!el) return;
        if (!state.projects.length) { el.innerHTML = '<div class="sys" style="padding:40px 0;line-height:1.8">no projects woven yet<br><span style="opacity:.75">run <b class="mono" style="font-weight:500">loom init</b> in a repo on your computer</span></div>'; return; }
        el.innerHTML = state.projects.map(function(p){
          var r = p.route, act = r && (r.status === "running" || r.status === "waiting_human");
          // working: an agent mid-turn, or an orchestra / crew / council / shift / review in flight (#296)
          var working = (p.agents || []).filter(function(a){ return a.busy; }).map(function(a){ return a.id; }).concat(p.activity || []);
          return '<div class="card" data-id="' + esc(p.id) + '">' +
            '<div class="row1"><span class="dot' + (p.needsInput ? " hot" : working.length ? " work" : "") + '"' + (working.length ? ' title="working: ' + esc(working.join(", ")) + '"' : "") + '></span>' +
            '<span class="nm">' + esc(p.name) + "</span>" +
            (act ? '<span class="badge live">' + esc(r.name || "route") + " " + (r.current + 1) + "/" + r.steps.length + (r.status === "waiting_human" ? " \u00b7 paused" : "") + "</span>" : "") +
            '</div>' +
            '<div class="row2">baton: ' + esc(p.holder || "\u2014") +
            (p.costUsd > 0 ? " &middot; " + money(p.costUsd) : "") +
            (p.needsInput ? ' &middot; <span style="color:var(--warn)">needs input</span>' : working.length ? ' &middot; <span class="workingtxt">working: ' + esc(working.join(", ")) + "</span>" : "") + "</div></div>";
        }).join("");
        Array.prototype.forEach.call(el.querySelectorAll(".card"), function(card){
          card.onclick = function(){ location.hash = "#p/" + card.getAttribute("data-id"); };
        });
      }).catch(function(err){ toast(err.message); });
    }
    refresh();
    state.timers.push(setInterval(refresh, 5000));
  }
export { renderBoard };
