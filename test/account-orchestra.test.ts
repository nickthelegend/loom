import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { expect, it } from "vitest";
import { addAccount } from "../src/core/accounts.js";
import { OrchestraEngine, type OrchestraHost } from "../src/core/orchestra.js";
import { EchoAdapter } from "../src/adapters/echo.js";
import type { AgentConfig, LoomEvent } from "../src/types.js";
import { makeProjectDir, tmpDir, waitUntil } from "./helpers.js";

it("records fleet accounts in events and saved workerDetails and gives each echo worker its selection", async () => {
  process.env.LOOM_HOME = tmpDir("account-orchestra");
  const accounts = ["personal", "work"].map(label => addAccount({ kind: "codex", label }));
  const dir = makeProjectDir();
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });
  git("init", "-q", "-b", "main");
  fs.writeFileSync(path.join(dir, ".gitignore"), ".loom/\n");
  git("add", "-A"); git("-c", "user.name=test", "-c", "user.email=test@test", "commit", "-qm", "seed");
  const configs: AgentConfig[] = [];
  const events: LoomEvent[] = [];
  let chats = 0;
  const host: OrchestraHost = {
    projectId: "account-fleet", projectName: "account-fleet", projectDir: dir,
    roster: () => [{ id: "conductor", kind: "echo", role: "orchestrator" }], installedKinds: () => ["codex"],
    makeAgent: (cfg, cwd) => { configs.push(structuredClone(cfg)); return new EchoAdapter(cfg.id, "echo", cwd); },
    append: e => { const event = { ...e, id: events.length + 1, ts: Date.now() }; events.push(event); return event; },
    createChat: title => ({ id: `chat-${++chats}`, title, createdAt: Date.now() }),
    briefingFor: () => "", gate: () => {}, observe: () => {},
  };
  const engine = new OrchestraEngine(host);
  const run = await engine.start({ goal: "compare two accounts", orchestrator: "conductor", workers: ["codexx2"], race: true });
  try {
    await waitUntil(() => engine.get(run.id)?.status === "completed");
    const expected = accounts.map((a, i) => ({ id: i ? "codex#2" : "codex", kind: "codex", account: a.id, configDir: a.configDir }));
    expect(run.workerDetails).toEqual(expected);
    expect(events.find(e => e.payload.phase === "started")?.payload.workerDetails).toEqual(expected);
    expect(configs.filter(c => c.kind === "codex").map(c => c.account)).toEqual(accounts.map(a => a.id));
    expect(configs.filter(c => c.kind === "codex").map(c => c.options?.configDir)).toEqual(accounts.map(a => a.configDir));
    expect(new OrchestraEngine(host).get(run.id)?.workerDetails).toEqual(expected);
  } finally { await engine.abort(run.id); }
});
