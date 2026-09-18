/**
 * An orchestra run against the real agent CLIs.
 *
 *   node scripts/verify-orchestra.mjs [--orchestrator claude-code] [--workers codex,antigravity-cli]
 *
 * The suite drives orchestra with a scripted orchestrator and echo workers —
 * every git step is real, the models are not. This is the other half: a real
 * orchestrator plans a small goal into tasks, real workers build them in
 * parallel worktrees, and the result is checked on disk, on the integration
 * branch, the way a user would check it.
 *
 * Costs a few cents per agent. Needs `npm run build` first (runs from dist/).
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : dflt;
};
const orchestrator = arg("orchestrator", "claude-code");
const workers = arg("workers", "codex,antigravity-cli").split(",").filter(Boolean);
const plan = process.argv.includes("--plan");

process.env.LOOM_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "loom-vo-home-"));
process.env.LOOM_NO_NOTIFY = "1";
const { ProjectRuntime } = await import(`${ROOT}/dist/daemon/runtime.js`);
const { writeProjectConfig } = await import(`${ROOT}/dist/core/registry.js`);

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-vo-"));
const git = (...a) => execFileSync("git", a, { cwd: dir, encoding: "utf8" });
git("init", "-q", "-b", "main");
git("config", "user.email", "t@t");
git("config", "user.name", "t");
fs.writeFileSync(path.join(dir, ".gitignore"), ".loom/\nnode_modules/\n");
fs.writeFileSync(
  path.join(dir, "package.json"),
  JSON.stringify({ name: "calc", type: "module", scripts: { test: "node --test" } }, null, 2),
);
fs.writeFileSync(path.join(dir, "README.md"), "# calc\nA tiny calculator library.\n");
git("add", "-A");
git("commit", "-qm", "seed");

const kinds = [...new Set([orchestrator, ...workers])];
const OC_MODEL = { opencode: { model: "opencode/big-pickle" } };
writeProjectConfig(dir, {
  name: "calc",
  agents: kinds.map((k) => ({ id: k, kind: k, role: k, ...(OC_MODEL[k] ? { options: OC_MODEL[k] } : {}) })),
  brain: { extractor: "off" },
});
const rt = await ProjectRuntime.open({ id: "verify-orch", name: "calc", dir });

const goal =
  "Build a tiny ES-module calculator library in this repo: src/add.js exporting add(a,b), " +
  "src/multiply.js exporting multiply(a,b), and src/index.js re-exporting both. Each module " +
  "gets a node:test test file under test/ (test/add.test.js, test/multiply.test.js). " +
  "Split this across the workers so they build in parallel; keep it minimal.";

console.log(`\n  orchestra · orchestrator=${orchestrator} · workers=${workers.join(",")}\n  repo ${dir}\n`);
const t0 = Date.now();
const run = await rt.orchestra.start({ goal, orchestrator, workers, maxRounds: 6, plan });
let last = "";
while (true) {
  const r = rt.orchestra.get(run.id);
  const line = `${r.status} · ` + r.tasks.map((t) => `${t.id}[${t.agent}]=${t.status}`).join(" ");
  if (line !== last) {
    console.log(`  ${((Date.now() - t0) / 1000).toFixed(0).padStart(4)}s  ${line}`);
    last = line;
  }
  if (["completed", "failed", "aborted", "waiting_human"].includes(r.status)) break;
  if (Date.now() - t0 > 20 * 60_000) {
    await rt.orchestra.abort(run.id, "verify timeout");
    break;
  }
  await new Promise((res) => setTimeout(res, 1000));
}
const r = rt.orchestra.get(run.id);
console.log(`\n  status: ${r.status}${r.error ? ` — ${r.error}` : ""}${r.question ? ` — asks: ${r.question}` : ""}`);
if (r.summary) console.log(`  summary: ${r.summary.slice(0, 400)}`);
const agentsUsed = [...new Set(r.tasks.map((t) => t.agent))];
console.log(`  tasks: ${r.tasks.length} across ${agentsUsed.join(", ")}`);
const overlap = r.tasks.some((a) => r.tasks.some((b) => a !== b && a.startedAt < b.finishedAt && b.startedAt < a.finishedAt));
console.log(`  ran in parallel: ${overlap ? "yes" : "no"}`);

let ok = r.status === "completed";
if (ok) {
  await rt.orchestra.apply(run.id);
  const need = ["src/add.js", "src/multiply.js", "src/index.js"];
  const missing = need.filter((f) => !fs.existsSync(path.join(dir, f)));
  console.log(`  files after apply: ${missing.length ? "MISSING " + missing.join(", ") : "all present"}`);
  try {
    const out = execFileSync("node", ["--test"], { cwd: dir, encoding: "utf8", stdio: "pipe" });
    const pass = out.match(/(?:#|ℹ) pass (\d+)/)?.[1];
    console.log(`  node --test: PASS (${pass} tests)`);
  } catch (e) {
    ok = false;
    console.log(`  node --test: FAIL\n${String(e.stdout ?? e.message).slice(-800)}`);
  }
  ok = ok && missing.length === 0;
  if (plan) {
    const pdir = path.join(dir, "plans", run.id);
    const files = fs.existsSync(pdir) ? fs.readdirSync(pdir) : [];
    const index = files.includes("PLAN.md") ? fs.readFileSync(path.join(pdir, "PLAN.md"), "utf8") : "";
    const specsOk = r.tasks.every((t) => files.includes(`${t.id}.md`));
    console.log(`  plan files: ${files.join(", ") || "NONE"}${index.includes("loom-plan: 1") ? "" : " (PLAN.md missing front matter)"}`);
    if (files.length) console.log(`  ${path.join(pdir, files.find((f) => f !== "PLAN.md") ?? "PLAN.md")}`);
    ok = ok && specsOk && index.includes("loom-plan: 1");
  }
}
console.log(`\n  ${ok ? "✓ ORCHESTRA WORKS" : "✗ orchestra did not deliver"} · ${((Date.now() - t0) / 1000).toFixed(0)}s · $${r.costUsd.toFixed(3)}\n`);
await rt.close();
process.exitCode = ok ? 0 : 1;
