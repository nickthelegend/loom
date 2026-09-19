/**
 * GitHub facts as team feed events — one mapping for every way they arrive
 * (Loom Teams D7, Phase 6 D83–D84):
 *
 *   - polling: a daemon's `gh pr list` rows and `gh api …/deployments`
 *   - webhooks: a repo webhook posting to `loom hub` (POST /github/webhook/:team)
 *     or to the hosted hub's Edge Function (supabase/functions/github-webhook)
 *
 * Both produce the SAME dedupe keys for the same fact, so a team running both
 * never sees a PR merge, a failed check or a deploy twice: the hub appends a
 * key once.
 *
 * Self-contained on purpose — no imports, web-standard crypto only — so the
 * Edge Function (Deno) runs a byte-identical copy:
 * supabase/functions/_shared/github-events.ts (test/github-events.test.ts
 * fails when they drift).
 */

export type GhFeedType =
  | "pr_opened"
  | "pr_merged"
  | "pr_closed"
  | "check_failed"
  | "check_passed"
  | "review_submitted"
  | "deploy_started"
  | "deploy_succeeded"
  | "deploy_failed";

/** A feed event from GitHub (a FeedIn without device, signature or sealed content). */
export interface GhFeed {
  repo: string;
  type: GhFeedType;
  meta: Record<string, unknown>;
  dedupeKey: string;
}

/** The events a Loom repo webhook subscribes to. */
export const WEBHOOK_EVENTS = ["pull_request", "check_suite", "check_run", "pull_request_review", "deployment_status"] as const;

const REPO_RE = /^[a-z0-9_.-]+\/[a-z0-9_.-]+$/;

/** "Acme/App" → "acme/app"; null when it isn't owner/name. */
export function ghRepo(fullName: unknown): string | null {
  const r = String(fullName ?? "").trim().toLowerCase();
  return REPO_RE.test(r) ? r : null;
}

// ── dedupe keys: the contract between polling and webhooks ──

export const ghKey = {
  opened: (repo: string, n: number) => `gh:${repo}#${n}:opened`,
  merged: (repo: string, n: number) => `gh:${repo}#${n}:merged`,
  closed: (repo: string, n: number) => `gh:${repo}#${n}:closed`,
  /** One failing check at one commit: a fix's commit failing again is news. */
  failed: (repo: string, n: number, sha: string, check: string) => `gh:${repo}#${n}:failed:${sha}:${check}`,
  /** Checks passing at one commit. */
  passed: (repo: string, n: number, sha: string) => `gh:${repo}#${n}:passed:${sha}`,
  review: (repo: string, n: number, id: number | string) => `gh:${repo}#${n}:review:${id}`,
  deploy: (repo: string, id: number, type: GhFeedType) => `deploy:${repo}:${id}:${type}`,
};

const FAILED = /FAIL|ERROR|TIMED_OUT|CANCELLED/i;
const PASSED = /SUCCESS|NEUTRAL|SKIPPED/i;

/** The feed event a deployment status is, if any (D72). */
export function deployEventType(state: string): GhFeedType | null {
  if (state === "success") return "deploy_succeeded";
  if (state === "failure" || state === "error") return "deploy_failed";
  if (state === "queued" || state === "in_progress" || state === "pending") return "deploy_started";
  return null;
}

// ── polling: one `gh pr list --json number,title,state,headRefName,headRefOid,author,url,mergedAt,statusCheckRollup,files` row ──

