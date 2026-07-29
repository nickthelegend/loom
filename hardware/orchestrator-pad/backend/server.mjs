/**
 * The macropad backend — the tailnet server the Mac runs.
 *
 *   POST /select  {agent}          lock the baton to an agent (a Loom handoff).
 *   POST /voice   PCM/WAV in       held-to-talk turn → the selected agent → PCM
 *                 ?agent=…         reply out. (agent optional; defaults to the
 *                                  last /select.) Transcript + reply in headers.
 *   GET  /speak   ?text=…          arbitrary text → PCM. Amp test / telnet `say`.
 *   GET  /health                   brain, selected agent, wired models.
 *
 * Brain = "loom" drives the Loom daemon (the pad becomes a Loom surface); it
 * falls back to a standalone Groq chat if the daemon isn't reachable. Reply
 * audio is buffered and sent with Content-Length so the ESP32's HTTP client —
 * which reads a raw stream, not chunked — gets clean PCM.
 *
 * Dependency-free: node:http + global fetch. API keys come from .env.
 */

import http from "node:http";
import crypto from "node:crypto";
import { config, assertConfigured } from "./config.mjs";
import { stt, llm, ttsStream, pcmToWav, isWav } from "./providers.mjs";
import { loomInit, loomReachable, loomSelect, loomAsk, loomAgents } from "./loom.mjs";

assertConfigured();

let brainMode = "llm"; // resolved at startup
let currentAgent = null; // set by /select, used by /voice when no ?agent

const MAX_UPLOAD = 6 * 1024 * 1024;
const hdr = (s) => encodeURIComponent(String(s ?? "").slice(0, 480));

