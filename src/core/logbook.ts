/**
 * Everything that went wrong, kept where you can see it.
 *
 * Before this, an error had two possible fates: `console.error` into
 * ~/.loom/daemon.log — a file you have to know about, find, and tail — or one
 * of the 48 empty `catch {}` blocks in this codebase, where it stopped existing
 * entirely. Neither reaches the person looking at the window wondering why
 * nothing happened.
 *
 * So: a ring buffer in the daemon, streamed to the app's Console tab. Bounded
 * on purpose — a long-lived daemon that keeps every log line it ever wrote is a
 * memory leak with good intentions. The tail is what you want anyway; the whole
 * history is in daemon.log.
 *
 * This does NOT replace the log file, and the duplication is deliberate. The
 * Console is for the error you're looking at right now; the file is for the one
 * that killed the daemon at 3am, when there was no window to look at.
 */

export type LogLevel = "error" | "warn" | "info";

export interface LogRecord {
  id: number;
  at: number;
  level: LogLevel;
  /** Which part of Loom is talking: "daemon", "adapter:codex", "board", … */
  scope: string;
  message: string;
  /** A stack, a stderr tail, an HTTP body — whatever helps. Trimmed. */
  detail?: string;
  /** The project it belongs to, when it belongs to one. */
  project?: string;
}

const MAX_RECORDS = 500;
const MAX_DETAIL = 4000;

type Listener = (r: LogRecord) => void;

class Logbook {
  private records: LogRecord[] = [];
  private listeners = new Set<Listener>();
  private nextId = 1;

  /**
   * Record something, and say it out loud.
   *
   * Both, always: the buffer is for the window and the console is for the file.
   * An error that only reaches one of them is an error someone won't see.
   */
  add(level: LogLevel, scope: string, message: string, detail?: unknown, project?: string): LogRecord {
    const record: LogRecord = {
      id: this.nextId++,
      at: Date.now(),
      level,
      scope,
      message: String(message).slice(0, 500),
      ...(detail === undefined ? {} : { detail: stringify(detail) }),
      ...(project ? { project } : {}),
    };
    this.records.push(record);
    if (this.records.length > MAX_RECORDS) this.records.splice(0, this.records.length - MAX_RECORDS);

    const line = `[${new Date(record.at).toISOString()}] ${level} ${scope}: ${record.message}`;
    if (level === "error") console.error(line + (record.detail ? `\n${record.detail}` : ""));
    else if (level === "warn") console.warn(line);
    else console.log(line);

    for (const l of this.listeners) {
      try {
        l(record);
      } catch {
        // A broken subscriber must not break logging — that would be a fine
        // irony to debug with no logs.
      }
    }
    return record;
  }

  error(scope: string, message: string, detail?: unknown, project?: string): LogRecord {
    return this.add("error", scope, message, detail, project);
  }

  warn(scope: string, message: string, detail?: unknown, project?: string): LogRecord {
    return this.add("warn", scope, message, detail, project);
  }

  info(scope: string, message: string, detail?: unknown, project?: string): LogRecord {
    return this.add("info", scope, message, detail, project);
  }

  /** The tail, newest last. `since` is an id, for polling without duplicates. */
  list(opts: { since?: number; level?: LogLevel; project?: string; limit?: number } = {}): LogRecord[] {
    let out = this.records;
    if (opts.since !== undefined) out = out.filter((r) => r.id > opts.since!);
    if (opts.level) out = out.filter((r) => r.level === opts.level);
    if (opts.project) out = out.filter((r) => r.project === opts.project);
    const limit = opts.limit ?? 200;
    return out.slice(-limit);
  }

  clear(): void {
    this.records = [];
  }

  subscribe(l: Listener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }
}

/** One book per process. The daemon is the process that has things go wrong in it. */
export const logbook = new Logbook();

/**
 * Turn whatever was thrown into something readable.
 *
 * Errors carry a stack; the rest carry whatever they carry. `String(err)` on a
 * plain object gives "[object Object]", which is the least useful sentence in
 * computing.
 */
function stringify(detail: unknown): string {
  if (detail === undefined || detail === null) return "";
  let text: string;
  if (detail instanceof Error) text = detail.stack ?? `${detail.name}: ${detail.message}`;
  else if (typeof detail === "string") text = detail;
  else {
    try {
      text = JSON.stringify(detail, null, 2);
    } catch {
      text = String(detail);
    }
  }
  return text.length > MAX_DETAIL ? `${text.slice(0, MAX_DETAIL)}\n… (${text.length - MAX_DETAIL} more)` : text;
}
