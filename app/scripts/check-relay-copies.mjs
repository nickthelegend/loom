#!/usr/bin/env node
/**
 * The app carries copies of the daemon's relay files (src/core/relay-*.ts).
 * They must stay logically identical: the only allowed differences are the
 * "COPY of …" header and import specifiers (the app drops the `.js` suffix).
 *
 *   node app/scripts/check-relay-copies.mjs
 *
 * Exits 1 and prints the first differing line when they drift.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..", "..");

const PAIRS = [
  ["src/core/relay-protocol.ts", "app/src/relay-protocol.ts"],
  ["src/core/relay-client.ts", "app/src/relay-client.ts"],
];

/** Drop the copy's header: the leading `//` comment block and the blank line after it. */
function stripCopyHeader(src) {
  const lines = src.split("\n");
  let i = 0;
  if (!/^\/\/ COPY of /.test(lines[0] ?? "")) throw new Error("copy is missing its 'COPY of' header");
  while (i < lines.length && lines[i].startsWith("//")) i++;
  if (lines[i] === "") i++;
  return lines.slice(i).join("\n");
}

/** Import lines are allowed to differ, so they are not compared. */
const isImportLine = (l) => /^\s*import\s/.test(l) || /^\s*\}?\s*from\s+["']/.test(l) || /\sfrom\s+["'][^"']+["'];?\s*$/.test(l);

function comparable(src) {
  return src.split("\n").filter((l) => !isImportLine(l));
}

let failed = false;
for (const [origRel, copyRel] of PAIRS) {
  const orig = fs.readFileSync(path.join(repo, origRel), "utf8");
  const copy = stripCopyHeader(fs.readFileSync(path.join(repo, copyRel), "utf8"));
  const a = comparable(orig);
  const b = comparable(copy);
  try {
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      assert.equal(b[i], a[i], `${copyRel} differs from ${origRel} at non-import line ${i + 1}`);
    }
    // The import lines themselves may only differ by a `.js` suffix on relative specifiers.
    const imports = (s) =>
      s.split("\n").filter(isImportLine).map((l) => l.replace(/(["']\.{1,2}\/[^"']+?)\.js(["'])/g, "$1$2"));
    assert.deepEqual(imports(copy), imports(orig), `${copyRel} imports something ${origRel} doesn't`);
    console.log(`ok   ${copyRel} == ${origRel} (${a.length} lines compared, imports excluded)`);
  } catch (err) {
    failed = true;
    console.error(`FAIL ${err.message}`);
  }
}
process.exit(failed ? 1 : 0);
