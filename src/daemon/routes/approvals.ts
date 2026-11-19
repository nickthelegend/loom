import { readApprovalRoles, writeApprovalRoles, mayApprove } from "../../core/team-sharing.js";
import { bearerToken } from "../auth.js";
import type { Express, Request } from 'express';
import { PERMISSION_PROFILES } from "../../core/permissions.js";
import type { RouteContext, WithRuntime } from './context.js';
/** Register approvals routes in the order established by LoomDaemon.routes(). */
export function registerApprovalsRoutes(app: Express, ctx: Pick<RouteContext, "approvals" | "auth">, withRuntime: WithRuntime): void {

  const identity = (req: import("express").Request) => {
    const token = bearerToken(req.headers.authorization);
    return { owner: !ctx.auth.allowedProjects(token ?? "") && !ctx.auth.guestOf(token), client: ctx.auth.clientFor(token) };
  };
  app.get("/api/projects/:id/approval-roles", withRuntime(async (rt, req, res) => {
    const who = identity(req), roles = readApprovalRoles(rt.info.dir);
    res.json({ ...roles, canApprove: mayApprove(roles, who.owner, who.client?.id), devices: ctx.auth.approvalDevices(rt.info.id) });
  }));
  app.put("/api/projects/:id/approval-roles", withRuntime(async (rt, req, res) => {
    const who = identity(req);
    if (!mayApprove(readApprovalRoles(rt.info.dir), who.owner, who.client?.id)) return void res.status(403).json({ error: "only a project approver may change approval roles" });
    try { res.json(writeApprovalRoles(rt.info.dir, req.body)); }
    catch (e) { res.status(400).json({ error: (e as Error).message }); }
  }));

  const owner = (req: Request) => {
    const r = req as Request & { guest?: unknown; projectScope?: string[] | null };
    return !r.guest && !r.projectScope;
  };
  app.get("/api/projects/:id/safety", withRuntime(async (rt, req, res) => {
    if (!owner(req)) return void res.status(403).json({ error: "Safety settings require an owner or unscoped device." });
    res.json({ policy: rt.safetyPolicy() });
  }));
  app.put("/api/projects/:id/safety", withRuntime(async (rt, req, res) => {
    if (!owner(req)) return void res.status(403).json({ error: "Safety settings require an owner or unscoped device." });
    try { res.json({ policy: rt.setSafetyPolicy(req.body) }); }
    catch (error) { res.status(400).json({ error: (error as Error).message }); }
  }));

  // ---- permissions & approvals (core/permissions.ts, core/approvals.ts) ---
  app.get("/api/permissions", (_req, res) => {
    res.json({ profiles: PERMISSION_PROFILES });
  });

  app.post(
    "/api/projects/:id/agents/:agentId/permissions",
    withRuntime(async (rt, req, res) => {
      if (!owner(req)) return void res.status(403).json({ error: "Permission changes require an owner or unscoped device." });
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
      const who = identity(req);
      if (!mayApprove(readApprovalRoles(rt.info.dir), who.owner, who.client?.id)) return void res.status(403).json({ error: "this device is not a project approver" });
      const b = (req.body ?? {}) as { decision?: string; message?: string };
      if (b.decision !== "allow" && b.decision !== "allow_session" && b.decision !== "deny") {
        return void res.status(400).json({ error: 'decision must be "allow", "allow_session" or "deny"' });
      }
      if (b.decision === "allow_session" && !a.sessionOption) return void res.status(400).json({ error: "this request can't be allowed for the session" });
      a.settle(
        b.decision === "allow" ? { behavior: "allow" }
          : b.decision === "allow_session" ? { behavior: "allow", scope: "session" }
          : { behavior: "deny", message: String(b.message ?? "Denied in Loom.").slice(0, 500) },
        guest?.name ?? who.client?.name ?? "owner",
      );
      res.json({ ok: true });
    }),
  );
}
