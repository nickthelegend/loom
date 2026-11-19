import type { Express } from 'express';
import { type Request } from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { logbook } from "../../core/logbook.js";
import { CHECK_TTL_MS, releaseChangelog, detectInstall, newerThan, plan, refuseDirtyCheckout } from "../../core/updater.js";
import { VERSION } from "../../version.js";
import { defaultExec } from "../landing.js";
import { BUILD_REV, loomRoot } from '../system.js';
import type { RouteContext } from './context.js';
/** Register updates routes in the order established by LoomDaemon.routes(). */
export function registerUpdatesRoutes(app: Express, ctx: Pick<RouteContext, "cachedRelease" | "updating" | "close">): void {

  let changelogCache: { tag: string; at: number; value: ReturnType<typeof releaseChangelog> } | undefined;

  app.get("/api/updates", (req, res) => {
    void (async () => {
      const root = loomRoot();
      let git = null;
      if (root) {
        const { remoteBehind } = await import("../../core/git.js");
        git = await remoteBehind(root).catch(() => null);
      }
      const release = await ctx.cachedRelease(req.query.refresh !== undefined);
      if (release && (!changelogCache || changelogCache.tag !== release.tag || Date.now() - changelogCache.at > CHECK_TTL_MS || req.query.refresh !== undefined)) {
        changelogCache = { tag: release.tag, at: Date.now(), value: releaseChangelog(VERSION, release) };
      }
      const changelog = release ? await changelogCache!.value : { entries: [], available: false };
      const install = detectInstall(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
      const p = plan(install);
      res.json({
        version: VERSION,
        changelog,
        rev: BUILD_REV,
        root,
        git,
        // The release half: what's published, and whether this copy can fetch it.
        latest: release?.version ?? null,
        release,
        behindRelease: release ? newerThan(release.version, VERSION) : false,
        install: p.install,
        canApply: p.refusal === null,
        refusal: p.refusal,
        steps: p.steps.map((x) => [x.cmd, ...x.args].join(" ")),
      });
    })();
  });

  /**
   * Bring this copy up to date, in the words the plan showed.
   *
   * The update runs as a sequence of real commands whose output goes to the
   * logbook (and so to every open client, live). When it finishes, the daemon
   * exits: whatever started it — the CLI's ensureDaemon, the desktop shell,
   * a service manager — brings it back on the new build, which is also how a
   * stale build is replaced today.
   */
  app.post("/api/updates/apply", (req, res) => {
    // Updating replaces the code this machine runs: the local admin only,
    // never a paired phone.
    if (!(req as Request & { isAdmin?: boolean }).isAdmin) {
      return void res.status(403).json({ error: "admin only" });
    }
    void (async () => {
      if (ctx.updating) return void res.status(409).json({ error: "an update is already running" });
      const install = detectInstall(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
      const p = plan(install);
      if (p.refusal) return void res.status(400).json({ error: p.refusal });
      if (p.install === "git" && p.cwd) {
        const dirty = await defaultExec("git", ["status", "--porcelain"], p.cwd);
        const refusal = refuseDirtyCheckout(dirty.out);
        if (refusal) return void res.status(400).json({ error: refusal });
      }
      ctx.updating = true;
      res.json({ started: true, steps: p.steps.map((x) => [x.cmd, ...x.args].join(" ")) });
      const ran: string[] = [];
      for (const step of p.steps) {
        const line = [step.cmd, ...step.args].join(" ");
        logbook.info("update", `running ${line}`);
        const r = await defaultExec(step.cmd, step.args, p.cwd ?? process.cwd(), { timeoutMs: 15 * 60_000 });
        ran.push(line);
        if (r.code !== 0) {
          ctx.updating = false;
          logbook.error("update", `${line} failed (exit ${r.code})`, (r.err || r.out).slice(-4000));
          return;
        }
        if (r.out.trim()) logbook.info("update", `${step.cmd} finished`, r.out.trim().slice(-2000));
      }
      logbook.info("update", `updated via ${ran.join(" && ")} — restarting on the new build`);
      // Let the answer and the log frames reach the clients before we go.
      setTimeout(() => {
        // bounded: the new build is installed, and nothing still open may keep the old one running
        const deadline = new Promise<void>((r) => setTimeout(r, 15_000).unref());
        void Promise.race([ctx.close(), deadline]).finally(() => process.exit(0));
      }, 750);
    })();
  });
}
