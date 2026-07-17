/**
 * Pure view-model for the Loom TUI — everything here is testable without
 * rendering a single frame.
 */

import pc from "picocolors";
import type { AgentStatus } from "../types.js";
import { BOARD_COLUMNS, type BoardCard, type BoardColumn, type BoardData } from "../daemon/board.js";
import type { Memory, MemoryKind } from "../core/brain.js";

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
  pc.dim("    shift+tab         switch view: Thread · Board · Brain · Diff"),
  pc.dim("    tab               shift agent (handoff happens when you send)"),
  pc.dim("    pgup / pgdn       scroll the view · enter send · esc back/interrupt"),
  pc.dim("    ctrl+p palette    ·  ctrl+c quit"),
  pc.bold("  commands"),
  pc.dim("    /board · /brain · /diff · /thread   jump to a view"),
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
  | { type: "command"; cmd: string } // run a slash command immediately
  | { type: "view"; view: ViewName }; // switch the active tab

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
  items.push(
    { id: "view:thread", label: "go to Thread", hint: "the conversation", action: { type: "view", view: "thread" } },
    { id: "view:board", label: "go to Board", hint: "agents · issues · PRs", action: { type: "view", view: "board" } },
    { id: "view:brain", label: "go to Brain", hint: "learned memory", action: { type: "view", view: "brain" } },
    { id: "view:diff", label: "go to Diff", hint: "working tree", action: { type: "view", view: "diff" } },
  );
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

// ---------------------------------------------------------------------------
// Views — the tabbed faces of the TUI (Thread · Board · Brain · Diff)
// ---------------------------------------------------------------------------

export type ViewName = "thread" | "board" | "brain" | "diff";
export const VIEWS: ViewName[] = ["thread", "board", "brain", "diff"];
const VIEW_LABEL: Record<ViewName, string> = {
  thread: "Thread",
  board: "Board",
  brain: "Brain",
  diff: "Diff",
};

/** The tab strip — active tab bright and underlined, the rest dim. */
export function renderTabs(active: ViewName): string {
  return (
    "  " +
    VIEWS.map((v, i) => {
      const label = `${i + 1} ${VIEW_LABEL[v]}`;
      return v === active ? pc.cyan(pc.bold(pc.underline(label))) : pc.dim(label);
    }).join(pc.dim("   "))
  );
}

/** Next/previous view in the tab order — wraps. */
export function cycleView(current: ViewName, dir: 1 | -1 = 1): ViewName {
  const i = VIEWS.indexOf(current);
  return VIEWS[(i + dir + VIEWS.length) % VIEWS.length]!;
}

function truncate(s: string, width: number): string {
  const vis = stripAnsi(s);
  if (vis.length <= width) return s;
  // Truncating colored text safely is fiddly; when it's plain, cut precisely,
  // otherwise cut the visible tail and let the reset ride along.
  if (s === vis) return s.slice(0, Math.max(0, width - 1)) + "…";
  return s.slice(0, Math.max(0, width - 1)) + pc.reset("…");
}

// ── Board ──────────────────────────────────────────────────────────────────

const COLUMN_LABEL: Record<BoardColumn, string> = {
  working: "Working",
  "needs-you": "Needs you",
  "in-review": "In review",
  ready: "Ready",
};

function cardBadge(c: BoardCard): string {
  if (c.pr) return pc.dim(`PR #${c.pr.number}`);
  if (c.issue) return pc.dim(`#${c.issue.number}`);
  if (c.own) return pc.dim("card");
  return pc.dim(c.kind ?? "agent");
}

/** The board as columns of cards. Empty columns are kept, so the flow reads. */
export function formatBoard(board: BoardData, width = 80): string[] {
  const out: string[] = [];
  const repo = board.repo ? pc.dim(` · ${board.repo}`) : "";
  out.push(pc.bold("  Board") + repo, "");
  if (board.ghError) {
    out.push(pc.yellow(`  GitHub: ${board.ghError.detail}`) + pc.dim(" (agent cards still live)"), "");
  }
  const byCol = new Map<BoardColumn, BoardCard[]>();
  for (const col of BOARD_COLUMNS) byCol.set(col, []);
  for (const c of board.cards) byCol.get(c.column)?.push(c);
  for (const col of BOARD_COLUMNS) {
    const cards = byCol.get(col) ?? [];
    out.push(`  ${pc.cyan(pc.bold(COLUMN_LABEL[col]))} ${pc.dim(`(${cards.length})`)}`);
    if (!cards.length) out.push(pc.dim("    —"));
    for (const c of cards) {
      const line = `    ${badgeDot(c.state)} ${truncate(c.title, width - 18)}  ${cardBadge(c)}`;
      out.push(line);
    }
    out.push("");
  }
  if (!board.cards.length) out.push(pc.dim("  nothing on the board yet — agents, your cards, issues and PRs land here"));
  return out;
}

