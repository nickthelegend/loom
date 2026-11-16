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
  return '<span class="pres" role="status" aria-label="' + esc(others.map(function(p){ return p.name + (p.typing ? " (typing)" : ""); }).join(", ") + " in this chat") + '">' +
    others.slice(0, 5).map(function(p){
      return '<span class="presav' + (p.typing ? " typing" : "") + (p.kind === "guest" ? " guest" : "") + '" title="' + esc(p.name + (p.kind === "guest" ? " · guest" : p.kind === "device" ? " · your device" : "") + (p.typing ? " · typing…" : "")) + '" style="--ph:' + hueOf(p.name) + '">' + esc(initials(p.name)) + "</span>";
    }).join("") +
    (others.length > 5 ? '<span class="presav more">+' + (others.length - 5) + "</span>" : "") +
    (typing.length ? '<span class="prestyping">' + esc(typing.length === 1 ? typing[0].name + " is typing…" : typing.length + " are typing…") + "</span>" : "") +
    "</span>";
}

/**
 * Keep the daemon told: which chat this socket is viewing (chatOf() is read every beat, so a switch
 * is picked up), and typing while `box` has fresh input. Returns stop().
 */
export function trackPresence(ws, chatOf, box){
  var typing = false, idle = null, stopped = false;
  function send(t){
    if (stopped || !ws || ws.readyState !== 1) return;
    try { ws.send(JSON.stringify(t === undefined ? { type: "presence", chat: chatOf() } : { type: "presence", chat: chatOf(), typing: t })); } catch (e) {}
  }
  function setTyping(t){ if (t === typing) return; typing = t; send(t); }
  function onInput(){
    var has = !!(box && box.value.trim());
    setTyping(has);
    if (idle) clearTimeout(idle);
    if (has) idle = setTimeout(function(){ setTyping(false); }, TYPING_IDLE_MS);
  }
  send(false);
  var beat = setInterval(function(){ send(); }, HEARTBEAT_MS);
  if (box) { box.addEventListener("input", onInput); box.addEventListener("blur", function(){ setTyping(false); }); }
  return {
    /** Say so now (a chat switch, or a send that emptied the box). */
    poke: function(){ typing = false; send(false); },
    stop: function(){ stopped = true; clearInterval(beat); if (idle) clearTimeout(idle); if (box) box.removeEventListener("input", onInput); },
  };
}
