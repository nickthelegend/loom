import type { Express } from 'express';
import { type Request } from "express";
import fs from "node:fs";
import path from "node:path";
import { buildDefaultRoutes, defaultAgentConfigs, detectAdes } from "../../core/ades.js";
import { ensureLoomHome, listProjects, projectLoomDir, readProjectConfig, registerProject, unregisterProject, writeProjectConfig } from "../../core/registry.js";
import type { ProjectConfig, ProjectInfo } from "../../types.js";
import type { RouteContext } from './context.js';

/**
 * Make a directory a project: its config (detecting the agents on this
 * machine when it has none) and its registry entry. Also how a joined
 * teammate's fresh clone becomes a project (daemon/onboard.ts).
 */
export async function addProjectAt(resolved: string, name?: string): Promise<{ info: ProjectInfo; config: ProjectConfig }> {
  let config = readProjectConfig(resolved);
  // A config that exists but has no name is legal on disk and was silently
  // corrosive: the defaulting branch below is skipped, `--name` is ignored,
  // and `registerProject` stores `name: null`. That null then surfaces as a
  // nameless row in the project list and as a missing `project` field in
  // snapshots — which declare it as a string. ProjectConfig types `name` as
  // required, but the file is read through an unchecked cast, so the type
  // system never had a chance to notice. Fill it in, and persist, because
  // the docs tell people to hand-edit this file for agents; forgetting the
  // name while doing so should cost them nothing.
  if (config && !String(config.name ?? "").trim()) {
    config = { ...config, name: name?.trim() || path.basename(resolved) };
    writeProjectConfig(resolved, config);
  }
  if (!config) {
    // Every ADE Loom can drive, probed in parallel — see core/ades.ts.
    // This used to name claude and opencode by hand, which is how the list
    // of what Loom actually drives drifted from the list of logos it ships.
    const availability = await detectAdes();
    const agents = defaultAgentConfigs(availability);
    const routes = buildDefaultRoutes(agents);
    config = {
      name: name ?? path.basename(resolved),
      agents,
      ...(routes ? { routes } : {}),
    };
    writeProjectConfig(resolved, config);
  }
  const info = registerProject(resolved, config.name || path.basename(resolved));
  return { info, config };
}

/** Register projects routes in the order established by LoomDaemon.routes(). */
export function registerProjectsRoutes(app: Express, ctx: Pick<RouteContext, "runtime" | "runtimes" | "specRunner">): void {

  app.get("/api/projects", (req, res) => {
    void (async () => {
      // A scoped token's world IS its scope: other projects are not listed,
      // not greyed out — a list that names what you cannot open is a map of
      // someone else's machine.
      const scope = (req as Request & { projectScope?: string[] | null }).projectScope;
      const projects = [];
      for (const info of listProjects()) {
        if (scope && !scope.includes(info.id)) continue;
        try {
          const rt = await ctx.runtime(info.id);
          projects.push(await rt.status());
        } catch (err) {
          projects.push({
            id: info.id,
            name: info.name,
            dir: info.dir,
            holder: null,
            agents: [],
            lastEvent: null,
            needsInput: false,
            error: String(err instanceof Error ? err.message : err),
            ...(fs.existsSync(info.dir) ? {} : { missing: true }),
          });
        }
      }
      res.json({ projects });
    })();
  });

  app.post("/api/projects", (req, res) => {
    void (async () => {
      const { dir, name } = (req.body ?? {}) as { dir?: string; name?: string };
      if (!dir) return void res.status(400).json({ error: "missing dir" });
      const resolved = path.resolve(dir);
      if (!fs.existsSync(resolved)) {
        return void res.status(400).json({ error: `no such directory: ${resolved}` });
      }
      const { info, config } = await addProjectAt(resolved, name);
      res.json({ project: info, config });
    })();
  });

  /**
   * Stop tracking a project. The opposite of POST /api/projects, which did
   * not exist until now: you could point Loom at a directory and had no
   * supported way to un-point it short of hand-editing ~/.loom/registry.json
   * and restarting the daemon. `unregisterProject` was already sitting in
   * core/registry.ts with no caller.
   *
   * Registry-only, deliberately. The project's `.loom/` — its config, its
   * event log, its memory — stays exactly where it is, so re-adding the same
   * directory later restores the whole history rather than starting a blank
   * one. Deleting a run's record because someone tidied a list is not a
   * trade this should make on the user's behalf; `rm -rf .loom` is theirs.
   *
   * The live runtime is closed first. Left open it keeps polling, holds its
   * agents, and would happily write more events into a project the API has
   * just said it no longer tracks.
   */
  app.delete("/api/projects/:id", (req, res) => {
    void (async () => {
      const id = String(req.params.id);
      const info = listProjects().find((p) => p.id === id);
      if (!info) return void res.status(404).json({ error: "no such project" });
      const rt = ctx.runtimes.get(id);
      if (rt) {
        await rt.close();
        ctx.runtimes.delete(id);
      }
      // A spec run mid-flight would keep streaming into a project the API
      // just said it no longer tracks; its daemon-side scrollback files are
      // daemon state (not the project's .loom/), so tidying them here is not
      // deleting the user's data — re-adding the project starts terminals
      // fresh, exactly as expected.
      ctx.specRunner.stop(id);
      try {
        const dir = path.join(ensureLoomHome(), "scrollback");
        for (const f of fs.readdirSync(dir)) {
          if (f.startsWith(`${id}-`)) fs.rmSync(path.join(dir, f), { force: true });
        }
      } catch {
        /* no scrollback dir yet */
      }
      unregisterProject(id);
      res.json({ removed: true, project: info, keptOnDisk: projectLoomDir(info.dir) });
    })();
  });
}
