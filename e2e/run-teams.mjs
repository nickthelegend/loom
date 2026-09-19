/**
 * Area L: Loom Teams live — the real hosted hub (Supabase), two member daemons
 * (alice, bob) plus alice's runner, real agents on cheap models, and the
 * private GitHub sandbox nickthelegend/loom-e2e-sandbox for every PR, check,
 * review, merge and deploy. Members are throwaway hosted users (GitHub OAuth
 * itself is L1); everything they do goes through the product's REST API.
 * Deletes its hosted users and teams at the end. Run: node e2e/run-teams.mjs [--only=L2,L3]
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Blocked, Daemon, Recorder, check, expect, git, ROOT, sleep, until } from "./lib.mjs";

const only = (process.argv.find((a) => a.startsWith("--only=")) ?? "").slice(7).split(",").filter(Boolean);
const want = (id) => !only.length || only.includes(id);
const rec = new Recorder(path.join(ROOT, "e2e/results/teams.json"));
const env = Object.fromEntries(
  fs.readFileSync(path.join(ROOT, ".env"), "utf8").split("\n").filter((l) => l.includes("=")).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
);
const SANDBOX = "nickthelegend/loom-e2e-sandbox";
const gh = (...args) => execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const { createClient } = await import("@supabase/supabase-js");
const admin = createClient(env.SUPABASE_URL, env.SUPABASE_SECRET_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
const anon = () => createClient(env.SUPABASE_URL, env.SUPABASE_PUBLISHABLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
const HUB = env.SUPABASE_URL; // the hosted hub, as `loom team signin` resolves it

// ── throwaway hosted members ──
const tag = Math.random().toString(36).slice(2, 7);
const users = [];
async function member(name) {
  const login = `loomtest-${tag}-${name}`;
  const email = `${login}@example.com`;
  const password = `Pw-${Math.random().toString(36).slice(2)}-${Date.now()}`;
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { user_name: login } });
  if (error) throw error;
  users.push(data.user.id);
  const session = async () => (await anon().auth.signInWithPassword({ email, password })).data.session.refresh_token;
  return { login, id: data.user.id, session };
}

function clone(name) {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), `loom-e2e-${name}-`)), "sandbox");
  execFileSync("gh", ["repo", "clone", SANDBOX, dir, "--", "-q"], { stdio: "ignore" });
  git(dir, "config", "user.name", name);
  git(dir, "config", "user.email", `${name}@loom-e2e.local`);
  return dir;
}

async function setupMember(d, dir) {
  await d.start();
  const pid = (await d.post("/api/projects", { dir })).body.project.id;
  const P = `/api/projects/${pid}`;
  await d.post(`${P}/agents/claude-code/model`, { model: "haiku" });
  await d.patch(`${P}/config`, { git: { delivery: "pr" } });
  return { pid, P };
}

const alice = await member("alice");
const bob = await member("bob");
const A = new Daemon("alice");
const B = new Daemon("bob");
const aDir = clone("alice");
const bDir = clone("bob");
const a = await setupMember(A, aDir);
const b = await setupMember(B, bDir);
let teamId = "";
const openPrs = [];

async function teamOf(d) {
  return (await d.get("/api/team")).body.teams?.[0];
}

try {
  // sign in, create, invite, join (the product's own REST)
  await check(rec, "L2", async () => {
    const s = await A.post("/api/team/signin", { hub: HUB, token: await alice.session() });
    expect(s.status === 200 && s.body.team.signedIn, `alice signed in, got ${s.status} ${s.text.slice(0, 200)}`);
    const c = await A.post("/api/team/create", { name: `e2e-${tag}` });
    expect(c.status === 200, `create, got ${c.text.slice(0, 200)}`);
    teamId = c.body.result.id;
    const inv = await A.post("/api/team/invite", {});
    expect(inv.status === 200 && inv.body.result.link, `invite, got ${inv.text.slice(0, 200)}`);
    const sb = await B.post("/api/team/signin", { hub: HUB, token: await bob.session() });
    expect(sb.status === 200, `bob signed in, got ${sb.status} ${sb.text.slice(0, 200)}`);
    const j = await B.post("/api/team/join", { link: inv.body.result.link });
    expect(j.status === 200, `bob joined, got ${j.status} ${j.text.slice(0, 200)}`);
    const members = async (d) => (await teamOf(d))?.members?.map((m) => m.github).sort().join(",");
    const want2 = [alice.login, bob.login].sort().join(",");
    await until(async () => (await members(A)) === want2 && (await members(B)) === want2, { timeoutMs: 30_000, what: "both see both" });
    return `team ${teamId} on the hosted hub; members ${want2} seen by both`;
  });

  await check(rec, "L3", async () => {
    const sh = await A.post(`${a.P}/team/share`, {});
    expect(sh.status === 200 && sh.body.repo === SANDBOX, `shared ${SANDBOX}, got ${sh.text}`);
    // bob's clone matches the team repo by its remote (D8): no explicit share needed
    await A.post(`${a.P}/messages`, { text: "Count from 1 to 60, one number per line, slowly. Do not use tools.", agentId: "claude-code" });
    await sleep(2500);
    await A.post("/api/team/beat", {});
    const seen = await until(async () => {
      const t = await teamOf(B);
      return (t?.presence ?? []).find((p) => p.github === alice.login && p.repo === SANDBOX) ?? null;
    }, { timeoutMs: 30_000, what: "bob sees alice's session" });
    await A.post(`${a.P}/interrupt`, {});
    return `bob sees ${seen.github}'s ${seen.agent} on ${seen.repo} (${seen.state}), intent ${JSON.stringify(seen.intent).slice(0, 80)}`;
  });

  let goalRun = "";
  await check(rec, "L4", async () => {
    const r = await A.post(`${a.P}/orchestra`, {
      // The sandbox keeps what earlier runs landed, so each run asks for its
      // own function: repeating a goal that is already on main produces no
      // commits, and a PR with no commits is a fixture bug, not a finding.
      goal: `Add a function sub_${tag}(a, b) returning a - b to src/math.js (keep every existing function as it is), and a test for it in test/math.test.js. One task for the opencode worker, touching src/math.js and test/math.test.js.`,
      orchestrator: "claude-code",
      workers: ["opencode"],
      maxRounds: 6,
    });
    expect(r.status === 200, `start, got ${r.status} ${r.text.slice(0, 200)}`);
    goalRun = r.body.run.id;
    const ev = await until(async () => {
      const t = await teamOf(B);
      return (t?.feed ?? []).find((e) => e.type === "goal_started" && e.meta?.runId === goalRun) ?? null;
    }, { timeoutMs: 60_000, what: "goal_started in bob's feed" });
    expect(String(ev.content?.goal ?? "").includes(`sub_${tag}`), `bob decrypts the goal title, got ${JSON.stringify(ev.content)}`);
    return `bob's feed: goal_started ${goalRun} by ${ev.github}, decrypted "${String(ev.content.goal).slice(0, 60)}"`;
  });

  let pr = 0;
  await check(rec, "L7a", async () => {
    // the goal completes and is delivered as a real PR on the sandbox
    const run = await until(async () => {
      const x = (await A.get(`${a.P}/orchestra/${goalRun}`)).body.run;
      return ["completed", "failed", "waiting_human", "aborted"].includes(x.status) && (x.status !== "completed" || x.delivered || x.deliveryError) ? x : null;
    }, { timeoutMs: 900_000, every: 5000, what: "goal completed + delivered" });
    expect(run.status === "completed" && run.delivered?.prUrl, `completed and delivered as a PR, got ${run.status} ${run.deliveryError ?? run.error ?? ""}`);
    pr = Number(run.delivered.prUrl.split("/").pop());
    openPrs.push(pr);
    const view = JSON.parse(gh("pr", "view", String(pr), "-R", SANDBOX, "--json", "state,headRefName,files"));
    expect(view.state === "OPEN" && view.files.some((f) => f.path === "src/math.js"), `real PR with src/math.js, got ${JSON.stringify(view).slice(0, 200)}`);
    return `real PR #${pr} (${view.headRefName}) with ${view.files.map((f) => f.path).join(", ")} · $${run.costUsd.toFixed(3)}`;
  });

  await check(rec, "L7b", async () => {
    expect(pr, "needs L7a");
    // real CI on the sandbox, then landing sees it; the cross-vendor review posts its status
    // on the commit it reviewed (a high finding sends the goal back, so the head may move on)
    await until(async () => {
      const checks = JSON.parse(gh("pr", "checks", String(pr), "-R", SANDBOX, "--json", "name,bucket") || "[]");
      return checks.length && checks.every((c) => c.bucket === "pass") ? checks : null;
    }, { timeoutMs: 600_000, every: 10_000, what: "sandbox CI green" });
    const reviewed = await until(async () => {
      await A.post(`${a.P}/team/landing/poll`, {});
      const g = (await A.get(`${a.P}/team/landing`)).body.goals.find((x) => x.runId === goalRun);
      return g?.landing?.review ? g : null;
    }, { timeoutMs: 600_000, every: 15_000, what: "the review" });
    const st = JSON.parse(gh("api", `repos/${SANDBOX}/commits/${reviewed.landing.reviewedSha}/status`));
    const loomReview = (st.statuses ?? []).find((s) => s.context === "loom/review");
    expect(loomReview, `loom/review status on the head commit, got ${JSON.stringify(st.statuses?.map((s) => s.context))}`);
    const reviews = JSON.parse(gh("api", `repos/${SANDBOX}/pulls/${pr}/reviews`));
    expect(reviews.some((r) => r.state === "COMMENTED" && /Loom review/.test(r.body)), `a COMMENT review, got ${reviews.map((r) => r.state)}`);
    expect(!reviews.some((r) => r.state === "APPROVED"), "never approves");
    return `CI green; ${reviewed.landing.review.reviewer} reviewed (${reviewed.landing.review.state}, ${reviewed.landing.review.findings} findings); loom/review=${loomReview.state}; a COMMENT review, no approval`;
  });

  await check(rec, "L9a", async () => {
    // a tag before the merge, for release notes
    try {
      gh("api", `repos/${SANDBOX}/git/refs`, "-f", `ref=refs/tags/e2e-${tag}`, "-f", `sha=${gh("api", `repos/${SANDBOX}/commits/main`, "-q", ".sha")}`);
    } catch (e) {
      throw new Error(`couldn't tag: ${e.stderr ?? e}`);
    }
    return `tagged main as e2e-${tag}`;
  });

  await check(rec, "L7c", async () => {
    expect(pr, "needs L7a");
    const g = (await A.get(`${a.P}/team/landing`)).body.goals.find((x) => x.runId === goalRun);
    if (g.landing.review?.state === "failure") {
      await A.post(`${a.P}/team/landing/override`, { runId: goalRun, reason: "e2e: tiny change, reviewed by hand" });
    }
    const l = await A.post(`${a.P}/team/landing/land`, { runId: goalRun });
    expect(l.status === 200, `land 200, got ${l.status} ${l.text.slice(0, 200)}`);
    await until(async () => {
      await A.post(`${a.P}/team/landing/poll`, {});
      return JSON.parse(gh("pr", "view", String(pr), "-R", SANDBOX, "--json", "state")).state === "MERGED";
    }, { timeoutMs: 900_000, every: 15_000, what: "PR merged on GitHub" });
    const main = gh("api", `repos/${SANDBOX}/contents/src/math.js?ref=main`, "-q", ".content");
    expect(Buffer.from(main, "base64").toString().includes(`sub_${tag}`), `main has sub_${tag}()`);
    const final = (await A.get(`${a.P}/team/landing`)).body.goals.find((x) => x.runId === goalRun);
    return `landed via ${final.landing.train ? "the landing train (no merge queue)" : "auto-merge"}; PR #${pr} MERGED on GitHub; main has sub_${tag}(); landing=${final.landing.state}`;
  });

  await check(rec, "L9b", async () => {
    // the merge to main runs the sandbox's deploy workflow → a real `staging` deployment
    const dep = await until(async () => {
      const r = (await A.get(`${a.P}/team/deploys`)).body.deployments ?? [];
      return r.find((x) => x.state === "success") ?? null;
    }, { timeoutMs: 600_000, every: 15_000, what: "a successful staging deployment" });
    const notes = await A.get(`${a.P}/team/release-notes?since=e2e-${tag}`);
    expect(notes.status === 200 && notes.body.markdown.includes(`#${pr}`), `release notes list #${pr}, got ${notes.text.slice(0, 300)}`);
    return `deployment ${dep.id} to ${dep.environment}: ${dep.state}; release notes since e2e-${tag} list #${pr}`;
  });

  await check(rec, "L8", async () => {
    const d = await A.get(`${a.P}/team/doctor`);
    expect(d.status === 200, `doctor 200, got ${d.status} ${d.text.slice(0, 200)}`);
    const txt = JSON.stringify(d.body.findings);
    expect(/no merge queue/.test(txt), `reports no merge queue, got ${txt.slice(0, 300)}`);
    expect(d.body.fixable.includes(".github/workflows/ci.yml"), `ci.yml fixable, got ${d.body.fixable}`);
    const f = await A.post(`${a.P}/team/doctor/fix`, {});
    expect(f.status === 200 && f.body.prUrl, `fix PR, got ${f.text.slice(0, 300)}`);
    const n = Number(f.body.prUrl.split("/").pop());
    openPrs.push(n);
    const diff = gh("pr", "diff", String(n), "-R", SANDBOX);
    expect(/\+\s*merge_group:/.test(diff), `adds merge_group, got ${diff.slice(0, 300)}`);
    return `findings: ${d.body.findings.map((x) => x.level).join(",")}; fix PR #${n} adds merge_group to ci.yml`;
  });

  await check(rec, "L6", async () => {
    const mem = await A.post(`${a.P}/brain`, { kind: "convention", text: `Sandbox functions live in src/math.js (${tag}).` });
    expect(mem.status === 200, `memory added, got ${mem.status}`);
    await A.post(`${a.P}/team/brain/sync`, {});
    const got = await until(async () => {
      await B.post(`${b.P}/team/brain/sync`, {});
      const v = (await B.get(`${b.P}/team/brain`)).body;
      return (v.memories ?? []).find((m) => m.text.includes(tag)) ?? null;
    }, { timeoutMs: 60_000, every: 3000, what: "bob sees alice's memory" });
    expect(got.tier === "proposed" && got.author === alice.login, `proposed by alice, got ${JSON.stringify(got)}`);
    const pro = await B.post(`${b.P}/team/brain/promote`, { ids: [got.id] });
    expect(pro.status === 200 && pro.body.result.prUrl, `canon PR, got ${pro.text.slice(0, 300)}`);
    const n = Number(pro.body.result.prUrl.split("/").pop());
    openPrs.push(n);
    const agents = gh("api", `repos/${SANDBOX}/contents/AGENTS.md?ref=loom/canon`, "-q", ".content");
    expect(Buffer.from(agents, "base64").toString().includes(tag), "AGENTS.md on loom/canon has it");
    return `bob sees "${got.text.slice(0, 50)}" proposed by ${got.author}; promoted → canon PR #${n} (AGENTS.md on loom/canon)`;
  });

  await check(rec, "L10", async () => {
    const R = new Daemon("runner");
    fs.mkdirSync(R.home, { recursive: true });
    fs.writeFileSync(path.join(R.home, "runner.json"), JSON.stringify({ enabled: false, shared: false, capacity: 1, isolation: "inline", kinds: ["claude-code", "opencode"] }));
    fs.writeFileSync(path.join(R.home, "runner-token"), gh("auth", "token") + "\n", { mode: 0o600 });
    await R.start();
    try {
      const pair = await A.post("/api/runner/pair", {});
      expect(pair.status === 200 && pair.body.result.link, `pair link, got ${pair.status}`);
      const j = await R.post("/api/runner/join", { link: pair.body.result.link, token: await alice.session() });
      expect(j.status === 200, `runner joined, got ${j.status} ${j.text.slice(0, 300)}`);
      const runners = (await A.get(`${a.P}/team/runners`)).body.runners;
      expect(runners.some((r) => r.mine), `alice sees her runner, got ${JSON.stringify(runners).slice(0, 200)}`);
      const s = await A.post(`${a.P}/team/runners/start`, { goal: "Add a one-line comment '// loom runner was here' at the top of api/index.js. One task for the opencode worker, touching only api/index.js." });
      expect(s.status === 200, `start on runner, got ${s.status} ${s.text.slice(0, 200)}`);
      const job = await until(async () => {
        const v = (await A.get(`${a.P}/team/runners`)).body.jobs.find((x) => x.id === s.body.result.jobId);
        return v?.progress?.landing?.pr ? v : v?.state === "failed" ? v : null;
      }, { timeoutMs: 900_000, every: 10_000, what: "the runner's goal delivered a PR" });
      expect(job.state !== "failed", `runner job didn't fail: ${job.error}`);
      openPrs.push(job.progress.landing.pr);
      const view = JSON.parse(gh("pr", "view", String(job.progress.landing.pr), "-R", SANDBOX, "--json", "files,state"));
      expect(view.files.some((f) => f.path === "api/index.js"), "the runner's PR changes api/index.js");
      return `runner ${runners.find((r) => r.mine).label} ran the goal in a fresh clone: PR #${job.progress.landing.pr} (${view.state}), status ${job.progress.status}`;
    } finally {
      await R.stop();
    }
  });
} finally {
  for (const n of openPrs) {
    try {
      if (JSON.parse(gh("pr", "view", String(n), "-R", SANDBOX, "--json", "state")).state === "OPEN") gh("pr", "close", String(n), "-R", SANDBOX, "--delete-branch");
    } catch { /* already gone */ }
  }
  // A merged PR's branch and this run's tag outlive the PRs: the sandbox is a
  // fixture, and the next run should find it as this one did.
  try {
    for (const b of JSON.parse(gh("api", `repos/${SANDBOX}/branches`, "--paginate")).map((x) => x.name)) {
      if (/^loom\//.test(b)) gh("api", "-X", "DELETE", `repos/${SANDBOX}/git/refs/heads/${b}`);
    }
    gh("api", "-X", "DELETE", `repos/${SANDBOX}/git/refs/tags/e2e-${tag}`);
  } catch { /* nothing to clean */ }
  await A.stop();
  await B.stop();
  // clean the hosted project: the e2e team and users
  if (teamId) await admin.from("teams").delete().eq("id", teamId);
  for (const id of users) await admin.auth.admin.deleteUser(id);
  const left = await admin.from("profiles").select("github").like("github", `loomtest-${tag}%`);
  console.log(`cleanup: ${left.data?.length ?? "?"} test profiles left`);
}
