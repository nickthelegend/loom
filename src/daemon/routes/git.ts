import { SecretScanError, withSecretOverride } from "../../core/git-safety.js";
import path from "node:path";
import fs from "node:fs";
import type { Express } from 'express';
import { agentDiffStats, describeChat, draftCommit, REVIEW_TEMPLATES, suggestChangelog } from "../../core/git-review.js";
import { branches as gitBranches, checkout as gitCheckout, commit as gitCommit, discard as gitDiscard, GitError, fileDiff as gitFileDiff, init as gitInit, log as gitLog, push as gitPush, stage as gitStage, stagedDiff as gitStagedDiff, status as gitStatus, unstage as gitUnstage } from "../../core/git.js";
import { logbook } from "../../core/logbook.js";
import { asPaths } from '../system.js';
import type { WithRuntime } from './context.js';
/** Register git routes in the order established by LoomDaemon.routes(). */
export function registerGitRoutes(app: Express, withRuntime: WithRuntime): void {

  // ---- source control ---------------------------------------------------
  // Reading the working tree has been possible since the Explorer landed;
  // doing anything about it has not. These are the writes, and they're the
  // only endpoints in Loom that can destroy work — hence the path checks in
  // core/git.ts and the noise in the log when you discard.
  app.get(
    "/api/projects/:id/git/status",
    withRuntime(async (rt, _req, res) => {
      res.json(await gitStatus(rt.info.dir));
    }),
  );

  const gitWrite = (
    fn: (dir: string, body: Record<string, unknown>) => Promise<unknown>,
  ) =>
    withRuntime(async (rt, req, res) => {
      try {
        const body = (req.body ?? {}) as Record<string, unknown>;
        const auth = req as typeof req & { guest?: unknown; projectScope?: string[] | null };
        if (body.overrideSecrets !== undefined && typeof body.overrideSecrets !== "boolean") return void res.status(400).json({ error: "overrideSecrets must be boolean" });
        if (body.overrideSecrets && (auth.guest || auth.projectScope)) return void res.status(403).json({ error: "Secret overrides require an owner or unscoped device." });
        const result = await withSecretOverride(body.overrideSecrets === true, () => fn(rt.info.dir, body));
        if (body.overrideSecrets) rt.log.append({ kind: "status", payload: { state: "secret_override", operation: req.path } });
        res.json(result);
      } catch (err) {
        if (err instanceof SecretScanError) return void res.status(409).json({ error: err.message, code: "secrets_detected", findings: err.findings });
        // git's own words, not ours: "nothing to commit, working tree clean"
        // beats anything we'd invent about an exit code.
        const message = err instanceof Error ? err.message : String(err);
        logbook.warn("git", message, err instanceof GitError ? err.stderr : err, rt.info.id);
        res.status(400).json({ error: err instanceof GitError ? err.stderr || message : message });
      }
    });

  // Add one pattern to the project's .gitignore (the source-control panel's
  // "Ignore" for Loom's own .loom/ files). One line, no globbing tricks beyond
  // what git reads; a pattern that's already there is left alone.
  app.post(
    "/api/projects/:id/git/ignore",
    withRuntime(async (rt, req, res) => {
      const pattern = String((req.body as { pattern?: unknown } | undefined)?.pattern ?? "").trim();
      if (!pattern || pattern.length > 200 || /[\r\n]/.test(pattern) || pattern.startsWith("!")) {
        return void res.status(400).json({ error: "one gitignore pattern, please" });
      }
      const file = path.join(rt.info.dir, ".gitignore");
      const cur = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
      const lines = cur.split(/\r?\n/).map((l) => l.trim());
      const bare = pattern.replace(/^\/|\/$/g, "");
      if (lines.some((l) => l.replace(/^\/|\/$/g, "") === bare)) return void res.json({ added: false });
      fs.writeFileSync(file, cur + (cur && !cur.endsWith("\n") ? "\n" : "") + pattern + "\n");
      res.json({ added: true });
    }),
  );

  app.post(
    "/api/projects/:id/git/stage",
    gitWrite((dir, b) => gitStage(dir, asPaths(b.paths))),
  );

  app.post(
    "/api/projects/:id/git/unstage",
    gitWrite((dir, b) => gitUnstage(dir, asPaths(b.paths))),
  );

  app.post(
    "/api/projects/:id/git/discard",
    gitWrite((dir, b) => gitDiscard(dir, asPaths(b.paths), asPaths(b.untracked))),
  );

  app.post(
    "/api/projects/:id/git/commit",
    gitWrite((dir, b) => gitCommit(dir, String(b.message ?? ""))),
  );

  // init / push / checkout — all write, all through the same error surface.
  app.post(
    "/api/projects/:id/git/init",
    gitWrite((dir) => gitInit(dir)),
  );

  app.post(
    "/api/projects/:id/git/push",
    gitWrite((dir) => gitPush(dir)),
  );

  app.post(
    "/api/projects/:id/git/checkout",
    gitWrite((dir, b) => gitCheckout(dir, String(b.ref ?? ""))),
  );

  // read-only: the commit log, one file's diff, and the branch list
  app.get(
    "/api/projects/:id/git/log",
    withRuntime(async (rt, req, res) => {
      const limit = Number((req.query as Record<string, string>).limit) || 30;
      res.json({ commits: await gitLog(rt.info.dir, limit) });
    }),
  );

  app.get(
    "/api/projects/:id/git/diff",
    withRuntime(async (rt, req, res) => {
      const p = String((req.query as Record<string, string>).path ?? "");
      if (!p) return void res.status(400).json({ error: "missing path" });
      try {
        res.json({ path: p, patch: await gitFileDiff(rt.info.dir, p) });
      } catch (err) {
        res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
      }
    }),
  );

  app.get(
    "/api/projects/:id/git/branches",
    withRuntime(async (rt, _req, res) => {
      res.json(await gitBranches(rt.info.dir));
    }),
  );

  app.get("/api/projects/:id/git/review-templates", withRuntime(async (_rt, _req, res) => {
    res.json({ templates: REVIEW_TEMPLATES });
  }));
  app.get("/api/projects/:id/insights/diffs", withRuntime(async (rt, req, res) => {
    res.json({ agents: agentDiffStats(rt.log.list({ kinds: ["turn_diff", "orchestra"], sinceTs: Number(req.query.since) || 0 })), from: "event-log" });
  }));
  app.post("/api/projects/:id/git/pr-description", withRuntime(async (rt, req, res) => {
    const chat = String(req.body?.chat ?? "main");
    if (!rt.chats().some(c => c.id === chat)) return void res.status(404).json({ error: "no such chat" });
    try { res.json(describeChat(rt.log.list({ chat }), String(req.body?.template ?? "standard"))); }
    catch (error) { res.status(400).json({ error: String(error) }); }
  }));
  app.post("/api/projects/:id/git/changelog", withRuntime(async (rt, req, res) => {
    try { res.json(await suggestChangelog(rt.info.dir, String(req.body?.branch ?? ""), String(req.body?.base ?? "HEAD"))); }
    catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : String(error) }); }
  }));
  app.post("/api/projects/:id/git/suggest-message", withRuntime(async (rt, req, res) => {
    const diff = await gitStagedDiff(rt.info.dir).catch(() => "");
    if (!diff.trim()) return void res.status(400).json({ error: "nothing to describe — stage or edit some files first" });
    const chat = String(req.body?.chat ?? "main");
    const prompt = rt.log.list({ chat, kinds: ["message"] }).filter(e => !e.agentId).at(-1)?.payload.text;
    res.json(await draftCommit(String(prompt ?? ""), diff, rt.config.git?.messageModel));
  }));
}
