/**
 * The split workspace: several Loom views in one window — ⌘D splits side by side, ⌘⇧D one above
 * the other; drag a chat from a pane's sidebar onto another pane's edge to open it there, or a
 * pane by its grip to move it. Approach credit: Nuphos (Apache-2.0, © Zeabur Inc.); the layout
 * model is ported from it (splits.js).
 *
 * Each pane is the whole Loom app in "pane mode" in a same-origin frame (/app?pane=<id>#…): the
 * app is written for one live view per page, and a frame gives every pane its own. Panes keep
 * their frame when the layout changes shape — only the frame's box moves — so a split never
 * reloads what you were looking at. The layout is saved; the last pane closed leaves split mode.
 *
 * Panes talk to the workspace with postMessage ({ loom: "pane", id, type, … }), same origin only.
 */

import { CHAT_DRAG_TYPE, PANE_DRAG_TYPE, dropPane, dropZone, isSplitShortcut, leafIds, loadWorkspace, newPaneId, paneRects, removePane, saveWorkspace, splitPane } from "./splits.js";

var MAC = /Mac|iPhone|iPad/.test(navigator.platform || "");

var commandHere = null;
/** A menu command arriving at the workspace window: splits are its own, the rest go to the focused pane. */
export function workspaceCommand(item) { if (commandHere) commandHere(item); }

export function inWorkspace() { return /[?&]split=1(&|$)/.test(location.search); }
export function paneId() { var m = /[?&]pane=([\w-]+)/.exec(location.search); return m ? m[1] : null; }

/** From a normal window: split the current view into two panes. */
export function enterWorkspace(dir) {
  var hash = location.hash || "";
  var a = newPaneId(), b = newPaneId();
  saveWorkspace({ layout: { direction: dir || "row", children: [{ id: a }, { id: b }] }, panes: { [a]: { hash: hash }, [b]: { hash: hash } }, focus: b });
  location.href = "/app?split=1";
}

