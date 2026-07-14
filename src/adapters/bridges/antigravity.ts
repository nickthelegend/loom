/**
 * Antigravity bridge — read-mostly, second-class by design.
 *
 * Antigravity (a VS Code/Windsurf-class GUI agent) exposes no stable
 * send/interrupt/memory API. Launched with a remote-debugging port it does
 * expose a Chromium DevTools endpoint, which gives Loom *presence*:
 * we can see it, list its targets, and keep its shared-context projection
 * fresh on disk (.loom/memory/antigravity.md) for the human driving it.
 *
 * A bridge NEVER holds the baton and never edits the tree under Loom's lock.
 * If Antigravity ever ships a real API, this graduates to an adapter.
 */

import { BridgeBase, fetchJson } from "../base.js";

interface AntigravityOptions {
  /** Chromium remote-debugging port Antigravity was launched with. */
  debugPort?: number;
  host?: string;
}

interface CdpTarget {
  title?: string;
  type?: string;
  url?: string;
}

export class AntigravityBridge extends BridgeBase {
  private options: AntigravityOptions;
  private pollTimer: NodeJS.Timeout | null = null;

  constructor(id: string, projectDir: string, options: Record<string, unknown> = {}) {
    super(id, "antigravity", projectDir);
    this.options = options as AntigravityOptions;
  }

  private get endpoint(): string {
    const host = this.options.host ?? "127.0.0.1";
    const port = this.options.debugPort ?? 9222;
    return `http://${host}:${port}`;
  }

  async available(): Promise<boolean> {
    try {
      await fetchJson(`${this.endpoint}/json/version`, undefined, 2000);
      return true;
    } catch {
      return false;
    }
  }

  async start(): Promise<void> {
    const up = await this.available();
    if (!up) {
      this.emit({
        kind: "status",
        payload: {
          state: "unreachable",
          hint: `launch Antigravity with --remote-debugging-port=${this.options.debugPort ?? 9222}`,
        },
      });
      return;
    }
    const targets = await fetchJson<CdpTarget[]>(`${this.endpoint}/json`, undefined, 3000).catch(
      () => [] as CdpTarget[],
    );
    this.emit({
      kind: "status",
      payload: {
        state: "observed",
        targets: targets.slice(0, 10).map((t) => ({ title: t.title, type: t.type })),
      },
    });
    // Light presence polling so the board can show reachability.
    this.pollTimer = setInterval(() => {
      void this.available().then((ok) => {
        if (!ok) this.emit({ kind: "status", payload: { state: "unreachable" } });
      });
    }, 60_000);
    this.pollTimer.unref?.();
  }

  async stop(): Promise<void> {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
  }
}
