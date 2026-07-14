/**
 * Echo adapter — a deterministic in-process agent used by tests and demos.
 * It behaves like a full-duplex adapter: streams a message, then completes.
 *
 * Prompt tricks (for exercising the machinery without a real model):
 *   - text containing "make a plan"  → replies in planner voice ("plan is complete")
 *   - text containing "sleep:<ms>"   → stays busy that long (interrupt testing)
 */

import type { SendInput } from "../types.js";
import { AdapterBase } from "./base.js";

export class EchoAdapter extends AdapterBase {
  private aborted = false;

  async available(): Promise<boolean> {
    return true;
  }

  async start(): Promise<void> {
    this.emit({ kind: "status", payload: { state: "started" } });
  }

  async stop(): Promise<void> {
    this.emit({ kind: "status", payload: { state: "stopped" } });
  }

  async send(input: SendInput): Promise<void> {
    if (this._busy) throw new Error(`echo agent "${this.id}" is busy`);
    this._busy = true;
    this.aborted = false;
    const started = Date.now();
    try {
      const sleepMatch = input.text.match(/sleep:(\d+)/);
      if (sleepMatch) {
        const ms = Math.min(Number(sleepMatch[1]), 60_000);
        const deadline = Date.now() + ms;
        while (Date.now() < deadline && !this.aborted) {
          await new Promise((r) => setTimeout(r, 20));
        }
      } else {
        await new Promise((r) => setTimeout(r, 25));
      }
      if (this.aborted) {
        this.emit({ kind: "status", payload: { state: "interrupted" } });
        return;
      }
      const briefingNote = input.briefing ? ` (briefed: ${input.briefing.length} chars)` : "";
      const text = /make a plan/i.test(input.text)
        ? `Here is the approach. 1) analyze 2) implement 3) verify. The plan is complete and ready to execute.${briefingNote}`
        : `echo(${this.id}): ${input.text}${briefingNote}`;
      this.emit({ kind: "message", payload: { text } });
      this.emit({
        kind: "run_complete",
        payload: { durationMs: Date.now() - started, costUsd: 0 },
      });
    } finally {
      this._busy = false;
    }
  }

  async interrupt(): Promise<void> {
    this.aborted = true;
  }
}