export function renderWorkspace() {
  var w = loadWorkspace();
  if (!w) { var id0 = newPaneId(); w = { layout: { id: id0 }, panes: { [id0]: { hash: "" } }, focus: id0 }; }
  document.documentElement.classList.add("workspace");
  document.body.innerHTML = '<div class="wsroot" id="wsroot"></div><div class="wsdrop" id="wsdrop" hidden><div class="wszone" id="wszone"></div></div>';
  var rootEl = document.getElementById("wsroot"), drop = document.getElementById("wsdrop"), zoneEl = document.getElementById("wszone");
  var els = {};
  var dragging = null; // { kind: "chat", hash } | { kind: "pane", id }

  function save() { saveWorkspace(w); }
  function src(id) { return "/app?pane=" + encodeURIComponent(id) + (w.panes[id].hash || ""); }

  function draw() {
    var rects = paneRects(w.layout), live = {};
    rects.forEach(function(r){
      live[r.id] = true;
      var el = els[r.id];
      if (!el) {
        el = document.createElement("section");
        el.className = "wspane";
        el.dataset.pane = r.id;
        el.innerHTML = '<header class="wshead"><span class="wsgrip" draggable="true" title="Drag to move this pane">⠇</span>' +
          '<span class="wstitle"></span><button class="wsbtn" data-act="row" title="Split right (' + (MAC ? "⌘" : "Ctrl+") + 'D)">◫</button>' +
          '<button class="wsbtn" data-act="column" title="Split down (' + (MAC ? "⌘⇧" : "Ctrl+Shift+") + 'D)">⬒</button>' +
          '<button class="wsbtn" data-act="close" title="Close pane">×</button></header>' +
          '<iframe class="wsframe" title="Loom pane"></iframe>';
        el.querySelector("iframe").src = src(r.id);
        el.querySelector(".wstitle").textContent = w.panes[r.id].title || "Loom";
        el.addEventListener("click", function(e){
          var b = e.target.closest && e.target.closest(".wsbtn");
          if (!b) return;
          var act = b.getAttribute("data-act");
          if (act === "close") close(r.id); else split(r.id, act);
        });
        el.addEventListener("mousedown", function(){ focus(r.id); });
        var grip = el.querySelector(".wsgrip");
        grip.addEventListener("dragstart", function(e){
          e.dataTransfer.setData(PANE_DRAG_TYPE, r.id);
          e.dataTransfer.effectAllowed = "move";
          // covering the drag source during dragstart cancels the drag in Chromium: next tick
          setTimeout(function(){ startDrag({ kind: "pane", id: r.id }); }, 0);
        });
        grip.addEventListener("dragend", endDrag);
        rootEl.appendChild(el);
        els[r.id] = el;
      }
      el.style.left = r.left + "%"; el.style.top = r.top + "%"; el.style.width = r.width + "%"; el.style.height = r.height + "%";
      el.classList.toggle("focused", w.focus === r.id);
    });
    Object.keys(els).forEach(function(id){ if (!live[id]) { els[id].remove(); delete els[id]; } });
  }

  function focus(id) { if (w.focus === id) return; w.focus = id; save(); draw(); }

  function split(target, dir, hash, before) {
    var id = newPaneId();
    w.panes[id] = { hash: hash !== undefined ? hash : (w.panes[target] || {}).hash || "" };
    w.layout = splitPane(w.layout, target, id, dir, before);
    w.focus = id;
    save(); draw();
  }

  function close(id) {
    var next = removePane(w.layout, id);
    delete w.panes[id];
    if (!next) { saveWorkspace(null); location.href = "/app"; return; }
    w.layout = next;
    var left = leafIds(next);
    if (left.length === 1) {
      // one pane is just a window: leave split mode where that pane was
      var hash = w.panes[left[0]].hash || "";
      saveWorkspace(null);
      location.href = "/app" + hash;
      return;
    }
    if (!w.panes[w.focus]) w.focus = left[0];
    save(); draw();
  }

  // ── dragging a chat or a pane onto a pane's edge ──

  function startDrag(d) { dragging = d; drop.hidden = false; }
  function endDrag() { dragging = null; drop.hidden = true; zoneEl.style.display = "none"; }

  function hit(e) {
    var box = rootEl.getBoundingClientRect();
    var x = ((e.clientX - box.left) / box.width) * 100, y = ((e.clientY - box.top) / box.height) * 100;
    var r = paneRects(w.layout).find(function(p){ return x >= p.left && x < p.left + p.width && y >= p.top && y < p.top + p.height; });
    if (!r) return null;
    return { rect: r, zone: dropZone((x - r.left) / r.width, (y - r.top) / r.height) };
  }

  drop.addEventListener("dragover", function(e){
    if (!dragging) return;
    e.preventDefault();
    var h = hit(e);
    if (!h) { zoneEl.style.display = "none"; return; }
    var r = h.rect, z = h.zone, l = r.left, t = r.top, wd = r.width, ht = r.height;
    if (z === "left") wd /= 2; else if (z === "right") { l += wd / 2; wd /= 2; } else if (z === "top") ht /= 2; else if (z === "bottom") { t += ht / 2; ht /= 2; }
    zoneEl.style.display = "block";
    zoneEl.style.left = l + "%"; zoneEl.style.top = t + "%"; zoneEl.style.width = wd + "%"; zoneEl.style.height = ht + "%";
  });
  drop.addEventListener("dragleave", function(e){ if (e.target === drop) zoneEl.style.display = "none"; });
  drop.addEventListener("drop", function(e){
    e.preventDefault();
    var d = dragging, h = hit(e);
    endDrag();
    if (!d || !h) return;
    if (d.kind === "pane") { w.layout = dropPane(w.layout, h.rect.id, d.id, h.zone); save(); draw(); return; }
    var hash = d.hash || e.dataTransfer.getData(CHAT_DRAG_TYPE);
    if (!hash) return;
    if (h.zone === "center") {
      // open the chat in that pane
      w.panes[h.rect.id] = { hash: hash };
      var f = els[h.rect.id] && els[h.rect.id].querySelector("iframe");
      if (f) f.src = src(h.rect.id);
      save();
      return;
    }
    split(h.rect.id, h.zone === "left" || h.zone === "right" ? "row" : "column", hash, h.zone === "left" || h.zone === "top");
  });
  window.addEventListener("dragend", endDrag);

  // ── what panes say ──

  window.addEventListener("message", function(e){
    if (e.origin !== location.origin) return;
    var m = e.data;
    if (!m || m.loom !== "pane" || !w.panes[m.id]) return;
    if (m.type === "split") split(m.id, m.dir === "column" ? "column" : "row");
    else if (m.type === "close") close(m.id);
    else if (m.type === "focus") focus(m.id);
    else if (m.type === "at") {
      var p = w.panes[m.id];
      if (typeof m.hash === "string") p.hash = m.hash;
      if (typeof m.title === "string" && m.title) { p.title = m.title; var t = els[m.id] && els[m.id].querySelector(".wstitle"); if (t) t.textContent = m.title; }
      save();
    } else if (m.type === "drag" && typeof m.hash === "string") startDrag({ kind: "chat", hash: m.hash });
    else if (m.type === "dragend") endDrag();
  });

  document.addEventListener("keydown", function(e){
    if (isSplitShortcut(e, MAC)) { e.preventDefault(); split(w.focus, e.shiftKey ? "column" : "row"); }
  });

  commandHere = function(item){
    if (item === "split-right" || item === "split-down") return split(w.focus, item === "split-down" ? "column" : "row");
    var f = els[w.focus] && els[w.focus].querySelector("iframe");
    if (f && f.contentWindow) f.contentWindow.postMessage({ loom: "command", item: item }, location.origin);
  };

  save();
  draw();
}

