import type { Express } from 'express';
import { PERMISSION_PROFILES } from "../../core/permissions.js";
import type { RouteContext, WithRuntime } from './context.js';
/** Register approvals routes in the order established by LoomDaemon.routes(). */
export function registerApprovalsRoutes(app: Express, ctx: Pick<RouteContext, "approvals">, withRuntime: WithRuntime): void {

  // ---- permissions & approvals (core/permissions.ts, core/approvals.ts) ---
  app.get("/api/permissions", (_req, res) => {
    res.json({ profiles: PERMISSION_PROFILES });
  });

  app.post(
    "/api/projects/:id/agents/:agentId/permissions",
    withRuntime(async (rt, req, res) => {
      const { permissions } = (req.body ?? {}) as { permissions?: string };
      try {
        const cfg = rt.setAgentPermissions(String(req.params.agentId), permissions as never);
        res.json({ agent: cfg });
      } catch (err) {
        res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
      }
    }),
  );

  app.get(
    "/api/projects/:id/approvals",
    withRuntime(async (rt, req, res) => {
      const guest = (req as unknown as { guest?: { chat: string } }).guest;
      const pending = [...ctx.approvals.values()]
        .filter((a) => a.projectId === rt.info.id && (!guest || (a.chat ?? "main") === guest.chat))
        .map(({ settle: _s, ...a }) => a);
      res.json({ approvals: pending });
    }),
  );

  app.post(
    "/api/projects/:id/approvals/:approvalId",
    withRuntime(async (rt, req, res) => {
      const a = ctx.approvals.get(String(req.params.approvalId));
      const guest = (req as unknown as { guest?: { chat: string; name: string } }).guest;
      if (!a || a.projectId !== rt.info.id || (guest && (a.chat ?? "main") !== guest.chat)) return void res.status(404).json({ error: "no such approval (already answered?)" });
      const b = (req.body ?? {}) as { decision?: string; message?: string };
      if (b.decision !== "allow" && b.decision !== "allow_session" && b.decision !== "deny") {
        return void res.status(400).json({ error: 'decision must be "allow", "allow_session" or "deny"' });
      }
      if (b.decision === "allow_session" && !a.sessionOption) return void res.status(400).json({ error: "this request can't be allowed for the session" });
      a.settle(
        b.decision === "allow" ? { behavior: "allow" }
          : b.decision === "allow_session" ? { behavior: "allow", scope: "session" }
          : { behavior: "deny", message: String(b.message ?? "Denied in Loom.").slice(0, 500) },
        guest?.name,
      );
      res.json({ ok: true });
    }),
  );
}
