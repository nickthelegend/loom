/**
 * Every agent × every permission mode, against the real CLIs.
 *
 *   node scripts/verify-permissions.mjs [kind,kind…]
 *
 * core/permissions.ts maps Loom's three words (bypass / auto / ask) onto each
 * CLI's own flags. Flags read off --help are claims; this checks the deed. Each
 * cell asks the agent to write a file and records whether it did:
 *
 *   bypass → must write      auto → should write (agent-dependent)
 *   ask    → read-only agents must NOT write; Claude needs a daemon to ask
 *            (see test/approvals.test.ts), so here it runs without one and
 *            must degrade to plan — also no write.
 *
 * Costs a few cents per cell. Needs `npm run build` (runs from dist/).
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.env.LOOM_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "loom-vp-home-"));
const { createAgent } = await import(`${ROOT}/dist/adapters/index.js`);
const { PERMISSION_MODES, PERMISSION_PROFILES } = await import(`${ROOT}/dist/core/permissions.js`);

const kinds = (process.argv[2] ?? "claude-code,codex,antigravity-cli,grok-code,opencode").split(",");
const OPTS = { opencode: { model: "opencode/big-pickle" } };

async function cell(kind, mode) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `loom-vp-${kind}-${mode}-`));
  execFileSync("git", ["init", "-q", "."], { cwd: dir });
  fs.mkdirSync(path.join(dir, ".loom"));
  const agent = createAgent({ id: kind, kind, role: "x", options: { ...(OPTS[kind] ?? {}), permissions: mode } }, dir);
  const t0 = Date.now();
  const kinds = new Set();
  agent.onEvent((e) => kinds.add(e.kind));
  try {
    if (!(await agent.available())) return { kind, mode, result: "not installed" };
    await agent.start();
    await Promise.race([
      agent.send({ text: "Create a file named proof.txt containing exactly the word: works. Do it now, then stop." }),
      new Promise((_, rej) => setTimeout(() => rej(new Error("timeout 240s")), 240_000)),
    ]);
    const wrote = fs.existsSync(path.join(dir, "proof.txt"));
    return { kind, mode, result: wrote ? "WROTE" : "no write", secs: ((Date.now() - t0) / 1000).toFixed(0), events: [...kinds].join(",") };
  } catch (err) {
    return { kind, mode, result: "ERROR", detail: String(err.message).slice(0, 120) };
  } finally {
    await agent.stop().catch(() => {});
  }
}

const expected = { bypass: "WROTE", auto: "WROTE", ask: "no write" };
// Cells marked unsupported fall back to the kind's default mode; skip them.
const supported = (kind, mode) => !PERMISSION_PROFILES[kind]?.modes[mode]?.unsupported;
const results = await Promise.all(
  kinds.map(async (kind) => {
    const rows = [];
    for (const mode of PERMISSION_MODES) {
      if (supported(kind, mode)) rows.push(await cell(kind, mode));
      else rows.push({ kind, mode, result: "n/a", detail: PERMISSION_PROFILES[kind].modes[mode].unsupported });
    }
    return rows;
  }),
);
console.log("\n  agent            mode     result     expected   secs");
for (const r of results.flat()) {
  const ok = r.result === expected[r.mode] || r.result === "n/a";
  console.log(
    `  ${ok ? "✓" : "✗"} ${r.kind.padEnd(16)} ${r.mode.padEnd(8)} ${String(r.result).padEnd(10)} ${expected[r.mode].padEnd(10)} ${r.secs ?? ""} ${r.detail ?? ""}`,
  );
}
console.log("");
