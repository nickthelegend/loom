import type { Express, Request } from 'express';
import { logbook, type LogLevel } from "../../core/logbook.js";
/** Register logs routes in the order established by LoomDaemon.routes(). */
export function registerLogsRoutes(app: Express): void {

  // ---- the Console ------------------------------------------------------
  // Everything that went wrong, for the tab next to the terminal. Until this
  // existed an error's only home was ~/.loom/daemon.log, which you have to
  // know about, find, and tail — so in practice errors reached nobody.
  app.get("/api/logs", (req, res) => {
    const since = req.query.since === undefined ? undefined : Number(req.query.since);
    const level = req.query.level as "error" | "warn" | "info" | undefined;
    // A scoped token sees its own projects' records and nothing daemon-wide —
    // the same rule the socket's log frames follow (daemon/delivery.ts).
    const scope = (req as Request & { projectScope?: string[] | null }).projectScope;
    const logs = logbook.list({
      ...(Number.isFinite(since) ? { since } : {}),
      ...(level ? { level } : {}),
      ...(req.query.project ? { project: String(req.query.project) } : {}),
    });
    res.json({ logs: scope ? logs.filter((r) => Boolean(r.project && scope.includes(r.project))) : logs });
  });

  app.delete("/api/logs", (req, res) => {
    // the book is every project's: clearing it is the owner's (or their own unscoped device's)
    if ((req as Request & { projectScope?: string[] | null }).projectScope) {
      return void res.status(403).json({ error: "clearing the Console needs an owner or unscoped token" });
    }
    logbook.clear();
    res.json({ ok: true });
  });

  /**
   * The window reporting its own errors — a failed fetch, a thrown render, an
   * unhandled rejection. Client-side failures used to die in the browser
   * console where no one was looking; now they land in the same Console tab as
   * the daemon's, streamed to every window and kept in the ring buffer.
   */
  app.post("/api/logs", (req, res) => {
    const b = (req.body ?? {}) as {
      level?: string;
      scope?: string;
      message?: string;
      detail?: unknown;
      project?: string;
    };
    const level: LogLevel = b.level === "error" || b.level === "warn" ? b.level : "info";
    const message = String(b.message ?? "").slice(0, 500);
    if (!message) return void res.status(400).json({ error: "missing message" });
    const scope = (b.scope ? String(b.scope) : "app").slice(0, 40);
    const rec = logbook.add(level, scope, message, b.detail, b.project ? String(b.project) : undefined);
    res.json({ ok: true, id: rec.id });
  });
}
