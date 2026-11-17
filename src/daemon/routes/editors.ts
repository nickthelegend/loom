import type { Express, Request } from "express";
import { detectEditors, lastEditor, openInEditor } from "../../core/editors.js";
import type { WithRuntime } from "./context.js";

function allowed(req: Request): boolean {
  const who = req as Request & { guest?: unknown; projectScope?: string[] | null };
  return !who.guest && !who.projectScope;
}

export function registerEditorsRoutes(app: Express, withRuntime: WithRuntime): void {
  /** Owner/own unscoped devices only. Returns {editors: [{id, label}], lastEditor: string | null}.
   * Stable ids are launcher names (code, cursor, zed, windsurf, idea, webstorm,
   * pycharm, goland, clion, rider, phpstorm, rubymine, subl), plus xcode on macOS.
   * An absent lastEditor in the list means that editor is no longer installed.
   */
  app.get("/api/editors", (req, res) => {
    if (!allowed(req)) return void res.status(403).json({ error: "editors are private to the owner and unscoped devices" });
    res.json({ editors: detectEditors().map(({ id, label }) => ({ id, label })), lastEditor: lastEditor() });
  });
  /** POST {editor: string, path?: string, line?: positive integer}.
   * path defaults to the project directory; relative paths are project-relative.
   * Returns {editor, path: canonical absolute path, line?} after the launcher spawns,
   * and remembers editor for this OS user. 400: invalid editor/path/line or launch failure;
   * 403: scoped/guest device. Paths outside the project, including symlinks, are refused.
   */
  app.post("/api/projects/:id/open-in", withRuntime(async (rt, req, res) => {
    if (!allowed(req)) return void res.status(403).json({ error: "only the owner and unscoped devices can open editors" });
    const { editor, path, line } = req.body ?? {};
    if (typeof editor !== "string" || !editor || (path !== undefined && typeof path !== "string") ||
      (line !== undefined && (!Number.isSafeInteger(line) || line < 1)))
      return void res.status(400).json({ error: "send {editor, path?: string, line?: positive integer}" });
    try { res.json(await openInEditor(rt.info.dir, editor, path, line)); }
    catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : String(error) }); }
  }));
}
