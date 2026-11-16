import assert from "node:assert/strict";
import { test } from "node:test";
import { tokenizeLine } from "../src/code-model.ts";

const kinds = (line: string, ext = "ts") => tokenizeLine(line, ext).tokens.map((t) => [t.kind, t.text]);

test("colours keywords, strings, numbers and a trailing comment, and keeps every character", () => {
  const line = 'const n = 42; // the answer "x"';
  const toks = tokenizeLine(line, "ts").tokens;
  assert.equal(toks.map((t) => t.text).join(""), line);
  assert.deepEqual(toks.filter((t) => t.kind !== "plain").map((t) => [t.kind, t.text]), [
    ["keyword", "const"], ["number", "42"], ["comment", "// the answer \"x\""],
  ]);
});
test("a string with an escaped quote stays one string", () => {
  assert.deepEqual(kinds('"a\\"b" + 1').filter(([k]) => k === "string"), [["string", '"a\\"b"']]);
});
test("Python comments start with #", () => {
  assert.deepEqual(kinds("x = 1  # one", "py").at(-1), ["comment", "# one"]);
});
test("a block comment carries to the next line", () => {
  const a = tokenizeLine("code(); /* start", "js");
  assert.equal(a.inBlock, true);
  const b = tokenizeLine("still */ after", "js", true);
  assert.equal(b.inBlock, false);
  assert.deepEqual(b.tokens[0], { kind: "comment", text: "still */" });
});
test("digits inside a name aren't numbers", () => {
  assert.equal(kinds("v2 = x1").some(([k]) => k === "number"), false);
});