export function prRowFeed(repo: string, pr: Record<string, unknown>): GhFeed[] {
  const n = Number(pr.number);
  const state = String(pr.state ?? "").toUpperCase();
  const author = (pr.author as { login?: string } | undefined)?.login ?? null;
  const sha = String(pr.headRefOid ?? "");
  // Changed paths are metadata like lease globs (D2): the live team context needs them (D48).
  const files = Array.isArray(pr.files)
    ? (pr.files as Array<{ path?: string }>).map((f) => String(f.path ?? "")).filter(Boolean).slice(0, 50)
    : [];
  const base = {
    number: n, url: pr.url, branch: pr.headRefName, author, loom: String(pr.headRefName ?? "").startsWith("loom/"),
    ...(files.length ? { files } : {}),
  };
  const out: GhFeed[] = [{ repo, type: "pr_opened", meta: base, dedupeKey: ghKey.opened(repo, n) }];
  if (state === "MERGED") out.push({ repo, type: "pr_merged", meta: base, dedupeKey: ghKey.merged(repo, n) });
  if (state === "CLOSED") out.push({ repo, type: "pr_closed", meta: base, dedupeKey: ghKey.closed(repo, n) });
  const checks = Array.isArray(pr.statusCheckRollup) ? (pr.statusCheckRollup as Array<Record<string, unknown>>) : [];
  const failed = checks.filter((c) => FAILED.test(String(c.conclusion ?? c.state ?? "")));
  const done = checks.length > 0 && checks.every((c) => String(c.status ?? "COMPLETED").toUpperCase() === "COMPLETED" || c.state);
  if (failed.length) {
    // one event per failing check, as a check_run webhook reports it
    for (const name of [...new Set(failed.map((c) => String(c.name ?? c.context ?? "check")))].sort()) {
      out.push({ repo, type: "check_failed", meta: { ...base, checks: [name], ...(sha ? { sha } : {}) }, dedupeKey: ghKey.failed(repo, n, sha, name) });
    }
  } else if (done && checks.every((c) => PASSED.test(String(c.conclusion ?? c.state ?? "")))) {
    out.push({ repo, type: "check_passed", meta: { ...base, ...(sha ? { sha } : {}) }, dedupeKey: ghKey.passed(repo, n, sha) });
  }
  return out;
}

// ── webhooks ──

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === "object" ? (v as Obj) : {});

/** The PR fields a webhook's pull_request object shares with a polled row. */
function prMeta(repo: string, pr: Obj): Record<string, unknown> {
  const head = obj(pr.head);
  const branch = String(head.ref ?? "");
  return {
    number: Number(pr.number),
    url: String(pr.html_url ?? `https://github.com/${repo}/pull/${Number(pr.number)}`),
    branch,
    author: (obj(pr.user).login as string | undefined) ?? null,
    loom: branch.startsWith("loom/"),
  };
}

/** A check's PRs: check_run/check_suite carry {number, head:{ref, sha}} for same-repo PRs. */
function checkPrs(repo: string, list: unknown): Array<Record<string, unknown>> {
  return (Array.isArray(list) ? list : []).map((p) => {
    const head = obj(obj(p).head);
    const branch = String(head.ref ?? "");
    const n = Number(obj(p).number);
    return { number: n, url: `https://github.com/${repo}/pull/${n}`, branch, loom: branch.startsWith("loom/") };
  }).filter((m) => Number.isInteger(m.number) && (m.number as number) > 0);
}

/**
 * One webhook delivery as feed events. `event` is the X-GitHub-Event header;
 * `repoFilter` (normalized owner/name) drops deliveries for repos the team
 * doesn't share. Unknown events and actions map to nothing.
 */
