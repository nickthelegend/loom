import { openShare } from "../../core/shares.js";
import { threadReplay } from "../../core/replay.js";
import type { Express } from 'express';
import { VERSION } from "../../version.js";
import { BUILD_REV, isLoopback, isLoopbackHost } from '../system.js';
import type { RouteContext } from './context.js';
/** Register public routes in the order established by LoomDaemon.routes(). */
export function registerPublicRoutes(app: Express, ctx: Pick<RouteContext, "terminals" | "auth"> & Partial<Pick<RouteContext, "runtime">>): void {

  // A read-only thread link (#199): the token is the only credential, so it's checked against
  // the stored hash, expires, and opens one chat's replay page — nothing else on this daemon.
  app.get("/share/:token", async (req, res) => {
    res.setHeader("cache-control", "no-store");
    res.setHeader("x-robots-tag", "noindex, nofollow");
    const share = openShare(String(req.params.token ?? ""));
    if (!share || !ctx.runtime) return void res.status(404).type("text/plain").send("This link has expired or was revoked.");
    try {
      const rt = await ctx.runtime(share.projectId);
      const events = rt.log.list({ chat: share.chat, limit: 20_000 });
      res.setHeader("content-type", "text/html; charset=utf-8");
      res.setHeader("content-security-policy", "default-src 'none'; style-src 'unsafe-inline'; img-src data:");
      res.send(threadReplay(events, { project: rt.info.name, chat: share.title }));
    } catch {
      res.status(404).type("text/plain").send("This thread isn't available any more.");
    }
  });

  app.get("/api/health", (_req, res) => {
    res.json({
      ok: true,
      name: "loom",
      version: VERSION,
      rev: BUILD_REV,
      terminal: ctx.terminals.mode,
      // a transcriber is configured: the mic records and the daemon transcribes
      stt: !!process.env.LOOM_STT_CMD,
    });
  });

  /** Wrong pairing codes per address, for throttling guesses at /api/pair/claim. */
  const claimTries = new Map<string, { fails: number; until: number }>();
  app.post("/api/pair/claim", (req, res) => {
    const { token, name } = (req.body ?? {}) as { token?: string; name?: string };
    if (!token) return void res.status(400).json({ error: "missing token" });
    // A pairing token is the only credential this route takes, so guessing
    // is throttled: ten wrong ones from one address and it waits.
    const who = String(req.headers["x-loom-via"] ? "relay" : req.socket.remoteAddress ?? "?");
    const now = Date.now();
    const tries = claimTries.get(who);
    if (tries && tries.until > now && tries.fails >= 10) {
      const mins = Math.ceil((tries.until - now) / 60_000);
      res.setHeader("Retry-After", String(Math.ceil((tries.until - now) / 1000)));
      return void res.status(429).json({ error: `too many wrong pairing codes from here — try again in ${mins} minute${mins === 1 ? "" : "s"}` });
    }
    const claimed = ctx.auth.claim(token, name ?? "device");
    if (!claimed) {
      const t = tries && tries.until > now ? tries : { fails: 0, until: now + 10 * 60_000 };
      t.fails++;
      claimTries.set(who, t);
      if (claimTries.size > 1000) claimTries.clear(); // bounded, whatever happens
      return void res.status(403).json({ error: "invalid or expired pairing token" });
    }
    claimTries.delete(who);
    res.json(claimed);
  });

  /**
   * The local admin console bootstraps here — before the bearer wall, gated by
   * the socket being loopback. A same-machine caller gets the admin token (it
   * lives in a config file they can already read), which is what lets the web
   * app served on localhost mint pairing codes and open phone access. Everyone
   * else — a phone on the tailnet, anything past localhost — is turned away and
   * pairs like any other device. Admin-ness stays a property of the *token*,
   * so a paired client is never an admin no matter where it connects from.
   */
  app.get("/api/bootstrap", (req, res) => {
    // Both must hold: the TCP peer is loopback (can't be spoofed by a header),
    // AND the Host is a loopback literal (defeats DNS rebinding, where the
    // socket is loopback but the browser sends the attacker's hostname).
    // A relayed request arrives from loopback too — it must never be local.
    if (req.headers["x-loom-via"] || !isLoopback(req.socket.remoteAddress) || !isLoopbackHost(req.headers.host)) {
      return void res.status(403).json({ error: "not a local request" });
    }
    res.json({ token: ctx.auth.adminToken(), admin: true });
  });
}
