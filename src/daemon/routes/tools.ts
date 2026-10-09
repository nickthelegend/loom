import type { Express } from 'express';
import path from "node:path";
import { searchCatalog } from "../../core/mcp-catalog.js";
import { probeMcpServer } from "../../core/mcp.js";
import { authorSkill, SkillInstallError } from "../../core/skill-install.js";
import { suggestSkill } from "../../core/skills.js";
import type { WithRuntime } from './context.js';
/** Register tools routes in the order established by LoomDaemon.routes(). */
export function registerToolsRoutes(app: Express, withRuntime: WithRuntime): void {

  // Skills: the SKILL.md context blocks; per-project enable state; a keyword
  // suggestion for the current message (?suggest=<text>).
  app.get(
    "/api/projects/:id/skills",
    withRuntime(async (rt, req, res) => {
      const skills = rt.getSkills();
      const suggest = req.query.suggest ? suggestSkill(String(req.query.suggest), skills) : null;
      res.json({ skills, suggestion: suggest });
    }),
  );

  app.put(
    "/api/projects/:id/skills/:skillId",
    withRuntime(async (rt, req, res) => {
      const { enabled } = (req.body ?? {}) as { enabled?: boolean };
      const id = String(req.params.skillId);
      // turning on a skill that doesn't exist saved a phantom row and said OK
      if (enabled !== false && !rt.skillsCatalog().some((sk) => sk.id === id)) {
        return void res.status(404).json({ error: `no skill "${id}" in this project or on this machine` });
      }
      res.json({ skills: rt.setSkillEnabled(id, enabled !== false) });
    }),
  );

  // The skill picker's list: every skill discoverable from this project, from
  // all four roots (project, ~/.claude, plugin caches, bundled), without the
  // bodies. `origin` and `source` say where each one lives, and `installed`
  // marks the ones in the project's own skills/ dir — the only ones DELETE
  // will touch.
  app.get(
    "/api/projects/:id/skills/catalog",
    withRuntime(async (rt, _req, res) => {
      res.json({ skills: rt.skillsCatalog() });
    }),
  );

  // Install a skill: from a git remote, or from a directory on this machine.
  // Everything the user can fix — a URL that isn't git, a repo with no
  // SKILL.md, a name already taken — comes back as a 400 with the reason,
  // because "invalid input" is useless when the real answer is "that repo has
  // no SKILL.md in it".
  app.post(
    "/api/projects/:id/skills/install",
    withRuntime(async (rt, req, res) => {
      const body = (req.body ?? {}) as { gitUrl?: string; dir?: string; force?: boolean };
      try {
        const skill = await rt.installSkill(body);
        res.json({ skill, skills: rt.skillsCatalog() });
      } catch (err) {
        if (err instanceof SkillInstallError) {
          return void res.status(400).json({ error: err.message });
        }
        throw err;
      }
    }),
  );

  // Remove a project-installed skill from disk. Refused (400) for a skill
  // that lives in ~/.claude or a plugin cache: those are shared with every
  // other tool on the machine and are not ours to delete.
  app.delete(
    "/api/projects/:id/skills/:skillId",
    withRuntime(async (rt, req, res) => {
      try {
        const removed = rt.removeSkill(String(req.params.skillId));
        res.json({ ...removed, skills: rt.skillsCatalog() });
      } catch (err) {
        if (err instanceof SkillInstallError) {
          return void res.status(400).json({ error: err.message });
        }
        throw err;
      }
    }),
  );

  // The MCP catalog: the official registry, searchable, plus a hand-verified
  // shortlist for the empty state. Not project-scoped — it is the same
  // catalog for everyone, and caching it per-project would multiply the
  // requests against somebody else's public service by the project count.
  //
  // `degraded: true` means the registry did not answer and `servers` is
  // therefore empty; `featured` needs no network and is always there.
  app.get("/api/mcp/catalog", (req, res) => {
    void (async () => {
      const q = String(req.query.q ?? "").trim();
      const limit = req.query.limit ? Number(req.query.limit) : undefined;
      res.json(await searchCatalog(q, limit));
    })();
  });

  // MCP servers: the connect/toggle list. PATCH upserts one by name.
  //
  // `connected` on each row is measured here, not inferred from the presence
  // of a url — every configured endpoint gets a bounded probe (2s, in
  // parallel) and reports what actually answered. `?probe=0` skips it for a
  // caller that only wants the configured list back fast.
  app.get(
    "/api/projects/:id/mcps",
    withRuntime(async (rt, req, res) => {
      const probe = String(req.query.probe ?? "1") !== "0";
      res.json({ mcps: probe ? await rt.getMcpsProbed() : rt.getMcps(), probed: probe });
    }),
  );

  app.patch(
    "/api/projects/:id/mcps",
    withRuntime(async (rt, req, res) => {
      const body = (req.body ?? {}) as { mcp?: { name?: string } };
      if (!body.mcp?.name) return void res.status(400).json({ error: "mcp.name required" });
      res.json({ mcps: rt.upsertMcp(body.mcp as Parameters<typeof rt.upsertMcp>[0]) });
    }),
  );

  // Install a server picked out of the catalog.
  //
  // Two things separate this from the PATCH above. It refuses a server with
  // neither a url nor a command — that is the exact shape of the old
  // placeholder rows, and the whole point of the catalog is that a row means
  // something now. And it probes what it just wrote, so the response carries a
  // measured `connected` rather than leaving the UI to render a green badge
  // off the presence of a string.
  app.post(
    "/api/projects/:id/mcps/install",
    withRuntime(async (rt, req, res) => {
      const body = (req.body ?? {}) as {
        name?: string;
        url?: string;
        command?: string;
        args?: unknown;
        transport?: string;
        headers?: Record<string, string>;
        env?: Record<string, string>;
        description?: string;
        slug?: string;
      };
      const name = String(body.name ?? "").trim();
      if (!name) return void res.status(400).json({ error: "name required" });
      const url = String(body.url ?? "").trim();
      const command = String(body.command ?? "").trim();
      if (!url && !command) {
        return void res.status(400).json({
          error: `"${name}" has neither a url nor a command — an MCP server needs somewhere to connect to or something to run`,
        });
      }
      if (url && !/^https?:\/\//i.test(url)) {
        return void res.status(400).json({ error: `"${url}" is not an http(s) URL` });
      }
      const transport = body.transport === "sse" || body.transport === "http" ? body.transport : undefined;
      const args = Array.isArray(body.args) ? body.args.map((a) => String(a)) : undefined;
      const mcps = rt.upsertMcp({
        name,
        url,
        ...(command ? { command } : {}),
        ...(args?.length ? { args } : {}),
        ...(url && transport ? { transport } : {}),
        ...(body.headers && Object.keys(body.headers).length ? { headers: body.headers } : {}),
        ...(body.env && Object.keys(body.env).length ? { env: body.env } : {}),
        ...(body.description ? { description: String(body.description) } : {}),
        ...(body.slug ? { slug: String(body.slug) } : {}),
        enabledForSession: true,
      });
      // Probe after persisting: the answer describes what is now configured,
      // and a server that fails its probe is still installed — unreachable is
      // a state to show, not a reason to refuse to save.
      const installed = mcps.find((m) => m.name === name);
      const connected = url ? await probeMcpServer(url).catch(() => false) : false;
      res.json({
        installed: installed ? { ...installed, connected, probedAt: Date.now() } : null,
        mcps: await rt.getMcpsProbed(),
      });
    }),
  );

  // The background poll's live view: up/down, consecutive failures, last
  // probe. POST forces a poll now instead of waiting for the next tick.
  app.get(
    "/api/projects/:id/mcps/health",
    withRuntime(async (rt, _req, res) => {
      res.json({ health: rt.mcpHealthReport() });
    }),
  );

  app.post(
    "/api/projects/:id/mcps/health",
    withRuntime(async (rt, _req, res) => {
      await rt.pollMcpHealth();
      res.json({ health: rt.mcpHealthReport() });
    }),
  );

  // Author a skill in place: scaffold skills/<id>/SKILL.md, validated by the
  // same parser the roster reads with — a skill this accepts is one the
  // loader will actually offer.
  app.post(
    "/api/projects/:id/skills/author",
    withRuntime(async (rt, req, res) => {
      const b = (req.body ?? {}) as {
        id?: string;
        name?: string;
        description?: string;
        body?: string;
        enable?: boolean;
      };
      try {
        const out = authorSkill(rt.info.dir, {
          id: String(b.id ?? ""),
          name: String(b.name ?? ""),
          description: String(b.description ?? ""),
          ...(b.body ? { body: String(b.body) } : {}),
        });
        if (b.enable !== false) rt.setSkillEnabled(path.basename(out.dir), true);
        res.json(out);
      } catch (err) {
        res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
      }
    }),
  );

  // Uninstall a server. 404 when nothing was configured under that name —
  // "deleted a thing that wasn't there" hides a typo in a server name.
  app.delete(
    "/api/projects/:id/mcps/:name",
    withRuntime(async (rt, req, res) => {
      const { removed, mcps } = rt.removeMcp(String(req.params.name));
      if (!removed) return void res.status(404).json({ error: `no configured MCP server "${req.params.name}"` });
      res.json({ removed: true, mcps });
    }),
  );
}
