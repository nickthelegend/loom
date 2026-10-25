/**
 * Share live: let a teammate into one running chat — to read along, to talk to the agent too, or
 * also to answer its tool approvals — for a few hours. The owner side is a dialog (a link + QR);
 * the guest side is a page that is only that chat, live. The daemon enforces the rest: a guest's
 * token reaches that chat and nothing else (server.ts, the guest wall).
 *
 * Approach credit: Nuphos's shared sessions ("invite someone into a running session; talk to the
 * same agent, see the same tool calls, steer together"), Apache-2.0, © Zeabur Inc.
 */

import { api, logout } from "./connection.js";
import { esc, mdToHtml } from "./format.js";
import { ICONS, LOADER } from "./icons.js";
import { toast } from "./notifications.js";
import { root, state } from "./state.js";

var GUEST_KEY = "loomGuest";
export function isGuest() { try { return localStorage.getItem(GUEST_KEY) === "1"; } catch (e) { return false; } }
export function markGuest(on) { try { if (on) localStorage.setItem(GUEST_KEY, "1"); else localStorage.removeItem(GUEST_KEY); } catch (e) {} }

var ROLES = [
  ["view", "Read along", "sees the chat live, can't send"],
  ["reply", "Talk to the agent", "sends messages and can stop a turn"],
  ["approve", "Talk and approve", "also answers the agent's tool approvals in this chat"],
];

