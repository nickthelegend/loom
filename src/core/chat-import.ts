/**
 * Chats you had with your agents outside Loom, found on this machine and
 * brought into a project's thread list.
 *
 * Every agent CLI keeps its own history, and each session records the folder
 * it ran in, so a project can find the ones that belong to it:
 *
 *   Claude Code  ~/.claude/projects/<folder-slug>/<session>.jsonl   (each record has `cwd`)
 *   Codex        ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl        (session_meta.cwd)
 *   OpenCode     ~/.local/share/opencode/opencode.db                  (session.directory)
 *
 * Read-only, always: nothing here writes to another tool's files. Listing reads
 * only the head of each file (some run to hundreds of MB); importing streams it
 * and keeps the conversation — your words, the agent's replies, and one line
 * per tool call — not the tool output.
 *
 * Sessions Loom itself ran (its own Claude/OpenCode sessions, Codex threads it
 * started) are flagged `fromLoom`: they're already in the thread.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

export type ImportSource = "claude-code" | "codex" | "opencode";

export interface FoundChat {
  source: ImportSource;
  id: string;
  title: string;
  /** The folder it ran in (the project, or a folder inside it). */
  cwd: string;
  updatedAt: number;
  /** On-disk size, so a huge one can be told apart before importing. */
  bytes?: number;
  /** Started by a program rather than typed by you (Claude's SDK entrypoints). */
  automated?: boolean;
  /** One Loom ran — its turns are already in the thread. */
  fromLoom?: boolean;
}

export type ImportedItem =
  | { kind: "user"; ts: number; text: string }
  | { kind: "assistant"; ts: number; text: string; model?: string }
  | { kind: "tool"; ts: number; tool: string; summary: string };

export interface ImportedChat {
  source: ImportSource;
  id: string;
  title: string;
  items: ImportedItem[];
  /** Items left out past the cap, so the thread can say so. */
  dropped: number;
}

export interface ImportRoots {
  claude?: string;
  codex?: string;
  opencodeDb?: string;
}

const HOME_ROOTS = (): Required<ImportRoots> => ({
  claude: path.join(os.homedir(), ".claude", "projects"),
  codex: path.join(os.homedir(), ".codex", "sessions"),
  opencodeDb: path.join(os.homedir(), ".local", "share", "opencode", "opencode.db"),
});

const MAX_ITEMS = 2000;
const MAX_TEXT = 20_000;
const HEAD_BYTES = 96 * 1024;

const within = (dir: string, cwd: string): boolean => {
  const a = path.resolve(dir), b = path.resolve(cwd);
  return b === a || b.startsWith(a + path.sep);
};

const clip = (s: string, n: number): string => (s.length > n ? s.slice(0, n - 1) + "…" : s);

