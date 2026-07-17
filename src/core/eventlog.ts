/**
 * Append-only per-project event log — Loom's source of truth.
 *
 * Primary store: node:sqlite (built into Node >= 22.5, zero native deps).
 * Fallback store: JSONL (if node:sqlite is unavailable, or LOOM_STORE=jsonl).
 */

import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import type { EventKind, LoomEvent, NewEvent } from "../types.js";
import { MAIN_CHAT } from "../types.js";

export interface ListOpts {
  since?: number; // exclusive event id
  limit?: number;
  kinds?: EventKind[];
  /**
   * Only this conversation. Asking for the main chat also returns events
   * written before chats existed — they have no id and belong to it.
   * Omit to read the whole project, which is what the brain wants.
   */
  chat?: string;
}

/** The store behind a project's log. Exported so search can take a narrow
 * slice of it (list) rather than the whole EventLog — a searcher has no
 * business being able to append. */
export interface EventStore {
  append(
    e: Required<Omit<NewEvent, "agentId" | "chat">> & { agentId?: string; chat?: string },
  ): LoomEvent;
  list(opts?: ListOpts): LoomEvent[];
  lastId(): number;
  close(): void;
}

// ---------------------------------------------------------------------------
// SQLite store (node:sqlite)
// ---------------------------------------------------------------------------

type SqliteModule = typeof import("node:sqlite");

class SqliteStore implements EventStore {
  private db: InstanceType<SqliteModule["DatabaseSync"]>;

