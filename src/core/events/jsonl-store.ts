import fs from "node:fs";
import type { LoomEvent, NewEvent } from "../../types.js";
import { MAIN_CHAT } from "../../types.js";
import type { EventStore, ListOpts } from "./contracts.js";

export class JsonlStore implements EventStore {
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
      id: this.nextId,
      ts: e.ts,
      kind: e.kind,
      ...(e.agentId ? { agentId: e.agentId } : {}),
      ...(e.chat ? { chat: e.chat } : {}),
      payload: e.payload,
    };
    const serialized = JSON.stringify(ev);
    fs.appendFileSync(this.file, serialized + "\n");
    this.nextId++;
    this.cache.push(JSON.parse(serialized) as LoomEvent);
    return ev;
  }

  count(opts: ListOpts = {}): number {
    return this.filtered({ ...opts, limit: undefined }).length;
  }

  list(opts: ListOpts = {}): LoomEvent[] {
    return structuredClone(this.filtered(opts));
  }

  private filtered(opts: ListOpts): LoomEvent[] {
    let out = this.cache;
    if (opts.since !== undefined) out = out.filter((e) => e.id > opts.since!);
    if (opts.before !== undefined) out = out.filter((e) => e.id < opts.before!);
    if (opts.kinds?.length) out = out.filter((e) => opts.kinds!.includes(e.kind));
    if (opts.sinceTs !== undefined) out = out.filter((e) => e.ts >= opts.sinceTs!);
    if (opts.agentId !== undefined) out = out.filter((e) => e.agentId === opts.agentId);
    // must match SqliteStore exactly: an event with no chat is main's
    if (opts.chat !== undefined) {
      out = out.filter((e) =>
        opts.chat === MAIN_CHAT ? (e.chat ?? MAIN_CHAT) === MAIN_CHAT : e.chat === opts.chat,
      );
    }
    if (opts.limit && out.length > opts.limit) out = out.slice(-opts.limit);
    return out;
  }

  lastId(): number {
    return this.cache[this.cache.length - 1]?.id ?? 0;
  }

  size(): { bytes: number; events: number } {
    let bytes = 0;
    try {
      bytes = fs.statSync(this.file).size;
    } catch {
      /* not written yet */
    }
    return { bytes, events: this.cache.length };
  }

  compact(): void {
    // an append-only text log has no free pages to reclaim
  }

  lastReplyIds(): Map<string, number> {
    const out = new Map<string, number>();
    for (const e of this.cache) if (e.kind === "message" && e.agentId) out.set(e.chat ?? MAIN_CHAT, e.id);
    return out;
  }

  close(): void {}
}
