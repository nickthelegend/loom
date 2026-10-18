/**
 * Council: the runner. One planner and up to four reviewers take a goal
 * through core/council.ts's stages, in one chat:
 *
 *   plan → backtest → decide → build → prove → forward-test → fix
 *
 * Only the planner ever writes (it holds the baton; the reviewers run as
 * read-only reviews beside it), every finding the planner accepts or rejects
 * is recorded as a decision, and Proof — not the planner — says whether the
 * tests pass. Each stage is a `council` event, so the card in the thread
 * (and `loom council`) shows where it is.
 *
 * Events, one kind, `payload.phase`:
 *   started { councilId, goal, planner, reviewers, chat, stages }
 *   stage   { councilId, stage, status, detail? }
 *   done    { councilId, status: done | failed | stopped, summary }
 */

import { randomUUID } from "node:crypto";
import type { ListOpts } from "../core/events/contracts.js";
import {
  BACKTEST_FOCUS, FORWARD_FOCUS, STAGES, backtestText, buildPrompt, decidePrompt, fixPrompt, parseVerdicts, planPrompt, proofStage,
  type StageKey, type StageStatus,
} from "../core/council.js";
import type { Finding, ReviewTarget } from "../core/review.js";
import { turnOutcome, type TurnOutcome } from "../core/turn-wait.js";
import type { LoomEvent, NewEvent } from "../types.js";
import type { ReviewState } from "./review.js";

export interface CouncilHost {
  hasAgent(id: string): boolean;
  canWrite(id: string): boolean;
  createChat(title: string): { id: string };
  holder(): string | undefined;
  handoff(to: string): Promise<unknown>;
  send(agentId: string, text: string, opts: { chat: string; plan: boolean }): Promise<unknown>;
  interrupt(chat: string): Promise<unknown>;
  checkReviewers(ids: string[]): string[];
  startReview(input: { agents: string[]; target: ReviewTarget; focus: string; chat: string }): Promise<ReviewState>;
  reviewStatus(id: string): ReviewState | null;
  diffTarget(): ReviewTarget;
  decide(findingId: string, decision: "accepted" | "rejected", note?: string): void;
  prove(chat: string): Promise<{ verdict: string; headline: string } | null>;
  list(opts: ListOpts): LoomEvent[];
  append(e: NewEvent): LoomEvent;
  lastId(): number;
  warn(message: string, detail: unknown): void;
}

export interface StartCouncil { goal: string; planner: string; reviewers: string[] }
export interface CouncilState {
  councilId: string; goal: string; planner: string; reviewers: string[]; chat: string;
  status: "running" | "done" | "failed" | "stopped";
  stages: Array<{ key: StageKey; name: string; status: StageStatus; detail?: string }>;
  summary?: string;
}

class Stopped extends Error {}

/** How long one turn or one review may take before the council gives up on it. */
const STEP_MS = 45 * 60_000;

export class CouncilRunner {
  private running: { id: string; chat: string; stop: boolean } | null = null;
  /** For tests: how often to look at the log while waiting. */
  pollMs = 400;

  constructor(private readonly host: CouncilHost) {
    // a council the daemon restarted under won't pick up mid-stage: close it, saying where it was
    for (const e of host.list({ kinds: ["council"] })) {
      if (e.payload.phase !== "started") continue;
      const id = String(e.payload.councilId);
      const s = this.status(id);
      if (!s || s.status !== "running") continue;
      const at = s.stages.find((x) => x.status === "running");
      if (at) this.stage(id, s.chat, at.key, "failed", "Loom restarted during this stage");
      this.host.append({ kind: "council", chat: s.chat, payload: { phase: "done", councilId: id, status: "failed", summary: `stopped at ${at?.name ?? "the start"}: Loom restarted` } });
    }
  }

  private closed = false;

  get active(): boolean { return Boolean(this.running); }

  /** The project is closing: whatever is waiting stops waiting. */
  close(): void { this.closed = true; }

  start(input: StartCouncil): CouncilState {
    if (this.running) throw new Error("a council is already running in this project — stop it first");
    const goal = input.goal?.trim();
    if (!goal) throw new Error("a council needs a goal");
    if (!this.host.hasAgent(input.planner)) throw new Error(`no agent "${input.planner}" in this project`);
    if (!this.host.canWrite(input.planner)) throw new Error(`"${input.planner}" can't plan and build (a bridge, switched off, or a read-only model agent)`);
    const reviewers = input.reviewers.length ? this.host.checkReviewers(input.reviewers.filter((r) => r !== input.planner)) : [];
    if (!reviewers.length) throw new Error("name at least one reviewer other than the planner");
    const councilId = randomUUID().slice(0, 6);
    const chat = this.host.createChat(`🏛 Council · ${goal.replace(/\s+/g, " ")}`.slice(0, 60)).id;
    this.running = { id: councilId, chat, stop: false };
    this.host.append({ kind: "council", chat, payload: { phase: "started", councilId, goal, planner: input.planner, reviewers, chat, stages: STAGES.map((s) => ({ key: s.key, name: s.name, what: s.what })) } });
    void this.run(councilId, chat, goal, input.planner, reviewers)
      .catch((err) => this.host.warn("council failed", err))
      .finally(() => { if (this.running?.id === councilId) this.running = null; });
    return this.status(councilId)!;
  }

