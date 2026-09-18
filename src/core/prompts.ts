/**
 * The prompt manager — a clipboard manager for prompts.
 *
 * Two shelves, daemon-wide (a good prompt isn't a property of one project):
 *
 *  - **saved**: prompts you kept, titled, optionally pinned to the top, with a
 *    use count so the ones you reach for float up;
 *  - **recent**: every prompt you actually sent (chat turns, orchestra goals),
 *    newest first, de-duplicated, capped — the history you didn't have to
 *    remember to save.
 *
 * Stored in ~/.loom/prompts.json. Nothing leaves the machine.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { loomHome } from "./registry.js";

export interface SavedPrompt {
  id: string;
  title: string;
  text: string;
  pinned: boolean;
  uses: number;
  createdAt: number;
  lastUsed?: number;
}

export interface RecentPrompt {
  text: string;
  at: number;
  project?: string;
  mode?: "chat" | "orchestrate" | "plan";
}

interface PromptStore {
  saved: SavedPrompt[];
  recent: RecentPrompt[];
}

const RECENT_CAP = 200;
const TEXT_CAP = 20_000;

function file(): string {
  return path.join(loomHome(), "prompts.json");
}

function read(): PromptStore {
  try {
    const s = JSON.parse(fs.readFileSync(file(), "utf8")) as Partial<PromptStore>;
    return { saved: s.saved ?? [], recent: s.recent ?? [] };
  } catch {
    return { saved: [], recent: [] };
  }
}

function write(s: PromptStore): void {
  fs.mkdirSync(loomHome(), { recursive: true });
  const f = file();
  fs.writeFileSync(f + ".tmp", JSON.stringify(s, null, 2), { mode: 0o600 });
  fs.renameSync(f + ".tmp", f);
}

function titleFrom(text: string): string {
  const line = text.trim().split("\n")[0] ?? "";
  return line.length > 60 ? `${line.slice(0, 57)}…` : line || "Untitled prompt";
}

/** Saved (pinned first, then most-used, then newest) and recent, optionally filtered. */
export function listPrompts(q = ""): PromptStore {
  const s = read();
  const needle = q.trim().toLowerCase();
  const match = (t: string) => !needle || t.toLowerCase().includes(needle);
  const saved = s.saved
    .filter((p) => match(p.title) || match(p.text))
    .sort(
      (a, b) =>
        Number(b.pinned) - Number(a.pinned) ||
        b.uses - a.uses ||
        (b.lastUsed ?? b.createdAt) - (a.lastUsed ?? a.createdAt),
    );
  const recent = s.recent.filter((r) => match(r.text));
  return { saved, recent };
}

export function savePrompt(input: { title?: string; text: string; pinned?: boolean }): SavedPrompt {
  const text = String(input.text ?? "").trim().slice(0, TEXT_CAP);
  if (!text) throw new Error("a prompt needs text");
  const s = read();
  const existing = s.saved.find((p) => p.text === text);
  if (existing) {
    if (input.title?.trim()) existing.title = input.title.trim().slice(0, 80);
    if (typeof input.pinned === "boolean") existing.pinned = input.pinned;
    write(s);
    return existing;
  }
  const p: SavedPrompt = {
    id: crypto.randomBytes(5).toString("hex"),
    title: input.title?.trim().slice(0, 80) || titleFrom(text),
    text,
    pinned: Boolean(input.pinned),
    uses: 0,
    createdAt: Date.now(),
  };
  s.saved.push(p);
  write(s);
  return p;
}

export function updatePrompt(
  id: string,
  patch: { title?: string; text?: string; pinned?: boolean; used?: boolean },
): SavedPrompt {
  const s = read();
  const p = s.saved.find((x) => x.id === id);
  if (!p) throw new Error(`no saved prompt "${id}"`);
  if (typeof patch.title === "string" && patch.title.trim()) p.title = patch.title.trim().slice(0, 80);
  if (typeof patch.text === "string" && patch.text.trim()) p.text = patch.text.trim().slice(0, TEXT_CAP);
  if (typeof patch.pinned === "boolean") p.pinned = patch.pinned;
  if (patch.used) {
    p.uses++;
    p.lastUsed = Date.now();
  }
  write(s);
  return p;
}

export function deletePrompt(id: string): boolean {
  const s = read();
  const before = s.saved.length;
  s.saved = s.saved.filter((p) => p.id !== id);
  if (s.saved.length === before) return false;
  write(s);
  return true;
}

/** Remember a prompt that was actually sent. Duplicates move to the top. */
export function recordRecent(text: string, meta: { project?: string; mode?: RecentPrompt["mode"] } = {}): void {
  const t = String(text ?? "").trim().slice(0, TEXT_CAP);
  if (!t) return;
  try {
    const s = read();
    s.recent = [{ text: t, at: Date.now(), ...meta }, ...s.recent.filter((r) => r.text !== t)].slice(0, RECENT_CAP);
    write(s);
  } catch {
    /* history is a convenience — never fail a send over it */
  }
}

export function clearRecent(): void {
  const s = read();
  s.recent = [];
  write(s);
}
