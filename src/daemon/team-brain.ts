/**
 * Team Brain — one project's share of the team's memory (Loom Teams, Phase 3,
 * "one brain"; docs/teams-architecture.md D40–D51).
 *
 * What it does, and the decision each part serves:
 *   - publishes this project's durable memories to the hub, sealed under the
 *     team key with an HMAC so exact twins merge as confirmations (D13, D41).
 *     Untrusted (D43) and private (D13) memories stay home; an author's edit is
 *     an update, a local forget is a withdrawal (D40)
 *   - holds the team's memories for this repo — snapshot, then the stream (D50)
 *     — and the canon from AGENTS.md on origin's default branch (D44)
 *   - builds the tiered pool every briefing ranks: canon > confirmed > own >
 *     a teammate's proposal (D42), for this repo only (D51)
 *   - keeps an inbox of what needs a human: contradictions, near-duplicates,
 *     corrections awaiting resolution, untrusted memories, promotion candidates
 *   - promotes memories to canon through one rolling `loom/canon` PR (D45, D46)
 *   - writes the live team context block for briefings (D48)
 */

import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { CONFIDENCE_FLOOR, lemmatize, memoryHash, type Memory, type MemoryKind } from "../core/brain.js";
import { cosine, findConflicts, trigramVector } from "../core/brain-index.js";
import { logbook } from "../core/logbook.js";
import { parseCanon, upsertCanon, withClaudeImport, type CanonEntry } from "../core/team-canon.js";
import { memoryHmac, openFromTeam, sealForTeam, type TeamKey } from "../core/team-crypto.js";
import { LEASE_TTL_MS, type FeedEvent, type FeedIn, type HubClient, type Lease, type TeamMemory } from "../core/team-hub.js";
import { overlap, type LeaseScope } from "../core/team-leases.js";
import type { TieredMemory } from "../core/team-memory.js";
import type { ProjectRuntime } from "./runtime.js";

/** What a team memory's sealed content holds — the hub sees none of it. */
interface SealedMemory {
  text: string;
  kind: MemoryKind;
  entities?: string[];
  confidence?: number;
}

export interface TeamBrainDeps {
  hub(): HubClient | null;
  deviceId(): string | null;
  github(): string | null;
  share(rt: ProjectRuntime): Promise<{ teamId: string; repo: string } | null>;
  keys(teamId: string): TeamKey[];
  feed(teamId: string): FeedEvent[];
  leases(teamId: string): Lease[];
  /** Run a command in a directory (git, gh). Tests swap in fakes for `gh`. */
  exec?(cmd: string, args: string[], cwd: string): Promise<string>;
}

/** Memory kinds worth sharing: `task` notes die with their run (D13). */
const DURABLE: ReadonlySet<MemoryKind> = new Set(["constraint", "failure", "decision", "convention", "fact"]);
const CONTEXT_CHARS = 1500;
export const CANON_BRANCH = "loom/canon";

export interface InboxItem {
  id: string;
  type: "contradiction" | "duplicate" | "correction" | "untrusted" | "promote";
  detail: string;
  a: MemoryView;
  b?: MemoryView;
}

export interface MemoryView {
  id: string;
  text: string;
  kind: MemoryKind;
  tier: TieredMemory["tier"];
  author: string | null;
  confirmedBy: string[];
  mine: boolean;
  untrusted?: boolean;
}

function run(cmd: string, args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { cwd, timeout: 60_000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) =>
      err ? reject(new Error((stderr || err.message).trim())) : resolve(stdout),
    );
  });
}

export function shareable(m: Memory): boolean {
  return DURABLE.has(m.kind) && m.confidence >= CONFIDENCE_FLOOR && !m.untrusted && !m.private && !m.expiresAt;
}

export class TeamBrain {
  /** Every team memory for this repo, every state (history too — D47 keeps losers). */
  private cache = new Map<string, TeamMemory>();
  private opened = new Map<string, SealedMemory | null>(); // id+hmac → decrypted
  private canon: CanonEntry[] = [];
  private share: { teamId: string; repo: string } | null = null;
  private syncing: Promise<void> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private unsub: (() => void) | null = null;
  /** Last error from a publish/sync, for the UI. */
  lastError: string | null = null;

