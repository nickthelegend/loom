import { api } from '../connection.js';
import { esc } from '../format.js';
import { toast } from '../notifications.js';

var drafts = new Map(), opened = new Set(), forms = new Map();
function draftHtml(text){ return '<label>Draft · edit and copy<textarea class="scmmsg" rows="12" aria-label="Git draft">' + esc(text) + '</textarea></label>'; }
export function gitReviewHtml(pid, chat){
  var form = forms.get(pid + "/" + chat) || {};
  return '<details class="scmcommit" id="gitreview"' + (opened.has(pid + "/" + chat) ? " open" : "") + '><summary>Git and review</summary>' +
    '<label>Review checklist <select id="gittemplate">' + ["standard", "security", "release"].map(function(name){ return '<option' + (name === (form.gittemplate || "standard") ? " selected" : "") + '>' + esc(name) + "</option>"; }).join("") + '</select></label>' +
    '<label>Reviewer <input id="gitreviewagent" value="' + esc(form.gitreviewagent || "") + '" placeholder="agent id"></label><button class="btn sm" id="gitstartreview">Start review</button>' +
    '<button class="btn sm" id="gitdescribe">Draft PR description</button>' +
    '<label>Merged branch <input id="gitchangelogbranch" value="' + esc(form.gitchangelogbranch || "") + '" placeholder="feature/my-change"></label>' +
    '<button class="btn sm" id="gitchangelog">Suggest CHANGELOG</button>' +
    '<label>Message model (Claude; empty uses template)<input id="gitmessagemodel" value="' + esc(form.gitmessagemodel || "") + '" placeholder="e.g. haiku"></label>' +
    '<button class="btn sm" id="gitsavemodel">Save message model</button>' +
    '<div id="gitdraft">' + (drafts.has(pid + '/' + chat) ? draftHtml(drafts.get(pid + '/' + chat)) : '') + '</div></details>';
}

export function bindGitReview(pid, chat){
  var root = document.getElementById("gitreview");
  if (!root) return;
  var context = pid + "/" + chat; root.dataset.context = context;
  root.ontoggle = function(){ if (root.open) opened.add(context); else opened.delete(context); };
  function remember(e){
    if (e.target.matches("#gitdraft textarea")) drafts.set(context, e.target.value);
    else if (e.target.matches("input,select")) {
      var form = forms.get(context) || {}; form[e.target.id] = e.target.value; forms.set(context, form);
    }
  }
  root.addEventListener("input", remember); root.addEventListener("change", remember);
  function draft(button, route, body, key){
    button.disabled = true;
    api("/api/projects/" + pid + "/git/" + route, { method: "POST", body: JSON.stringify(body) })
      .then(function(r){
        drafts.set(context, r[key]);
        var current = document.getElementById("gitreview");
        if (current && current.dataset.context === context) current.querySelector("#gitdraft").innerHTML = draftHtml(r[key]);
      }).catch(function(e){ toast(e.message); }).finally(function(){ button.disabled = false; });
  }
  root.querySelector("#gitstartreview").onclick = function(){
    var button = this; button.disabled = true;
    api("/api/projects/" + pid + "/reviews", { method: "POST", body: JSON.stringify({ agents: [root.querySelector("#gitreviewagent").value], template: root.querySelector("#gittemplate").value }) })
      .then(function(r){ toast("Review started"); location.hash = "#p/" + encodeURIComponent(pid) + "/c/" + encodeURIComponent(r.review.chat); })
      .catch(function(e){ toast(e.message); }).finally(function(){ button.disabled = false; });
  };
  root.querySelector("#gitdescribe").onclick = function(){ draft(this, "pr-description", { chat: chat, template: root.querySelector("#gittemplate").value }, "description"); };
  root.querySelector("#gitchangelog").onclick = function(){ draft(this, "changelog", { branch: root.querySelector("#gitchangelogbranch").value }, "entry"); };
  if (!(forms.get(context) || {}).hasOwnProperty("gitmessagemodel")) api("/api/projects/" + pid + "/config").then(function(c){
    var form = forms.get(context) || {};
    if (!Object.prototype.hasOwnProperty.call(form, "gitmessagemodel")) {
      form.gitmessagemodel = (c.git || {}).messageModel || ""; forms.set(context, form);
      root.querySelector("#gitmessagemodel").value = form.gitmessagemodel;
    }
  }).catch(function(){});
  root.querySelector("#gitsavemodel").onclick = function(){
    api("/api/projects/" + pid + "/config", { method: "PATCH", body: JSON.stringify({ git: { messageModel: root.querySelector("#gitmessagemodel").value } }) })
      .then(function(){ toast("Message model saved"); }).catch(function(e){ toast(e.message); });
  };
}
