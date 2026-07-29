/**
 * Unit tests — the pure, network-free parts. Node's built-in runner, no deps:
 *   node --test test/unit.test.mjs
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { pcmToWav, isWav } from "../providers.mjs";
import { config } from "../config.mjs";

test("pcmToWav writes a valid 16 kHz mono 16-bit header", () => {
  const pcm = Buffer.alloc(3200); // 0.1 s of 16 kHz/16-bit mono
  const wav = pcmToWav(pcm, 16000, 1, 16);

  assert.equal(wav.length, pcm.length + 44, "44-byte header + payload");
  assert.equal(wav.toString("ascii", 0, 4), "RIFF");
  assert.equal(wav.toString("ascii", 8, 12), "WAVE");
  assert.equal(wav.toString("ascii", 12, 16), "fmt ");
  assert.equal(wav.readUInt16LE(20), 1, "PCM format");
  assert.equal(wav.readUInt16LE(22), 1, "mono");
  assert.equal(wav.readUInt32LE(24), 16000, "sample rate");
  assert.equal(wav.readUInt16LE(34), 16, "bits per sample");
  assert.equal(wav.readUInt32LE(28), 32000, "byte rate = 16000*1*2");
  assert.equal(wav.readUInt32LE(40), pcm.length, "data chunk size");
  assert.equal(wav.readUInt32LE(4), 36 + pcm.length, "RIFF chunk size");
});

test("pcmToWav honours a different sample rate", () => {
  const wav = pcmToWav(Buffer.alloc(100), 24000);
  assert.equal(wav.readUInt32LE(24), 24000);
  assert.equal(wav.readUInt32LE(28), 48000, "byte rate tracks the rate");
});

test("isWav detects a container vs raw PCM", () => {
  assert.equal(isWav(pcmToWav(Buffer.alloc(64))), true);
  assert.equal(isWav(Buffer.alloc(64)), false, "silent PCM is not a WAV");
  assert.equal(isWav(Buffer.from("RIFFxxxxWAVE")), true);
  assert.equal(isWav(Buffer.from("nope")), false, "too short");
});

test("config has the wired defaults", () => {
  assert.equal(config.sampleRate, 16000);
  assert.equal(config.groq.sttModel, "whisper-large-v3-turbo");
  assert.ok(config.groq.llmModel.startsWith("llama"));
  assert.equal(config.deepgram.ttsModel, "aura-2-thalia-en");
  assert.ok(config.groq.maxTokens > 0 && config.groq.maxTokens <= 400, "reply length is bounded");
});
