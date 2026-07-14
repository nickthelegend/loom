/**
 * Projections — rendering the event log into (a) a persistent, namespaced
 * memory document for an agent, and (b) a short one-shot handoff briefing.
 *
 * v1 is deterministic (no LLM in the loop): a distillation template over the
 * recent log. An LLM-synthesized variant can slot in behind the same
 * signatures later.
 */

import type { LoomEvent, ProjectConfig } from "../types.js";

const MAX_MSG_CHARS = 300;
const RECENT_MESSAGES = 30;
const RECENT_FILES = 20;

function truncate(text: string, max = MAX_MSG_CHARS): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? oneLine.slice(0, max - 1) + "…" : oneLine;
}

function author(e: LoomEvent): string {
  return e.agentId ?? (e.payload.author as string | undefined) ?? "user";
}

export interface ProjectionInput {
  projectName: string;
  config: ProjectConfig;
  events: LoomEvent[]; // ascending; pass a recent window
  targetAgentId: string;
  fromAgentId?: string | null;
}

/** Persistent memory document written to .loom/memory/<agent>.md. */
export function buildProjection(input: ProjectionInput): string {
  const { projectName, config, events, targetAgentId } = input;

  const messages = events.filter((e) => e.kind === "message").slice(-RECENT_MESSAGES);
  const decisions = events.filter((e) => e.kind === "decision");
  const handoffs = events.filter((e) => e.kind === "handoff").slice(-5);
  const files = [
    ...new Set(
      events
        .filter((e) => e.kind === "file_edit")
        .map((e) => String(e.payload.path ?? ""))
        .filter(Boolean),
    ),
  ].slice(-RECENT_FILES);

  const lines: string[] = [];
  lines.push(`# Loom shared context — ${projectName}`);
  lines.push("");
  lines.push(
    "> Managed by Loom. Do not edit — regenerated on every baton handoff.",
    `> You are \`${targetAgentId}\`. This is the shared state of the project across all agents.`,
  );
  lines.push("");

  lines.push("## Agents & roles");
  for (const a of config.agents) {
    const marker = a.id === targetAgentId ? " ← you" : "";
    lines.push(`- \`${a.id}\` (${a.kind}) — ${a.role}${marker}`);
  }
  lines.push("");

  if (handoffs.length) {
    lines.push("## Recent baton handoffs");
    for (const h of handoffs) {
      const from = (h.payload.from as string | null) ?? "—";
      const to = (h.payload.to as string | null) ?? "—";
      lines.push(`- ${new Date(h.ts).toISOString()}: ${from} → ${to}`);
    }
    lines.push("");
  }

  if (decisions.length) {
    lines.push("## Decisions");
    for (const d of decisions) {
      lines.push(`- ${truncate(String(d.payload.text ?? ""))}`);
    }
    lines.push("");
  }

  if (messages.length) {
    lines.push("## Recent conversation (condensed)");
    for (const m of messages) {
      lines.push(`- **${author(m)}**: ${truncate(String(m.payload.text ?? ""))}`);
    }
    lines.push("");
  }

  if (files.length) {
    lines.push("## Files recently touched");
    for (const f of files) lines.push(`- \`${f}\``);
    lines.push("");
  }

  return lines.join("\n");
}

/** Short one-shot briefing injected with the first turn after a handoff. */
export function buildBriefing(input: ProjectionInput): string {
  const { projectName, events, targetAgentId, fromAgentId } = input;
  const messages = events.filter((e) => e.kind === "message").slice(-8);
  const decisions = events.filter((e) => e.kind === "decision").slice(-6);

  const lines: string[] = [];
  lines.push(
    `[Loom handoff] You are "${targetAgentId}" picking up the baton for project "${projectName}"` +
      (fromAgentId ? ` from "${fromAgentId}".` : "."),
  );
  lines.push(
    `A fuller shared-context document is at .loom/memory/${targetAgentId}.md — read it if you need more history.`,
  );
  if (decisions.length) {
    lines.push("Key decisions so far:");
    for (const d of decisions) lines.push(`- ${truncate(String(d.payload.text ?? ""), 200)}`);
  }
  if (messages.length) {
    lines.push("Most recent exchanges:");
    for (const m of messages) {
      lines.push(`- ${author(m)}: ${truncate(String(m.payload.text ?? ""), 200)}`);
    }
  }
  lines.push("Continue the work seamlessly; do not re-ask for context the log already answers.");
  return lines.join("\n");
}
