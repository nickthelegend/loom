import type { EventKind, LoomEvent, NewEvent } from "../../types.js";

export interface ListOpts {
  since?: number; // exclusive event id
  /** Only events older than this id (exclusive) — paging a thread backwards. */
  before?: number;
  limit?: number;
  kinds?: EventKind[];
  /**
   * Only this conversation. Asking for the main chat also returns events
   * written before chats existed — they have no id and belong to it.
   * Omit to read the whole project, which is what the brain wants.
   */
  chat?: string;
  /** Only events written at or after this time (ms) — a day's spend, a 30-day chart — without reading the rest. */
  sinceTs?: number;
  /** Only this agent's events. */
  agentId?: string;
}

/** The store behind a project's log. Exported so search can take a narrow
 * slice of it (list) rather than the whole EventLog — a searcher has no
 * business being able to append. */
export interface EventStore {
  append(
    e: Required<Omit<NewEvent, "agentId" | "chat">> & { agentId?: string; chat?: string },
  ): LoomEvent;
  list(opts?: ListOpts): LoomEvent[];
  /** How many events match, without reading them (limit is ignored). */
  count(opts?: ListOpts): number;
  lastId(): number;
  /** The newest agent message id per chat (a missing chat is main's). */
  lastReplyIds(): Map<string, number>;
  /** Bytes on disk and events held. */
  size(): { bytes: number; events: number };
  /** Reclaim free space (SQLite VACUUM). Never drops an event. */
  compact(): void;
  close(): void;
}

/** Read access to canonical history; no storage lifecycle or mutation authority. */
export interface EventReader {
  list(opts?: ListOpts): LoomEvent[];
  lastId(): number;
}

/** App-owned history used by Brain and execution. Only its owner closes it. */
export interface EventJournal extends EventReader {
  append(event: NewEvent): LoomEvent;
  onEvent(callback: (event: LoomEvent) => void): () => void;
}
