/**
 * Deploys and release notes (Loom Teams, Phase 5; D72) — read-only.
 *
 * GitHub Environments stay the deploy gate; Loom never deploys. It watches a
 * shared repo's deployments and posts their outcome to the team feed, alerts a
 * member whose merged goal is in a deploy that failed, and writes release notes
 * from the goals merged since a tag.
 */

import { execFile } from "node:child_process";

import { logbook } from "../core/logbook.js";
import { notify } from "../core/notify.js";
import type { FeedIn } from "../core/team-hub.js";
import type { Exec } from "./landing.js";
import type { ProjectRuntime } from "./runtime.js";

export interface Deployment {
  id: number;
  environment: string;
  sha: string;
  ref: string;
  creator: string | null;
  state: string; // latest status: queued | in_progress | success | failure | error | inactive | pending
  url: string | null;
  at: number;
}

/** The feed event a deployment's latest status is, if any (D72). */
export function deployEvent(d: Deployment): FeedIn["type"] | null {
  if (d.state === "success") return "deploy_succeeded";
  if (d.state === "failure" || d.state === "error") return "deploy_failed";
  if (d.state === "queued" || d.state === "in_progress" || d.state === "pending") return "deploy_started";
  return null;
}

export interface ReleaseEntry {
  pr: number;
  title: string;
  author: string;
  url: string;
  mergedAt: string | null;
  /** The goal's summary (the first paragraph of a Loom goal PR's body). */
  summary?: string;
  loom: boolean;
}

/** Release notes, grouped by member, Loom goals marked (D72). */
export function renderReleaseNotes(since: string, until: string, entries: ReleaseEntry[]): string {
  if (!entries.length) return `## Changes since ${since}\n\nNothing merged since ${since}.\n`;
  const byAuthor = new Map<string, ReleaseEntry[]>();
  for (const e of entries) byAuthor.set(e.author, [...(byAuthor.get(e.author) ?? []), e]);
  const lines = [`## Changes since ${since}`, "", `${entries.length} pull request${entries.length === 1 ? "" : "s"} merged into ${until}.`];
  for (const [author, es] of [...byAuthor.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))) {
    lines.push("", `### @${author}`);
    for (const e of es) {
      lines.push(`- ${e.title} ([#${e.pr}](${e.url}))${e.loom ? " · _Loom goal_" : ""}`);
      if (e.summary) lines.push(`  ${e.summary.replace(/\s+/g, " ").slice(0, 300)}`);
    }
  }
  return lines.join("\n") + "\n";
}

/** PR numbers from first-parent commit subjects: merge commits and squash "(#123)" suffixes. */
export function prNumbersFromLog(log: string): number[] {
  const out: number[] = [];
  for (const line of log.split("\n")) {
    const m = /Merge pull request #(\d+)/.exec(line) ?? /\(#(\d+)\)\s*$/.exec(line);
    if (m) out.push(Number(m[1]));
  }
  return [...new Set(out)];
}

const realExec: Exec = (cmd, args, cwd, opts = {}) =>
  new Promise((resolve) => {
    execFile(cmd, args, { cwd, timeout: opts.timeoutMs ?? 60_000, maxBuffer: 16 * 1024 * 1024 }, (err, out, errOut) =>
      resolve({ code: err ? 1 : 0, out: String(out), err: String(errOut) }),
    );
  });

export interface DeployDeps {
  share(rt: ProjectRuntime): Promise<{ teamId: string; repo: string } | null>;
  post(rt: ProjectRuntime, e: FeedIn): Promise<void>;
  exec?: Exec;
}

export const DEPLOY_POLL_MS = 2 * 60_000;

export class Deploys {
  private alerted = new Set<string>();

  constructor(private rt: ProjectRuntime, private deps: DeployDeps) {}

  private exec(cmd: string, args: string[]) {
    return (this.deps.exec ?? realExec)(cmd, args, this.rt.info.dir);
  }

  private async ghJson<T>(args: string[]): Promise<T | null> {
    const r = await this.exec("gh", args);
    if (r.code !== 0) return null;
    try {
      return JSON.parse(r.out) as T;
    } catch {
      return null;
    }
  }

