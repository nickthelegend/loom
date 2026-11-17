/**
 * The model scoreboard (#406): which agent@model wins your races and comparisons, how often its
 * turns finish, how long they take and what they cost — this project or all of them, over 7 days,
 * 30 days or everything. GET /api/scoreboard; every number is from recorded turns and kept picks,
 * and "—" means no observations, never zero.
 */
import { agentGlyph } from '../agents.js';
import { api } from '../connection.js';
import { esc, money } from '../format.js';
import { ICONS, LOADER } from '../icons.js';

function pct(x){ return x == null ? "—" : Math.round(x * 100) + "%"; }
function dur(ms){
  if (ms == null) return "—";
  var s = Math.round(ms / 1000);
  return s < 60 ? s + "s" : Math.floor(s / 60) + "m " + (s % 60) + "s";
}

export function openScoreboard(pid){
  if (document.querySelector(".scrim")) return;
  var scope = pid || "all", win = "30d", by = "byKindModel", closed = false;
  var scrim = document.createElement("div");
  scrim.className = "scrim";
  scrim.innerHTML = '<div class="modal scoremodal" role="dialog" aria-label="Model scoreboard">' +
    '<div class="modalhead">Model scoreboard<button class="iconbtn" id="sbx" aria-label="close">' + ICONS.x + "</button></div>" +
    '<div class="modalbody">' +
      '<div class="sbbar">' +
        (pid ? '<div class="seg" id="sbscope"><button data-v="' + esc(pid) + '" class="on">This project</button><button data-v="all">All projects</button></div>' : "") +
        '<div class="seg" id="sbwin"><button data-v="7d">7 days</button><button data-v="30d" class="on">30 days</button><button data-v="all">All time</button></div>' +
        '<div class="seg" id="sbby"><button data-v="byKindModel" class="on">Agent + model</button><button data-v="byModel">Model</button></div>' +
      "</div>" +
      '<div class="sbtable" id="sbtable">' + LOADER + "</div>" +
    "</div>" +
    '<div class="modalfoot"><span class="hintx">Wins are the picks you kept in races and Ask several. Ranked by win rate, then cost per turn. <code>loom scoreboard</code> in a terminal.</span></div>' +
  "</div>";
  document.body.appendChild(scrim);
  function close(){ closed = true; scrim.remove(); document.removeEventListener("keydown", onKey); }
  function onKey(e){ if (e.key === "Escape") { e.preventDefault(); close(); } }
  document.addEventListener("keydown", onKey);
  scrim.addEventListener("click", function(ev){ if (ev.target === scrim) close(); });
  scrim.querySelector("#sbx").onclick = close;
  function seg(id, set){
    var box = scrim.querySelector(id); if (!box) return;
    Array.prototype.forEach.call(box.querySelectorAll("button"), function(b){
      b.onclick = function(){
        Array.prototype.forEach.call(box.querySelectorAll("button"), function(x){ x.classList.toggle("on", x === b); });
        set(b.getAttribute("data-v")); load();
      };
    });
  }
  seg("#sbscope", function(v){ scope = v; });
  seg("#sbwin", function(v){ win = v; });
  seg("#sbby", function(v){ by = v; });
  var last = null, gen = 0;
  function draw(){
    var el = scrim.querySelector("#sbtable");
    var rows = (last && last[by]) || [];
    if (!rows.length) { el.innerHTML = '<div class="snote">Nothing recorded in this window yet. Run a race or Ask several, and the kept picks show up here.</div>'; return; }
    var top = rows[0];
    el.innerHTML = '<table class="sbt"><thead><tr><th></th><th>' + (by === "byModel" ? "Model" : "Agent · model") + '</th><th title="kept picks / entries">Wins</th><th title="turns that finished">Finishes</th><th>Turns</th><th title="median turn time">Median</th><th>Per turn</th><th>Total</th></tr></thead><tbody>' +
      rows.map(function(r, i){
        var name = by === "byModel" ? esc(r.model) : (r.kind ? agentGlyph(r.kind, r.kind) + " " : "") + esc(r.kind ? r.kind + " · " + r.model : r.key);
        return '<tr' + (i === 0 && r === top && r.wins > 0 ? ' class="lead"' : "") + '>' +
          '<td class="rk">' + (i + 1) + "</td><td class=\"nm\">" + name + "</td>" +
          "<td>" + (r.entries ? "<b>" + pct(r.winRate) + "</b> <span class=\"dim\">" + r.wins + "/" + r.entries + "</span>" : "—") + "</td>" +
          "<td>" + pct(r.finishedRate) + "</td><td>" + r.turns + "</td><td>" + dur(r.medianMs) + "</td>" +
          "<td>" + (r.avgCostUsd == null ? "—" : money(r.avgCostUsd)) + "</td><td>" + money(r.totalCostUsd || 0) + "</td></tr>";
      }).join("") + "</tbody></table>";
  }
  function load(){
    var mine = ++gen;
    scrim.querySelector("#sbtable").innerHTML = LOADER;
    api("/api/scoreboard?project=" + encodeURIComponent(scope) + "&window=" + encodeURIComponent(win)).then(function(r){
      if (closed || mine !== gen) return;
      last = r; draw();
    }).catch(function(e){
      if (closed || mine !== gen) return;
      scrim.querySelector("#sbtable").innerHTML = '<div class="snote">' + esc(e.message) + "</div>";
    });
  }
  load();
}
