/**
 * Searching a project: its code, and its conversations.
 *
 * The rail could find a file by name and nothing else, which is the least
 * useful half of search — you almost always remember a line, not a filename.
 * And the thread, which is where the actual reasoning of a project lives, was
 * not searchable at all.
 *
 * ## Code: git grep, then a walk
 *
 * `git grep` is the right tool in a repo and it isn't close: it's fast, it
 * already ignores .gitignore, and it never descends into node_modules. Outside
 * a repo there's no index to lean on, so the fallback walks — with hard caps,
 * because a search box that hangs the daemon on a home directory is worse than
 * one that says "too many results".
 *
 * ## Chats: the event log
 *
 * Messages are events, so searching chats is scanning the log. No index: a
 * project's log is thousands of rows, not millions, and a substring scan over
 * that is microseconds. When that stops being true, this is the function to
 * change, and it will be obvious.
 */

import { execFile } from "./process.js";
import fs from "node:fs";
import path from "node:path";
import type { EventStore } from "./eventlog.js";
import type { LoomEvent } from "../types.js";

export interface CodeHit {
  path: string;
  line: number;
  text: string;
}

export interface ChatHit {
  chat: string;
  eventId: number;
  at: number;
  kind: string;
  agentId: string | null;
  /** The matching text, trimmed around the hit. */
  snippet: string;
}

const MAX_HITS = 200;
const MAX_LINE = 400;

/** Directories no one wants in a code search, ever. */
const SKIP = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  ".next",
  ".cache",
  "coverage",
  ".loom",
  "vendor",
]);

/**
 * Search file contents.
 *
 * Case-insensitive and fixed-string, not regex: the box is a search box, and
 * someone typing `foo(bar)` means those characters. A regex there would turn a
 * paren into a syntax error and blame them for it.
 */
export async function searchCode(dir: string, query: string): Promise<{ hits: CodeHit[]; truncated: boolean }> {
  const q = query.trim();
  if (!q) return { hits: [], truncated: false };

  const viaGit = await gitGrep(dir, q);
  if (viaGit) return viaGit;
  return walkGrep(dir, q);
}

function gitGrep(dir: string, q: string): Promise<{ hits: CodeHit[]; truncated: boolean } | null> {
  return new Promise((resolve) => {
    execFile(
      "git",
      [
        "grep",
        "--no-color",
        "-I", // skip binaries
        "-n", // line numbers
        "-i", // case-insensitive
        "-F", // fixed string: what they typed is what they meant
        "--untracked", // a file you just wrote is still your code
        "-e",
        q,
      ],
      { cwd: dir, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout) => {
        // exit 1 means "no matches", which is an answer, not a failure. Any
        // other error (not a repo, no git) means fall back to the walk.
        const code = (err as { code?: number } | null)?.code;
        if (err && code !== 1) return resolve(null);
        const lines = String(stdout).split("\n").filter(Boolean);
        const hits: CodeHit[] = [];
        for (const line of lines) {
          if (hits.length >= MAX_HITS) break;
          // path:line:text — and a path may contain colons, so split from the
          // left exactly twice rather than on every colon.
          const first = line.indexOf(":");
          const second = line.indexOf(":", first + 1);
          if (first < 0 || second < 0) continue;
          const file = line.slice(0, first);
          const num = Number(line.slice(first + 1, second));
          if (!Number.isFinite(num)) continue;
          if (SKIP.has(file.split("/")[0] ?? "")) continue;
          hits.push({ path: file, line: num, text: line.slice(second + 1).slice(0, MAX_LINE).trim() });
        }
        resolve({ hits, truncated: lines.length > hits.length });
      },
    );
  });
}

/** No git: walk it, carefully. */
function walkGrep(dir: string, q: string): { hits: CodeHit[]; truncated: boolean } {
  const needle = q.toLowerCase();
  const hits: CodeHit[] = [];
  let scanned = 0;
  let truncated = false;

  const walk = (current: string): void => {
    if (hits.length >= MAX_HITS || scanned >= 4000) {
      truncated = true;
      return;
    }
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return; // unreadable dir is not worth an exception
    }
    for (const e of entries) {
      if (hits.length >= MAX_HITS || scanned >= 4000) {
        truncated = true;
        return;
      }
      if (e.name.startsWith(".") && e.name !== ".env.example") continue;
      const full = path.join(current, e.name);
      if (e.isDirectory()) {
        if (!SKIP.has(e.name)) walk(full);
        continue;
      }
      if (!e.isFile()) continue;
      scanned++;
      let body: string;
      try {
        const stat = fs.statSync(full);
        if (stat.size > 1024 * 1024) continue; // a megabyte of one file isn't source
        body = fs.readFileSync(full, "utf8");
      } catch {
        continue; // binary or gone: not a match, not an error
      }
      if (body.includes("\0")) continue; // binary
      const lines = body.split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (hits.length >= MAX_HITS) {
          truncated = true;
          return;
        }
        const line = lines[i] ?? "";
        if (line.toLowerCase().includes(needle)) {
          hits.push({
            path: path.relative(dir, full),
            line: i + 1,
            text: line.slice(0, MAX_LINE).trim(),
          });
        }
      }
    }
  };
  walk(dir);
  return { hits, truncated };
}

/**
 * Search the conversations.
 *
 * Every kind of event with text in it, not just your messages: an agent's
 * reply, the tool it ran, the error it hit. What you remember about a project
 * is rarely the sentence you typed — it's the answer you got.
 */
export function searchChats(
  log: Pick<EventStore, "list">,
  query: string,
  opts: { chat?: string; limit?: number } = {},
): { hits: ChatHit[]; truncated: boolean } {
  const q = query.trim().toLowerCase();
  if (!q) return { hits: [], truncated: false };
  const limit = opts.limit ?? 100;

  // one chat's search reads that chat, not the newest 20,000 events of the project
  const events = log.list({ limit: 20_000, ...(opts.chat ? { chat: opts.chat } : {}) });
  const hits: ChatHit[] = [];
  let truncated = false;

  // Newest first: you're looking for something you saw recently, nearly always.
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (!e) continue;
    if (opts.chat && (e.chat ?? "main") !== opts.chat) continue;
    const text = textOf(e);
    if (!text) continue;
    const at = text.toLowerCase().indexOf(q);
    if (at < 0) continue;
    if (hits.length >= limit) {
      truncated = true;
      break;
    }
    hits.push({
      chat: e.chat ?? "main",
      eventId: e.id,
      at: e.ts,
      kind: e.kind,
      agentId: e.agentId ?? null,
      snippet: snippet(text, at, q.length),
    });
  }
  return { hits, truncated };
}

/** The searchable text of an event, whatever kind it is. */
function textOf(e: LoomEvent): string {
  const p = e.payload ?? {};
  const candidates = [p.text, p.message, p.summary, p.question, p.tool, p.path];
  for (const c of candidates) {
    if (typeof c === "string" && c.trim()) return c;
  }
  return "";
}

/**
 * A window around the match.
 *
 * Enough either side to recognise it, and an ellipsis when there's more — a
 * result that shows the first 80 characters of a 4KB reply is a result you
 * can't identify.
 */
function snippet(text: string, at: number, len: number): string {
  const pad = 60;
  const start = Math.max(0, at - pad);
  const end = Math.min(text.length, at + len + pad);
  return (start > 0 ? "…" : "") + text.slice(start, end).replace(/\s+/g, " ").trim() + (end < text.length ? "…" : "");
}
