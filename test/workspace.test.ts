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

/**
 * Which backend is in play. A pty is the real thing but needs node-pty to
 * have built; the pipe fallback is what a machine without it gets. Both ship,
 * so both are tested — the shared behaviour here, the divergence below.
 */
let mode: "pty" | "pipe";

/** Everything a terminal has emitted since a mark, with escapes stripped. */
function outputSince(mark: number, term: string): string {
  return termFrames
    .slice(mark)
    .filter((f) => f.term === term && f.chunk)
    .map((f) => f.chunk)
    .join("")
    // eslint-disable-next-line no-control-regex
    .replace(/\[[0-9;?]*[ -/]*[@-~]|\][^]*(?:|\\)|./g, "");
}

/**
 * Run a command and wait for it to finish, however this backend says so.
 * A pty only tells you by drawing (its prompt comes back), so we wait for the
 * output to match; pipe mode says so explicitly with an exit frame — and a
 * command like `cd` emits nothing at all there, so waiting on output would
 * hang forever.
 */
async function runTerm(term: string, cmd: string, needle: RegExp): Promise<string> {
  const before = termFrames.length;
  // a pty is a keyboard: the newline is what submits. pipe mode takes a line.
  const data = mode === "pty" ? `${cmd}\r` : cmd;
  await post(`/api/projects/${projectId}/term/input`, { term, data });
  if (mode === "pipe") {
    await waitUntil(() =>
      termFrames.slice(before).some((f) => f.term === term && f.exit !== undefined),
    );
  } else {
    await waitUntil(() => needle.test(outputSince(before, term)));
  }
  return outputSince(before, term);
}

