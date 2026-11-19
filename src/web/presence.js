/**
 * Who's in a shared chat right now (#362): initials in the header, and "typing…" when someone is
 * composing. The daemon keeps it in memory from the sockets (src/daemon/presence.ts); a client says
 * which chat it's looking at, heartbeats every 20s, and flips typing as the box fills and empties.
 */
import { esc } from './format.js';

var HEARTBEAT_MS = 20000, TYPING_IDLE_MS = 3500;

function initials(name){
  var parts = String(name || "?").trim().split(/\s+/).filter(Boolean);
  return ((parts[0] || "?")[0] + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase();
}
function hueOf(s){ var h = 0; for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360; return h; }

/**
 * The header's people row. `self` is this socket's own presence id (the hello frame's presenceId):
 * it's left out, and the row stays empty while nobody else is here, so a chat you're alone in
 * looks as it always did.
 */
export function presenceHtml(people, self){
  // self: this socket's presence id (from the WS hello), or a name for an older daemon
  var others = (people || []).filter(function(p){ return p.id !== self && p.name !== self; });
  if (!others.length) return "";
  var typing = others.filter(function(p){ return p.typing; });
  return '<span class="pres" role="status" aria-label="' + esc(others.map(function(p){ return p.name + (p.typing ? " (typing)" : p.following ? " (following your view)" : ""); }).join(", ") + " in this chat") + '">' +
    others.slice(0, 5).map(function(p){
      return '<span class="presav' + (p.typing ? " typing" : "") + (p.kind === "guest" ? " guest" : "") + '" title="' + esc(p.name + (p.kind === "guest" ? " · guest" : p.kind === "device" ? " · your device" : "") + (p.typing ? " · typing…" : p.following ? " · following your view" : "")) + '" style="--ph:' + hueOf(p.name) + '">' + esc(initials(p.name)) + "</span>";
    }).join("") +
    (others.length > 5 ? '<span class="presav more">+' + (others.length - 5) + "</span>" : "") +
    (typing.length ? '<span class="prestyping">' + esc(typing.length === 1 ? typing[0].name + " is typing…" : typing.length + " are typing…") + "</span>" : "") +
    "</span>";
}

/**
 * Keep the daemon told: which chat this socket is viewing (chatOf() is read every beat, so a switch
 * is picked up), and typing while `box` has fresh input. Returns stop().
 */
export function trackPresence(ws, chatOf, box, extra){
  var typing = false, idle = null, stopped = false, followingChat = null, observedChat = chatOf();
  function send(t){
    if (stopped || !ws || ws.readyState !== 1) return;
    try {
      var frame = { type: "presence", chat: chatOf(), ...(t === undefined ? {} : { typing: t }) };
      if (frame.chat !== observedChat) { observedChat = frame.chat; followingChat = null; }
      if (extra) Object.assign(frame, extra());
      else if (followingChat === frame.chat) {
        var pane = document.getElementById('pane-thread'), dock = document.querySelector('#dockpane.open'), tab = document.querySelector('#docktabs .dtab.on');
        var file = dock && tab && /^[fad]:/.test(tab.getAttribute('data-dtab') || '') ? tab.getAttribute('title') || '' : '';
        var preview = file ? Array.from(document.querySelectorAll('#pane-changes .filepreview .lc')).map(el => el.textContent).join('\n').slice(0, 20000) : '';
        frame.view = { scroll: pane && pane.scrollHeight > pane.clientHeight ? pane.scrollTop / (pane.scrollHeight - pane.clientHeight) : 1, ...(file ? { file, preview } : {}) };
      }
      ws.send(JSON.stringify(frame));
    } catch (e) {}
  }
  function setTyping(t){ if (t === typing) return; typing = t; send(t); }
  function onInput(){
    var has = !!(box && box.value.trim());
    setTyping(has);
    if (idle) clearTimeout(idle);
    if (has) idle = setTimeout(function(){ setTyping(false); }, TYPING_IDLE_MS);
  }
  function onPresence(event){
    try {
      var snapshot = JSON.parse(event.data);
      if (snapshot.type !== 'presence' || snapshot.chat !== chatOf()) return;
      if (snapshot.chat !== observedChat) { observedChat = snapshot.chat; followingChat = null; }
      var wasFollowing = followingChat === snapshot.chat;
      followingChat = (snapshot.people || []).some(p => p.kind === 'guest' && p.following === true) ? snapshot.chat : null;
      if (!extra && !wasFollowing && followingChat) send();
    } catch (e) {}
  }
  ws.addEventListener('message', onPresence);
  send(false);
  var beat = setInterval(function(){ send(); }, HEARTBEAT_MS);
  var viewTimer = null;
  function viewChanged(){ if (!viewTimer) viewTimer = setTimeout(function(){ viewTimer = null; send(); }, 250); }
  document.addEventListener('scroll', viewChanged, true);
  document.addEventListener('click', viewChanged);
  if (box) { box.addEventListener("input", onInput); box.addEventListener("blur", function(){ setTyping(false); }); }
  return {
    /** Say so now (a chat switch, or a send that emptied the box). */
    poke: function(){ typing = false; send(false); },
    stop: function(){ stopped = true; ws.removeEventListener('message', onPresence); clearInterval(beat); if (viewTimer) clearTimeout(viewTimer); document.removeEventListener("scroll", viewChanged, true); document.removeEventListener("click", viewChanged); if (idle) clearTimeout(idle); if (box) box.removeEventListener("input", onInput); },
  };
}
