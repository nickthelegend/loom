import type { EventKind, LoomEvent, NewEvent } from "../../types.js";
import { MAIN_CHAT } from "../../types.js";
import type { EventStore, ListOpts } from "./contracts.js";
import { ContinuityStore } from "../continuity/store.js";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { ContinuityError, digest } from "../continuity/contracts.js";

export type SqliteModule = typeof import("node:sqlite");

export class SqliteStore implements EventStore {
  private db: InstanceType<SqliteModule["DatabaseSync"]>;
  readonly continuity: ContinuityStore;
  private file: string;

  constructor(sqlite: SqliteModule, file: string) {
    this.file = file;
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
    // time windows over one kind: today's spend, the cost/usage charts
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_events_kind_ts ON events(kind, ts)");
    this.continuity = new ContinuityStore(this.db, file);
  }

  /** Explicit offline migration. Conflicting IDs or malformed records abort the
   * entire import; original files and IDs stay intact. Never silently renumber. */
  importJsonl(file: string): { imported: number; known: number; backup: string } {
    const ownerTable = this.db.prepare("SELECT name FROM sqlite_master WHERE name='continuity_meta'").get();
    if (ownerTable && this.db.prepare("SELECT value FROM continuity_meta WHERE key='owner'").get())
      throw new ContinuityError("conflict", "close the Brain project owner before importing legacy history");
    const events = this.readJsonl(file), hash = digest(fs.readFileSync(file, "utf8"));
    const backup = `${file}.before-brain-v1.${randomUUID()}`;
    fs.copyFileSync(file, backup, fs.constants.COPYFILE_EXCL);
    const dbBackup = `${path.join(path.dirname(file), "log.db")}.before-jsonl.${randomUUID()}.db`;
    this.db.prepare("VACUUM INTO ?").run(dbBackup);
    let imported = 0, known = 0;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.exec("CREATE TABLE IF NOT EXISTS continuity_imports (hash TEXT PRIMARY KEY, source TEXT NOT NULL, count INTEGER NOT NULL, backup TEXT NOT NULL)");
      for (const event of events) {
        const prior = this.eventById(event.id);
        if (prior) {
          if (!isDeepStrictEqual(prior, event)) throw new ContinuityError("conflict", `legacy event ID ${event.id} conflicts with SQLite; reconcile the two backups before import`);
          known++; continue;
        }
        this.db.prepare("INSERT INTO events(id,ts,kind,agent_id,chat,payload) VALUES (?,?,?,?,?,?)")
          .run(event.id, event.ts, event.kind, event.agentId ?? null, event.chat ?? null, JSON.stringify(event.payload));
        imported++;
      }
      this.db.prepare("INSERT OR IGNORE INTO continuity_imports VALUES (?,?,?,?)").run(hash, path.basename(file), events.length, path.basename(backup));
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    return { imported, known, backup };
  }
  verifyJsonl(file: string): void {
    if (!fs.existsSync(file) || !fs.statSync(file).size) return;
    for (const event of this.readJsonl(file)) if (!isDeepStrictEqual(event, this.eventById(event.id)))
      throw new ContinuityError("conflict", "SQLite and JSONL contain distinct histories; stop the daemon and run loom brain:migrate before continuing");
  }
  private eventById(id: number): LoomEvent | undefined {
    const row = this.db.prepare("SELECT * FROM events WHERE id=?").get(id) as { id: number; ts: number; kind: EventKind; agent_id: string | null; chat: string | null; payload: string } | undefined;
    return row ? { id: row.id, ts: row.ts, kind: row.kind, ...(row.agent_id ? { agentId: row.agent_id } : {}),
      ...(row.chat ? { chat: row.chat } : {}), payload: JSON.parse(row.payload) } : undefined;
  }
  private readJsonl(file: string): LoomEvent[] {
    if (fs.statSync(file).size > 100_000_000) throw new ContinuityError("overflow", "legacy import exceeds the 100 MB offline import limit");
    let last = 0;
    return fs.readFileSync(file, "utf8").split("\n").filter(line => line.trim()).map(line => {
      let event: LoomEvent;
      try { event = JSON.parse(line) as LoomEvent; } catch { throw new ContinuityError("invalid", "malformed JSONL record; repair a copy before migration (original left intact)"); }
      if (!Number.isSafeInteger(event.id) || event.id <= last || !Number.isSafeInteger(event.ts) ||
        typeof event.kind !== "string" || !event.payload || typeof event.payload !== "object" || Array.isArray(event.payload) ||
        (event.chat !== undefined && typeof event.chat !== "string") || (event.agentId !== undefined && typeof event.agentId !== "string"))
        throw new ContinuityError("invalid", "invalid or duplicate/out-of-order legacy event");
      last = event.id;
      return { id: event.id, ts: event.ts, kind: event.kind, ...(event.agentId ? { agentId: event.agentId } : {}), ...(event.chat ? { chat: event.chat } : {}), payload: event.payload };
    });
  }

