import type { Express, Request } from 'express';
import QRCode from "qrcode";
import { inviteTeammate, type Onboarding } from "../onboard.js";
import type { RouteContext, WithRuntime } from './context.js';
/**
 * One-link onboarding (daemon/onboard.ts). Admin only: inviting mints a team
 * key's carrier, and joining signs this machine in and clones onto it.
 * Links travel in bodies, never in a URL — they carry the team key.
 */
export function registerOnboardRoutes(app: Express, ctx: Pick<RouteContext, "team"> & { onboarding: Onboarding; gh?: (args: string[]) => Promise<string> }, withRuntime: WithRuntime): void {
  const admin = (req: Request) => Boolean((req as Request & { isAdmin?: boolean }).isAdmin);

  app.post(
    "/api/projects/:id/team/invite",
    withRuntime(async (rt, req, res) => {
      if (!admin(req)) return void res.status(403).json({ error: "admin only" });
      const b = (req.body ?? {}) as { teamId?: string; grant?: boolean };
      try {
        const out = await inviteTeammate(ctx.team, rt, {
          ...(b.teamId ? { teamId: String(b.teamId) } : {}),
          ...(typeof b.grant === "boolean" ? { grant: b.grant } : {}),
          ...(ctx.gh ? { gh: ctx.gh } : {}),
        });
        // the link is long (it carries the key): low error correction keeps the QR scannable
        const qrSvg = await QRCode.toString(out.link, { type: "svg", margin: 1, errorCorrectionLevel: "L" }).catch(() => undefined);
        res.json({ ...out, ...(qrSvg ? { qrSvg } : {}) });
      } catch (err) {
        res.status(400).json({ error: (err as Error).message, ...((err as { code?: string }).code ? { code: (err as { code?: string }).code } : {}) });
      }
    }),
  );

  app.post("/api/onboard/preview", (req, res) => {
    if (!admin(req)) return void res.status(403).json({ error: "admin only" });
    void (async () => {
      try {
        res.json(await ctx.onboarding.preview(String(req.body?.link ?? "")));
      } catch (err) {
        res.status(400).json({ error: (err as Error).message });
      }
    })();
  });

  app.post("/api/onboard", (req, res) => {
    if (!admin(req)) return void res.status(403).json({ error: "admin only" });
    const b = (req.body ?? {}) as Record<string, unknown>;
    try {
      const job = ctx.onboarding.start(String(b.link ?? ""), {
        ...(b.dir ? { dir: String(b.dir) } : {}),
        ...(b.into ? { into: String(b.into) } : {}),
        ...(b.github ? { github: String(b.github) } : {}),
        ...(b.secret ? { secret: String(b.secret) } : {}),
        ...(b.token ? { token: String(b.token) } : {}),
      });
      res.json({ job });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.get("/api/onboard/:job", (req, res) => {
    if (!admin(req)) return void res.status(403).json({ error: "admin only" });
    const job = ctx.onboarding.get(String(req.params.job));
    if (!job) return void res.status(404).json({ error: "no such join" });
    res.json({ job });
  });
}
