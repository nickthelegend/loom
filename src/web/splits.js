/**
 * The split workspace's layout: a tree of panes, split in rows (side by side) or columns (one
 * above the other). Pure functions — the workspace (workspace.js) renders it.
 *
 * Ported from Nuphos, apps/desktop/src/app/workspace/splitLayout.ts
 * (https://github.com/nuphos/nuphos), Copyright 2026 Zeabur Inc., Apache License 2.0.
 * "This product includes software developed at Zeabur Inc."
 * Changes for Loom: TypeScript → JavaScript; Loom's own drag types; panes carry what they show
 * (a project and chat) beside the tree; the layout is saved per window; ⌘-click reuse and the
 * focus helpers were left out.
 */

/** @typedef {{ id: string } | { direction: "row" | "column", children: Layout[] }} Layout */

export function splitPane(layout, target, id, direction, before) {
  if ("id" in layout) {
    if (layout.id !== target) return layout;
    return { direction: direction, children: before ? [{ id: id }, layout] : [layout, { id: id }] };
  }
  // Repeating a direction adds an equal-sized sibling rather than halving again.
  if (layout.direction === direction && layout.children.some(function(c){ return "id" in c && c.id === target; })) {
    var children = layout.children.slice();
    children.splice(children.findIndex(function(c){ return "id" in c && c.id === target; }) + (before ? 0 : 1), 0, { id: id });
    return { direction: layout.direction, children: children };
  }
  return { direction: layout.direction, children: layout.children.map(function(c){ return splitPane(c, target, id, direction, before); }) };
}

export function removePane(layout, id) {
  if ("id" in layout) return layout.id === id ? null : layout;
  var children = layout.children.map(function(c){ return removePane(c, id); }).filter(Boolean);
  if (!children.length) return null;
  return children.length === 1 ? children[0] : { direction: layout.direction, children: children };
}

/** Private drag types, so the overlay ignores files and text. */
export var CHAT_DRAG_TYPE = "application/x-loom-chat";
export var PANE_DRAG_TYPE = "application/x-loom-pane";

/** Edge bands a quarter deep split that side; the middle swaps (a pane) or opens there (a chat). */
export function dropZone(x, y) {
  var edges = [["left", x], ["right", 1 - x], ["top", y], ["bottom", 1 - y]];
  var best = edges.reduce(function(a, b){ return b[1] < a[1] ? b : a; });
  return best[1] < 0.25 ? best[0] : "center";
}

export function hasPane(layout, id) {
  return "id" in layout ? layout.id === id : layout.children.some(function(c){ return hasPane(c, id); });
}

export function swapPanes(layout, a, b) {
  if ("id" in layout) return layout.id === a ? { id: b } : layout.id === b ? { id: a } : layout;
  return { direction: layout.direction, children: layout.children.map(function(c){ return swapPanes(c, a, b); }) };
}

/** Put `id` on `zone`'s side of `target`, out of its old spot first; the centre swaps two shown panes. */
export function dropPane(layout, target, id, zone) {
  if (id === target) return layout;
  if (zone === "center") return hasPane(layout, id) ? swapPanes(layout, target, id) : layout;
  var rest = removePane(layout, id) || layout;
  return splitPane(rest, target, id, zone === "left" || zone === "right" ? "row" : "column", zone === "left" || zone === "top");
}

/** The tree as flat rectangles, in percent of the workspace. */
export function paneRects(layout, rect) {
  rect = rect || { left: 0, top: 0, width: 100, height: 100 };
  if ("id" in layout) return [{ id: layout.id, left: rect.left, top: rect.top, width: rect.width, height: rect.height }];
  var n = layout.children.length, row = layout.direction === "row";
  return layout.children.flatMap(function(c, i){
    return paneRects(c, {
      left: rect.left + (row ? (i * rect.width) / n : 0),
      top: rect.top + (row ? 0 : (i * rect.height) / n),
      width: row ? rect.width / n : rect.width,
      height: row ? rect.height : rect.height / n,
    });
  });
}

export function leafIds(layout) {
  return "id" in layout ? [layout.id] : layout.children.flatMap(leafIds);
}

/** ⌘D on a Mac, Ctrl+D elsewhere — never while composing text, never with Alt. */
export function isSplitShortcut(e, mac) {
  return (mac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey) && !e.altKey && e.code === "KeyD" && !e.isComposing;
}

// ── saved per window ──

var KEY = "loomSplit:v1";

/** { layout, panes: { [id]: { hash } }, focus } or null. */
export function loadWorkspace() {
  try {
    var w = JSON.parse(localStorage.getItem(KEY) || "null");
    if (!w || !w.layout || !w.panes) return null;
    var ids = leafIds(w.layout);
    if (!ids.length || ids.some(function(id){ return !w.panes[id]; })) return null;
    return w;
  } catch (e) { return null; }
}

export function saveWorkspace(w) {
  try { if (w) localStorage.setItem(KEY, JSON.stringify(w)); else localStorage.removeItem(KEY); } catch (e) {}
}

var seq = 0;
export function newPaneId() { return "pane-" + Date.now().toString(36) + "-" + (seq++); }
