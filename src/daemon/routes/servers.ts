import type { Express } from 'express';
import { frameability, isLoopbackHost } from "../../core/preview-proxy.js";
import { writeProjectConfig } from "../../core/registry.js";
import { suggestServers, urlFor } from "../../core/servers.js";
import { parseServerConfig } from '../system.js';
import type { WithRuntime } from './context.js';
/** Register servers routes in the order established by LoomDaemon.routes(). */
export function registerServersRoutes(app: Express, withRuntime: WithRuntime): void {

  /**
   * The project's dev servers: what's configured, and what each one is doing.
   *
   * "Running" means a port answered, not that a process exists — the
   * difference is the whole point of Loom knowing about them (core/servers.ts).
   */
  app.get(
    "/api/projects/:id/servers",
    withRuntime(async (rt, _req, res) => {
      res.json({ servers: rt.servers.list(), suggested: suggestServers(rt.info.dir) });
    }),
  );

  app.post(
    "/api/projects/:id/servers",
    withRuntime(async (rt, req, res) => {
      const b = (req.body ?? {}) as { servers?: unknown };
      if (!Array.isArray(b.servers)) return void res.status(400).json({ error: "servers must be a list" });
      try {
        const servers = b.servers.map(parseServerConfig);
        writeProjectConfig(rt.info.dir, { ...rt.config, servers });
        rt.config.servers = servers;
        res.json({ servers: rt.servers.list() });
      } catch (err) {
        res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
      }
    }),
  );

  for (const action of ["start", "stop", "restart"] as const) {
    app.post(
      `/api/projects/:id/servers/:name/${action}`,
      withRuntime(async (rt, req, res) => {
        try {
          const status = await rt.servers[action](String(req.params.name));
          res.json({ server: status });
        } catch (err) {
          res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
        }
      }),
    );
  }

  /**
   * Preview a server through Loom, so the page can report back.
   *
   * A dev server is a different origin, and one origin can't read another's
   * console. Loom stands in front of it instead (core/preview-proxy.ts) and
   * injects a script that posts what the page logs, fetches and throws. Each
   * server gets one proxy, started when first asked for.
   */
  app.post(
    "/api/projects/:id/servers/:name/preview",
    withRuntime(async (rt, req, res) => {
      try {
        const cfg = rt.servers.mustConfig(String(req.params.name));
        // configured, or else what the running server announced it's on
        const target = urlFor(cfg) ?? rt.servers.status(cfg).url ?? null;
        if (!target) return void res.status(400).json({ error: `server "${cfg.name}" has no port or url to preview` });
        const proxy = await rt.previewProxy(cfg.name, target);
        res.json({ url: `http://127.0.0.1:${proxy.port}`, target, bridged: true });
      } catch (err) {
        res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
      }
    }),
  );

  /**
   * Preview an address typed into the bar, through the same proxy.
   *
   * Only this machine: a typed localhost URL is a dev server Loom wasn't told
   * about, and it deserves the console and the picker as much as one it was.
   * Anywhere else is someone else's site, and Loom has no business standing in
   * the middle of it — those load as themselves (or refuse to be framed). One
   * proxy per origin, reused, so the frame's address stays put across reloads.
   */
  app.post(
    "/api/projects/:id/preview/proxy",
    withRuntime(async (rt, req, res) => {
      const raw = String((req.body as { url?: unknown } | undefined)?.url ?? "").trim();
      let u: URL;
      try {
        u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`);
      } catch {
        return void res.status(400).json({ error: "that isn't a url" });
      }
      if (u.protocol !== "http:" && u.protocol !== "https:") return void res.status(400).json({ error: "only http and https can be previewed" });
      if (!isLoopbackHost(u.hostname)) return void res.status(400).json({ error: "only addresses on this machine go through the preview proxy" });
      try {
        const proxy = await rt.previewProxy(`url:${u.origin}`, u.origin);
        res.json({ url: `http://127.0.0.1:${proxy.port}`, target: u.origin, bridged: true });
      } catch (err) {
        res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
      }
    }),
  );

  /**
   * Will this page let itself be shown in a frame? Asked for an address that
   * isn't on this machine (those go through the proxy, which lets them): the
   * frame itself can't tell Loom it was refused, so Loom looks at the same
   * headers the browser will and says so plainly instead of a blank pane.
   */
  app.post(
    "/api/projects/:id/preview/frameable",
    withRuntime(async (_rt, req, res) => {
      const raw = String((req.body as { url?: unknown } | undefined)?.url ?? "").trim();
      let u: URL;
      try {
        u = new URL(raw);
      } catch {
        return void res.status(400).json({ error: "that isn't a url" });
      }
      if (u.protocol !== "http:" && u.protocol !== "https:") return void res.status(400).json({ error: "only http and https" });
      try {
        const r = await fetch(u, { redirect: "follow", signal: AbortSignal.timeout(6_000), headers: { accept: "text/html,*/*" } });
        const verdict = frameability(r.headers.get("x-frame-options"), r.headers.get("content-security-policy"));
        void r.body?.cancel().catch(() => {});
        res.json({ ...verdict, status: r.status });
      } catch (err) {
        // unreachable from here isn't "refuses framing" — say we don't know
        res.json({ frameable: null, reason: err instanceof Error ? err.message : String(err) });
      }
    }),
  );

  /** A server's recent output — the log pane, and what an agent reads. */
  app.get(
    "/api/projects/:id/servers/:name/log",
    withRuntime(async (rt, req, res) => {
      try {
        rt.servers.mustConfig(String(req.params.name));
        const limit = req.query.limit ? Math.max(1, Number(req.query.limit)) : 200;
        res.json({ lines: rt.servers.log(String(req.params.name), limit) });
      } catch (err) {
        res.status(404).json({ error: err instanceof Error ? err.message : String(err) });
      }
    }),
  );
}
