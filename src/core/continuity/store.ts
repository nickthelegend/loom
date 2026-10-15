import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { LoomEvent } from "../../types.js";
import { MAIN_CHAT } from "../../types.js";
import { BindingV1, ContextItemV1, ContextPacketV1, DeliveryReceiptV1, RenderedBriefingV1,
  ContinuityError, digest, parseBounded, type Binding, type ContextItem, type ContextPacket,
  type ContinuityRequest, type Receipt, type RenderedBriefing, type SourceRef } from "./contracts.js";

type Row = Record<string, string | number | null>;
const decode = <T>(row: Row | undefined): T | undefined => row ? JSON.parse(String(row.data)) as T : undefined;
export const eventText = (e: LoomEvent): string => typeof e.payload.text === "string" ? e.payload.text : JSON.stringify(e.payload);
export const isUser = (e: LoomEvent): boolean => !e.agentId &&
  ((e.kind === "message" && e.payload.author !== "loom") || (e.kind === "decision" && e.payload.auto !== true && (e.payload.author === undefined || e.payload.author === "user")));
const USER_SOURCE = `agent_id IS NULL AND ((kind='decision' AND coalesce(json_extract(payload,'$.auto'),0)!=1
  AND coalesce(json_extract(payload,'$.author'),'user')='user') OR (kind='message' AND coalesce(json_extract(payload,'$.author'),'user')!='loom'))`;
// A captured request is conversation history only once it may have reached a
// harness. Queued, overflowed or pre-launch-failed requests are not yet said.
const UNSENT_REQUESTS = `SELECT r.event_id FROM continuity_requests r WHERE r.chat=? AND NOT EXISTS
  (SELECT 1 FROM continuity_receipts c WHERE c.request_id=r.id AND json_extract(c.data,'$.status') IN ('submitting','accepted','outcome_unknown'))`;
// Only a current checkpoint replaces its originals; superseding it restores them.
const CHECKPOINTED = `SELECT d.event_id FROM continuity_dispositions d JOIN continuity_items i ON i.id=d.item_id
  WHERE d.chat=? AND json_extract(i.data,'$.status')!='superseded'`;

/** Uses the event journal's existing connection. There is no second writer,
 * memory-only acknowledgement, or nested connection transaction here. */
export class ContinuityStore {
  private readonly token = randomUUID();
  private owned = false;
  private active = false;
  private fts = false;
  constructor(private readonly db: DatabaseSync, private readonly file: string) {}

