/** The split workspace's layout model (src/web/splits.js, ported from Nuphos's splitLayout.ts). */

import { describe, expect, it } from "vitest";
// @ts-expect-error — plain JS module from the web client
import { dropPane, dropZone, isSplitShortcut, leafIds, paneRects, removePane, splitPane } from "../src/web/splits.js";

describe("split layout", () => {
  it("splits, adds an equal sibling in the same direction, and nests across directions", () => {
    let l = splitPane({ id: "a" }, "a", "b", "row", false);
    expect(l).toEqual({ direction: "row", children: [{ id: "a" }, { id: "b" }] });
    l = splitPane(l, "b", "c", "row", false);
    expect(l).toEqual({ direction: "row", children: [{ id: "a" }, { id: "b" }, { id: "c" }] });
    l = splitPane(l, "c", "d", "column", true);
    expect(l).toEqual({ direction: "row", children: [{ id: "a" }, { id: "b" }, { direction: "column", children: [{ id: "d" }, { id: "c" }] }] });
    expect(leafIds(l)).toEqual(["a", "b", "d", "c"]);
  });

  it("removing a pane collapses a split left with one child", () => {
    const l = { direction: "row", children: [{ id: "a" }, { direction: "column", children: [{ id: "b" }, { id: "c" }] }] };
    expect(removePane(l, "b")).toEqual({ direction: "row", children: [{ id: "a" }, { id: "c" }] });
    expect(removePane(removePane(l, "b"), "c")).toEqual({ id: "a" });
    expect(removePane({ id: "a" }, "a")).toBeNull();
  });

  it("lays panes out as percentages", () => {
    const rects = paneRects({ direction: "row", children: [{ id: "a" }, { direction: "column", children: [{ id: "b" }, { id: "c" }] }] });
    expect(rects).toEqual([
      { id: "a", left: 0, top: 0, width: 50, height: 100 },
      { id: "b", left: 50, top: 0, width: 50, height: 50 },
      { id: "c", left: 50, top: 50, width: 50, height: 50 },
    ]);
  });

  it("drop zones: a quarter-deep band per edge, the middle is centre; dropping moves or swaps a pane", () => {
    expect(dropZone(0.1, 0.5)).toBe("left");
    expect(dropZone(0.95, 0.5)).toBe("right");
    expect(dropZone(0.5, 0.05)).toBe("top");
    expect(dropZone(0.5, 0.9)).toBe("bottom");
    expect(dropZone(0.5, 0.5)).toBe("center");
    const l = { direction: "row", children: [{ id: "a" }, { id: "b" }, { id: "c" }] };
    expect(dropPane(l, "a", "c", "top")).toEqual({ direction: "row", children: [{ direction: "column", children: [{ id: "c" }, { id: "a" }] }, { id: "b" }] });
    expect(dropPane(l, "a", "c", "center")).toEqual({ direction: "row", children: [{ id: "c" }, { id: "b" }, { id: "a" }] });
    expect(dropPane(l, "a", "a", "left")).toBe(l);
  });

  it("⌘D on a Mac, Ctrl+D elsewhere; never with Alt or mid-composition", () => {
    const k = (o: Record<string, unknown>) => ({ metaKey: false, ctrlKey: false, altKey: false, code: "KeyD", isComposing: false, ...o });
    expect(isSplitShortcut(k({ metaKey: true }), true)).toBe(true);
    expect(isSplitShortcut(k({ ctrlKey: true }), true)).toBe(false);
    expect(isSplitShortcut(k({ ctrlKey: true }), false)).toBe(true);
    expect(isSplitShortcut(k({ metaKey: true, altKey: true }), true)).toBe(false);
    expect(isSplitShortcut(k({ metaKey: true, isComposing: true }), true)).toBe(false);
  });
});
