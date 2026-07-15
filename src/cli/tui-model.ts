/**
 * Pure view-model for the Loom TUI — everything here is testable without
 * rendering a single frame.
 */

import pc from "picocolors";
import type { AgentStatus } from "../types.js";

// ---------------------------------------------------------------------------
// Logo — "lo" dim, "om" bright, opencode-style block letters
// ---------------------------------------------------------------------------

const L = ["██    ", "██    ", "██    ", "██████"];
const O = ["▄████▄", "██  ██", "██  ██", "▀████▀"];
const M = ["▄█▄▄█▄", "██▀▀██", "██  ██", "██  ██"];

export const LOGO_WIDTH = 6 * 4 + 2 * 3; // 4 letters + 3 gaps

export function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

export function centerPad(line: string, width: number): string {
  const visible = stripAnsi(line).length;
  if (visible >= width) return line;
  return " ".repeat(Math.floor((width - visible) / 2)) + line;
}

/** The four logo rows, centered for the given terminal width. */
export function logoLines(width: number): string[] {
  const rows: string[] = [];
  for (let r = 0; r < 4; r++) {
    const dim = pc.dim(`${L[r]}  ${O[r]}`);
    const bright = pc.bold(`${O[r]}  ${M[r]}`);
    rows.push(centerPad(`${dim}  ${bright}`, width));
  }
  rows.push("");
  rows.push(centerPad(pc.dim("one thread · every agent"), width));
  return rows;
}

// ---------------------------------------------------------------------------
// Agent cycling (tab = shift agent/IDE)
// ---------------------------------------------------------------------------

export function switchableAgents(agents: AgentStatus[]): AgentStatus[] {
  return agents.filter((a) => a.tier === "adapter" && a.available);
}

/** Next (or previous) adapter in the cycle; null if none can take turns. */
export function cycleAgent(
  agents: AgentStatus[],
  currentId: string | null,
  dir: 1 | -1 = 1,
): string | null {
  const pool = switchableAgents(agents);
  if (!pool.length) return null;
  const idx = pool.findIndex((a) => a.id === currentId);
  if (idx === -1) return pool[0]!.id;
  return pool[(idx + dir + pool.length) % pool.length]!.id;
}

// ---------------------------------------------------------------------------
// Slash commands
// ---------------------------------------------------------------------------

export interface SlashCommand {
  cmd: string;
  args: string[];
  rest: string;
}

export function parseSlash(text: string): SlashCommand | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) return null;
  const [head = "", ...parts] = trimmed.slice(1).split(/\s+/);
  return { cmd: head.toLowerCase(), args: parts, rest: parts.join(" ") };
}

export const HELP_LINES = [
  pc.bold("  keys"),
  pc.dim("    tab / shift+tab   shift agent (handoff happens when you send)"),
  pc.dim("    enter             send · esc  interrupt · ctrl+c  quit"),
  pc.bold("  commands"),
  pc.dim("    /route <name|a,b,c> <task>   run a pipeline across agents"),
  pc.dim("    /routes                      list named pipelines"),
  pc.dim("    /handoff <agent>             pass the baton now"),
  pc.dim("    /agents                      who's in this project"),
  pc.dim("    /decision <text>             pin a fact into shared memory"),
  pc.dim("    /interrupt · /abort          stop the turn / stop the route"),
  pc.dim("    /pair                        QR-pair your phone"),
  pc.dim("    /quit                        leave (daemon keeps running)"),
];

/** Rendered value with a block cursor, opencode-style. */
export function renderInput(value: string, cursor: number, placeholder: string): string {
  if (!value) {
    return pc.inverse(placeholder.charAt(0) || " ") + pc.dim(placeholder.slice(1));
  }
  const before = value.slice(0, cursor);
  const at = value.charAt(cursor) || " ";
  const after = value.length > cursor ? value.slice(cursor + 1) : "";
  return before + pc.inverse(at) + after;
}

export const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
