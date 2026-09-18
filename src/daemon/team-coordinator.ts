/**
 * Loom Teams, Phase 2 — "stop colliding": a project's orchestra, coordinated
 * with the team. One per open project; the orchestra engine asks it before
 * every task starts, and tells it what workers touch and finish.
 *
 * Decisions (docs/teams-architecture.md §1a):
 *   D28 scopes are real files · D29 an overlap needs a declared decision ·
 *   D30 wait:<goal> starts after that PR merges, on fresh main · D31 a held
 *   hard zone queues · D32 a stuck wait unblocks · D33 drift widens the lease,
 *   stops only in someone's hard zone · D34 predicted conflicts go to both
 *   owners and orchestrators · D35 WIP refs + merge-tree on task merge and every
 *   5 min · D36 leases release when the goal lands · D37–D39 team policy.
 */

import { execFile } from "node:child_process";

import { logbook } from "../core/logbook.js";
import { notify } from "../core/notify.js";
import type { Admission, OrchestraCoordinator, OrchestraRun, OrchestraTask } from "../core/orchestra.js";
import { openFromTeam, sealForTeam, type TeamKey } from "../core/team-crypto.js";
import type { FeedEvent, FeedIn, HubClient, Lease, Presence } from "../core/team-hub.js";
import { covered, overlap, scopeOf, zoneOf } from "../core/team-leases.js";
import { agentAllowed, isProtected, loadPolicy, type TeamPolicy } from "../core/team-policy.js";
import type { ProjectRuntime } from "./runtime.js";

/** What the coordinator needs from Team Link. */
export interface CoordinatorContext {
  hub(): HubClient | null;
  deviceId(): string | null;
  github(): string | null;
  share(rt: ProjectRuntime): Promise<{ teamId: string; repo: string } | null>;
  keys(teamId: string): TeamKey[];
  feed(teamId: string): FeedEvent[];
  presence(teamId: string): Presence[];
}

const POLICY_TTL_MS = 60_000;
const WIP_EVERY_MS = 5 * 60_000;
const STUCK_WAIT_MS = 24 * 60 * 60_000;

function git(args: string[], cwd: string): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    execFile("git", args, { cwd, timeout: 30_000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) =>
      resolve({ code: err ? ((err as { code?: number }).code ?? 1) : 0, out: String(stdout || stderr) }),
    );
  });
}

export const wipRef = (member: string, runId: string) => `refs/loom/wip/${member}/${runId}`;

export class TeamCoordinator implements OrchestraCoordinator {
  private policy: (TeamPolicy & { at: number }) | null = null;
  private leaseIds = new Map<string, string>(); // `${run}/${task}` → lease id
  private driftBuf = new Map<string, { paths: Set<string>; timer: ReturnType<typeof setTimeout> }>();
  private wipTimer: ReturnType<typeof setTimeout> | null = null;
  private interval: ReturnType<typeof setInterval>;
  private predicted = new Set<string>();
  private posted = new Set<string>();

  constructor(
    private rt: ProjectRuntime,
    private ctx: CoordinatorContext,
  ) {
    this.interval = setInterval(() => void this.wipAndPredict().catch(() => {}), WIP_EVERY_MS);
    this.interval.unref?.();
  }

  stop(): void {
    clearInterval(this.interval);
    if (this.wipTimer) clearTimeout(this.wipTimer);
    for (const d of this.driftBuf.values()) clearTimeout(d.timer);
  }

  // ── policy (D37–D39) ──

  async teamPolicy(): Promise<TeamPolicy | null> {
    if (!(await this.ctx.share(this.rt))) return null;
    if (!this.policy || Date.now() - this.policy.at > POLICY_TTL_MS) {
      const p = await loadPolicy(this.rt.info.dir);
      this.policy = { ...p, at: Date.now() };
      this.rt.teamPolicy = p;
    }
    return this.policy;
  }

  maxParallel(): number | null {
    return this.policy?.orchestra.maxParallelPerMember ?? null;
  }

