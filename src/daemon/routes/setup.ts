import type { Express, Request } from 'express';
import type { RouteContext } from './context.js';
import { readProjectConfig } from "../../core/registry.js";
import { findProject } from "../../core/registry.js";
import { setupReport, signInCommand } from "../../core/setup.js";
import { setupRequirements, SetupInstallError, type SetupInstaller, type SetupCommandRunner } from "../../core/setup-install.js";
import { forgetProbes } from "../../adapters/base.js";
/** Register setup routes in the order established by LoomDaemon.routes(). */
export function registerSetupRoutes(app: Express, ctx: Pick<RouteContext, "runtimes" | "broadcastProjects">, installer: SetupInstaller, run?: SetupCommandRunner): void {

  /** GET -> SetupRequirements (core/setup-install.ts). Only unscoped callers
   * can inspect this machine. POST /install accepts exactly { kind } from
   * AGENT_INSTALLS; owner/admin only, including when a device uses loopback.
   * Streams InstallEvent frames to unscoped sockets. HTTP 200 -> { ok:true,
   * version }; 500 -> { ok:false, version:null, error }. Invalid body/kind ->
   * 400; same kind already running -> 409; refused identity -> 403.
   * No command, package, environment or path override is accepted over HTTP.
   */
  app.get("/api/setup/requirements", async (req, res) => {
    if ((req as Request & { projectScope?: string[] | null }).projectScope) return void res.status(403).json({ error: "requirements require an unscoped token" });
    try { res.json(await setupRequirements(run)); }
    catch (err) { res.status(500).json({ error: (err as Error).message }); }
  });
  app.post("/api/setup/install", async (req, res) => {
    if (!(req as Request & { isAdmin?: boolean }).isAdmin || (req as Request & { projectScope?: string[] | null }).projectScope) {
      return void res.status(403).json({ error: "admin only" });
    }
    if (!req.body || Object.keys(req.body).length !== 1 || typeof req.body.kind !== "string") return void res.status(400).json({ error: "expected { kind }" });
    try {
      const result = await installer.install(req.body.kind, event => ctx.broadcastProjects({ ...event }));
      res.status(result.ok ? 200 : 500).json(result);
    } catch (err) { res.status(err instanceof SetupInstallError ? err.status : 500).json({ error: (err as Error).message }); }
  });

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
        // a turn that failed "not signed in" outranks the CLI's own sign-in file (#274)
        for (const rt of ctx.runtimes.values()) {
          for (const s of rt.learnedSignOuts()) {
            const i = checks.findIndex((c) => c.name === s.kind);
            if (i >= 0 && checks[i]!.status !== "fail") checks[i] = { name: s.kind, status: "fail", detail: `a turn by ${s.agentId} failed: “${s.message}”${signInCommand(s.kind) ? ` — ${signInCommand(s.kind)}` : ""}` };
          }
        }
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
