/**
 * Integration tests — the real pipeline against Groq + Deepgram.
 *   node --test test/integration.test.mjs
 *
 * Needs GROQ_API_KEY and DEEPGRAM_API_KEY in .env; skips (doesn't fail) without
 * them. The STT-from-speech test needs macOS `say`; it skips elsewhere.
 */

import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "../config.mjs";
import { llm, ttsStream, pcmToWav } from "../providers.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const HAVE_KEYS = Boolean(config.groq.key && config.deepgram.key);
const HAVE_SAY = (() => {
  try {
    execFileSync("which", ["say"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

const PORT = 8099;
const base = `http://127.0.0.1:${PORT}`;
let child;

/** A real spoken WAV via macOS `say`, at exactly the pad's format. */
function sayWav(text) {
  const p = path.join(os.tmpdir(), `pad-say-${Date.now()}.wav`);
  execFileSync("say", ["-o", p, "--data-format=LEI16@16000", text]);
  const buf = fs.readFileSync(p);
  fs.unlinkSync(p);
  return buf;
}

before(async () => {
  if (!HAVE_KEYS) return;
  // Force the standalone LLM brain so these tests stay deterministic and never
  // trigger a real Loom agent run. The Loom bridge has its own test.
  child = spawn(process.execPath, ["server.mjs"], {
    cwd: path.join(here, ".."),
    // PAD_TOKEN:"" forces auth off regardless of .env — these tests exercise the
    // pipeline, not the gate (auth has its own test).
    env: { ...process.env, PORT: String(PORT), HOST: "127.0.0.1", BRAIN: "llm", PAD_TOKEN: "" },
    stdio: "ignore",
  });
  // wait for /health
  const deadline = Date.now() + 15000;
  for (;;) {
    try {
      const r = await fetch(`${base}/health`);
      if (r.ok) break;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error("server did not start");
    await new Promise((r) => setTimeout(r, 300));
  }
});

after(() => {
  child?.kill("SIGKILL");
});

test("provider: llm returns a short spoken reply", { skip: !HAVE_KEYS }, async () => {
  const reply = await llm("In one word, what colour is a clear daytime sky?");
  assert.ok(reply.length > 0, "non-empty reply");
  assert.ok(/blue/i.test(reply), `expected 'blue' in: ${reply}`);
});

test("provider: tts returns real 16 kHz PCM", { skip: !HAVE_KEYS }, async () => {
  const res = await ttsStream("Orchestrator pad online.");
  const buf = Buffer.from(await res.arrayBuffer());
  assert.ok(buf.length > 4000, `expected audio, got ${buf.length} bytes`);
  assert.equal(buf.length % 2, 0, "16-bit samples → even byte count");
});

test("/health reports the wired models", { skip: !HAVE_KEYS }, async () => {
  const j = await (await fetch(`${base}/health`)).json();
  assert.equal(j.ok, true);
  assert.equal(j.sampleRate, 16000);
  assert.equal(j.tts, config.deepgram.ttsModel);
});

test("/speak turns text into PCM", { skip: !HAVE_KEYS }, async () => {
  const res = await fetch(`${base}/speak?text=${encodeURIComponent("testing one two three")}`);
  assert.equal(res.status, 200);
  const buf = Buffer.from(await res.arrayBuffer());
  assert.ok(buf.length > 4000, `expected PCM, got ${buf.length}`);
});

test("/voice: speech in → transcript, reply, and audio out", { skip: !(HAVE_KEYS && HAVE_SAY) }, async () => {
  const wav = sayWav("What is the capital of France?");
  const res = await fetch(`${base}/voice`, {
    method: "POST",
    headers: { "Content-Type": "audio/wav" },
    body: wav,
  });
  assert.equal(res.status, 200, `body: ${res.status === 200 ? "" : await res.text()}`);

  const transcript = decodeURIComponent(res.headers.get("x-transcript") || "");
  const reply = decodeURIComponent(res.headers.get("x-reply") || "");
  assert.ok(/france/i.test(transcript), `heard: ${transcript}`);
  assert.ok(reply.length > 0, "got a reply");
  assert.ok(/paris/i.test(reply), `expected Paris in the reply: ${reply}`);

  const audio = Buffer.from(await res.arrayBuffer());
  assert.ok(audio.length > 8000, `expected spoken reply audio, got ${audio.length}`);
  assert.equal(audio.length % 2, 0);
});

test("/voice: rejects a too-short upload", { skip: !HAVE_KEYS }, async () => {
  const res = await fetch(`${base}/voice`, { method: "POST", body: pcmToWav(Buffer.alloc(200)) });
  assert.equal(res.status, 400);
});
