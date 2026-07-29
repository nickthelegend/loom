/**
 * All configuration in one place, read from the environment.
 *
 * Secrets (the two API keys) live in `.env`, which is gitignored — nothing here
 * is ever committed. Everything else has a sensible default so a fresh clone
 * runs with just the two keys set.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Tiny .env loader (so there's no dotenv dependency). KEY=VALUE per line,
// # comments and blank lines ignored, surrounding quotes stripped.
const here = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.join(here, ".env");
if (fs.existsSync(envPath)) {
  for (const raw of fs.readFileSync(envPath, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = val;
  }
}

const env = (k, d) => process.env[k] ?? d;

export const config = {
  port: Number(env("PORT", "8080")),
  host: env("HOST", "0.0.0.0"), // bind all interfaces so the pad on your LAN can reach it

  // The one audio format the whole system speaks: 16 kHz, 16-bit, mono PCM.
  // The mic records it, Deepgram is asked to return it, the amp plays it.
  sampleRate: Number(env("SAMPLE_RATE", "16000")),

  // Who transcribes: "deepgram" (works out of the box) or "groq" (whisper — fast,
  // but Groq gates audio models per-project; enable them for your key's project
  // first, then set STT_PROVIDER=groq).
  sttProvider: (env("STT_PROVIDER", "deepgram") || "deepgram").toLowerCase(),

  groq: {
    key: env("GROQ_API_KEY", ""),
    base: env("GROQ_BASE", "https://api.groq.com/openai/v1"),
    llmModel: env("LLM_MODEL", "llama-3.3-70b-versatile"),
    sttModel: env("GROQ_STT_MODEL", "whisper-large-v3-turbo"),
    // Keep replies short — this is a speaker on a desk, not an essay generator.
    system: env(
      "SYSTEM_PROMPT",
      "You are the voice of a desk macropad that orchestrates coding agents. " +
        "Answer out loud, in one or two spoken sentences — plain, direct, no markdown, " +
        "no code blocks, no lists. If you don't know, say so briefly.",
    ),
    maxTokens: Number(env("MAX_TOKENS", "160")),
  },

  deepgram: {
    key: env("DEEPGRAM_API_KEY", ""),
    // STT. Groq's whisper is org-gated on many accounts, so audio lives here with
    // the TTS — one provider, one key for everything the microphone touches.
    sttModel: env("STT_MODEL", "nova-2"),
    // Aura-2 voice. Others: aura-2-andromeda-en, aura-2-apollo-en, aura-asteria-en …
    ttsModel: env("TTS_MODEL", "aura-2-thalia-en"),
  },

  // A per-request ceiling so a stuck upstream can't hang the pad forever.
  timeoutMs: Number(env("TIMEOUT_MS", "20000")),

  // Shared secret the pad must present (Authorization: Bearer <token>, or the
  // X-Pad-Token header). Empty = auth off — fine on a trusted LAN. REQUIRED once
  // you expose the backend to the public internet (e.g. Tailscale Funnel):
  // without it, anyone who finds the URL can spend your API keys and drive Loom.
  // Generate one with:  openssl rand -hex 24
  padToken: env("PAD_TOKEN", ""),

  // ── The brain ──────────────────────────────────────────────────────────
  // "loom": the pad drives the Loom daemon — an agent key locks that agent
  //         (a handoff, visible in the thread), and a held-to-talk turn is sent
  //         to that agent as a message. "llm": a standalone Groq chat, no Loom.
  // Defaults to loom when LOOM_URL is reachable at startup, else falls back.
  brain: (env("BRAIN", "loom") || "loom").toLowerCase(),

  loom: {
    url: env("LOOM_URL", "http://127.0.0.1:7420").replace(/\/+$/, ""),
    // When the backend runs on the same machine as the daemon, it bootstraps the
    // admin token over loopback — no token to configure. Set LOOM_TOKEN only for
    // a remote daemon over the tailnet.
    token: env("LOOM_TOKEN", ""),
    // Empty = use the daemon's first project.
    project: env("LOOM_PROJECT", ""),
    // How long to wait for the agent's spoken reply before falling back to a
    // "sent, check the thread" confirmation (agents doing real work take a while).
    replyTimeoutMs: Number(env("LOOM_REPLY_TIMEOUT_MS", "45000")),
    pollMs: Number(env("LOOM_POLL_MS", "1200")),
    // Nudge agents toward a speakable answer without polluting the thread much.
    voiceHint: env(
      "LOOM_VOICE_HINT",
      "(Reply in one or two spoken sentences, no code or markdown.) ",
    ),
    // TTS gets unwieldy past a couple of sentences — cap what we speak.
    maxSpeakChars: Number(env("LOOM_MAX_SPEAK_CHARS", "600")),
  },
};

/** Fail loud and early if a key is missing — better than a 401 mid-conversation. */
export function assertConfigured() {
  const missing = [];
  if (!config.groq.key) missing.push("GROQ_API_KEY");
  if (!config.deepgram.key) missing.push("DEEPGRAM_API_KEY");
  if (missing.length) {
    console.error(`\n  ✗ missing ${missing.join(" and ")} — copy .env.example to .env and fill them in.\n`);
    process.exit(1);
  }
}
