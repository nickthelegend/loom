/**
 * The workspace surfaces the desktop UI is built on, over real HTTP + WS:
 * the Explorer (list / read / find) and the terminal (a long-lived shell per
 * tab). The Explorer tests double as the sandbox contract — these endpoints
 * hand file contents to any paired client, so escaping the project directory
 * must stay impossible.
 */

import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { readDaemonConfig } from "../src/core/registry.js";
import { DaemonClient } from "../src/daemon/client.js";
import { LoomDaemon } from "../src/daemon/server.js";
import { makeProjectDir, tmpDir, waitUntil } from "./helpers.js";

let daemon: LoomDaemon;
let client: DaemonClient;
let projectId: string;
let projectDir: string;
let baseUrl: string;
let adminToken: string;

/** Frames the daemon pushes for terminal output, in arrival order. */
interface TermFrame {
  type: string;
  term?: string;
  chunk?: string;
  exit?: number;
  cwd?: string;
  closed?: boolean;
}
let termFrames: TermFrame[] = [];
let ws: WebSocket;

const get = (p: string) =>
  fetch(`${baseUrl}${p}`, { headers: { authorization: `Bearer ${adminToken}` } });
const post = (p: string, body: unknown) =>
  fetch(`${baseUrl}${p}`, {
    method: "POST",
    headers: { authorization: `Bearer ${adminToken}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });

beforeAll(async () => {
  process.env.LOOM_HOME = tmpDir("home");
  process.env.LOOM_NO_NOTIFY = "1";
  daemon = new LoomDaemon({ host: "127.0.0.1", port: 0 });
  const { host, port } = await daemon.listen();
  baseUrl = `http://${host}:${port}`;
  const cfg = readDaemonConfig()!;
  adminToken = cfg.adminToken;
  client = new DaemonClient(cfg);

  projectDir = makeProjectDir({ name: "workspace" });
  fs.mkdirSync(path.join(projectDir, "src", "checkout"), { recursive: true });
  fs.mkdirSync(path.join(projectDir, "node_modules", "left-pad"), { recursive: true });
  fs.writeFileSync(path.join(projectDir, "README.md"), "# workspace\n");
  fs.writeFileSync(path.join(projectDir, "src", "checkout", "promo.ts"), "export const promo = 1\n");
  // a name that also exists under node_modules, to prove find() skips it
  fs.writeFileSync(path.join(projectDir, "node_modules", "left-pad", "promo.ts"), "junk\n");
  projectId = (await client.addProject(projectDir)).project.id;

  ws = new WebSocket(`ws://${host}:${port}/ws?token=${adminToken}&project=${projectId}`);
  ws.on("message", (d) => {
    try {
      const frame = JSON.parse(String(d)) as TermFrame;
      if (frame.type === "term") termFrames.push(frame);
    } catch {
      /* ignore non-JSON */
    }
  });
  ws.on("error", () => {});
  await new Promise<void>((r) => ws.once("open", () => r()));
});

afterAll(async () => {
  ws?.close();
  await daemon.close();
});

/** Run one command in a terminal and resolve once its exit frame lands. */
async function runTerm(term: string, cmd: string): Promise<{ out: string; exit: number; cwd: string }> {
  const before = termFrames.length;
  await post(`/api/projects/${projectId}/term/input`, { term, data: cmd });
  await waitUntil(() => termFrames.slice(before).some((f) => f.exit !== undefined));
  const mine = termFrames.slice(before).filter((f) => f.term === term);
  const done = mine.find((f) => f.exit !== undefined)!;
  return {
    out: mine.filter((f) => f.chunk).map((f) => f.chunk).join(""),
    exit: done.exit!,
    cwd: done.cwd ?? "",
  };
}

describe("explorer: listing", () => {
  it("lists the project root, directories first, and never .git", async () => {
    fs.mkdirSync(path.join(projectDir, ".git"), { recursive: true });
    const { entries } = (await get(`/api/projects/${projectId}/files?dir=.`).then((r) => r.json())) as {
      entries: { name: string; path: string; dir: boolean }[];
    };
    const names = entries.map((e) => e.name);
    expect(names).toContain("src");
    expect(names).toContain("README.md");
    expect(names).not.toContain(".git");
    // every directory sorts ahead of every file
    const lastDir = entries.map((e) => e.dir).lastIndexOf(true);
    const firstFile = entries.map((e) => e.dir).indexOf(false);
    if (lastDir !== -1 && firstFile !== -1) expect(lastDir).toBeLessThan(firstFile);
  });

  it("lists a subdirectory with project-relative paths", async () => {
    const { entries } = (await get(
      `/api/projects/${projectId}/files?dir=${encodeURIComponent("src/checkout")}`,
    ).then((r) => r.json())) as { entries: { name: string; path: string }[] };
    expect(entries.map((e) => e.name)).toEqual(["promo.ts"]);
    expect(entries[0]!.path).toBe(path.join("src", "checkout", "promo.ts"));
  });
});

describe("explorer: reading", () => {
  it("reads a file inside the project", async () => {
    const body = (await get(
      `/api/projects/${projectId}/file?path=${encodeURIComponent("src/checkout/promo.ts")}`,
    ).then((r) => r.json())) as { content: string; truncated: boolean };
    expect(body.content).toContain("export const promo");
    expect(body.truncated).toBe(false);
  });

  it("refuses to read a directory", async () => {
    const res = await get(`/api/projects/${projectId}/file?path=src`);
    expect(res.status).toBe(400);
  });
});

describe("explorer: find", () => {
  it("matches by filename and skips dependency directories", async () => {
    const { matches } = (await get(`/api/projects/${projectId}/find?q=promo`).then((r) =>
      r.json(),
    )) as { matches: string[] };
    expect(matches).toContain(path.join("src", "checkout", "promo.ts"));
    expect(matches.some((m) => m.includes("node_modules"))).toBe(false);
  });

  it("returns nothing for an empty query", async () => {
    const { matches } = (await get(`/api/projects/${projectId}/find?q=`).then((r) => r.json())) as {
      matches: string[];
    };
    expect(matches).toEqual([]);
  });
});

// The sandbox is the whole security story for these endpoints: they run as the
// daemon and will hand back whatever they can reach.
describe("explorer: sandbox", () => {
  const escapes = [
    "../../../../etc/passwd",
    "..",
    "../",
    "src/../../..",
    "/etc/passwd",
  ];

  it.each(escapes)("refuses to read outside the project: %s", async (attempt) => {
    const res = await get(`/api/projects/${projectId}/file?path=${encodeURIComponent(attempt)}`);
    expect(res.ok).toBe(false);
    const body = await res.text();
    expect(body).not.toContain("root:");
  });

  it.each(escapes)("refuses to list outside the project: %s", async (attempt) => {
    const res = await get(`/api/projects/${projectId}/files?dir=${encodeURIComponent(attempt)}`);
    expect(res.ok).toBe(false);
  });

  it("refuses to follow a symlink that points outside the project", async () => {
    const secret = path.join(tmpDir("outside"), "secret.txt");
    fs.writeFileSync(secret, "TOP SECRET\n");
    const link = path.join(projectDir, "escape.txt");
    try {
      fs.symlinkSync(secret, link);
    } catch {
      return; // no symlink permission on this platform — nothing to assert
    }
    const res = await get(`/api/projects/${projectId}/file?path=escape.txt`);
    const body = await res.text();
    expect(body).not.toContain("TOP SECRET");
    expect(res.ok).toBe(false);
  });

  it("404s for an unknown project", async () => {
    const res = await get(`/api/projects/does-not-exist/files?dir=.`);
    expect(res.status).toBe(404);
  });

  it("requires authentication", async () => {
    const res = await fetch(`${baseUrl}/api/projects/${projectId}/files?dir=.`);
    expect(res.status).toBe(401);
  });
});

describe("terminal", () => {
  it("opens a shell rooted in the project directory", async () => {
    const body = (await post(`/api/projects/${projectId}/term/open`, { term: "t1" }).then((r) =>
      r.json(),
    )) as { cwd: string; term: string };
    expect(body.term).toBe("t1");
    expect(fs.realpathSync(body.cwd)).toBe(fs.realpathSync(projectDir));
  });

  it("runs a command, streams its output, and reports the exit code", async () => {
    const { out, exit } = await runTerm("t1", "echo hello-loom");
    expect(out).toContain("hello-loom");
    expect(exit).toBe(0);
  });

  it("reports a non-zero exit code", async () => {
    // a subshell — a bare `exit` would take the session's shell down with it
    const { exit } = await runTerm("t1", "(exit 3)");
    expect(exit).toBe(3);
  });

  it("never leaks the end-of-command sentinel into the output", async () => {
    const { out } = await runTerm("t1", "echo marker-check");
    expect(out).not.toContain("__LOOM_END__");
  });

  it("keeps cd across commands — it is one shell, not one per command", async () => {
    const first = await runTerm("t1", "cd src/checkout");
    expect(fs.realpathSync(first.cwd)).toBe(fs.realpathSync(path.join(projectDir, "src", "checkout")));
    // a separate command later still sees the new directory
    const second = await runTerm("t1", "pwd");
    expect(second.out).toContain(path.join("src", "checkout"));
    expect(fs.realpathSync(second.cwd)).toBe(
      fs.realpathSync(path.join(projectDir, "src", "checkout")),
    );
  });

  it("keeps shell variables across commands", async () => {
    await runTerm("t1", "LOOM_TEST_VAR=woven");
    const { out } = await runTerm("t1", "echo $LOOM_TEST_VAR");
    expect(out).toContain("woven");
  });

  it("isolates terminals from each other", async () => {
    await post(`/api/projects/${projectId}/term/open`, { term: "t2" });
    // quoted: unquoted brackets are a glob, and zsh aborts a script on no-match
    const { out } = await runTerm("t2", 'echo "[$LOOM_TEST_VAR]"');
    expect(out).toContain("[]"); // t1's variable is not visible here
  });

  it("interrupts a running command without killing the shell", async () => {
    const before = termFrames.length;
    await post(`/api/projects/${projectId}/term/input`, { term: "t2", data: "sleep 30" });
    await new Promise((r) => setTimeout(r, 300));
    await post(`/api/projects/${projectId}/term/signal`, { term: "t2" });
    await waitUntil(() => termFrames.slice(before).some((f) => f.exit !== undefined));
    const exited = termFrames.slice(before).find((f) => f.exit !== undefined)!;
    expect(exited.exit).toBe(130); // 128 + SIGINT
    expect(termFrames.slice(before).some((f) => f.closed)).toBe(false);
    // and the shell still works
    const { out } = await runTerm("t2", "echo alive");
    expect(out).toContain("alive");
  });

  it("closes a session on request", async () => {
    await post(`/api/projects/${projectId}/term/close`, { term: "t2" });
    await waitUntil(() => termFrames.some((f) => f.term === "t2" && f.closed));
  });
});