  constructor(private rt: ProjectRuntime, private deps: TeamBrainDeps) {
    // A memory learned, edited or forgotten in a shared project reaches the team shortly after.
    this.unsub = rt.log.onEvent((e) => {
      if (e.kind === "memory_add" || e.kind === "memory_update" || e.kind === "memory_forget") this.soon();
    });
  }

  stop(): void {
    this.unsub?.();
    this.unsub = null;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private exec(cmd: string, args: string[], cwd = this.rt.info.dir): Promise<string> {
    return this.deps.exec ? this.deps.exec(cmd, args, cwd) : run(cmd, args, cwd);
  }

  private soon(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.sync().catch(() => {});
    }, 1500);
    this.timer.unref?.();
  }

  get teamId(): string | null {
    return this.share?.teamId ?? null;
  }

  // ── sync: backfill, publish, canon ──

  /** One pass: learn the share, backfill the team's memories once, publish ours, refresh canon. */
  sync(): Promise<void> {
    if (this.syncing) return this.syncing;
    this.syncing = this.doSync().finally(() => {
      this.syncing = null;
    });
    return this.syncing;
  }

  private async doSync(): Promise<void> {
    const hub = this.deps.hub();
    const prev = this.share;
    this.share = hub ? await this.deps.share(this.rt) : null;
    if (!this.share || !hub) {
      this.cache.clear();
      return;
    }
    if (!prev || prev.teamId !== this.share.teamId || prev.repo !== this.share.repo || !this.cache.size) {
      // D50: a live snapshot (with history, so resolutions stay visible), then the stream.
      const all = await hub.teamMemories(this.share.teamId, this.share.repo, { history: true });
      this.cache = new Map(all.map((m) => [m.id, m]));
    }
    try {
      await this.publish();
      this.lastError = null;
    } catch (e) {
      this.lastError = e instanceof Error ? e.message : String(e);
      logbook.warn("team", "couldn't publish memories", this.lastError);
    }
    await this.loadCanon().catch(() => {});
  }

  /** A hub event about a memory in our team. */
  onMemory(m: TeamMemory): void {
    if (!this.share || m.teamId !== this.share.teamId || m.repo !== this.share.repo) return;
    this.cache.set(m.id, m);
  }

  private key(): TeamKey | null {
    const keys = this.share ? this.deps.keys(this.share.teamId) : [];
    return keys[keys.length - 1] ?? null;
  }

  private open(m: TeamMemory): SealedMemory | null {
    const k = `${m.id}:${m.hmac}`;
    if (!this.opened.has(k)) {
      const v = openFromTeam(this.share ? this.deps.keys(this.share.teamId) : [], m.sealed) as SealedMemory | null;
      this.opened.set(k, v && typeof v.text === "string" ? v : null);
    }
    return this.opened.get(k) ?? null;
  }

  /**
   * Make the hub agree with this project's brain, idempotently and without any
   * local bookkeeping: the cache says what the team already has.
   */
  private async publish(): Promise<void> {
    const hub = this.deps.hub();
    const share = this.share;
    const key = this.key();
    const device = this.deps.deviceId();
    const me = this.deps.github();
    if (!hub || !share || !key || !device || !me) return;
    const local = this.rt.brain.all();
    const localIds = new Set(local.map((m) => m.id));
    const byHmac = new Map<string, TeamMemory>();
    for (const t of this.cache.values()) if (t.state === "live") byHmac.set(t.hmac, t);

    for (const m of local) {
      const mine = this.cache.get(m.id);
      if (!shareable(m)) {
        // made private or re-flagged since it was shared: withdraw it
        if (mine && mine.state === "live" && mine.author === me) {
          await hub.forgetTeamMemory(share.teamId, m.id, m.private ? "made private" : "no longer shareable");
          this.cache.set(m.id, { ...mine, state: "forgotten" });
        }
        continue;
      }
      const h = memoryHmac(key, m.text);
      if (mine) {
        if (mine.state !== "live" || mine.hmac === h) continue; // resolved against, or already current
        const sealed = sealForTeam(key, sealedOf(m));
        this.cache.set(m.id, await hub.updateTeamMemory(share.teamId, m.id, { hmac: h, sealed })); // D40: the author edits
        continue;
      }
      const twin = byHmac.get(h);
      if (twin && twin.confirmedBy.includes(me)) continue; // already counted
      const out = await hub.publishMemory(share.teamId, {
        id: m.id,
        repo: share.repo,
        hmac: h,
        sealed: sealForTeam(key, sealedOf(m)),
        deviceId: device,
      });
      this.cache.set(out.memory.id, out.memory);
      byHmac.set(out.memory.hmac, out.memory);
    }

    // A memory this project forgot, that it had shared: withdraw it too.
    const forgotten = new Set(
      this.rt.log.list({ kinds: ["memory_forget"] }).map((e) => String((e.payload as { id?: string }).id ?? "")),
    );
    for (const t of this.cache.values()) {
      if (t.state !== "live" || t.author !== me || localIds.has(t.id) || !forgotten.has(t.id)) continue;
      await hub.forgetTeamMemory(share.teamId, t.id, "forgotten by its author");
      this.cache.set(t.id, { ...t, state: "forgotten" });
    }
  }

  /** Publish one correction to a teammate's memory (D40): a new memory that supersedes theirs. */
  async correct(targetId: string, text: string): Promise<TeamMemory> {
    const hub = this.deps.hub();
    const share = this.share;
    const key = this.key();
    const device = this.deps.deviceId();
    if (!hub || !share || !key || !device) throw new Error("this project isn't shared with a team");
    const target = this.cache.get(targetId);
    const opened = target ? this.open(target) : null;
    const kind: MemoryKind = opened?.kind ?? this.rt.brain.get(targetId)?.kind ?? "decision";
    const { memory } = this.rt.brain.add({
      kind,
      text,
      provenance: { agentId: "user", eventId: 0, ts: Date.now() },
      confidence: 1,
    });
    const out = await hub.publishMemory(share.teamId, {
      id: memory.id,
      repo: share.repo,
      hmac: memoryHmac(key, memory.text),
      sealed: sealForTeam(key, sealedOf(memory)),
      deviceId: device,
      supersedes: targetId,
    });
    this.cache.set(out.memory.id, out.memory);
    return out.memory;
  }

  /** Settle a contradiction or a correction (D47): the loser is kept, superseded, linked. */
  async resolve(winnerId: string, loserId: string, reason: string): Promise<void> {
    const hub = this.deps.hub();
    if (!hub || !this.share) throw new Error("this project isn't shared with a team");
    if (this.canon.some((c) => c.id === loserId)) {
      throw new Error("canon changes through a PR — edit or delete that line in AGENTS.md");
    }
    await this.ensurePublished(winnerId);
    await this.ensurePublished(loserId);
    await hub.resolveMemories(this.share.teamId, winnerId, loserId, reason || "resolved");
    const all = await hub.teamMemories(this.share.teamId, this.share.repo, { history: true });
    this.cache = new Map(all.map((m) => [m.id, m]));
  }

  /** A local-only memory that's about to be resolved has to exist on the hub first. */
  private async ensurePublished(id: string): Promise<void> {
    if (this.cache.has(id)) return;
    // canon winning over a team memory: the hub needs the canon line as a row to link to
    const c = this.canon.find((e) => e.id === id);
    const m = this.rt.brain.get(id) ?? (c ? asMemory(c.id, c, Date.now(), Date.now(), "canon") : undefined);
    if (!m) throw new Error(`no memory "${id}"`);
    const hub = this.deps.hub()!;
    const key = this.key();
    const device = this.deps.deviceId();
    if (!key || !device) throw new Error("no team key on this device");
    const out = await hub.publishMemory(this.share!.teamId, {
      id: m.id,
      repo: this.share!.repo,
      hmac: memoryHmac(key, m.text),
      sealed: sealForTeam(key, sealedOf(m)),
      deviceId: device,
    });
    this.cache.set(out.memory.id, out.memory);
  }

  // ── canon ──

  private async defaultBranch(): Promise<string> {
    const head = (await this.exec("git", ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]).catch(() => "")).trim();
    return head ? head.replace(/^origin\//, "") : "main";
  }

  /** D44: canon is what AGENTS.md on origin's default branch says. */
  async loadCanon(): Promise<CanonEntry[]> {
    const branch = await this.defaultBranch();
    const text = await this.exec("git", ["show", `origin/${branch}:AGENTS.md`]).catch(() => "");
    this.canon = parseCanon(text);
    return this.canon;
  }

  canonEntries(): CanonEntry[] {
    return [...this.canon];
  }

  /**
   * D45: put memories up for canon on the one rolling `loom/canon` PR. Built
   * fresh from the default branch each time — its canon, plus what's already
   * pending on the branch, plus these — so a merged PR never leaves the branch
   * behind, and the PR always shows exactly what isn't canon yet.
   */
  async promote(ids: string[]): Promise<{ branch: string; prUrl: string | null; added: number; note?: string }> {
    if (!ids.length) throw new Error("which memories?");
    const entries: CanonEntry[] = [];
    for (const id of ids) {
      const v = this.view(id);
      if (!v) throw new Error(`no memory "${id}"`);
      if (v.untrusted) throw new Error(`"${v.text.slice(0, 60)}" was learned from outside content — trust it first`);
      if (v.kind === "task") throw new Error("task notes don't belong in canon");
      entries.push({ id: v.id, kind: v.kind, text: v.text });
    }
    const dir = this.rt.info.dir;
    await this.exec("git", ["fetch", "--quiet", "origin"]).catch(() => {});
    const base = await this.defaultBranch();
    const pending = await this.exec("git", ["show", `origin/${CANON_BRANCH}:AGENTS.md`]).catch(() => "");
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "loom-canon-"));
    const wt = path.join(tmp, "wt");
    try {
      await this.exec("git", ["worktree", "add", "--quiet", "--detach", wt, `origin/${base}`], dir);
      const agentsFile = path.join(wt, "AGENTS.md");
      const doc = fs.existsSync(agentsFile) ? fs.readFileSync(agentsFile, "utf8") : "# AGENTS.md\n\nGuidance for coding agents working in this repository.\n";
      const merged: CanonEntry[] = [];
      const seen = new Set<string>();
      const add = (e: CanonEntry) => {
        const k = "t:" + normText(e.text);
        if (seen.has(e.id) || seen.has(k)) return;
        seen.add(e.id);
        seen.add(k);
        merged.push(e);
      };
      const current = parseCanon(doc);
      for (const e of current) add(e);
      for (const e of parseCanon(pending)) add(e);
      const before = merged.length;
      for (const e of entries) add(e);
      const added = merged.length - before;
      if (!added && merged.length === current.length) {
        return { branch: CANON_BRANCH, prUrl: null, added: 0, note: "already canon" };
      }
      fs.writeFileSync(agentsFile, upsertCanon(doc, merged));
      const claudeFile = path.join(wt, "CLAUDE.md");
      if (fs.existsSync(claudeFile)) {
        const next = withClaudeImport(fs.readFileSync(claudeFile, "utf8")); // D46
        if (next) fs.writeFileSync(claudeFile, next);
      }
      await this.exec("git", ["add", "AGENTS.md", ...(fs.existsSync(claudeFile) ? ["CLAUDE.md"] : [])], wt);
      const subject = entries.length === 1 ? `canon: ${entries[0]!.text.slice(0, 60)}` : `canon: ${entries.length} memories`;
      await this.exec(
        "git",
        ["-c", "user.name=Loom", "-c", "user.email=loom@users.noreply.github.com", "commit", "--quiet", "-m", subject,
          "-m", "Proposed as team canon by Loom (docs/teams-architecture.md D44–D46)."],
        wt,
      );
      // Rebuilt from base every time, so this is a force push of a branch Loom owns.
      await this.exec("git", ["push", "--quiet", "--force", "origin", `HEAD:refs/heads/${CANON_BRANCH}`], wt);
      let prUrl: string | null = null;
      let note: string | undefined;
      const repo = this.share?.repo;
      try {
        const open = JSON.parse(
          await this.exec("gh", ["pr", "list", ...(repo ? ["--repo", repo] : []), "--head", CANON_BRANCH, "--state", "open", "--json", "url"], wt),
        ) as Array<{ url: string }>;
        prUrl = open[0]?.url ?? null;
        if (!prUrl) {
          prUrl = (
            await this.exec(
              "gh",
              ["pr", "create", ...(repo ? ["--repo", repo] : []), "--base", base, "--head", CANON_BRANCH, "--title", "Team canon",
                "--body", canonPrBody()],
              wt,
            )
          ).trim().split("\n").pop() || null;
        }
      } catch (e) {
        note = `pushed ${CANON_BRANCH}; couldn't open the PR with gh: ${e instanceof Error ? e.message : String(e)}`;
      }
      await this.announce("canon_proposed", { ids: entries.map((e) => e.id), ...(prUrl ? { prUrl } : {}) });
      return { branch: CANON_BRANCH, prUrl, added, ...(note ? { note } : {}) };
    } finally {
      await this.exec("git", ["worktree", "remove", "--force", wt], dir).catch(() => {});
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }

  private async announce(type: FeedIn["type"], meta: Record<string, unknown>): Promise<void> {
    const hub = this.deps.hub();
    const device = this.deps.deviceId();
    if (!hub || !this.share || !device) return;
    await hub.appendFeed(this.share.teamId, { repo: this.share.repo, type, meta, deviceId: device }).catch(() => null);
  }

  // ── the pool every briefing ranks (D42) ──

  /**
   * Canon, the team's live memories and this project's own, as one tiered
   * pool — or null when the project isn't shared (the solo brain applies).
   */
  pool(own: Memory[] = this.rt.brain.all()): TieredMemory[] | null {
    if (!this.share) return null;
    const me = this.deps.github();
    const out: TieredMemory[] = [];
    const seen = new Set<string>(); // ids and normalized texts already in the pool
    const take = (m: TieredMemory) => {
      const k = "t:" + normText(m.text); // the normalization the HMAC merges on (D41)
      if (seen.has(m.id) || seen.has(k)) return;
      seen.add(m.id);
      seen.add(k);
      out.push(m);
    };
    const now = Date.now();
    for (const c of this.canon) {
      take({ ...asMemory(c.id, { text: c.text, kind: c.kind }, now, now, "canon"), tier: "canon" });
    }
    const team = [...this.cache.values()].filter((t) => t.state === "live");
    // Confirmed first, so a twin of our own memory shows its confirmations.
    team.sort((a, b) => b.confirmedBy.length - a.confirmedBy.length);
    for (const t of team) {
      const s = this.open(t);
      if (!s) continue;
      const confirmed = t.confirmedBy.length >= 2;
      if (!confirmed && t.author === me) continue; // ours: the local copy below carries it
      take({
        ...asMemory(t.id, s, t.createdAt, t.updatedAt, t.author),
        tier: confirmed ? "confirmed" : "proposed",
        author: t.author,
        confirmedBy: [...t.confirmedBy],
      });
    }
    for (const m of own) {
      const t = this.cache.get(m.id);
      if (t && t.state !== "live") continue; // resolved against (D47) or withdrawn
      take({ ...m, tier: "own" });
    }
    return out;
  }

  /** One memory as the UI shows it, from any tier. */
  view(id: string): MemoryView | null {
    const me = this.deps.github();
    const c = this.canon.find((e) => e.id === id);
    if (c) return { id, text: c.text, kind: c.kind, tier: "canon", author: null, confirmedBy: [], mine: false };
    const t = this.cache.get(id);
    const s = t ? this.open(t) : null;
    const local = this.rt.brain.get(id);
    if (t && s) {
      return {
        id,
        text: s.text,
        kind: s.kind,
        tier: t.confirmedBy.length >= 2 ? "confirmed" : t.author === me ? "own" : "proposed",
        author: t.author,
        confirmedBy: [...t.confirmedBy],
        mine: t.author === me,
        ...(local?.untrusted ? { untrusted: true } : {}),
      };
    }
    if (local) {
      return {
        id,
        text: local.text,
        kind: local.kind,
        tier: "own",
        author: me,
        confirmedBy: me ? [me] : [],
        mine: true,
        ...(local.untrusted ? { untrusted: true } : {}),
      };
    }
    return null;
  }

  /** Every live team memory plus the canon, for the Team view (D49). */
  memories(opts: { history?: boolean } = {}): Array<MemoryView & { state: TeamMemory["state"]; supersedes?: string; supersededBy?: string; resolvedBy?: string; resolvedReason?: string }> {
    const out = [];
    for (const c of this.canon) out.push({ ...this.view(c.id)!, state: "live" as const });
    for (const t of this.cache.values()) {
      if (!opts.history && t.state !== "live") continue;
      if (this.canon.some((c) => c.id === t.id)) continue;
      const v = this.view(t.id);
      if (!v) continue;
      out.push({
        ...v,
        state: t.state,
        ...(t.supersedes ? { supersedes: t.supersedes } : {}),
        ...(t.supersededBy ? { supersededBy: t.supersededBy } : {}),
        ...(t.resolvedBy ? { resolvedBy: t.resolvedBy } : {}),
        ...(t.resolvedReason ? { resolvedReason: t.resolvedReason } : {}),
      });
    }
    return out;
  }

  // ── the inbox (D49) ──

  inbox(): InboxItem[] {
    const pool = this.pool();
    if (!pool) return [];
    const byId = new Map(pool.map((m) => [m.id, m]));
    const view = (m: TieredMemory): MemoryView => this.view(m.id) ?? {
      id: m.id, text: m.text, kind: m.kind, tier: m.tier, author: m.author ?? null, confirmedBy: m.confirmedBy ?? [], mine: m.tier === "own",
    };
    const items: InboxItem[] = [];
    const pairs = new Set<string>();
    const pairKey = (a: string, b: string) => [a, b].sort().join("|");

    // Corrections waiting on a decision: a live memory that supersedes another live one.
    for (const t of this.cache.values()) {
      if (t.state !== "live" || !t.supersedes) continue;
      const target = this.cache.get(t.supersedes);
      if (!target || target.state !== "live") continue;
      const a = byId.get(t.id);
      const b = byId.get(target.id);
      if (!a || !b) continue;
      pairs.add(pairKey(a.id, b.id));
      items.push({ id: `correction:${pairKey(a.id, b.id)}`, type: "correction", detail: `${t.author} corrected ${target.author}`, a: view(a), b: view(b) });
    }

    // Contradictions across people (a teammate or canon on one side).
    for (const c of findConflicts(pool)) {
      const a = byId.get(c.a.id)!;
      const b = byId.get(c.b.id)!;
      if (a.tier === "own" && b.tier === "own") continue; // the solo brain's own conflict view covers these
      if (a.tier === "canon" && b.tier === "canon") continue;
      const k = pairKey(a.id, b.id);
      if (pairs.has(k)) continue;
      pairs.add(k);
      items.push({ id: `contradiction:${k}`, type: "contradiction", detail: c.signal === "negation" ? "one says the opposite of the other" : "same topic, different answer", a: view(a), b: view(b) });
    }

    // Near-duplicates the HMAC couldn't merge (D41: exact merges, near flags).
    const vecs = new Map(pool.map((m) => [m.id, trigramVector(m.text)]));
    for (let i = 0; i < pool.length; i++) {
      for (let j = i + 1; j < pool.length; j++) {
        const a = pool[i]!;
        const b = pool[j]!;
        if (a.kind !== b.kind || (a.tier === "own" && b.tier === "own") || (a.tier === "canon" && b.tier === "canon")) continue;
        const k = pairKey(a.id, b.id);
        if (pairs.has(k)) continue;
        if (cosine(vecs.get(a.id)!, vecs.get(b.id)!) < 0.92) continue;
        pairs.add(k);
        items.push({ id: `duplicate:${k}`, type: "duplicate", detail: "nearly the same memory, worded differently", a: view(a), b: view(b) });
      }
    }

    // Learned from outside content: needs a human before it can reach anyone (D43).
    for (const m of this.rt.brain.all()) {
      if (!m.untrusted || m.private || !DURABLE.has(m.kind)) continue;
      items.push({ id: `untrusted:${m.id}`, type: "untrusted", detail: "learned while reading outside content — trust it to share it", a: view({ ...m, tier: "own" }) });
    }

    // Confirmed by 2+ members, not canon yet: worth a PR.
    for (const m of pool) {
      if (m.tier !== "confirmed" || m.kind === "task") continue;
      items.push({ id: `promote:${m.id}`, type: "promote", detail: `confirmed by ${m.confirmedBy?.length ?? 2} teammates — make it canon?`, a: view(m) });
    }
    return items;
  }

  // ── live team context (D48) ──

  /**
   * What teammates are doing near this work, right now: their leases on these
   * paths, open PRs that change them, failing checks, predicted conflicts.
   * ≤1.5k chars; "" when there's nothing near.
   */
  context(files: string[] = []): string {
    if (!this.share) return "";
    const me = this.deps.github();
    const lines: string[] = [];
    const scope: LeaseScope = { globs: files, files, prefixes: files };
    const now = Date.now();

    for (const l of this.deps.leases(this.share.teamId)) {
      if (l.repo !== this.share.repo || l.github === me || now - l.ts > LEASE_TTL_MS) continue;
      const hit = files.length ? overlap(scope, { globs: l.globs, files: l.files, prefixes: l.prefixes }) : [];
      if (files.length && !hit.length) continue;
      const who = l.github || "a teammate";
      const intent = openFromTeam(this.deps.keys(this.share.teamId), l.sealed) as { task?: string; goal?: string } | null;
      lines.push(`- ${who}'s agent holds ${(hit.length ? hit : l.globs).slice(0, 4).join(", ")}${intent?.task ? ` — "${intent.task.slice(0, 80)}"` : ""}${l.state === "landing" ? " (landing, PR open)" : ""}`);
    }

    const feed = this.deps.feed(this.share.teamId).filter((e) => e.repo === this.share!.repo);
    const closed = new Set(feed.filter((e) => e.type === "pr_merged" || e.type === "pr_closed").map((e) => Number(e.meta.number)));
    const fileSet = new Set(files);
    for (const e of feed) {
      if (e.type !== "pr_opened" || closed.has(Number(e.meta.number)) || e.meta.number === undefined) continue;
      if (e.meta.author && e.meta.author === me) continue;
      const prFiles = Array.isArray(e.meta.files) ? (e.meta.files as string[]) : [];
      const touching = files.length ? prFiles.filter((f) => fileSet.has(f) || files.some((x) => f.startsWith(x.replace(/\/?$/, "/")))) : [];
      if (!touching.length) continue;
      lines.push(`- open PR #${String(e.meta.number)} by ${String(e.meta.author ?? "a teammate")} also changes ${touching.slice(0, 4).join(", ")}`);
    }
    const day = now - 24 * 60 * 60_000;
    for (const e of feed) {
      if (e.type !== "check_failed" || e.ts < day || closed.has(Number(e.meta.number))) continue;
      const checks = Array.isArray(e.meta.checks) ? (e.meta.checks as string[]) : [];
      lines.push(`- checks failing on PR #${String(e.meta.number)}: ${checks.slice(0, 3).join(", ")}`);
    }
    for (const e of feed) {
      if (e.type !== "conflict_predicted" || e.ts < day) continue;
      const paths = Array.isArray(e.meta.paths) ? (e.meta.paths as string[]) : [];
      if (files.length && !paths.some((p) => fileSet.has(p))) continue;
      lines.push(`- a merge conflict is predicted on ${paths.slice(0, 4).join(", ") || "shared files"}`);
    }
    if (!lines.length) return "";
    const head = "## Your team, right now (live — near this work)";
    let out = head;
    for (const l of [...new Set(lines)]) {
      if (out.length + l.length + 1 > CONTEXT_CHARS) break;
      out += "\n" + l;
    }
    return out;
  }

  status(): Record<string, unknown> {
    const live = [...this.cache.values()].filter((t) => t.state === "live");
    return {
      shared: Boolean(this.share),
      teamId: this.share?.teamId ?? null,
      repo: this.share?.repo ?? null,
      canon: this.canon.length,
      team: live.length,
      confirmed: live.filter((t) => t.confirmedBy.length >= 2).length,
      mine: live.filter((t) => t.author === this.deps.github()).length,
      lastError: this.lastError,
    };
  }
}

function normText(t: string): string {
  return t.trim().toLowerCase().replace(/\s+/g, " ");
}

function sealedOf(m: Memory): SealedMemory {
  return { text: m.text, kind: m.kind, entities: m.entities.slice(0, 30), confidence: m.confidence };
}

function asMemory(id: string, s: { text: string; kind: MemoryKind; entities?: string[]; confidence?: number }, createdAt: number, updatedAt: number, by: string): Memory {
  return {
    id,
    kind: s.kind,
    text: s.text,
    entities: s.entities ?? [],
    scope: {},
    provenance: { agentId: `@${by}`, eventId: 0, ts: createdAt },
    confidence: s.confidence ?? 1,
    lemmas: lemmatize(s.text),
    hash: memoryHash(s.text),
    createdAt,
    updatedAt,
  };
}

function canonPrBody(): string {
  return [
    "Loom proposes these memories as **team canon** — things every agent on the team (Loom or not) treats as settled.",
    "",
    "They live in a managed section of `AGENTS.md`. Review them like code: edit or delete a line to change canon, or add a line by hand.",
    "This PR rolls: Loom adds to it until it merges.",
    "",
    "🤖 Generated with [Loom](https://github.com/nickthelegend/loom)",
  ].join("\n");
}
