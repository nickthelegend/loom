/**
 * Review: the runner (#253). Each reviewer is a read-only subtask in the
 * review's own chat — none takes the baton, so nobody is asked to hand off
 * for a read — and once the last one has answered, one `review` card collects
 * every finding to accept (it becomes a project decision) or reject. The
 * reading of replies is core/review.ts.
 *
 * Events, one kind, `payload.phase`:
 *   started  { reviewId, chat, target, agents, focus? }
 *   done     { reviewId, chat, target, results[], findings[], summary }
 *   decided  { reviewId, findingId, decision, note? }
 */

import { randomUUID } from "node:crypto";
import type { ListOpts } from "../core/events/contracts.js";
import { collectFindings, decisionText, reviewPrompt, reviewSummary, targetLabel, type Finding, type FindingDecision, type ReviewTarget } from "../core/review.js";
import type { LoomEvent, NewEvent } from "../types.js";

export interface ReviewHost {
  hasAgent(id: string): boolean;
  /** An agent that can run a subtask (an adapter, enabled). */
  canReview(id: string): boolean;
  holder(): string | undefined;
  createChat(title: string): { id: string };
  spawn(parent: string, opts: { agentId: string; task: string; chat: string; readOnly: true; onSettled: (o: { ok: boolean; message?: string }) => void }): Promise<unknown>;
  list(opts: ListOpts): LoomEvent[];
  append(e: NewEvent): LoomEvent;
  decide(text: string): void;
  maxReviewers: number;
  /** How long one reviewer may take (ms); past it, it's stopped and left out so the others' findings land. */
  reviewerTimeoutMs?: () => number;
  /** Stop a reviewer that ran out of time. */
  stopReviewer?: (agentId: string) => Promise<unknown>;
}

export interface ReviewResult {
  agent: string; status: "done" | "failed"; error?: string; reply: string;
  /** Files it changed anyway. A review is read-only: an agent without a plan mode is only told so, and this is how you'd know it didn't listen. */
  edited?: string[];
}
export interface ReviewState {
  reviewId: string;
  chat: string;
  target: { kind: string; file?: string; label?: string };
  agents: string[];
  status: "running" | "done";
  results?: ReviewResult[];
  findings?: Array<Finding & { decision?: FindingDecision; note?: string }>;
  summary?: string;
}

/** What a target looks like on a card: the diff itself stays in the brief. */
const slim = (t: ReviewTarget): ReviewState["target"] => (t.kind === "file" ? { kind: "file", file: t.file } : t.kind === "text" ? { kind: "text", label: targetLabel(t) } : { kind: t.kind });

export class ReviewRunner {
  private pending = new Map<string, { chat: string; target: ReviewState["target"]; agents: string[]; settled: Map<string, { ok: boolean; message?: string }>; startedAt: number }>();

  constructor(private readonly host: ReviewHost) {
    // a review the daemon restarted under will never hear back: close it, saying so
    for (const e of host.list({ kinds: ["review"] })) {
      if (e.payload.phase !== "started") continue;
      const id = String(e.payload.reviewId);
      if (host.list({ kinds: ["review"], chat: String(e.chat ?? "main") }).some((d) => d.payload.phase === "done" && d.payload.reviewId === id)) continue;
      const agents = (e.payload.agents as string[]) ?? [];
      this.finish(id, String(e.chat), e.payload.target as ReviewState["target"], agents, new Map(agents.map((a) => [a, { ok: false, message: "Loom restarted before it answered" }])), e.ts);
    }
  }

  /** The reviewers, deduplicated — or why they can't review. */
  check(names: string[]): string[] {
    const agents = [...new Set(names.map((a) => a.trim()).filter(Boolean))];
    if (!agents.length) throw new Error("name at least one agent to review");
    if (agents.length > this.host.maxReviewers) throw new Error(`${agents.length} reviewers — ${this.host.maxReviewers} at a time is the limit`);
    for (const a of agents) {
      if (!this.host.hasAgent(a)) throw new Error(`no agent "${a}" in this project`);
      if (!this.host.canReview(a)) throw new Error(`"${a}" can't run a review (it's a bridge, or switched off)`);
    }
    return agents;
  }