function readBody(req, limit = MAX_UPLOAD) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error("upload too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

/** Buffer a fetch Response's PCM body into one Buffer — so we can send a
 *  Content-Length. The ESP32 streams the *download* to I2S; the backend, with
 *  RAM to spare, holds the reply so there are no chunked-transfer markers. */
async function collectPcm(ttsRes) {
  const chunks = [];
  for await (const c of ttsRes.body) chunks.push(Buffer.from(c));
  return Buffer.concat(chunks);
}

async function speakPcm(res, text, extraHeaders = {}) {
  const pcm = await collectPcm(await ttsStream(text));
  res.writeHead(200, {
    "Content-Type": "application/octet-stream",
    "Content-Length": pcm.length,
    "Cache-Control": "no-store",
    "X-Sample-Rate": String(config.sampleRate),
    ...extraHeaders,
  });
  res.end(pcm);
  return pcm.length;
}

/** Constant-time check of the pad's shared secret. When PAD_TOKEN is unset the
 *  backend is open (trusted-LAN mode); when set, every request must carry it as
 *  `Authorization: Bearer <token>` or `X-Pad-Token`. */
function tokenOk(req) {
  if (!config.padToken) return true;
  const auth = req.headers["authorization"] || "";
  const provided = auth.startsWith("Bearer ") ? auth.slice(7) : req.headers["x-pad-token"] || "";
  const a = Buffer.from(String(provided));
  const b = Buffer.from(config.padToken);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** transcript → reply text, via Loom or the standalone LLM. */
async function think(agent, transcript) {
  if (brainMode === "loom") {
    const { reply, done } = await loomAsk(agent, transcript);
    if (done && reply) return reply;
    if (!done) return `Sent to ${agent || "the agent"}. Check the thread.`;
    return reply || `${agent || "The agent"} finished.`;
  }
  return llm(transcript);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const started = Date.now();

  // Gate everything behind the shared secret when one is configured — except
  // /health, which must stay open so connectivity checks (the Loom app's
  // "LoomPad" pill, load balancers) can see the backend is up without the token.
  const isHealth = req.method === "GET" && url.pathname === "/health";
  if (!isHealth && !tokenOk(req)) {
    console.warn(`  ✗ 401 ${req.method} ${url.pathname} from ${req.socket.remoteAddress}`);
    return void json(res, 401, { error: "unauthorized" });
  }

  if (req.method === "GET" && url.pathname === "/health") {
    return void json(res, 200, {
      ok: true,
      brain: brainMode,
      agent: currentAgent,
      agents: loomAgents(),
      sampleRate: config.sampleRate,
      stt: `${config.sttProvider}:${config.sttProvider === "groq" ? config.groq.sttModel : config.deepgram.sttModel}`,
      llm: config.groq.llmModel,
      tts: config.deepgram.ttsModel,
    });
  }

  // --- select / lock an agent (the pad's agent keys) ----------------------
  if (req.method === "POST" && url.pathname === "/select") {
    let body = {};
    try {
      body = JSON.parse((await readBody(req)).toString() || "{}");
    } catch {
      /* allow ?agent= form too */
    }
    const agent = String(body.agent || url.searchParams.get("agent") || "").trim();
    if (!agent) return void json(res, 400, { error: "missing agent" });
    currentAgent = agent;
    let from = null;
    if (brainMode === "loom") {
      try {
        from = (await loomSelect(agent)).from ?? null;
      } catch (err) {
        console.error(`  ✗ select ${agent}: ${err.message}`);
        return void json(res, 502, { error: err.message });
      }
    }
    console.log(`  /select → ${agent}${from ? ` (baton was ${from})` : ""}`);
    return void json(res, 200, { ok: true, agent, brain: brainMode, from });
  }

  // --- speak arbitrary text (amp test / telnet `say`) ---------------------
  if (req.method === "GET" && url.pathname === "/speak") {
    const text = (url.searchParams.get("text") || "").trim();
    if (!text) return void json(res, 400, { error: "missing ?text=" });
    try {
      const n = await speakPcm(res, text);
      console.log(`  /speak "${text.slice(0, 40)}" → ${n}b (${Date.now() - started}ms)`);
    } catch (err) {
      fail(res, err, started);
    }
    return;
  }

  // --- the voice turn -----------------------------------------------------
  if (req.method === "POST" && url.pathname === "/voice") {
    try {
      const raw = await readBody(req);
      if (raw.length < 2048) return void json(res, 400, { error: "audio too short" });
      const agent = (url.searchParams.get("agent") || currentAgent || "").trim();
      const wav = isWav(raw) ? raw : pcmToWav(raw);

      const t0 = Date.now();
      const transcript = await stt(wav);
      const t1 = Date.now();
      if (!transcript) return void json(res, 422, { error: "heard nothing" });

      let reply;
      try {
        reply = await think(agent, transcript);
      } catch (err) {
        console.error(`  ✗ brain(${brainMode}) ${agent}: ${err.message}`);
        reply = brainMode === "loom" ? `${agent || "That agent"} is not available.` : "Sorry, something went wrong.";
      }
      if (!reply) reply = "No reply.";
      const t2 = Date.now();

      const bytes = await speakPcm(res, reply, {
        "X-Transcript": hdr(transcript),
        "X-Reply": hdr(reply),
        "X-Agent": hdr(agent),
      });
      console.log(
        `  /voice [${agent || "-"}]  heard: "${transcript}"\n` +
          `          said:  "${reply.slice(0, 100)}${reply.length > 100 ? "…" : ""}"\n` +
          `          stt ${t1 - t0}ms · think ${t2 - t1}ms · tts ${Date.now() - t2}ms · ${bytes}b`,
      );
    } catch (err) {
      fail(res, err, started);
    }
    return;
  }

  json(res, 404, { error: "not found" });
});

function json(res, code, obj) {
  if (res.headersSent) return;
  res.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(obj));
}
function fail(res, err, started) {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`  ✗ ${msg} (${Date.now() - started}ms)`);
  if (!res.headersSent) json(res, 500, { error: msg });
  else res.end();
}

async function chooseBrain() {
  if (config.brain === "loom" && (await loomReachable())) {
    const { agents } = await loomInit();
    brainMode = "loom";
    console.log(`  brain: loom (${config.loom.url}) · agents: ${agents.join(", ")}`);
  } else {
    brainMode = "llm";
    console.log(
      config.brain === "loom"
        ? `  brain: llm  (loom not reachable at ${config.loom.url} — falling back)`
        : `  brain: llm`,
    );
  }
}

server.listen(config.port, config.host, async () => {
  console.log(`\n  orchestrator-pad backend`);
  console.log(`  listening on http://${config.host}:${config.port}`);
  console.log(
    `  stt ${config.sttProvider}:${config.sttProvider === "groq" ? config.groq.sttModel : config.deepgram.sttModel} · llm ${config.groq.llmModel} · tts ${config.deepgram.ttsModel}`,
  );
  await chooseBrain();
  console.log(
    config.padToken
      ? `  auth:  on (pad must send the PAD_TOKEN)`
      : `  auth:  OFF — set PAD_TOKEN before exposing this to the internet`,
  );
  console.log(`  point the pad at this machine — LAN: http://<lan-ip>:${config.port}  ·  remote: Tailscale Funnel (see README)\n`);
});
