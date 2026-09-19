/**
 * Phase 6 (D83, D84): GitHub facts as feed events — the webhook mapping, its
 * dedupe keys matching polling's exactly, signature checks, the Edge
 * Function's handler, and its copy of the mapping staying identical.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { githubWebhookFeed, prRowFeed, signGithubBody, verifyGithubSignature, type GhFeed } from "../src/core/github-events.js";
import { Deploys } from "../src/daemon/deploys.js";
import type { Exec } from "../src/daemon/landing.js";
import type { ProjectRuntime } from "../src/daemon/runtime.js";
import type { FeedIn } from "../src/core/team-hub.js";
import { handleWebhook } from "../supabase/functions/github-webhook/handler.js";
// @ts-expect-error — a plain .mjs script with no types
import { EDGE_COPIES, header } from "../scripts/sync-edge-shared.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPO = { full_name: "Acme/App" };
const SHA = "a".repeat(40);

const prPayload = (action: string, extra: Record<string, unknown> = {}) => ({
  action,
  repository: REPO,
  pull_request: { number: 7, html_url: "https://github.com/acme/app/pull/7", head: { ref: "loom/orchestra/o1/main", sha: SHA }, user: { login: "alice" }, ...extra },
});
const checkRun = (name: string, conclusion: string) => ({
  action: "completed",
  repository: REPO,
  check_run: { name, conclusion, head_sha: SHA, pull_requests: [{ number: 7, head: { ref: "loom/orchestra/o1/main", sha: SHA } }] },
});
const checkSuite = (conclusion: string) => ({
  action: "completed",
  repository: REPO,
  check_suite: { conclusion, head_sha: SHA, pull_requests: [{ number: 7, head: { ref: "loom/orchestra/o1/main", sha: SHA } }] },
});
const deployStatus = (state: string) => ({
  repository: REPO,
  deployment: { id: 42, environment: "production", sha: SHA, ref: "main", creator: { login: "bob" } },
  deployment_status: { state, log_url: "https://github.com/acme/app/actions/runs/1" },
});
const row = (over: Record<string, unknown>) => ({
  number: 7, state: "OPEN", headRefName: "loom/orchestra/o1/main", headRefOid: SHA, url: "https://github.com/acme/app/pull/7", author: { login: "alice" }, ...over,
});

describe("webhook deliveries as feed events (D83)", () => {
  it("maps pull_request opened / merged / closed, keyed to the repo, lower-cased", () => {
    expect(githubWebhookFeed("pull_request", prPayload("opened")).map((e) => [e.type, e.repo, e.meta.branch, e.meta.loom])).toEqual([
      ["pr_opened", "acme/app", "loom/orchestra/o1/main", true],
    ]);
    expect(githubWebhookFeed("pull_request", prPayload("reopened"))[0]!.type).toBe("pr_opened");
    expect(githubWebhookFeed("pull_request", prPayload("closed", { merged: true }))[0]!.type).toBe("pr_merged");
    expect(githubWebhookFeed("pull_request", prPayload("closed", { merged: false }))[0]!.type).toBe("pr_closed");
    expect(githubWebhookFeed("pull_request", prPayload("synchronize"))).toEqual([]);
  });

  it("maps a failing check_run per check and PR, a passing check_suite per PR head; passing runs are silent", () => {
    const f = githubWebhookFeed("check_run", checkRun("test", "failure"));
    expect(f).toMatchObject([{ type: "check_failed", meta: { number: 7, checks: ["test"], sha: SHA } }]);
    expect(githubWebhookFeed("check_run", checkRun("test", "timed_out"))[0]!.type).toBe("check_failed");
    expect(githubWebhookFeed("check_run", checkRun("test", "success"))).toEqual([]);
    expect(githubWebhookFeed("check_suite", checkSuite("success"))).toMatchObject([{ type: "check_passed", meta: { number: 7, sha: SHA } }]);
    expect(githubWebhookFeed("check_suite", checkSuite("failure"))).toEqual([]);
    expect(githubWebhookFeed("check_run", { ...checkRun("x", "failure"), action: "created" })).toEqual([]);
  });

  it("maps a submitted review, and deployment statuses like the deploy poll", () => {
    const r = githubWebhookFeed("pull_request_review", { ...prPayload("submitted"), review: { id: 99, state: "APPROVED", user: { login: "carol" } } });
    expect(r).toMatchObject([{ type: "review_submitted", meta: { number: 7, by: "carol", review: "approved" }, dedupeKey: "gh:acme/app#7:review:99" }]);
    expect(githubWebhookFeed("deployment_status", deployStatus("in_progress"))[0]!.type).toBe("deploy_started");
    expect(githubWebhookFeed("deployment_status", deployStatus("success"))[0]!.type).toBe("deploy_succeeded");
    expect(githubWebhookFeed("deployment_status", deployStatus("error"))[0]).toMatchObject({ type: "deploy_failed", meta: { id: 42, environment: "production", creator: "bob" } });
    expect(githubWebhookFeed("deployment_status", deployStatus("inactive"))).toEqual([]);
  });

  it("drops repos outside the filter, unknown events, and junk", () => {
    expect(githubWebhookFeed("pull_request", prPayload("opened"), ["acme/other"])).toEqual([]);
    expect(githubWebhookFeed("pull_request", prPayload("opened"), ["acme/app"])).toHaveLength(1);
    expect(githubWebhookFeed("issues", { action: "opened", repository: REPO })).toEqual([]);
    expect(githubWebhookFeed("pull_request", null)).toEqual([]);
    expect(githubWebhookFeed("pull_request", { action: "opened", repository: { full_name: "not a repo" } })).toEqual([]);
  });
});

describe("dedupe keys: polling and webhooks name a fact the same way (D84)", () => {
  const keys = (es: GhFeed[] | FeedIn[], type: string) => es.filter((e) => e.type === type).map((e) => e.dedupeKey);

  it("PR opened, merged and closed", () => {
    expect(keys(githubWebhookFeed("pull_request", prPayload("opened")), "pr_opened")).toEqual(keys(prRowFeed("acme/app", row({})), "pr_opened"));
    expect(keys(githubWebhookFeed("pull_request", prPayload("closed", { merged: true })), "pr_merged")).toEqual(keys(prRowFeed("acme/app", row({ state: "MERGED" })), "pr_merged"));
    expect(keys(githubWebhookFeed("pull_request", prPayload("closed")), "pr_closed")).toEqual(keys(prRowFeed("acme/app", row({ state: "CLOSED" })), "pr_closed"));
  });

  it("a failing check at a commit, one event per check, and checks passing at a commit", () => {
    const polled = prRowFeed("acme/app", row({
      statusCheckRollup: [
        { name: "test", status: "COMPLETED", conclusion: "FAILURE" },
        { name: "lint", status: "COMPLETED", conclusion: "FAILURE" },
        { name: "build", status: "COMPLETED", conclusion: "SUCCESS" },
      ],
    }));
    const hooked = [...githubWebhookFeed("check_run", checkRun("test", "failure")), ...githubWebhookFeed("check_run", checkRun("lint", "failure"))];
    expect(keys(hooked, "check_failed").sort()).toEqual(keys(polled, "check_failed").sort());
    expect(keys(polled, "check_failed")).toHaveLength(2);
    const green = prRowFeed("acme/app", row({ statusCheckRollup: [{ name: "test", status: "COMPLETED", conclusion: "SUCCESS" }] }));
    expect(keys(githubWebhookFeed("check_suite", checkSuite("success")), "check_passed")).toEqual(keys(green, "check_passed"));
  });

  it("deployments: the webhook's key is the deploy poll's", async () => {
    const posted: FeedIn[] = [];
    const exec: Exec = async (_cmd, args) => {
      const p = args.find((a) => a.startsWith("repos/")) ?? "";
      if (/\/statuses/.test(p)) return { code: 0, out: JSON.stringify([{ state: "failure", log_url: "u", created_at: "2026-09-20T00:00:00Z" }]), err: "" };
      return { code: 0, out: JSON.stringify([{ id: 42, environment: "production", sha: SHA, ref: "main", creator: { login: "bob" } }]), err: "" };
    };
    const rt = { info: { dir: "/nowhere", name: "app" }, orchestra: { list: () => [] } } as unknown as ProjectRuntime;
    const d = new Deploys(rt, { share: async () => ({ teamId: "t", repo: "acme/app" }), post: async (_r, e) => void posted.push(e), exec });
    await d.poll();
    expect(posted.map((e) => e.dedupeKey)).toEqual(keys(githubWebhookFeed("deployment_status", deployStatus("failure")), "deploy_failed"));
  });
});

describe("X-Hub-Signature-256", () => {
  const body = JSON.stringify(prPayload("opened"));

  it("accepts the signature of exactly this body, and nothing else", async () => {
    const sig = await signGithubBody("s3cret", body);
    expect(sig).toMatch(/^sha256=[0-9a-f]{64}$/);
    expect(await verifyGithubSignature("s3cret", body, sig)).toBe(true);
    expect(await verifyGithubSignature("s3cret", new TextEncoder().encode(body), sig.toUpperCase().replace("SHA256=", "sha256="))).toBe(true);
    expect(await verifyGithubSignature("other", body, sig)).toBe(false); // wrong secret
    expect(await verifyGithubSignature("s3cret", body.replace("alice", "mallory"), sig)).toBe(false); // replayed signature, tampered body
    expect(await verifyGithubSignature("s3cret", body, null)).toBe(false); // missing
    expect(await verifyGithubSignature("s3cret", body, "sha1=abc")).toBe(false); // the old SHA-1 header
    expect(await verifyGithubSignature("s3cret", body, `sha256=${"0".repeat(64)}`)).toBe(false);
    expect(await verifyGithubSignature("", body, sig)).toBe(false); // no secret, no trust
  });
});

describe("the hosted receiver (supabase/functions/github-webhook)", () => {
  const TEAM = "00000000-0000-4000-8000-00000000a11c";
  const ingested: GhFeed[][] = [];
  const deps = {
    secretFor: async (t: string) => (t === TEAM ? "hooksecret" : null),
    ingest: async (_t: string, es: GhFeed[]) => {
      ingested.push(es);
      return es.length;
    },
  };
  const post = async (team: string, event: string, body: string, sig?: string | null) =>
    handleWebhook(
      new Request(`https://x.supabase.co/functions/v1/github-webhook/${team}`, {
        method: "POST",
        headers: { "x-github-event": event, ...(sig ? { "x-hub-signature-256": sig } : {}) },
        body,
      }),
      deps,
    );

  it("404s unknown teams, 401s bad or missing signatures, acks ping, and ingests the rest", async () => {
    const body = JSON.stringify(checkRun("test", "failure"));
    const sig = await signGithubBody("hooksecret", body);
    expect((await post("00000000-0000-4000-8000-000000000000", "check_run", body, sig)).status).toBe(404);
    expect((await post("not-a-uuid", "check_run", body, sig)).status).toBe(404);
    expect((await post(TEAM, "check_run", body, null)).status).toBe(401);
    expect((await post(TEAM, "check_run", body.replace("failure", "success"), sig)).status).toBe(401);
    const ping = await post(TEAM, "ping", "{}", await signGithubBody("hooksecret", "{}"));
    expect(ping.status).toBe(200);
    expect(ingested).toHaveLength(0);
    const ok = await post(TEAM, "check_run", body, sig);
    expect(ok.status).toBe(202);
    expect(await ok.json()).toEqual({ accepted: 1 });
    expect(ingested[0]).toMatchObject([{ type: "check_failed", repo: "acme/app" }]);
    const get = await handleWebhook(new Request(`https://x/functions/v1/github-webhook/${TEAM}`), deps);
    expect(get.status).toBe(405);
  });

  it("runs a byte-identical copy of the mapping", () => {
    for (const [orig, copy] of EDGE_COPIES as Array<[string, string]>) {
      const want = header(orig) + fs.readFileSync(path.join(root, orig), "utf8");
      expect(fs.readFileSync(path.join(root, copy), "utf8"), `${copy} drifted from ${orig}: run node scripts/sync-edge-shared.mjs`).toBe(want);
    }
  });
});
