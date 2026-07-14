/**
 * The baton = the write lock. Exactly one adapter per project may hold it;
 * holding it is what authorizes edits to the shared working tree.
 *
 * Handoffs are explicit (the user confirms in the surface). The active agent
 * is interruptible: a confirmed handoff interrupts an in-flight turn.
 */

import type { EventLog } from "./eventlog.js";
import { readProjectState, writeProjectState } from "./registry.js";

export class NotHolderError extends Error {
  constructor(
    public readonly agentId: string,
    public readonly holder: string | null,
  ) {
    super(
      holder
        ? `agent "${agentId}" does not hold the baton (holder: "${holder}")`
        : `no agent holds the baton`,
    );
    this.name = "NotHolderError";
  }
}

export class BatonManager {
  private projectDir: string;
  private log: EventLog;

  constructor(projectDir: string, log: EventLog) {
    this.projectDir = projectDir;
    this.log = log;
  }

  holder(): string | null {
    return readProjectState(this.projectDir).holder;
  }

  holderSince(): number | undefined {
    return readProjectState(this.projectDir).holderSince;
  }

  /** First acquisition (no current holder). Logged as a handoff from nobody. */
  acquire(agentId: string): void {
    const state = readProjectState(this.projectDir);
    if (state.holder === agentId) return;
    if (state.holder && state.holder !== agentId) {
      throw new NotHolderError(agentId, state.holder);
    }
    state.holder = agentId;
    state.holderSince = Date.now();
    writeProjectState(this.projectDir, state);
    this.log.append({ kind: "handoff", payload: { from: null, to: agentId } });
  }

  /**
   * Move the baton. Caller is responsible for interrupting the current
   * holder and injecting the projection — see ProjectRuntime.handoff().
   */
  handoff(to: string, meta: Record<string, unknown> = {}): { from: string | null } {
    const state = readProjectState(this.projectDir);
    const from = state.holder;
    if (from === to) return { from };
    state.holder = to;
    state.holderSince = Date.now();
    writeProjectState(this.projectDir, state);
    this.log.append({ kind: "handoff", payload: { from, to, ...meta } });
    return { from };
  }

  release(agentId: string): void {
    const state = readProjectState(this.projectDir);
    if (state.holder !== agentId) return;
    state.holder = null;
    delete state.holderSince;
    writeProjectState(this.projectDir, state);
    this.log.append({ kind: "handoff", payload: { from: agentId, to: null } });
  }

  /** Throws NotHolderError unless agentId currently holds the baton. */
  assertHolder(agentId: string): void {
    const holder = this.holder();
    if (holder !== agentId) throw new NotHolderError(agentId, holder);
  }
}
