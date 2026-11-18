export interface Draft { draft: string; revision: number }

/** Serialize edits so a slow response cannot overwrite a newer keystroke. */
export class DraftSession {
  private revision = 0;
  private stopped = false;
  private queue: Promise<unknown>;
  edited = false;
  private write: (draft: Draft) => Promise<Draft>;
  private failed: (error: unknown) => void;
  constructor(read: () => Promise<Draft>, write: (draft: Draft) => Promise<Draft>, loaded: (text: string) => void, failed: (error: unknown) => void) {
    this.write = write; this.failed = failed;
    this.queue = read().then(d => { this.revision = d.revision; if (!this.edited) loaded(d.draft); })
      .catch(e => { this.stopped = true; failed(e); });
  }
  save(text: string): Promise<unknown> {
    this.edited = true;
    this.queue = this.queue.then(async () => {
      if (this.stopped) return;
      const d = await this.write({ draft: text, revision: this.revision });
      this.revision = d.revision;
    }).catch(e => { this.stopped = true; this.failed(e); });
    return this.queue;
  }
}

export function firstUnread(events: Array<{ id: number; kind: string; agentId?: string; payload: Record<string, unknown> }>, seen?: number): number | null {
  if (seen === undefined) return null;
  return events.find(e => e.id > seen && e.kind === "message" && e.agentId && !e.payload.reasoning)?.id ?? null;
}

export function variables(text: string): string[] {
  return [...new Set([...text.matchAll(/\{\{\s*([\w-]+)\s*\}\}/g)].map(m => m[1]!))];
}
export function fillVariables(text: string, values: Record<string, string>): string {
  return text.replace(/\{\{\s*([\w-]+)\s*\}\}/g, (_, key: string) => Object.hasOwn(values, key) ? values[key]! : "");
}
