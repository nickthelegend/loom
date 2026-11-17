import type { Express, Request } from "express";
import { dismissOnboarding, onboardingReport, type OnboardingOptions } from "../../core/onboarding.js";

/** GET -> OnboardingReport, with ordered steps and stable action keys defined
 * in core/onboarding.ts. Share is optional; demo progress never completes agent.
 * Available to owners/admins and unscoped devices. Guests and scoped tokens
 * cannot inspect progress across all projects. POST /dismiss and /restore
 * return { dismissed }; owner/admin only because this preference is machine-wide.
 */
export function registerOnboardingRoutes(app: Express, options: OnboardingOptions = {}): void {
  app.use("/api/onboarding", (req, res, next) => {
    if ((req as Request & { projectScope?: string[] | null }).projectScope) return void res.status(403).json({ error: "onboarding requires an unscoped token" });
    next();
  });
  app.get("/api/onboarding", async (_req, res) => {
    try { res.json(await onboardingReport(options)); }
    catch (err) { res.status(500).json({ error: (err as Error).message }); }
  });
  for (const action of ["dismiss", "restore"] as const) {
    app.post(`/api/onboarding/${action}`, (req, res) => {
      if (!(req as Request & { isAdmin?: boolean }).isAdmin) return void res.status(403).json({ error: "admin only" });
      try { res.json(dismissOnboarding(action === "dismiss")); }
      catch (err) { res.status(500).json({ error: (err as Error).message }); }
    });
  }
}