/** A title from someone's first words: one line, no markup noise. */
function titleFrom(text: string): string {
  const line = text.replace(/<[^>]+>[\s\S]*?<\/[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  return clip(line || "(untitled)", 80);
}

/** The first `n` bytes of a file, cut at the last whole line. */
function head(file: string, n = HEAD_BYTES): string[] {
  let fd: number | null = null;
  try {
    fd = fs.openSync(file, "r");
    const buf = Buffer.alloc(n);
    const got = fs.readSync(fd, buf, 0, n, 0);
    const text = buf.subarray(0, got).toString("utf8");
    const lines = text.split("\n");
    if (got === n) lines.pop(); // last one is cut
    return lines;
  } catch {
    return [];
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}

const parse = (line: string): Record<string, unknown> | null => {
  if (!line.trim()) return null;
  try {
    const o = JSON.parse(line);
    return o && typeof o === "object" ? (o as Record<string, unknown>) : null;
  } catch {
    return null;
  }
};

async function* lines(file: string): AsyncGenerator<Record<string, unknown>> {
  const rl = readline.createInterface({ input: fs.createReadStream(file, { encoding: "utf8" }), crlfDelay: Infinity });
  for await (const line of rl) {
    const o = parse(line);
    if (o) yield o;
  }
}

/** One line for a tool call, from whatever its input names. */
function toolSummary(input: unknown): string {
  if (typeof input === "string") {
    const j = parse(input);
    if (j) return toolSummary(j);
    return clip(input.replace(/\s+/g, " "), 120);
  }
  if (!input || typeof input !== "object") return "";
  const i = input as Record<string, unknown>;
  const cmd = Array.isArray(i.command) ? i.command.join(" ") : i.command ?? i.cmd;
  const v = cmd ?? i.file_path ?? i.filePath ?? i.path ?? i.pattern ?? i.query ?? i.url ?? i.description ?? i.prompt;
  if (typeof v === "string" && v) return clip(v.replace(/\s+/g, " "), 120);
  if (Array.isArray(i.todos)) return `${i.todos.length} todos`;
  return clip(JSON.stringify(i), 120);
}

/** Strip what an agent's client injects around your words (reminders, command wrappers). */
function cleanUserText(text: string): string {
  return text
    // Loom's own handoff briefing, when the session was one Loom ran
    .replace(/===== LOOM SESSION MEMORY[\s\S]*?===== end session memory[^\n]*\n?/g, "")
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "")
    .replace(/<(?:local-command-stdout|local-command-stderr|command-message|command-args)>[\s\S]*?<\/[^>]+>/g, "")
    .replace(/<command-name>([\s\S]*?)<\/command-name>/g, "$1")
    .trim();
}

const ms = (v: unknown, fallback = 0): number => {
  if (typeof v === "number") return v < 1e12 ? v * 1000 : v;
  if (typeof v === "string") {
    const t = Date.parse(v);
    return Number.isFinite(t) ? t : fallback;
  }
  return fallback;
};

// ---------------------------------------------------------------- Claude Code

function claudeText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((b): b is { type: string; text: string } => !!b && typeof b === "object" && (b as { type?: unknown }).type === "text" && typeof (b as { text?: unknown }).text === "string")
    .map((b) => b.text)
    .join("\n");
}

type Located = FoundChat & { file: string };

function findClaude(dir: string, root: string, loomIds: Set<string>): Located[] {
  const slug = path.resolve(dir).replace(/[^A-Za-z0-9]/g, "-");
  let folders: string[] = [];
  try {
    folders = fs.readdirSync(root).filter((f) => f === slug || f.startsWith(slug + "-"));
  } catch {
    return [];
  }
  const out: Located[] = [];
  for (const folder of folders) {
    let files: string[] = [];
    try { files = fs.readdirSync(path.join(root, folder)).filter((f) => f.endsWith(".jsonl")); } catch { continue; }
    for (const f of files) {
      const file = path.join(root, folder, f);
      let cwd = "", title = "", summary = "", entry = "";
      for (const o of head(file).map(parse)) {
        if (!o) continue;
        if (!cwd && typeof o.cwd === "string") cwd = o.cwd;
        if (!entry && typeof o.entrypoint === "string") entry = o.entrypoint;
        if (o.type === "summary" && typeof o.summary === "string" && !summary) summary = o.summary;
        if (!title && o.type === "user" && !o.isMeta && !o.isSidechain) {
          const t = cleanUserText(claudeText((o.message as { content?: unknown } | undefined)?.content));
          if (t && !t.startsWith("Caveat:")) title = titleFrom(t);
        }
      }
      if (!cwd || !within(dir, cwd)) continue; // a sibling folder whose name starts the same
      const id = f.replace(/\.jsonl$/, "");
      let st: fs.Stats;
      try { st = fs.statSync(file); } catch { continue; }
      out.push({
        file, source: "claude-code", id, title: summary || title || "(untitled)", cwd, updatedAt: st.mtimeMs, bytes: st.size,
        ...(/^sdk/.test(entry) ? { automated: true } : {}),
        ...(loomIds.has(id) ? { fromLoom: true } : {}),
      });
    }
  }
  return out;
}

async function readClaude(file: string): Promise<ImportedItem[]> {
  const items: ImportedItem[] = [];
  for await (const o of lines(file)) {
    if (o.isSidechain || o.isMeta) continue;
    const ts = ms(o.timestamp);
    const msg = (o.message ?? {}) as { content?: unknown; model?: string };
    if (o.type === "user") {
      const t = cleanUserText(claudeText(msg.content));
      if (t && !t.startsWith("Caveat:")) items.push({ kind: "user", ts, text: clip(t, MAX_TEXT) });
    } else if (o.type === "assistant" && Array.isArray(msg.content)) {
      for (const b of msg.content as Array<Record<string, unknown>>) {
        if (b.type === "text" && typeof b.text === "string" && b.text.trim()) {
          const last = items[items.length - 1];
          // one reply is often several records; keep it one message
          if (last?.kind === "assistant" && ts - last.ts < 120_000) last.text = clip(`${last.text}\n\n${b.text}`, MAX_TEXT);
          else items.push({ kind: "assistant", ts, text: clip(b.text, MAX_TEXT), ...(msg.model ? { model: msg.model } : {}) });
        } else if (b.type === "tool_use" && typeof b.name === "string") {
          items.push({ kind: "tool", ts, tool: b.name, summary: toolSummary(b.input) });
        }
      }
    }
  }
  return items;
}

// ---------------------------------------------------------------------- Codex

function walk(dir: string, out: string[] = []): string[] {
  let ents: fs.Dirent[] = [];
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.startsWith("rollout-") && e.name.endsWith(".jsonl")) out.push(p);
  }
  return out;
}

