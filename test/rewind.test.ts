/**
 * Rewind, end to end through a real daemon (#101).
 *
 * checkpoint.test.ts proves what git does to a directory. This proves the
 * other half: that a turn leaves a checkpoint behind without being asked,
 * that the routes hand it back, and — the one that would hurt — that a rewind
 * is refused while an agent is still typing into the tree it would replace.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { readDaemonConfig } from "../src/core/registry.js";
import { DaemonClient } from "../src/daemon/client.js";
import { LoomDaemon } from "../src/daemon/server.js";
import { makeProjectDir, tmpDir, waitUntil } from "./helpers.js";

const git = (dir: string, ...args: string[]): string => execFileSync("git", args, { cwd: dir, encoding: "utf8" });

let daemon: LoomDaemon;
let client: DaemonClient;
let baseUrl: string;
let token: string;
let projectId: string;
let dir: string;

interface Checkpoint {
  id: string;
  label: string;
  commit: string;
  at: number;
}

async function api<T = unknown>(method: string, p: string, body?: unknown): Promise<T> {
  const r = await fetch(`${baseUrl}/api/projects/${projectId}${p}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const j = (await r.json()) as T & { error?: string };
  if (!r.ok) throw new Error(j.error ?? `${r.status}`);
  return j;
}

const read = (rel: string): string | null => {
  try {
    return fs.readFileSync(path.join(dir, rel), "utf8");
  } catch {
    return null;
  }
};

beforeAll(async () => {
  process.env.LOOM_HOME = tmpDir("home");
  process.env.LOOM_NO_NOTIFY = "1";
  daemon = new LoomDaemon({ host: "127.0.0.1", port: 0 });
  await daemon.listen();
  const cfg = readDaemonConfig()!;
  baseUrl = `http://${cfg.host}:${cfg.port}`;
  token = cfg.adminToken;
  client = new DaemonClient(cfg);

  // A real repository, so checkpoints mean something.
  dir = makeProjectDir({ name: "rewind" });
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "t@t");
  git(dir, "config", "user.name", "t");
  fs.writeFileSync(path.join(dir, ".gitignore"), ".loom/\n.env\n");
  fs.writeFileSync(path.join(dir, "app.ts"), "export const port = 3000;\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "seed");
  fs.writeFileSync(path.join(dir, ".env"), "SECRET=hunter2\n");

  projectId = (await client.addProject(dir)).project.id;
}, 60_000);

afterAll(async () => {
  await daemon.close();
});

describe("a turn leaves a way back", () => {
  it("checkpoints before the agent runs, labelled with what it was asked", async () => {
    // The echo agent writes a file when told to; whatever it does, the
    // checkpoint is taken before it starts.
    await api("POST", "/messages", { text: "write:generated.ts", agentId: "execbot" });
    await waitUntil(async () => (await api<{ checkpoints: Checkpoint[] }>("GET", "/checkpoints")).checkpoints.length > 0);

    const { checkpoints } = await api<{ checkpoints: Checkpoint[] }>("GET", "/checkpoints");
    expect(checkpoints[0]!.label).toContain("write:generated.ts");
    expect(checkpoints[0]!.commit).toMatch(/^[0-9a-f]{40}$/);

    // It is announced in the thread, so the UI can offer it without polling
    // a second endpoint per turn.
    const { events } = await api<{ events: Array<{ kind: string; payload: Record<string, unknown> }> }>(
      "GET",
      "/events?limit=100",
    );
    const said = events.filter((e) => e.kind === "checkpoint");
    expect(said.length).toBeGreaterThan(0);
    expect(said[0]!.payload.reason).toBe("before_turn");
    expect(said[0]!.payload.id).toBe(checkpoints[0]!.id);
  }, 60_000);

  /** A checkpoint is not a branch and not a commit anyone will trip over. */
  it("keeps them out of the way of ordinary git", async () => {
    expect(git(dir, "branch", "--list")).not.toContain("checkpoint");
    expect(git(dir, "stash", "list").trim()).toBe("");
    expect(git(dir, "log", "--oneline").trim().split("\n")).toHaveLength(1); // just "seed"
    expect(git(dir, "rev-parse", "--abbrev-ref", "HEAD").trim()).toBe("main");
  });
});

describe("rewinding through the daemon", () => {
  it("puts the files back and hands you the way to undo the undo", async () => {
    const { checkpoints: before } = await api<{ checkpoints: Checkpoint[] }>("GET", "/checkpoints");
    const target = before.at(-1)!; // the oldest we have: the original tree

    fs.writeFileSync(path.join(dir, "app.ts"), "export const port = 9999;\n");
    fs.writeFileSync(path.join(dir, "scribble.ts"), "not wanted\n");

    const out = await api<{ restored: Checkpoint; undo: Checkpoint; changed: string[] }>(
      "POST",
      `/checkpoints/${target.id}/rewind`,
    );

    expect(read("app.ts")).toBe("export const port = 3000;\n");
    expect(read("scribble.ts")).toBeNull();
    expect(out.restored.id).toBe(target.id);
    expect(out.changed).toContain("scribble.ts");

    // The rewind is itself a checkpoint you can go back to.
    expect(out.undo.id).not.toBe(target.id);
    await api("POST", `/checkpoints/${out.undo.id}/rewind`);
    expect(read("scribble.ts")).toBe("not wanted\n");
    expect(read("app.ts")).toBe("export const port = 9999;\n");
  }, 60_000);

  it("never touches an ignored file, so .env survives every rewind", async () => {
    fs.writeFileSync(path.join(dir, ".env"), "SECRET=rotated\n");
    const { checkpoints } = await api<{ checkpoints: Checkpoint[] }>("GET", "/checkpoints");
    await api("POST", `/checkpoints/${checkpoints.at(-1)!.id}/rewind`);
    expect(read(".env")).toBe("SECRET=rotated\n");
  }, 60_000);

  it("says what it means when the id isn't one", async () => {
    await expect(api("POST", "/checkpoints/cnope/rewind")).rejects.toThrow(/no checkpoint/);
    await expect(api("POST", "/checkpoints/..%2F..%2Fetc/rewind")).rejects.toThrow();
  });

  /**
   * The dangerous one. An agent mid-turn has read the tree it is writing
   * into; replacing that tree underneath it puts the damage in whatever it
   * writes next, where nobody will connect it to the rewind.
   */
  it("refuses while an agent is mid-turn, and names who", async () => {
    const { checkpoints } = await api<{ checkpoints: Checkpoint[] }>("GET", "/checkpoints");
    const rt = daemon.runtimes.get(projectId)!;
    // Stand an agent up as busy the way a real turn does.
    (rt as unknown as { busySince: Map<string, number> }).busySince.set("execbot", Date.now());
    try {
      await expect(api("POST", `/checkpoints/${checkpoints[0]!.id}/rewind`)).rejects.toThrow(/execbot.*mid-turn/);
    } finally {
      (rt as unknown as { busySince: Map<string, number> }).busySince.delete("execbot");
    }
    // …and having refused, it changed nothing.
    expect(read("app.ts")).toBeTruthy();
  }, 60_000);
});
