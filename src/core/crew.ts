/**
 * Agent Teams, Phase 1 — a crew for one person, working one goal at a time
 * (docs/proposals/agent-teams.md).
 *
 * A crew is a named set of teammates — roster agents with a role (lead,
 * builder, reviewer, tester, researcher) and a charter. A goal runs the
 * "Ship" play in its own worktree, on its own branch, one turn at a time:
 *
 *   Lead plans cards → (you approve) → for each card in order:
 *     a builder builds it → Loom commits → the reviewer reviews the diff
 *     (changes go back to the same builder, same session) → the tester runs
 *     the tests (a failure goes back to the builder) → the card is done.
 *   Then the Lead writes the summary, and the branch is yours to apply.
 *
 * Everything a teammate does lands in its own thread; the crew's channel gets
 * the plan, the hand-offs, the reviews and anything a teammate posts. You
 * talk to the crew in that channel. Teammates speak the protocol in
 * core/crew-protocol.ts. Parallel builders, per-teammate native sessions and
 * crews across people are later phases (§11).
 */

import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type { Adapter, AgentConfig, ChatInfo, EventKind, LoomEvent } from "../types.js";
import { loomHome, type BoardTask } from "./registry.js";
import { parseCrewReply, protocolFor, type CrewAction, type CrewRole, type PlannedCard } from "./crew-protocol.js";

const exec = promisify(execFile);

export interface CrewTeammate {
  /** Unique within the crew ("lead", "builder-1"). */
  id: string;
  /** A roster agent id. Several teammates may share one; each gets its own session. */
  agent: string;
  role: CrewRole;
  charter?: string;
}

export interface CrewConfig {
  id: string;
  name: string;
  teammates: CrewTeammate[];
  /** The Lead's plan waits for your OK before anyone builds (default on). */
  planApproval?: boolean;
  /** How many times a card may go back to its builder from review or test (default 2). */
  maxRounds?: number;
  /** What the tester runs, when you'd rather say than have it look. */
  testCommand?: string;
  /** Minutes a teammate may go silent before its turn is interrupted and retried once (default 8). */
  stallMinutes?: number;
}

export type CardStage = "planned" | "building" | "review" | "testing" | "done" | "failed";

export interface CrewCard {
  /** The board task id. */
  id: string;
  title: string;
  detail?: string;
  touches?: string[];
  role: CrewRole;
  assignee?: string;
  blockedBy: string[];
  stage: CardStage;
  /** Teammate building it. */
  builder?: string;
  /** Times it went back to the builder. */
  rounds: number;
  /** What the builder is told next (review notes, test failures, your messages). */
  feedback: string[];
  commits: string[];
  summary?: string;
  error?: string;
}

export type GoalStatus = "planning" | "awaiting_approval" | "running" | "waiting_human" | "completed" | "failed" | "stopped" | "interrupted";

export interface CrewGoal {
  id: string;
  text: string;
  status: GoalStatus;
  /** Branch and worktree the goal is built in, cut from `base`. */
  branch: string;
  dir: string;
  base: string;
  baseBranch: string;
  cards: CrewCard[];
  /** What is happening right now (a card's stage, or the plan). */
  current?: { teammate: string; card?: string; step: string };
  question?: { teammate: string; text: string; step: "plan" | "card" };
  summary?: string;
  error?: string;
  /** Plan turns that came back without a plan. */
  rounds?: number;
  costUsd: number;
  startedAt: number;
  finishedAt?: number;
  applied?: { into: string; at: number };
}

export interface CrewState {
  id: string;
  channel: string;
  threads: Record<string, string>;
  goal?: CrewGoal;
  history: Array<{ id: string; text: string; status: GoalStatus; summary?: string; finishedAt?: number; branch: string }>;
  /** Messages for a teammate's next turn (from you, or posted by another teammate). */
  notes: Record<string, string[]>;
}

export interface CrewView extends CrewConfig {
  state: CrewState;
  busy: boolean;
}

export interface CrewHost {
  projectId: string;
  projectName: string;
  projectDir: string;
  crews(): CrewConfig[];
  saveCrews(crews: CrewConfig[]): void;
  roster(): AgentConfig[];
  makeAgent(cfg: AgentConfig, dir: string): Adapter;
  append(e: { kind: EventKind; agentId?: string; chat?: string; payload: Record<string, unknown> }): LoomEvent;
  createChat(title: string, opts?: { agentId?: string }): ChatInfo;
  chatExists(id: string): boolean;
  briefingFor(query: string, agentId: string): string | Promise<string>;
  gate(agentId: string): void;
  observe(event: LoomEvent): void;
  stream?(f: { agentId: string; chat: string; text: string; reasoning?: boolean }): void;
  createTask(input: { title: string; column?: string; agent?: string; blockedBy?: string[] }): BoardTask;
  updateTask(id: string, patch: Record<string, unknown>): BoardTask | null;
  /** The GitHub login running this daemon, when on a team (commit trailers). */
  member?(): string | null;
  /** Tests: how long silence counts as a stall, in ms (else the crew's stallMinutes, else 8 min). */
  stallMs?: number;
  /** How long a crew's test command may run (default 10 min). */
  testTimeoutMs?: number;
}

/** Templates (§5.1): which roles, and which agent kinds each prefers, in order. */
const TEMPLATES: Record<string, Array<{ id: string; role: CrewRole; prefer: string[]; charter?: string }>> = {
  ship: [
    { id: "lead", role: "lead", prefer: ["claude-code", "codex", "opencode"] },
    { id: "builder-1", role: "builder", prefer: ["codex", "opencode", "claude-code"] },
    { id: "builder-2", role: "builder", prefer: ["opencode", "codex", "claude-code"] },
    { id: "reviewer", role: "reviewer", prefer: ["claude-code", "codex", "opencode"], charter: "Be strict: cite file:line for every problem. Approve only what you'd merge." },
    { id: "tester", role: "tester", prefer: ["opencode", "codex", "claude-code"] },
  ],
  fix: [
    { id: "lead", role: "lead", prefer: ["codex", "claude-code", "opencode"] },
    { id: "builder", role: "builder", prefer: ["codex", "claude-code", "opencode"] },
    { id: "tester", role: "tester", prefer: ["opencode", "codex", "claude-code"] },
  ],
  research: [
    { id: "lead", role: "lead", prefer: ["claude-code", "codex", "opencode"] },
    { id: "researcher-1", role: "researcher", prefer: ["opencode", "codex", "claude-code"] },
    { id: "researcher-2", role: "researcher", prefer: ["codex", "opencode", "claude-code"] },
  ],
  solo: [
    { id: "builder", role: "builder", prefer: ["codex", "opencode", "claude-code"] },
    { id: "reviewer", role: "reviewer", prefer: ["claude-code", "opencode", "codex"] },
  ],
};
export const CREW_TEMPLATES = Object.keys(TEMPLATES);

