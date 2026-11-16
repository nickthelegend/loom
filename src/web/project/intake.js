/**
 * My issues (#382): what's assigned to you on GitHub or Linear, and Start — a chat per issue with
 * the issue as its task (or an Orchestra goal), linked back to the issue when its PR opens. An
 * issue already started says where it went instead of starting twice.
 *
 * Approach after Agent Orchestrator's issue intake (Apache-2.0).
 */
import { agentLabel } from '../agents.js';
import { api } from '../connection.js';
import { esc } from '../format.js';
import { ICONS, LOADER } from '../icons.js';
import { toast } from '../notifications.js';
import { state } from '../state.js';

export function openIntake(pid){
  if (document.querySelector(".scrim")) return;
  var source = "github", label = "", issues = null, err = "", picked = {};
  var scrim = document.createElement("div");
  scrim.className = "scrim";
  scrim.innerHTML = '<div class="modal intakemodal">' +
    '<div class="modalhead">My issues<button class="iconbtn" id="ikx" aria-label="close">' + ICONS.x + "</button></div>" +
    '<div class="modalbody">' +
      '<div class="ikbar"><div class="seg" id="iksrc"><button data-src="github" class="on">GitHub</button><button data-src="linear">Linear</button></div>' +
        '<input id="iklabel" placeholder="label (optional)" spellcheck="false" autocomplete="off"><button class="btn ghost sm" id="ikload">Refresh</button></div>' +
      '<div class="iklist" id="iklist">' + LOADER + "</div>" +
      '<div class="ikopts"><span>Start each as</span><div class="seg" id="ikmode"><button data-mode="chat" class="on">a chat</button><button data-mode="orchestra">an Orchestra goal</button></div>' +
        '<select id="ikagent" aria-label="who works on it"></select></div>' +
    "</div>" +
    '<div class="modalfoot"><span class="hintx" id="ikhint">Assigned to you, open. Each starts in its own chat; its PR links back to the issue.</span><span class="spacer"></span>' +
      '<button class="btn ghost" id="ikcancel">Close</button><button class="btn primary" id="ikstart" disabled>Start</button></div>' +
  "</div>";
  document.body.appendChild(scrim);
  var closed = false;
  function close(){ closed = true; scrim.remove(); document.removeEventListener("keydown", onKey); }
  function onKey(e){ if (e.key === "Escape") { e.preventDefault(); close(); } }
  document.addEventListener("keydown", onKey);
  scrim.addEventListener("click", function(ev){ if (ev.target === scrim) close(); });
  scrim.querySelector("#ikx").onclick = close;
  scrim.querySelector("#ikcancel").onclick = close;
  var mode = "chat";

  // who works on it: the project's agents that take turns, or the router's choice
  var agents = (((state.project || {}).agents) || []).filter(function(a){ return a.tier !== "bridge" && a.enabled !== false; });
  scrim.querySelector("#ikagent").innerHTML = '<option value="">whoever the project routes to</option>' +
    agents.map(function(a){ return '<option value="' + esc(a.id) + '">' + esc(agentLabel(a.kind, a.id)) + (a.id !== a.kind ? " · " + esc(a.id) : "") + "</option>"; }).join("");

  function count(){ return Object.keys(picked).filter(function(k){ return picked[k]; }).length; }
  function drawFoot(){
    var n = count(), b = scrim.querySelector("#ikstart");
    b.disabled = !n;
    b.textContent = n ? "Start " + n : "Start";
  }
  function draw(){
    if (closed) return;
    var list = scrim.querySelector("#iklist");
    if (err) { list.innerHTML = '<div class="snote">' + esc(err) + "</div>"; return; }
    if (!issues) { list.innerHTML = LOADER; return; }
    if (!issues.length) { list.innerHTML = '<div class="snote">Nothing open is assigned to you' + (label ? " with “" + esc(label) + "”" : "") + ".</div>"; return; }
    list.innerHTML = issues.map(function(it){
      var started = it.started && it.started.chat;
      var ref = it.identifier || (it.number ? "#" + it.number : "");
      return '<label class="ikrow' + (started ? " done" : "") + '">' +
        (started ? '<span class="ikdone" title="already started">' + ICONS.check + "</span>"
          : '<input type="checkbox" data-ik="' + esc(it.id) + '"' + (picked[it.id] ? " checked" : "") + ">") +
        '<span class="ikref">' + esc(ref) + "</span>" +
        '<span class="iktitle">' + esc(it.title) + "</span>" +
        (it.labels || []).slice(0, 3).map(function(l){ return '<span class="iklab">' + esc(l) + "</span>"; }).join("") +
        (started ? '<button type="button" class="btn ghost xs" data-ikopen="' + esc(it.started.chat) + '">Open chat</button>' : "") +
        "</label>";
    }).join("");
    Array.prototype.forEach.call(list.querySelectorAll("[data-ik]"), function(cb){
      cb.onchange = function(){ picked[cb.getAttribute("data-ik")] = cb.checked; drawFoot(); };
    });
    Array.prototype.forEach.call(list.querySelectorAll("[data-ikopen]"), function(b){
      b.onclick = function(ev){ ev.preventDefault(); var chat = b.getAttribute("data-ikopen"); close(); if (state.setChat) state.setChat(pid, chat); };
    });
    drawFoot();
  }
  function load(){
    issues = null; err = ""; picked = {}; draw(); drawFoot();
    label = scrim.querySelector("#iklabel").value.trim();
    api("/api/projects/" + pid + "/intake?source=" + source + (label ? "&label=" + encodeURIComponent(label) : ""))
      .then(function(j){ issues = (j && j.issues) || []; draw(); })
      .catch(function(e){ err = e.message; draw(); });
  }
  Array.prototype.forEach.call(scrim.querySelectorAll("#iksrc [data-src]"), function(b){
    b.onclick = function(){
      source = b.getAttribute("data-src");
      Array.prototype.forEach.call(scrim.querySelectorAll("#iksrc [data-src]"), function(x){ x.classList.toggle("on", x === b); });
      load();
    };
  });
  Array.prototype.forEach.call(scrim.querySelectorAll("#ikmode [data-mode]"), function(b){
    b.onclick = function(){
      mode = b.getAttribute("data-mode");
      Array.prototype.forEach.call(scrim.querySelectorAll("#ikmode [data-mode]"), function(x){ x.classList.toggle("on", x === b); });
    };
  });
  scrim.querySelector("#ikload").onclick = load;
  scrim.querySelector("#iklabel").onkeydown = function(e){ if (e.key === "Enter") { e.preventDefault(); load(); } };
  scrim.querySelector("#ikstart").onclick = function(){
    var ids = Object.keys(picked).filter(function(k){ return picked[k]; });
    if (!ids.length) return;
    var btn = this, agent = scrim.querySelector("#ikagent").value;
    btn.disabled = true; btn.textContent = "Starting…";
    api("/api/projects/" + pid + "/intake/start", { method: "POST", body: JSON.stringify({ source: source, ids: ids, mode: mode, ...(agent ? { agent: agent } : {}) }) })
      .then(function(j){
        var n = ((j && j.issues) || []).length;
        toast("started " + n + " issue" + (n === 1 ? "" : "s") + (mode === "orchestra" ? " as Orchestra goals" : " — a chat each"));
        if (state.refreshProjects) state.refreshProjects();
        load();
      })
      .catch(function(e){ toast(e.message); drawFoot(); });
  };
  load();
}
