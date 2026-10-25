import type { Express } from 'express';
import { timingSafeEqual } from "node:crypto";
import { listProjects } from "../../core/registry.js";
import { isLoopbackHost } from '../system.js';
import type { RouteContext } from './context.js';
/** Register alerts routes in the order established by LoomDaemon.routes(). */
export function registerAlertsRoutes(app: Express, ctx: Pick<RouteContext, "host" | "runtime" | "startHealLoop">): void {

  /**
   * Self-healing loop: an alert posts here.
   *   firing   → quarantine the failing agent and fail the baton over to a
   *              fallback (Loom keeps working while the agent is degraded).
   *   resolved → lift the quarantine and hand the baton BACK to the original
   *              agent — a real pause-then-retry, not a one-way failover.
   * Closing the loop from metric breach → intervention → recovery → retry.
   *
   * The body is an Alertmanager-style payload, which is what every backend
   * Loom is pointed at already sends — SigNoz, Prometheus/Alertmanager and
   * Grafana all POST the same `{status, alerts: [{status, labels}]}` shape.
   * So the route is named for the payload it accepts rather than for one
   * vendor, and a single webhook channel configured anywhere reaches it.
   */
  app.post("/api/webhooks/alerts", (req, res) => {
    void (async () => {
      const secret = process.env.LOOM_WEBHOOK_SECRET;
      const same = (v: unknown) => typeof v === "string" && v.length === secret!.length && timingSafeEqual(Buffer.from(v), Buffer.from(secret!));
      if (secret && !same(req.query.token) && !same(req.headers["x-loom-secret"])) {
        return void res.status(401).json({ error: "unauthorized" });
      }
      // No secret set is fine on loopback and nowhere else.
      //
      // This route sits in front of the bearer wall on purpose — an alert
      // sender posts here and has no Loom token — and its own secret was
      // optional, which together meant a daemon started with --host or
      // --tailnet served an unauthenticated endpoint that can quarantine an
      // agent, move the baton, and append status events the shared brain then
      // reads. On 127.0.0.1 that is a local-user-only capability and an
      // acceptable default; reachable from a network it is a stranger
      // steering the fleet. The comment on the auth bypass already said "set
      // that secret whenever the daemon binds past localhost" — this makes it
      // true rather than advisory, and says which variable to set instead of
      // just refusing.
      if (!secret && !isLoopbackHost(ctx.host)) {
        return void res.status(401).json({
          error:
            "this daemon is not bound to localhost, so the webhook needs LOOM_WEBHOOK_SECRET set",
        });
      }
      const body = (req.body ?? {}) as Record<string, unknown>;
      const rawAlerts = Array.isArray(body.alerts) ? (body.alerts as Record<string, unknown>[]) : [body];
      const q = req.query as Record<string, string>;
      const common = (body.commonLabels ?? {}) as Record<string, string>;
      const actions: Array<Record<string, unknown>> = [];
      for (const raw of rawAlerts) {
        const al = (raw ?? {}) as Record<string, unknown>;
        const labels = { ...common, ...((al.labels ?? {}) as Record<string, string>) };
        const status = String(al.status ?? body.status ?? "firing");
        const projectRef = labels["loom.project"] ?? labels.loom_project ?? q.project;
        const agent = labels["gen_ai.agent.id"] ?? labels.gen_ai_agent_id ?? labels.agent ?? q.agent;
        const alertName = String(labels.alertname ?? body.title ?? "alert");
        if (status !== "firing" && status !== "resolved") { actions.push({ skipped: `status "${status}"` }); continue; }
        if (!agent) { actions.push({ skipped: "no agent label on alert" }); continue; }
        const infos = listProjects();
        // A project ref must actually match — never silently act on an arbitrary
        // project. Only auto-pick when there's exactly one project and no ref.
        const info = projectRef
          ? infos.find((p) => p.name === projectRef || p.id === projectRef)
          : infos.length === 1 ? infos[0] : undefined;
        if (!info) {
          actions.push({ skipped: projectRef ? `no project matching "${projectRef}"` : "project label required (multiple projects)" });
          continue;
        }
        try {
          const rt = await ctx.runtime(info.id);
          if (status === "resolved") {
            // Recovery: retry the original agent if we had quarantined it.
            const q0 = rt.unquarantine(String(agent));
            if (!q0) { actions.push({ project: info.name, agent, alert: alertName, action: "resolved (was not quarantined)" }); continue; }
            const holder = rt.baton.holder();
            const retried = q0.displaced && holder !== agent;
            if (retried) await rt.handoff(String(agent));
            rt.log.append({
              kind: "status", agentId: String(agent),
              payload: { state: "alert_recovery", alert: alertName, retried, pausedMs: Date.now() - q0.since }
            });
            actions.push({
              project: info.name, agent, alert: alertName,
              action: retried ? `recovered — baton handed back to ${agent}` : "recovered — quarantine lifted"
            });
            continue;
          }
          // Firing: pause the agent and fail the baton over.
          const holder = rt.baton.holder();
          const agents = (await rt.status()).agents;
          const fallback = agents.find((a) => a.id !== agent)?.id;
          const displaced = holder === agent && !!fallback;
          rt.quarantine(String(agent), alertName, displaced);
          rt.log.append({
            kind: "status", agentId: String(agent),
            payload: { state: "alert_intervention", alert: alertName, holder, fallback: fallback ?? null }
          });
          // Then the recheck loop: pause → recheck → return the baton if the
          // agent stops erroring, retrying a few times before giving up. It
          // starts once the failover has landed: started before, a quick
          // recheck could find the agent still holding the baton, call it
          // recovered with nothing to hand back, and let the failover strand
          // the baton on the stand-in a moment later.
          const since = Date.now();
          try {
            if (displaced) {
              await rt.handoff(fallback!);
              actions.push({ project: info.name, agent, alert: alertName, action: `quarantined; baton handed to ${fallback}` });
            } else {
              actions.push({
                project: info.name, agent, alert: alertName,
                action: fallback ? "quarantined (agent wasn't holding the baton)" : "quarantined (no fallback agent)"
              });
            }
          } finally {
            ctx.startHealLoop(rt, String(agent), alertName, since);
          }
        } catch (e) {
          actions.push({ agent, error: e instanceof Error ? e.message : String(e) });
        }
      }
      res.json({ ok: true, actions });
    })();
  });
}