/** Owner: a link that lets a teammate into this chat. */
export function openShareLive(pid, cid, title) {
  if (document.querySelector(".scrim")) return;
  var scrim = document.createElement("div"); scrim.className = "scrim";
  scrim.innerHTML = '<div class="modal phonemodal sharelive">' +
    '<div class="modalhead">Share live · ' + esc(title || "this chat") + '<button class="iconbtn" id="slx" aria-label="close">' + ICONS.x + '</button></div>' +
    '<div class="modalbody" id="slbody">' +
      '<label class="slfield">Their name<input id="slname" placeholder="e.g. Priya" maxlength="40" spellcheck="false"></label>' +
      '<div class="slroles" role="radiogroup" aria-label="What they can do">' + ROLES.map(function(r, i){
        return '<label class="slrole"><input type="radio" name="slrole" value="' + r[0] + '"' + (i === 1 ? " checked" : "") + '><span><b>' + r[1] + "</b><small>" + r[2] + "</small></span></label>";
      }).join("") + "</div>" +
      '<label class="slfield">For<select id="slhours"><option value="1">1 hour</option><option value="8">8 hours</option><option value="24" selected>a day</option><option value="168">a week</option></select></label>' +
      '<div class="phhint">They join from a browser with the link — nothing to install. They see this chat and nothing else on this machine, and you can revoke it any time under Settings ▸ Devices.</div>' +
    "</div>" +
    '<div class="modalfoot"><span class="spacer"></span><button class="btn" id="slmake">Create link</button></div></div>';
  document.body.appendChild(scrim);
  function close(){ scrim.remove(); document.removeEventListener("keydown", onKey); }
  function onKey(e){ if (e.key === "Escape") { e.preventDefault(); close(); } }
  document.addEventListener("keydown", onKey);
  scrim.addEventListener("click", function(ev){ if (ev.target === scrim) close(); });
  document.getElementById("slx").onclick = close;
  setTimeout(function(){ var n = document.getElementById("slname"); if (n) n.focus(); }, 30);
  document.getElementById("slmake").onclick = function(){
    var name = document.getElementById("slname").value.trim() || "Guest";
    var role = (scrim.querySelector('input[name="slrole"]:checked') || {}).value || "reply";
    var hours = Number(document.getElementById("slhours").value) || 24;
    var body = document.getElementById("slbody");
    body.innerHTML = LOADER;
    api("/api/pair/networks").catch(function(){ return null; }).then(function(nets){
      // the address a teammate can reach: the tailnet, else the LAN; Loom Cloud carries it anywhere
      var net = nets && ((nets.tailnet && nets.tailnet.reachable && nets.tailnet) || (nets.localnet && nets.localnet.reachable && nets.localnet));
      return api("/api/pair/new", { method: "POST", body: JSON.stringify({ ...(net && net.ip ? { host: net.ip } : {}), guest: { project: pid, chat: cid, role: role, name: name, hours: hours } }) })
        .then(function(r){ return { r: r, reachable: Boolean(net) }; });
    }).then(function(x){
      var r = x.r, viaCloud = /[#&]relay=/.test(r.link || "");
      body.innerHTML = '<div style="display:flex;flex-direction:column;align-items:center;gap:12px">' +
        (r.qrSvg ? '<div class="phqrcard">' + r.qrSvg + "</div>" : "") + "</div>" +
        '<div class="phlinkrow"><input id="sllink" readonly spellcheck="false" aria-label="share link" value="' + esc(r.link) + '"><button class="btn ghost" id="slcopy">Copy</button></div>' +
        '<div class="phhint">' + esc(name) + " can " + (role === "view" ? "read along" : role === "reply" ? "talk to the agent" : "talk and approve") +
        " until " + new Date(r.guest ? r.guest.until : Date.now() + hours * 3600000).toLocaleString() + ". The link works once; send it to them only." +
        (viaCloud ? " It reaches this machine from anywhere via Loom Cloud." : x.reachable ? " They need to be on the same network or tailnet." :
          " This machine only answers itself right now — turn on Loom Cloud (Settings ▸ Loom Cloud) or phone access so they can reach it.") + "</div>";
      document.getElementById("slcopy").onclick = function(){
        var i = document.getElementById("sllink"); i.select();
        (navigator.clipboard ? navigator.clipboard.writeText(i.value) : Promise.reject()).then(function(){ toast("copied"); }).catch(function(){ document.execCommand("copy"); toast("copied"); });
      };
      document.getElementById("slmake").textContent = "Done";
      document.getElementById("slmake").onclick = close;
    }).catch(function(e){ body.innerHTML = '<div class="phmsg">' + esc(e.message) + "</div>"; });
  };
}

// ── the guest's page ──

/** A teammate's view of the chat they were let into: that chat, live, and nothing else. */
export function renderGuest() {
  root.innerHTML = '<div class="guest">' + LOADER + "</div>";
  api("/api/guest").then(function(me){ draw(me); }).catch(function(e){
    if (/401|403|404|not a shared/.test(String(e.message))) { markGuest(false); root.innerHTML = '<div class="guest"><div class="gempty"><h2>This link has ended</h2><p>Ask for a new one.</p></div></div>'; return; }
    root.innerHTML = '<div class="guest"><div class="gempty">' + esc(e.message) + "</div></div>";
  });
}

function draw(me) {
  var canSend = me.role === "reply" || me.role === "approve";
  var pid = me.project.id;
  document.title = me.chat.title + " · shared · Loom";
  root.innerHTML = '<div class="guest">' +
    '<header class="ghead"><div class="gtitle"><b>' + esc(me.chat.title) + '</b><span class="gsub">' + esc(me.project.name) + " · shared with you as " + esc(me.name) + "</span></div>" +
    '<span class="grole">' + esc(me.role === "view" ? "reading along" : me.role === "reply" ? "can talk" : "can talk and approve") + "</span>" +
    '<button class="btn ghost" id="gleave">Leave</button></header>' +
    '<main class="gfeed" id="gfeed" aria-live="polite"></main>' +
    (canSend ? '<footer class="gcompose"><textarea id="gbox" rows="2" placeholder="Message the agent…"></textarea><div class="gacts"><button class="btn ghost" id="gstop">Stop</button><button class="btn" id="gsend">Send</button></div></footer>'
      : '<footer class="gcompose gview">You can read along. The person who shared it can let you talk too.</footer>') +
    "</div>";
  document.getElementById("gleave").onclick = function(){ markGuest(false); logout(); };
  var feed = document.getElementById("gfeed"), seen = {}, decided = {};

  function add(e) {
    if (seen[e.id]) return;
    seen[e.id] = true;
    var p = e.payload || {}, html = "";
    if (e.kind === "message" && !p.reasoning) {
      var who = e.agentId ? esc(e.agentId) : esc(p.by || (p.author === "loom" ? "Loom" : "owner"));
      html = '<div class="gmsg ' + (e.agentId ? "agent" : "human") + '"><div class="gwho">' + who + '</div><div class="gtext">' + mdToHtml(String(p.text || "")) + "</div></div>";
    } else if (e.kind === "tool_call") {
      html = '<div class="gtool">' + esc(String(p.tool || p.name || "tool")) + "</div>";
    } else if (e.kind === "approval" && p.phase === "requested") {
      html = '<div class="gapprove" data-approval="' + esc(p.approvalId) + '"><div><b>' + esc(e.agentId || "agent") + "</b> wants to use <b>" + esc(p.tool) + "</b></div><pre>" + esc(String(p.input || "").slice(0, 600)) + "</pre>" +
        (me.role === "approve" && !decided[p.approvalId] ? '<div class="gacts"><button class="btn ghost" data-deny>Deny</button><button class="btn" data-allow>Allow</button></div>' : '<div class="gnote">waiting for approval</div>') + "</div>";
    } else if (e.kind === "approval" && p.phase === "decided") {
      decided[p.approvalId] = true;
      var card = feed.querySelector('[data-approval="' + p.approvalId + '"] .gacts, [data-approval="' + p.approvalId + '"] .gnote');
      if (card) card.outerHTML = '<div class="gnote">' + (p.behavior === "allow" ? "allowed" : "denied") + (p.by ? " by " + esc(p.by) : "") + "</div>";
      return;
    } else if (e.kind === "error") {
      html = '<div class="gtool gerr">' + esc(String(p.message || "error")) + "</div>";
    }
    if (!html) return;
    var near = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 80;
    feed.insertAdjacentHTML("beforeend", html);
    if (near) feed.scrollTop = feed.scrollHeight;
  }

  feed.addEventListener("click", function(ev){
    var b = ev.target.closest && ev.target.closest("[data-allow],[data-deny]");
    if (!b) return;
    var id = b.closest("[data-approval]").getAttribute("data-approval");
    api("/api/projects/" + pid + "/approvals/" + id, { method: "POST", body: JSON.stringify({ decision: b.hasAttribute("data-allow") ? "allow" : "deny" }) }).catch(function(e){ toast(e.message); });
  });

  api("/api/projects/" + pid + "/events?limit=300").then(function(j){
    (j.events || []).forEach(add);
    feed.scrollTop = feed.scrollHeight;
  }).catch(function(e){ toast(e.message); });

  (function connect(){
    var ws = new WebSocket((location.protocol === "https:" ? "wss://" : "ws://") + location.host + "/ws?project=" + encodeURIComponent(pid), ["loom.bearer." + state.token]);
    ws.onmessage = function(ev){ try { var f = JSON.parse(ev.data); if (f.type === "event" && f.event) add(f.event); } catch (e) {} };
    ws.onclose = function(c){ if (c.code !== 4403 && document.getElementById("gfeed")) setTimeout(connect, 2000); };
  })();

  if (canSend) {
    var box = document.getElementById("gbox");
    var send = function(){
      var text = box.value.trim();
      if (!text) return;
      box.value = "";
      api("/api/projects/" + pid + "/messages", { method: "POST", body: JSON.stringify({ text: text }) }).catch(function(e){ toast(e.message); box.value = text; });
    };
    document.getElementById("gsend").onclick = send;
    box.addEventListener("keydown", function(e){ if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } });
    document.getElementById("gstop").onclick = function(){ api("/api/projects/" + pid + "/interrupt", { method: "POST", body: "{}" }).then(function(){ toast("stopped"); }).catch(function(e){ toast(e.message); }); };
  }
}