  constructor(sqlite: SqliteModule, file: string) {
    this.db = new sqlite.DatabaseSync(file);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        kind TEXT NOT NULL,
        agent_id TEXT,
        chat TEXT,
        payload TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_events_kind ON events(kind, id);
    `);
    // Migrate BEFORE indexing chat. A log written before chats existed already
    // has an `events` table, so CREATE TABLE IF NOT EXISTS is a no-op and the
    // column is still missing — indexing it here would throw "no such column"
    // and take the whole log down with it. Add the column, then index.
    // The log is append-only and those events are history: a NULL chat reads
    // as the main conversation rather than being rewritten.
    const cols = this.db.prepare("PRAGMA table_info(events)").all() as { name: string }[];
    if (!cols.some((c) => c.name === "chat")) {
      this.db.exec("ALTER TABLE events ADD COLUMN chat TEXT");
    }
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_events_chat ON events(chat, id)");
  }

  append(e: Required<Omit<NewEvent, "agentId" | "chat">> & { agentId?: string; chat?: string }): LoomEvent {
    const stmt = this.db.prepare(
      "INSERT INTO events (ts, kind, agent_id, chat, payload) VALUES (?, ?, ?, ?, ?)",
    );
    const res = stmt.run(
      e.ts,
      e.kind,
      e.agentId ?? null,
      e.chat ?? null,
      JSON.stringify(e.payload),
    );
    return {
      id: Number(res.lastInsertRowid),
      ts: e.ts,
      kind: e.kind,
      ...(e.agentId ? { agentId: e.agentId } : {}),
      ...(e.chat ? { chat: e.chat } : {}),
      payload: e.payload,
    };
  }

  list(opts: ListOpts = {}): LoomEvent[] {
    const clauses: string[] = [];
    const params: (string | number)[] = [];
    if (opts.since !== undefined) {
      clauses.push("id > ?");
      params.push(opts.since);
    }
    if (opts.kinds?.length) {
      clauses.push(`kind IN (${opts.kinds.map(() => "?").join(",")})`);
      params.push(...opts.kinds);
    }
    if (opts.chat !== undefined) {
      if (opts.chat === MAIN_CHAT) {
        // pre-chat history has no id and belongs to the main conversation
        clauses.push("(chat = ? OR chat IS NULL)");
      } else {
        clauses.push("chat = ?");
      }
      params.push(opts.chat);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    // When limiting, we want the *most recent* N in ascending order.
    const sql = opts.limit
      ? `SELECT * FROM (SELECT * FROM events ${where} ORDER BY id DESC LIMIT ?) ORDER BY id ASC`
      : `SELECT * FROM events ${where} ORDER BY id ASC`;
    if (opts.limit) params.push(opts.limit);
    const rows = this.db.prepare(sql).all(...params) as Array<{
      id: number | bigint;
      ts: number;
      kind: string;
      agent_id: string | null;
      chat: string | null;
      payload: string;
    }>;
    return rows.map((r) => ({
      id: Number(r.id),
      ts: r.ts,
      kind: r.kind as EventKind,
      ...(r.agent_id ? { agentId: r.agent_id } : {}),
      ...(r.chat ? { chat: r.chat } : {}),
      payload: JSON.parse(r.payload) as Record<string, unknown>,
    }));
  }

  lastId(): number {
    const row = this.db.prepare("SELECT MAX(id) AS m FROM events").get() as
      | { m: number | bigint | null }
      | undefined;
    return row?.m ? Number(row.m) : 0;
  }

  close(): void {
    this.db.close();
  }
}

// ---------------------------------------------------------------------------
// JSONL fallback store
// ---------------------------------------------------------------------------

class JsonlStore implements EventStore {
  private file: string;
  private nextId: number;
  private cache: LoomEvent[];

  constructor(file: string) {
    this.file = file;
    this.cache = [];
    if (fs.existsSync(file)) {
      for (const line of fs.readFileSync(file, "utf8").split("\n")) {
        if (!line.trim()) continue;
        try {
          this.cache.push(JSON.parse(line) as LoomEvent);
        } catch {
          // Skip torn trailing writes; the log stays usable.
        }
      }
    }
    this.nextId = (this.cache[this.cache.length - 1]?.id ?? 0) + 1;
  }

  append(e: Required<Omit<NewEvent, "agentId" | "chat">> & { agentId?: string; chat?: string }): LoomEvent {
    const ev: LoomEvent = {
      id: this.nextId++,
      ts: e.ts,
      kind: e.kind,
      ...(e.agentId ? { agentId: e.agentId } : {}),
      ...(e.chat ? { chat: e.chat } : {}),
      payload: e.payload,
    };
    fs.appendFileSync(this.file, JSON.stringify(ev) + "\n");
    this.cache.push(ev);
    return ev;
  }

  list(opts: ListOpts = {}): LoomEvent[] {
    let out = this.cache;
    if (opts.since !== undefined) out = out.filter((e) => e.id > opts.since!);
    if (opts.kinds?.length) out = out.filter((e) => opts.kinds!.includes(e.kind));
    // must match SqliteStore exactly: an event with no chat is main's
    if (opts.chat !== undefined) {
      out = out.filter((e) =>
        opts.chat === MAIN_CHAT ? (e.chat ?? MAIN_CHAT) === MAIN_CHAT : e.chat === opts.chat,
      );
    }
    if (opts.limit && out.length > opts.limit) out = out.slice(-opts.limit);
    return [...out];
  }

  lastId(): number {
    return this.cache[this.cache.length - 1]?.id ?? 0;
  }

  close(): void {}
}

// ---------------------------------------------------------------------------
// EventLog facade
// ---------------------------------------------------------------------------

export class EventLog {
  private store: EventStore;
  private emitter = new EventEmitter();

  private constructor(store: EventStore) {
    this.store = store;
    this.emitter.setMaxListeners(100);
  }

  /** Open (or create) the log inside a project's .loom directory. */
  static async open(loomDir: string): Promise<EventLog> {
    fs.mkdirSync(loomDir, { recursive: true });
    if (process.env.LOOM_STORE !== "jsonl") {
      let sqlite: SqliteModule;
      try {
        sqlite = await import("node:sqlite");
      } catch {
        // No node:sqlite in this runtime — the JSONL store is the whole point
        // of the fallback. This is the ONLY thing it catches.
        return new EventLog(new JsonlStore(path.join(loomDir, "log.jsonl")));
      }
      // Deliberately outside the catch. If node:sqlite exists but the log won't
      // open — corrupt file, failed migration, bad permissions — falling back
      // would silently start an EMPTY jsonl log beside a database full of your
      // history, and write new events there. Losing the thread is worse than
      // failing loudly, so this throws.
      return new EventLog(new SqliteStore(sqlite, path.join(loomDir, "log.db")));
    }
    return new EventLog(new JsonlStore(path.join(loomDir, "log.jsonl")));
  }

  append(e: NewEvent): LoomEvent {
    const ev = this.store.append({
      ts: e.ts ?? Date.now(),
      kind: e.kind,
      payload: e.payload,
      ...(e.agentId ? { agentId: e.agentId } : {}),
      ...(e.chat ? { chat: e.chat } : {}),
    });
    this.emitter.emit("event", ev);
    return ev;
  }

  list(opts?: ListOpts): LoomEvent[] {
    return this.store.list(opts);
  }

  lastId(): number {
    return this.store.lastId();
  }

  /** Live subscription to appended events; returns unsubscribe. */
  onEvent(cb: (e: LoomEvent) => void): () => void {
    this.emitter.on("event", cb);
    return () => this.emitter.off("event", cb);
  }

  close(): void {
    this.emitter.removeAllListeners();
    this.store.close();
  }
}
