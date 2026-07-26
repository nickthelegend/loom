/**
 * Time-Travel Replay — reconstruct the fleet's exact state at any point by
 * folding the event log up to that moment. Snapshots aren't stored; they're
 * rebuilt on demand (a fold, like the brain). Scrub to a frame and you see who
 * held the baton, each agent's turns/cost, the decisions made so far, the brain's
 * top facts, and the thread — all as of that instant.
 */

import type { LoomEvent } from "../types.js";

export type AgentSnapState = {
  turnsCompleted: number;
  tokensUsed: number;
  costUsd: number;
  lastAction: string;
  status: "idle" | "active" | "waiting" | "errored";
};

export interface TimeSnapshot {
  timestampMs: number;
  turnIndex: number;
  eventIndex: number;
  batonHolder: string;
  decisionsAtPoint: string[];
  agentStates: Record<string, AgentSnapState>;
  memorySnapshot: { decisionsCount: number; keyFacts: string[] };
  threadLength: number;
  lastMessage: { agentId: string; text: string; timestamp: number } | null;
  /** Files that were untracked ("??") when a turn touched them — i.e. new. */
  filesCreatedSoFar: number;
  filesModifiedSoFar: number;
  triggerEvent: { type: string; agentId: string; description: string };
}

const SNAPSHOT_KINDS = new Set(["run_complete", "handoff", "error", "route_completed", "route_failed", "route_started"]);
const isDecisionStatus = (e: LoomEvent): boolean => e.kind === "status" && (e.payload as Record<string, unknown>).state === "agent_decision";
const isHealStatus = (e: LoomEvent): boolean =>
  e.kind === "status" && ["alert_intervention", "alert_recovery"].includes(String((e.payload as Record<string, unknown>).state));

function describeEvent(e: LoomEvent): string {
  const p = e.payload as Record<string, unknown>;
  const agent = e.agentId ?? String(p.agentId ?? "system");
  switch (e.kind) {
    case "run_complete": return `${agent} completed turn`;
    case "handoff": return p.from ? `baton · ${String(p.from)} → ${String(p.to ?? "—")}` : `baton · ${String(p.to ?? "agent")} takes it first`;
    case "error": return `${agent} errored: ${String(p.message ?? "").slice(0, 60)}`;
    case "route_started": return "route started";
    case "route_completed": return "route completed";
    case "route_failed": return `route failed: ${String(p.error ?? p.reason ?? "")}`;
    case "status":
      if (isDecisionStatus(e)) return `${agent} decided: ${String(p.title ?? "")}`;
      if (p.state === "alert_intervention") return `⚡ Alert → baton off ${agent}`;
      if (p.state === "alert_recovery") return `✓ Recovery → ${agent}`;
      return String(p.state ?? "status");
    default: return e.kind;
  }
}

/** Fold the event log into a list of scrubatble snapshots. Pure. */
export function buildSnapshots(events: LoomEvent[]): TimeSnapshot[] {
  const snapshots: TimeSnapshot[] = [];
  let batonHolder: string | null = null;
  const agentStates: Record<string, AgentSnapState> = {};
  const decisionIds: string[] = [];
  let threadLength = 0;
  let lastMessage: TimeSnapshot["lastMessage"] = null;
  let filesCreated = 0;
  let filesModified = 0;
  let memoryFacts: string[] = [];

  const ensure = (id: string): AgentSnapState =>
    (agentStates[id] ??= { turnsCompleted: 0, tokensUsed: 0, costUsd: 0, lastAction: "", status: "idle" });

  for (let i = 0; i < events.length; i++) {
    const e = events[i]!;
    const p = e.payload as Record<string, unknown>;

    switch (e.kind) {
      case "handoff": {
        const to = String(p.to ?? p.agent ?? "");
        if (to) { batonHolder = to; ensure(to).status = "active"; }
        break;
      }
      case "run_complete": {
        const id = e.agentId ?? String(p.agentId ?? "");
        if (id) {
          const a = ensure(id);
          a.turnsCompleted += 1;
          a.tokensUsed += Number(p.inputTokens ?? 0) + Number(p.outputTokens ?? 0);
          a.costUsd += Number(p.costUsd ?? 0);
          a.lastAction = `Completed turn ${a.turnsCompleted}`;
          a.status = "idle";
        }
        break;
      }
      case "turn_diff": {
        // A turn_diff carries ChangedFile[] — a porcelain XY status and a path.
        // "??" is git's code for a file that wasn't tracked before this turn,
        // which is the only thing in the log that means "created". Counting it
        // is what makes `filesCreatedSoFar` a real number: it was initialised to
        // 0, never incremented, and shipped through the API as a count of
        // created files that was structurally always zero.
        const files = Array.isArray(p.files) ? (p.files as Array<string | { status?: string }>) : [];
        filesModified += files.length; // Loom attributes tree changes per turn
        for (const f of files) {
          if (typeof f !== "string" && String(f?.status ?? "").trim() === "??") filesCreated += 1;
        }
        break;
      }
      case "message": {
        threadLength += 1;
        lastMessage = { agentId: e.agentId ?? "user", text: String(p.text ?? "").slice(0, 200), timestamp: e.ts };
        break;
      }
      case "memory_add":
      case "memory_import": {
        const fact = String(p.text ?? p.file ?? p.kind ?? "").slice(0, 80);
        if (fact) memoryFacts = [fact, ...memoryFacts].slice(0, 3);
        break;
      }
      case "error": {
        if (e.agentId) { const a = ensure(e.agentId); a.status = "errored"; a.lastAction = `Error: ${String(p.message ?? "unknown").slice(0, 50)}`; }
        break;
      }
      case "status": {
        if (isDecisionStatus(e) && p.decisionId) decisionIds.push(String(p.decisionId));
        break;
      }
    }

    const snapWorthy = SNAPSHOT_KINDS.has(e.kind) || isDecisionStatus(e) || isHealStatus(e);
    if (!snapWorthy) continue;

    snapshots.push({
      timestampMs: e.ts,
      turnIndex: Object.values(agentStates).reduce((s, a) => s + a.turnsCompleted, 0),
      eventIndex: i,
      batonHolder: batonHolder ?? "none",
      decisionsAtPoint: [...decisionIds],
      agentStates: JSON.parse(JSON.stringify(agentStates)) as Record<string, AgentSnapState>,
      memorySnapshot: { decisionsCount: decisionIds.length, keyFacts: [...memoryFacts] },
      threadLength,
      lastMessage,
      filesCreatedSoFar: filesCreated,
      filesModifiedSoFar: filesModified,
      triggerEvent: { type: isDecisionStatus(e) ? "decision" : e.kind, agentId: e.agentId ?? String(p.agentId ?? "system"), description: describeEvent(e) },
    });
  }

  return snapshots;
}
