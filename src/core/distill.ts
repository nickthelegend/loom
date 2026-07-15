/**
 * Projection rendering — template (default) or LLM-synthesized.
 *
 * The LLM path asks a small Claude model to distill the recent log into a
 * dense handoff document (mission, state, decisions, risks, next moves).
 * It sits behind the SAME interface as the template and falls back to it on
 * any failure — a missing/broken/slow Claude must never break a handoff.
 *
 * Enable per project in .loom/config.json:
 *   "projection": { "mode": "llm", "model": "haiku" }
 */

import type { LoomEvent, ProjectionConfig } from "../types.js";
import { claudeText } from "./claude-cli.js";
import { buildProjection, type ProjectionInput } from "./projection.js";

const MAX_TRANSCRIPT_EVENTS = 60;
const MAX_LINE_CHARS = 300;

export interface RenderedProjection {
  content: string;
  mode: "template" | "llm";
}

function managedHeader(input: ProjectionInput): string {
  return [
    `# Loom shared context — ${input.projectName}`,
    "",
    "> Managed by Loom. Do not edit — regenerated on every baton handoff.",
    `> You are \`${input.targetAgentId}\`. This is the shared state of the project across all agents.`,
    "",
  ].join("\n");
}

function transcriptDigest(events: LoomEvent[]): string {
  const interesting = events.filter((e) =>
    ["message", "decision", "handoff", "file_edit", "route_started", "route_completed"].includes(
      e.kind,
    ),
  );
  return interesting
    .slice(-MAX_TRANSCRIPT_EVENTS)
    .map((e) => {
      const who = e.agentId ?? String(e.payload.author ?? "user");
      if (e.kind === "message") {
        return `${who}: ${String(e.payload.text ?? "").replace(/\s+/g, " ").slice(0, MAX_LINE_CHARS)}`;
      }
      if (e.kind === "decision") return `DECISION: ${String(e.payload.text ?? "")}`;
      if (e.kind === "file_edit") return `EDIT: ${String(e.payload.path ?? "")}`;
      if (e.kind === "handoff") {
        return `HANDOFF: ${String(e.payload.from ?? "—")} -> ${String(e.payload.to ?? "—")}`;
      }
      return `${e.kind.toUpperCase()}: ${String(e.payload.task ?? "")}`;
    })
    .join("\n");
}

function distillPrompt(input: ProjectionInput): string {
  const roles = input.config.agents.map((a) => `- ${a.id} (${a.kind}) — ${a.role}`).join("\n");
  return [
    "You are Loom's memory distiller. Multiple coding agents share one project; the baton",
    `is being handed to agent "${input.targetAgentId}". Distill the transcript below into the`,
    "handoff document that agent needs. Be dense and concrete; no fluff, no preamble.",
    "",
    "Write EXACTLY these markdown sections:",
    "## Mission — what the humans actually want (1-3 sentences)",
    "## Current state — what has been done / where things stand",
    "## Decisions — every standing decision, one bullet each (keep ALL of them)",
    "## Open questions & risks — unresolved threads the next agent must know",
    "## Next moves — what the incoming agent should do first",
    "",
    "Under 500 words total. Base it ONLY on the transcript; do not invent facts.",
    "",
    "Agents & roles:",
    roles,
    "",
    "Transcript (oldest first):",
    transcriptDigest(input.events),
  ].join("\n");
}

/** Render a projection per the project's configured mode, falling back to the template. */
export async function renderProjection(
  input: ProjectionInput,
  cfg?: ProjectionConfig,
): Promise<RenderedProjection> {
  if (cfg?.mode !== "llm") {
    return { content: buildProjection(input), mode: "template" };
  }
  try {
    const body = await claudeText(distillPrompt(input), {
      model: cfg.model ?? "haiku",
      timeoutMs: cfg.timeoutMs ?? 45_000,
    });
    const trimmed = body.trim();
    if (trimmed.length < 80 || !/##\s/.test(trimmed)) {
      throw new Error("distillation came back malformed");
    }
    return { content: managedHeader(input) + trimmed + "\n", mode: "llm" };
  } catch {
    return { content: buildProjection(input), mode: "template" };
  }
}
