/**
 * Loop watch: an agent stuck re-running the same thing.
 *
 * The expensive failure isn't the error — it's the agent that hits the same
 * failing test eight times, or runs the same command in a circle, burning
 * tokens while you're away. Within one turn this counts each command (or tool
 * call) by what it is, and says so once when:
 *
 *   failing    the same command has failed 3 times
 *   repeating  the exact same call has been made 5 times
 *
 * Pure: the runtime feeds it events and decides what to do (watchdog config).
 */

import type { LoomEvent } from "../types.js";

export interface Loop {
  agentId: string;
  chat: string;
  kind: "failing" | "repeating";
  /** The command or call, as the thread shows it. */
  call: string;
  count: number;
  /** The last failure's output, when there was one. */
  output?: string;
}

export const FAILING_AT = 3;
export const REPEATING_AT = 5;

interface Turn { calls: Map<string, { n: number; failed: number }>; said: Set<string> }

/** "npm  test  -- --run" and "npm test -- --run" are the same call; so are two reads of one file. */
export function signature(p: Record<string, unknown>): string | null {
  const command = typeof p.command === "string" ? p.command
    : String(p.tool ?? "").toLowerCase() === "shell" || String(p.tool ?? "").toLowerCase() === "bash"
      ? String((p.input as Record<string, unknown> | undefined)?.command ?? "") : "";
  if (command.trim()) return command.replace(/\s+/g, " ").trim().slice(0, 300);
  const tool = String(p.tool ?? p.name ?? "").trim();
  if (!tool) return null;
  return `${tool}: ${String(p.summary ?? "").replace(/\s+/g, " ").trim().slice(0, 200)}`;
}

export class LoopWatch {
  private turns = new Map<string, Turn>();

  /** One event; returns a loop the first time this turn crosses a line, else null. */
  observe(e: LoomEvent): Loop | null {
    if (!e.agentId) return null;
    const chat = e.chat ?? "main";
    const key = `${e.agentId}\u0000${chat}`;
    if (e.kind === "run_complete" || (e.kind === "status" && (e.payload.state === "interrupted" || e.payload.state === "stopped"))) {
      this.turns.delete(key);
      return null;
    }
    if (e.kind !== "tool_call") return null;
    const p = e.payload as Record<string, unknown>;
    const sig = signature(p);
    if (!sig) return null;
    let turn = this.turns.get(key);
    if (!turn) { turn = { calls: new Map(), said: new Set() }; this.turns.set(key, turn); }
    const c = turn.calls.get(sig) ?? { n: 0, failed: 0 };
    c.n++;
    const failed = (typeof p.exitCode === "number" && p.exitCode !== 0) || p.ok === false;
    if (failed) c.failed++;
    turn.calls.set(sig, c);
    const output = [p.output, p.preview, p.error].filter((x): x is string => typeof x === "string" && !!x.trim()).join("\n").slice(-1500) || undefined;
    if (failed && c.failed === FAILING_AT && !turn.said.has(`f:${sig}`)) {
      turn.said.add(`f:${sig}`);
      return { agentId: e.agentId, chat, kind: "failing", call: sig, count: c.failed, ...(output ? { output } : {}) };
    }
    if (c.n === REPEATING_AT && !turn.said.has(`f:${sig}`) && !turn.said.has(`r:${sig}`)) {
      turn.said.add(`r:${sig}`);
      return { agentId: e.agentId, chat, kind: "repeating", call: sig, count: c.n };
    }
    return null;
  }

  /** A person spoke in the chat: every agent's count there starts over. */
  reset(chat: string): void {
    for (const k of [...this.turns.keys()]) if (k.endsWith(`\u0000${chat}`)) this.turns.delete(k);
  }
}

/** What Loom tells a stuck agent when it nudges it. */
export function nudgeText(loop: Loop): string {
  return loop.kind === "failing"
    ? `[Loom] You've run \`${loop.call}\` ${loop.count} times this turn and it failed each time. Stop repeating it. Say in one or two sentences what is actually failing and why your fixes haven't worked, then try a different approach — or ask if you need something from me.`
    : `[Loom] You've made the same call (\`${loop.call}\`) ${loop.count} times this turn. Step back: say what you're trying to find out, and take a different route to it.`;
}
