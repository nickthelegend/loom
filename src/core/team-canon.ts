/**
 * Loom Teams, Phase 3 — canon: the memories every agent on the team treats as
 * law, living in the repo where people review them.
 *
 * D44: the source of truth is a Loom-managed section of AGENTS.md on the
 * default branch. Each line carries a hidden `<!-- loom:m:<id> -->` marker so
 * it round-trips through Loom; a human editing or deleting a line in any PR is
 * a real canon change, and a line a human adds by hand (no marker) is canon
 * too. AGENTS.md is the cross-vendor convention, so agents outside Loom —
 * Codex, Cursor, Jules, Copilot — read the same canon. D46: CLAUDE.md gets an
 * `@AGENTS.md` import so Claude Code does as well.
 *
 * Pure text in, text out — the daemon does the git.
 */

import crypto from "node:crypto";

import type { MemoryKind } from "./brain.js";

export const CANON_START = "<!-- loom:canon";
export const CANON_END = "<!-- /loom:canon -->";

export interface CanonEntry {
  id: string;
  kind: MemoryKind;
  text: string;
}

const HEADINGS: Array<[MemoryKind, string]> = [
  ["constraint", "Constraints"],
  ["failure", "Known failures — don't repeat these"],
  ["decision", "Decisions"],
  ["convention", "Conventions"],
  ["fact", "Facts"],
];

function kindOfHeading(h: string): MemoryKind {
  const t = h.toLowerCase();
  if (t.startsWith("constraint")) return "constraint";
  if (t.startsWith("known failure") || t.startsWith("failure")) return "failure";
  if (t.startsWith("decision")) return "decision";
  if (t.startsWith("convention")) return "convention";
  return "fact";
}

/** A stable id for a line a human added without a marker. */
export function handEntryId(text: string): string {
  return "h" + crypto.createHash("sha256").update(text.trim().toLowerCase()).digest("hex").slice(0, 15);
}

/** The managed section's bounds in a document, or null when there isn't one. */
export function findSection(doc: string): { start: number; end: number } | null {
  const start = doc.indexOf(CANON_START);
  if (start < 0) return null;
  const endMarker = doc.indexOf(CANON_END, start);
  if (endMarker < 0) return null;
  return { start, end: endMarker + CANON_END.length };
}

/** Canon entries from an AGENTS.md (empty when it has no managed section). */
export function parseCanon(doc: string): CanonEntry[] {
  const sec = findSection(doc);
  if (!sec) return [];
  const out: CanonEntry[] = [];
  let kind: MemoryKind = "fact";
  for (const raw of doc.slice(sec.start, sec.end).split("\n")) {
    const line = raw.trim();
    const h = /^#{2,4}\s+(.+)$/.exec(line);
    if (h) {
      if (!/team canon/i.test(h[1]!)) kind = kindOfHeading(h[1]!);
      continue;
    }
    const item = /^[-*]\s+(.+)$/.exec(line);
    if (!item) continue;
    const marker = /<!--\s*loom:m:([A-Za-z0-9_-]{1,40})\s*-->/.exec(item[1]!);
    const text = item[1]!.replace(/<!--[\s\S]*?-->/g, "").trim();
    if (!text) continue;
    out.push({ id: marker?.[1] ?? handEntryId(text), kind, text });
  }
  return out;
}

/** The managed section for a set of entries, grouped by kind. */
export function renderCanon(entries: CanonEntry[]): string {
  const lines = [
    `${CANON_START} — team canon, managed by Loom. Change it through a PR; each line is one thing every agent treats as settled. -->`,
    "## Team canon",
    "",
  ];
  for (const [kind, heading] of HEADINGS) {
    const items = entries.filter((e) => e.kind === kind || (kind === "fact" && e.kind === "task"));
    if (!items.length) continue;
    lines.push(`### ${heading}`, "");
    for (const e of items) lines.push(`- ${e.text.replace(/\s+/g, " ").trim()} <!-- loom:m:${e.id} -->`);
    lines.push("");
  }
  lines.push(CANON_END);
  return lines.join("\n");
}

/**
 * Put the section into a document: replace the existing one, or append it at
 * the end — never touching anything a human wrote outside the markers.
 */
export function upsertCanon(doc: string, entries: CanonEntry[]): string {
  const body = renderCanon(entries);
  const sec = findSection(doc);
  if (sec) return doc.slice(0, sec.start) + body + doc.slice(sec.end);
  const base = doc.replace(/\s+$/, "");
  return (base ? `${base}\n\n` : "") + body + "\n";
}

/** Everything a human wrote: the document with the managed section cut out. */
export function withoutCanon(doc: string): string {
  const sec = findSection(doc);
  if (!sec) return doc;
  return (doc.slice(0, sec.start) + doc.slice(sec.end)).replace(/\n{3,}/g, "\n\n").trim();
}

/** D46: the CLAUDE.md line that makes Claude Code read AGENTS.md. Null when nothing to change. */
export function withClaudeImport(claudeMd: string): string | null {
  if (/^\s*@AGENTS\.md\s*$/m.test(claudeMd)) return null;
  return `${claudeMd.replace(/\s+$/, "")}\n\n@AGENTS.md\n`;
}
