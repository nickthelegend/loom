import { scoreboardCsv, scoreboardDigest } from "../../core/scoreboard.js";
import type { Express, Request } from "express";
import { findProject, listProjects } from "../../core/registry.js";
import { readScoreboard, scoreboardWindow } from "../../core/scoreboard.js";
import { listFleets, removeFleet, saveFleet } from "../../core/fleets.js";

/** Authenticated APIs for scoreboard and fleet pickers. Guests are refused by the
 * daemon's shared-chat wall. Project-scoped devices see only their allowed projects;
 * user-wide fleets require an owner or unscoped device.
 * GET /api/scoreboard?project=<id|all>&window=<7d|30d|all> defaults to all/30d.
 * Returns Scoreboard (core/scoreboard.ts): { project, projects, window, since,
 * generatedAt, byKindModel: ModelStanding[], byModel: ModelStanding[] }.
 * GET /api/fleets -> { fleets: [{ name, spec }] }, sorted by name.
 * PUT /api/fleets { name, spec } -> { fleet: { name, spec } }; replaces that name.
 * DELETE /api/fleets { name } (or ?name=...) -> { removed: true }, 404 if absent.
 * Names are case-sensitive, 1–64 letters/digits/_/-, starting with a letter/digit.
 * Specs are comma-separated parser-validated rows; saved specs cannot reference
 * other fleets. Orchestra workers and compare entrants accept "@name" array rows.
 * Invalid windows, names and specs return 400 with { error: string }.
 */
export function registerScoreboardRoutes(app: Express): void {
  app.get("/api/scoreboard", async (req, res) => {
    try {
      const window = scoreboardWindow(req.query.window ?? "30d");
      const project = String(req.query.project ?? "all");
      const scope = (req as Request & { projectScope?: string[] | null }).projectScope;
      if (scope && (req.query.format || req.query.digest)) return void res.status(403).json({ error: "scoreboard export and digest require an unscoped session" });
      const selected = project === "all" ? listProjects() : [findProject(project)].filter(p => p !== undefined);
      if (project !== "all" && !selected.length) return void res.status(404).json({ error: "no such project" });
      if (project !== "all" && scope && !scope.includes(selected[0]!.id)) {
        return void res.status(403).json({ error: "this token is not scoped to that project" });
      }
      const board = await readScoreboard(selected.filter(p => !scope || scope.includes(p.id)), req.query.digest === "1" ? "7d" : window, project);
      if (req.query.format === "csv") { res.type("text/csv").attachment("loom-scoreboard.csv").send(scoreboardCsv(board, req.query.by === "byModel" ? "byModel" : "byKindModel")); return; }
      if (req.query.format === "csv-json") { res.json({ csv: scoreboardCsv(board, req.query.by === "byModel" ? "byModel" : "byKindModel") }); return; }
      if (req.query.digest === "1") { res.json({ text: scoreboardDigest(board), board }); return; }
      res.json(board);
    } catch (err) { res.status(400).json({ error: (err as Error).message }); }
  });
  app.use("/api/fleets", (req, res, next) => {
    if ((req as Request & { projectScope?: string[] | null }).projectScope) {
      return void res.status(403).json({ error: "fleets require an owner or unscoped token" });
    }
    next();
  });
  app.get("/api/fleets", (_req, res) => {
    try { res.json({ fleets: listFleets() }); }
    catch (err) { res.status(500).json({ error: (err as Error).message }); }
  });
  app.put("/api/fleets", (req, res) => {
    try { res.json({ fleet: saveFleet(req.body?.name, req.body?.spec) }); }
    catch (err) { res.status(400).json({ error: (err as Error).message }); }
  });
  app.delete("/api/fleets", (req, res) => {
    try {
      if (!removeFleet(req.body?.name ?? req.query.name)) return void res.status(404).json({ error: "unknown fleet" });
      res.json({ removed: true });
    } catch (err) { res.status(400).json({ error: (err as Error).message }); }
  });
}