  async start(input: { agents: string[]; target: ReviewTarget; focus?: string; chat?: string }): Promise<ReviewState> {
    const agents = this.check(input.agents);
    if (input.target.kind === "file" && !input.target.file.trim()) throw new Error("which file?");
    const reviewId = randomUUID().slice(0, 6);
    const label = targetLabel(input.target);
    const chat = input.chat ?? this.host.createChat(`🔍 Review · ${label}`.slice(0, 60)).id;
    const target = slim(input.target);
    // the parent a child is filed under: whoever holds the baton, which a review never takes
    const parent = this.host.holder() ?? agents[0]!;
    const run = { chat, target, agents, settled: new Map<string, { ok: boolean; message?: string }>(), startedAt: Date.now() };
    this.pending.set(reviewId, run);
    this.host.append({ kind: "review", chat, payload: { phase: "started", reviewId, chat, target, agents, ...(input.focus ? { focus: input.focus } : {}) } });
    const task = reviewPrompt(input.target, input.focus);
    const limit = this.host.reviewerTimeoutMs?.() ?? 15 * 60_000;
    for (const agentId of agents) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const settle = (o: { ok: boolean; message?: string }) => {
        if (timer) clearTimeout(timer);
        if (run.settled.has(agentId)) return; // a late answer after the time ran out
        run.settled.set(agentId, o);
        if (run.settled.size === agents.length && this.pending.delete(reviewId)) this.finish(reviewId, chat, target, agents, run.settled, run.startedAt);
      };
      // one slow reviewer (a free model in a queue) shouldn't hold everyone's findings hostage
      timer = setTimeout(() => {
        const took = limit >= 60_000 ? `${Math.round(limit / 60_000)} min` : `${Math.round(limit / 1000)}s`;
        settle({ ok: false, message: `took longer than ${took} — left out (review.timeoutMin in .loom/config.json)` });
        void this.host.stopReviewer?.(agentId).catch(() => {});
      }, limit);
      timer.unref?.();
      try {
        await this.host.spawn(parent, { agentId, task, chat, readOnly: true, onSettled: settle });
      } catch (err) {
        settle({ ok: false, message: err instanceof Error ? err.message : String(err) });
      }
    }
    return { reviewId, chat, target, agents, status: "running" };
  }

  /** The reviewer's answer: its last reply in the review's chat. */
  private replyOf(chat: string, agent: string, since: number): string {
    const msgs = this.host.list({ chat, agentId: agent, kinds: ["message"], sinceTs: since }).filter((m) => !m.payload.reasoning && typeof m.payload.text === "string");
    return String(msgs.at(-1)?.payload.text ?? "");
  }

  private editsOf(chat: string, agent: string, since: number): string[] {
    const paths = this.host.list({ chat, agentId: agent, kinds: ["file_edit"], sinceTs: since }).map((e) => String(e.payload.path ?? "")).filter(Boolean);
    return [...new Set(paths)];
  }

  private finish(reviewId: string, chat: string, target: ReviewState["target"], agents: string[], settled: Map<string, { ok: boolean; message?: string }>, since: number): void {
    const results: ReviewResult[] = agents.map((agent) => {
      const s = settled.get(agent);
      const reply = this.replyOf(chat, agent, since);
      const edited = this.editsOf(chat, agent, since);
      // a turn that ended without a word didn't review anything (#278)
      const answered = s?.ok && reply.trim().length > 0;
      const base = answered ? { agent, status: "done" as const, reply: reply.slice(0, 6000) }
        : { agent, status: "failed" as const, error: s?.ok ? "it finished without a reply" : s?.message ?? "no answer", reply: reply.slice(0, 6000) };
      return edited.length ? { ...base, edited } : base;
    });
    const findings = collectFindings(reviewId, results.filter((r) => r.status === "done").map((r) => ({ agent: r.agent, reply: r.reply })));
    this.host.append({ kind: "review", chat, payload: { phase: "done", reviewId, chat, target, results, findings, summary: reviewSummary(results, findings) } });
  }

  private doneEvent(reviewId: string): LoomEvent | undefined {
    return this.host.list({ kinds: ["review"] }).find((e) => e.payload.phase === "done" && e.payload.reviewId === reviewId);
  }

  status(reviewId: string): ReviewState | null {
    const started = this.host.list({ kinds: ["review"] }).find((e) => e.payload.phase === "started" && e.payload.reviewId === reviewId);
    if (!started) return null;
    const base = { reviewId, chat: String(started.payload.chat), target: started.payload.target as ReviewState["target"], agents: started.payload.agents as string[] };
    const done = this.doneEvent(reviewId);
    if (!done) return { ...base, status: "running" };
    const decided = new Map(this.host.list({ kinds: ["review"], chat: base.chat }).filter((e) => e.payload.phase === "decided" && e.payload.reviewId === reviewId)
      .map((e) => [String(e.payload.findingId), { decision: e.payload.decision as FindingDecision, ...(e.payload.note ? { note: String(e.payload.note) } : {}) }]));
    return { ...base, status: "done", results: done.payload.results as ReviewResult[], summary: String(done.payload.summary),
      findings: (done.payload.findings as Finding[]).map((f) => ({ ...f, ...decided.get(f.id) })) };
  }

  /** Accept (it becomes a project decision every agent is briefed with) or reject one finding. */
  decide(findingId: string, decision: FindingDecision, note?: string): { finding: Finding; decision: FindingDecision } {
    if (decision !== "accepted" && decision !== "rejected") throw new Error("accept or reject");
    const reviewId = findingId.split(".")[0]!;
    const done = this.doneEvent(reviewId);
    if (!done) throw new Error(this.status(reviewId) ? "that review is still running" : `no review finding "${findingId}"`);
    const finding = (done.payload.findings as Finding[]).find((f) => f.id === findingId);
    if (!finding) throw new Error(`no finding "${findingId}" in review ${reviewId}`);
    const was = this.status(reviewId)!.findings!.find((f) => f.id === findingId)!.decision;
    this.host.append({ kind: "review", chat: String(done.chat ?? done.payload.chat), payload: { phase: "decided", reviewId, findingId, decision, ...(note ? { note } : {}), text: finding.text } });
    if (decision === "accepted" && was !== "accepted") this.host.decide(decisionText(finding, note));
    return { finding, decision };
  }

  /** The latest reviews, newest first. */
  recent(limit = 10): ReviewState[] {
    return this.host.list({ kinds: ["review"] }).filter((e) => e.payload.phase === "started").slice(-limit).reverse()
      .map((e) => this.status(String(e.payload.reviewId))!).filter(Boolean);
  }
}
