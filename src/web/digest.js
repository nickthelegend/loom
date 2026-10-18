/** Browser digest module. See README.md for ownership and startup. */
import { api } from './connection.js';
import { esc } from './format.js';
import { ICONS } from './icons.js';
import { state } from './state.js';


  /**
   * What happened while you were away.
   *
   * Only when you've actually been away — coming back to a project you had
   * open a minute ago doesn't need a summary of the minute. The mark is per
   * device, because "when did you last look" is a fact about this window and
   * nowhere else.
   */
  function maybeDigest(pid){
    var key = "loomSeen:" + pid;
    var since = 0;
    try { since = Number(localStorage.getItem(key)) || 0; } catch (e) {}
    var mark = function(){ try { localStorage.setItem(key, String(Date.now())); } catch (e) {} };
    if (!since || Date.now() - since < 30 * 60000) return mark();
    api("/api/projects/" + pid + "/digest?since=" + since).then(function(d){
      mark();
      // a total with nothing behind it ("1 turn") isn't worth a dialog
      if (!d || !d.lines || !d.lines.some(function(l){ return l.kind !== "cost"; })) return;
      // you've moved on to another project while this was loading: its digest isn't about where you are (#293)
      if (state.pid !== pid) return;
      showDigest(d, since, pid);
    }).catch(function(){ mark(); });
  }


  /** The digest itself: sentences, newest first, each one clickable. */
  function showDigest(d, since, pid){
    if (document.querySelector(".scrim")) return;
    var hours = Math.max(1, Math.round((Date.now() - since) / 3600000));
    var proj = (state.projects || []).filter(function(p){ return p.id === (pid || state.pid); })[0];
    // a stretch that crosses midnight says which day each moment was
    var day = function(t){ return new Date(t).toDateString(); };
    var spansDays = d.lines.some(function(l){ return l.kind !== "cost" && l.at && day(l.at) !== day(Date.now()); });
    var scrim = document.createElement("div");
    scrim.className = "scrim";
    var rows = d.lines.map(function(l){
      // the totals row sums the whole stretch: it has no moment of its own
      var when = l.kind === "cost" ? "in all" : (spansDays ? new Date(l.at).toLocaleDateString([], { month: "short", day: "numeric" }) + " " : "") +
        new Date(l.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) + "";
      return '<div class="dgrow ' + esc(l.kind) + '"' + (l.chat ? ' data-dgchat="' + esc(l.chat) + '"' : "") + '>' +
        '<span class="dgt">' + esc(when) + "</span><span>" + esc(l.text) + (l.count > 1 ? ' <span class="dgn">\u00d7' + l.count + "</span>" : "") + "</span></div>";
    }).join("");
    scrim.innerHTML = '<div class="modal digest" role="dialog" aria-modal="true"><div class="modalhead">While you were away' + (proj ? ' \u00b7 ' + esc(proj.name) : "") +
      '<button class="iconbtn" id="dgclose" aria-label="close">' + ICONS.x + "</button></div>" +
      '<div class="dgsub">the last ' + hours + " hour" + (hours === 1 ? "" : "s") +
      (d.waiting && d.waiting.length ? ' · <b class="warn">waiting on you: ' + esc(d.waiting.join(", ")) + "</b>" : "") + "</div>" +
      '<div class="dglist">' + rows + "</div></div>";
    document.body.appendChild(scrim);
    var onKey = function(ev){ if (ev.key === "Escape") { ev.preventDefault(); close(); } };
    var close = function(){ scrim.remove(); document.removeEventListener("keydown", onKey, true); };
    document.addEventListener("keydown", onKey, true);
    scrim.addEventListener("click", function(ev){ if (ev.target === scrim) close(); });
    document.getElementById("dgclose").onclick = close;
    Array.prototype.forEach.call(scrim.querySelectorAll("[data-dgchat]"), function(row){
      row.onclick = function(){
        var chat = row.getAttribute("data-dgchat");
        close();
        if (state.setChat) state.setChat(state.pid, chat);
        if (state.showTab) state.showTab("thread");
      };
    });
  }
export { maybeDigest,showDigest };
