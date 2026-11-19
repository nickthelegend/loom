export type QuickAction = "new-chat" | "approvals" | "projects";
export function quickAction(id: unknown): QuickAction | null {
  return id === "new-chat" || id === "approvals" || id === "projects" ? id : null;
}
export function sharedText(value: { text?: string | null; webUrl?: string | null }): string {
  return [value.text, value.webUrl].filter((v, i, a) => v && a.indexOf(v) === i).join("\n").slice(0, 100_000);
}
export interface DiffLocation { file: string; line: number; side: "old" | "new"; text: string }
export function diffLocations(patch: string): Array<DiffLocation | null> {
  let file = "", old = 0, next = 0, hunk = false;
  return patch.split("\n").map(text => {
    const header = /^diff --git a\/.+ b\/(.+)$/.exec(text);
    if (header) { file = header[1]!; hunk = false; return null; }
    const range = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text);
    if (range) { old = Number(range[1]); next = Number(range[2]); hunk = true; return null; }
    if (!hunk || !file || !/^[ +\-]/.test(text)) return null;
    const removed = text[0] === "-";
    const location: DiffLocation = { file, line: removed ? old : next, side: removed ? "old" : "new", text: text.slice(1) };
    if (text[0] !== "+") old++;
    if (!removed) next++;
    return location;
  });
}
export function lineQuestion(l: DiffLocation): string {
  return `Explain this diff line in ${l.file}:${l.line} (${l.side}):\n\n${l.text}\n`;
}

export function cachedChatHits(events: Array<{ id: number; kind: string; chat?: string; payload: Record<string, unknown> }>, chat: string, query: string): Array<{ eventId: number; snippet: string }> {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  return events.filter(e => e.kind === "message" && (e.chat || "main") === chat).slice().reverse().flatMap(e => {
    const text = String(e.payload.text ?? ""), at = text.toLowerCase().indexOf(needle);
    if (at < 0) return [];
    const start = Math.max(0, at - 60);
    return [{ eventId: e.id, snippet: (start ? "…" : "") + text.slice(start, start + 200) }];
  }).slice(0, 100);
}

export interface PendingMessage { id: string; project: string; chat: string; text: string; agentId?: string; plan?: boolean; error?: string }
/** Serial writes and deliveries keep taps, reconnects and a slow disk from losing messages. */
export class Outbox {
  items: PendingMessage[] = [];
  private tail: Promise<unknown> = Promise.resolve();
  private flushing: Promise<void> | null = null;
  inFlight: string | null = null;
  private read: () => Promise<string | null>;
  private write: (value: string) => Promise<void>;
  private send: (item: PendingMessage) => Promise<unknown>;
  constructor(read: () => Promise<string | null>, write: (value: string) => Promise<void>, send: (item: PendingMessage) => Promise<unknown>) {
    this.read = read; this.write = write; this.send = send;
  }
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const task = this.tail.then(fn); this.tail = task.catch(() => {}); return task;
  }
  load(): Promise<void> { return this.serial(async () => { const value = await this.read(); this.items = value ? JSON.parse(value) : []; }); }
  add(item: PendingMessage): Promise<void> { return this.serial(async () => {
    const next = [...this.items, item]; await this.write(JSON.stringify(next)); this.items = next;
  }); }
  remove(id: string): Promise<void> { return this.serial(async () => {
    if (this.inFlight === id) throw new Error("This message is being sent. Check the chat before discarding it.");
    const next = this.items.filter(i => i.id !== id); await this.write(JSON.stringify(next)); this.items = next;
  }); }
  flush(allowed: () => boolean = () => true): Promise<void> {
    if (this.flushing) return this.flushing;
    const run = async () => {
      await this.tail;
      while (this.items.length && allowed()) {
        const item = this.items[0]!;
        if (item.error) return;
        this.inFlight = item.id;
        try { await this.send(item); }
        catch (e) {
          const status = (e as { status?: number }).status;
          if (status && status >= 400 && status < 500) await this.serial(async () => {
            const next = this.items.map(i => i.id === item.id ? { ...i, error: e instanceof Error ? e.message : String(e) } : i);
            await this.write(JSON.stringify(next)); this.items = next;
          });
          return;
        } finally { this.inFlight = null; }
        await this.remove(item.id);
      }
    };
    const task = run(); this.flushing = task;
    const done = () => { this.flushing = null; };
    void task.then(done, done);
    return task;
  }
}
