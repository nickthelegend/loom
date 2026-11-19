import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { LoomDaemon } from "../src/daemon/server.js";
import { DaemonClient } from "../src/daemon/client.js";
import { readDaemonConfig } from "../src/core/registry.js";
import { makeProjectDir, tmpDir } from "./helpers.js";

const root = process.cwd();
let daemon: LoomDaemon, client: DaemonClient, dir: string, id: string;
const cli = (args: string[]) => new Promise<{ out: string; code: number }>(resolve => {
  execFile(process.execPath, [path.join(root, "node_modules/tsx/dist/cli.mjs"), path.join(root, "src/cli/index.ts"), ...args], { cwd: dir, timeout: 20_000, env: { ...process.env, NO_COLOR: "1" } }, (error, out, err) => resolve({ out: out + err, code: error ? 1 : 0 }));
});
beforeAll(async () => {
  process.env.LOOM_HOME = tmpDir("r3-cli"); process.env.LOOM_NO_NOTIFY = "1";
  daemon = new LoomDaemon({ host: "127.0.0.1", port: 0 }); await daemon.listen(); client = new DaemonClient(readDaemonConfig()!);
  dir = makeProjectDir(); id = (await client.addProject(dir)).project.id;
});
afterAll(async () => { await daemon.close(); });
it("creates command webhooks, previews templates and exports calendar subscriptions through the CLI", async () => {
  const created = await cli(["triggers:add", "{{body.comment.body}}", "--webhook", "--github-command"]);
  expect(created.code).toBe(0); expect((await client.triggers(id)).triggers[0]!.githubCommand).toBe(true);
  const payload = path.join(dir, "sample.json"); fs.writeFileSync(payload, JSON.stringify({ title: "CLI fixture" }));
  const preview = await cli(["triggers:preview", "{{body.title}} {{event}}", "--payload", payload, "--event", "issue"]);
  expect(preview.code).toBe(0); expect(preview.out).toContain("CLI fixture issue");
  await client.addTrigger(id, { prompt: "check", kind: "schedule", every: "1h" });
  const calendar = await cli(["triggers:calendar"]); expect(calendar.code).toBe(0); expect(calendar.out).toContain("BEGIN:VEVENT");
  const sub = await cli(["triggers:calendar", "--subscribe"]); expect(sub.code).toBe(0); expect(sub.out).toContain("/api/webhooks/calendar/");
  const jira = await cli(["intake", "--jira", "--github"]); expect(jira.code).toBe(1); expect(jira.out).toContain("choose --github, --linear or --jira");
});
it("reads SMTP settings from a file without printing the password and previews the digest", async () => {
  const file = path.join(dir, "smtp.json"); fs.writeFileSync(file, JSON.stringify({ enabled: false, host: "smtp.example.com", password: "cli-secret" }));
  const saved = await cli(["email", "--settings", file]); expect(saved.code).toBe(0); expect(saved.out).toContain('"hasPassword":true'); expect(saved.out).not.toContain("cli-secret");
  const preview = await cli(["email", "--preview"]); expect(preview.code).toBe(0); expect(preview.out).toContain("Loom digest");
  const bridgeHelp = await cli(["bridge", "--help"]); expect(bridgeHelp.out).toContain("--orchestra-channel");
});
