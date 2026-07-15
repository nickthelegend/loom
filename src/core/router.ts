/**
 * Hop routers for dynamic routes — after each step, decide who works next.
 *
 * Two brains, one interface:
 *  - rulesRouter: deterministic role rules (free, offline, always available)
 *  - llmRouter:   asks Claude (headless, JSON out) to pick the next hop,
 *                 falling back to the rules on any failure
 *
 * Loom never lets a router run away: dynamic routes carry a hop budget and
 * every decision lands in the event log with its reason.
 */

import { spawn } from "node:child_process";
import type { AgentRole } from "../types.js";

export interface RouterAgent {
  id: string;
  role: AgentRole;
}

export interface RouterContext {
  task: string;
  /** Agent ids of hops taken so far, in order. */
  hops: string[];
  /** Adapter-tier agents eligible for the next hop. */
  agents: RouterAgent[];
  /** Recent conversation: author (agent id or "user"/"loom") + text. */
  recent: Array<{ author: string; text: string }>;
}

export interface HopDecision {
  next: string | "done";
  reason: string;
  /** Which brain produced this decision. */
  by: "rules" | "llm";
}

const NEEDS_MORE_WORK =
  /\b(must fix|needs? (?:a )?fix|found (?:an? |some )?(?:issues?|bugs?)|reject(?:ed)?|fail(?:ed|ing)|not approved|request(?:ing)? changes|does not (?:pass|work))\b/i;

function byRole(agents: RouterAgent[], role: AgentRole): RouterAgent | undefined {
  return agents.find((a) => a.role === role);
}

function lastTextFrom(ctx: RouterContext, agentId: string): string {
  for (let i = ctx.recent.length - 1; i >= 0; i--) {
    if (ctx.recent[i]!.author === agentId) return ctx.recent[i]!.text;
  }
  return "";
}

/** Deterministic plan → execute → review → (fix loop) → done. */
export function rulesRouter(ctx: RouterContext): HopDecision {
  const { hops, agents } = ctx;
  const done = (reason: string): HopDecision => ({ next: "done", reason, by: "rules" });
  if (!agents.length) return done("no adapters available");

  if (!hops.length) {
    const first = byRole(agents, "planner") ?? byRole(agents, "executor") ?? agents[0]!;
    return { next: first.id, reason: `start with the ${first.role}`, by: "rules" };
  }

  const last = hops[hops.length - 1]!;
  const lastRole = agents.find((a) => a.id === last)?.role ?? "general";

  if (lastRole === "planner") {
    const exec = byRole(agents, "executor");
    if (exec) return { next: exec.id, reason: "plan ready — execute it", by: "rules" };
    return done("planned, and no executor exists");
  }
  if (lastRole === "executor") {
    const reviewer = byRole(agents, "reviewer");
    if (reviewer) return { next: reviewer.id, reason: "work done — review it", by: "rules" };
    return done("executed, and no reviewer exists");
  }
  if (lastRole === "reviewer") {
    const verdict = lastTextFrom(ctx, last);
    const exec = byRole(agents, "executor");
    const reviewRounds = hops.filter(
      (h) => agents.find((a) => a.id === h)?.role === "reviewer",
    ).length;
    if (exec && reviewRounds < 3 && NEEDS_MORE_WORK.test(verdict)) {
      return { next: exec.id, reason: "review found issues — back to the executor", by: "rules" };
    }
    return done("review passed");
  }
  return done("general agent finished the task");
}

// ---------------------------------------------------------------------------
// LLM router (claude headless), rules fallback
// ---------------------------------------------------------------------------

export interface LlmRouterOptions {
  /** Model for routing decisions; small+fast is right. */
  model?: string;
  timeoutMs?: number;
}

function routerPrompt(ctx: RouterContext): string {
  const agents = ctx.agents.map((a) => `- ${a.id} (${a.role})`).join("\n");
  const hops = ctx.hops.length ? ctx.hops.join(" → ") : "(none yet)";
  const recent = ctx.recent
    .slice(-10)
    .map((m) => `${m.author}: ${m.text.replace(/\s+/g, " ").slice(0, 240)}`)
    .join("\n");
  return [
    "You are the routing brain of Loom, a control plane that passes a baton between coding agents.",
    "Decide which agent should take the NEXT turn on this task, or whether the task is complete.",
    "",
    `Task: ${ctx.task}`,
    `Hops so far: ${hops}`,
    "Available agents:",
    agents,
    "Recent conversation:",
    recent || "(empty)",
    "",
    'Reply with ONLY a JSON object, no prose: {"next":"<agent-id or done>","reason":"<under 15 words>"}',
    "Prefer finishing (\"done\") once the task is genuinely complete; avoid pointless extra hops.",
  ].join("\n");
}

export async function llmRouter(
  ctx: RouterContext,
  opts: LlmRouterOptions = {},
): Promise<HopDecision> {
  try {
    const raw = await claudeJson(routerPrompt(ctx), opts);
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) throw new Error("no JSON in router reply");
    const parsed = JSON.parse(match[0]) as { next?: string; reason?: string };
    const next = String(parsed.next ?? "").trim();
    const valid = next === "done" || ctx.agents.some((a) => a.id === next);
    if (!valid) throw new Error(`router chose unknown agent "${next}"`);
    return { next, reason: String(parsed.reason ?? "llm decision").slice(0, 140), by: "llm" };
  } catch {
    const fallback = rulesRouter(ctx);
    return { ...fallback, reason: `${fallback.reason} (llm unavailable — rules fallback)` };
  }
}

function claudeJson(prompt: string, opts: LlmRouterOptions): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "claude",
      [
        "-p",
        prompt,
        "--output-format",
        "json",
        "--model",
        opts.model ?? "haiku",
        "--no-session-persistence",
      ],
      { stdio: ["ignore", "pipe", "ignore"] },
    );
    let out = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("router timed out"));
    }, opts.timeoutMs ?? 45_000);
    timer.unref?.();
    child.stdout.on("data", (d: Buffer) => (out += d.toString()));
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`claude exited ${code}`));
      try {
        const wrapper = JSON.parse(out) as { result?: string };
        resolve(String(wrapper.result ?? out));
      } catch {
        resolve(out);
      }
    });
  });
}
