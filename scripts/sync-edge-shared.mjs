#!/usr/bin/env node
/**
 * The hosted hub's Edge Functions (Deno) run copies of a few self-contained
 * files from src/core. This writes the copies; test/github-events.test.ts
 * fails when a copy drifts from its original.
 *
 *   node scripts/sync-edge-shared.mjs
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const EDGE_COPIES = [["src/core/github-events.ts", "supabase/functions/_shared/github-events.ts"]];

export function header(orig) {
  return [
    `// COPY of ${orig} for the Edge Functions (Deno). Don't edit it here: edit the`,
    "// original, then run `node scripts/sync-edge-shared.mjs` (test/github-events.test.ts checks).",
    "",
  ].join("\n");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  for (const [orig, copy] of EDGE_COPIES) {
    const out = path.join(repo, copy);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, header(orig) + fs.readFileSync(path.join(repo, orig), "utf8"));
    console.log(`wrote ${copy}`);
  }
}
