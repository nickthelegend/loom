/**
 * Reads SCRIPT-120.md's indented spoken lines and renders each to a WAV with the
 * hyperframes Kokoro TTS, so the 120s cut gets the same voice as the 30s one.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const SCRIPT = process.argv[2];
const OUT = process.argv[3];
fs.mkdirSync(OUT, { recursive: true });

const src = fs.readFileSync(SCRIPT, "utf8").split("\n");
const lines = [];
let cur = null;
for (const raw of src) {
  if (/^##\s+Line\s+(\d+)/.test(raw)) {
    if (cur) lines.push(cur);
    cur = { n: Number(RegExp.$1), text: [] };
    continue;
  }
  if (cur && /^ {4}\S/.test(raw)) cur.text.push(raw.trim());
  else if (cur && cur.text.length && raw.trim() === "") { /* keep gathering */ }
}
if (cur) lines.push(cur);

console.log(`parsed ${lines.length} spoken lines`);
for (const l of lines) {
  const text = l.text.join(" ").replace(/\s+/g, " ").trim();
  if (!text) { console.log(`  line ${l.n}: EMPTY, skipped`); continue; }
  const file = path.join(OUT, `${String(l.n).padStart(2, "0")}.wav`);
  console.log(`  line ${l.n} (${text.split(" ").length}w): ${text.slice(0, 62)}…`);
  execFileSync("npx", ["hyperframes", "tts", text, "--voice", process.env.HF_VOICE||"am_adam", "--speed", process.env.HF_SPEED||"1.2", "-o", file],
    { stdio: ["ignore", "pipe", "pipe"], cwd: process.argv[4] || process.cwd() });
}
console.log("done ->", OUT);
