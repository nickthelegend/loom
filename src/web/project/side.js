/**
 * Side chats (#376): `/btw <question>` asks the agent something about the work without touching
 * the thread or the turn that's running. It opens a drawer beside the thread, answered by the same
 * agent and model in a read-only fork; none of it enters the project's log or memory. "Bring back"
 * quotes an answer into the main composer, where it's yours to send or not.
 *
 * Approach after Agent Orchestrator (side.go) and T3 Code (/side, /btw).
 */
import { api } from '../connection.js';
import { esc,mdToHtml } from '../format.js';
import { ICONS } from '../icons.js';
import { toast } from '../notifications.js';
import { state } from '../state.js';

var side = null; // { pid, chat, sideId, messages: [{role,text,at}], live: "", busy, error }

function drawer(){ return document.getElementById("sidedrawer"); }

function draw(){
  var el = drawer();
  if (!el || !side) return;
  var msgs = side.messages.map(function(m, i){
    if (m.role === "user") return '<div class="sdq">' + esc(m.text) + "</div>";
    return '<div class="sda"><div class="bubble md">' + mdToHtml(m.text) + "</div>" +
      '<button type="button" class="sdback" data-sdback="' + i + '" title="quote this into the main composer">' + ICONS.up + "Bring back</button></div>";
  }).join("");
  var live = side.busy
    ? '<div class="sda live"><div class="bubble md">' + (side.live ? mdToHtml(side.live) : '<span class="sdthink">thinking…</span>') + "</div></div>"
    : "";
  var body = el.querySelector(".sdbody");
  var atEnd = !body || body.scrollHeight - body.scrollTop - body.clientHeight < 40;
  el.querySelector(".sdbody").innerHTML = msgs + live + (side.error ? '<div class="sderr">' + esc(side.error) + "</div>" : "");
  if (atEnd) { var b = el.querySelector(".sdbody"); b.scrollTop = b.scrollHeight; }
  var send = el.querySelector("#sdsend");
  if (send) send.disabled = !!side.busy;
  Array.prototype.forEach.call(el.querySelectorAll("[data-sdback]"), function(btn){
    btn.onclick = function(){ bringBack(side.messages[Number(btn.getAttribute("data-sdback"))]); };
  });
}

/** Quote an answer into the main composer as a Markdown block quote, after what's already there. */
function bringBack(m){
  if (!m) return;
  var box = document.getElementById("box");
  if (!box) return;
  var quote = String(m.text || "").trim().split("\n").map(function(l){ return "> " + l; }).join("\n");
  box.value = (box.value.trim() ? box.value.replace(/\s+$/, "") + "\n\n" : "") + quote + "\n\n";
  box.dispatchEvent(new Event("input", { bubbles: true }));
  box.focus();
  box.setSelectionRange(box.value.length, box.value.length);
  toast("quoted into your message — it goes nowhere until you send it");
}

function mount(){
  var el = drawer();
  if (el) return el;
  el = document.createElement("aside");
  el.id = "sidedrawer";
  el.className = "sidedrawer";
  el.setAttribute("role", "complementary");
  el.setAttribute("aria-label", "Side chat");
  el.innerHTML =
    '<div class="sdhead"><span class="sdt">Side chat</span><span class="sds" id="sdsub"></span><span class="spacer"></span>' +
      '<button class="iconbtn" id="sdclose" title="close (forgets this side chat)" aria-label="close side chat">' + ICONS.x + "</button></div>" +
    '<div class="sdnote">Read-only, private to you — none of this goes into the thread or the brain.</div>' +
    '<div class="sdbody"></div>' +
    '<form class="sdform" id="sdform"><textarea id="sdbox" rows="2" placeholder="Ask on the side…" spellcheck="true"></textarea>' +
      '<button type="submit" class="sendbtn" id="sdsend" aria-label="ask">' + ICONS.up + "</button></form>";
  document.body.appendChild(el);
  el.querySelector("#sdclose").onclick = closeSide;
  el.querySelector("#sdform").onsubmit = function(ev){
    ev.preventDefault();
    var b = el.querySelector("#sdbox"), t = (b.value || "").trim();
    if (!t || (side && side.busy)) return;
    b.value = "";
    ask(t);
  };
  el.querySelector("#sdbox").onkeydown = function(e){
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); el.querySelector("#sdform").requestSubmit ? el.querySelector("#sdform").requestSubmit() : el.querySelector("#sdsend").click(); }
    else if (e.key === "Escape") { e.preventDefault(); closeSide(); }
  };
  return el;
}

