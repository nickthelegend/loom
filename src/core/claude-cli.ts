/**
 * Minimal helper for one-shot Claude calls (headless `claude -p`, JSON out).
 * Used by the dynamic-route router and the LLM projection distiller — small
 * internal reasoning jobs, never user-facing turns (those go through the
 * claude-code adapter with sessions and streaming).
 */

import { spawn } from "node:child_process";

export interface ClaudeCliOptions {
  /** Model alias or id; small+fast is right for internal jobs. */
  model?: string;
  timeoutMs?: number;
}

export function claudeText(prompt: string, opts: ClaudeCliOptions = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "claude",
      [
        "-p",
        prompt,
        "--output-format",
        "json",
        "--model",
        opts.model ?? "haiku",
        "--no-session-persistence",
      ],
      { stdio: ["ignore", "pipe", "ignore"] },
    );
    let out = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("claude call timed out"));
    }, opts.timeoutMs ?? 45_000);
    timer.unref?.();
    child.stdout.on("data", (d: Buffer) => (out += d.toString()));
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`claude exited ${code}`));
      try {
        const wrapper = JSON.parse(out) as { result?: string; is_error?: boolean };
        if (wrapper.is_error) return reject(new Error("claude returned an error result"));
        resolve(String(wrapper.result ?? out));
      } catch {
        resolve(out);
      }
    });
  });
}
