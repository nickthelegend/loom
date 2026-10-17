/**
 * What Loom's "Auto" lets an agent do, for the CLIs whose own Auto stops at
 * file edits (Claude Code's acceptEdits asks about every other tool, and Auto
 * never stops to ask — so before this, Auto refused every command that wasn't
 * read-only, and an agent could never run its own tests).
 *
 * Auto means the same thing it means for Codex (workspace-write): edit files
 * and run commands **inside the project**. Refused, with the rule that fired:
 *
 *   - a path outside the project (unless it's one of the project's readPaths —
 *     sibling folders an agent may read, never write),
 *   - a command that can't be taken back (the Blast-Radius Shield's list),
 *   - an MCP tool nobody allowed.
 *
 * `permissions.allow` in .loom/config.json allows more: a command prefix
 * ("docker compose up"), a tool name ("WebFetch"), or a glob ("mcp__github__*").
 * It never overrides the destructive-command rule. Pure.
 */

import path from "node:path";
import os from "node:os";
import { dangerOf } from "./shield.js";

export interface AutoPolicy {
  projectDir: string;
  /** Extra folders the agent may read (absolute). */
  readPaths: string[];
  /** Commands, tools or globs explicitly allowed (permissions.allow, plus the project's test command). */
  allow: string[];
}

export type AutoDecision = { allow: true; rule?: string } | { allow: false; rule: string; detail: string };

const READ_TOOLS = new Set(["Read", "Glob", "Grep", "LS", "NotebookRead"]);
const WRITE_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
/** Tools that touch nothing on disk, or that stay governed by this same policy (subagents ask here too). */
const SAFE_TOOLS = new Set(["Task", "Agent", "TodoWrite", "WebSearch", "WebFetch", "BashOutput", "KillShell", "KillBash", "ListMcpResourcesTool", "ReadMcpResourceTool", "SlashCommand", "Skill"]);
/** System locations a command may name without leaving the project: the tools themselves, temp, devices. */
const SYSTEM = ["/usr", "/bin", "/sbin", "/opt/homebrew", "/opt/local", "/Library/Developer", "/Applications/Xcode.app", "/dev", "/tmp", "/private/tmp", "/var/folders", "/private/var/folders", "/etc/hosts", "/System"];

const within = (p: string, root: string) => {
  const rel = path.relative(root, p);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
};

function resolveIn(dir: string, p: string): string {
  const home = os.homedir();
  const expanded = p === "~" ? home : p.startsWith("~/") ? path.join(home, p.slice(2)) : p.replace(/^\$HOME(?=\/|$)/, home);
  return path.resolve(dir, expanded);
}

/** Shell words, quotes respected: "a b" and 'a b' are one word; \  escapes a space. */
export function shellWords(command: string): string[] {
  const words: string[] = [];
  let cur = "", quote: string | null = null, any = false;
  for (let i = 0; i < command.length; i++) {
    const c = command[i]!;
    if (quote) {
      if (c === quote) quote = null;
      else if (c === "\\" && quote === '"' && i + 1 < command.length) cur += command[++i];
      else cur += c;
      continue;
    }
    if (c === "'" || c === '"') { quote = c; any = true; continue; }
    if (c === "\\" && i + 1 < command.length) { cur += command[++i]; any = true; continue; }
    if (/\s/.test(c) || ";&|<>()".includes(c)) { if (cur || any) words.push(cur); cur = ""; any = false; if (!/\s/.test(c)) words.push(c); continue; }
    cur += c; any = true;
  }
  if (cur || any) words.push(cur);
  return words;
}

