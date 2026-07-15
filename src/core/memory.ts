/**
 * Unified memory — "multiple memory in one".
 *
 * Every AI dev environment (ADE) keeps its own memory: Claude Code has
 * CLAUDE.md, OpenCode has AGENTS.md, others have their own files. Loom's job
 * is to make those ONE brain: it imports each connected ADE's native memory
 * into the shared event log, merges it with the project's decisions and
 * recent context, and projects the union back out on every handoff.
 *
 * Connect a new ADE → its existing knowledge joins the shared brain, and
 * everything the other agents learned flows into it. That's the seam an
 * isolation-first tool (separate worktrees) structurally can't own.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type {
  AgentConfig,
  LoomEvent,
  MemorySource,
  ProjectConfig,
  UnifiedMemory,
} from "../types.js";

const MAX_IMPORT_CHARS = 8_000; // per source, keeps the brain bounded
const RECENT_DECISIONS = 40;

/**
 * Where each ADE keeps its native, project-local memory. Project-scoped only
 * by default — global files (e.g. ~/.claude/CLAUDE.md) are intentionally NOT
 * imported so the shared brain stays about THIS project. Override per agent
 * with `memoryFiles` in config.
 */
const NATIVE_MEMORY: Record<string, string[]> = {
  "claude-code": ["CLAUDE.md", ".claude/CLAUDE.md", "AGENTS.md"],
  opencode: ["AGENTS.md", ".opencode/AGENTS.md", "opencode.md"],
  antigravity: [".antigravity/memory.md", "AGENTS.md", ".windsurfrules"],
  echo: [],
};

export function nativeMemoryFiles(agent: AgentConfig): string[] {
  if (agent.memoryFiles) return agent.memoryFiles;
  return NATIVE_MEMORY[agent.kind] ?? ["AGENTS.md"];
}

export interface ImportedBlock {
  agentId: string;
  kind: string;
  file: string;
  content: string;
}

/**
 * Read every configured ADE's native memory from disk. Deduplicates by file
 * path (agents commonly share AGENTS.md) — the first agent to claim a file
 * owns it in the brain.
 */
export function readNativeMemory(projectDir: string, config: ProjectConfig): ImportedBlock[] {
  const blocks: ImportedBlock[] = [];
  const seenFiles = new Set<string>();
  for (const agent of config.agents) {
    for (const rel of nativeMemoryFiles(agent)) {
      const norm = rel.replace(/^\.\//, "");
      if (seenFiles.has(norm)) continue;
      const abs = path.join(projectDir, norm);
      if (!fs.existsSync(abs)) continue;
      try {
        const raw = fs.readFileSync(abs, "utf8").trim();
        if (!raw) continue;
        seenFiles.add(norm);
        blocks.push({
          agentId: agent.id,
          kind: agent.kind,
          file: norm,
          content: raw.length > MAX_IMPORT_CHARS ? raw.slice(0, MAX_IMPORT_CHARS) + "\n… (truncated)" : raw,
        });
      } catch {
        // Unreadable file — skip, never fatal.
      }
    }
  }
  return blocks;
}

export function hashContent(content: string): string {
  return crypto.createHash("sha1").update(content).digest("hex").slice(0, 12);
}

/**
 * Build the unified brain document from the log + freshly-read native memory.
 * This is what "multiple memory in one" produces, and what enriches every
 * handoff projection.
 */
export function buildUnifiedMemory(
  projectName: string,
  events: LoomEvent[],
  imported: ImportedBlock[],
): UnifiedMemory {
  const decisions = events
    .filter((e) => e.kind === "decision")
    .map((e) => String(e.payload.text ?? ""))
    .filter(Boolean)
    .slice(-RECENT_DECISIONS);

  const sources: MemorySource[] = imported.map((b) => ({
    agentId: b.agentId,
    kind: b.kind,
    file: b.file,
    chars: b.content.length,
  }));

  const lines: string[] = [];
  lines.push(`# Loom unified memory — ${projectName}`);
  lines.push("");
  lines.push(
    "> One brain across every connected agent. Merged from each ADE's native memory,",
    "> the project's decisions, and the shared thread. Regenerated on demand.",
  );
  lines.push("");

  if (decisions.length) {
    lines.push("## Decisions (shared across all agents)");
    for (const d of decisions) lines.push(`- ${d}`);
    lines.push("");
  }

  if (imported.length) {
    lines.push("## Imported from connected ADEs");
    for (const b of imported) {
      lines.push(`### ${b.agentId} · \`${b.file}\` (${b.kind})`);
      lines.push("");
      lines.push(b.content);
      lines.push("");
    }
  }

  if (!decisions.length && !imported.length) {
    lines.push("_No decisions recorded yet and no ADE memory files found._");
    lines.push("");
  }

  return { projectName, decisions, sources, document: lines.join("\n") };
}
