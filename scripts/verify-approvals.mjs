/**
 * "Always ask" against the real Claude Code CLI.
 *
 *   node scripts/verify-approvals.mjs
 *
 * A real daemon, a project whose claude-code agent is in "ask" mode, and one
 * task that needs a file write. Passes when: the write shows up as a pending
 * approval in Loom, nothing is written while it waits, and the file appears
 * only after Loom approves it. Costs a few cents. Needs `npm run build`.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.env.LOOM_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "loom-va-home-"));
process.env.LOOM_NO_NOTIFY = "1";
const { LoomDaemon } = await import(`${ROOT}/dist/daemon/server.js`);
const { readDaemonConfig, writeProjectConfig } = await import(`${ROOT}/dist/core/registry.js`);

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-va-"));
execFileSync("git", ["init", "-q", "."], { cwd: dir });
writeProjectConfig(dir, {
  name: "asky",
  agents: [{ id: "claude-code", kind: "claude-code", role: "x", options: { permissions: "ask" } }],
  brain: { extractor: "off" },
});

const daemon = new LoomDaemon({ host: "127.0.0.1", port: 0 });
const { port } = await daemon.listen();
const base = `http://127.0.0.1:${port}`;
const token = readDaemonConfig().adminToken;
const api = (p, init = {}) =>
  fetch(base + p, { ...init, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" } }).then((r) => r.json());

const { project } = await api("/api/projects", { method: "POST", body: JSON.stringify({ dir }) });
const pid = project.id;
await api(`/api/projects/${pid}/messages`, {
  method: "POST",
  body: JSON.stringify({ text: "Create a file named proof.txt containing exactly the word: works. Then stop.", agentId: "claude-code" }),
});

const proof = path.join(dir, "proof.txt");
let approval = null;
const t0 = Date.now();
while (Date.now() - t0 < 120_000 && !approval) {
  const { approvals } = await api(`/api/projects/${pid}/approvals`);
  approval = approvals[0] ?? null;
  if (!approval) await new Promise((r) => setTimeout(r, 1000));
}
let ok = false;
if (!approval) {
  console.log("  ✗ no approval request arrived within 120s");
} else {
  console.log(`  approval requested: ${approval.tool} ${JSON.stringify(approval.input).slice(0, 100)}`);
  const writtenEarly = fs.existsSync(proof);
  console.log(`  file before approval: ${writtenEarly ? "WRITTEN (bad)" : "absent (good)"}`);
  await api(`/api/projects/${pid}/approvals/${approval.id}`, { method: "POST", body: JSON.stringify({ decision: "allow" }) });
  const t1 = Date.now();
  while (Date.now() - t1 < 90_000 && !fs.existsSync(proof)) {
    // later tool uses may ask too — approve them
    const { approvals } = await api(`/api/projects/${pid}/approvals`);
    for (const a of approvals) {
      await api(`/api/projects/${pid}/approvals/${a.id}`, { method: "POST", body: JSON.stringify({ decision: "allow" }) });
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  const after = fs.existsSync(proof) ? fs.readFileSync(proof, "utf8").trim() : null;
  console.log(`  file after approval: ${after === null ? "absent" : JSON.stringify(after)}`);
  ok = !writtenEarly && after !== null;
}
console.log(`\n  ${ok ? "✓ ALWAYS-ASK WORKS" : "✗ always-ask did not behave"} · ${((Date.now() - t0) / 1000).toFixed(0)}s\n`);
await daemon.close();
process.exitCode = ok ? 0 : 1;
