/**
 * Append-only per-project event log — Loom's source of truth.
 *
 * Primary store: node:sqlite (built into Node >= 22.5, zero native deps).
 * Fallback store: JSONL (if node:sqlite is unavailable, or LOOM_STORE=jsonl).
 */

import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import type { LoomEvent, NewEvent } from "../types.js";
import type { EventJournal, EventStore, ListOpts } from "./events/contracts.js";
import { JsonlStore } from "./events/jsonl-store.js";
import { SqliteStore, type SqliteModule } from "./events/sqlite-store.js";
import { ContinuityError, type ContinuityRequest } from "./continuity/contracts.js";
import type { ContinuityStore } from "./continuity/store.js";
export type { EventReader, EventJournal, EventStore, ListOpts } from "./events/contracts.js";

export class EventLog implements EventJournal {
  private closed = false;
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
        // of the fallback. This is the ONLY thing it catches. But not beside a
        // log.db: an older Node (a shell that put nvm's 20 first after a
        // reboot) opened an EMPTY jsonl log next to the real history, and the
        // app showed every thread blank, which reads exactly like data loss.
        if (fs.existsSync(path.join(loomDir, "log.db"))) {
          throw new Error(
            `this project's history is in ${path.join(loomDir, "log.db")}, which needs node:sqlite — ` +
              `run Loom on Node 22.5 or newer (this is Node ${process.versions.node})`,
          );
        }
        return new EventLog(new JsonlStore(path.join(loomDir, "log.jsonl")));
      }
      // Deliberately outside the catch. If node:sqlite exists but the log won't
      // open — corrupt file, failed migration, bad permissions — falling back
      // would silently start an EMPTY jsonl log beside a database full of your
      // history, and write new events there. Losing the thread is worse than
      // failing loudly, so this throws.
      const dbFile = path.join(loomDir, "log.db"), jsonlFile = path.join(loomDir, "log.jsonl");
      if (!fs.existsSync(dbFile) && fs.existsSync(jsonlFile) && fs.statSync(jsonlFile).size)
        throw new ContinuityError("unsupported", "legacy JSONL history needs explicit migration: stop the daemon and run loom brain:migrate (LOOM_STORE=jsonl still reads the original)");
      const store = new SqliteStore(sqlite, dbFile);
      try { store.verifyJsonl(jsonlFile); } catch (error) { store.close(); throw error; }
      return new EventLog(store);
    }
    return new EventLog(new JsonlStore(path.join(loomDir, "log.jsonl")));
  }

  static async migrateJsonl(loomDir: string): Promise<{ imported: number; known: number; backup: string }> {
    const sqlite = await import("node:sqlite");
    const file = path.join(loomDir, "log.jsonl");
    if (!fs.existsSync(file)) throw new ContinuityError("invalid", "no log.jsonl to import");
    const store = new SqliteStore(sqlite, path.join(loomDir, "log.db"));
    try { return store.importJsonl(file); } finally { store.close(); }
  }

  append(e: NewEvent): LoomEvent {
    if (this.closed) throw new Error("event log is closed");
    const ev = this.store.append({
      ts: e.ts ?? Date.now(),
      kind: e.kind,
      // Match durable JSON semantics and detach from caller-owned objects.
      payload: JSON.parse(JSON.stringify(e.payload)) as Record<string, unknown>,
      ...(e.agentId ? { agentId: e.agentId } : {}),
      ...(e.chat ? { chat: e.chat } : {}),
    });
    this.emitter.emit("event", ev);
    return ev;
  }

  list(opts?: ListOpts): LoomEvent[] {
    if (this.closed) throw new Error("event log is closed");
    return this.store.list(opts);
  }

  /** How many events match, without reading them. */
  count(opts?: ListOpts): number {
    if (this.closed) throw new Error("event log is closed");
    return this.store.count(opts);
  }

  lastId(): number {
    if (this.closed) throw new Error("event log is closed");
    return this.store.lastId();
  }

  /** Optional SQLite Brain interface; JSONL remains readable without pretending
   * to support transactional native continuity. */
  get continuity(): ContinuityStore | null {
    if (this.closed) throw new Error("event log is closed");
    return this.store instanceof SqliteStore ? this.store.continuity : null;
  }

  captureRequest(request: ContinuityRequest): { event: LoomEvent; created: boolean } {
    const store = this.continuity;
    if (!store) throw new ContinuityError("unsupported", "native continuity requires SQLite; legacy JSONL is still readable");
    const result = store.capture(request, () => this.store.append({ ts: Date.now(), kind: "message",
      chat: request.conversationId, payload: { text: request.text, author: request.source === "user" ? "user" : "loom", requestId: request.id } }));
    // Capture and its idempotency row commit together before clients see either.
    if (result.created) this.emitter.emit("event", result.event);
    return result;
  }

  lastReplyIds(): Map<string, number> {
    if (this.closed) throw new Error("event log is closed");
    return this.store.lastReplyIds();
  }

  size(): { bytes: number; events: number } {
    return this.store.size();
  }

  compact(): void {
    this.store.compact();
  }

  /** Live subscription to appended events; returns unsubscribe. */
  onEvent(cb: (e: LoomEvent) => void): () => void {
    if (this.closed) throw new Error("event log is closed");
    const listener = (event: LoomEvent) => {
      try {
        cb(structuredClone(event));
      } catch (error) {
        // The event is already durable. A failed observer must not make the
        // writer retry it or prevent the other observers from receiving it.
        process.emitWarning(`event subscriber failed: ${String(error)}`, { code: "LOOM_EVENT_SUBSCRIBER" });
      }
    };
    this.emitter.on("event", listener);
    return () => this.emitter.off("event", listener);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.emitter.removeAllListeners();
    this.store.close();
  }
}
