import type { LoomEvent } from "../../types.js";

/** Map the existing journal vocabulary; no second event bus or GitHub poller. */
export function automationEvents(e: LoomEvent): string[] {
  const p = e.payload, out: string[] = [];
  if (e.kind === "run_complete") out.push(p.error ? "turn_failed" : "turn_finished");
  if (e.kind === "error" && e.agentId) out.push("turn_failed");
  if (e.kind === "needs_input" || (e.kind === "approval" && p.phase === "requested")) out.push("needs_you");
  if (e.kind === "approval" && p.phase === "decided" && p.behavior === "deny" && /^No answer within /.test(String(p.message))) out.push("approval_expired");
  if (e.kind === "orchestra") {
    if (["completed", "failed", "aborted"].includes(String(p.phase))) out.push("run_completed");
    if (p.phase === "waiting") out.push("needs_you");
    if (p.phase === "delivered" && p.pr) out.push("pr_opened");
    const landing = p.landing as { state?: string; checks?: { failing?: unknown[] } } | undefined;
    if (p.phase === "landing" && landing?.state === "merged") out.push("pr_merged");
    if (p.phase === "landing" && landing?.checks?.failing?.length) out.push("ci_failed");
  }
  return out;
}
