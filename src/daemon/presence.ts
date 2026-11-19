import { redactText } from "../core/redact.js";
import { PRESENCE_BROADCAST_MS, PRESENCE_TTL_MS, type PresencePerson, type PresenceSnapshot } from "../core/presence.js";

interface ChatPresence<T> {
  projectId: string;
  chat: string;
  people: Map<T, PresencePerson>;
  pending?: ReturnType<typeof setTimeout>;
}

/** Ephemeral views, owned by sockets. Nothing here reaches a project log or disk. */
export class ChatPresenceTracker<T> {
  private chats = new Map<string, ChatPresence<T>>();
  private views = new Map<T, { group: ChatPresence<T>; expiry: ReturnType<typeof setTimeout> }>();
  private closed = false;
  private listeners = new Map<T, (raw: unknown) => void>();
  private metadata = new Map<T, { chat: string; following?: boolean; view?: PresencePerson["view"] }>();
  ownerSocket: (socket: T) => boolean = () => false;

  constructor(private readonly publish: (snapshot: PresenceSnapshot) => void) {}

  view(socket: T, projectId: string, chat: string, who: Pick<PresencePerson, "id" | "name" | "kind">, typing?: boolean): void {
    if (this.closed) return;
    const previous = this.views.get(socket);
    if (previous && (previous.group.projectId !== projectId || previous.group.chat !== chat)) this.remove(socket);
    const key = JSON.stringify([projectId, chat]);
    let group = this.chats.get(key);
    if (!group) {
      group = { projectId, chat, people: new Map() };
      this.chats.set(key, group);
    }
    this.listen(socket);
    const person = group.people.get(socket);
    const metadata = this.metadata.get(socket);
    const extra = metadata?.chat === chat ? metadata : undefined;
    const nextTyping = typing ?? person?.typing ?? false;
    group.people.set(socket, { ...who, typing: nextTyping, since: person?.since ?? Date.now(),
      ...(who.kind === "guest" && extra?.following ? { following: true } : {}),
      ...(who.kind !== "guest" && this.ownerSocket(socket) && [...group.people.values()].some(p => p.kind === "guest" && p.following) && extra?.view ? { view: extra.view } : {}) });
    const view = this.views.get(socket);
    if (view) view.expiry.refresh();
    else {
      const expiry = setTimeout(() => this.remove(socket), PRESENCE_TTL_MS);
      expiry.unref();
      this.views.set(socket, { group, expiry });
    }
    if (!person || person.typing !== nextTyping || JSON.stringify(person.view) !== JSON.stringify(extra?.view) || Boolean(person.following) !== Boolean(extra?.following)) this.changed(group);
  }

  attach(socket: T): void { this.listen(socket); }

  private listen(socket: T): void {
    if (this.listeners.has(socket)) return;
    const ws = socket as T & { on?: (event: string, fn: (raw: unknown) => void) => void };
    if (!ws.on) return;
    const listener = (raw: unknown) => {
      try {
        const msg = JSON.parse(String(raw));
        if (msg?.type !== "presence" || typeof msg.chat !== "string") return;
        const group = this.views.get(socket)?.group;
        const who = group?.people.get(socket);
        if (who?.kind === "guest" && msg.chat !== group?.chat) return;
        const next: { chat: string; following?: boolean; view?: PresencePerson["view"] } = { chat: msg.chat };
        if (typeof msg.following === "boolean") next.following = msg.following;
        const previous = this.metadata.get(socket);
        if (previous && previous.chat === msg.chat) next.view = previous.view;
        if (this.ownerSocket(socket) && msg.view && Number.isFinite(msg.view.scroll)) {
          next.view = { chat: msg.chat, scroll: Math.max(0, Math.min(1, msg.view.scroll)),
            ...(typeof msg.view.file === "string" && msg.view.file.length < 500 && !msg.view.file.includes("\0") ? { file: redactText(msg.view.file), ...(typeof msg.view.preview === "string" ? { preview: redactText(msg.view.preview.slice(0, 20000)) } : {}) } : {}) };
        }
        this.metadata.set(socket, next);
      } catch { /* Presence is best-effort; malformed frames change nothing. */ }
    };
    this.listeners.set(socket, listener);
    ws.on("message", listener);
    ws.on("close", () => this.detach(socket));
  }

  private detach(socket: T): void {
    const listener = this.listeners.get(socket);
    const ws = socket as T & { off?: (event: string, fn: (raw: unknown) => void) => void };
    if (listener) ws.off?.("message", listener);
    this.listeners.delete(socket); this.metadata.delete(socket);
  }

  remove(socket: T): void {
    const view = this.views.get(socket);
    if (!view) return;
    clearTimeout(view.expiry);
    this.views.delete(socket);
    view.group.people.delete(socket);
    this.changed(view.group);
  }

  snapshot(projectId: string, chat: string): PresenceSnapshot {
    const group = this.chats.get(JSON.stringify([projectId, chat]));
    return { type: "presence", projectId, chat, people: [...(group?.people.values() ?? [])].map((p) => ({ ...p })) };
  }

  project(projectId: string): PresencePerson[] {
    const people = new Map<string, PresencePerson>();
    for (const group of this.chats.values()) if (group.projectId === projectId) {
      for (const person of group.people.values()) people.set(person.id, { ...person });
    }
    return [...people.values()];
  }

  private changed(group: ChatPresence<T>): void {
    const following = [...group.people.values()].some(p => p.kind === "guest" && p.following);
    for (const [socket, person] of group.people) {
      const metadata = this.metadata.get(socket);
      if (following && person.kind !== "guest" && this.ownerSocket(socket) && metadata?.chat === group.chat && metadata.view) person.view = metadata.view;
      else delete person.view;
    }
    if (group.pending) return;
    // Coalesce bursts across all sockets in a chat, keeping the final typing
    // state even when a start and stop arrive in the same quarter second.
    group.pending = setTimeout(() => {
      group.pending = undefined;
      this.publish(this.snapshot(group.projectId, group.chat));
      if (!group.people.size) this.chats.delete(JSON.stringify([group.projectId, group.chat]));
    }, PRESENCE_BROADCAST_MS);
    group.pending.unref();
  }

  close(): void {
    this.closed = true;
    for (const view of this.views.values()) clearTimeout(view.expiry);
    for (const group of this.chats.values()) if (group.pending) clearTimeout(group.pending);
    this.views.clear();
    this.chats.clear();
    for (const socket of this.listeners.keys()) this.detach(socket);
  }
}
