/**
 * Triggers, in the app: schedules and webhooks that start an agent's turn on their own
 * (core/triggers.ts). Each one, when it runs next, how its last runs went, and Fire / Pause /
 * Remove; a form to add one. A webhook's secret is shown once, when it's made.
 * Approach credit: Nuphos (Apache-2.0, © Zeabur Inc.).
 */

import { api } from "./connection.js";
import { esc } from "./format.js";
import { ICONS, LOADER } from "./icons.js";
import { toast } from "./notifications.js";

export function openTriggers(pid, projectName) {
  if (!pid || document.querySelector(".scrim")) return;
  var scrim = document.createElement("div"); scrim.className = "scrim";
  scrim.innerHTML = '<div class="modal triggersmodal"><div class="modalhead">Triggers' + (projectName ? " · " + esc(projectName) : "") +
    '<button class="iconbtn" id="trx" aria-label="close">' + ICONS.x + '</button></div><div class="modalbody" id="trbody">' + LOADER + "</div></div>";
  document.body.appendChild(scrim);
  function close(){ scrim.remove(); document.removeEventListener("keydown", onKey); }
  function onKey(e){ if (e.key === "Escape") { e.preventDefault(); close(); } }
  document.addEventListener("keydown", onKey);
  scrim.addEventListener("click", function(ev){ if (ev.target === scrim) close(); });
  document.getElementById("trx").onclick = close;
  var body = document.getElementById("trbody");
  var base = "/api/projects/" + encodeURIComponent(pid) + "/triggers";
  var reveal = null; // { id, secret, path } just after a webhook is made

  function when(t) {
    if (t.kind === "webhook") return "webhook";
    return t.cron ? "cron " + t.cron : "every " + (t.everyMin % 1440 === 0 ? t.everyMin / 1440 + "d" : t.everyMin % 60 === 0 ? t.everyMin / 60 + "h" : t.everyMin + "m");
  }

  function load() {
    api(base).then(draw).catch(function(e){ body.innerHTML = '<div class="phmsg">' + esc(e.message) + "</div>"; });
  }

  function draw(j) {
    var list = j.triggers || [], runs = j.runs || [];
    var h = list.length ? "" : '<div class="trempty">No triggers yet. A schedule or a webhook starts the next turn on its own, each in its own thread.</div>';
    list.forEach(function(t){
      var mine = runs.filter(function(r){ return r.trigger === t.id; }).slice(0, 3);
      h += '<div class="trrow' + (t.enabled ? "" : " off") + '" data-t="' + esc(t.id) + '">' +
        '<div class="trhead"><b>' + esc(t.name) + '</b><span class="trwhen">' + esc(when(t)) + (t.agent ? " → " + esc(t.agent) : "") + "</span>" +
        (t.nextAt ? '<span class="trnext">next ' + esc(new Date(t.nextAt).toLocaleString()) + "</span>" : "") + "</div>" +
        '<div class="trprompt">' + esc(String(t.prompt).split("\n")[0].slice(0, 160)) + "</div>" +
        (reveal && reveal.id === t.id ? '<div class="trsecret"><div>URL <code>' + esc(location.origin + reveal.path) + "</code></div><div>Secret <code>" + esc(reveal.secret) +
          '</code> <span class="hintx">shown once — sign the body (X-Hub-Signature-256) or send it as X-Loom-Secret</span></div></div>' : "") +
        (mine.length ? '<div class="trruns">' + mine.map(function(r){ return '<span class="' + (r.ok ? "ok" : "skip") + '">' + (r.ok ? "✓" : "·") + " " + esc(new Date(r.at).toLocaleTimeString()) + " " + esc(r.note) + "</span>"; }).join("") + "</div>" : "") +
        '<div class="pillrow"><button class="btn ghost sm" data-fire>Run now</button><button class="btn ghost sm" data-toggle>' + (t.enabled ? "Pause" : "Resume") + '</button><button class="btn ghost sm" data-rm>Remove</button></div></div>';
    });
    h += '<details class="tradd"' + (list.length ? "" : " open") + '><summary>Add a trigger</summary><div class="cloudin">' +
      '<div class="field"><label>What the agent should do</label><textarea id="trprompt" rows="3" placeholder="Summarise yesterday\'s merged PRs. For a webhook: {{body.some.field}}, {{event}}"></textarea></div>' +
      '<div class="field"><label>When</label><select id="trkind"><option value="every">Every…</option><option value="cron">On a schedule (cron)</option><option value="webhook">When a webhook arrives</option></select></div>' +
      '<div class="field" id="trwhenf"><label id="trwhenl">Every</label><input id="trwhen" value="1h" spellcheck="false" placeholder="30m, 2h, 1d"></div>' +
      '<div class="field"><label>Name <span class="opt">optional</span></label><input id="trname" spellcheck="false"></div>' +
      '<div class="field"><label>Agent <span class="opt">optional — default: whoever holds the baton</span></label><input id="tragent" spellcheck="false"></div>' +
      '</div><div class="pillrow"><button class="btn primary sm" id="tradd">Add trigger</button></div></details>';
    body.innerHTML = h;
    reveal = null;
    var kind = document.getElementById("trkind");
    kind.onchange = function(){
      var k = kind.value, f = document.getElementById("trwhenf");
      f.style.display = k === "webhook" ? "none" : "";
      document.getElementById("trwhenl").textContent = k === "cron" ? "Cron (minute hour day month weekday, your local time)" : "Every";
      document.getElementById("trwhen").value = k === "cron" ? "0 9 * * 1-5" : "1h";
    };
    document.getElementById("tradd").onclick = function(){
      var prompt = document.getElementById("trprompt").value.trim();
      if (!prompt) { toast("say what the agent should do"); return; }
      var k = kind.value, w = document.getElementById("trwhen").value.trim();
      var name = document.getElementById("trname").value.trim(), agent = document.getElementById("tragent").value.trim();
      var req = { kind: k === "webhook" ? "webhook" : "schedule", prompt: prompt };
      if (k === "every") req.every = w; else if (k === "cron") req.cron = w;
      if (name) req.name = name;
      if (agent) req.agent = agent;
      api(base, { method: "POST", body: JSON.stringify(req) }).then(function(r){
        if (r.secret) reveal = { id: r.trigger.id, secret: r.secret, path: r.path };
        toast("trigger added");
        api(base).then(draw);
      }).catch(function(e){ toast(e.message); });
    };
    Array.prototype.forEach.call(body.querySelectorAll("[data-t]"), function(row){
      var id = row.getAttribute("data-t"), t = list.find(function(x){ return x.id === id; });
      row.querySelector("[data-fire]").onclick = function(){
        api(base + "/" + id + "/fire", { method: "POST", body: "{}" }).then(function(r){ toast(r.run.ok ? "queued — it runs in its own thread" : r.run.note); load(); }).catch(function(e){ toast(e.message); });
      };
      row.querySelector("[data-toggle]").onclick = function(){
        api(base + "/" + id, { method: "PATCH", body: JSON.stringify({ enabled: !t.enabled }) }).then(load).catch(function(e){ toast(e.message); });
      };
      row.querySelector("[data-rm]").onclick = function(){
        api(base + "/" + id, { method: "DELETE" }).then(function(){ toast("removed — its thread stays"); load(); }).catch(function(e){ toast(e.message); });
      };
    });
  }
  load();
}
