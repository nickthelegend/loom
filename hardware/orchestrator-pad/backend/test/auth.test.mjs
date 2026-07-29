/**
 * Auth tests — the PAD_TOKEN shared-secret gate.
 *   node --test test/auth.test.mjs
 *
 * Spawns the server WITH a token set and checks that requests without it are
 * refused and requests with it pass. Needs the two API keys to boot (the server
 * asserts them at startup); skips without them.
 */

import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "../config.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const HAVE_KEYS = Boolean(config.groq.key && config.deepgram.key);

const PORT = 8098;
const TOKEN = "test-token-abc123";
const base = `http://127.0.0.1:${PORT}`;
let child;

before(async () => {
  if (!HAVE_KEYS) return;
  child = spawn(process.execPath, ["server.mjs"], {
    cwd: path.join(here, ".."),
    env: { ...process.env, PORT: String(PORT), HOST: "127.0.0.1", BRAIN: "llm", PAD_TOKEN: TOKEN },
    stdio: "ignore",
  });
  const deadline = Date.now() + 15000;
  for (;;) {
    try {
      // health is gated too, so knock with the token to detect readiness
      const r = await fetch(`${base}/health`, { headers: { Authorization: `Bearer ${TOKEN}` } });
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

test("no token → 401", { skip: !HAVE_KEYS }, async () => {
  const r = await fetch(`${base}/health`);
  assert.equal(r.status, 401);
});

test("wrong token → 401", { skip: !HAVE_KEYS }, async () => {
  const r = await fetch(`${base}/health`, { headers: { Authorization: "Bearer nope" } });
  assert.equal(r.status, 401);
});

test("correct Bearer token → 200", { skip: !HAVE_KEYS }, async () => {
  const r = await fetch(`${base}/health`, { headers: { Authorization: `Bearer ${TOKEN}` } });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).ok, true);
});

test("X-Pad-Token header form → 200", { skip: !HAVE_KEYS }, async () => {
  const r = await fetch(`${base}/health`, { headers: { "X-Pad-Token": TOKEN } });
  assert.equal(r.status, 200);
});
