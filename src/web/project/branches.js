/**
 * Branches in a chat (#375): editing a prompt or retrying a reply makes a sibling branch instead of
 * appending a new turn, and a ‹ n/m › pager under the message switches between them. The thread
 * shows the active branch's history; files stay as they are unless you choose to rewind them,
 * after seeing what that would change.
 *
 * Approach after Agent Orchestrator's conversation branches (Apache-2.0).
 */
import { api } from '../connection.js';
import { esc } from '../format.js';
import { askConfirm, askText, toast } from '../notifications.js';
import { state } from '../state.js';

export function createBranches(view){
  var listing = null; // { branches, active, siblingsByEventId }

  function base(){ return "/api/projects/" + view.pid + "/chats/" + encodeURIComponent(view.chatId || "main") + "/branches"; }

  /** Which choice of `choices` the active branch descends from (the original is its parent's id). */
  function currentIndex(choices){
    if (!listing) return 0;
    var byId = {}; (listing.branches || []).forEach(function(b){ byId[b.id] = b; });
    var id = listing.active, seen = {};
    while (id != null && !seen[id]) {
      seen[id] = true;
      var at = choices.indexOf(id);
      if (at >= 0) return at;
      id = byId[id] ? byId[id].parent : null;
    }
    return 0;
  }

  function drawPagers(){
    var feed = document.getElementById("feed"); if (!feed) return;
    Array.prototype.forEach.call(feed.querySelectorAll(".brpager"), function(p){ p.remove(); });
    if (!listing || !listing.siblingsByEventId) return;
    Object.keys(listing.siblingsByEventId).forEach(function(eventId){
      var choices = listing.siblingsByEventId[eventId] || [];
      if (choices.length < 2) return;
      var msg = feed.querySelector('.msg[data-id="' + eventId + '"]'); if (!msg) return;
      var i = currentIndex(choices);
      var pager = document.createElement("div");
      pager.className = "brpager";
      pager.setAttribute("role", "group");
      pager.setAttribute("aria-label", "versions of this message");
      pager.innerHTML = '<button type="button" data-br="' + esc(choices[(i - 1 + choices.length) % choices.length]) + '"' + (i === 0 ? " disabled" : "") + ' aria-label="previous version">‹</button>' +
        '<span class="brn">' + (i + 1) + "/" + choices.length + "</span>" +
        '<button type="button" data-br="' + esc(choices[(i + 1) % choices.length]) + '"' + (i === choices.length - 1 ? " disabled" : "") + ' aria-label="next version">›</button>';
      msg.appendChild(pager);
    });
    Array.prototype.forEach.call(feed.querySelectorAll(".brpager [data-br]"), function(b){
      b.onclick = function(ev){ ev.preventDefault(); ev.stopPropagation(); activate(b.getAttribute("data-br")); };
    });
  }

  function load(){
    var chat = view.chatId || "main";
    return api(base()).then(function(j){
      if ((view.chatId || "main") !== chat) return;
      listing = j; drawPagers();
    }).catch(function(){ listing = null; });
  }

  function reloadThread(){
    var p = state.loadHistory ? state.loadHistory() : null;
    return Promise.resolve(p).then(load);
  }

  /**
   * Switch to a branch. History only, by default — then, if files differ at that point, ask whether
   * to rewind them too, saying how many would change.
   */
  function activate(branchId){
    api(base() + "/" + encodeURIComponent(branchId) + "/activate", { method: "POST", body: "{}" })
      .then(reloadThread)
      .then(function(){ return api(base() + "/" + encodeURIComponent(branchId) + "/rewind").catch(function(){ return null; }); })
      .then(function(pre){
        var changed = (pre && pre.changed) || [];
        if (!changed.length) return;
        return askConfirm("Rewind files to this version too?\n\n" + changed.length + " file" + (changed.length === 1 ? "" : "s") + " would change: " + changed.slice(0, 6).join(", ") + (changed.length > 6 ? "…" : "") + "\n\nWithout this, only the conversation switches.", { ok: "Rewind files" })
          .then(function(ok){
            if (!ok) return;
            return api(base() + "/" + encodeURIComponent(branchId) + "/activate", { method: "POST", body: JSON.stringify({ rewindFiles: true }) })
              .then(function(r){ toast("files rewound · " + (((r && r.rewind && r.rewind.changed) || []).length) + " changed"); });
          });
      })
      .catch(function(err){ toast(err.message); });
  }

  /** ✎ on your message: a new version of it, as a sibling — the original stays one arrow away. */
  function editAsBranch(msgEl, raw){
    var id = Number(msgEl && msgEl.getAttribute("data-id")) || 0;
    if (!id) return false;
    askText("Edit your message", { value: raw, ok: "Send as a new version", multiline: true, required: true }).then(function(text){
      if (text === null || !text.trim() || text.trim() === raw.trim()) return;
      api(base(), { method: "POST", body: JSON.stringify({ fromEventId: id, mode: "edit", text: text.trim() }) })
        .then(function(){ toast("sent as a new version · ‹ › switches back"); return reloadThread(); })
        .catch(function(err){ toast(err.message); });
    });
    return true;
  }

  /** Retry on a reply: the same prompt again, as a sibling of that reply. */
  function retryAsBranch(msgEl){
    var id = Number(msgEl && msgEl.getAttribute("data-id")) || 0;
    if (!id) return false;
    api(base(), { method: "POST", body: JSON.stringify({ fromEventId: id, mode: "retry" }) })
      .then(function(){ toast("retrying as a new version · ‹ › compares them"); return reloadThread(); })
      .catch(function(err){ toast(err.message); });
    return true;
  }

  return { load: load, drawPagers: drawPagers, editAsBranch: editAsBranch, retryAsBranch: retryAsBranch, activate: activate };
}
