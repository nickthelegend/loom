import type { Express } from 'express';
import { loadPolicy } from "../../core/team-policy.js";
import { repoOf } from "../team.js";
import type { RouteContext, WithRuntime } from './context.js';
/** Register project-team routes in the order established by LoomDaemon.routes(). */
export function registerProjectTeamRoutes(app: Express, ctx: Pick<RouteContext, "team">, withRuntime: WithRuntime): void {

  // ---- team policy in effect for a project (D37) ----
  app.get(
    "/api/projects/:id/team/policy",
    withRuntime(async (rt, _req, res) => {
      res.json({ policy: await loadPolicy(rt.info.dir) });
    }),
  );

  // ---- team sharing, per project (D8: opt-in) ----
  // What this project has chosen (config `team`) and which GitHub repo its
  // origin is — the two facts the UI needs to show Shared / Private / Auto.
  app.get(
    "/api/projects/:id/team/share",
    withRuntime(async (rt, _req, res) => {
      // cfg is omitted when nothing was chosen — "auto", not "private".
      res.json({ ...(rt.config.team ? { cfg: rt.config.team } : {}), repo: (await repoOf(rt.info.dir)) ?? "" });
    }),
  );

  app.post(
    "/api/projects/:id/team/share",
    withRuntime(async (rt, req, res) => {
      try {
        const b = (req.body ?? {}) as { teamId?: string };
        res.json(await ctx.team.share(rt, b.teamId || undefined));
      } catch (err) {
        res.status(400).json({ error: (err as Error).message });
      }
    }),
  );

  app.delete(
    "/api/projects/:id/team/share",
    withRuntime(async (rt, _req, res) => {
      ctx.team.unshare(rt);
      res.json({ ok: true });
    }),
  );

  // ---- the team brain, per project (Phase 3, daemon/team-brain.ts) ----
  // The Team view (D49): canon, the team's memories with their tiers, and the
  // inbox of what needs a human.
  app.get(
    "/api/projects/:id/team/brain",
    withRuntime(async (rt, req, res) => {
      const tb = ctx.team.brainFor(rt);
      if (req.query.sync === "1") await tb.sync().catch(() => { });
      res.json({
        status: tb.status(),
        memories: tb.memories({ history: req.query.history === "1" }),
        inbox: tb.inbox(),
      });
    }),
  );

  app.post(
    "/api/projects/:id/team/brain/:action",
    withRuntime(async (rt, req, res) => {
      const tb = ctx.team.brainFor(rt);
      const b = (req.body ?? {}) as Record<string, unknown>;
      const str = (k: string) => {
        const v = String(b[k] ?? "").trim();
        if (!v) throw new Error(`missing ${k}`);
        return v;
      };
      try {
        let out: unknown = { ok: true };
        const action = String(req.params.action);
        if (action === "sync") await tb.sync();
        else if (action === "promote") {
          const ids = Array.isArray(b.ids) ? b.ids.map(String) : [str("id")];
          out = await tb.promote(ids);
        } else if (action === "correct") out = await tb.correct(str("id"), str("text"));
        else if (action === "resolve") await tb.resolve(str("winner"), str("loser"), String(b.reason ?? ""));
        else if (action === "merge") await tb.resolve(str("keep"), str("drop"), "duplicate");
        else if (action === "trust" || action === "private") {
          const id = str("id");
          const value = b.value === undefined ? true : Boolean(b.value);
          rt.brain.update(id, action === "trust" ? { untrusted: !value } : { private: value }, "user");
          await tb.sync();
        } else return void res.status(404).json({ error: `unknown team brain action "${action}"` });
        res.json({ result: out, status: tb.status(), memories: tb.memories(), inbox: tb.inbox() });
      } catch (err) {
        res.status(400).json({ error: (err as Error).message });
      }
    }),
  );

  // ---- landing, per project (Phase 4, daemon/landing.ts) ----
  // Goal PRs on their way to main — checks, fixes, review, Land — plus
  // teammates' goals waiting for someone to adopt them (D52–D63).
  app.get(
    "/api/projects/:id/team/landing",
    withRuntime(async (rt, req, res) => {
      const l = ctx.team.landingFor(rt);
      if (req.query.poll === "1") await l.tick().catch(() => { });
      res.json({ goals: l.status(), adoptable: await l.adoptable().catch(() => []) });
    }),
  );

  app.post(
    "/api/projects/:id/team/landing/:action",
    withRuntime(async (rt, req, res) => {
      const l = ctx.team.landingFor(rt);
      const b = (req.body ?? {}) as Record<string, unknown>;
      const runId = String(b.runId ?? "");
      try {
        let out: unknown = { ok: true };
        const action = String(req.params.action);
        if (action === "land") {
          // a goal that moved to a runner is landed there (Phase 5)
          out = rt.orchestra.get(runId)?.status === "moved" ? await ctx.team.landOnRunner(rt, runId) : await l.land(runId);
        }
        else if (action === "poll") await l.tick();
        else if (action === "review") {
          const run = rt.orchestra.get(runId);
          if (!run?.landing?.headSha) throw new Error("that goal has no PR commit to review yet");
          await l.review(run, run.landing.headSha);
          out = run.landing;
        } else if (action === "override") out = await l.overrideReview(runId, String(b.reason ?? ""));
        else if (action === "adopt") out = await l.adopt(Number(b.pr), {
          ...(b.orchestrator ? { orchestrator: String(b.orchestrator) } : {}),
          ...(Array.isArray(b.workers) ? { workers: b.workers.map(String) } : {}),
        });
        else return void res.status(404).json({ error: `unknown landing action "${action}"` });
        res.json({ result: out, goals: l.status() });
      } catch (err) {
        res.status(400).json({ error: (err as Error).message });
      }
    }),
  );

  // ---- deploys and release notes (Phase 5, daemon/deploys.ts) — read-only ----
  app.get(
    "/api/projects/:id/team/deploys",
    withRuntime(async (rt, _req, res) => {
      try {
        res.json({ deployments: await ctx.team.deploysFor(rt).list() });
      } catch (err) {
        res.status(400).json({ error: (err as Error).message });
      }
    }),
  );

  app.get(
    "/api/projects/:id/team/release-notes",
    withRuntime(async (rt, req, res) => {
      try {
        const since = String(req.query.since ?? "").trim();
        if (!since) throw new Error("since which tag or commit? ?since=v1.2.0");
        res.json({ markdown: await ctx.team.deploysFor(rt).releaseNotes(since) });
      } catch (err) {
        res.status(400).json({ error: (err as Error).message });
      }
    }),
  );

  // ---- runners (Phase 5, daemon/runner.ts) ----
  // A project's view: runners that can take its goals, and the jobs in flight.
  app.get(
    "/api/projects/:id/team/runners",
    withRuntime(async (rt, _req, res) => {
      try {
        res.json(await ctx.team.runnersView(rt));
      } catch (err) {
        res.status(400).json({ error: (err as Error).message });
      }
    }),
  );

  // Team auto-orchestration: is it ready here, and one step to take part (loom team auto [on])
  app.get(
    "/api/projects/:id/team/auto",
    withRuntime(async (rt, _req, res) => {
      try { res.json(await ctx.team.teamAutoStatus(rt)); } catch (err) { res.status(400).json({ error: (err as Error).message }); }
    }),
  );
  app.post(
    "/api/projects/:id/team/auto",
    withRuntime(async (rt, _req, res) => {
      try { res.json(await ctx.team.teamAutoOn(rt)); } catch (err) { res.status(400).json({ error: (err as Error).message }); }
    }),
  );

  app.post(
    "/api/projects/:id/team/runners/:action",
    withRuntime(async (rt, req, res) => {
      const b = (req.body ?? {}) as Record<string, unknown>;
      const str = (k: string) => (b[k] === undefined || b[k] === null || b[k] === "" ? undefined : String(b[k]));
      try {
        const action = String(req.params.action);
        let out: unknown;
        if (action === "start") {
          out = await ctx.team.startOnRunner(rt, {
            goal: String(b.goal ?? ""),
            ...(str("orchestrator") ? { orchestrator: str("orchestrator")! } : {}),
            ...(Array.isArray(b.workers) ? { workers: b.workers.map(String) } : {}),
            ...(b.plan ? { plan: true } : {}),
            ...(str("runner") ? { runner: str("runner")! } : {}),
          });
        } else if (action === "continue") out = await ctx.team.continueOnRunner(rt, String(b.runId ?? ""), { ...(str("runner") ? { runner: str("runner")! } : {}) });
        else if (action === "bring-back") out = await ctx.team.bringBack(rt, String(b.runId ?? ""));
        else if (action === "land") out = await ctx.team.landOnRunner(rt, String(b.runId ?? ""));
        else return void res.status(404).json({ error: `unknown runner action "${action}"` });
        res.json({ result: out, ...(await ctx.team.runnersView(rt)) });
      } catch (err) {
        res.status(400).json({ error: (err as Error).message });
      }
    }),
  );

  // Repo setup for landing safely (D62): report, and a fix PR on request.
  app.get(
    "/api/projects/:id/team/doctor",
    withRuntime(async (rt, _req, res) => {
      try {
        res.json(await ctx.team.landingFor(rt).doctor());
      } catch (err) {
        res.status(400).json({ error: (err as Error).message });
      }
    }),
  );

  app.post(
    "/api/projects/:id/team/doctor/fix",
    withRuntime(async (rt, _req, res) => {
      try {
        res.json(await ctx.team.landingFor(rt).doctorFix());
      } catch (err) {
        res.status(400).json({ error: (err as Error).message });
      }
    }),
  );
}
