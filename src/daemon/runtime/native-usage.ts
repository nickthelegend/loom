/**
 * What each native harness last said about its context and its account:
 * tokens in context against the model's window, whether it is compacting right
 * now, and the provider's usage-limit windows.
 *
 * Adapters report these as status events (context_usage, compacting,
 * native_compacted, usage_limits). The thread renders the events themselves;
 * this keeps the latest reading so a project status can say it without the
 * client replaying the log. Limits belong to the provider account, not to an
 * agent, so only instances using the same config home share a reading.
 */

import type { AgentContextUsage, LoomEvent, ProviderLimits } from "../../types.js";

const PROVIDER: Record<string, string> = { codex: "codex", "claude-code": "claude" };
export const providerOf = (kind: string): string | undefined => PROVIDER[kind];

export class NativeUsage {
  private readonly contexts = new Map<string, AgentContextUsage>();
  private readonly limits = new Map<string, ProviderLimits>();

  constructor(private readonly accountOf: (agentId: string) => string | undefined = () => undefined) {}

  private key(provider: string, agentId?: string): string {
    return JSON.stringify([provider, agentId ? this.accountOf(agentId) ?? "default" : "default"]);
  }

  /** Fold one adapter event in. Unrelated events are ignored. */
  observe(event: Pick<LoomEvent, "kind" | "agentId" | "payload" | "ts">): void {
    const agent = event.agentId;
    if (!agent) return;
    const p = event.payload as Record<string, unknown>;
    const at = typeof event.ts === "number" ? event.ts : Date.now();
    const current = this.contexts.get(agent);
    const turnOver = event.kind === "run_complete" || event.kind === "error" || (event.kind === "status" && p.state === "interrupted");
    if (turnOver) {
      if (current?.compacting) this.contexts.set(agent, { ...current, compacting: false });
      return;
    }
    if (event.kind !== "status") return;
    switch (p.state) {
      case "context_usage":
        if (typeof p.usedTokens !== "number") return;
        this.contexts.set(agent, { usedTokens: p.usedTokens,
          maxTokens: typeof p.maxTokens === "number" ? p.maxTokens : current?.maxTokens ?? null,
          compacting: current?.compacting ?? false, compactedAt: current?.compactedAt ?? null, at });
        return;
      case "compacting":
        this.contexts.set(agent, { ...(current ?? { usedTokens: 0, maxTokens: null, compactedAt: null }), compacting: true, at });
        return;
      case "native_compacted":
        this.contexts.set(agent, { ...(current ?? { usedTokens: 0, maxTokens: null }),
          ...(typeof p.postTokens === "number" ? { usedTokens: p.postTokens } : {}), compacting: false, compactedAt: at, at });
        return;
      case "usage_limits": {
        if (typeof p.provider !== "string" || !Array.isArray(p.windows)) return;
        // A report can carry one window (Claude sends one per event): merge by id.
        const key = this.key(p.provider, agent);
        const previous = this.limits.get(key);
        const windows = new Map((previous?.windows ?? []).map(w => [w.id, w]));
        for (const w of p.windows as ProviderLimits["windows"]) if (w && typeof w.id === "string") windows.set(w.id, w);
        this.limits.set(key, { provider: p.provider, windows: [...windows.values()],
          reached: typeof p.reached === "string" ? p.reached : null, at });
        return;
      }
      default:
        return;
    }
  }

  context(agentId: string): AgentContextUsage | null { return this.contexts.get(agentId) ?? null; }
  limitsFor(kind: string, agentId?: string): ProviderLimits | null {
    const provider = providerOf(kind);
    return provider ? this.limits.get(this.key(provider, agentId)) ?? null : null;
  }
}
