/**
 * The real-product harness: a real Loom daemon (the built `dist/`, the same
 * code the desktop app and `loom up` run) in its own LOOM_HOME on its own port,
 * real HTTP, real git, real agent CLIs, the real hosted hub and a real GitHub
 * sandbox repo. Nothing here is a mock: a test passes only when the running
 * product does what the plan says, observed from the outside.
 */

import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const CLI = path.join(ROOT, "dist", "cli", "index.js");

export async function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function until(fn, { timeoutMs = 30_000, every = 250, what = "condition" } = {}) {
  const end = Date.now() + timeoutMs;
  let last;
  while (Date.now() < end) {
    try {
      last = await fn();
      if (last) return last;
    } catch (e) {
      last = e;
    }
    await sleep(every);
  }
  throw new Error(`timed out waiting for ${what}${last instanceof Error ? `: ${last.message}` : ""}`);
}

/** A daemon of our own: fresh home (a first-time user), its own port. */
export class Daemon {
  constructor(name, opts = {}) {
    this.name = name;
    this.home = opts.home ?? fs.mkdtempSync(path.join(os.tmpdir(), `loom-e2e-${name}-`));
    this.env = { ...process.env, LOOM_HOME: this.home, LOOM_NO_NOTIFY: "1", ...(opts.env ?? {}) };
    this.logFile = path.join(this.home, "daemon.log");
  }
  async start() {
    this.port = this.port ?? (await freePort());
    const out = fs.openSync(this.logFile, "a");
    // `entry` lets a test run a DIFFERENT build than this checkout's — the
    // update run needs a daemon that can replace itself (see run-update.mjs).
    this.proc = spawn(process.execPath, [this.entry ?? CLI, "daemon", "--port", String(this.port)], { env: this.env, stdio: ["ignore", out, out] });
    this.base = `http://127.0.0.1:${this.port}`;
    await until(async () => (await fetch(`${this.base}/api/health`)).ok, { what: `${this.name} daemon health`, timeoutMs: 40_000 });
    this.admin = JSON.parse(fs.readFileSync(path.join(this.home, "daemon.json"), "utf8")).adminToken;
    return this;
  }
  async stop() {
    if (!this.proc) return;
    const p = this.proc;
    this.proc = null;
    p.kill("SIGTERM");
    await new Promise((r) => {
      const t = setTimeout(() => {
        try { p.kill("SIGKILL"); } catch { /* gone */ }
        r();
      }, 8000);
      p.once("exit", () => {
        clearTimeout(t);
        r();
      });
    });
  }
  async restart() {
    await this.stop();
    await this.start();
  }
  /** A real request. Returns {status, body, text, ms}. */
  async req(method, p, body, token = this.admin) {
    const t0 = Date.now();
    const res = await fetch(`${this.base}${p}`, {
      method,
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
    return { status: res.status, body: json, text, ms: Date.now() - t0 };
  }
  get = (p, t) => this.req("GET", p, undefined, t);
  post = (p, b = {}, t) => this.req("POST", p, b, t);
  patch = (p, b = {}, t) => this.req("PATCH", p, b, t);
  del = (p, t) => this.req("DELETE", p, undefined, t);
  cli(args, opts = {}) {
    return execFileSync(process.execPath, [CLI, ...args], {
      env: { ...this.env, LOOM_PORT: String(this.port), LOOM_URL: this.base },
      cwd: opts.cwd ?? ROOT,
      encoding: "utf8",
      timeout: opts.timeoutMs ?? 120_000,
      input: opts.input,
    });
  }
  log() {
    try {
      return fs.readFileSync(this.logFile, "utf8");
    } catch {
      return "";
    }
  }
}

export function git(dir, ...args) {
  return execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/** A fresh local git repo with one commit — a first-time user's project. */
export function freshRepo(name, files = { "README.md": `# ${name}\n` }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `loom-e2e-repo-${name}-`));
  git(dir, "init", "-q", "-b", "main");
  for (const [f, c] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    fs.writeFileSync(path.join(dir, f), c);
  }
  git(dir, "add", "-A");
  git(dir, "-c", "user.name=e2e", "-c", "user.email=e2e@loom.local", "commit", "-qm", "init");
  return dir;
}

// ── results ──

export class Recorder {
  constructor(file) {
    this.file = file;
    this.results = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
  }
  set(id, status, evidence) {
    this.results[id] = { status, evidence: String(evidence).slice(0, 1500), at: new Date().toISOString() };
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.results, null, 2));
    const mark = status === "PASS" ? "✓" : status === "FAIL" ? "✗" : "◌";
    console.log(`${mark} ${status.padEnd(7)} ${id}  ${String(evidence).split("\n")[0].slice(0, 140)}`);
  }
}

/** Run one planned test: the body returns evidence, throws to FAIL, or throws Blocked. */
export class Blocked extends Error {}

export async function check(rec, id, fn) {
  try {
    const ev = await fn();
    rec.set(id, "PASS", ev ?? "ok");
  } catch (e) {
    if (e instanceof Blocked) rec.set(id, "BLOCKED", e.message);
    else rec.set(id, "FAIL", e?.stack ?? String(e));
  }
}

export function expect(cond, msg) {
  if (!cond) throw new Error(`expected: ${msg}`);
}