function codexText(p: Record<string, unknown>): string {
  return typeof p.message === "string" ? p.message : "";
}

function findCodex(dir: string, root: string, loomIds: Set<string>): Located[] {
  const out: Located[] = [];
  for (const file of walk(root)) {
    // the session's instructions come first and can run long; read on until your first message
    let rows = head(file).map(parse);
    if (!rows.some((o) => o?.type === "event_msg" && (o.payload as { type?: unknown })?.type === "user_message")) rows = head(file, 1024 * 1024).map(parse);
    const meta = rows.find((o) => o?.type === "session_meta")?.payload as Record<string, unknown> | undefined;
    if (!meta || typeof meta.cwd !== "string" || !within(dir, meta.cwd)) continue;
    const first = rows.find((o) => o?.type === "event_msg" && (o.payload as { type?: unknown })?.type === "user_message");
    const said = first ? cleanUserText(codexText(first.payload as Record<string, unknown>)) : "";
    const id = String(meta.id ?? meta.session_id ?? path.basename(file));
    let st: fs.Stats;
    try { st = fs.statSync(file); } catch { continue; }
    out.push({
      file, source: "codex", id, title: first ? titleFrom(codexText(first.payload as Record<string, unknown>)) : "(untitled)",
      cwd: meta.cwd, updatedAt: st.mtimeMs, bytes: st.size,
      ...(meta.originator === "loom" || loomIds.has(id) ? { fromLoom: true } : {}),
    });
  }
  return out;
}

async function readCodex(file: string): Promise<ImportedItem[]> {
  const items: ImportedItem[] = [];
  let model: string | undefined;
  for await (const o of lines(file)) {
    const ts = ms(o.timestamp);
    const p = (o.payload ?? {}) as Record<string, unknown>;
    if (o.type === "turn_context" && typeof p.model === "string") model = p.model;
    if (o.type === "event_msg") {
      if (p.type === "user_message" && cleanUserText(codexText(p))) items.push({ kind: "user", ts, text: clip(cleanUserText(codexText(p)), MAX_TEXT) });
      else if (p.type === "agent_message" && codexText(p).trim()) items.push({ kind: "assistant", ts, text: clip(codexText(p).trim(), MAX_TEXT), ...(model ? { model } : {}) });
    } else if (o.type === "response_item" && (p.type === "function_call" || p.type === "custom_tool_call" || p.type === "local_shell_call")) {
      items.push({ kind: "tool", ts, tool: String(p.name ?? p.type), summary: toolSummary(p.arguments ?? p.input ?? p.action) });
    }
  }
  return items;
}

