/** Live Windows acceptance: actual installed Codex and OpenCode, with native
 * continuity on. Sends real prompts; use the test suite for free protocol fakes.
 * Run `npm run build` first, then `node scripts/verify-windows-native.mjs`.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

if (process.platform !== "win32") throw new Error("This acceptance script requires native Windows");
const modelArg = process.argv.indexOf("--opencode-model");
const opencodeModel = modelArg < 0 ? "opencode/big-pickle" : process.argv[modelArg + 1];
assert(opencodeModel, "--opencode-model requires provider/model");
process.env.LOOM_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "loom-native-home-"));
for (const key of ["LOOM_NO_NOTIFY", "LOOM_NO_PUSH", "LOOM_TELEMETRY_DISABLED", "LOOM_TRIAGE_NO_LLM", "LOOM_DECISIONS_NO_CLI"]) process.env[key] = "1";
const { ProjectRuntime } = await import("../dist/daemon/runtime.js");
const { writeProjectConfig } = await import("../dist/core/registry.js");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-windows-native-"));
const git = (...args) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });
git("init", "-q", "-b", "main");
git("config", "user.name", "Loom Windows acceptance");
git("config", "user.email", "test@example.invalid");
fs.writeFileSync(path.join(dir, ".gitignore"), ".loom/\n");
fs.writeFileSync(path.join(dir, "README.md"), "# Native continuity acceptance\n");
git("add", "-A"); git("commit", "-qm", "seed");
writeProjectConfig(dir, { name: "Windows native continuity", brain: { continuity: true, extractor: "off" },
  agents: [{ id: "codex", kind: "codex" }, { id: "opencode", kind: "opencode", options: { model: opencodeModel, permissions: "bypass" } }] });
const info = { id: path.basename(dir), name: "Windows native continuity", dir };
let runtime;
const bindings = new Map(), chats = new Map();

async function send(agent, text, requestId) {
  const health = await runtime.harnesses.ensure(agent);
  assert(health.available, `${agent}: ${health.error}`);
  console.log(`${agent}: version ${health.version}`);
  await runtime.sendMessage(text, agent, { chat: chats.get(agent), requestId });
  const deadline = performance.now() + 240_000;
  let receipt;
  while (performance.now() < deadline) {
    receipt = runtime.continuity.store.receipts(requestId).at(-1);
    if (receipt && ["complete", "failed", "unknown", "interrupted"].includes(receipt.execution)) break;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  assert.equal(receipt?.status, "accepted", JSON.stringify(receipt));
  assert.equal(receipt?.execution, "complete", JSON.stringify(receipt));
  const binding = runtime.continuity.store.bindingById(receipt.bindingId);
  assert(binding.nativeSessionId, "native session ID must be persisted");
  console.log(`${agent}: ${requestId} accepted, complete, session=${binding.nativeSessionId}`);
  return { receipt, binding };
}

try {
  console.log(`Project: ${dir}`);
  runtime = await ProjectRuntime.open(info);
  for (const agent of ["codex", "opencode"]) {
    chats.set(agent, runtime.createChat(`${agent} native`).id);
    const result = await send(agent, `Create ${agent}.txt containing exactly first. Make no other changes.`, `${agent}-first`);
    assert.equal(fs.readFileSync(path.join(dir, `${agent}.txt`), "utf8").trim(), "first");
    bindings.set(agent, result.binding);
  }
  await runtime.close(); runtime = null;
  console.log("Daemon stopped; reopening the same project and bindings.");
  runtime = await ProjectRuntime.open(info);
  for (const agent of ["codex", "opencode"]) {
    const result = await send(agent, `Append a second line containing exactly second to ${agent}.txt. Preserve the first line. Make no other changes.`, `${agent}-second`);
    assert.equal(result.binding.nativeSessionId, bindings.get(agent).nativeSessionId, "restart must resume the same native session");
    assert.equal(result.binding.id, bindings.get(agent).id, "restart must preserve the binding");
    const packet = runtime.continuity.store.packet(result.receipt.packetId);
    assert.equal(packet?.packet.mode, "delta", "resumed session must receive delta context");
    assert.deepEqual(fs.readFileSync(path.join(dir, `${agent}.txt`), "utf8").trim().split(/\r?\n/), ["first", "second"]);
  }
  assert.equal(runtime.continuity.store.activeReceipts().length, 0);
  console.log("PASS: Windows native Codex + OpenCode, acceptance, file writes, clean shutdown, restart, same-session resume and delta context.");
} finally { await runtime?.close(); }