/** Glob-ish match: "*" anywhere, otherwise a prefix on a word boundary ("npm test" allows "npm test -- --run"). */
export function allowMatches(pattern: string, value: string): boolean {
  const p = pattern.trim();
  if (!p) return false;
  if (p.includes("*")) return new RegExp("^" + p.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$").test(value);
  return value === p || value.startsWith(p + " ");
}

/** Where a path may be read or written from, given the policy. */
function placeOf(p: string, policy: AutoPolicy): "project" | "read" | "system" | "outside" {
  if (within(p, policy.projectDir)) return "project";
  if (policy.readPaths.some((r) => within(p, r))) return "read";
  if (SYSTEM.some((s) => within(p, s))) return "system";
  return "outside";
}

/** A command's working directory after a leading `cd X &&`, and the rest. */
function stripCd(words: string[], dir: string): { dir: string; rest: string[] } {
  let i = 0, cwd = dir;
  while (words[i] === "cd" && words[i + 1] !== undefined && (words[i + 2] === "&" || words[i + 2] === ";" || words[i + 2] === undefined)) {
    cwd = resolveIn(cwd, words[i + 1]!);
    i += 2;
    while (words[i] === "&" || words[i] === ";") i++;
  }
  return { dir: cwd, rest: words.slice(i) };
}

export function decideAuto(tool: string, input: Record<string, unknown>, policy: AutoPolicy): AutoDecision {
  const allowedByName = policy.allow.some((a) => allowMatches(a, tool));

  if (tool === "Bash") {
    const command = String(input.command ?? "").trim();
    if (!command) return { allow: true };
    const danger = dangerOf(command, policy.projectDir);
    if (danger) return { allow: false, rule: `a command that can't be taken back (${danger.what})`, detail: `\`${command.slice(0, 200)}\` — ${danger.why}` };
    const words = shellWords(command);
    const { dir, rest } = stripCd(words, policy.projectDir);
    const body = rest.filter((w) => !"&;|<>()".includes(w)).join(" ");
    if (policy.allow.some((a) => allowMatches(a, body) || allowMatches(a, command))) return { allow: true, rule: "permissions.allow" };
    if (placeOf(dir, policy) === "outside") return { allow: false, rule: "a command run outside the project", detail: `it changes directory to ${dir}` };
    for (const w of rest) {
      // a word that names a path: absolute, home-relative, or climbing out with ..
      const m = /^(?:[\w.-]+=)?((?:\/|~|\$HOME|\.\.)(?:[^\s]*))$/.exec(w);
      if (!m || /^\/\/|^\/?[a-z]+:\/\//i.test(m[1]!)) continue;
      const p = resolveIn(dir, m[1]!);
      const where = placeOf(p, policy);
      if (where === "outside") return { allow: false, rule: "a path outside the project", detail: `\`${m[1]}\` resolves to ${p}, outside ${policy.projectDir}${policy.readPaths.length ? " and its readPaths" : ""}` };
    }
    return { allow: true };
  }

  if (READ_TOOLS.has(tool) || WRITE_TOOLS.has(tool)) {
    const raw = input.file_path ?? input.path ?? input.notebook_path;
    if (typeof raw !== "string" || !raw) return { allow: true };
    const p = resolveIn(policy.projectDir, raw);
    const where = placeOf(p, policy);
    if (WRITE_TOOLS.has(tool)) {
      if (where === "project") return { allow: true };
      return { allow: false, rule: where === "read" ? "a write to a read-only path" : "a write outside the project", detail: `${tool} on ${p}${where === "read" ? " — readPaths can be read, not written" : ""}` };
    }
    if (where !== "outside") return { allow: true };
    return { allow: false, rule: "a read outside the project", detail: `${tool} on ${p} — add its folder to readPaths in .loom/config.json to allow it` };
  }

  if (SAFE_TOOLS.has(tool) || allowedByName) return { allow: true };
  if (tool.startsWith("mcp__")) return { allow: false, rule: "an MCP tool nobody allowed", detail: `${tool} — add it (or "mcp__server__*") to permissions.allow` };
  return { allow: false, rule: "a tool Auto doesn't cover", detail: `${tool} — add it to permissions.allow` };
}

/** The refusal the agent reads: what fired, on what, and how to allow it. */
export function refusalText(d: Extract<AutoDecision, { allow: false }>): string {
  return `Loom's Auto mode refused ${d.rule}: ${d.detail}. Auto edits files and runs commands inside the project; ` +
    `to allow more, add it to permissions.allow (or a folder to readPaths) in .loom/config.json, or switch this agent to Always ask or Bypass.`;
}