/** Fill a template's roles from the roster; the reviewer avoids the builders' vendor when it can. */
export function teammatesFromTemplate(template: string, roster: AgentConfig[]): CrewTeammate[] {
  const slots = TEMPLATES[template];
  if (!slots) throw new Error(`no crew template "${template}" (${CREW_TEMPLATES.join(", ")})`);
  if (!roster.length) throw new Error("this project has no agents to put on a crew");
  const byKind = (kind: string) => roster.find((a) => a.kind === kind);
  const out: CrewTeammate[] = [];
  for (const s of slots) {
    let pick = s.prefer.map(byKind).find(Boolean) ?? roster[0]!;
    if (s.role === "reviewer") {
      const builderKinds = new Set(out.filter((t) => t.role === "builder").map((t) => roster.find((a) => a.id === t.agent)?.kind));
      const other = roster.find((a) => !builderKinds.has(a.kind) && s.prefer.includes(a.kind)) ?? roster.find((a) => !builderKinds.has(a.kind));
      if (other) pick = other;
    }
    out.push({ id: s.id, agent: pick.id, role: s.role, ...(s.charter ? { charter: s.charter } : {}) });
  }
  return out;
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "crew";
const newId = () => `g${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
const terminal = (s: GoalStatus) => s === "completed" || s === "failed" || s === "stopped";
const TURN_TEXT_CAP = 40_000;

/** Run a crew's test command in the worktree: ok when it exits 0; the output's tail either way. */
function runTests(command: string, cwd: string, timeoutMs: number): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    execFile("/bin/sh", ["-c", command], { cwd, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, CI: "1", NO_COLOR: "1", FORCE_COLOR: "0" } },
      (err, stdout, stderr) => {
        const output = `${stdout}${stderr ? `\n${stderr}` : ""}`.trim().slice(-8000);
        const timedOut = Boolean(err && (err as NodeJS.ErrnoException & { killed?: boolean }).killed);
        resolve({ ok: !err, output: timedOut ? `${output}\n(timed out after ${Math.round(timeoutMs / 1000)}s)` : output || (err ? err.message : "") });
      });
  });
}

async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await exec("git", args, { cwd, maxBuffer: 32 * 1024 * 1024 });
  return stdout;
}

export class CrewEngine {
  private states = new Map<string, CrewState>();
  /** Live adapters for the active goal: `${crew}/${teammate}`. */
  private agents = new Map<string, Adapter>();
  private running = new Set<string>();
  private turnText = new Map<string, string>();
  private turnError = new Map<string, string>();
  private turnQuestion = new Map<string, string>();
  private currentTurn = new Map<string, string>();
  /** When each live teammate last showed a sign of life (any event or streamed text). */
  private lastActivity = new Map<string, number>();
  private gitChain: Promise<unknown> = Promise.resolve();
  private closed = false;

  constructor(private readonly host: CrewHost) {
    // A goal that was mid-turn when Loom stopped is interrupted, not lost:
    // `resume` carries on from the step it was on.
    for (const cfg of host.crews()) {
      const st = this.load(cfg.id);
      if (st?.goal && ["planning", "running"].includes(st.goal.status)) {
        st.goal.status = "interrupted";
        this.save(st);
      }
    }
  }

  // ── config ──

  /** The agents a teammate can be. */
  roster(): AgentConfig[] {
    return this.host.roster();
  }

  list(): CrewView[] {
    return this.host.crews().map((c) => ({ ...c, state: this.state(c), busy: this.running.has(c.id) }));
  }

  get(id: string): CrewView {
    const c = this.config(id);
    return { ...c, state: this.state(c), busy: this.running.has(c.id) };
  }

  create(input: { name?: string; template?: string; teammates?: CrewTeammate[]; planApproval?: boolean; testCommand?: string }): CrewView {
    const roster = this.host.roster();
    const teammates = input.teammates?.length ? input.teammates : teammatesFromTemplate(input.template ?? "ship", roster);
    this.validate(teammates, roster);
    const name = (input.name ?? "").trim() || `${(input.template ?? "ship").replace(/^./, (c) => c.toUpperCase())} crew`;
    const existing = this.host.crews();
    let id = slug(name);
    for (let n = 2; existing.some((c) => c.id === id); n++) id = `${slug(name)}-${n}`;
    const cfg: CrewConfig = {
      id,
      name: name.slice(0, 60),
      teammates,
      ...(input.planApproval === false ? { planApproval: false } : {}),
      ...(input.testCommand ? { testCommand: input.testCommand.slice(0, 300) } : {}),
    };
    this.host.saveCrews([...existing, cfg]);
    return this.get(id);
  }

  update(id: string, patch: { name?: string; teammates?: CrewTeammate[]; planApproval?: boolean; testCommand?: string | null; stallMinutes?: number | null }): CrewView {
    const crews = this.host.crews();
    const cfg = crews.find((c) => c.id === id);
    if (!cfg) throw new Error(`no crew "${id}"`);
    if (this.running.has(id)) throw new Error(`${cfg.name} is working — stop it before changing the crew`);
    if (patch.teammates) {
      this.validate(patch.teammates, this.host.roster());
      cfg.teammates = patch.teammates;
    }
    if (patch.name?.trim()) cfg.name = patch.name.trim().slice(0, 60);
    if (patch.planApproval !== undefined) {
      if (patch.planApproval) delete cfg.planApproval;
      else cfg.planApproval = false;
    }
    if (patch.testCommand !== undefined) {
      if (patch.testCommand) cfg.testCommand = patch.testCommand.slice(0, 300);
      else delete cfg.testCommand;
    }
    if (patch.stallMinutes !== undefined) {
      if (patch.stallMinutes && patch.stallMinutes > 0) cfg.stallMinutes = Math.min(patch.stallMinutes, 240);
      else delete cfg.stallMinutes;
    }
    this.host.saveCrews(crews);
    // every client showing this crew should redraw it (a phone, the other window)
    const st = this.state(cfg);
    this.host.append({ kind: "crew", chat: st.channel, payload: { phase: "updated", crewId: cfg.id, crew: cfg.name } });
    return this.get(id);
  }

  async remove(id: string): Promise<void> {
    const cfg = this.config(id);
    if (this.running.has(id)) throw new Error(`${cfg.name} is working — stop it first`);
    const st = this.load(id);
    if (st?.goal?.dir) await this.dropWorktree(st.goal).catch(() => {});
    this.host.saveCrews(this.host.crews().filter((c) => c.id !== id));
    fs.rmSync(this.stateFile(id), { force: true });
    this.states.delete(id);
  }

  private validate(teammates: CrewTeammate[], roster: AgentConfig[]): void {
    if (!teammates.length) throw new Error("a crew needs at least one teammate");
    if (teammates.length > 8) throw new Error("a crew has at most 8 teammates");
    const ids = new Set<string>();
    for (const t of teammates) {
      if (!/^[a-z0-9][a-z0-9-]{0,30}$/.test(t.id)) throw new Error(`teammate id "${t.id}" — use lowercase letters, digits and dashes`);
      if (ids.has(t.id)) throw new Error(`two teammates are called "${t.id}"`);
      ids.add(t.id);
      if (!roster.some((a) => a.id === t.agent)) throw new Error(`"${t.agent}" isn't an agent on this project's roster`);
    }
    if (teammates.filter((t) => t.role === "lead").length > 1) throw new Error("a crew has one lead");
    if (!teammates.some((t) => t.role === "lead" || t.role === "builder" || t.role === "researcher"))
      throw new Error("a crew needs someone who does the work: a lead, a builder or a researcher");
  }

  // ── talking to it ──

  /** Give the crew a goal. It plans in the channel and (by default) waits for your OK. */
  async goal(id: string, text: string): Promise<CrewGoal> {
    const cfg = this.config(id);
    const st = this.state(cfg);
    if (!text.trim()) throw new Error("what should the crew do?");
    if (st.goal && !terminal(st.goal.status)) throw new Error(`${cfg.name} is already on a goal — finish, stop or apply it first`);
    if (st.goal) this.archive(st);
    // every teammate must be allowed to run (budget, quarantine, continuity) before anything is set up
    for (const t of cfg.teammates) this.host.gate(t.agent);
    const gid = newId();
    const baseBranch = (await git(["rev-parse", "--abbrev-ref", "HEAD"], this.host.projectDir).catch(() => "")).trim();
    const base = (await git(["rev-parse", "HEAD"], this.host.projectDir).catch(() => "")).trim();
    if (!base) throw new Error("a crew works in git — make a first commit in this project");
    const branch = `loom/crew/${cfg.id}/${gid}`;
    const dir = path.join(loomHome(), "crews", this.host.projectId, cfg.id, gid);
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    await this.serial(() => git(["worktree", "add", "-q", "-b", branch, dir, base], this.host.projectDir));
    const goal: CrewGoal = { id: gid, text: text.trim().slice(0, 8000), status: "planning", branch, dir, base, baseBranch, cards: [], costUsd: 0, startedAt: Date.now() };
    st.goal = goal;
    st.notes = {};
    this.save(st);
    this.host.append({ kind: "message", chat: st.channel, payload: { text: goal.text, author: "user", crew: { crewId: cfg.id, goalId: gid } } });
    this.phase(cfg, st, "goal_started", { branch, text: goal.text });
    this.drive(cfg.id);
    return goal;
  }

  /**
   * You, in the channel. With no goal on, it becomes the goal; while the crew
   * waits on a question it's the answer; otherwise it's a note for the
   * teammate you name (or the Lead) on its next turn.
   */
  async say(id: string, text: string, to?: string): Promise<{ routed: "goal" | "answer" | "note" | "replan"; to?: string }> {
    const cfg = this.config(id);
    const st = this.state(cfg);
    const body = text.trim();
    if (!body) throw new Error("say something");
    const target = to?.replace(/^@/, "") || (/^@([a-z0-9-]+)\s/.exec(body)?.[1] ?? undefined);
    if (target && !cfg.teammates.some((t) => t.id === target)) throw new Error(`no teammate "${target}" on ${cfg.name}`);
    const g = st.goal;
    if (!g || terminal(g.status)) {
      await this.goal(id, body);
      return { routed: "goal" };
    }
    this.host.append({ kind: "message", chat: st.channel, payload: { text: body, author: "user", crew: { crewId: cfg.id, goalId: g.id, ...(target ? { to: target } : {}) } } });
    if (g.status === "waiting_human" && g.question && (!target || target === g.question.teammate)) {
      (st.notes[g.question.teammate] ??= []).push(`Your question was: ${g.question.text}\nThe answer: ${body}`);
      g.status = g.question.step === "plan" ? "planning" : "running";
      g.question = undefined;
      this.save(st);
      this.drive(id);
      return { routed: "answer", to: target };
    }
    if (g.status === "awaiting_approval" && (!target || target === this.lead(cfg)?.id)) {
      // Feedback on the plan: the Lead plans again with it.
      const lead = this.lead(cfg) ?? cfg.teammates[0]!;
      (st.notes[lead.id] ??= []).push(`Feedback on your plan: ${body}`);
      for (const c of g.cards) this.host.updateTask(c.id, { column: "ready", title: `[superseded] ${c.title}`.slice(0, 200) });
      g.cards = [];
      g.status = "planning";
      this.save(st);
      this.drive(id);
      return { routed: "replan", to: lead.id };
    }
    const who = target ?? this.lead(cfg)?.id ?? cfg.teammates[0]!.id;
    (st.notes[who] ??= []).push(`From the person you work for: ${body}`);
    this.save(st);
    return { routed: "note", to: who };
  }

  /** OK the Lead's plan: building starts. */
  approve(id: string): CrewGoal {
    const cfg = this.config(id);
    const st = this.state(cfg);
    const g = st.goal;
    if (!g || g.status !== "awaiting_approval") throw new Error(`${cfg.name} has no plan waiting for approval`);
    g.status = "running";
    this.save(st);
    this.phase(cfg, st, "plan_approved", { cards: g.cards.length });
    this.drive(id);
    return g;
  }

  /** Stop: the current turn is interrupted, and the goal ends where it is (its branch stays). */
  async stop(id: string): Promise<CrewGoal> {
    const cfg = this.config(id);
    const st = this.state(cfg);
    const g = st.goal;
    if (!g || terminal(g.status)) throw new Error(`${cfg.name} isn't on a goal`);
    g.status = "stopped";
    g.finishedAt = Date.now();
    this.save(st);
    const key = this.currentTurn.get(id);
    if (key) await this.agents.get(key)?.interrupt().catch(() => {});
    this.phase(cfg, st, "stopped", {});
    return g;
  }

  /** Carry on an interrupted (or stopped) goal from the step it was on. */
  resume(id: string): CrewGoal {
    const cfg = this.config(id);
    const st = this.state(cfg);
    const g = st.goal;
    if (!g || !["interrupted", "stopped", "failed"].includes(g.status)) throw new Error(`${cfg.name} has nothing to resume`);
    if (!fs.existsSync(g.dir)) throw new Error("the goal's worktree is gone — start the goal again");
    g.status = g.cards.length ? "running" : "planning";
    g.error = undefined;
    g.finishedAt = undefined;
    for (const c of g.cards) if (c.stage === "failed") { c.stage = c.commits.length ? "review" : "planned"; c.error = undefined; c.rounds = 0; }
    this.save(st);
    this.phase(cfg, st, "resumed", {});
    this.drive(id);
    return g;
  }

  /** Merge a finished goal's branch into the branch you're on. */
  async apply(id: string): Promise<{ merged: string; into: string }> {
    const cfg = this.config(id);
    const st = this.state(cfg);
    const g = st.goal;
    if (!g || g.status !== "completed") throw new Error(`${cfg.name} has no finished goal to apply`);
    if (g.applied) throw new Error(`already applied to ${g.applied.into}`);
    const into = (await git(["rev-parse", "--abbrev-ref", "HEAD"], this.host.projectDir)).trim();
    await this.serial(async () => {
      try {
        await git(["-c", "user.name=Loom Crew", "-c", "user.email=crew@loom.local", "merge", "--no-ff", "--no-edit", "-m",
          `Merge ${cfg.name}: ${g.text.split("\n")[0]!.slice(0, 60)}`, g.branch], this.host.projectDir);
      } catch (err) {
        await git(["merge", "--abort"], this.host.projectDir).catch(() => {});
        throw new Error(`merge into ${into} failed — ${(err as Error).message.split("\n")[0]}`);
      }
    });
    g.applied = { into, at: Date.now() };
    this.save(st);
    this.phase(cfg, st, "applied", { into });
    await this.dropWorktree(g).catch(() => {});
    return { merged: g.branch, into };
  }

  async shutdown(): Promise<void> {
    this.closed = true;
    for (const a of this.agents.values()) await Promise.resolve(a.stop()).catch(() => {});
    this.agents.clear();
  }

  // ── the play ──

  private drive(id: string): void {
    if (this.running.has(id) || this.closed) return;
    this.running.add(id);
    void this.loop(id)
      .catch((err) => {
        const cfg = this.host.crews().find((c) => c.id === id);
        if (!cfg) return;
        const st = this.state(cfg);
        if (st.goal && !terminal(st.goal.status)) this.finish(cfg, st, "failed", (err as Error).message);
      })
      .finally(() => this.running.delete(id));
  }

  private async loop(id: string): Promise<void> {
    for (;;) {
      if (this.closed) return;
      const cfg = this.host.crews().find((c) => c.id === id);
      if (!cfg) return;
      const st = this.state(cfg);
      const g = st.goal;
      if (!g) return;
      if (g.status === "planning") {
        await this.plan(cfg, st, g);
        continue;
      }
      if (g.status !== "running") return;
      const done = new Set(g.cards.filter((c) => c.stage === "done").map((c) => c.id));
      const next = g.cards.find((c) => c.stage !== "done" && c.stage !== "failed" && c.blockedBy.every((b) => done.has(b)));
      if (!next) {
        if (g.cards.every((c) => c.stage === "done")) await this.wrapUp(cfg, st, g);
        else this.finish(cfg, st, "failed", g.cards.some((c) => c.stage === "failed") ? "a card failed and the rest wait on it" : "the cards wait on each other");
        return;
      }
      await this.work(cfg, st, g, next);
    }
  }

  private async plan(cfg: CrewConfig, st: CrewState, g: CrewGoal): Promise<void> {
    const lead = this.lead(cfg);
    if (!lead) {
      // No Lead: the goal is the one card, for the first builder.
      this.addCards(cfg, st, g, [{ title: g.text.split("\n")[0]!.slice(0, 120), detail: g.text, role: "builder" }]);
      g.status = "running";
      this.save(st);
      return;
    }
    const prompt = [
      `New goal for ${cfg.name}:`,
      g.text,
      "",
      "Plan it into cards: 1–6 small cards, each one coherent change a builder can finish in one go, in the order they should be built.",
      "Give each card what it touches (path globs) and which card titles it waits for. Don't edit any files yet.",
    ].join("\n");
    const reply = await this.turn(cfg, st, g, lead, prompt, "plan");
    if (reply === null || g.status !== "planning") return;
    if (reply.asked) return;
    const plan = reply.actions.find((a): a is Extract<CrewAction, { type: "plan" }> => a.type === "plan");
    if (!plan) {
      g.rounds = (g.rounds ?? 0) + 1;
      if ((g.rounds ?? 0) >= 2) {
        // No plan twice: the goal becomes one card, rather than a crew stuck asking.
        this.addCards(cfg, st, g, [{ title: g.text.split("\n")[0]!.slice(0, 120), detail: g.text, role: "builder" }]);
      } else {
        (st.notes[lead.id] ??= []).push("Your reply had no plan action. Answer with the ```loom block and a plan action.");
        this.save(st);
        return;
      }
    } else this.addCards(cfg, st, g, plan.cards);
    g.status = cfg.planApproval === false ? "running" : "awaiting_approval";
    this.save(st);
    this.phase(cfg, st, "planned", { cards: g.cards.map((c) => ({ id: c.id, title: c.title, role: c.role })), awaitingApproval: g.status === "awaiting_approval" });
  }

  private addCards(cfg: CrewConfig, st: CrewState, g: CrewGoal, planned: PlannedCard[]): void {
    const made: CrewCard[] = [];
    planned.forEach((p) => {
      const task = this.host.createTask({ title: p.title, column: "ready" });
      this.host.updateTask(task.id, { crew: cfg.id, goal: g.id, stage: "planned" });
      made.push({ id: task.id, title: p.title, ...(p.detail ? { detail: p.detail } : {}), ...(p.touches ? { touches: p.touches } : {}),
        role: p.role ?? "builder", ...(p.assignee ? { assignee: p.assignee } : {}), blockedBy: [], stage: "planned", rounds: 0, feedback: [], commits: [] });
    });
    // "waits for" names cards by title or 1-based position in the plan
    planned.forEach((p, i) => {
      for (const ref of p.blockedBy ?? []) {
        const n = Number(ref);
        const dep = Number.isInteger(n) && n >= 1 && n <= made.length ? made[n - 1] : made.find((c) => c.title.toLowerCase() === ref.toLowerCase());
        if (dep && dep !== made[i] && !made[i]!.blockedBy.includes(dep.id)) made[i]!.blockedBy.push(dep.id);
      }
    });
    g.cards.push(...made);
  }

  /** One card through build → review → test. */
  private async work(cfg: CrewConfig, st: CrewState, g: CrewGoal, card: CrewCard): Promise<void> {
    const maxRounds = cfg.maxRounds ?? 2;
    if (card.stage === "planned" || card.stage === "building") {
      const builder = this.builderFor(cfg, g, card);
      card.builder = builder.id;
      card.stage = "building";
      this.host.updateTask(card.id, { column: "working", agent: builder.agent, claimedBy: builder.id, stage: "building" });
      this.save(st);
      if (card.rounds === 0 && !card.feedback.length) this.phase(cfg, st, "claimed", { card: card.id, title: card.title, teammate: builder.id });
      const feedback = card.feedback.splice(0);
      const prompt = feedback.length
        ? [`Back to you on "${card.title}":`, ...feedback, "", "Fix it in this worktree, then report."].join("\n")
        : [`Your card: ${card.title}`, card.detail ?? "", card.touches?.length ? `It touches: ${card.touches.join(", ")}` : "", "", `The goal it serves: ${g.text}`].filter(Boolean).join("\n");
      const reply = await this.turn(cfg, st, g, builder, prompt, "card", card);
      if (reply === null || reply.asked || g.status !== "running") return;
      const done = reply.actions.find((a): a is Extract<CrewAction, { type: "done" }> => a.type === "done");
      card.summary = done?.summary || reply.text.slice(0, 600);
      if (reply.error) {
        card.stage = "failed";
        card.error = reply.error;
        this.host.updateTask(card.id, { column: "needs-you", stage: "failed" });
        this.save(st);
        this.phase(cfg, st, "card_failed", { card: card.id, title: card.title, error: reply.error });
        return;
      }
      const sha = await this.commit(cfg, g, card, builder);
      if (sha) card.commits.push(sha);
      card.stage = this.reviewer(cfg) ? "review" : this.tests(cfg) ? "testing" : "done";
      this.save(st);
    }
    if (card.stage === "review") {
      const reviewer = this.reviewer(cfg)!;
      this.host.updateTask(card.id, { column: "in-review", stage: "review" });
      const diff = await this.cardDiff(g, card);
      const prompt = [
        `Review "${card.title}" (built by ${card.builder}).`,
        card.detail ?? "",
        card.summary ? `What the builder says it did: ${card.summary}` : "",
        "",
        diff ? "The change:\n```diff\n" + diff + "\n```" : "The builder changed no files.",
      ].filter(Boolean).join("\n");
      const reply = await this.turn(cfg, st, g, reviewer, prompt, "card", card);
      if (reply === null || reply.asked || g.status !== "running") return;
      // a review that errored is no review — never an approval
      if (reply.error) return this.giveUp(cfg, st, card, `review didn't happen: ${reply.error}`);
      const review = reply.actions.find((a): a is Extract<CrewAction, { type: "review" }> => a.type === "review");
      const verdict = review?.verdict ?? "approve";
      this.phase(cfg, st, "reviewed", { card: card.id, title: card.title, teammate: reviewer.id, verdict, notes: review?.notes ?? "" });
      if (verdict === "changes") {
        if (card.rounds >= maxRounds) return this.giveUp(cfg, st, card, `review still wants changes after ${card.rounds} rounds: ${review?.notes ?? ""}`);
        card.rounds++;
        card.feedback.push(`The reviewer (${reviewer.id}) asks for changes:\n${review?.notes ?? ""}`);
        card.stage = "building";
        this.save(st);
        return;
      }
      card.stage = this.tests(cfg) ? "testing" : "done";
      this.save(st);
    }
    if (card.stage === "testing") {
      this.host.updateTask(card.id, { column: "in-review", stage: "testing" });
      let result: "pass" | "fail";
      let log: string;
      let who: string;
      if (cfg.testCommand) {
        // A test command is a fact, not an opinion: Loom runs it in the worktree
        // itself — no model to misread it, no agent sandbox to block a server
        // the tests start — and the exit code decides.
        g.current = { teammate: "loom", card: card.id, step: "testing" };
        this.save(st);
        const out = await runTests(cfg.testCommand, g.dir, this.host.testTimeoutMs ?? 10 * 60_000);
        if (terminal(g.status) || this.closed || g.status !== "running") return;
        result = out.ok ? "pass" : "fail";
        log = out.output;
        who = "loom";
      } else {
        const tester = this.tester(cfg)!;
        const prompt = [
          `Test the work so far for "${card.title}" in this worktree.`,
          "Run the project's tests (look at package.json scripts, Makefile, pytest, cargo…). Don't change source files.",
          "Report pass or fail with the last lines of output.",
        ].join("\n");
        const reply = await this.turn(cfg, st, g, tester, prompt, "card", card);
        if (reply === null || reply.asked || g.status !== "running") return;
        if (reply.error) return this.giveUp(cfg, st, card, `tests didn't run: ${reply.error}`);
        const test = reply.actions.find((a): a is Extract<CrewAction, { type: "test" }> => a.type === "test");
        result = test?.result ?? "pass";
        log = test?.log ?? "";
        who = tester.id;
        // a tester's own edits (a fixture, a snapshot) are part of the card
        const sha = await this.commit(cfg, g, card, tester, "tests");
        if (sha) card.commits.push(sha);
      }
      this.phase(cfg, st, "tested", { card: card.id, title: card.title, teammate: who, result, log: log.slice(-1200), ...(cfg.testCommand ? { command: cfg.testCommand } : {}) });
      if (result === "fail") {
        if (card.rounds >= maxRounds) return this.giveUp(cfg, st, card, `tests still fail after ${card.rounds} rounds`);
        card.rounds++;
        card.feedback.push(`The tests fail (${who}${cfg.testCommand ? `: ${cfg.testCommand}` : ""}):\n${log.slice(-3000)}`);
        card.stage = "building";
        this.save(st);
        return;
      }
      card.stage = "done";
    }
    if (card.stage === "done") {
      this.host.updateTask(card.id, { column: "ready", stage: "done" });
      this.save(st);
      this.phase(cfg, st, "card_done", { card: card.id, title: card.title, teammate: card.builder });
    }
  }

  private giveUp(cfg: CrewConfig, st: CrewState, card: CrewCard, why: string): void {
    card.stage = "failed";
    card.error = why.slice(0, 1000);
    this.host.updateTask(card.id, { column: "needs-you", stage: "failed" });
    this.save(st);
    this.phase(cfg, st, "card_failed", { card: card.id, title: card.title, error: card.error });
  }

  private async wrapUp(cfg: CrewConfig, st: CrewState, g: CrewGoal): Promise<void> {
    const lead = this.lead(cfg);
    let summary = g.cards.map((c) => `- ${c.title}${c.summary ? `: ${c.summary.split("\n")[0]!.slice(0, 160)}` : ""}`).join("\n");
    if (lead) {
      const prompt = ["Every card is built, reviewed and tested:", summary, "", "Write the summary of this goal for its pull request."].join("\n");
      const reply = await this.turn(cfg, st, g, lead, prompt, "card");
      if (reply === null || g.status !== "running") return;
      const done = reply.actions.find((a): a is Extract<CrewAction, { type: "done" }> => a.type === "done");
      if (done?.summary) summary = done.summary;
    }
    g.summary = summary;
    this.finish(cfg, st, "completed");
  }

  private finish(cfg: CrewConfig, st: CrewState, status: "completed" | "failed", error?: string): void {
    const g = st.goal!;
    g.status = status;
    g.finishedAt = Date.now();
    g.current = undefined;
    if (error) g.error = error.slice(0, 2000);
    this.save(st);
    this.phase(cfg, st, status === "completed" ? "completed" : "failed", {
      branch: g.branch, cards: g.cards.length, ...(g.summary ? { summary: g.summary } : {}), ...(error ? { error } : {}), costUsd: g.costUsd,
    });
    void this.stopAgents(cfg.id);
  }

  // ── one turn ──

  /**
   * Send one teammate one prompt in the goal's worktree and wait for the turn.
   * Its role, charter, crewmates, protocol and any notes ride in the briefing.
   * Null when the goal stopped meanwhile.
   */
  private async turn(cfg: CrewConfig, st: CrewState, g: CrewGoal, tm: CrewTeammate, prompt: string, step: "plan" | "card", card?: CrewCard, retried = false):
    Promise<{ text: string; actions: CrewAction[]; asked: boolean; error?: string } | null> {
    const key = `${cfg.id}/${tm.id}/${tm.agent}`;
    const rosterCfg = this.host.roster().find((a) => a.id === tm.agent);
    if (!rosterCfg) throw new Error(`teammate ${tm.id}'s agent "${tm.agent}" is no longer on the roster`);
    this.host.gate(tm.agent);
    let agent = this.agents.get(key);
    const fresh = !agent;
    if (!agent) {
      // Its own instance and state slot, so two teammates on one agent kind keep separate sessions.
      // The seat *and* the agent in it: swap a teammate's agent and the old one's
      // saved session (an opencode ses_…, say) never reaches the new one.
      agent = this.host.makeAgent({ ...rosterCfg, id: `crew-${cfg.id}-${tm.id}.${rosterCfg.id}`.slice(0, 80), role: tm.role }, g.dir);
      this.agents.set(key, agent);
      this.wire(cfg, st, g, agent, tm, key);
      await agent.start();
    }
    const chat = this.thread(cfg, st, tm);
    g.current = { teammate: tm.id, step: card ? card.stage : "plan", ...(card ? { card: card.id } : {}) };
    this.save(st);
    const notes = (st.notes[tm.id] ?? []).splice(0);
    this.save(st);
    const briefing = [
      await this.briefing(cfg, tm, g, fresh),
      notes.length ? `Messages for you:\n${notes.map((n) => `- ${n}`).join("\n")}` : "",
    ].filter(Boolean).join("\n\n");
    this.host.append({ kind: "message", chat, payload: { text: prompt, author: "loom", crew: { crewId: cfg.id, goalId: g.id, teammate: tm.id, ...(card ? { card: card.id } : {}) } } });
    this.turnText.set(key, "");
    this.turnError.delete(key);
    this.turnQuestion.delete(key);
    this.currentTurn.set(cfg.id, key);
    // A teammate that goes silent (a model that never answers) would hold the
    // goal forever: interrupt it, and give the turn one more try.
    const stallMs = this.host.stallMs ?? (cfg.stallMinutes ?? 8) * 60_000;
    let stalled = false;
    this.lastActivity.set(key, Date.now());
    const watchdog = setInterval(() => {
      if (Date.now() - (this.lastActivity.get(key) ?? Date.now()) < stallMs) return;
      stalled = true;
      clearInterval(watchdog);
      void agent!.interrupt().catch(() => {});
    }, Math.max(20, Math.min(15_000, stallMs / 4)));
    watchdog.unref?.();
    try {
      await agent.send({ text: prompt, briefing });
    } catch (err) {
      // an agent that throws (it won't start, it can't resume) fails this turn, not the whole goal
      this.turnError.set(key, (err as Error).message.slice(0, 1000));
    } finally {
      clearInterval(watchdog);
      this.currentTurn.delete(cfg.id);
    }
    if (terminal(g.status) || this.closed) return null;
    if (stalled) {
      const mins = Math.max(1, Math.round(stallMs / 60_000));
      if (!retried) {
        this.phase(cfg, st, "stalled", { teammate: tm.id, ...(card ? { card: card.id, title: card.title } : {}), retrying: true });
        (st.notes[tm.id] ??= []).push("Your last turn produced nothing and was stopped. Please try again.");
        return this.turn(cfg, st, g, tm, prompt, step, card, true);
      }
      this.phase(cfg, st, "stalled", { teammate: tm.id, ...(card ? { card: card.id, title: card.title } : {}), retrying: false });
      this.turnError.set(key, `${tm.id} went silent twice (no output for ${stallMs < 60_000 ? `${Math.round(stallMs / 1000)}s` : `${mins} min`}) — its agent may be down or rate-limited`);
    }
    const text = (this.turnText.get(key) ?? "").trim();
    const error = this.turnError.get(key);
    // A provider hiccup (a dropped stream, a 5xx) shouldn't sink a card: one more try.
    if (error && !stalled && !retried) {
      this.phase(cfg, st, "retrying", { teammate: tm.id, error: error.slice(0, 300), ...(card ? { card: card.id, title: card.title } : {}) });
      return this.turn(cfg, st, g, tm, prompt, step, card, true);
    }
    const parsed = parseCrewReply(text, tm.role);
    for (const a of parsed.allowed) if (a.type === "post") this.post(cfg, st, g, tm, a.text, a.to);
    if (parsed.refused.length) {
      (st.notes[tm.id] ??= []).push(`As ${tm.role} you can't ${[...new Set(parsed.refused.map((a) => a.type))].join(" or ")} — Loom ignored ${parsed.refused.length === 1 ? "that action" : "those actions"}.`);
    }
    const asked = parsed.allowed.find((a): a is Extract<CrewAction, { type: "ask" }> => a.type === "ask")?.question ?? this.turnQuestion.get(key);
    if (asked && !error) {
      g.status = "waiting_human";
      g.question = { teammate: tm.id, text: asked, step };
      this.save(st);
      this.phase(cfg, st, "asks", { teammate: tm.id, question: asked });
      return { text, actions: parsed.allowed, asked: true };
    }
    this.save(st);
    return { text, actions: parsed.allowed, asked: false, ...(error ? { error } : {}) };
  }

  private wire(cfg: CrewConfig, st: CrewState, g: CrewGoal, agent: Adapter, tm: CrewTeammate, key: string): void {
    agent.onStream?.((d) => {
      this.lastActivity.set(key, Date.now());
      this.host.stream?.({ agentId: tm.agent, chat: this.thread(cfg, st, tm), ...d });
    });
    agent.onEvent((e) => {
      this.lastActivity.set(key, Date.now());
      const p = e.payload as Record<string, unknown>;
      if (e.kind === "message" && !p.reasoning && p.role !== "user") {
        const prev = this.turnText.get(key) ?? "";
        const next = `${prev}\n${String(p.text ?? "")}`;
        this.turnText.set(key, next.length > TURN_TEXT_CAP ? next.slice(-TURN_TEXT_CAP) : next);
      }
      if (e.kind === "error") this.turnError.set(key, String(p.message ?? "error").slice(0, 1000));
      // A teammate that stops to ask in its own UI would wait forever: take the
      // question to the channel and end the turn.
      if (e.kind === "needs_input" && !this.turnQuestion.has(key)) {
        this.turnQuestion.set(key, String(p.question ?? "the teammate needs input").slice(0, 1000));
        void agent.interrupt().catch(() => {});
      }
      const event = this.host.append({ kind: e.kind, agentId: tm.agent, chat: this.thread(cfg, st, tm),
        payload: { ...p, crew: { crewId: cfg.id, goalId: g.id, teammate: tm.id } } });
      if (e.kind === "status" && p.state === "turn_cost") g.costUsd += Number(p.costUsd ?? 0) || 0;
      this.host.observe(event);
    });
  }

  private async briefing(cfg: CrewConfig, tm: CrewTeammate, g: CrewGoal, fresh: boolean): Promise<string> {
    const lines = [
      `You are ${tm.id}, the ${tm.role} on ${cfg.name} — a crew of agents working in the project "${this.host.projectName}".`,
      `The crew: ${cfg.teammates.map((t) => `${t.id} (${t.role})`).join(", ")}.`,
      ROLE_GUIDE[tm.role],
      tm.charter ? `Your standing instructions: ${tm.charter}` : "",
      `You work in a worktree on branch ${g.branch}. Loom commits for you after your turn; don't commit or push yourself.`,
      `Post to a crewmate with a post action ("to": "@id"); it reaches them on their next turn. Ask the person you work for with an ask action when you're truly blocked.`,
      protocolFor(tm.role),
    ];
    if (fresh) {
      const brain = await Promise.resolve(this.host.briefingFor(g.text, tm.agent)).catch(() => "");
      if (brain) lines.push(brain);
    }
    return lines.filter(Boolean).join("\n\n");
  }

  // ── helpers ──

  private post(cfg: CrewConfig, st: CrewState, g: CrewGoal, from: CrewTeammate, text: string, to?: string): void {
    const target = to && cfg.teammates.some((t) => t.id === to) ? to : undefined;
    this.host.append({ kind: "message", agentId: from.agent, chat: st.channel,
      payload: { text: target ? `@${target} ${text}` : text, crew: { crewId: cfg.id, goalId: g.id, teammate: from.id, ...(target ? { to: target } : {}) } } });
    if (target && target !== from.id) (st.notes[target] ??= []).push(`${from.id} (${from.role}) says: ${text}`);
  }

  private phase(cfg: CrewConfig, st: CrewState, phase: string, payload: Record<string, unknown>): void {
    this.host.append({ kind: "crew", chat: st.channel, payload: { phase, crewId: cfg.id, crew: cfg.name, goalId: st.goal?.id, ...payload } });
  }

  private async commit(cfg: CrewConfig, g: CrewGoal, card: CrewCard, tm: CrewTeammate, what = ""): Promise<string | null> {
    return this.serial(async () => {
      await git(["add", "-A"], g.dir);
      await git(["rm", "-r", "-q", "--cached", "--ignore-unmatch", "--", ".loom"], g.dir).catch(() => {});
      if (!(await git(["diff", "--cached", "--name-only"], g.dir)).trim()) return null;
      const member = this.host.member?.() ?? null;
      const kind = this.host.roster().find((a) => a.id === tm.agent)?.kind ?? tm.agent;
      const message = [
        `${card.title}${what ? ` (${what})` : ""}`.slice(0, 72),
        "",
        `Card ${card.id} of ${cfg.name}, goal ${g.id}: ${g.text.split("\n")[0]!.slice(0, 120)}`,
        "",
        `Co-Authored-By: ${tm.agent} <${tm.agent}@loom.local>`,
        ...(member ? [`Loom-Member: ${member}`] : []),
        `Loom-Crew: ${cfg.id}`,
        `Loom-Goal: ${g.id}`,
        `Loom-Card: ${card.id}`,
        `Loom-Teammate: ${tm.id}`,
        `Loom-Agent: ${kind}`,
      ].join("\n");
      await git(["-c", "user.name=Loom Crew", "-c", "user.email=crew@loom.local", "commit", "-q", "--no-verify", "-m", message], g.dir);
      return (await git(["rev-parse", "HEAD"], g.dir)).trim();
    });
  }

  /** What a card changed: its first commit's parent to the worktree's tip. */
  private async cardDiff(g: CrewGoal, card: CrewCard): Promise<string> {
    if (!card.commits.length) return "";
    const from = `${card.commits[0]}^`;
    const diff = await git(["diff", from, "HEAD"], g.dir).catch(() => "");
    return diff.length > 30_000 ? `${diff.slice(0, 30_000)}\n… (truncated)` : diff;
  }

  /** A goal's whole change against where it started. */
  async goalDiff(id: string): Promise<string> {
    const st = this.state(this.config(id));
    const g = st.goal;
    if (!g) return "";
    const diff = await git(["diff", g.base, g.branch], this.host.projectDir).catch(() => "");
    return diff.length > 400_000 ? `${diff.slice(0, 400_000)}\n… (truncated)` : diff;
  }

  private builderFor(cfg: CrewConfig, g: CrewGoal, card: CrewCard): CrewTeammate {
    const named = card.builder ?? card.assignee;
    const byId = named ? cfg.teammates.find((t) => t.id === named) : undefined;
    if (byId) return byId;
    const pool = cfg.teammates.filter((t) => t.role === (card.role === "researcher" ? "researcher" : "builder"));
    const workers = pool.length ? pool : cfg.teammates.filter((t) => t.role === "builder" || t.role === "researcher");
    if (!workers.length) return this.lead(cfg) ?? cfg.teammates[0]!;
    const taken = g.cards.filter((c) => c.builder).length;
    return workers[taken % workers.length]!;
  }

  private lead(cfg: CrewConfig): CrewTeammate | undefined { return cfg.teammates.find((t) => t.role === "lead"); }
  private reviewer(cfg: CrewConfig): CrewTeammate | undefined { return cfg.teammates.find((t) => t.role === "reviewer"); }
  private tester(cfg: CrewConfig): CrewTeammate | undefined { return cfg.teammates.find((t) => t.role === "tester"); }
  /** Is there a test step: a test command Loom runs, or a tester teammate? */
  private tests(cfg: CrewConfig): boolean { return Boolean(cfg.testCommand || this.tester(cfg)); }

  private thread(cfg: CrewConfig, st: CrewState, tm: CrewTeammate): string {
    const have = st.threads[tm.id];
    if (have && this.host.chatExists(have)) return have;
    let chat: ChatInfo;
    try {
      chat = this.host.createChat(`👥 ${cfg.name} · ${tm.id}`.slice(0, 60), { agentId: tm.agent });
    } catch {
      chat = this.host.createChat(`👥 ${cfg.name} · ${tm.id}`.slice(0, 60));
    }
    st.threads[tm.id] = chat.id;
    this.save(st);
    return chat.id;
  }

  private config(id: string): CrewConfig {
    const cfg = this.host.crews().find((c) => c.id === id);
    if (!cfg) throw new Error(`no crew "${id}"`);
    return cfg;
  }

  private state(cfg: CrewConfig): CrewState {
    let st = this.states.get(cfg.id) ?? this.load(cfg.id);
    if (!st || !this.host.chatExists(st.channel)) {
      const channel = this.host.createChat(`👥 ${cfg.name}`.slice(0, 60)).id;
      st = st ? { ...st, channel } : { id: cfg.id, channel, threads: {}, history: [], notes: {} };
      this.save(st);
    }
    this.states.set(cfg.id, st);
    return st;
  }

  private archive(st: CrewState): void {
    const g = st.goal!;
    st.history = [{ id: g.id, text: g.text.slice(0, 300), status: g.status, ...(g.summary ? { summary: g.summary.slice(0, 600) } : {}), ...(g.finishedAt ? { finishedAt: g.finishedAt } : {}), branch: g.branch }, ...st.history].slice(0, 30);
    if (g.dir && !g.applied) void this.dropWorktree(g).catch(() => {});
    st.goal = undefined;
  }

  private async dropWorktree(g: CrewGoal): Promise<void> {
    if (!fs.existsSync(g.dir)) return;
    await this.serial(() => git(["worktree", "remove", "--force", g.dir], this.host.projectDir));
  }

  private async stopAgents(crewId: string): Promise<void> {
    for (const [key, a] of [...this.agents]) {
      if (!key.startsWith(`${crewId}/`)) continue;
      this.agents.delete(key);
      await Promise.resolve(a.stop()).catch(() => {});
    }
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.gitChain.then(fn, fn);
    this.gitChain = run.catch(() => {});
    return run;
  }

  private stateFile(id: string): string {
    return path.join(this.host.projectDir, ".loom", "crews", `${id}.json`);
  }

  private load(id: string): CrewState | undefined {
    try {
      const st = JSON.parse(fs.readFileSync(this.stateFile(id), "utf8")) as CrewState;
      this.states.set(id, st);
      return st;
    } catch {
      return undefined;
    }
  }

  private save(st: CrewState): void {
    this.states.set(st.id, st);
    const file = this.stateFile(st.id);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(st, null, 1));
    fs.renameSync(tmp, file);
  }
}

const ROLE_GUIDE: Record<CrewRole, string> = {
  lead: "As the lead you turn goals into cards for the builders, answer their questions when you can, and write the goal's summary at the end. You plan; you don't edit files.",
  builder: "As a builder you make the change your card asks for, in this worktree, and keep it to that card. Run what you need to check it. Say what you did in a done action.",
  reviewer: "As the reviewer you read a card's diff and decide: approve, or ask for changes with notes that cite file:line. You don't edit files. Ask for changes only for real problems.",
  tester: "As the tester you run the project's tests in this worktree and report pass or fail with the last lines of output. Don't change source files to make tests pass.",
  researcher: "As a researcher you investigate what your card asks and write up what you found in a done action, with sources and file:line references.",
};