function badgeDot(state: BoardData["cards"][number]["state"]): string {
  switch (state) {
    case "working":
      return pc.yellow("●");
    case "input-needed":
      return pc.magenta("◆");
    case "ci-failed":
    case "changes-requested":
      return pc.red("▲");
    case "approved":
    case "ready":
      return pc.green("✔");
    default:
      return pc.dim("○");
  }
}

// ── Brain ──────────────────────────────────────────────────────────────────

const KIND_ORDER: MemoryKind[] = ["constraint", "failure", "decision", "convention", "fact", "task"];
const KIND_HEAD: Record<MemoryKind, string> = {
  constraint: "Constraints",
  failure: "Failures — do not repeat",
  decision: "Decisions",
  convention: "Conventions",
  fact: "Facts",
  task: "Task notes",
};

/** The learned memory units, grouped by kind, with confidence and who learned it. */
export function formatBrain(
  memories: Memory[],
  stats: { total: number; byKind: Record<string, number> } | null,
  width = 80,
): string[] {
  const out: string[] = [];
  const total = stats?.total ?? memories.length;
  out.push(pc.bold("  Brain") + pc.dim(`  ${total} memor${total === 1 ? "y" : "ies"} learned`), "");
  if (!memories.length) {
    out.push(
      pc.dim("  nothing learned yet — the brain fills in as agents finish turns,"),
      pc.dim("  or pin a fact with /decision <text>."),
    );
    return out;
  }
  const byKind = new Map<MemoryKind, Memory[]>();
  for (const m of memories) (byKind.get(m.kind) ?? byKind.set(m.kind, []).get(m.kind)!).push(m);
  for (const kind of KIND_ORDER) {
    const ms = byKind.get(kind);
    if (!ms?.length) continue;
    const head = kind === "failure" ? pc.red(pc.bold(KIND_HEAD[kind])) : pc.cyan(pc.bold(KIND_HEAD[kind]));
    out.push(`  ${head} ${pc.dim(`(${ms.length})`)}`);
    for (const m of ms) {
      const low = m.confidence < 0.6;
      const conf = low ? pc.dim(`  ~${m.confidence.toFixed(2)}`) : "";
      const who = pc.dim(` — ${m.provenance.agentId}`);
      const text = truncate(m.text, width - 6);
      out.push(`    ${low ? pc.dim("· ") : pc.dim("• ")}${low ? pc.dim(text) : text}${who}${conf}`);
    }
    out.push("");
  }
  return out;
}

// ── Diff ───────────────────────────────────────────────────────────────────

interface TreeShape {
  git: boolean;
  branch?: string;
  files: Array<{ status: string; path: string }>;
  patch: string;
  truncated: boolean;
}

/** The working tree: changed files, then a colorised unified diff. */
export function formatDiff(tree: TreeShape, width = 80): string[] {
  const out: string[] = [];
  if (!tree.git) {
    out.push(pc.bold("  Diff"), "", pc.dim("  not a git repository here."));
    return out;
  }
  out.push(pc.bold("  Source control") + (tree.branch ? pc.dim(`  on ${tree.branch}`) : ""), "");
  if (!tree.files.length) {
    out.push(pc.green("  ✔ working tree clean"));
    return out;
  }
  out.push(pc.cyan(pc.bold(`  Changes (${tree.files.length})`)));
  for (const f of tree.files) out.push(`    ${statusMark(f.status)} ${truncate(f.path, width - 8)}`);
  out.push("");
  if (tree.patch.trim()) {
    for (const raw of tree.patch.split("\n")) out.push("  " + colorDiffLine(truncate(raw, width - 2)));
    if (tree.truncated) out.push("", pc.dim("  … diff truncated — open the workspace for the rest."));
  }
  return out;
}

function statusMark(status: string): string {
  const s = status.trim().charAt(0).toUpperCase();
  if (s === "A" || s === "?") return pc.green("A");
  if (s === "D") return pc.red("D");
  if (s === "R") return pc.cyan("R");
  return pc.yellow("M");
}

function colorDiffLine(line: string): string {
  if (/^(\+\+\+|---)/.test(line)) return pc.dim(line);
  if (line.startsWith("@@")) return pc.cyan(line);
  if (line.startsWith("+")) return pc.green(line);
  if (line.startsWith("-")) return pc.red(line);
  if (line.startsWith("diff ") || line.startsWith("index ")) return pc.dim(line);
  return line;
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
