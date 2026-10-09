import path from "node:path";
import fs from "node:fs";
import type { Express } from 'express';
import { claudeText } from "../../core/claude-cli.js";
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
        res.json(await fn(rt.info.dir, (req.body ?? {}) as Record<string, unknown>));
      } catch (err) {
        // git's own words, not ours: "nothing to commit, working tree clean"
        // beats anything we'd invent about an exit code.
        const message = err instanceof Error ? err.message : String(err);
        logbook.warn("git", message, err instanceof GitError ? err.stderr : err, rt.info.id);
        res.status(400).json({ error: message });
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

  // Draft a commit message from the staged diff, via the logged-in Claude CLI
  // — the "Generate" affordance. No key; a no-op-ish 400 when Claude isn't
  // there, so the field just stays empty and the user types their own.
  app.post(
    "/api/projects/:id/git/suggest-message",
    withRuntime(async (rt, _req, res) => {
      const diff = await gitStagedDiff(rt.info.dir).catch(() => "");
      if (!diff.trim()) return void res.status(400).json({ error: "nothing to describe — stage or edit some files first" });
      try {
        const prompt =
          "Write a single-line Conventional Commit subject (type(scope): summary, imperative mood, <72 chars) " +
          "for this diff. Reply with ONLY the subject line, no quotes, no body.\n\n" +
          diff;
        const out = (await claudeText(prompt, { model: "haiku", timeoutMs: 30_000 })).trim();
        const message = out.split("\n")[0]?.replace(/^["'`]|["'`]$/g, "").trim().slice(0, 120) ?? "";
        if (!message) return void res.status(502).json({ error: "Claude returned nothing — type a message instead" });
        res.json({ message });
      } catch {
        // claudeText's raw "claude exited N" helps no one at the commit box.
        res.status(502).json({ error: "couldn't reach Claude to draft a message — type one instead" });
      }
    }),
  );
}
