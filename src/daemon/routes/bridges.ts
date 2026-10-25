import type { Express, Request } from "express";
import { maskToken, readBridges, writeBridges, type BridgeConfig, type ChatBridges, type Platform } from "../chat-bridge.js";

const isAdmin = (req: Request) => Boolean((req as Request & { isAdmin?: boolean }).isAdmin);
const ids = (v: unknown): string[] => (Array.isArray(v) ? v : typeof v === "string" ? v.split(",") : []).map((x) => String(x).trim()).filter(Boolean);

/** Slack / Discord bridges (daemon/chat-bridge.ts). Owner-only: they hold bot tokens and run your agents. */
export function registerBridgeRoutes(app: Express, bridges: ChatBridges): void {
  app.get("/api/bridges", (req, res) => {
    if (!isAdmin(req)) return void res.status(403).json({ error: "only this machine's owner can see the bridges" });
    const b = readBridges();
    const view = (p: Platform) => {
      const c = b[p];
      return c ? { enabled: c.enabled, botToken: maskToken(c.botToken), ...(c.appToken ? { appToken: maskToken(c.appToken) } : {}), users: c.users, channels: c.channels,
        ...(c.project ? { project: c.project } : {}), ...(c.agent ? { agent: c.agent } : {}), status: bridges.status[p] ?? null } : null;
    };
    res.json({ slack: view("slack"), discord: view("discord") });
  });

  app.put("/api/bridges/:platform", (req, res) => {
    void (async () => {
      if (!isAdmin(req)) return void res.status(403).json({ error: "only this machine's owner can set up a bridge" });
      const p = req.params.platform as Platform;
      if (p !== "slack" && p !== "discord") return void res.status(404).json({ error: "slack or discord" });
      const body = (req.body ?? {}) as Record<string, unknown>;
      const all = readBridges();
      const cur: Partial<BridgeConfig> = all[p] ?? {};
      const next: BridgeConfig = {
        enabled: body.enabled === undefined ? true : Boolean(body.enabled),
        botToken: typeof body.botToken === "string" && body.botToken ? body.botToken.trim() : cur.botToken ?? "",
        ...(p === "slack" ? { appToken: typeof body.appToken === "string" && body.appToken ? body.appToken.trim() : cur.appToken } : {}),
        users: body.users !== undefined ? ids(body.users) : cur.users ?? [],
        channels: body.channels !== undefined ? ids(body.channels) : cur.channels ?? [],
        ...(body.project !== undefined ? (body.project ? { project: String(body.project) } : {}) : cur.project ? { project: cur.project } : {}),
        ...(body.agent !== undefined ? (body.agent ? { agent: String(body.agent) } : {}) : cur.agent ? { agent: cur.agent } : {}),
      };
      if (next.enabled) {
        if (!next.botToken) return void res.status(400).json({ error: `${p} needs a bot token` });
        if (p === "slack" && !next.appToken) return void res.status(400).json({ error: "Slack needs an app-level token (xapp-…) for Socket Mode" });
        if (!next.users.length) return void res.status(400).json({ error: "say who the bot listens to (user ids) — it hears nobody otherwise" });
      }
      all[p] = next;
      writeBridges(all);
      try { await bridges.restart(p); }
      catch (e) { return void res.status(502).json({ error: `saved, but ${p} didn't connect: ${(e as Error).message}` }); }
      res.json({ ok: true, status: bridges.status[p] ?? null });
    })();
  });

  app.delete("/api/bridges/:platform", (req, res) => {
    void (async () => {
      if (!isAdmin(req)) return void res.status(403).json({ error: "only this machine's owner can remove a bridge" });
      const p = req.params.platform as Platform;
      const all = readBridges();
      if (!all[p]) return void res.status(404).json({ error: `no ${p} bridge` });
      delete all[p];
      writeBridges(all);
      await bridges.restart(p).catch(() => {});
      res.json({ removed: true });
    })();
  });
}