  /** Stop after the current stage; a turn in progress is interrupted. */
  async stop(): Promise<CouncilState | null> {
    const r = this.running;
    if (!r) return null;
    r.stop = true;
    await this.host.interrupt(r.chat).catch(() => {});
    return this.status(r.id);
  }

  private stage(councilId: string, chat: string, stage: StageKey, status: StageStatus, detail?: string): void {
    this.host.append({ kind: "council", chat, payload: { phase: "stage", councilId, stage, status, ...(detail ? { detail: detail.slice(0, 400) } : {}) } });
  }

  private async sleep(): Promise<void> {
    if (this.closed) throw new Stopped();
    await new Promise((r) => setTimeout(r, this.pollMs));
  }

  private check(councilId: string): void {
    if (this.running?.id === councilId && this.running.stop) throw new Stopped();
  }

  /** Send the planner one turn in the council's chat and wait for it to end. */
  private async turn(councilId: string, chat: string, planner: string, text: string, plan: boolean): Promise<TurnOutcome> {
    const since = this.host.lastId();
    await this.host.send(planner, text, { chat, plan });
    const deadline = Date.now() + STEP_MS;
    // the answer is the turn after OUR request: the planner may be finishing another turn first (a relay, a
    // queued message), and that turn's end isn't this one's (#289)
    let asked: number | null = null;
    while (Date.now() < deadline) {
      asked ??= this.host.list({ chat, kinds: ["message"], limit: 500 }).find((e) => e.id > since && !e.agentId && String(e.payload.text ?? "").trim() === text.trim())?.id ?? null;
      const out = asked === null ? null : turnOutcome(this.host.list({ chat, agentId: planner, limit: 2000 }).filter((e) => e.id > asked!), planner, asked);
      if (out) return out;
      if (this.running?.stop) {
        // a stopped turn ends with an interrupted status, not run_complete
        if (this.host.list({ chat, agentId: planner, kinds: ["status"] }).some((e) => e.id > since && (e.payload.state === "interrupted" || e.payload.state === "stopped"))) throw new Stopped();
      }
      await this.sleep();
    }
    throw new Error(`${planner} didn't finish within ${STEP_MS / 60_000} minutes`);
  }

  private async review(councilId: string, chat: string, reviewers: string[], target: ReviewTarget, focus: string): Promise<ReviewState> {
    const started = await this.host.startReview({ agents: reviewers, target, focus, chat });
    const deadline = Date.now() + STEP_MS;
    while (Date.now() < deadline) {
      const s = this.host.reviewStatus(started.reviewId);
      if (s?.status === "done") return s;
      this.check(councilId);
      await this.sleep();
    }
    throw new Error(`the reviewers didn't finish within ${STEP_MS / 60_000} minutes`);
  }

  private record(findings: Finding[], reply: string): { accepted: Finding[]; rejected: Finding[]; open: number } {
    const verdicts = parseVerdicts(reply, findings.map((f) => f.id));
    const accepted: Finding[] = [], rejected: Finding[] = [];
    for (const f of findings) {
      const v = verdicts.get(f.id);
      if (!v) continue;
      try { this.host.decide(f.id, v.decision, v.note); } catch (err) { this.host.warn("council couldn't record a verdict", err); }
      (v.decision === "accepted" ? accepted : rejected).push(f);
    }
    return { accepted, rejected, open: findings.length - accepted.length - rejected.length };
  }

