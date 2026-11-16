import assert from "node:assert/strict";
import { test } from "node:test";
import { applyTermChunk, TERM_KEYS } from "../src/term-model.ts";

test("strips colour and keeps the text a terminal would show", () => {
  assert.deepEqual(applyTermChunk([], "\x1b[32m✓\x1b[0m tests pass\n$ "), ["✓ tests pass", "$ "]);
});
test("a carriage return redraws the line, as a progress bar does", () => {
  assert.deepEqual(applyTermChunk([], "10%\r55%\r100%\n"), ["100%", ""]);
});
test("backspace moves back and the next character overwrites", () => {
  assert.deepEqual(applyTermChunk([], "lx\bs\n"), ["ls", ""]);
});
test("chunks continue the last line", () => {
  const a = applyTermChunk([], "npm te");
  assert.deepEqual(applyTermChunk(a, "st\nok"), ["npm test", "ok"]);
});
test("keeps only the newest lines", () => {
  const lines = applyTermChunk([], Array.from({ length: 30 }, (_, i) => `l${i}`).join("\n"), 10);
  assert.equal(lines.length, 10);
  assert.equal(lines[9], "l29");
});
test("drops window-title escapes", () => {
  assert.deepEqual(applyTermChunk([], "\x1b]0;~/loom\x07ok"), ["ok"]);
});
test("Ctrl-C is ETX and the arrows are cursor keys", () => {
  assert.equal(TERM_KEYS["Ctrl-C"], "\x03");
  assert.equal(TERM_KEYS["↑"], "\x1b[A");
});
