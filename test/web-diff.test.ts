// @vitest-environment jsdom
/**
 * The Changes pane's diff cards, rendered from a working-tree patch: what a
 * new file looks like, since the patch now carries new files' content.
 */

import { beforeAll, describe, expect, it } from "vitest";

// a browser module: its imports read storage when they load
let renderDiffFiles: (t: { patch: string }) => string;
let splitPatch: (p: string) => Array<{ path: string; binary?: boolean }>;
beforeAll(async () => {
  const mem = new Map<string, string>();
  (globalThis as { localStorage?: unknown }).localStorage ??= {
    getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v), removeItem: (k: string) => void mem.delete(k),
  };
  window.matchMedia ??= ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} })) as unknown as typeof window.matchMedia;
  // @ts-expect-error — plain JS
  ({ renderDiffFiles, splitPatch } = await import("../src/web/diff.js"));
});

const patch = [
  "diff --git a/app.js b/app.js",
  "index 3c3629e..4fdb29a 100644",
  "--- a/app.js",
  "+++ b/app.js",
  "@@ -1 +1,2 @@",
  " one",
  "+two",
  "diff --git a/new.txt b/new.txt",
  "new file mode 100644",
  "--- /dev/null",
  "+++ b/new.txt",
  "@@ -0,0 +1,1 @@",
  "+hello",
  "?? new file: shot.png (binary)",
  "?? new file: blob.bin (binary)",
].join("\n");

describe("the Changes pane's diff cards", () => {
  it("names a binary new file by its path, not with the note glued on", () => {
    const files = splitPatch(patch);
    expect(files.map((f) => f.path)).toEqual(["app.js", "new.txt", "shot.png", "blob.bin"]);
    expect(files[2]!.binary).toBe(true);
  });

  it("shows a new image as the image, a new binary as a note, and drops git's header lines", () => {
    const html = renderDiffFiles({ patch });
    expect(html).toContain('<img data-projimg="shot.png"');
    expect(html).toContain("new binary file");
    expect(html).toContain("hello"); // the new text file's content is there
    expect(html).not.toContain("new file mode");
    expect(html).not.toContain("--- /dev/null");
    expect(html).not.toContain("index 3c3629e");
  });
});
