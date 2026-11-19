/** Browser notifications module. See README.md for ownership and startup. */
import { state } from './state.js';
import { durfmt } from './transcript.js';
import { esc } from './format.js';
import { labelOf } from './agents.js';


  // a request that fails after the page is gone (a closed tab, a torn-down test window) has no one to tell
  /**
   * A composer menu opens upward from the card. With the Orchestrate cast
   * showing, the card is tall enough that a 440px menu ran off the top of the
   * window — cap it to the room actually above the card.
   */
  function fitMenu(m){
    if (!m || !m.parentNode || !m.parentNode.getBoundingClientRect) return;
    var top = m.parentNode.getBoundingClientRect().top;
    if (top > 0) m.style.maxHeight = Math.max(180, Math.min(460, Math.floor(top - 16))) + "px";
  }
  /**
   * An in-app confirm instead of the browser's own dialog. That one reads
   * "127.0.0.1 says…" in the desktop app, blocks the whole page, and some
   * embedders dismiss it unseen — the click on Abort simply did nothing.
   * Resolves true or false. A page that installed its own window.confirm (an
   * embedder, a test harness) is honoured as-is.
   */
  /**
   * Say what's wrong inside the dialog that's wrong, beside its buttons — a
   * toast lands behind the dialog, at the bottom of the window, where nobody
   * is looking while they fill a form in. Empty message clears it.
   */
  function modalErr(root, msg, focusEl){
    if (!root) return;
    var foot = root.querySelector(".modalfoot"); if (!foot) { if (msg) toast(msg); return; }
    var e = foot.querySelector(".mferr");
    if (!e) { e = document.createElement("span"); e.className = "mferr"; e.setAttribute("role", "alert"); foot.insertBefore(e, foot.firstChild); }
    e.textContent = msg || "";
    if (msg && focusEl && focusEl.focus) focusEl.focus();
  }
  function askConfirm(message, opts){
    opts = opts || {};
    try {
      if (typeof window.confirm === "function" && String(window.confirm).indexOf("[native code]") < 0) {
        return Promise.resolve(!!window.confirm(message));
      }
    } catch (e) {}
    return new Promise(function(resolve){
      var text = String(message || "");
      var cut = text.indexOf("\n\n");
      var q = text.indexOf("?");
      var head = cut > 0 ? text.slice(0, cut) : (q > 0 && q < 140 ? text.slice(0, q + 1) : text);
      var body = cut > 0 ? text.slice(cut + 2) : (q > 0 && q < 140 ? text.slice(q + 1).trim() : "");
      var scrim = document.createElement("div");
      scrim.className = "scrim cfscrim";
      scrim.innerHTML = '<div class="modal cfmodal" role="alertdialog" aria-modal="true">' +
        '<div class="cft">' + esc(head) + "</div>" +
        (body ? '<div class="cfb">' + esc(body).replace(/\n/g, "<br>") + "</div>" : "") +
        '<div class="cfa"><button type="button" class="btn sm ghost" data-cf="0">Cancel</button>' +
        '<button type="button" class="btn sm ' + (opts.danger ? "cfdanger" : "primary") + '" data-cf="1">' + esc(opts.ok || "Continue") + "</button></div></div>";
      document.body.appendChild(scrim);
      function done(v){ document.removeEventListener("keydown", key, true); if (scrim.parentNode) scrim.parentNode.removeChild(scrim); resolve(v); }
      function key(e){
        if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); done(false); }
        else if (e.key === "Enter") { e.preventDefault(); e.stopPropagation(); done(true); }
      }
      document.addEventListener("keydown", key, true);
      scrim.onmousedown = function(e){ if (e.target === scrim) done(false); };
      scrim.querySelector('[data-cf="1"]').onclick = function(){ done(true); };
      scrim.querySelector('[data-cf="0"]').onclick = function(){ done(false); };
      setTimeout(function(){ var b = scrim.querySelector('[data-cf="1"]'); if (b) b.focus(); }, 0);
    });
  }
  /**
   * An in-app text prompt. The desktop shell (Electron) has no window.prompt
   * at all — it returns nothing — so every "Rename…" and "why?" that used it
   * silently did nothing there. Resolves the text, or null when cancelled. A
   * page that installed its own window.prompt (a test harness) is honoured.
   */
  function askText(message, opts){
    opts = opts || {};
    try {
      if (typeof window.prompt === "function" && String(window.prompt).indexOf("[native code]") < 0) {
        var v = window.prompt(message, opts.value || "");
        return Promise.resolve(v === undefined ? null : v);
      }
    } catch (e) {}
    return new Promise(function(resolve){
      var scrim = document.createElement("div");
      scrim.className = "scrim cfscrim";
      var multi = !!opts.multiline;
      scrim.innerHTML = '<div class="modal cfmodal" role="dialog" aria-modal="true">' +
        '<div class="cft">' + esc(String(message || "")) + "</div>" +
        (opts.note ? '<div class="cfb">' + esc(opts.note) + "</div>" : "") +
        (multi
          ? '<textarea class="cfin" rows="4" spellcheck="true"></textarea>'
          : '<input class="cfin" type="text" spellcheck="false" autocomplete="off">') +
        '<div class="cfa"><button type="button" class="btn sm ghost" data-cf="0">Cancel</button>' +
        '<button type="button" class="btn sm primary" data-cf="1">' + esc(opts.ok || "OK") + "</button></div></div>";
      document.body.appendChild(scrim);
      var input = scrim.querySelector(".cfin");
      input.value = opts.value || "";
      if (opts.placeholder) input.placeholder = opts.placeholder;
      function done(v){ document.removeEventListener("keydown", key, true); if (scrim.parentNode) scrim.parentNode.removeChild(scrim); resolve(v); }
      function ok(){
        var v = input.value;
        if (opts.required && !v.trim()) { input.focus(); input.classList.add("bad"); return; }
        done(v);
      }
      function key(e){
        if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); done(null); }
        else if (e.key === "Enter" && (!multi || e.metaKey || e.ctrlKey)) { e.preventDefault(); e.stopPropagation(); ok(); }
      }
      document.addEventListener("keydown", key, true);
      scrim.onmousedown = function(e){ if (e.target === scrim) done(null); };
      scrim.querySelector('[data-cf="1"]').onclick = ok;
      scrim.querySelector('[data-cf="0"]').onclick = function(){ done(null); };
      setTimeout(function(){ input.focus(); input.select(); }, 0);
    });
  }
  function toast(msg){ if (typeof document === "undefined" || !document) return; var t = document.getElementById("toast"); if (!t) return;
    // while the daemon is down the banner says so once; polls don't each toast it
    if (state.daemonUp === false && /Can’t reach Loom|Failed to fetch|Load failed|NetworkError/i.test(String(msg))) return;
    rememberNotification(msg);
    t.textContent = msg;
    t.classList.add("show"); clearTimeout(t._t); t._t = setTimeout(function(){ t.classList.remove("show"); }, 2600); }

  /** Assertive screen-reader announcement for high-stakes moments (an agent
   *  needs you). Cleared then re-set so repeats are re-announced. */
  function announce(msg){ var a = document.getElementById("a11y-alert"); if (!a) return;
    a.textContent = ""; setTimeout(function(){ a.textContent = msg; }, 60); }

  /** The core alert. An agent is blocked on the human — the one moment Loom is
   *  built to surface. Reach the user through every channel that isn't already
   *  looking: assertive SR announce, a title flash while the tab is hidden, and
   *  an OS notification when permitted. Restored on the next focus. */
  var _titleFlash = null, _baseTitle = "Loom";

  function stopTitleFlash(){ if (_titleFlash){ clearInterval(_titleFlash); _titleFlash = null; document.title = _baseTitle; } }

  function notifyNeedsInput(ev){
    var who = (ev && ev.agentId) || "an agent";
    var q = ev && ev.payload && ev.payload.question ? ev.payload.question : "";
    announce(who + " needs input" + (q ? ": " + q : ""));
    toast("\u23f8 " + who + " needs you");
    // The desktop shell can do better than a browser notification: a native
    // one carrying the question, answerable where the OS allows it. Quiet when
    // the window is focused and already on that conversation — a notification
    // about what you are looking at is noise.
    if (window.loomNative && window.loomNative.notify) {
      var nchat = (ev && ev.chat) || "main";
      var here = state.currentChat ? state.currentChat() : "main";
      if (document.hidden || nchat !== here) {
        try {
          window.loomNative.notify({
            title: who + " needs you",
            body: q || "Loom · an agent is waiting on you",
            chat: nchat,
            project: state.pid || null,
            agentId: (ev && ev.agentId) || null
          });
        } catch (e) {}
      }
      return;
    }
    if (document.hidden){
      if (!_titleFlash){ var on = false; _titleFlash = setInterval(function(){
        document.title = (on = !on) ? "\u23f8 " + who + " needs you" : _baseTitle; }, 1100); }
      try {
        if (window.Notification && Notification.permission === "granted"){
          new Notification(who + " needs input", { body: q || "Loom \u00b7 an agent is waiting on you", tag: "loom-needs-input" });
        } else if (window.Notification && Notification.permission === "default"){
          Notification.requestPermission();
        }
      } catch (e) {}
    }
  }
  /**
   * The tab you're not looking at: its title says how many agents are
   * working, and its icon carries the count (or an amber "!" when one is
   * waiting on you). Redrawn only when something changed.
   */
  var _ambient = "";
  function updateAmbient(busy, needs){
    var name = state.project && state.project.name;
    _baseTitle = (needs ? "⏸ " : busy ? "● " + busy + " working · " : "") + (name ? name + " · " : "") + "Loom";
    if (!_titleFlash) document.title = _baseTitle;
    var key = busy + "|" + (needs ? 1 : 0);
    if (key === _ambient) return;
    _ambient = key;
    var link = document.getElementById("favicon");
    // jsdom (the test DOM) has no canvas and says so loudly; a real browser does
    if (!link || /jsdom/i.test(navigator.userAgent || "")) return;
    try {
      var c = document.createElement("canvas"); c.width = 64; c.height = 64;
      var g = c.getContext("2d");
      g.fillStyle = "#0a0a0a";
      g.beginPath();
      if (g.roundRect) g.roundRect(0, 0, 64, 64, 14); else g.rect(0, 0, 64, 64);
      g.fill();
      g.fillStyle = "#fafafa"; g.font = "600 24px -apple-system,Segoe UI,sans-serif"; g.textAlign = "center";
      g.fillText("lo", 32, 38);
      g.fillStyle = "#67e8f9"; g.fillRect(20, 45, 24, 3);
      if (needs || busy) {
        g.beginPath(); g.arc(48, 16, 15, 0, Math.PI * 2);
        g.fillStyle = needs ? "#f59e0b" : "#eab308"; g.fill();
        g.lineWidth = 3; g.strokeStyle = "#0a0a0a"; g.stroke();
        g.fillStyle = "#0a0a0a"; g.font = "800 19px -apple-system,Segoe UI,sans-serif";
        g.fillText(needs ? "!" : busy > 9 ? "9+" : String(busy), 48, 23);
      }
      link.type = "image/png";
      link.href = c.toDataURL("image/png");
    } catch (e) {}
  }
  /**
   * Has a thread got replies this device hasn't seen? A thread never opened
   * here takes its current newest reply as the baseline — a first launch
   * shouldn't light up every chat you ever had.
   */
  function isUnread(pid, c){
    if (!c || !c.lastReplyId) return false;
    var m = {};
    try { m = JSON.parse(localStorage.getItem("loomSeen") || "{}") || {}; } catch (e) { return false; }
    var k = pid + ":" + c.id;
    if (m[k] === undefined) {
      m[k] = c.lastReplyId;
      try { localStorage.setItem("loomSeen", JSON.stringify(m)); } catch (e) {}
      return false;
    }
    return c.lastReplyId > m[k];
  }
  /** Preferences that belong to this device (how it should get your attention). */
  function devicePref(name, fallback){
    try { var v = localStorage.getItem("loomPref:" + name); return v === null ? fallback : v === "1"; } catch (e) { return fallback; }
  }
  function setDevicePref(name, on){ try { localStorage.setItem("loomPref:" + name, on ? "1" : "0"); } catch (e) {} }
  /** A soft two-note chime, made on the spot: no audio file to ship or fetch. */
  function chime(){
    try {
      var AC = window.AudioContext || window.webkitAudioContext; if (!AC) return;
      var ctx = chime.ctx || (chime.ctx = new AC());
      [[660, 0], [880, 0.12]].forEach(function(n){
        var o = ctx.createOscillator(), v = ctx.createGain(), t = ctx.currentTime + n[1];
        o.type = "sine"; o.frequency.value = n[0];
        v.gain.setValueAtTime(0.0001, t); v.gain.exponentialRampToValueAtTime(0.12, t + 0.02); v.gain.exponentialRampToValueAtTime(0.0001, t + 0.35);
        o.connect(v); v.connect(ctx.destination); o.start(t); o.stop(t + 0.4);
      });
    } catch (e) {}
  }
  /**
   * A long turn finished while you were in another window: say who, and the
   * first line of what they said. Short turns don't — you were still here.
   */
  function notifyDone(ev, projectName){
    var p = (ev && ev.payload) || {};
    if (!document.hidden || !devicePref("notifyDone", true)) return;
    if (Number(p.durationMs || 0) < 20000) return;
    var who = labelOf((ev && ev.agentId) || "agent");
    var last = document.querySelectorAll('#feed .msg.agent[data-agent="' + String(ev.agentId || "").replace(/"/g, "") + '"] .bubble');
    var line = last.length ? (last[last.length - 1].innerText || "").trim().split("\n")[0].slice(0, 140) : "";
    var title = who + " finished" + (projectName ? " · " + projectName : "");
    var body = line || ("after " + durfmt(Number(p.durationMs || 0)));
    if (devicePref("chime", false)) chime();
    if (window.loomNative && window.loomNative.notify) {
      try { window.loomNative.notify({ title: title, body: body, chat: (ev && ev.chat) || "main", project: state.pid || null, agentId: (ev && ev.agentId) || null }); } catch (e) {}
      return;
    }
    try {
      if (window.Notification && Notification.permission === "granted") new Notification(title, { body: body, tag: "loom-done-" + (ev.agentId || "") });
    } catch (e) {}
  }
export { _baseTitle,_titleFlash,announce,askConfirm,askText,chime,devicePref,fitMenu,isUnread,modalErr,notifyDone,notifyNeedsInput,setDevicePref,stopTitleFlash,toast,updateAmbient };
var HISTORY_KEY = "loomNotifications:v1";
export function notificationHistory(){
  try { var rows = JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]'); return Array.isArray(rows) ? rows.filter(function(r){ return r && typeof r.text === 'string' && Number.isFinite(r.at); }).slice(0, 100) : []; } catch (e) { return []; }
}
function rememberNotification(msg){
  var rows = notificationHistory();
  rows.unshift({ text: String(msg).slice(0, 2000), at: Date.now(), project: state.pid || null, chat: state.chat || 'main' });
  try { localStorage.setItem(HISTORY_KEY, JSON.stringify(rows.slice(0, 100))); } catch (e) {}
  window.dispatchEvent(new Event('loom-notification'));
}
export function openNotificationHistory(){
  if (document.querySelector('.scrim')) return;
  var scrim = document.createElement('div'); scrim.className = 'scrim';
  scrim.innerHTML = '<div class="modal" role="dialog" aria-modal="true" aria-label="Notification history"><div class="modalhead">Notification history<button class="iconbtn" data-close aria-label="Close">×</button></div><div class="modalbody" style="max-height:60vh;overflow:auto" data-history></div><div class="modalfoot"><button class="btn outline" data-clear>Clear history</button></div></div>';
  document.body.appendChild(scrim);
  function draw(){
    var rows = notificationHistory();
    scrim.querySelector('[data-history]').innerHTML = rows.length ? rows.map(function(r, i){ return '<div class="notification-entry"><time>' + esc(new Date(r.at).toLocaleString()) + '</time><div>' + esc(r.text) + '</div>' + (r.project ? '<button class="btn xs ghost" data-open-notification="' + i + '">Open chat</button>' : '') + '</div>'; }).join('') : '<p>No notifications yet. Messages shown by Loom will appear here.</p>';
    scrim.querySelectorAll('[data-open-notification]').forEach(function(b){ b.onclick = function(){ var r = rows[Number(b.dataset.openNotification)]; close(); location.hash = '#p/' + encodeURIComponent(r.project) + '/c/' + encodeURIComponent(r.chat || 'main'); }; });
  }
  function close(){ scrim.remove(); document.removeEventListener('keydown', key); window.removeEventListener('loom-notification', draw); window.removeEventListener('storage', draw); }
  function key(e){ if (e.key === 'Escape') close(); }
  scrim.querySelector('[data-close]').onclick = close;
  scrim.querySelector('[data-clear]').onclick = function(){ try { localStorage.removeItem(HISTORY_KEY); } catch (e) {} draw(); };
  scrim.onclick = function(e){ if (e.target === scrim) close(); };
  document.addEventListener('keydown', key); window.addEventListener('loom-notification', draw); window.addEventListener('storage', draw);
  draw(); scrim.querySelector('[data-close]').focus();
}
