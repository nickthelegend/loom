import type { Express } from 'express';
import { logbook } from "../../core/logbook.js";
import { findSpecs, playwrightSetup, type SpecRun } from "../specs.js";
import type { RouteContext, WithRuntime } from './context.js';
/** Register specs routes in the order established by LoomDaemon.routes(). */
export function registerSpecsRoutes(app: Express, ctx: Pick<RouteContext, "specRunner" | "broadcastTerm">, withRuntime: WithRuntime): void {

  // ---- the Browser tab: Playwright specs -------------------------------
  // Agents write browser tests constantly and Loom had nowhere to watch them
  // run. List the project's specs, run one, stream the reporter over the
  // same socket the thread uses, and let a failure be handed back to an
  // agent. Playwright stays the project's dependency, not Loom's.
  app.get(
    "/api/projects/:id/specs",
    withRuntime(async (rt, _req, res) => {
      const setup = playwrightSetup(rt.info.dir);
      res.json({
        specs: findSpecs(rt.info.dir),
        running: ctx.specRunner.running(rt.info.id),
        // so an empty list can say why: no Playwright here at all, or no specs yet
        playwright: !!(setup.config || setup.dependency),
        testDir: setup.testDir,
      });
    }),
  );

  app.post(
    "/api/projects/:id/specs/run",
    withRuntime(async (rt, req, res) => {
      const file = String((req.body as { file?: string } | undefined)?.file ?? "").trim();
      if (!file) return void res.status(400).json({ error: "missing file" });
      try {
        const run = ctx.specRunner.start(rt.info.id, rt.info.dir, file, {
          onLine: (r: SpecRun, line: string) =>
            ctx.broadcastTerm(rt.info.id, { type: "spec", runId: r.id, file: r.file, line }),
          onDone: (r: SpecRun) => {
            ctx.broadcastTerm(rt.info.id, {
              type: "spec_done",
              runId: r.id,
              file: r.file,
              exitCode: r.exitCode,
              ...(r.stopped ? { stopped: r.stopped } : {}),
            });
            // The Console keeps the record; the stream is for watching live.
            if (r.exitCode === 0) {
              logbook.info("specs", `${r.file} passed`, undefined, rt.info.id);
            } else if (r.stopped === "stop") {
              logbook.info("specs", `${r.file} stopped`, undefined, rt.info.id);
            } else {
              logbook.error(
                "specs",
                `${r.file} failed (exit ${r.exitCode})`,
                r.lines.slice(-40).join("\n"),
                rt.info.id,
              );
            }
          },
        });
        res.json({ run: { id: run.id, file: run.file, startedAt: run.startedAt } });
      } catch (err) {
        res.status(409).json({ error: err instanceof Error ? err.message : String(err) });
      }
    }),
  );

  app.post(
    "/api/projects/:id/specs/stop",
    withRuntime(async (rt, _req, res) => {
      res.json({ stopped: ctx.specRunner.stop(rt.info.id) });
    }),
  );
}
