import type { Express, Request } from "express";
import { agentSkillsStatus, installAgentSkills, parseSkillAgents, uninstallAgentSkills } from "../../core/agent-skills.js";
import { readDaemonConfig } from "../../core/registry.js";

/** Machine-wide agent skills API, using the exported core/agent-skills types.
 * GET -> AgentSkillsStatus & { autoUpdate: boolean }. Owner and unscoped devices
 * can read; scoped tokens and guests cannot inspect machine-wide directories.
 * POST /install or /uninstall { agents: SkillAgent[] } -> AgentSkillsResult.
 * Only admin tokens and owner sessions may mutate. Codex/OpenCode share a destination, so POST
 * returns one result per unique directory/skill. HTTP 200 can contain conflicts
 * or filesystem errors: show each result, then GET to refresh actual status.
 * Invalid selection -> 400; unauthorized -> 401; non-owner mutation -> 403.
 * Paths are never accepted over HTTP. CLI --target is local-only.
 */
export function registerAgentSkillsRoutes(app: Express): void {
  app.use("/api/agent-skills", (req, res, next) => {
    if ((req as Request & { projectScope?: string[] | null }).projectScope) {
      return void res.status(403).json({ error: "agent skills require an owner or unscoped token" });
    }
    next();
  });
  app.get("/api/agent-skills", (_req, res) => {
    try { res.json({ ...agentSkillsStatus(), autoUpdate: readDaemonConfig()?.agentSkills?.autoUpdate !== false }); }
    catch (err) { res.status(500).json({ error: (err as Error).message }); }
  });
  for (const action of ["install", "uninstall"] as const) {
    app.post(`/api/agent-skills/${action}`, (req, res) => {
      if (!(req as Request & { isAdmin?: boolean }).isAdmin) return void res.status(403).json({ error: "admin only" });
      let agents;
      try {
        if (!req.body || Object.keys(req.body).some(key => key !== "agents")) throw new Error("expected { agents: [...] }");
        agents = parseSkillAgents(req.body.agents);
      } catch (err) { return void res.status(400).json({ error: (err as Error).message }); }
      try { res.json((action === "install" ? installAgentSkills : uninstallAgentSkills)({ agents })); }
      catch (err) { res.status(500).json({ error: (err as Error).message }); }
    });
  }
}
