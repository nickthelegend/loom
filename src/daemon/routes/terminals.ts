import type { Express, Request, Response } from 'express';
import { findProject } from "../../core/registry.js";
import { TooManySessionsError } from "../terminals.js";
import type { RouteContext } from './context.js';
/** Register terminals routes in the order established by LoomDaemon.routes(). */
export function registerTerminalsRoutes(app: Express, ctx: Pick<RouteContext, "terminals">): void {
  // A shell is this machine, not a project: the owner and their own (unscoped) devices only —
  // never a token limited to some projects, never a guest (#380).
  const notOwnDevice = (req: Request, res: Response): boolean => {
    const r = req as Request & { guest?: unknown; projectScope?: string[] | null };
    if (!r.guest && !r.projectScope) return false;
    res.status(403).json({ error: "the terminal is for this machine's owner and their own devices" });
    return true;
  };

  // Terminal: one long-lived shell per tab. A real pty when node-pty is
  // available (echo, job control, vim), otherwise a pipe-backed shell — see
  // terminals.ts. Output streams over the project WebSocket; input arrives
  // there too, because a tty needs a round-trip per keystroke. Bearer auth +
  // the tailnet are the trust boundary, same as the agents the daemon runs.
  app.post("/api/projects/:id/term/open", (req, res) => {
    if (notOwnDevice(req, res)) return;
    const info = findProject(String(req.params.id));
    if (!info) return void res.status(404).json({ error: "unknown project" });
    const { term, cols, rows } = (req.body ?? {}) as {
      term?: string;
      cols?: number;
      rows?: number;
    };
    const termId = String(term ?? "t1");
    const existing = ctx.terminals.get(info.id, termId);
    if (existing) {
      // A reload rejoins the session it left, and gets replayed what it missed.
      return void res.json({
        term: termId,
        cwd: existing.cwd,
        mode: existing.mode,
        reused: true,
        scrollback: existing.scrollback(),
      });
    }
    try {
      const sess = ctx.terminals.open(info.id, termId, info.dir, cols ?? 80, rows ?? 24);
      res.json({ term: termId, cwd: sess.cwd, mode: sess.mode, reused: false, scrollback: "" });
    } catch (err) {
      // only the cap is a 429 — a shell that won't spawn is our problem, not
      // the client's rate
      res.status(err instanceof TooManySessionsError ? 429 : 500).json({
        error: (err as Error).message,
      });
    }
  });

  app.post("/api/projects/:id/term/input", (req, res) => {
    if (notOwnDevice(req, res)) return;
    const info = findProject(String(req.params.id));
    if (!info) return void res.status(404).json({ error: "unknown project" });
    const { term, data } = (req.body ?? {}) as { term?: string; data?: string };
    const termId = String(term ?? "t1");
    try {
      // this opens a session when none exists, so it can fail the same ways
      // /term/open can — uncaught, Express answers a JSON client with HTML
      const sess =
        ctx.terminals.get(info.id, termId) ?? ctx.terminals.open(info.id, termId, info.dir);
      sess.write(String(data ?? ""));
      res.json({ ok: true });
    } catch (err) {
      res.status(err instanceof TooManySessionsError ? 429 : 500).json({
        error: (err as Error).message,
      });
    }
  });

  app.post("/api/projects/:id/term/signal", (req, res) => {
    if (notOwnDevice(req, res)) return;
    const info = findProject(String(req.params.id));
    if (!info) return void res.status(404).json({ error: "unknown project" });
    const sess = ctx.terminals.get(info.id, String((req.body ?? {}).term ?? "t1"));
    if (!sess) return void res.json({ signalled: false });
    sess.interrupt();
    res.json({ signalled: true });
  });

  app.post("/api/projects/:id/term/resize", (req, res) => {
    if (notOwnDevice(req, res)) return;
    const info = findProject(String(req.params.id));
    if (!info) return void res.status(404).json({ error: "unknown project" });
    const { term, cols, rows } = (req.body ?? {}) as {
      term?: string;
      cols?: number;
      rows?: number;
    };
    const sess = ctx.terminals.get(info.id, String(term ?? "t1"));
    if (!sess) return void res.json({ resized: false });
    sess.resize(Number(cols) || 80, Number(rows) || 24);
    res.json({ resized: true });
  });

  app.post("/api/projects/:id/term/close", (req, res) => {
    if (notOwnDevice(req, res)) return;
    const info = findProject(String(req.params.id));
    if (!info) return void res.status(404).json({ error: "unknown project" });
    ctx.terminals.close(info.id, String((req.body ?? {}).term ?? "t1"));
    res.json({ closed: true });
  });
}