// ------------------------------------------------------------------- OpenCode

type Db = { prepare(sql: string): { all(...a: unknown[]): unknown[]; get(...a: unknown[]): unknown } ; close(): void };

async function openDb(file: string): Promise<Db | null> {
  if (!fs.existsSync(file)) return null;
  try {
    const { DatabaseSync } = await import("node:sqlite");
    return new DatabaseSync(file, { readOnly: true }) as unknown as Db;
  } catch {
    return null;
  }
}

async function findOpenCode(dir: string, dbFile: string, loomIds: Set<string>): Promise<FoundChat[]> {
  const db = await openDb(dbFile);
  if (!db) return [];
  try {
    const d = path.resolve(dir);
    const rows = db.prepare(
      "SELECT id, title, directory, time_updated FROM session WHERE parent_id IS NULL AND (directory = ? OR directory LIKE ?) ORDER BY time_updated DESC LIMIT 200",
    ).all(d, d + path.sep + "%") as Array<{ id: string; title: string; directory: string; time_updated: number }>;
    // A session opencode never titled ("New session - <date>") was opened through its API,
    // by Loom or another tool; name it by its first message instead.
    const firstWords = (id: string): string => {
      try {
        const m = db.prepare("SELECT data FROM session_message WHERE session_id = ? AND type = 'user' ORDER BY seq LIMIT 1").get(id) as { data?: string } | undefined;
        const t = (parse(m?.data ?? "") ?? {}).text;
        if (typeof t === "string" && cleanUserText(t)) return titleFrom(cleanUserText(t).replace(/^\[image\] \S+\s*/gm, ""));
        const p = db.prepare("SELECT p.data FROM part p JOIN message m ON m.id = p.message_id WHERE p.session_id = ? AND m.data LIKE '%\"role\":\"user\"%' ORDER BY p.time_created LIMIT 1").get(id) as { data?: string } | undefined;
        const pt = (parse(p?.data ?? "") ?? {}).text;
        return typeof pt === "string" && cleanUserText(pt) ? titleFrom(cleanUserText(pt)) : "(untitled)";
      } catch {
        return "(untitled)";
      }
    };
    return rows.map((r) => {
      const untitled = !r.title || /^New session - \d{4}-/.test(r.title);
      return {
        source: "opencode" as const, id: r.id, title: untitled ? firstWords(r.id) : clip(r.title, 80), cwd: r.directory, updatedAt: ms(r.time_updated),
        ...(untitled ? { automated: true } : {}),
        ...(loomIds.has(r.id) ? { fromLoom: true } : {}),
      };
    });
  } catch {
    return [];
  } finally {
    db.close();
  }
}

