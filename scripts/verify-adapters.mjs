/**
 * Every adapter Loom claims, given a real task, against the real tool.
 *
 *   node scripts/verify-adapters.mjs
 *
 * This is the check the test suite can't be. The suite drives fake CLIs — fast,
 * free, deterministic, and completely unable to tell you that your `claude`
 * isn't logged in or your opencode token is rejected. Those are the failures
 * that actually stop you working, and they only exist on a real machine.
 *
 * Adapters are asked to write a file, because a file on disk is a fact. A
 * transcript saying "I created it" is a claim. Bridges are asked a question and
 * must answer, since they can't write under Loom's lock by design.
 *
 * Costs a few cents in tokens per adapter. Run it when something feels wrong,
 * or after installing a new agent.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { fileURLToPath } from "node:url";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { createAgent } = await import(`${ROOT}/dist/adapters/index.js`);
const { isAdapter } = await import(`${ROOT}/dist/types.js`);

function scratchRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-verify-"));
  execFileSync("git", ["init", "-q", "."], { cwd: dir });
  fs.mkdirSync(path.join(dir, ".loom"), { recursive: true });
  return dir;
}

const ADAPTERS = [
  { id: "claude-code", kind: "claude-code" },
  { id: "codex", kind: "codex" },
  { id: "opencode", kind: "opencode", options: { model: process.env.LOOM_OC_MODEL || "opencode/north-mini-code-free" } },
  { id: "grok-code", kind: "grok-code" },
];
const BRIDGES = [
  { id: "antigravity", kind: "antigravity" },
  { id: "kiro", kind: "kiro" },
];

const results = [];

for (const cfg of ADAPTERS) {
  const dir = scratchRepo();
  const agent = createAgent({ ...cfg, role: "x" }, dir);
  const line = { name: cfg.kind, kind: "adapter" };
  try {
    if (!(await agent.available())) {
      line.status = "not installed";
      results.push(line);
      continue;
    }
    const t0 = Date.now();
    const seen = [];
    agent.onEvent((e) => seen.push(e.kind));
    await agent.start();
    await agent.send({ text: "create a file named proof.txt containing exactly the word: works. then stop." });
    const p = path.join(dir, "proof.txt");
    const wrote = fs.existsSync(p) ? fs.readFileSync(p, "utf8").trim() : null;
    line.status = wrote ? "WORKS" : "no file written";
    line.detail = wrote ? `proof.txt = ${JSON.stringify(wrote)} · ${((Date.now() - t0) / 1000).toFixed(1)}s` : `events: ${[...new Set(seen)].join(",")}`;
    line.events = [...new Set(seen)].join(",");
    await agent.stop();
  } catch (e) {
    line.status = "FAILED";
    line.detail = String(e.message).slice(0, 90);
  }
  fs.rmSync(dir, { recursive: true, force: true });
  results.push(line);
}

for (const cfg of BRIDGES) {
  const dir = scratchRepo();
  const agent = createAgent({ ...cfg, role: "x" }, dir);
  const line = { name: cfg.kind, kind: "bridge" };
  try {
    const drive = await agent.driver.driveable();
    if (!drive.ok) {
      line.status = "not driveable";
      line.detail = drive.reason;
      results.push(line);
      fs.rmSync(dir, { recursive: true, force: true });
      continue;
    }
    const t0 = Date.now();
    const reply = await agent.ask("reply with exactly one word: works");
    const hit = /works/i.test(reply);
    line.status = hit ? "WORKS" : "answered, but not as asked";
    line.detail = `${((Date.now() - t0) / 1000).toFixed(1)}s · ${reply.replace(/\s+/g, " ").slice(0, 60)}`;
  } catch (e) {
    line.status = "FAILED";
    line.detail = String(e.message).slice(0, 90);
  }
  fs.rmSync(dir, { recursive: true, force: true });
  results.push(line);
}

console.log("");
for (const r of results) {
  const mark = r.status === "WORKS" ? "✓" : r.status === "not installed" ? "·" : "✗";
  console.log(`  ${mark} ${r.name.padEnd(13)} ${r.kind.padEnd(8)} ${String(r.status).padEnd(16)} ${r.detail ?? ""}`);
}
const working = results.filter((r) => r.status === "WORKS").length;
console.log(`\n  ${working}/${results.length} working`);

// The ones that failed are almost always the tool's own credentials, not Loom.
// Say so, with the command that fixes each.
const FIX = {
  "claude-code": "run `claude` in a terminal and log in",
  codex: "codex login",
  opencode: "its model pin is stale — `opencode models` then set options.model in .loom/config.json",
  "grok-code": "run `grok` in a terminal and log in",
  antigravity: 'open -a "Antigravity IDE" --args --remote-debugging-port=9333, sign in, open a chat',
  kiro: 'open -a "Kiro" --args --remote-debugging-port=9334, then open its chat panel',
};
const broken = results.filter((r) => r.status !== "WORKS");
if (broken.length) {
  console.log("\n  what each one needs:");
  for (const b of broken) console.log(`    ${b.name.padEnd(13)} ${FIX[b.name] ?? ""}`);
}
process.exit(broken.length ? 1 : 0);
