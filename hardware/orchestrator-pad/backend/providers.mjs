/**
 * The three upstream calls, each a plain async function so the pipeline in
 * server.mjs reads top to bottom: bytes → text → reply → bytes.
 *
 *   stt()       Deepgram Nova   (audio → transcript)
 *   llm()       Groq Llama      (transcript → reply)
 *   ttsStream() Deepgram Aura   (reply → 16 kHz PCM stream)
 *
 * Audio (STT + TTS) is Deepgram; the LLM is Groq. No SDKs — Node's global
 * fetch/FormData do it all.
 */

import { config } from "./config.mjs";

/** Abort a fetch that outlives the deadline, so one slow upstream can't wedge the pad. */
function withTimeout(ms) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  return { signal: ctrl.signal, done: () => clearTimeout(t) };
}

/**
 * Wrap raw PCM in a 44-byte WAV header. The pad uploads headerless PCM (simpler
 * firmware); the STT API wants a real container, so we add one here.
 */
export function pcmToWav(pcm, sampleRate = config.sampleRate, channels = 1, bits = 16) {
  const byteRate = (sampleRate * channels * bits) / 8;
  const blockAlign = (channels * bits) / 8;
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16); // PCM fmt chunk size
  header.writeUInt16LE(1, 20); // audio format = PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bits, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

/** Does this buffer already start with a RIFF/WAVE header? */
export function isWav(buf) {
  return buf.length >= 12 && buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WAVE";
}

/**
 * Audio bytes (WAV) → transcript. Empty string when nothing was heard.
 * Dispatches to Deepgram (default) or Groq whisper per STT_PROVIDER.
 */
export async function stt(wavBuffer) {
  return config.sttProvider === "groq" ? sttGroq(wavBuffer) : sttDeepgram(wavBuffer);
}

async function sttDeepgram(wavBuffer) {
  const { signal, done } = withTimeout(config.timeoutMs);
  try {
    const url = `https://api.deepgram.com/v1/listen?model=${encodeURIComponent(config.deepgram.sttModel)}&smart_format=true&punctuate=true`;
    const res = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Token ${config.deepgram.key}`, "Content-Type": "audio/wav" },
      body: wavBuffer,
      signal,
    });
    if (!res.ok) throw new Error(`STT(deepgram) ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const json = await res.json();
    return String(json.results?.channels?.[0]?.alternatives?.[0]?.transcript ?? "").trim();
  } finally {
    done();
  }
}

async function sttGroq(wavBuffer) {
  const { signal, done } = withTimeout(config.timeoutMs);
  try {
    const form = new FormData();
    form.append("file", new Blob([wavBuffer], { type: "audio/wav" }), "speech.wav");
    form.append("model", config.groq.sttModel);
    form.append("response_format", "json");
    form.append("temperature", "0");
    const res = await fetch(`${config.groq.base}/audio/transcriptions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${config.groq.key}` },
      body: form,
      signal,
    });
    if (!res.ok) throw new Error(`STT(groq) ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const json = await res.json();
    return String(json.text ?? "").trim();
  } finally {
    done();
  }
}

/** Transcript → a short spoken reply. */
export async function llm(userText) {
  const { signal, done } = withTimeout(config.timeoutMs);
  try {
    const res = await fetch(`${config.groq.base}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.groq.key}` },
      body: JSON.stringify({
        model: config.groq.llmModel,
        temperature: 0.4,
        max_tokens: config.groq.maxTokens,
        messages: [
          { role: "system", content: config.groq.system },
          { role: "user", content: userText },
        ],
      }),
      signal,
    });
    if (!res.ok) throw new Error(`LLM ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const json = await res.json();
    return String(json.choices?.[0]?.message?.content ?? "").trim();
  } finally {
    done();
  }
}

/**
 * Reply text → a streaming Response of raw 16 kHz / 16-bit / mono PCM.
 *
 * `encoding=linear16&sample_rate=…&container=none` is the whole trick: Deepgram
 * hands back headerless PCM at exactly the amp's format, so the backend never
 * transcodes and the firmware writes the bytes straight to I2S. Returns the
 * fetch Response so the caller can pipe `.body` through without buffering.
 */
export async function ttsStream(text) {
  const url =
    `https://api.deepgram.com/v1/speak?model=${encodeURIComponent(config.deepgram.ttsModel)}` +
    `&encoding=linear16&sample_rate=${config.sampleRate}&container=none`;
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Token ${config.deepgram.key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });
  if (!res.ok || !res.body) {
    throw new Error(`TTS ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`);
  }
  return res;
}
