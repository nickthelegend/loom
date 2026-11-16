import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LoomDaemon } from "../src/daemon/server.js";
import { DaemonClient } from "../src/daemon/client.js";
import { readDaemonConfig } from "../src/core/registry.js";
import { knownAuth, probeAuth } from "../src/core/setup.js";
import { makeProjectDir, tmpDir, waitUntil } from "./helpers.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let daemon: LoomDaemon, client: DaemonClient, base: string, token: string, dir: string, binDir: string;
const previous = { PATH: process.env.PATH, LOOM_CODEX_BIN: process.env.LOOM_CODEX_BIN };
const headers = (auth = token) => ({ authorization: `Bearer ${auth}`, "content-type": "application/json" });
const call = (route: string, method = "GET", body?: unknown, auth = token) => fetch(`${base}/api/accounts${route}`, {
  method, headers: headers(auth), ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});
function cli(args: string[], extra: NodeJS.ProcessEnv = {}): Promise<{ code: number; out: string; err: string }> {
  return new Promise(resolve => execFile(process.execPath, [path.join(root, "node_modules/tsx/dist/cli.mjs"), path.join(root, "src/cli/index.ts"), ...args],
    { cwd: dir, env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0", ...extra } }, (err, out, stderr) => resolve({ code: err ? Number(err.code) || 1 : 0, out, err: stderr })));
}
beforeEach(async () => {
  process.env.LOOM_HOME = tmpDir("accounts-api");
  process.env.LOOM_NO_NOTIFY = "1";
  binDir = tmpDir("accounts-status-bin");
  const bin = path.join(binDir, "codex");
  fs.writeFileSync(bin, `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(path.join(binDir, "calls.jsonl"))}, JSON.stringify({args, dir:process.env.CODEX_HOME})+'\\n');
if(args.join(' ') === 'login status') {
  if(process.env.CODEX_HOME.endsWith('unknown')) { console.error('status unavailable'); process.exit(2); }
  const authed = !process.env.CODEX_HOME.endsWith('signed-out');
  console.error(authed ? 'Logged in using ChatGPT' : 'Not logged in'); process.exit(authed ? 0 : 1);
}
if(args.join(' ') === 'login') { console.log('terminal login: '+process.env.CODEX_HOME); process.exit(Number(process.env.LOOM_FAKE_LOGIN_EXIT || 0)); }
if(args.join(' ') === '--version') { console.log('codex-cli 99.0.0'); process.exit(0); }
process.exit(2);
`, { mode: 0o755 });
  process.env.LOOM_CODEX_BIN = bin;
  process.env.PATH = `${binDir}${path.delimiter}${previous.PATH}`;
  daemon = new LoomDaemon({ host: "127.0.0.1", port: 0 });
  const address = await daemon.listen();
  base = `http://${address.host}:${address.port}`;
  token = readDaemonConfig()!.adminToken;
  client = new DaemonClient(readDaemonConfig()!);
  dir = makeProjectDir();
  await client.addProject(dir);
});
afterEach(async () => {
  await daemon?.close();
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});

describe("accounts API and CLI", () => {
  it("lists CLI status per home, returns a login command without launching it, and deletes only metadata", async () => {
    const { account: a } = await client.addAccount({ kind: "codex", label: "personal" });
    const { account: b } = await client.addAccount({ kind: "codex", label: "work", configDir: path.join(process.env.LOOM_HOME!, "signed-out") });
    const { account: c } = await client.addAccount({ kind: "codex", label: "unknown", configDir: path.join(process.env.LOOM_HOME!, "unknown") });
    expect((await client.accounts()).accounts).toEqual([{ ...a, authed: true }, { ...b, authed: false }, { ...c, authed: null }]);
    const login = await client.accountLogin(b.id);
    expect(login).toMatchObject({ bin: "codex", args: ["login"], env: { CODEX_HOME: b.configDir } });
    expect(login.command).toContain("codex login");
    const calls = fs.readFileSync(path.join(binDir, "calls.jsonl"), "utf8").trim().split("\n").map(s => JSON.parse(s));
    expect(calls.every(c => c.args.join(" ") === "login status")).toBe(true);
    expect(new Set(calls.map(c => c.dir))).toEqual(new Set([a.configDir, b.configDir, c.configDir]));
    expect(await client.removeAccount(b.id)).toEqual({ forgotten: true });
    expect(fs.existsSync(b.configDir)).toBe(true);
    expect((await call(`/${b.id}`, "DELETE")).status).toBe(404);
    expect((await call(`/${b.id}/login`, "POST", {})).status).toBe(404);
  });

  it("rejects bad input before writing and scopes every accounts endpoint", async () => {
    for (const body of [{}, { kind: "echo", label: "bad" }, { kind: "codex", label: " " }, { kind: "codex", label: "bad", configDir: "relative" }]) {
      expect((await call("", "POST", body)).status).toBe(400);
    }
    const { account } = await client.addAccount({ kind: "codex", label: "work" });
    const project = (await client.listProjects()).projects[0]!;
    const pair = async (projects?: string[]) => {
      const mint = await fetch(`${base}/api/pair/new`, { method: "POST", headers: headers(), body: JSON.stringify(projects ? { projects } : {}) });
      const { token: pairToken } = await mint.json() as { token: string };
      const claimed = await fetch(`${base}/api/pair/claim`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: pairToken, name: "accounts-test" }) });
      return (await claimed.json() as { clientToken: string }).clientToken;
    };
    const scoped = await pair([project.id]);
    for (const [route, method, body] of [["", "GET", undefined], ["", "POST", { kind: "codex", label: "blocked" }], [`/${account.id}`, "DELETE", undefined], [`/${account.id}/login`, "POST", {}]] as const) {
      expect((await call(route, method, body, scoped)).status).toBe(403);
      expect((await call(route, method, body, "bad-token")).status).toBe(401);
    }
    expect((await call("", "GET", undefined, await pair())).status).toBe(200);
  });

  it("adds, lists and signs in from the terminal, preserving login exit codes", async () => {
    const added = await cli(["accounts", "add", "codex", "--label", "work", "--dir", path.join(process.env.LOOM_HOME!, "space and 'quote'")]);
    expect(added.code, added.err).toBe(0);
    const listed = await cli(["accounts", "--json"]);
    expect(listed.code, listed.err).toBe(0);
    const { accounts: [a] } = JSON.parse(listed.out);
    expect(a).toMatchObject({ kind: "codex", label: "work", authed: true });
    const login = await cli(["accounts", "login", a.id]);
    expect(login.code, login.err).toBe(0);
    expect(login.out).toContain(`terminal login: ${a.configDir}`);
    expect((await cli(["accounts", "login", a.id], { LOOM_FAKE_LOGIN_EXIT: "7" })).code).toBe(7);
    const invalid = await cli(["agents:add", "echo", "--account", "work"]);
    expect(invalid.code).toBe(1);
    expect(invalid.err).toContain("account requires");
  });

  it("keeps cached auth verdicts separate for two homes of the same CLI", async () => {
    const signedIn = { CODEX_HOME: path.join(process.env.LOOM_HOME!, "signed-in") };
    const signedOut = { CODEX_HOME: path.join(process.env.LOOM_HOME!, "signed-out") };
    expect(await probeAuth("codex", signedOut)).toMatchObject({ authed: false });
    knownAuth("codex", 60_000, signedIn);
    knownAuth("codex", 60_000, signedOut);
    await waitUntil(() => knownAuth("codex", 60_000, signedIn)?.authed === true && knownAuth("codex", 60_000, signedOut)?.authed === false);
  });
});
