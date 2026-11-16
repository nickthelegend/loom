import fs from "node:fs";
import path from "node:path";
import { newId, readProjectConfig, writeProjectConfig } from "../core/registry.js";
import {
  cloneSource, initializeProject, projectAgents, projectGit, projectName, reserveProjectDirectory,
  ProjectCreationError, type CloneProjectInput, type CreatedProject, type NewProjectInput, type ProjectCloneJob,
} from "../core/project-creation.js";
import type { ProjectConfig, ProjectInfo } from "../types.js";

type RegisterProject = (dir: string, name?: string) => Promise<{ info: ProjectInfo; config: ProjectConfig }>;

/** Jobs belong to this daemon; a restart forgets their progress, but keeps registered projects. */
export class ProjectCreation {
  private jobs = new Map<string, ProjectCloneJob>();
  private pending = new Map<AbortController, Promise<void>>();
  private closing = false;

  constructor(private register: RegisterProject, private broadcast: (frame: Record<string, unknown>) => void) {}

  async create(input: NewProjectInput): Promise<CreatedProject> {
    if (this.closing) throw new ProjectCreationError("daemon is shutting down", 503);
    const name = projectName(input.name);
    const agents = projectAgents(input.agents);
    if (input.git !== undefined && typeof input.git !== "boolean") throw new ProjectCreationError("git must be a boolean");
    const dir = reserveProjectDirectory(name);
    try {
      await initializeProject(dir, name, input.git !== false);
      if (agents !== undefined) writeProjectConfig(dir, { name, agents });
      const { info, config } = await this.register(dir, name);
      this.broadcast({ type: "projects", project: info });
      return { project: info, config };
    } catch (error) {
      fs.rmSync(dir, { recursive: true, force: true });
      throw error;
    }
  }

  clone(input: CloneProjectInput): { jobId: string; dir: string } {
    if (this.closing) throw new ProjectCreationError("daemon is shutting down", 503);
    const source = cloneSource(input.url);
    const name = projectName(input.name === undefined ? source.name : input.name);
    const dir = reserveProjectDirectory(name);
    const jobId = newId();
    const job: ProjectCloneJob = { status: "cloning", progress: "" };
    // Keep recent completed jobs for reconnecting clients without growing forever.
    if (this.jobs.size >= 100) {
      for (const [id, old] of this.jobs) {
        if (old.status !== "cloning") this.jobs.delete(id);
        if (this.jobs.size < 100) break;
      }
    }
    this.jobs.set(jobId, job);
    const publish = () => this.broadcast({ type: "project-job", jobId, dir, ...job });
    publish();
    const controller = new AbortController();
    const task = (async () => {
      try {
        await projectGit(["-c", "protocol.allow=never", "-c", "protocol.https.allow=always", "-c", "protocol.ssh.allow=always",
          ...(source.url.startsWith("file:") ? ["-c", "protocol.file.allow=always"] : []),
          "clone", "--progress", "--", source.url, dir], path.dirname(dir), {
          signal: controller.signal,
          // git rewrites one line with \r as it goes; the client only needs the latest one
          progress: (text) => {
            const line = text.split(/[\r\n]+/).map((l) => l.trim()).filter(Boolean).pop() ?? "";
            if (line && line !== job.progress) { job.progress = line.slice(0, 200); publish(); }
          },
        });
        if (this.closing) throw new Error("project creation cancelled: daemon is shutting down");
        // A repository must not redirect config writes outside its own clone.
        const loom = path.join(dir, ".loom");
        for (const file of [loom, path.join(loom, "config.json")]) {
          if (fs.lstatSync(file, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error("cloned Loom config must not be a symlink");
        }
        // A cloned repo is someone else's code: a committed .loom/config.json could name agent
        // commands that would run the moment the project opens. Set it aside (kept, for you to read
        // and adopt) and let Loom detect this machine's agents as it does for any new folder.
        const committed = path.join(loom, "config.json");
        let setAside = false;
        if (fs.existsSync(committed)) {
          fs.renameSync(committed, path.join(loom, "config.cloned.json"));
          setAside = true;
        }
        const { info } = await this.register(dir, input.name === undefined ? undefined : name);
        if (input.name !== undefined) {
          const config = readProjectConfig(dir);
          if (config && config.name !== name) writeProjectConfig(dir, { ...config, name });
        }
        if (setAside) job.progress = "the repo's own .loom/config.json was set aside as .loom/config.cloned.json";
        job.project = info;
        job.status = "done";
        this.broadcast({ type: "projects", project: info });
      } catch (error) {
        job.status = "failed";
        job.error = error instanceof Error ? error.message : String(error);
        try { fs.rmSync(dir, { recursive: true, force: true }); }
        catch (cleanup) { job.error += `; could not remove ${dir}: ${String(cleanup)}`; }
      } finally {
        publish();
        this.pending.delete(controller);
      }
    })();
    this.pending.set(controller, task);
    return { jobId, dir };
  }

  job(id: string): ProjectCloneJob | undefined { return this.jobs.get(id); }

  async close(): Promise<void> {
    this.closing = true;
    for (const controller of this.pending.keys()) controller.abort();
    await Promise.all(this.pending.values());
  }
}
