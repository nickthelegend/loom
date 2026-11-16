import type { Express, Request } from "express";
import { accountLogin, addAccount, configDirEnv, listAccounts, removeAccount } from "../../core/accounts.js";
import { probeAuth } from "../../core/setup.js";

/** Machine-wide, owner/unscoped only. No endpoint reads or returns credentials.
 * GET /api/accounts -> { accounts: [{ id, kind, label, configDir, authed }] }.
 * authed is true/false/null from the CLI's status command, never inferred from files.
 * POST { kind, label, configDir? } -> { account }; omitted paths use LOOM_HOME/accounts/<id>.
 * DELETE /:id -> { forgotten: true }; removes only registry metadata, or 404.
 * POST /:id/login -> { command, bin, args, env }; display command is POSIX shell
 * (PowerShell on Windows). Only a local terminal should execute bin/args/env.
 */
export function registerAccountsRoutes(app: Express): void {
  app.use("/api/accounts", (req, res, next) => {
    if ((req as Request & { projectScope?: string[] | null }).projectScope) {
      return void res.status(403).json({ error: "accounts require an owner or unscoped token" });
    }
    next();
  });
  app.get("/api/accounts", async (_req, res) => {
    try {
      const accounts = await Promise.all(listAccounts().map(async account => ({
        ...account, authed: (await probeAuth(account.kind, configDirEnv(account.kind, account.configDir))).authed,
      })));
      res.json({ accounts });
    } catch (err) { res.status(500).json({ error: (err as Error).message }); }
  });
  app.post("/api/accounts", (req, res) => {
    try { res.json({ account: addAccount(req.body ?? {}) }); }
    catch (err) { res.status(400).json({ error: (err as Error).message }); }
  });
  app.delete("/api/accounts/:id", (req, res) => {
    if (!removeAccount(String(req.params.id))) return void res.status(404).json({ error: "unknown account" });
    res.json({ forgotten: true });
  });
  app.post("/api/accounts/:id/login", (req, res) => {
    const account = listAccounts().find(a => a.id === String(req.params.id));
    if (!account) return void res.status(404).json({ error: "unknown account" });
    res.json(accountLogin(account));
  });
}
