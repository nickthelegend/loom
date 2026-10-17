/**
 * Proof, run: check an agent's finished turn (see core/proof.ts for the rules).
 *
 * The re-run happens in a clean checkout of exactly what the agent left: a
 * detached worktree at HEAD, the working tree's tracked changes applied, its
 * new files copied, and the project's dependency folders linked rather than
 * reinstalled — so it's the agent's code, not its terminal session, under test.
 * The verdict lands in the turn's chat as a `proof` event.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { execFile } from "../core/process.js";
import { runCommand } from "../core/run-command.js";
import { detectTestCommand, evidenceFrom, extractClaims, isPlanRequest, judge, parseCounts, type ProofResult, type Rerun } from "../core/proof.js";
import { loomHome } from "../core/registry.js";
import type { EventKind, LoomEvent } from "../types.js";
import { MAIN_CHAT } from "../types.js";

const exec = promisify(execFile);

export interface ProofConfig {
  /** What tests the project. Unset: detected (npm test, cargo test, pytest, go test, make test). */
  testCommand?: string;
  /** "claims" (default): check a turn when its reply claims tests/build/lint pass. "off": only when asked. */
  auto?: "claims" | "off";
  /** Minutes the re-run may take (default 10). */
  timeoutMin?: number;
}

export interface ProofHost {
  projectId: string;
  dir: string;
  config(): ProofConfig;
  list(opts: { chat?: string; kinds?: EventKind[]; since?: number; before?: number; limit?: number }): LoomEvent[];
  append(e: { kind: EventKind; agentId?: string; chat?: string; payload: Record<string, unknown> }): LoomEvent;
}

/** Dependency folders a clean checkout borrows from the real one, instead of installing. */
const DEP_DIRS = ["node_modules", ".venv", "venv", "vendor"];

export class ProofRunner {
  private chain: Promise<unknown> = Promise.resolve();
  private running = new Set<string>();

  constructor(private readonly host: ProofHost) {}

  /** The newest finished turn in a chat: its agent, final reply, and every event since the request it answered. */
  turn(chat = MAIN_CHAT, at?: number): { agentId: string; reply: LoomEvent | null; done: LoomEvent; events: LoomEvent[]; request: LoomEvent | null } | null {
    const recent = this.host.list({ chat, limit: 600, ...(at ? { before: at + 1 } : {}) });
    const doneAt = [...recent].reverse().findIndex((e) => e.kind === "run_complete" && e.agentId);
    if (doneAt < 0) return null;
    const di = recent.length - 1 - doneAt;
    const done = recent[di]!;
    const agentId = done.agentId!;
    // the turn starts after the last message that wasn't this agent's reply (the request), or the previous turn's end
    let start = 0;
    for (let i = di - 1; i >= 0; i--) {
      const e = recent[i]!;
      if (e.kind === "run_complete" || (e.kind === "message" && !e.agentId)) { start = i + 1; break; }
    }
    const events = recent.slice(start, di + 1).filter((e) => !e.agentId || e.agentId === agentId);
    const reply = [...events].reverse().find((e) => e.kind === "message" && e.agentId === agentId && !e.payload.reasoning && typeof e.payload.text === "string") ?? null;
    const before = recent[start - 1];
    const request = before && before.kind === "message" && !before.agentId ? before : null;
    return { agentId, reply, done, events, request };
  }

  /** A turn that was asked for a plan and changed nothing: there's no work to check yet (#245). */
  planOnly(t: { events: LoomEvent[]; request: LoomEvent | null }): boolean {
    const edited = t.events.some((e) => e.kind === "file_edit" || e.kind === "turn_diff");
    const asked = t.request ? isPlanRequest(String(t.request.payload.text ?? "")) || t.request.payload.plan === true : false;
    return asked && !edited;
  }

  /** Should this finished turn be checked without being asked? (Its reply claims something.) */
  wantsAuto(done: LoomEvent): boolean {
    if ((this.host.config().auto ?? "claims") === "off" || !done.agentId) return false;
    const t = this.turn(done.chat ?? MAIN_CHAT, done.id);
    if (!t || this.planOnly(t)) return false;
    return Boolean(t.reply && extractClaims(String(t.reply.payload.text)).length);
  }

  /** Check the newest finished turn in `chat`. One proof at a time per project; a second ask for the same turn joins the first. */
  prove(chat = MAIN_CHAT, opts: { at?: number; auto?: boolean; testCommand?: string } = {}): Promise<ProofResult & { eventId: number } | null> {
    this.pending++;
    const run = this.chain.then(() => this.proveNow(chat, opts));
    this.chain = run.catch(() => {});
    void run.finally(() => { this.pending--; }).catch(() => {});
    return run;
  }

  private pending = 0;
  /** A check asked for or running — a Night Shift waits for it before it reports. */
  get busy(): boolean { return this.pending > 0; }