/** In a pane: tell the workspace where we are, and hand it ⌘D, focus and chat drags. */
export function installPaneMode(state, runCommand) {
  var id = paneId();
  if (!id || window.parent === window) return;
  // the window's menu reaches the workspace; it hands this pane what's meant for it
  window.addEventListener("message", function(e){
    if (e.origin === location.origin && e.source === window.parent && e.data && e.data.loom === "command" && typeof e.data.item === "string") runCommand(e.data.item);
  });
  document.documentElement.classList.add("inpane", "nosidebar");
  var say = function(msg){ try { window.parent.postMessage(Object.assign({ loom: "pane", id: id }, msg), location.origin); } catch (e) {} };
  document.addEventListener("keydown", function(e){
    if (isSplitShortcut(e, MAC)) { e.preventDefault(); e.stopPropagation(); say({ type: "split", dir: e.shiftKey ? "column" : "row" }); }
  }, true);
  window.addEventListener("focus", function(){ say({ type: "focus" }); });
  document.addEventListener("mousedown", function(){ say({ type: "focus" }); }, true);
  var last = "";
  setInterval(function(){
    var chat = state.currentChat ? state.currentChat() : null;
    var hash = state.pid ? "#p/" + state.pid + (chat ? "/c/" + encodeURIComponent(chat) : "") : location.hash;
    var title = document.title || "Loom";
    var key = hash + "\u0000" + title;
    if (key !== last) { last = key; say({ type: "at", hash: hash, title: title }); }
  }, 1200);
  document.addEventListener("dragstart", function(e){
    var row = e.target.closest && e.target.closest(".crow[data-p][data-chat]");
    if (!row) return;
    var hash = "#p/" + row.getAttribute("data-p") + "/c/" + encodeURIComponent(row.getAttribute("data-chat"));
    e.dataTransfer.setData(CHAT_DRAG_TYPE, hash);
    say({ type: "drag", hash: hash });
  });
  document.addEventListener("dragend", function(){ say({ type: "dragend" }); });
}

/** Chat rows can be dragged (onto a pane's edge, in the workspace). */
export function makeChatsDraggable() {
  new MutationObserver(function(){
    var rows = document.querySelectorAll(".crow[data-p][data-chat]:not([draggable])");
    for (var i = 0; i < rows.length; i++) rows[i].setAttribute("draggable", "true");
  }).observe(document.body, { childList: true, subtree: true });
}
