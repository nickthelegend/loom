import type { Express } from 'express';
import { type Request } from "express";
import QRCode from "qrcode";
import { logbook } from "../../core/logbook.js";
import { findProject } from "../../core/registry.js";
import { lanIp, tailscaleIp, tailscaleState, tailscaleUp } from '../system.js';
import type { RouteContext } from './context.js';
/** Register pairing routes in the order established by LoomDaemon.routes(). */
export function registerPairingRoutes(app: Express, ctx: Pick<RouteContext, "exposedIps" | "host" | "port" | "expose" | "auth" | "cloudLinkParams">): void {

  /**
   * The two networks a phone could use to reach this daemon — the LAN and the
   * tailnet — with, for each, the address and whether the phone can actually
   * get here on it *right now*. It can't when we're bound to localhost, which
   * is the default; `reachable:false` is the modal's cue to offer "enable
   * phone access" (expose) before showing a QR that wouldn't resolve.
   */
  app.get("/api/pair/networks", (req, res) => {
    if (!(req as Request & { isAdmin?: boolean }).isAdmin) {
      return void res.status(403).json({ error: "admin only" });
    }
    void (async () => {
      const exposed = ctx.exposedIps();
      const reach = (ip: string | null) =>
        Boolean(ip) && (ctx.host === "0.0.0.0" || ctx.host === ip || exposed.includes(ip!));
      const lan = lanIp();
      const tstate = await tailscaleState();
      const ts = tstate.loggedIn ? tstate.ip : null;
      res.json({
        port: ctx.port,
        boundHost: ctx.host,
        exposed,
        localnet: { ip: lan, reachable: reach(lan) },
        tailnet: ts
          ? { ip: ts, available: true, reachable: reach(ts), installed: true }
          : {
            ip: null,
            available: false,
            reachable: false,
            installed: false,
            signedOut: tstate.installed,
            reason: tstate.installed
              ? "Tailscale is installed but signed out."
              : "Tailscale isn't installed on this machine.",
          },
      });
    })();
  });

  /**
   * Tailscale, from inside the app. `status` powers the connect-a-phone modal's
   * "Start Tailscale" affordance; `up` runs `tailscale up` and hands back the
   * one-time sign-in URL so the user finishes in a browser tab — no terminal.
   */
  app.get("/api/tailscale/status", (req, res) => {
    if (!(req as Request & { isAdmin?: boolean }).isAdmin) {
      return void res.status(403).json({ error: "admin only" });
    }
    void tailscaleState().then((s) => res.json(s));
  });

  app.post("/api/tailscale/up", (req, res) => {
    if (!(req as Request & { isAdmin?: boolean }).isAdmin) {
      return void res.status(403).json({ error: "admin only" });
    }
    void tailscaleUp().then(
      (r) => res.json(r),
      (err) => {
        logbook.error("tailscale", "could not bring Tailscale up", err);
        res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
      },
    );
  });

  /**
   * Make a phone-reachable address go live — a phone can't reach a
   * localhost-only daemon. We add a second listener on the requested LAN or
   * tailnet IP (never touching localhost), so this is safe to await and report
   * on directly. Explicit and user-driven (you clicked "connect a phone"), and
   * behind the token wall the whole time.
   */
  app.post("/api/pair/expose", (req, res) => {
    if (!(req as Request & { isAdmin?: boolean }).isAdmin) {
      return void res.status(403).json({ error: "admin only" });
    }
    void (async () => {
      const wanted = typeof req.body?.host === "string" ? (req.body.host as string).trim() : "";
      let ts: string | null = null;
      try {
        ts = await tailscaleIp();
      } catch {
        ts = null;
      }
      // Only ever bind an address that is genuinely ours (LAN or tailnet).
      const allowed = new Set([lanIp(), ts].filter(Boolean) as string[]);
      if (!wanted || !allowed.has(wanted)) {
        return void res.status(400).json({ error: "not a local or tailnet address of this machine" });
      }
      try {
        await ctx.expose(wanted);
        res.json({ ok: true, ip: wanted, port: ctx.port, exposed: ctx.exposedIps() });
      } catch (err) {
        logbook.error("daemon", `could not open phone access on ${wanted}`, err);
        res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
      }
    })();
  });

  app.post("/api/pair/new", (req, res) => {
    if (!(req as Request & { isAdmin?: boolean }).isAdmin) {
      return void res.status(403).json({ error: "admin only" });
    }
    void (async () => {
      // The QR must point at the address the phone will actually use, so the
      // caller may ask for the LAN or tailnet host — but only those. An
      // arbitrary host from the client never reaches the link.
      const wanted = typeof req.body?.host === "string" ? (req.body.host as string).trim() : "";
      let ts: string | null = null;
      try {
        ts = await tailscaleIp();
      } catch {
        ts = null;
      }
      const allowed = new Set([ctx.host, lanIp(), ts].filter(Boolean) as string[]);
      const host = wanted && allowed.has(wanted) ? wanted : ctx.host;
      const scopeIds = Array.isArray(req.body?.projects)
        ? (req.body.projects as unknown[]).map(String).filter(Boolean)
        : [];
      // Scope is resolved to ids at mint: a name that matches nothing is a
      // typo the admin should hear about now, not a permanently useless token.
      const resolvedScope: string[] = [];
      for (const p of scopeIds) {
        const info = findProject(p);
        if (!info) {
          return void res.status(400).json({ error: `unknown project "${p}" in scope` });
        }
        resolvedScope.push(info.id);
      }
      // an owner session (Loom Desktop's window) is minted only with the admin token itself
      const bearer = String(req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
      const owner = req.body?.owner === true && ctx.auth.isRootAdmin(bearer);
      if (req.body?.owner === true && !owner) return void res.status(403).json({ error: "an owner session needs the admin token" });
      const { token, expiresAt } = ctx.auth.newPairingToken(
        resolvedScope.length ? resolvedScope : undefined,
        { owner },
      );
      const url = `http://${host}:${ctx.port}`;
      // Deep link: scanning it with any camera opens the app, which claims the
      // single-use token from the URL fragment and pairs itself.
      // With Loom Cloud on, the fragment also carries the relay channel + key
      // and the Supabase project, so the phone can reach this daemon from any
      // network. Fragment only: none of it is ever sent to a server.
      const cloud = ctx.cloudLinkParams();
      const link = `${url}/app#pair=${token}${cloud}`;
      let qrSvg: string | undefined;
      try {
        qrSvg = await QRCode.toString(link, {
          type: "svg",
          margin: 1,
          errorCorrectionLevel: "M",
        });
      } catch (err) {
        // The link still works even if the QR doesn't render — degrade, don't fail.
        logbook.warn("pair", "QR render failed — the copy link still works", err);
      }
      res.json({ token, expiresAt, url, link, ...(qrSvg ? { qrSvg } : {}) });
    })();
  });
}