  private async proveNow(chat: string, opts: { at?: number; auto?: boolean; testCommand?: string }): Promise<ProofResult & { eventId: number } | null> {
    const t = this.turn(chat, opts.at);
    if (!t) return null;
    const key = `${chat}:${t.done.id}`;
    if (this.running.has(key)) return null;
    this.running.add(key);
    try {
      // asked for a plan, and nothing changed: say so — "the tests fail" about a plan is noise
      if (this.planOnly(t)) {
        const result: ProofResult = { verdict: "unverified", headline: "A plan, not a change — nothing to check until it's built", claims: [], ran: evidenceFrom(t.events), rerun: null };
        const event = this.host.append({ kind: "proof", chat: chat === MAIN_CHAT ? undefined : chat, payload: {
          verdict: result.verdict, headline: result.headline, about: t.agentId, turn: { done: t.done.id, ...(t.reply ? { reply: t.reply.id } : {}) },
          claims: [], ran: result.ran.slice(-12), plan: true, ...(opts.auto ? { auto: true } : {}) } });
        return { ...result, eventId: event.id };
      }
      const text = t.reply ? String(t.reply.payload.text) : "";
      const claims = extractClaims(text);
      const ran = evidenceFrom(t.events);
      const command = opts.testCommand ?? this.host.config().testCommand ?? detectTestCommand(this.host.dir);
      const rerun = command ? await this.rerun(command) : null;
      const result = judge(claims, ran, rerun);
      const event = this.host.append({ kind: "proof", chat: chat === MAIN_CHAT ? undefined : chat, payload: {
        verdict: result.verdict, headline: result.headline, about: t.agentId,
        turn: { done: t.done.id, ...(t.reply ? { reply: t.reply.id } : {}) },
        claims: result.claims, ran: result.ran.slice(-12),
        ...(result.rerun ? { rerun: result.rerun } : {}), ...(opts.auto ? { auto: true } : {}),
      } });
      return { ...result, eventId: event.id };
    } finally {
      this.running.delete(key);
    }
  }

  /** Run `command` against a clean checkout of the working tree as it is now. */
  async rerun(command: string): Promise<Rerun> {
    const timeoutMs = Math.max(1, this.host.config().timeoutMin ?? 10) * 60_000;
    const repo = await this.gitRoot();
    if (!repo) {
      // not a git checkout: there's no clean copy to make, so it runs where it is (and says so)
      const r = await runCommand(command, this.host.dir, { timeoutMs, keep: 64_000 });
      return this.toRerun(command, r, false);
    }
    const dir = path.join(loomHome(), "proof", this.host.projectId, randomUUID().slice(0, 8));
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    await exec("git", ["worktree", "add", "--detach", "-q", dir, "HEAD"], { cwd: repo });
    try {
      await this.copyWorkingTree(repo, dir);
      for (const dep of DEP_DIRS) {
        const from = path.join(repo, dep), to = path.join(dir, dep);
        if (fs.existsSync(from) && !fs.existsSync(to)) fs.symlinkSync(from, to, process.platform === "win32" ? "junction" : "dir");
      }
      // where the project sits in the repo, as git sees it — comparing paths ourselves trips on
      // /private/var vs /var (macOS) and short 8.3 names like RUNNER~1 (Windows)
      const { stdout: prefix } = await exec("git", ["rev-parse", "--show-prefix"], { cwd: this.host.dir });
      const sub = prefix.trim().replace(/\/$/, "");
      const r = await runCommand(command, sub ? path.join(dir, ...sub.split("/")) : dir, { timeoutMs, keep: 64_000 });
      return this.toRerun(command, r, true);
    } finally {
      await exec("git", ["worktree", "remove", "--force", dir], { cwd: repo }).catch(() => fs.rmSync(dir, { recursive: true, force: true }));
      await exec("git", ["worktree", "prune"], { cwd: repo }).catch(() => {});
    }
  }

  private toRerun(command: string, r: Awaited<ReturnType<typeof runCommand>>, clean: boolean): Rerun & { clean: boolean } {
    const counts = parseCounts(r.output);
    return { command, exitCode: r.exitCode, ok: r.ok, ms: r.ms, tail: r.output.slice(-3000), clean,
      ...(counts ? { counts } : {}), ...(r.timedOut ? { timedOut: true } : {}) };
  }

  private async gitRoot(): Promise<string | null> {
    try {
      const { stdout } = await exec("git", ["rev-parse", "--show-toplevel"], { cwd: this.host.dir });
      const root = stdout.trim();
      return root && (await exec("git", ["rev-parse", "--verify", "HEAD"], { cwd: root }).then(() => true, () => false)) ? root : null;
    } catch {
      return null;
    }
  }

  /** The agent's uncommitted work: tracked changes as a patch, new files copied (Loom's own .loom/ excluded). */
  private async copyWorkingTree(repo: string, dir: string): Promise<void> {
    const { stdout: patch } = await exec("git", ["diff", "HEAD", "--binary"], { cwd: repo, maxBuffer: 256 * 1024 * 1024 });
    if (patch.trim()) {
      const file = path.join(os.tmpdir(), `loom-proof-${randomUUID().slice(0, 8)}.patch`);
      fs.writeFileSync(file, patch);
      try { await exec("git", ["apply", "--binary", "--whitespace=nowarn", file], { cwd: dir }); }
      finally { fs.rmSync(file, { force: true }); }
    }
    const { stdout: untracked } = await exec("git", ["ls-files", "--others", "--exclude-standard", "-z"], { cwd: repo, maxBuffer: 64 * 1024 * 1024 });
    for (const rel of untracked.split("\0").filter(Boolean)) {
      if (rel === ".loom" || rel.startsWith(".loom/")) continue;
      const from = path.join(repo, rel), to = path.join(dir, rel);
      const stat = fs.lstatSync(from, { throwIfNoEntry: false });
      if (!stat) continue;
      fs.mkdirSync(path.dirname(to), { recursive: true });
      if (stat.isSymbolicLink()) fs.symlinkSync(fs.readlinkSync(from), to);
      else if (stat.isFile()) fs.copyFileSync(from, to);
    }
  }
}
