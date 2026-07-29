/**
 * End-to-end voice test on the Mac — no ESP32 needed.
 *
 *   node test-voice.mjs                       # asks a default question
 *   node test-voice.mjs "your question here"  # asks yours
 *
 * Uses macOS `say` to synthesise a 16 kHz PCM question (exactly what the mic
 * would record), POSTs it to a *running* backend's /voice, then plays the spoken
 * reply through `afplay`. Prints what was heard and said.
 *
 * Start the backend first:  npm start
 */

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { config } from "./config.mjs";
import { pcmToWav } from "./providers.mjs";

const url = process.env.VOICE_URL || `http://127.0.0.1:${config.port}/voice`;
const question = process.argv.slice(2).join(" ") || "In one sentence, what does the orchestrator pad do?";
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pad-voice-"));

function sh(name) {
  try {
    execFileSync("which", [name], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

if (!sh("say")) {
  console.error("  this harness needs macOS `say`. On Linux, POST any 16 kHz WAV to /voice instead.");
  process.exit(1);
}

console.log(`\n  asking: "${question}"`);
const qWav = path.join(tmp, "question.wav");
execFileSync("say", ["-o", qWav, "--data-format=LEI16@16000", question]);
console.log(`  synthesised question → ${fs.statSync(qWav).size} bytes @ 16 kHz`);

const t0 = Date.now();
let res;
try {
  res = await fetch(url, { method: "POST", headers: { "Content-Type": "audio/wav" }, body: fs.readFileSync(qWav) });
} catch (e) {
  console.error(`\n  ✗ couldn't reach ${url} — is the backend running? (npm start)\n    ${e.message}`);
  process.exit(1);
}

if (!res.ok) {
  console.error(`\n  ✗ /voice ${res.status}: ${await res.text()}`);
  process.exit(1);
}

const heard = decodeURIComponent(res.headers.get("x-transcript") || "");
const said = decodeURIComponent(res.headers.get("x-reply") || "");
const pcm = Buffer.from(await res.arrayBuffer());
const secs = pcm.length / 2 / config.sampleRate;
console.log(`\n  heard: "${heard}"`);
console.log(`  said:  "${said}"`);
console.log(`  reply audio: ${pcm.length} bytes · ${secs.toFixed(1)}s · round-trip ${Date.now() - t0}ms`);

// Wrap the raw PCM back into a WAV so afplay can play it.
const replyWav = path.join(tmp, "reply.wav");
fs.writeFileSync(replyWav, pcmToWav(pcm, config.sampleRate));

if (sh("afplay")) {
  console.log(`\n  ▶ playing the reply…`);
  spawnSync("afplay", [replyWav], { stdio: "ignore" });
  console.log(`  done.\n`);
} else {
  console.log(`\n  saved reply to ${replyWav} (no afplay to auto-play).\n`);
}