async function readOpenCode(dbFile: string, id: string): Promise<{ title: string; items: ImportedItem[] }> {
  const db = await openDb(dbFile);
  if (!db) throw new Error("OpenCode's history isn't on this machine");
  try {
    const s = db.prepare("SELECT title FROM session WHERE id = ?").get(id) as { title?: string } | undefined;
    if (!s) throw new Error(`no OpenCode session ${id}`);
    const items: ImportedItem[] = [];
    const tool = (ts: number, c: Record<string, unknown>) =>
      items.push({ kind: "tool", ts, tool: String(c.tool ?? c.name ?? "tool"), summary: toolSummary((c.state as { input?: unknown } | undefined)?.input) });
    // newer opencode: one row per message, content inline
    const rows = db.prepare("SELECT type, time_created, data FROM session_message WHERE session_id = ? ORDER BY seq").all(id) as Array<{ type: string; time_created: number; data: string }>;
    if (rows.length) {
      for (const r of rows) {
        const d = parse(r.data) ?? {};
        const ts = ms(r.time_created);
        if (r.type === "user" && typeof d.text === "string" && cleanUserText(d.text)) items.push({ kind: "user", ts, text: clip(cleanUserText(d.text), MAX_TEXT) });
        if (r.type === "assistant" && Array.isArray(d.content)) {
          const model = (d.model as { id?: string; providerID?: string } | undefined);
          for (const c of d.content as Array<Record<string, unknown>>) {
            if (c.type === "text" && typeof c.text === "string" && c.text.trim()) items.push({ kind: "assistant", ts, text: clip(c.text.trim(), MAX_TEXT), ...(model?.id ? { model: model.providerID ? `${model.providerID}/${model.id}` : model.id } : {}) });
            else if (c.type === "tool") tool(ts, c);
          }
        }
      }
    } else {
      // older opencode: messages, and their parts
      const msgs = db.prepare("SELECT id, time_created, data FROM message WHERE session_id = ? ORDER BY time_created, id").all(id) as Array<{ id: string; time_created: number; data: string }>;
      for (const m of msgs) {
        const role = (parse(m.data) ?? {}).role;
        const ts = ms(m.time_created);
        const parts = db.prepare("SELECT data FROM part WHERE message_id = ? ORDER BY id").all(m.id) as Array<{ data: string }>;
        for (const p of parts) {
          const c = parse(p.data) ?? {};
          if (c.type === "text" && typeof c.text === "string" && c.text.trim() && !c.synthetic) {
            const t = role === "user" ? cleanUserText(c.text) : c.text.trim();
            if (t) items.push(role === "user" ? { kind: "user", ts, text: clip(t, MAX_TEXT) } : { kind: "assistant", ts, text: clip(t, MAX_TEXT) });
          } else if (c.type === "tool") tool(ts, c);
        }
      }
    }
    const untitled = !s.title || /^New session - \d{4}-/.test(s.title);
    const firstUser = items.find((i) => i.kind === "user");
    return { title: untitled ? (firstUser ? titleFrom(firstUser.text.replace(/^\[image\] \S+\s*/gm, "")) : "(untitled)") : s.title ?? "(untitled)", items };
  } finally {
    db.close();
  }
}

// ----------------------------------------------------------------------- API

/** Every chat on this machine that ran in `dir` (or a folder inside it), newest first. */
export async function findChats(dir: string, opts: { roots?: ImportRoots; loomIds?: Set<string> } = {}): Promise<FoundChat[]> {
  const r = { ...HOME_ROOTS(), ...opts.roots };
  const loomIds = opts.loomIds ?? new Set<string>();
  const files = [...findClaude(dir, r.claude, loomIds), ...findCodex(dir, r.codex, loomIds)].map(({ file: _file, ...c }) => c);
  const all = [...files, ...(await findOpenCode(dir, r.opencodeDb, loomIds))];
  return all.sort((a, b) => b.updatedAt - a.updatedAt);
}

/** One chat's conversation, ready to append to a Loom thread. */
export async function readChat(dir: string, source: ImportSource, id: string, opts: { roots?: ImportRoots } = {}): Promise<ImportedChat> {
  const r = { ...HOME_ROOTS(), ...opts.roots };
  let title = "(untitled)";
  let items: ImportedItem[];
  if (source === "opencode") {
    ({ title, items } = await readOpenCode(r.opencodeDb, id));
  } else {
    // found by listing again, so a request can only name a chat that belongs to this folder
    const found = (source === "claude-code" ? findClaude(dir, r.claude, new Set()) : findCodex(dir, r.codex, new Set())).find((c) => c.id === id);
    if (!found) throw new Error(`no ${source} chat ${id} for this project`);
    title = found.title;
    items = source === "claude-code" ? await readClaude(found.file) : await readCodex(found.file);
  }
  const dropped = Math.max(0, items.length - MAX_ITEMS);
  return { source, id, title, items: dropped ? items.slice(-MAX_ITEMS) : items, dropped };
}