  /** The repo's recent deployments with their latest status. */
  async list(): Promise<Deployment[]> {
    const share = await this.deps.share(this.rt);
    if (!share) return [];
    const deps = (await this.ghJson<Array<Record<string, unknown>>>(["api", `repos/${share.repo}/deployments?per_page=20`])) ?? [];
    const out: Deployment[] = [];
    for (const d of deps) {
      const id = Number(d.id);
      const statuses = (await this.ghJson<Array<Record<string, unknown>>>(["api", `repos/${share.repo}/deployments/${id}/statuses?per_page=1`])) ?? [];
      const st = statuses[0];
      out.push({
        id,
        environment: String(d.environment ?? ""),
        sha: String(d.sha ?? ""),
        ref: String(d.ref ?? ""),
        creator: ((d.creator as { login?: string } | undefined)?.login ?? null),
        state: String(st?.state ?? "pending"),
        url: (st?.log_url as string) || (st?.environment_url as string) || null,
        at: Date.parse(String(st?.created_at ?? d.created_at ?? "")) || Date.now(),
      });
    }
    return out;
  }

  /** Post each deployment's latest status to the feed (idempotent), and alert on failed deploys of our goals. */
  async poll(): Promise<number> {
    let posted = 0;
    const share = await this.deps.share(this.rt);
    if (!share) return 0;
    for (const d of await this.list()) {
      const type = deployEvent(d);
      if (!type) continue;
      await this.deps.post(this.rt, {
        repo: share.repo,
        type,
        meta: { id: d.id, environment: d.environment, sha: d.sha, ref: d.ref, state: d.state, url: d.url, creator: d.creator },
        dedupeKey: `deploy:${share.repo}:${d.id}:${type}`,
      });
      posted++;
      if (type === "deploy_failed") await this.alertIfOurs(d).catch(() => {});
    }
    return posted;
  }

  /** D25/D72: a failed deploy that contains one of our merged goals buzzes our phone. */
  private async alertIfOurs(d: Deployment): Promise<void> {
    const key = `${d.id}`;
    if (this.alerted.has(key)) return;
    await this.exec("git", ["fetch", "-q", "origin", d.sha]).catch(() => {});
    for (const run of this.rt.orchestra.list()) {
      const sha = run.landing?.mergeSha;
      if (run.landing?.state !== "merged" || !sha) continue;
      const inIt = await this.exec("git", ["merge-base", "--is-ancestor", sha, d.sha]);
      if (inIt.code !== 0) continue;
      this.alerted.add(key);
      const text = `Deploy to ${d.environment} failed, and it includes your goal "${run.goal.split("\n")[0]!.slice(0, 80)}" (PR #${run.landing.pr})`;
      this.rt.log.append({ kind: "orchestra", chat: run.chat, payload: { phase: "alert", runId: run.id, text } });
      notify({ title: `Loom · ${this.rt.info.name}`, body: text });
      return;
    }
  }

  /** Release notes from the PRs merged into the default branch since `since` (a tag or commit). */
  async releaseNotes(since: string): Promise<string> {
    const head = (await this.exec("git", ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"])).out.trim() || "origin/main";
    await this.exec("git", ["fetch", "-q", "--tags", "origin"]);
    const log = await this.exec("git", ["log", "--first-parent", "--format=%s", `${since}..${head}`]);
    if (log.code !== 0) throw new Error(`can't read history since ${since}: ${log.err.trim().slice(0, 200)}`);
    const entries: ReleaseEntry[] = [];
    for (const n of prNumbersFromLog(log.out)) {
      const pr = await this.ghJson<{ title: string; author: { login: string }; url: string; mergedAt: string | null; body: string; headRefName: string }>(
        ["pr", "view", String(n), "--json", "title,author,url,mergedAt,body,headRefName"],
      );
      if (!pr) {
        logbook.warn("team", `release notes: couldn't read PR #${n}`);
        continue;
      }
      const loom = pr.headRefName.startsWith("loom/orchestra/");
      const summary = loom ? pr.body.split(/\n\s*\n/)[0]?.trim() : undefined;
      entries.push({ pr: n, title: pr.title, author: pr.author.login, url: pr.url, mergedAt: pr.mergedAt, loom, ...(summary ? { summary } : {}) });
    }
    return renderReleaseNotes(since, head.replace(/^origin\//, ""), entries);
  }
}