function ask(text){
  if (!side) return;
  // a side chat that failed can't take more; forget it on the daemon and carry on in a fresh one
  if (side.error && side.sideId) {
    var stale = side.sideId;
    api("/api/projects/" + side.pid + "/chats/" + encodeURIComponent(side.chat) + "/side/" + encodeURIComponent(stale), { method: "DELETE" }).catch(function(){});
    side.sideId = null;
  }
  side.messages.push({ role: "user", text: text, at: Date.now() });
  side.busy = true; side.live = ""; side.error = "";
  draw();
  var body = { text: text };
  if (side.sideId) body.sideId = side.sideId;
  var mine = side;
  api("/api/projects/" + mine.pid + "/chats/" + encodeURIComponent(mine.chat) + "/side", { method: "POST", body: JSON.stringify(body) })
    .then(function(j){ if (side === mine && j && j.sideId) { mine.sideId = j.sideId; poll(mine); } })
    .catch(function(err){ if (side === mine) { mine.busy = false; mine.error = err.message; draw(); } });
}

/** The WS frames carry the answer live; a slow poll catches anything a dropped socket missed. */
function poll(mine){
  if (side !== mine || !mine.sideId || !mine.busy) return;
  setTimeout(function(){
    if (side !== mine || !mine.busy) return;
    api("/api/projects/" + mine.pid + "/chats/" + encodeURIComponent(mine.chat) + "/side/" + encodeURIComponent(mine.sideId))
      .then(function(j){
        if (side !== mine) return;
        if (j && Array.isArray(j.messages)) mine.messages = j.messages;
        mine.busy = Boolean(j && j.busy);
        if (j && j.error) mine.error = String(j.error);
        if (!mine.busy) mine.live = "";
        draw();
        poll(mine);
      })
      .catch(function(){ poll(mine); });
  }, 2500);
}

/** A WS "side" frame: delta | message | done for one side chat. */
function onSideFrame(frame){
  if (!side) return;
  // the first frames can beat the POST's answer: adopt the id for this chat's pending ask
  if (!side.sideId && side.busy && frame.chat === side.chat) side.sideId = frame.sideId;
  if (frame.sideId !== side.sideId) return;
  if (frame.delta) { side.live += String(frame.delta); draw(); return; }
  if (frame.message) {
    var m = typeof frame.message === "string" ? { role: "agent", text: frame.message, at: Date.now() } : frame.message;
    if (m.role !== "user" && !side.messages.some(function(x){ return x.role === "agent" && x.at === m.at && x.text === m.text; })) { side.messages.push({ role: "agent", text: String(m.text || ""), at: m.at || Date.now() }); side.live = ""; }
    draw();
  }
  if (frame.done) { side.busy = false; side.live = ""; if (frame.error) side.error = String(frame.error); draw(); }
}

/** Open (or continue) this chat's side drawer, optionally asking a first question. */
export function openSide(pid, chat, question, who){
  chat = chat || "main";
  if (!side || side.pid !== pid || side.chat !== chat) {
    if (side && side.sideId) closeSide(true);
    side = { pid: pid, chat: chat, sideId: null, messages: [], live: "", busy: false, error: "" };
  }
  var el = mount();
  var sub = el.querySelector("#sdsub");
  if (sub) sub.textContent = who ? "with " + who : "";
  document.body.classList.add("hasside");
  draw();
  if (question && question.trim()) ask(question.trim());
  else setTimeout(function(){ var b = document.getElementById("sdbox"); if (b) b.focus(); }, 30);
}

export function closeSide(quiet){
  var was = side;
  side = null;
  var el = drawer();
  if (el) el.remove();
  document.body.classList.remove("hasside");
  if (was && was.sideId) {
    api("/api/projects/" + was.pid + "/chats/" + encodeURIComponent(was.chat) + "/side/" + encodeURIComponent(was.sideId), { method: "DELETE" })
      .catch(function(){ if (!quiet) toast("couldn't close the side chat on the daemon"); });
  }
}

state.onSideFrame = onSideFrame;
