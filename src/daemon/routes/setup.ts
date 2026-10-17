import type { Express } from 'express';
import type { RouteContext } from './context.js';
import { readProjectConfig } from "../../core/registry.js";
import { findProject } from "../../core/registry.js";
import { setupReport } from "../../core/setup.js";
import { forgetProbes } from "../../adapters/base.js";
/** Register setup routes in the order established by LoomDaemon.routes(). */
export function registerSetupRoutes(app: Express, ctx: Pick<RouteContext, "runtimes">): void {

  /**
   * What this machine still needs — the same answer `loom doctor` gives.
   *
   * Behind the auth wall on purpose: it enumerates which agents you have
   * installed and which GUI apps are open, a small inventory of your machine
   * and none of a stranger's business — which matters the moment the daemon
   * binds past localhost (--host, Tailscale).
   *
   * Probing GUI bridges means a couple of HTTP round trips to their debug
   * ports, so this is a request you make when you open Settings, not something
   * the app polls.
   */
  app.get("/api/setup", (_req, res) => {
    forgetProbes(); // Setup is "look at this machine again": an agent just installed shows up now
    void setupReport()
      .then((report) => res.json(report))
      .catch((err) => res.status(500).json({ error: String(err?.message ?? err) }));
  });

  /**
   * `loom doctor`, over HTTP — the env checks always, plus one project's
   * checks when a ?project is given. Dynamically imported so doctor.js (which
   * pulls BUILD_REV back out of this file) doesn't create an import cycle at
   * module-init time.
   */
  app.get("/api/doctor", (req, res) => {
    forgetProbes();
    void (async () => {
      try {
        const { envChecks, projectChecks, providerChecks, freeModelTrouble, envFacts } = await import("../../cli/doctor.js");
        const [checks, providers] = await Promise.all([envChecks(), providerChecks()]);
        checks.push(...providers);
        const projId = (req.query as Record<string, string>).project;
        if (projId) {
          const info = findProject(projId);
          if (info) {
            checks.push(...projectChecks(info.dir));
            const rt = ctx.runtimes.get(info.id);
            const agents = readProjectConfig(info.dir)?.agents ?? [];
            if (rt) checks.push(...freeModelTrouble(rt.log.list({ kinds: ["error"], sinceTs: Date.now() - 86_400_000 }), agents));
          }
        }
        // what this daemon process sees — PATH and key NAMES, never values — so `loom doctor` can compare it with the shell
        res.json({ checks, facts: envFacts() });
      } catch (err) {
        res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
      }
    })();
  });
}
