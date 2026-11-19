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
    const person = group.people.get(socket);
    const nextTyping = typing ?? person?.typing ?? false;
    group.people.set(socket, { ...who, typing: nextTyping, since: person?.since ?? Date.now() });
    const view = this.views.get(socket);
    if (view) view.expiry.refresh();
    else {
      const expiry = setTimeout(() => this.remove(socket), PRESENCE_TTL_MS);
      expiry.unref();
      this.views.set(socket, { group, expiry });
    }
    if (!person || person.typing !== nextTyping) this.changed(group);
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
  }
}