export function githubWebhookFeed(event: string, payload: unknown, repoFilter?: string[]): GhFeed[] {
  const p = obj(payload);
  const repo = ghRepo(obj(p.repository).full_name);
  if (!repo) return [];
  if (repoFilter && !repoFilter.includes(repo)) return [];
  const action = String(p.action ?? "");
  const out: GhFeed[] = [];

  if (event === "pull_request") {
    const pr = obj(p.pull_request);
    const n = Number(pr.number);
    if (!Number.isInteger(n) || n <= 0) return [];
    const meta = prMeta(repo, pr);
    if (action === "opened" || action === "reopened" || action === "ready_for_review") {
      out.push({ repo, type: "pr_opened", meta, dedupeKey: ghKey.opened(repo, n) });
    } else if (action === "closed") {
      if (pr.merged === true) out.push({ repo, type: "pr_merged", meta, dedupeKey: ghKey.merged(repo, n) });
      else out.push({ repo, type: "pr_closed", meta, dedupeKey: ghKey.closed(repo, n) });
    }
    return out;
  }

  if (event === "check_run" && action === "completed") {
    const run = obj(p.check_run);
    const conclusion = String(run.conclusion ?? "");
    const sha = String(run.head_sha ?? "");
    const name = String(run.name ?? "check");
    // failures one check at a time; passing is judged per suite (check_suite)
    if (!FAILED.test(conclusion)) return [];
    for (const m of checkPrs(repo, run.pull_requests)) {
      const n = m.number as number;
      out.push({ repo, type: "check_failed", meta: { ...m, checks: [name], sha }, dedupeKey: ghKey.failed(repo, n, sha, name) });
    }
    return out;
  }

  if (event === "check_suite" && action === "completed") {
    const suite = obj(p.check_suite);
    const conclusion = String(suite.conclusion ?? "");
    const sha = String(suite.head_sha ?? "");
    if (!PASSED.test(conclusion)) return []; // its failing runs arrive as check_run events
    for (const m of checkPrs(repo, suite.pull_requests)) {
      out.push({ repo, type: "check_passed", meta: { ...m, sha }, dedupeKey: ghKey.passed(repo, m.number as number, sha) });
    }
    return out;
  }

  if (event === "pull_request_review" && action === "submitted") {
    const pr = obj(p.pull_request);
    const review = obj(p.review);
    const n = Number(pr.number);
    if (!Number.isInteger(n) || n <= 0) return [];
    out.push({
      repo,
      type: "review_submitted",
      meta: { ...prMeta(repo, pr), by: (obj(review.user).login as string | undefined) ?? null, review: String(review.state ?? "").toLowerCase() },
      dedupeKey: ghKey.review(repo, n, String(review.id ?? "")),
    });
    return out;
  }

  if (event === "deployment_status") {
    const st = obj(p.deployment_status);
    const d = obj(p.deployment);
    const id = Number(d.id);
    const state = String(st.state ?? "");
    const type = deployEventType(state);
    if (!type || !Number.isFinite(id)) return [];
    out.push({
      repo,
      type,
      meta: {
        id,
        environment: String(d.environment ?? st.environment ?? ""),
        sha: String(d.sha ?? ""),
        ref: String(d.ref ?? ""),
        state,
        url: (st.log_url as string) || (st.environment_url as string) || (st.target_url as string) || null,
        creator: (obj(d.creator).login as string | undefined) ?? null,
      },
      dedupeKey: ghKey.deploy(repo, id, type),
    });
    return out;
  }
  return out;
}

// ── signatures: X-Hub-Signature-256 = "sha256=" + hex(HMAC-SHA256(secret, raw body)) ──

function bytes(body: Uint8Array | string): Uint8Array {
  return typeof body === "string" ? new TextEncoder().encode(body) : body;
}

function hex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** The header value GitHub sends for this body. */
export async function signGithubBody(secret: string, body: Uint8Array | string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const data = bytes(body);
  return `sha256=${hex(await crypto.subtle.sign("HMAC", key, data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer))}`;
}

/** Constant-time: the comparison touches every character whatever matches. */
function sameText(a: string, b: string): boolean {
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}

/** Is `header` the signature of exactly this raw body under the secret? Missing or malformed is false. */
export async function verifyGithubSignature(secret: string, body: Uint8Array | string, header: string | null | undefined): Promise<boolean> {
  if (!secret || !header || !/^sha256=[0-9a-f]{64}$/i.test(header.trim())) return false;
  return sameText(await signGithubBody(secret, body), header.trim().toLowerCase());
}