  activate(): void {
    if (this.active) return;
    const exists = this.db.prepare("SELECT name FROM sqlite_master WHERE name='continuity_meta'").get();
    if (!exists) {
      // VACUUM INTO produces a consistent backup even with another open reader.
      // Never overwrite a previous backup, and never proceed after backup failure.
      const backup = `${this.file}.before-brain-v1.${randomUUID()}.db`;
      this.db.prepare("VACUUM INTO ?").run(backup);
    }
    this.db.exec("PRAGMA busy_timeout=1000; PRAGMA foreign_keys=ON");
    this.transaction(() => {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS continuity_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS continuity_events_scope ON events(coalesce(chat,'${MAIN_CHAT}'),id);
        CREATE INDEX IF NOT EXISTS continuity_events_intent ON events(coalesce(chat,'${MAIN_CHAT}'),id)
          WHERE agent_id IS NULL AND (kind='message' OR kind='decision');
        CREATE TABLE IF NOT EXISTS continuity_requests (id TEXT PRIMARY KEY, hash TEXT NOT NULL,
          chat TEXT NOT NULL, event_id INTEGER NOT NULL UNIQUE REFERENCES events(id), data TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS continuity_bindings (id TEXT PRIMARY KEY, slot TEXT NOT NULL UNIQUE, data TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS continuity_items (id TEXT PRIMARY KEY, chat TEXT NOT NULL, data TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS continuity_item_revisions (id TEXT NOT NULL, revision INTEGER NOT NULL,
          data TEXT NOT NULL, PRIMARY KEY(id,revision));
        CREATE INDEX IF NOT EXISTS continuity_items_chat ON continuity_items(chat);
        CREATE TABLE IF NOT EXISTS continuity_packets (id TEXT PRIMARY KEY, request_id TEXT NOT NULL REFERENCES continuity_requests(id),
          data TEXT NOT NULL, rendered TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS continuity_receipts (id TEXT PRIMARY KEY, request_id TEXT NOT NULL REFERENCES continuity_requests(id),
          binding_id TEXT NOT NULL REFERENCES continuity_bindings(id), packet_id TEXT NOT NULL REFERENCES continuity_packets(id),
          workspace TEXT NOT NULL, active INTEGER NOT NULL, data TEXT NOT NULL);
        CREATE UNIQUE INDEX IF NOT EXISTS continuity_writer ON continuity_receipts(workspace) WHERE active=1;
        CREATE INDEX IF NOT EXISTS continuity_receipts_request ON continuity_receipts(request_id);
        CREATE INDEX IF NOT EXISTS continuity_receipts_binding ON continuity_receipts(binding_id);
        CREATE UNIQUE INDEX IF NOT EXISTS continuity_receipts_run ON continuity_receipts(json_extract(data,'$.runId'));
        CREATE TABLE IF NOT EXISTS continuity_dispositions (event_id INTEGER PRIMARY KEY REFERENCES events(id),
          chat TEXT NOT NULL, item_id TEXT NOT NULL REFERENCES continuity_items(id));
      `);
      const version = this.meta("version");
      if (version && version !== "1") throw new ContinuityError("unsupported", `unsupported Brain database version ${version}`);
      this.setMeta("version", "1");
    });
    try {
      this.db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS continuity_search USING fts5(chat UNINDEXED, text);
        CREATE TRIGGER IF NOT EXISTS continuity_search_insert AFTER INSERT ON events BEGIN
          INSERT INTO continuity_search(rowid, chat, text) VALUES (new.id, coalesce(new.chat, '${MAIN_CHAT}'),
            coalesce(json_extract(new.payload, '$.text'), new.payload)); END;
        CREATE TRIGGER IF NOT EXISTS continuity_search_delete AFTER DELETE ON events BEGIN
          DELETE FROM continuity_search WHERE rowid=old.id; END;
        CREATE TRIGGER IF NOT EXISTS continuity_search_update AFTER UPDATE ON events BEGIN
          DELETE FROM continuity_search WHERE rowid=old.id;
          INSERT INTO continuity_search(rowid, chat, text) VALUES (new.id, coalesce(new.chat, '${MAIN_CHAT}'),
            coalesce(json_extract(new.payload, '$.text'), new.payload)); END;`);
      this.db.exec(`INSERT INTO continuity_search(rowid,chat,text)
        SELECT id,coalesce(chat,'${MAIN_CHAT}'),coalesce(json_extract(payload,'$.text'),payload) FROM events
        WHERE id NOT IN (SELECT rowid FROM continuity_search)`);
      this.fts = true;
    } catch (error) {
      if (!/no such module: fts5/i.test(String(error))) throw error;
      this.fts = false;
    }
    this.active = true;
  }

  claimOwner(): void {
    if (this.owned) throw new ContinuityError("conflict", "this journal already has a Brain execution owner");
    this.activate();
    this.transaction(() => {
      const raw = this.meta("owner");
      if (raw) {
        const previous = JSON.parse(raw) as { token: string; pid: number; host: string };
        if (previous.token !== this.token) {
          if (previous.host !== os.hostname()) throw new ContinuityError("recovery_required", "project is owned on another host; use a local SQLite filesystem");
          let dead = false;
          try { process.kill(previous.pid, 0); } catch (error) { dead = (error as NodeJS.ErrnoException).code === "ESRCH"; }
          // A reused PID conservatively blocks takeover, never authorizes one.
          if (!dead) throw new ContinuityError("conflict", "another live project owner holds Brain; close it first");
        }
      }
      this.setMeta("owner", JSON.stringify({ token: this.token, pid: process.pid, host: os.hostname() }));
      for (const r of this.activeReceipts()) {
        if (r.execution === "running" || r.status === "submitting") {
          this.writeReceipt({ ...r, status: r.status === "submitting" ? "outcome_unknown" : r.status,
            execution: "unknown", evidence: "previous owner exited; native action outcome requires reconciliation", updatedAt: Date.now() }, true);
        }
      }
    });
    this.owned = true;
  }

  releaseOwner(): void {
    if (!this.owned) return;
    this.assertOwner();
    this.db.prepare("DELETE FROM continuity_meta WHERE key='owner'").run();
    this.owned = false;
  }
  private assertOwner(): void {
    if (!this.owned || JSON.parse(this.meta("owner") ?? "null")?.token !== this.token)
      throw new ContinuityError("conflict", "Brain project ownership changed");
  }
  guardEventWriter(): void {
    if (!this.db.prepare("SELECT name FROM sqlite_master WHERE name='continuity_meta'").get()) return;
    const owner = this.meta("owner");
    if (owner && JSON.parse(owner).token !== this.token)
      throw new ContinuityError("conflict", "another Brain owner holds this event journal");
    if (!owner && this.db.prepare("SELECT id FROM continuity_receipts WHERE active=1 LIMIT 1").get())
      throw new ContinuityError("recovery_required", "unresolved Brain writers remain; enable native continuity and reconcile before legacy writes");
  }
  private meta(key: string): string | undefined {
    return (this.db.prepare("SELECT value FROM continuity_meta WHERE key=?").get(key) as { value: string } | undefined)?.value;
  }
  private setMeta(key: string, value: string): void {
    this.db.prepare("INSERT INTO continuity_meta VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, value);
  }
  private transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try { const result = fn(); this.db.exec("COMMIT"); return result; }
    catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  capture(request: ContinuityRequest, append: () => LoomEvent): { event: LoomEvent; created: boolean } {
    this.assertOwner();
    return this.transaction(() => {
      const hash = digest(JSON.stringify(request));
      const previous = this.db.prepare("SELECT hash,event_id FROM continuity_requests WHERE id=?").get(request.id) as Row | undefined;
      if (previous) {
        if (previous.hash !== hash) throw new ContinuityError("conflict", "request ID already belongs to different content or target");
        return { event: this.event(Number(previous.event_id))!, created: false };
      }
      const event = append();
      this.db.prepare("INSERT INTO continuity_requests VALUES (?,?,?,?,?)")
        .run(request.id, hash, request.conversationId, event.id, JSON.stringify(request));
      return { event, created: true };
    });
  }
  request(id: string): ContinuityRequest | undefined {
    return decode(this.db.prepare("SELECT data FROM continuity_requests WHERE id=?").get(id) as Row | undefined);
  }
  requestEvent(id: string): LoomEvent | undefined {
    const row = this.db.prepare("SELECT event_id FROM continuity_requests WHERE id=?").get(id) as Row | undefined;
    return row ? this.event(Number(row.event_id)) : undefined;
  }
  event(id: number): LoomEvent | undefined {
    const r = this.db.prepare("SELECT * FROM events WHERE id=?").get(id) as Row | undefined;
    return r ? { id: Number(r.id), ts: Number(r.ts), kind: String(r.kind) as LoomEvent["kind"],
      ...(r.agent_id ? { agentId: String(r.agent_id) } : {}), ...(r.chat ? { chat: String(r.chat) } : {}),
      payload: JSON.parse(String(r.payload)) } : undefined;
  }
  source(event: LoomEvent, projectId: string): SourceRef {
    return { projectId, eventId: event.id, hash: digest(eventText(event)) };
  }
  history(chat: string, through: number, since = 0, limit = 10_001): LoomEvent[] {
    // Bounded ascending pagination. Unlike EventLog.limit this never hides old intent.
    const rows = this.db.prepare(`SELECT id FROM events WHERE coalesce(chat,'${MAIN_CHAT}')=? AND id>? AND id<=?
      ORDER BY id LIMIT ?`).all(chat, since, through, limit) as Row[];
    return rows.map(r => this.event(Number(r.id))!);
  }
  protectedEvents(chat: string, through: number): LoomEvent[] {
    const rows = this.db.prepare(`SELECT id FROM events WHERE coalesce(chat,'${MAIN_CHAT}')=? AND id<=?
      AND (kind='message' OR kind='decision') AND ${USER_SOURCE}
      AND id NOT IN (${CHECKPOINTED}) AND id NOT IN (${UNSENT_REQUESTS}) ORDER BY id LIMIT 10001`)
      .all(chat, through, chat, chat) as Row[];
    return rows.map(r => this.event(Number(r.id))!);
  }
  /** Governing user evidence after a snapshot. A newly queued request is not
   * governing: it runs as its own turn after the current one. */
  hasNewUserSources(chat: string, through: number): boolean {
    return Boolean(this.db.prepare(`SELECT id FROM events WHERE coalesce(chat,'${MAIN_CHAT}')=? AND id>?
      AND ${USER_SOURCE} AND id NOT IN (${UNSENT_REQUESTS}) LIMIT 1`).get(chat, through, chat));
  }
  /** Sources already placed in one native session by accepted packets. */
  delivered(bindingId: string, epoch: number): { messages: Set<number>; evidence: Set<number> } {
    const scope = `FROM continuity_receipts r JOIN continuity_packets p ON p.id=r.packet_id
      WHERE r.binding_id=? AND json_extract(r.data,'$.status')='accepted' AND json_extract(p.data,'$.target.sessionEpoch')=?`;
    const each = (path: string) => `SELECT json_extract(x.value,'$.source.eventId') AS id
      ${scope.replace("WHERE", `, json_each(p.data,'${path}') x WHERE`)}`;
    const ids = (parts: string[]) => new Set((this.db.prepare(parts.join(" UNION "))
      .all(...parts.flatMap(() => [bindingId, epoch])) as Row[]).filter(r => r.id !== null).map(r => Number(r.id)));
    return {
      messages: ids([`SELECT json_extract(p.data,'$.currentRequest.eventId') AS id ${scope}`, each("$.messages"), each("$.references")]),
      evidence: ids([each("$.evidence")]),
    };
  }
  binding(slot: string, create: () => Binding): Binding {
    this.assertOwner();
    const previous = decode<Binding>(this.db.prepare("SELECT data FROM continuity_bindings WHERE slot=?").get(slot) as Row | undefined);
    if (previous) return BindingV1.parse(previous);
    const binding = BindingV1.parse(create());
    this.db.prepare("INSERT INTO continuity_bindings VALUES (?,?,?)").run(binding.id, slot, JSON.stringify(binding));
    return binding;
  }
  updateBinding(binding: Binding): void {
    this.assertOwner(); BindingV1.parse(binding);
    this.db.prepare("UPDATE continuity_bindings SET data=? WHERE id=?").run(JSON.stringify(binding), binding.id);
  }
  bindingById(id: string): Binding | undefined {
    return decode(this.db.prepare("SELECT data FROM continuity_bindings WHERE id=?").get(id) as Row | undefined);
  }
  /** Every binding one agent instance has in one conversation (one per workspace and configuration). */
  bindingsFor(chat: string, agentInstanceId: string): Binding[] {
    return (this.db.prepare(`SELECT data FROM continuity_bindings
      WHERE json_extract(data,'$.conversationId')=? AND json_extract(data,'$.agentInstanceId')=?`).all(chat, agentInstanceId) as Row[])
      .map(r => BindingV1.parse(JSON.parse(String(r.data))));
  }
  /** Whether the binding's latest accepted packet was a delta or a reconstruction. */
  lastPacketMode(bindingId: string): "delta" | "reconstruction" | undefined {
    const row = this.db.prepare(`SELECT json_extract(p.data,'$.mode') AS mode FROM continuity_receipts r
      JOIN continuity_packets p ON p.id=r.packet_id WHERE r.binding_id=? AND json_extract(r.data,'$.status')='accepted'
      ORDER BY r.rowid DESC LIMIT 1`).get(bindingId) as { mode?: string } | undefined;
    return row?.mode === "delta" || row?.mode === "reconstruction" ? row.mode : undefined;
  }
  items(chat: string): ContextItem[] {
    return (this.db.prepare("SELECT data FROM continuity_items WHERE chat=? ORDER BY id").all(chat) as Row[])
      .map(r => ContextItemV1.parse(JSON.parse(String(r.data))));
  }
  putItem(item: ContextItem): void {
    this.assertOwner(); parseBounded(ContextItemV1, item);
    this.transaction(() => {
      const old = decode<ContextItem>(this.db.prepare("SELECT data FROM continuity_items WHERE id=?").get(item.id) as Row | undefined);
      if (old && (old.conversationId !== item.conversationId || item.revision !== old.revision + 1))
        throw new ContinuityError("conflict", "context item revision or scope changed");
      if (!old && item.revision !== 1) throw new ContinuityError("invalid", "new item revision must be 1");
      if (item.supersedes) {
        const target = decode<ContextItem>(this.db.prepare("SELECT data FROM continuity_items WHERE id=?").get(item.supersedes.id) as Row | undefined);
        if (item.origin !== "user" || item.status !== "accepted")
          throw new ContinuityError("invalid", "supersession requires an accepted user-reviewed correction");
        if (!target || target.status === "superseded" || target.conversationId !== item.conversationId || target.revision !== item.supersedes.revision || target.id === item.id)
          throw new ContinuityError("conflict", "superseded item is missing, stale or outside this chat");
        this.db.prepare("UPDATE continuity_items SET data=? WHERE id=?").run(JSON.stringify({ ...target, revision: target.revision + 1, status: "superseded" }), target.id);
        this.db.prepare("INSERT INTO continuity_item_revisions VALUES (?,?,?)").run(target.id, target.revision + 1, JSON.stringify({ ...target, revision: target.revision + 1, status: "superseded" }));
      }
      this.db.prepare("INSERT INTO continuity_items VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data")
        .run(item.id, item.conversationId, JSON.stringify(item));
      this.db.prepare("INSERT INTO continuity_item_revisions VALUES (?,?,?)").run(item.id, item.revision, JSON.stringify(item));
      // Removed checkpoint sources become mandatory again in the same transaction.
      const retained = new Set(item.origin === "user" ? item.sources.filter(s => !s.span).map(s => s.eventId) : []);
      for (const [eventId, itemId] of this.dispositions(item.conversationId)) {
        if (itemId === item.id && !retained.has(eventId))
          this.db.prepare("DELETE FROM continuity_dispositions WHERE event_id=?").run(eventId);
      }
      this.setMeta(`revision:${item.conversationId}`, String(this.revision(item.conversationId) + 1));
    });
  }
  revision(chat: string): number { return Number(this.meta(`revision:${chat}`) ?? 0); }
  // A source disposition is an explicit user-reviewed checkpoint. Original text
  // stays in events; deferred/uncertain discussion cannot disappear via top-K.
  dispose(eventId: number, chat: string, itemId: string): void {
    this.disposeMany([eventId], chat, itemId);
  }
  disposeMany(eventIds: number[], chat: string, itemId: string): void {
    this.assertOwner();
    const item = this.items(chat).find(i => i.id === itemId);
    if (!item || item.origin !== "user" || eventIds.length > 1000 || !eventIds.length ||
      !eventIds.every(eventId => item.sources.some(s => s.eventId === eventId && !s.span)))
      throw new ContinuityError("invalid", "checkpoint needs user-reviewed full-source evidence");
    this.transaction(() => {
      for (const eventId of eventIds) this.db.prepare("INSERT INTO continuity_dispositions VALUES (?,?,?) ON CONFLICT(event_id) DO UPDATE SET item_id=excluded.item_id")
        .run(eventId, chat, itemId);
      this.setMeta(`revision:${chat}`, String(this.revision(chat) + 1));
    });
  }
  /** Checkpointed sources. `active` omits those whose item was superseded. */
  dispositions(chat: string, active = false): Map<number, string> {
    const sql = active
      ? `SELECT d.event_id,d.item_id FROM continuity_dispositions d WHERE d.event_id IN (${CHECKPOINTED})`
      : "SELECT event_id,item_id FROM continuity_dispositions WHERE chat=?";
    return new Map((this.db.prepare(sql).all(chat) as Row[]).map(r => [Number(r.event_id), String(r.item_id)]));
  }
  /** Observation candidates (agent/tool output), newest first. */
  observations(chat: string, since: number, through: number, limit: number): LoomEvent[] {
    const rows = this.db.prepare(`SELECT id FROM events WHERE coalesce(chat,'${MAIN_CHAT}')=? AND id>? AND id<=?
      AND kind IN ('message','tool_call','file_edit','turn_diff','run_complete','error') AND NOT (${USER_SOURCE})
      ORDER BY id DESC LIMIT ?`).all(chat, since, through, limit) as Row[];
    return rows.map(r => this.event(Number(r.id))!);
  }
  countObservations(chat: string, since: number, through: number): number {
    return Number((this.db.prepare(`SELECT count(*) AS n FROM events WHERE coalesce(chat,'${MAIN_CHAT}')=? AND id>? AND id<=?
      AND kind IN ('message','tool_call','file_edit','turn_diff','run_complete','error') AND NOT (${USER_SOURCE})`)
      .get(chat, since, through) as Row).n);
  }
  savePacket(packet: ContextPacket, rendered: RenderedBriefing, receipt: Receipt): void {
    this.assertOwner(); parseBounded(ContextPacketV1, packet); parseBounded(RenderedBriefingV1, rendered); DeliveryReceiptV1.parse(receipt);
    if (receipt.packetId !== packet.id || receipt.requestId !== packet.requestId || receipt.bindingId !== packet.target.id ||
      receipt.status !== "prepared" || receipt.execution !== "idle" || rendered.packetId !== packet.id)
      throw new ContinuityError("invalid", "prepared packet, render and receipt links do not match");
    this.transaction(() => {
      this.db.prepare("INSERT INTO continuity_packets VALUES (?,?,?,?)")
        .run(packet.id, packet.requestId, JSON.stringify(packet), JSON.stringify(rendered));
      this.db.prepare("INSERT INTO continuity_receipts VALUES (?,?,?,?,?,?,?)")
        .run(receipt.id, receipt.requestId, receipt.bindingId, receipt.packetId, packet.snapshot.workspace.id, 0, JSON.stringify(receipt));
    });
  }
  packet(id: string): { packet: ContextPacket; rendered: RenderedBriefing } | undefined {
    const row = this.db.prepare("SELECT data,rendered FROM continuity_packets WHERE id=?").get(id) as Row | undefined;
    return row ? { packet: ContextPacketV1.parse(JSON.parse(String(row.data))), rendered: RenderedBriefingV1.parse(JSON.parse(String(row.rendered))) } : undefined;
  }
  packetSummary(id: string): object | null {
    const row = this.db.prepare(`SELECT json_object('id',json_extract(data,'$.id'),
      'conversationId',json_extract(data,'$.conversationId'),'mode',json_extract(data,'$.mode'),
      'target',json_extract(data,'$.target'),'snapshot',json_extract(data,'$.snapshot'),'budget',json_extract(data,'$.budget'),
      'counts',json_object('protectedItems',json_array_length(data,'$.items'), 'exactMessages',json_array_length(data,'$.messages'),
        'evidence',json_array_length(data,'$.evidence'),'coverage',json_array_length(data,'$.coverage'))) AS summary
      FROM continuity_packets WHERE id=?`).get(id) as Row | undefined;
    return row ? JSON.parse(String(row.summary)) : null;
  }
  receipts(requestId?: string): Receipt[] {
    if (!this.active && !this.db.prepare("SELECT name FROM sqlite_master WHERE name='continuity_receipts'").get()) return [];
    return (this.db.prepare(`SELECT data FROM continuity_receipts ${requestId ? "WHERE request_id=?" : ""} ORDER BY rowid DESC LIMIT 100`)
      .all(...(requestId ? [requestId] : [])) as Row[]).reverse().map(r => DeliveryReceiptV1.parse(JSON.parse(String(r.data))));
  }
  activeReceipts(): Receipt[] {
    return (this.db.prepare("SELECT data FROM continuity_receipts WHERE active=1").all() as Row[])
      .map(r => DeliveryReceiptV1.parse(JSON.parse(String(r.data))));
  }
  lastAccepted(bindingId: string, epoch: number): Receipt | undefined {
    return decode(this.db.prepare(`SELECT r.data AS data FROM continuity_receipts r JOIN continuity_packets p ON p.id=r.packet_id
      WHERE r.binding_id=? AND json_extract(r.data,'$.status')='accepted' AND json_extract(p.data,'$.target.sessionEpoch')=?
      ORDER BY r.rowid DESC LIMIT 1`).get(bindingId, epoch) as Row | undefined);
  }
  receiptForRun(id: string): Receipt | undefined {
    return decode(this.db.prepare("SELECT data FROM continuity_receipts WHERE json_extract(data,'$.runId')=?").get(id) as Row | undefined);
  }
  transition(id: string, status: Receipt["status"], execution: Receipt["execution"], evidence: string | null): Receipt {
    this.assertOwner();
    return this.transaction(() => {
      const old = decode<Receipt>(this.db.prepare("SELECT data FROM continuity_receipts WHERE id=?").get(id) as Row | undefined);
      if (!old) throw new ContinuityError("invalid", "receipt not found");
      const allowed: Record<Receipt["status"], Receipt["status"][]> = {
        prepared: ["submitting", "failed"], submitting: ["accepted", "failed", "outcome_unknown"],
        accepted: ["accepted"], failed: [], outcome_unknown: [] };
      if (!allowed[old.status].includes(status)) throw new ContinuityError("conflict", `invalid receipt transition ${old.status} -> ${status}`);
      if (status === "accepted" && !evidence) throw new ContinuityError("invalid", "native acceptance requires correlated evidence");
      const next = DeliveryReceiptV1.parse({ ...old, status, execution, evidence, updatedAt: Date.now() });
      this.writeReceipt(next, execution === "running" || execution === "unknown");
      return next;
    });
  }
  private writeReceipt(receipt: Receipt, active: boolean): void {
    this.db.prepare("UPDATE continuity_receipts SET active=?,data=? WHERE id=?").run(active ? 1 : 0, JSON.stringify(receipt), receipt.id);
  }
  assertWorkspaceIdle(workspace: string): void {
    this.assertOwner();
    if (this.db.prepare("SELECT id FROM continuity_receipts WHERE workspace=? AND active=1").get(workspace))
      throw new ContinuityError("recovery_required", "workspace has an active or uncertain native run; finish, interrupt, or reconcile it first");
  }
  reconcile(id: string, evidence: string): void {
    this.assertOwner();
    this.transaction(() => {
      const receipt = decode<Receipt>(this.db.prepare("SELECT data FROM continuity_receipts WHERE id=?").get(id) as Row | undefined);
      if (!receipt || receipt.execution !== "unknown")
        throw new ContinuityError("conflict", "only uncertain runs require manual reconciliation");
      if (!evidence.trim() || evidence.length > 2000) throw new ContinuityError("invalid", "record how native process termination and workspace were checked");
      this.writeReceipt({ ...receipt, execution: "interrupted", evidence: `user reconciliation: ${evidence}`, updatedAt: Date.now() }, false);
      const row = this.db.prepare("SELECT data FROM continuity_bindings WHERE id=?").get(receipt.bindingId) as Row | undefined;
      const binding = decode<Binding>(row);
      if (binding) this.updateBinding({ ...binding, nativeSessionId: null, sessionEpoch: binding.sessionEpoch + 1, retention: "unknown" });
    });
  }
  search(chat: string, query: string, limit = 12): LoomEvent[] {
    const words = query.match(/[\p{L}\p{N}_./-]+/gu)?.slice(0, 24) ?? [];
    if (!words.length) return [];
    let rows: Row[];
    if (this.fts) {
      const match = words.map(w => `"${w.replaceAll('"', '""')}"`).join(" OR ");
      rows = this.db.prepare("SELECT rowid AS id FROM continuity_search WHERE chat=? AND continuity_search MATCH ? ORDER BY bm25(continuity_search) LIMIT ?")
        .all(chat, match, Math.min(50, Math.max(1, limit))) as Row[];
    } else {
      rows = this.db.prepare(`SELECT id FROM events WHERE coalesce(chat,'${MAIN_CHAT}')=? AND payload LIKE ? ESCAPE '\\' ORDER BY id DESC LIMIT ?`)
        .all(chat, `%${words[0]!.replace(/[\\%_]/g, "\\$&")}%`, Math.min(50, Math.max(1, limit))) as Row[];
    }
    return rows.map(r => this.event(Number(r.id))!);
  }
  rebuildSearch(): void {
    this.assertOwner();
    if (!this.fts) return; // Lexical fallback reads canonical events directly.
    this.transaction(() => {
      this.db.exec(`DELETE FROM continuity_search;
        INSERT INTO continuity_search(rowid,chat,text)
          SELECT id,coalesce(chat,'${MAIN_CHAT}'),coalesce(json_extract(payload,'$.text'),payload) FROM events;`);
    });
  }
  get searchMode(): "fts5" | "lexical" { return this.fts ? "fts5" : "lexical"; }
  get backupFiles(): string[] { return fs.readdirSync(path.dirname(this.file)).filter(f => f.startsWith("log.db.before-brain-v1.")); }
}