  private async run(councilId: string, chat: string, goal: string, planner: string, reviewers: string[]): Promise<void> {
    let current: StageKey = "plan";
    const go = (k: StageKey) => { current = k; this.check(councilId); this.stage(councilId, chat, k, "running"); };
    const tally = (r: { accepted: Finding[]; rejected: Finding[]; open: number }) =>
      [`${r.accepted.length} accepted`, `${r.rejected.length} rejected`, r.open ? `${r.open} undecided` : ""].filter(Boolean).join(" · ");
    const failed = (o: TurnOutcome) => o.status === "error" ? o.error ?? "the turn failed" : o.status === "needs_input" ? `${planner} asked: ${o.question} — answer it in this chat` : "";
    const summary: string[] = [];
    try {
      if (this.host.holder() !== planner) await this.host.handoff(planner);

      go("plan");
      const planned = await this.turn(councilId, chat, planner, planPrompt(goal), true);
      if (failed(planned) || !planned.reply.trim()) throw Object.assign(new Error(failed(planned) || `${planner} answered with no plan`), { stage: "plan" });
      this.stage(councilId, chat, "plan", "done", `${planned.reply.split("\n").filter((l) => l.trim()).length} lines`);

      go("backtest");
      const back = await this.review(councilId, chat, reviewers, { kind: "text", text: backtestText(goal, planned.reply) }, BACKTEST_FOCUS);
      this.stage(councilId, chat, "backtest", "done", back.summary);

      let accepted: Finding[] = [], rejected: Finding[] = [];
      const found = back.findings ?? [];
      if (!found.length) this.stage(councilId, chat, "decide", "skipped", "the reviewers found nothing to decide");
      else {
        go("decide");
        const decided = await this.turn(councilId, chat, planner, decidePrompt(found), true);
        if (failed(decided)) throw Object.assign(new Error(failed(decided)), { stage: "decide" });
        const r = this.record(found, decided.reply);
        ({ accepted, rejected } = r);
        this.stage(councilId, chat, "decide", "done", tally(r));
        summary.push(`plan: ${tally(r)}`);
      }

      go("build");
      const built = await this.turn(councilId, chat, planner, buildPrompt(goal, accepted, rejected), false);
      if (failed(built)) throw Object.assign(new Error(failed(built)), { stage: "build" });
      this.stage(councilId, chat, "build", "done");

      go("prove");
      let proof = await this.host.prove(chat);
      // a "didn't hold" is marked as one, and the council carries on to the fix round with it
      this.stage(councilId, chat, "prove", proof ? proofStage(proof.verdict) : "skipped", proof?.headline ?? "nothing to check");

      let target: ReviewTarget | null = null;
      try { target = this.host.diffTarget(); } catch { /* the build changed nothing */ }
      let toFix: Finding[] = [];
      if (!target) this.stage(councilId, chat, "forward", "skipped", "the build changed no files");
      else {
        go("forward");
        const fwd = await this.review(councilId, chat, reviewers, target, FORWARD_FOCUS);
        // every finding goes to the fix round: the planner rejects what it won't do, out loud (#277)
        toFix = fwd.findings ?? [];
        this.stage(councilId, chat, "forward", "done", fwd.summary);
      }

      const contradicted = proof?.verdict === "contradicted";
      if (!toFix.length && !contradicted) this.stage(councilId, chat, "fix", "skipped", "nothing to fix");
      else {
        go("fix");
        const fixed = await this.turn(councilId, chat, planner, fixPrompt(toFix, contradicted ? proof!.headline : undefined), false);
        if (failed(fixed)) throw Object.assign(new Error(failed(fixed)), { stage: "fix" });
        const r = this.record(toFix, fixed.reply);
        proof = await this.host.prove(chat) ?? proof;
        this.stage(councilId, chat, "fix", "done", [toFix.length ? tally(r).replace("accepted", "fixed") : "", proof ? `Proof: ${proof.headline}` : ""].filter(Boolean).join(" · "));
        if (toFix.length) summary.push(`diff: ${tally(r).replace("accepted", "fixed")}`);
      }
      const verdict = proof ? ({ verified: "verified", contradicted: "didn't hold", unverified: "unverified" } as Record<string, string>)[proof.verdict] ?? proof.verdict : "not checked";
      this.host.append({ kind: "council", chat, payload: { phase: "done", councilId, status: "done", summary: [`built · Proof ${verdict}`, ...summary].join(" · ") } });
    } catch (err) {
      const stopped = err instanceof Stopped;
      const where = (err as { stage?: StageKey }).stage ?? current;
      const message = stopped ? "you stopped it" : err instanceof Error ? err.message : String(err);
      this.stage(councilId, chat, where, stopped ? "skipped" : "failed", message);
      const name = STAGES.find((s) => s.key === where)?.name ?? where;
      this.host.append({ kind: "council", chat, payload: { phase: "done", councilId, status: stopped ? "stopped" : "failed", summary: `${stopped ? "stopped" : "failed"} at ${name}: ${message}` } });
    }
  }

  status(councilId: string): CouncilState | null {
    const evs = this.host.list({ kinds: ["council"] }).filter((e) => e.payload.councilId === councilId);
    const started = evs.find((e) => e.payload.phase === "started");
    if (!started) return null;
    const p = started.payload;
    const stages: CouncilState["stages"] = STAGES.map((s) => ({ key: s.key, name: s.name, status: "waiting" as StageStatus }));
    for (const e of evs) {
      if (e.payload.phase !== "stage") continue;
      const st = stages.find((s) => s.key === e.payload.stage);
      if (st) { st.status = e.payload.status as StageStatus; if (e.payload.detail) st.detail = String(e.payload.detail); else delete st.detail; }
    }
    const done = evs.find((e) => e.payload.phase === "done");
    return { councilId, goal: String(p.goal), planner: String(p.planner), reviewers: p.reviewers as string[], chat: String(p.chat), stages,
      status: done ? (done.payload.status as CouncilState["status"]) : "running", ...(done ? { summary: String(done.payload.summary) } : {}) };
  }

  recent(limit = 10): CouncilState[] {
    return this.host.list({ kinds: ["council"] }).filter((e) => e.payload.phase === "started").slice(-limit).reverse()
      .map((e) => this.status(String(e.payload.councilId))!).filter(Boolean);
  }
}
