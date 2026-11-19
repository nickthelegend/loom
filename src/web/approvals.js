/** Browser approvals module. See README.md for ownership and startup. */
import { agentGlyph,kindOf,labelOf } from './agents.js';
import { api } from './connection.js';
import { esc,rel } from './format.js';
import { ICONS } from './icons.js';
import { toast } from './notifications.js';
import { state } from './state.js';


  // ---- approvals: an agent in "always ask" waits on a human -----------------
  // Claude Code routes each permission prompt through Loom's MCP approve tool
  // (core/approvals.ts); the daemon holds the request open and puts it in the
  // thread. These draw it, answer it, and fold it once answered — wherever the
  // answer came from, this window, another, or the phone.
  /** A tool's input for a human: JSON indented, else as sent. */
  function prettyInput(v){
    if (v == null) return "";
    if (typeof v !== "string") { try { return JSON.stringify(v, null, 2); } catch (e) { return String(v); } }
    // a preview cut at 4000 chars no longer parses — show it as it came
    try { return JSON.stringify(JSON.parse(v), null, 2); } catch (e) { return v; }
  }

  /** One request as a card: who, which tool, with what (folded when long), and the two answers. */
  function approvalCard(a, opts){
    opts = opts || {};
    var id = a.approvalId || a.id, agent = a.agent || a.agentId || "agent";
    var body = prettyInput(a.input);
    var gist = String(body).replace(/\s+/g, " ").slice(0, 80);
    var when = a.createdAt || a.ts;
    return '<div class="apcard" data-approval="' + esc(id) + '">' +
      '<div class="aph"><span class="apk">Approval needed</span>' +
        '<span class="apag">' + agentGlyph(kindOf(agent), agent) + esc(labelOf(agent)) + "</span>" +
        '<span class="apw">wants to use</span><span class="aptool">' + esc(a.tool || "a tool") + "</span>" +
        (when ? '<span class="aprel">' + rel(when) + "</span>" : "") + "</div>" +
      '<div class="apbody">' +
        (a.expiresAt ? '<p>Auto-denies at ' + esc(new Date(a.expiresAt).toLocaleTimeString()) + '</p>' : '') +
        (body && body !== "{}" ? '<details class="apin"' + (body.length <= 280 ? " open" : "") + "><summary>input \u00b7 " + esc(gist) + "</summary><pre>" + esc(body) + "</pre></details>" : "") +
        '<div class="apact"><input class="apwhy" placeholder="Reason, if you deny (optional)" maxlength="500" aria-label="reason for denying">' +
          (opts.open && a.chat ? '<button class="apopen" type="button" data-apchat="' + esc(a.chat) + '" title="open the thread it came from">thread</button>' : "") +
          '<button class="btn outline sm apdeny" type="button" data-apact="deny" data-apid="' + esc(id) + '">' + ICONS.x + "Deny</button>" +
          (a.sessionOption ? '<button class="btn outline sm apsess" type="button" data-apact="allow_session" data-apid="' + esc(id) + '" title="allow this for the rest of the agent\'s session">' + ICONS.check + "Allow for session</button>" : "") +
          '<button class="btn primary sm apallow" type="button" data-apact="allow" data-apid="' + esc(id) + '">' + ICONS.check + "Allow</button></div>" +
      "</div>" +
      '<div class="apres"></div></div>';
  }

  /**
   * Fold every card for this request to its outcome. behavior "" means we
   * know it was answered but not how (a 404: someone else got there first) —
   * which never overwrites a card that already knows.
   */
  function settleApprovalCards(id, behavior, message){
    var n = 0;
    Array.prototype.forEach.call(document.querySelectorAll(".apcard[data-approval]"), function(c){
      if (c.getAttribute("data-approval") !== id) return;
      n++;
      if (!behavior && c.classList.contains("done")) return;
      var tool = (c.querySelector(".aptool") || {}).textContent || "tool";
      var who = (c.querySelector(".apag") || {}).textContent || "";
      var res = c.querySelector(".apres");
      c.classList.add("done");
      if (res) res.innerHTML = (behavior === "allow" || behavior === "allow_session" ? '<span class="ok">\u2713 allowed' + (behavior === "allow_session" ? " for the session" : "") + "</span>"
          : behavior === "deny" ? '<span class="no">\u2715 denied</span>' : "<span>\u2713 answered elsewhere</span>") +
        "<span>" + esc(tool) + (who ? " \u00b7 " + esc(who) : "") + (message ? " \u2014 " + esc(message) : "") + "</span>";
    });
    return n > 0;
  }

  function pendingApprovals(){ return state.approvals && state.approvals.pid === state.pid ? state.approvals.list : []; }

  function dropApproval(id){
    var ap = state.approvals; if (!ap) return;
    ap.list = ap.list.filter(function(a){ return a.id !== id; });
    drawApBadge();
  }

  function decideApproval(id, decision, message, btn){
    var pid = state.pid;
    var card = btn && btn.closest ? btn.closest(".apcard") : null;
    var btns = card ? card.querySelectorAll("button[data-apact]") : [];
    Array.prototype.forEach.call(btns, function(b){ b.disabled = true; });
    var body = { decision: decision };
    if (decision === "deny" && message) body.message = message;
    return api("/api/projects/" + pid + "/approvals/" + encodeURIComponent(id), { method: "POST", body: JSON.stringify(body) })
      .then(function(){ settleApprovalCards(id, decision, decision === "deny" ? message : ""); dropApproval(id); })
      .catch(function(err){
        // Answered already (another window, the phone): the card is stale, not wrong.
        if (/no such approval|already answered/i.test(err.message)) { settleApprovalCards(id, "", ""); dropApproval(id); return; }
        Array.prototype.forEach.call(btns, function(b){ b.disabled = false; });
        toast(err.message);
      });
  }

  /** Delegated clicks for any surface that shows approval cards. True if it handled one. */
  function approvalClick(ev){
    var t = ev.target;
    var open = t.closest && t.closest("[data-apchat]");
    if (open) { closeApprovalsPop(); if (state.setChat) state.setChat(state.pid, open.getAttribute("data-apchat")); return true; }
    var b = t.closest && t.closest("[data-apact]");
    if (!b) return false;
    var card = b.closest(".apcard"), why = card && card.querySelector(".apwhy");
    decideApproval(b.getAttribute("data-apid"), b.getAttribute("data-apact"), why ? why.value.trim() : "", b);
    return true;
  }

  /** Enter in a card's reason box denies with that reason. */
  function approvalKey(ev){
    if (ev.key !== "Enter" || !ev.target.classList || !ev.target.classList.contains("apwhy")) return;
    ev.preventDefault();
    var d = ev.target.closest(".apcard").querySelector('[data-apact="deny"]');
    if (d && !d.disabled) d.click();
  }

  /** The pending count, wherever a badge for it is drawn (tab strip, phone header). */
  function drawApBadge(){
    var n = pendingApprovals().length;
    Array.prototype.forEach.call(document.querySelectorAll(".apbadge"), function(b){
      b.style.display = n ? "" : "none";
      b.innerHTML = '<span class="apn">' + n + "</span> to approve";
      b.title = n + " tool call" + (n === 1 ? "" : "s") + " waiting on your approval";
    });
    drawApPop();
  }

  /** Every request waiting in this project, answerable in place. */
  function openApprovalsPop(anchor){
    if (document.getElementById("appop")) { closeApprovalsPop(); return; }
    var pop = document.createElement("div");
    pop.id = "appop"; pop.className = "appop";
    pop.setAttribute("role", "dialog"); pop.setAttribute("aria-label", "pending approvals");
    document.body.appendChild(pop);
    pop.addEventListener("click", function(ev){ if (ev.target.closest && ev.target.closest("#appopx")) { closeApprovalsPop(); return; } approvalClick(ev); });
    pop.addEventListener("keydown", approvalKey);
    drawApPop();
    var r = anchor.getBoundingClientRect();
    pop.style.top = Math.round(r.bottom + 6) + "px";
    pop.style.left = Math.max(12, Math.min(window.innerWidth - pop.offsetWidth - 12, Math.round(r.right - pop.offsetWidth))) + "px";
    setTimeout(function(){ document.addEventListener("mousedown", apPopAway); document.addEventListener("keydown", apPopEsc); }, 0);
  }

  function drawApPop(){
    var pop = document.getElementById("appop"); if (!pop) return;
    var list = pendingApprovals();
    pop.innerHTML = '<div class="appoph">Waiting on you <span class="bn">' + list.length + "</span>" +
      '<span class="spacer"></span><button class="iconbtn" id="appopx" type="button" title="close">' + ICONS.x + "</button></div>" +
      '<div class="appopl">' + (list.length ? list.map(function(a){ return approvalCard(a, { open: true }); }).join("")
        : '<div class="pmempty">Nothing waiting \u2014 every tool call has its answer.</div>') + "</div>";
  }

  function apPopAway(ev){
    var pop = document.getElementById("appop");
    if (pop && !pop.contains(ev.target) && !(ev.target.closest && ev.target.closest(".apbadge"))) closeApprovalsPop();
  }

  function apPopEsc(ev){ if (ev.key === "Escape") closeApprovalsPop(); }

  function closeApprovalsPop(){
    document.removeEventListener("mousedown", apPopAway); document.removeEventListener("keydown", apPopEsc);
    var pop = document.getElementById("appop"); if (pop) pop.remove();
  }
export { apPopAway,apPopEsc,approvalCard,approvalClick,approvalKey,closeApprovalsPop,decideApproval,drawApBadge,drawApPop,dropApproval,openApprovalsPop,pendingApprovals,prettyInput,settleApprovalCards };
