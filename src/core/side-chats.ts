import { randomUUID } from "node:crypto";
import { EventHub } from "../providers/adapter.js";

export interface SideMessage { role: "user" | "agent"; text: string; /** Epoch milliseconds. */ at: number }
export interface SideView { messages: SideMessage[]; busy: boolean; /** Last turn failure; close and reopen the side to start fresh. */ error?: string }
/** Each frame has exactly one of delta, message or done. A message replaces that turn's accumulated delta. */
export type SideFrame = { chat: string; sideId: string } & (
  { delta: string } | { message: SideMessage } | { done: true; error?: string }
);
/** Full WebSocket envelope; private frames are never replayed from the event log. */
export type SideSocketFrame = SideFrame & { type: "side"; projectId: string };

export interface SideDriver {
  send(text: string, delta: (text: string) => void): Promise<string>;
  close(): Promise<void>;
}
interface Side extends SideView { id: string; chat: string; driver: SideDriver; closed: boolean; pending?: Promise<void> }

export class SideChatError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

/** Ephemeral conversations. This store deliberately has no event-log or memory writer. */
export class SideChats {
  private readonly sides = new Map<string, Side>();
  private readonly events = new EventHub<SideFrame>();
  private closed = false;

  constructor(private readonly create: (chat: string) => SideDriver, private readonly timeoutMs = 5 * 60_000) {}

  onEvent(listener: (frame: SideFrame) => void): () => void { return this.events.subscribe(listener); }

  private find(chat: string, id: string): Side {
    const side = this.sides.get(id);
    if (!side || side.chat !== chat) throw new SideChatError("no such side chat", 404);
    return side;
  }

  get(chat: string, id: string): SideView {
    const side = this.find(chat, id);
    return { messages: side.messages.map(m => ({ ...m })), busy: side.busy, ...(side.error ? { error: side.error } : {}) };
  }

  /** One drawer per parent chat. Omitting sideId starts it or continues the open drawer; a supplied id must exist. */
  send(chat: string, text: string, sideId?: string): { sideId: string } {
    if (this.closed) throw new SideChatError("project is closing", 409);
    if (!text.trim() || text.length > 32_000) throw new SideChatError("text must be between 1 and 32000 characters", 400);
    let side = sideId ? this.find(chat, sideId) : [...this.sides.values()].find(s => s.chat === chat);
    if (side?.busy) throw new SideChatError("side chat is busy", 409);
    if (side?.error) throw new SideChatError("close the failed side chat before asking again", 409);
    if (!side) {
      side = { id: randomUUID(), chat, driver: this.create(chat), messages: [], busy: false, closed: false };
      this.sides.set(side.id, side);
    }
    side.busy = true;
    const message: SideMessage = { role: "user", text: text.trim(), at: Date.now() };
    side.messages.push(message);
    this.events.publish({ chat, sideId: side.id, message });
    side.pending = this.answer(side, message.text);
    return { sideId: side.id };
  }

  private async answer(side: Side, text: string): Promise<void> {
    const frame = { chat: side.chat, sideId: side.id };
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const reply = await Promise.race([
        side.driver.send(text, delta => { if (!side.closed) this.events.publish({ ...frame, delta }); }),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("side chat timed out")), this.timeoutMs); timer.unref(); }),
      ]);
      if (!side.closed) {
        const message: SideMessage = { role: "agent", text: reply, at: Date.now() };
        side.messages.push(message);
        this.events.publish({ ...frame, message });
      }
    } catch (error) {
      side.error = error instanceof Error ? error.message : String(error);
      await side.driver.close().catch(() => {});
    } finally {
      if (timer) clearTimeout(timer);
      side.busy = false;
      if (!side.closed) this.events.publish({ ...frame, done: true, ...(side.error ? { error: side.error } : {}) });
    }
  }

  async delete(chat: string, id: string): Promise<void> {
    const side = this.find(chat, id);
    side.closed = true;
    this.sides.delete(id);
    await side.driver.close();
    await side.pending;
    this.events.publish({ chat, sideId: id, done: true });
  }

  async closeChat(chat: string): Promise<void> {
    await Promise.all([...this.sides.values()].filter(s => s.chat === chat).map(s => this.delete(chat, s.id)));
  }

  async close(): Promise<void> {
    this.closed = true;
    await Promise.all([...this.sides.values()].map(s => this.delete(s.chat, s.id)));
  }
}
