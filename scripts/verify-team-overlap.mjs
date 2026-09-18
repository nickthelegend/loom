/**
 * Loom Teams Phase 2 against a REAL orchestrator model.
 *
 *   node scripts/verify-team-overlap.mjs [--orchestrator claude-code]
 *
 * The suite drives overlap holds with a scripted orchestrator. This checks the
 * part only a real model can: told that its task overlaps a teammate's lease,
 * does it answer with a valid `overlap` decision (wait / narrow / proceed) and
 * carry on? A teammate (alice) holds src/auth/** on a real `loom hub`; bob's
 * real orchestrator plans a goal that needs src/auth. Workers are echo (free).
 * Costs a few cents. Needs `npm run build`.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const orchestrator = process.argv.includes("--orchestrator") ? process.argv[process.argv.indexOf("--orchestrator") + 1] : "claude-code";
process.env.LOOM_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "loom-vto-home-"));
process.env.LOOM_NO_NOTIFY = "1";
const { ProjectRuntime } = await import(`${ROOT}/dist/daemon/runtime.js`);
const { writeProjectConfig } = await import(`${ROOT}/dist/core/registry.js`);
const { TeamLink } = await import(`${ROOT}/dist/daemon/team.js`);
const { startHubServer } = await import(`${ROOT}/dist/hub/server.js`);
const { scopeOf } = await import(`${ROOT}/dist/core/team-leases.js`);

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), `loom-vto-${p}-`));
const git = (dir, ...a) => execFileSync("git", a, { cwd: dir, encoding: "utf8" });

const seed = tmp("seed");
git(seed, "init", "-q", "-b", "main");
fs.mkdirSync(path.join(seed, "src/auth"), { recursive: true });
fs.writeFileSync(path.join(seed, "src/auth/session.ts"), "export const ttl = 3600;\n");
fs.writeFileSync(path.join(seed, "src/auth/login.ts"), "export function login() {}\n");
fs.writeFileSync(path.join(seed, ".gitignore"), ".loom/\n");
git(seed, "add", "-A");
git(seed, "-c", "user.name=s", "-c", "user.email=s@s", "commit", "-qm", "seed");
const origin = tmp("origin");
git(origin, "init", "-q", "--bare", "-b", "main");
git(seed, "push", "-q", origin, "main");

const hub = await startHubServer({ port: 0, secret: "v" });
const dir = tmp("bob");
git(path.dirname(dir), "clone", "-q", origin, dir);
git(dir, "config", "loom.repo", "acme/app");
writeProjectConfig(dir, {
  name: "app",
  agents: [
    { id: orchestrator, kind: orchestrator, role: "orchestrator" },
    { id: "worker", kind: "echo", role: "worker" },
  ],
  brain: { extractor: "off" },
});
const rt = await ProjectRuntime.open({ id: "vto", name: "app", dir });
const bob = new TeamLink({ runtimes: () => [rt], broadcast: () => {}, statePath: path.join(tmp("state"), "team.json") });
bob.attachRuntime(rt);

// alice: owner, shares the repo, and holds src/auth/** for her running goal
const alice = hub.hub.client(hub.hub.signIn("alice").token);
const team = await alice.createTeam("Acme");
await alice.shareRepo(team.id, "acme/app");
const aliceDev = await alice.registerDevice({ label: "a", sealPub: "s", signPub: "p" });
await alice.claimLease(team.id, {
  deviceId: aliceDev.id, repo: "acme/app", runId: "o-alice", taskId: "t1", hardZones: [],
  ...scopeOf(["src/auth/**"], ["src/auth/session.ts", "src/auth/login.ts"]),
});
const { invite } = await alice.createInvite(team.id);
const { packInvite, newTeamKey } = await import(`${ROOT}/dist/core/team-crypto.js`);
await bob.join(`loom://team/join#${packInvite({ invite, key: newTeamKey(1), hub: hub.url })}`, { github: "bob", secret: "v" });

console.log(`\n  real ${orchestrator} orchestrating on a team repo where alice holds src/auth/**\n`);
const t0 = Date.now();
const run = await rt.orchestra.start({
  goal: "Change the session TTL in src/auth/session.ts from 3600 to 7200 seconds. One small task for the worker.",
  orchestrator,
  workers: ["worker"],
  maxRounds: 5,
});
let sawHold = null;
let last = "";
while (Date.now() - t0 < 8 * 60_000) {
  const r = rt.orchestra.get(run.id);
  for (const t of r.tasks) if (t.hold?.kind === "decide" && !sawHold) sawHold = t.hold.reason;
  const line = `${r.status} ` + r.tasks.map((t) => `${t.id}:${t.status}${t.hold ? `(${t.hold.kind})` : ""}${t.overlap ? `[${t.overlap.slice(0, 40)}]` : ""}`).join(" ");
  if (line !== last) console.log(`  ${((Date.now() - t0) / 1000).toFixed(0).padStart(4)}s  ${line}`);
  last = line;
  if (["completed", "failed", "aborted", "waiting_human"].includes(r.status)) break;
  if (r.tasks.some((t) => t.overlap)) {
    // it answered; give the answered task a moment to be admitted, then stop
    await new Promise((res) => setTimeout(res, 4000));
    break;
  }
  await new Promise((res) => setTimeout(res, 1500));
}
const r = rt.orchestra.get(run.id);
const answered = r.tasks.find((t) => t.overlap);
console.log(`\n  hold shown to the model: ${sawHold ? sawHold.slice(0, 160) : "none"}`);
console.log(`  model's decision:        ${answered ? answered.overlap : "none"}`);
const valid = answered && /^(wait:\S+|narrow|proceed:.+)$/.test(answered.overlap);
const feed = await alice.feed(team.id);
if (answered?.overlap.startsWith("proceed:")) {
  console.log(`  on the team feed:        ${feed.some((e) => e.type === "overlap_decided") ? "overlap_decided ✓" : "missing"}`);
}
console.log(`\n  ${sawHold && valid ? "✓ A REAL ORCHESTRATOR HANDLES OVERLAPS" : "✗ did not get a valid overlap decision"} · ${((Date.now() - t0) / 1000).toFixed(0)}s\n`);
if (!["completed", "failed", "aborted"].includes(r.status)) await rt.orchestra.abort(run.id);
await bob.stop();
await rt.close();
await hub.close();
process.exitCode = sawHold && valid ? 0 : 1;
