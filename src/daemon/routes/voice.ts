import type { Express } from 'express';
import express from "express";
import { execFile, fileCommand } from "../../core/process.js";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { logbook } from "../../core/logbook.js";
import type { WithRuntime } from './context.js';
/** Register voice routes in the order established by LoomDaemon.routes(). */
export function registerVoiceRoutes(app: Express, withRuntime: WithRuntime): void {

  // ---- voice: hold-to-talk from any client ------------------------------
  // Audio in, text out. Transcription is a CONFIGURED command (LOOM_STT_CMD,
  // e.g. whisper.cpp: `whisper-cli -m model.bin -f {file} -otxt`), because
  // Loom's contract is no accounts and no keys — shipping a cloud STT call
  // would break the reason the rest works offline. No command configured is
  // an honest 501 with the setup line, not a fake transcript.
  app.post(
    "/api/projects/:id/voice",
    express.raw({ type: ["audio/*", "application/octet-stream"], limit: "25mb" }),
    withRuntime(async (rt, req, res) => {
      const cmd = process.env.LOOM_STT_CMD;
      if (!cmd) {
        return void res.status(501).json({
          error:
            "no transcriber configured — set LOOM_STT_CMD to a command that takes {file} and prints text (e.g. whisper.cpp)",
        });
      }
      const body = req.body as Buffer;
      if (!body?.length) return void res.status(400).json({ error: "no audio" });
      // Date.now() alone collides when two clients release the mic in the
      // same millisecond — one request then transcribes the other's audio.
      const tmp = path.join(
        os.tmpdir(),
        `loom-voice-${Date.now()}-${crypto.randomBytes(4).toString("hex")}.audio`,
      );
      try {
        fs.writeFileSync(tmp, body);
        const launch = fileCommand(cmd, tmp);
        const text = await new Promise<string>((resolve, reject) => {
          execFile(
            launch.command,
            launch.args,
            { env: launch.env, windowsVerbatimArguments: launch.windowsVerbatimArguments, timeout: 60_000, maxBuffer: 1024 * 1024 },
            (err, stdout) => (err ? reject(err) : resolve(stdout.trim())),
          );
        });
        if (!text) return void res.status(422).json({ error: "the transcriber returned nothing" });
        logbook.info("voice", `transcribed ${body.length} bytes → ${text.length} chars`, undefined, rt.info.id);
        res.json({ text });
      } catch (err) {
        res.status(500).json({ error: `transcription failed: ${err instanceof Error ? err.message : err}` });
      } finally {
        try {
          fs.rmSync(tmp, { force: true });
        } catch {
          /* gone */
        }
      }
    }),
  );
}