  append(e: Required<Omit<NewEvent, "agentId" | "chat">> & { agentId?: string; chat?: string }): LoomEvent {
    this.continuity.guardEventWriter();
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

  /** The WHERE clause every read shares (list and count). */
  private where(opts: ListOpts): { where: string; params: (string | number)[] } {
    const clauses: string[] = [];
    const params: (string | number)[] = [];
    if (opts.since !== undefined) {
      clauses.push("id > ?");
      params.push(opts.since);
    }
    if (opts.before !== undefined) {
      clauses.push("id < ?");
      params.push(opts.before);
    }
    if (opts.kinds?.length) {
      clauses.push(`kind IN (${opts.kinds.map(() => "?").join(",")})`);
      params.push(...opts.kinds);
    }
    if (opts.sinceTs !== undefined) {
      clauses.push("ts >= ?");
      params.push(opts.sinceTs);
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
    if (opts.agentId !== undefined) {
      clauses.push("agent_id = ?");
      params.push(opts.agentId);
    }
    return { where: clauses.length ? `WHERE ${clauses.join(" AND ")}` : "", params };
  }

  count(opts: ListOpts = {}): number {
    const { where, params } = this.where(opts);
    const row = this.db.prepare(`SELECT COUNT(*) AS n FROM events ${where}`).get(...params) as { n: number | bigint };
    return Number(row.n);
  }

  list(opts: ListOpts = {}): LoomEvent[] {
    const { where, params } = this.where(opts);
    return this.listWhere(opts, where, params);
  }

  private listWhere(opts: ListOpts, where: string, params: (string | number)[]): LoomEvent[] {
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

  size(): { bytes: number; events: number } {
    const n = this.db.prepare("SELECT COUNT(*) AS n FROM events").get() as { n: number | bigint };
    let bytes = 0;
    for (const f of [this.file, `${this.file}-wal`]) {
      try {
        bytes += fs.statSync(f).size;
      } catch {
        /* no wal file is fine */
      }
    }
    return { bytes, events: Number(n.n) };
  }

  compact(): void {
    this.db.exec("VACUUM");
  }

  lastReplyIds(): Map<string, number> {
    const rows = this.db
      .prepare(
        "SELECT COALESCE(chat, ?) AS c, MAX(id) AS m FROM events WHERE kind = 'message' AND agent_id IS NOT NULL GROUP BY COALESCE(chat, ?)",
      )
      .all(MAIN_CHAT, MAIN_CHAT) as Array<{ c: string; m: number | bigint }>;
    return new Map(rows.map((r) => [r.c, Number(r.m)]));
  }

  lastId(): number {
    const row = this.db.prepare("SELECT MAX(id) AS m FROM events").get() as
      | { m: number | bigint | null }
      | undefined;
    return row?.m ? Number(row.m) : 0;
  }

  close(): void {
    this.continuity.releaseOwner();
    this.db.close();
  }
}
