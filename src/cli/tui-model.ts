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

// ---------------------------------------------------------------------------
// ctrl+p command palette
// ---------------------------------------------------------------------------

export type PaletteAction =
  | { type: "shift"; agentId: string } // change selected agent
  | { type: "insert"; text: string } // drop a template into the input
  | { type: "command"; cmd: string }; // run a slash command immediately

export interface PaletteItem {
  id: string;
  label: string;
  hint?: string;
  action: PaletteAction;
}

export function paletteItems(
  agents: AgentStatus[],
  routeNames: string[],
  selected: string | null,
): PaletteItem[] {
  const items: PaletteItem[] = [];
  for (const a of switchableAgents(agents)) {
    if (a.id === selected) continue;
    items.push({
      id: `shift:${a.id}`,
      label: `shift → ${a.id}`,
      hint: a.role,
      action: { type: "shift", agentId: a.id },
    });
  }
  for (const name of routeNames) {
    items.push({
      id: `route:${name}`,
      label: `route: ${name}`,
      hint: "pipeline",
      action: { type: "insert", text: `/route ${name} ` },
    });
  }
  items.push(
    { id: "route:auto", label: "route: auto", hint: "LLM picks each hop", action: { type: "insert", text: "/route auto " } },
    { id: "route:custom", label: "route: custom steps…", hint: "a,b,c task", action: { type: "insert", text: "/route " } },
    { id: "decision", label: "decision…", hint: "pin to shared memory", action: { type: "insert", text: "/decision " } },
    { id: "cmd:agents", label: "agents", hint: "who's here", action: { type: "command", cmd: "agents" } },
    { id: "cmd:routes", label: "routes", hint: "named pipelines", action: { type: "command", cmd: "routes" } },
    { id: "cmd:interrupt", label: "interrupt", hint: "stop current turn", action: { type: "command", cmd: "interrupt" } },
    { id: "cmd:abort", label: "abort route", hint: "stop the pipeline", action: { type: "command", cmd: "abort" } },
    { id: "cmd:pair", label: "pair phone", hint: "QR in terminal", action: { type: "command", cmd: "pair" } },
    { id: "cmd:help", label: "help", action: { type: "command", cmd: "help" } },
    { id: "cmd:quit", label: "quit", hint: "daemon keeps running", action: { type: "command", cmd: "quit" } },
  );
  return items;
}

/** Substring beats subsequence; earlier match beats later; stable otherwise. */
export function filterPalette(items: PaletteItem[], query: string): PaletteItem[] {
  const q = query.trim().toLowerCase();
  if (!q) return items;
  const scored: Array<{ item: PaletteItem; rank: number; idx: number }> = [];
  for (const item of items) {
    const hay = `${item.label} ${item.hint ?? ""}`.toLowerCase();
    const idx = hay.indexOf(q);
    if (idx >= 0) {
      scored.push({ item, rank: 0, idx });
      continue;
    }
    let i = 0;
    for (const ch of hay) {
      if (ch === q[i]) i++;
      if (i === q.length) break;
    }
    if (i === q.length) scored.push({ item, rank: 1, idx: hay.length });
  }
  return scored.sort((a, b) => a.rank - b.rank || a.idx - b.idx).map((s) => s.item);
}
