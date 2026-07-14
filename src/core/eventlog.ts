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

export interface ListOpts {
  since?: number; // exclusive event id
  limit?: number;
  kinds?: EventKind[];
}

interface EventStore {
  append(e: Required<Omit<NewEvent, "agentId">> & { agentId?: string }): LoomEvent;
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
        payload TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_events_kind ON events(kind, id);
    `);
  }

  append(e: Required<Omit<NewEvent, "agentId">> & { agentId?: string }): LoomEvent {
    const stmt = this.db.prepare(
      "INSERT INTO events (ts, kind, agent_id, payload) VALUES (?, ?, ?, ?)",
    );
    const res = stmt.run(e.ts, e.kind, e.agentId ?? null, JSON.stringify(e.payload));
    return {
      id: Number(res.lastInsertRowid),
      ts: e.ts,
      kind: e.kind,
      ...(e.agentId ? { agentId: e.agentId } : {}),
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
      payload: string;
    }>;
    return rows.map((r) => ({
      id: Number(r.id),
      ts: r.ts,
      kind: r.kind as EventKind,
      ...(r.agent_id ? { agentId: r.agent_id } : {}),
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

  append(e: Required<Omit<NewEvent, "agentId">> & { agentId?: string }): LoomEvent {
    const ev: LoomEvent = {
      id: this.nextId++,
      ts: e.ts,
      kind: e.kind,
      ...(e.agentId ? { agentId: e.agentId } : {}),
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
      try {
        const sqlite = await import("node:sqlite");
        return new EventLog(new SqliteStore(sqlite, path.join(loomDir, "log.db")));
      } catch {
        // Fall through to JSONL on runtimes without node:sqlite.
      }
    }
    return new EventLog(new JsonlStore(path.join(loomDir, "log.jsonl")));
  }

  append(e: NewEvent): LoomEvent {
    const ev = this.store.append({
      ts: e.ts ?? Date.now(),
      kind: e.kind,
      payload: e.payload,
      ...(e.agentId ? { agentId: e.agentId } : {}),
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
