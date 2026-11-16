import { api } from '../connection.js';
import { esc } from '../format.js';
import { modalErr } from '../notifications.js';

/** Choose the model before creating any sessions, in either roster surface. */
export function addAgents(pid, kind){
  return new Promise(function(resolve){
    var scrim = document.createElement("div");
    scrim.className = "scrim cfscrim";
    scrim.innerHTML = '<form class="modal cfmodal" role="dialog" aria-modal="true" aria-label="Add agents">' +
      '<div class="cft">Add ' + esc(kind) + '</div>' +
      '<label class="cflab" for="addmodel">Model<input class="cfin" id="addmodel" list="addmodels" placeholder="' +
        (kind === "model" ? 'provider/model' : 'Default model') + '" autocomplete="off" spellcheck="false"' + (kind === "model" ? ' required' : '') + '>' +
        '<datalist id="addmodels"></datalist></label>' +
      '<label class="cflab" for="addcount">Count<input class="cfin" id="addcount" type="number" min="1" max="8" step="1" value="1" required></label>' +
      // which subscription runs it (#379) — only for the CLIs that take a config home
      (kind === "claude-code" || kind === "codex" ? '<label class="cflab" for="addaccount" id="addaccountrow" style="display:none">Account<select class="cfin" id="addaccount"><option value="">Default sign-in</option></select></label>' : "") +
      '<div class="modalfoot"><button type="button" class="btn ghost" data-cancel>Cancel</button>' +
        '<button type="submit" class="btn primary">Add agents</button></div></form>';
    document.body.appendChild(scrim);
    var form = scrim.querySelector("form"), model = scrim.querySelector("#addmodel"), count = scrim.querySelector("#addcount");
    var busy = false;
    function done(result){
      document.removeEventListener("keydown", key, true);
      scrim.remove();
      resolve(result);
    }
    function cancel(){ if (!busy) done(null); }
    function key(e){ if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); cancel(); } }
    document.addEventListener("keydown", key, true);
    scrim.onmousedown = function(e){ if (e.target === scrim) cancel(); };
    scrim.querySelector("[data-cancel]").onclick = cancel;
    form.onsubmit = function(e){
      e.preventDefault();
      if (busy || !form.reportValidity()) return;
      var n = Number(count.value), selected = model.value.trim();
      if (!Number.isInteger(n) || n < 1 || n > 8) { modalErr(scrim, "Count must be an integer from 1 to 8", count); return; }
      if (kind === "model" && !selected) { modalErr(scrim, "Choose a model", model); return; }
      busy = true;
      var submit = form.querySelector('[type="submit"]');
      submit.disabled = true;
      modalErr(scrim, "");
      var body = { kind: kind, count: n };
      if (selected) body.model = selected;
      var acct = scrim.querySelector("#addaccount");
      if (acct && acct.value) body.account = acct.value;
      api("/api/projects/" + pid + "/agents", { method: "POST", body: JSON.stringify(body) })
        .then(done)
        .catch(function(e){ busy = false; submit.disabled = false; modalErr(scrim, e.message); });
    };
    api("/api/projects/" + pid + "/agents/models?kind=" + encodeURIComponent(kind))
      .then(function(j){
        scrim.querySelector("#addmodels").innerHTML = (j.models || []).map(function(m){ return '<option value="' + esc(m) + '"></option>'; }).join("");
      })
      .catch(function(){ /* Free text still works when suggestions are unavailable. */ });
    if (kind === "claude-code" || kind === "codex") {
      api("/api/accounts").then(function(j){
        var mine = ((j && j.accounts) || []).filter(function(a){ return a.kind === kind; });
        if (!mine.length) return;
        var sel = scrim.querySelector("#addaccount"); if (!sel) return;
        sel.innerHTML += mine.map(function(a){ return '<option value="' + esc(a.id) + '">' + esc(a.label) + (a.authed === false ? " (signed out)" : "") + "</option>"; }).join("");
        scrim.querySelector("#addaccountrow").style.display = "";
      }).catch(function(){});
    }
    model.focus();
  });
}