/** pipe mode only: the exit/cwd frame the sentinel produces. */
async function runForExit(term: string, cmd: string): Promise<{ exit: number; cwd: string }> {
  const before = termFrames.length;
  await post(`/api/projects/${projectId}/term/input`, { term, data: cmd });
  await waitUntil(() => termFrames.slice(before).some((f) => f.term === term && f.exit !== undefined));
  const done = termFrames.slice(before).find((f) => f.term === term && f.exit !== undefined)!;
  return { exit: done.exit!, cwd: done.cwd ?? "" };
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

/**
 * Tasks read GitHub through the user's own `gh`, so what this can assert
 * depends on the host: gh may be absent, signed out, or present. What must
 * hold everywhere is that a project with no GitHub remote says so — an empty
 * list would render as "this repo has no issues", which is a different claim.
 */
describe("tasks", () => {
  it("reports why it can't list, rather than returning an empty list", async () => {
    const res = await get(`/api/projects/${projectId}/tasks?kind=issue`);
    expect(res.ok).toBe(true);
    const body = (await res.json()) as { available: boolean; reason?: string; detail?: string };
    // the fixture project is a bare git dir with no remote
    expect(body.available).toBe(false);
    expect(["no-cli", "no-auth", "no-remote", "error"]).toContain(body.reason);
    expect(body.detail).toBeTruthy();
  });

  it("404s for an unknown project", async () => {
    const res = await get(`/api/projects/does-not-exist/tasks`);
    expect(res.status).toBe(404);
  });

  it("requires authentication", async () => {
    const res = await fetch(`${baseUrl}/api/projects/${projectId}/tasks`);
    expect(res.status).toBe(401);
  });
});

describe("terminal", () => {
  it("opens a shell rooted in the project directory", async () => {
    const body = (await post(`/api/projects/${projectId}/term/open`, { term: "t1" }).then((r) =>
      r.json(),
    )) as { cwd: string; term: string; mode: "pty" | "pipe" };
    mode = body.mode;
    expect(body.term).toBe("t1");
    expect(["pty", "pipe"]).toContain(mode);
    expect(fs.realpathSync(body.cwd)).toBe(fs.realpathSync(projectDir));
  });

  it("runs a command and streams its output", async () => {
    const out = await runTerm("t1", "echo hello-loom", /hello-loom/);
    expect(out).toMatch(/hello-loom/);
  });

  it("keeps cd across commands — it is one shell, not one per command", async () => {
    await runTerm("t1", "cd src/checkout", /\$|%|#|>/);
    // a later, separate command still sees the new directory
    const out = await runTerm("t1", "pwd", /src\/checkout/);
    expect(out).toContain(path.join("src", "checkout"));
  });

  it("keeps shell variables across commands", async () => {
    await runTerm("t1", "LOOM_TEST_VAR=woven", /\$|%|#|>/);
    const out = await runTerm("t1", "echo \"v=$LOOM_TEST_VAR\"", /v=woven/);
    expect(out).toMatch(/v=woven/);
  });

  it("isolates terminals from each other", async () => {
    await post(`/api/projects/${projectId}/term/open`, { term: "t2" });
    // quoted: unquoted brackets are a glob, and zsh aborts a script on no-match
    const out = await runTerm("t2", 'echo "[$LOOM_TEST_VAR]"', /\[\]/);
    expect(out).toMatch(/\[\]/); // t1's variable is not visible here
  });

  it("interrupts a running command without killing the shell", async () => {
    const before = termFrames.length;
    const data = mode === "pty" ? "sleep 30\r" : "sleep 30";
    await post(`/api/projects/${projectId}/term/input`, { term: "t2", data });
    await new Promise((r) => setTimeout(r, 400));
    await post(`/api/projects/${projectId}/term/signal`, { term: "t2" });
    await new Promise((r) => setTimeout(r, 600));
    // the session must survive the interrupt in both modes
    expect(termFrames.slice(before).some((f) => f.term === "t2" && f.closed)).toBe(false);
    const out = await runTerm("t2", "echo alive", /alive/);
    expect(out).toMatch(/alive/);
  });

  it("closes a session on request", async () => {
    await post(`/api/projects/${projectId}/term/close`, { term: "t3-unused" });
    await post(`/api/projects/${projectId}/term/open`, { term: "t3" });
    await post(`/api/projects/${projectId}/term/close`, { term: "t3" });
    await waitUntil(() => termFrames.some((f) => f.term === "t3" && f.closed));
  });

  it("replays scrollback so a reload rejoins the session it left", async () => {
    await runTerm("t1", "echo rejoin-marker", /rejoin-marker/);
    const body = (await post(`/api/projects/${projectId}/term/open`, { term: "t1" }).then((r) =>
      r.json(),
    )) as { reused: boolean; scrollback: string };
    expect(body.reused).toBe(true);
    expect(body.scrollback).toContain("rejoin-marker");
  });
});

// A pty is the real thing: the shell is on a tty, so it echoes what you type
// and drives its own prompt. None of this is true of the pipe fallback.
describe.runIf(process.env.LOOM_EXPECT_PTY !== "0")("terminal · pty mode", () => {
  it("gives the shell a real tty", async () => {
    if (mode !== "pty") return; // node-pty didn't build here — fallback covers it
    const out = await runTerm("t1", "tty", /dev\/(tty|pts)/);
    expect(out).toMatch(/dev\/(tty|pts)/);
  });

  it("echoes typed input back, like a terminal", async () => {
    if (mode !== "pty") return;
    const before = termFrames.length;
    // no newline: nothing runs, but a tty still echoes the keystrokes
    await post(`/api/projects/${projectId}/term/input`, { term: "t1", data: "echo-me" });
    await waitUntil(() => outputSince(before, "t1").includes("echo-me"));
    await post(`/api/projects/${projectId}/term/input`, { term: "t1", data: "\u0015" }); // ^U clears the line
  });

  it("resizes the tty", async () => {
    if (mode !== "pty") return;
    await post(`/api/projects/${projectId}/term/resize`, { term: "t1", cols: 100, rows: 30 });
    const out = await runTerm("t1", "tput cols", /\b100\b/);
    expect(out).toMatch(/\b100\b/);
  });
});

// The fallback's contract: no tty, so the daemon reports each command's exit
// code and cwd out of band via a sentinel it strips from the stream.
describe("terminal · pipe mode", () => {
  it("reports exit codes and never leaks the sentinel", async () => {
    if (mode !== "pipe") return; // a pty has no sentinel — the shell prompts itself
    const ok = await runForExit("t1", "echo sentinel-check");
    expect(ok.exit).toBe(0);
    // a subshell — a bare `exit` would take the session's shell down with it
    const bad = await runForExit("t1", "(exit 3)");
    expect(bad.exit).toBe(3);
    expect(outputSince(0, "t1")).not.toContain("__LOOM_END__");
  });
});
