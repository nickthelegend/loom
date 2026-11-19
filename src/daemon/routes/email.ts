import type { Express, Request, Response } from "express";
import { publicEmail, saveEmail, type EmailDigest } from "../email-digest.js";

export function registerEmailRoutes(app: Express, email: EmailDigest): void {
  const owner = (req: Request, res: Response) => {
    const r = req as Request & { guest?: unknown; projectScope?: string[] | null };
    if (!r.guest && !r.projectScope) return true;
    res.status(403).json({ error: "Email settings require the owner or an unscoped paired device" }); return false;
  };
  app.get("/api/integrations/email", (req, res) => { if (owner(req, res)) res.json(publicEmail()); });
  app.put("/api/integrations/email", (req, res) => {
    if (!owner(req, res)) return;
    try { saveEmail(req.body ?? {}); res.json(publicEmail()); }
    catch (e) { res.status(400).json({ error: (e as Error).message }); }
  });
  app.get("/api/integrations/email/preview", (req, res) => {
    if (!owner(req, res)) return;
    void email.preview().then(text => res.json({ text })).catch(() => res.status(500).json({ error: "Could not build digest" }));
  });
  app.post("/api/integrations/email/send", (req, res) => {
    if (!owner(req, res)) return;
    void email.tick(true).then(() => res.json({ sent: true })).catch(() => res.status(502).json({ error: "Digest not sent; check SMTP settings and server availability" }));
  });
}