  isProtected(branch: string): boolean {
    return this.policy ? isProtected(this.policy, branch) : false;
  }

  // ── admission ──

  async admit(run: OrchestraRun, task: OrchestraTask): Promise<Admission> {
    const share = await this.ctx.share(this.rt);
    const hub = this.ctx.hub();
    const device = this.ctx.deviceId();
    if (!share || !hub || !device) return { go: true };
    const policy = (await this.teamPolicy())!;
    const now = Date.now();
    const hold = (kind: "decide" | "wait" | "zone" | "capacity", reason: string, extra: Record<string, string> = {}): Admission => ({
      go: false,
      hold: { kind, reason, since: now, ...extra },
    });

    if (!agentAllowed(policy, task.kind)) {
      return hold("decide", `team policy doesn't allow ${task.kind} on this repo (allowed: ${policy.agents.allow!.join(", ")}) — reassign ${task.id}`);
    }
    if (!task.touches?.length) {
      return hold("decide", `declare "touches" for ${task.id}: the file globs it will change (required on team projects, so teammates can see what's taken)`);
    }
    const cap = policy.orchestra.teamMaxConcurrentAgents;
    if (cap) {
      const live = this.ctx.presence(share.teamId).filter((p) => p.state === "running" && /#t/.test(p.agent)).length;
      if (live >= cap) return hold("capacity", `the team is at its limit of ${cap} running agents (team policy) — starts when one finishes`);
    }

    // D29/D30/D32: an explicit wait
    let rebase = false;
    let note: string | undefined;
    if (task.overlap?.startsWith("wait:")) {
      const target = task.overlap.slice(5).trim();
      const w = this.waitState(share.teamId, target);
      if (w.state === "waiting") return hold("wait", `waiting for goal ${target}'s PR to merge — ${w.detail}`, { runId: target });
      rebase = true;
      note = `${task.id} stopped waiting on ${target}: ${w.detail}`;
    }

    const tracked = await this.tracked(run.dir);
    const scope = scopeOf(task.touches, tracked);
    const rivals = (await hub.leases(share.teamId, share.repo)).filter((l) => !l.stale && l.runId !== run.id);
    const zone = zoneOf(scope, policy.hardZones);
    const zoneHolder = zone ? rivals.find((l) => zoneOf(l, [zone]) === zone) : undefined;
    if (zone && zoneHolder) {
      await this.post(share.teamId, `zone:${run.id}/${task.id}/${zone}`, {
        type: "zone_waiting",
        repo: share.repo,
        meta: { runId: run.id, taskId: task.id, zone, holder: zoneHolder.github, holderRun: zoneHolder.runId },
      });
      return hold("zone", `${zone} is a hard zone held by ${this.describe(share.teamId, zoneHolder)} — starts when it's released`, {
        zone,
        holder: zoneHolder.github,
      });
    }
    const overlaps = rivals.map((l) => ({ lease: l, paths: overlap(scope, l) })).filter((o) => o.paths.length);
    const decision = task.overlap ?? "";
    if (overlaps.length && !decision.startsWith("proceed:") && !decision.startsWith("wait:")) {
      const who = overlaps
        .map((o) => `${this.describe(share.teamId, o.lease)} holds ${o.paths.slice(0, 5).join(", ")}${o.paths.length > 5 ? " …" : ""}`)
        .join("; ");
      const again = decision === "narrow" ? "still overlaps after narrowing — " : "";
      return hold("decide", `${task.id} ${again}overlaps a teammate's work: ${who}`);
    }
    if (overlaps.length && decision.startsWith("proceed:")) {
      await this.post(share.teamId, `proceed:${run.id}/${task.id}`, {
        type: "overlap_decided",
        repo: share.repo,
        meta: { runId: run.id, taskId: task.id, decision: "proceed", with: [...new Set(overlaps.map((o) => o.lease.runId))] },
        sealed: this.seal(share.teamId, { reason: decision.slice(8).trim(), goal: run.goal.split("\n")[0]!.slice(0, 200) }),
      });
    }

    const res = await hub.claimLease(share.teamId, {
      ...scope,
      deviceId: device,
      repo: share.repo,
      runId: run.id,
      taskId: task.id,
      hardZones: policy.hardZones,
      sealed: this.seal(share.teamId, { goal: run.goal.split("\n")[0]!.slice(0, 200), task: task.title.slice(0, 200) }),
    });
    if (!res.lease) {
      const b = res.blockedBy!;
      return hold("zone", `${b.zone} is a hard zone held by ${this.describe(share.teamId, b.lease)} — starts when it's released`, {
        zone: b.zone,
        holder: b.lease.github,
      });
    }
    this.leaseIds.set(`${run.id}/${task.id}`, res.lease.id);
    return { go: true, ...(rebase ? { rebase } : {}), ...(note ? { note } : {}) };
  }

  /** D30/D32: where the goal we're waiting on stands. */
  private waitState(teamId: string, target: string): { state: "waiting" | "go"; detail: string } {
    const feed = this.ctx.feed(teamId);
    const branch = `loom/orchestra/${target}/main`;
    if (feed.some((e) => e.type === "pr_merged" && e.meta.branch === branch)) return { state: "go", detail: "its PR merged" };
    if (feed.some((e) => e.type === "lease_released" && e.meta.runId === target && /merged/i.test(String(e.meta.reason ?? "")))) {
      return { state: "go", detail: "its work landed" };
    }
    const fin = [...feed].reverse().find((e) => e.type === "goal_finished" && e.meta.runId === target);
    if (fin && (fin.meta.status === "failed" || fin.meta.status === "aborted")) {
      return { state: "go", detail: `it ended (${String(fin.meta.status)}) without a PR` };
    }
    const hasPr = feed.some((e) => e.type === "pr_opened" && (e.meta.branch === branch || e.meta.runId === target));
    if (fin && !hasPr && Date.now() - fin.ts > STUCK_WAIT_MS) return { state: "go", detail: "it finished a day ago and never opened a PR" };
    const started = feed.find((e) => e.type === "goal_started" && e.meta.runId === target);
    if (!started && !fin) return { state: "waiting", detail: "no such goal on the team feed yet" };
    return { state: "waiting", detail: hasPr ? "its PR is open" : fin ? "it finished; no PR yet" : "it's still running" };
  }

  // ── drift (D33) ──

  onEdit(run: OrchestraRun, task: OrchestraTask, path: string): void {
    if (!task.touches?.length || covered(path, task.touches)) return;
    const key = `${run.id}/${task.id}`;
    const buf = this.driftBuf.get(key) ?? { paths: new Set<string>(), timer: setTimeout(() => void this.flushDrift(run, task), 1500) };
    buf.paths.add(path);
    this.driftBuf.set(key, buf);
  }

  private async flushDrift(run: OrchestraRun, task: OrchestraTask): Promise<void> {
    const key = `${run.id}/${task.id}`;
    const buf = this.driftBuf.get(key);
    this.driftBuf.delete(key);
    const leaseId = this.leaseIds.get(key);
    const share = await this.ctx.share(this.rt);
    const hub = this.ctx.hub();
    if (!buf || !leaseId || !share || !hub) return;
    const paths = [...buf.paths];
    const policy = (await this.teamPolicy())!;
    const res = await hub.extendLease(share.teamId, leaseId, { globs: paths, files: paths, prefixes: paths }, policy.hardZones);
    if (!res.lease && res.blockedBy) {
      const b = res.blockedBy;
      this.rt.orchestra.pauseTask(run.id, task.id, {
        kind: "zone",
        reason: `it edited ${paths.join(", ")} inside ${b.zone}, a hard zone held by ${this.describe(share.teamId, b.lease)} — paused until it's released`,
        zone: b.zone,
        holder: b.lease.github,
        since: Date.now(),
      });
      return;
    }
    task.touches = [...new Set([...(task.touches ?? []), ...paths])];
    const withRuns = [...new Set(res.overlaps.map((o) => o.lease.runId))];
    await this.post(share.teamId, `drift:${key}:${paths.sort().join(",")}`, {
      type: "drift",
      repo: share.repo,
      meta: { runId: run.id, taskId: task.id, paths, with: withRuns, holders: [...new Set(res.overlaps.map((o) => o.lease.github))] },
    });
    if (res.overlaps.length) {
      this.rt.orchestra.addNote(
        run.id,
        `${task.id} edited ${paths.join(", ")} outside its declared touches, overlapping ${res.overlaps.map((o) => this.describe(share.teamId, o.lease)).join("; ")}.`,
      );
    }
  }

  // ── WIP and conflict prediction (D34, D35) ──

  onTaskDone(): void {
    if (this.wipTimer) clearTimeout(this.wipTimer);
    this.wipTimer = setTimeout(() => void this.wipAndPredict().catch(() => {}), 2000);
    this.wipTimer.unref?.();
  }

  /** Runs whose leases still stand: running, or finished but not yet landed. */
  private liveRuns(): OrchestraRun[] {
    return this.rt.orchestra
      .list()
      .filter((r) => r.status !== "failed" && r.status !== "aborted" && !r.applied && !(r.delivered && r.delivered.mode !== "pr"));
  }

  async wipAndPredict(): Promise<Array<{ mine: string; theirs: string; files: string[] }>> {
    const share = await this.ctx.share(this.rt);
    const me = this.ctx.github();
    if (!share || !me) return [];
    const dir = this.rt.info.dir;
    const runs = this.liveRuns();
    for (const r of runs) {
      const push = await git(["push", "-q", "-f", "origin", `${r.branch}:${wipRef(me, r.id)}`], dir);
      if (push.code !== 0) logbook.warn("team", `couldn't publish WIP for ${r.id}`, push.out.slice(0, 300));
    }
    await git(["fetch", "-q", "--prune", "origin", "+refs/loom/wip/*:refs/loom-wip/*"], dir);
    const refs = (await git(["for-each-ref", "--format=%(refname)", "refs/loom-wip"], dir)).out.split("\n").filter(Boolean);
    const found: Array<{ mine: string; theirs: string; files: string[] }> = [];
    for (const ref of refs) {
      const [, , member, runId] = ref.split("/"); // refs/loom-wip/<member>/<run>
      if (!member || !runId || member === me) continue;
      for (const r of runs) {
        const mt = await git(["merge-tree", "--write-tree", "--name-only", "--no-messages", r.branch, ref], dir);
        if (mt.code !== 1) continue; // 0 = clean, >1 = error
        const files = mt.out.split("\n").slice(1).filter(Boolean).sort();
        if (!files.length) continue;
        found.push({ mine: r.id, theirs: runId, files });
        const pair = [r.id, runId].sort().join("+");
        const key = `${pair}:${files.join(",")}`;
        if (this.predicted.has(key)) continue;
        this.predicted.add(key);
        await this.post(share.teamId, `conflict:${key}`, {
          type: "conflict_predicted",
          repo: share.repo,
          meta: { runs: [r.id, runId], members: [me, member], files },
        });
        this.tellOwner(r.id, `Predicted merge conflict with ${member}'s goal ${runId} in ${files.join(", ")}.`);
      }
    }
    return found;
  }

  /** D34, the other half: a teammate's daemon predicted a conflict with one of our runs. */
  onTeamEvent(e: FeedEvent): void {
    const mine = new Set(this.rt.orchestra.list().map((r) => r.id));
    const runs = (e.meta.runs as string[] | undefined) ?? (e.meta.with as string[] | undefined) ?? [];
    const ours = runs.filter((r) => mine.has(r));
    // "A teammate did X" notes skip our own events; landing and unblocking must
    // not — the gh poll that reports OUR PR merged posts as us.
    const fromUs = e.github === this.ctx.github();
    if (!fromUs && e.type === "conflict_predicted" && ours.length) {
      for (const r of ours) this.tellOwner(r, `${e.github ?? "A teammate"} predicts a merge conflict with your goal in ${(e.meta.files as string[]).join(", ")}.`);
    }
    if (!fromUs && (e.type === "drift" || e.type === "overlap_decided") && ours.length) {
      const what = e.type === "drift" ? `edited ${(e.meta.paths as string[]).join(", ")}` : `chose to proceed alongside your work`;
      for (const r of ours) this.rt.orchestra.addNote(r, `${e.github ?? "A teammate"}'s ${String(e.meta.runId)}/${String(e.meta.taskId)} ${what}.`);
    }
    // Anything that can free a hold: look again (D30, D31, D32).
    if (["pr_merged", "lease_released", "goal_finished"].includes(e.type)) {
      for (const r of this.rt.orchestra.list()) if (r.tasks.some((t) => t.hold)) this.rt.orchestra.recheck(r.id);
    }
    // Our own goal's PR merged: it has landed (D36).
    if (e.type === "pr_merged") {
      const m = /^loom\/orchestra\/([^/]+)\/main$/.exec(String(e.meta.branch ?? ""));
      if (m && mine.has(m[1]!)) void this.release(m[1]!, `PR #${String(e.meta.number ?? "")} merged`);
    }
  }

  private tellOwner(runId: string, text: string): void {
    this.rt.orchestra.addNote(runId, text);
    notify({ title: `Loom · ${this.rt.info.name}`, body: text });
  }

  // ── lease lifecycle (D36) ──

  onRunEnd(run: OrchestraRun): void {
    void (async () => {
      const share = await this.ctx.share(this.rt);
      const hub = this.ctx.hub();
      if (!share || !hub) return;
      if (run.status === "completed") await hub.setRunLeaseState(share.teamId, run.id, "landing").catch(() => 0);
      else await this.release(run.id, `goal ${run.status}`);
    })();
  }

  /** The goal landed (or was abandoned): drop its leases and its WIP ref. */
  async release(runId: string, reason: string): Promise<void> {
    const share = await this.ctx.share(this.rt);
    const hub = this.ctx.hub();
    const me = this.ctx.github();
    if (!share || !hub || !me) return;
    await hub.releaseLeases(share.teamId, runId, reason).catch(() => 0);
    await git(["push", "-q", "origin", `:${wipRef(me, runId)}`], this.rt.info.dir);
    for (const k of [...this.leaseIds.keys()]) if (k.startsWith(`${runId}/`)) this.leaseIds.delete(k);
  }

  // ── helpers ──

  private tracked = (() => {
    const cache = new Map<string, { at: number; files: string[] }>();
    return async (dir: string): Promise<string[]> => {
      const c = cache.get(dir);
      if (c && Date.now() - c.at < 60_000) return c.files;
      const files = (await git(["ls-files"], dir)).out.split("\n").filter(Boolean);
      cache.set(dir, { at: Date.now(), files });
      return files;
    };
  })();

  private seal(teamId: string, value: unknown) {
    const keys = this.ctx.keys(teamId);
    const k = keys[keys.length - 1];
    return k ? sealForTeam(k, value) : undefined;
  }

  /** "bob's goal 'Rotate session keys' (o7x)" — decrypted when we hold the key. */
  private describe(teamId: string, l: Lease): string {
    const intent = openFromTeam<{ goal?: string }>(this.ctx.keys(teamId), l.sealed);
    return `${l.github}'s goal ${intent?.goal ? `'${intent.goal}' ` : ""}(${l.runId})`;
  }

  /** Post to the team feed once per key (the hub dedupes too). */
  private async post(teamId: string, key: string, e: FeedIn): Promise<void> {
    if (this.posted.has(key)) return;
    this.posted.add(key);
    await this.ctx
      .hub()
      ?.appendFeed(teamId, { ...e, dedupeKey: `${key}@${this.ctx.github() ?? ""}` })
      .catch(() => null);
  }
}
