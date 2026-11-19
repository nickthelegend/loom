import { deliverAttemptEvent } from "../../core/agents-r4/attempts.js";
import { isAdapter } from "../../types.js";
import type { AdapterEvent, AnyAgent } from "../../types.js";

interface Entry {
  agent: AnyAgent;
  off: () => void;
  starting?: Promise<AnyAgent>;
}

/** Owns live instances, subscriptions and startup, never native resume IDs.
 * Replacement invalidates the old callback synchronously. The replacement can
 * be inspected immediately, but cannot start until its predecessor has stopped.
 */
export class RuntimeAgents {
  private readonly entries = new Map<string, Entry>();
  private readonly live = new Map<string, AnyAgent>();
  private readonly stopping = new Map<string, Promise<void>>();
  private closed = false;

  get agents(): ReadonlyMap<string, AnyAgent> { return this.live; }

  install(agent: AnyAgent, onEvent: (event: AdapterEvent) => void): void {
    if (this.closed) throw new Error("agent runtime is closed");
    void this.retire(agent.id).catch(() => {}); // failure stays on the startup barrier
    const entry: Entry = { agent, off: () => {} };
    this.entries.set(agent.id, entry);
    this.live.set(agent.id, agent);
    entry.off = agent.onEvent((event) => {
      if (!this.closed && this.entries.get(agent.id) === entry) {
        if (isAdapter(agent)) deliverAttemptEvent(agent, event, e => {
          if (!this.closed && this.entries.get(agent.id) === entry) onEvent(e);
        });
        else onEvent(event);
      }
    });
  }

  async start(id: string): Promise<AnyAgent> {
    const entry = this.entries.get(id);
    if (this.closed || !entry) throw new Error(`agent "${id}" is no longer active`);
    if (!entry.starting) {
      entry.starting = (async () => {
        await this.stopping.get(id);
        if (this.closed || this.entries.get(id) !== entry) throw new Error(`agent "${id}" was replaced`);
        await entry.agent.start();
        if (this.closed || this.entries.get(id) !== entry) throw new Error(`agent "${id}" was replaced`);
        return entry.agent;
      })();
      // A failed startup can be retried; successful startup is shared by callers.
      void entry.starting.catch(() => { entry.starting = undefined; });
    }
    return entry.starting;
  }

  retire(id: string): Promise<void> {
    const entry = this.entries.get(id);
    if (!entry) return this.stopping.get(id) ?? Promise.resolve();
    this.entries.delete(id);
    this.live.delete(id);
    entry.off();
    const previous = this.stopping.get(id);
    const stopped = (async () => {
      await previous;
      // A pending start must settle before stop, otherwise it can resurrect a
      // child process after shutdown has already returned.
      await entry.starting?.catch(() => {});
      await entry.agent.stop();
    })();
    this.stopping.set(id, stopped);
    void stopped.then(() => {
      if (this.stopping.get(id) === stopped) this.stopping.delete(id);
    }).catch(() => {}); // retain rejected barrier: no successor may start
    return stopped;
  }

  async settled(id: string): Promise<void> { await this.stopping.get(id); }

  async close(): Promise<void> {
    this.closed = true;
    for (const id of this.entries.keys()) void this.retire(id).catch(() => {});
    await Promise.all(this.stopping.values());
  }
}
