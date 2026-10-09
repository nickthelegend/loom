/**
 * What the phone's thread leaves out because a card already says it.
 *
 * A plan is one checklist that changes as the agent works, not a new card per
 * change: agents post the whole list on every update (OpenCode's todowrite,
 * Codex's update_plan, Claude's TodoWrite), so a turn of three updates would
 * draw three cards. Only the newest per agent is drawn until you speak again.
 *
 * And the tool call behind a card — "⚙ todowrite" under the checklist,
 * "⚙ question" under the question you just answered — repeats it, so it's left
 * out too, but only once that agent's card is actually there: an adapter that
 * never sends the card keeps its tool line. All of it stays in the log.
 */

interface Ev {
  id: number;
  kind: string;
  agentId?: string;
  payload?: Record<string, unknown> | null;
}

const isPlan = (e: Ev): boolean => e.kind === "status" && e.payload?.state === "plan_updated";
const isQuestion = (e: Ev): boolean => e.kind === "needs_input";

/** Tool calls a card stands in for, by the card that does. */
const PLAN_TOOL = /^(todowrite|todo_write|update_plan|todoread)$/i;
const QUESTION_TOOL = /^(question|askuserquestion|ask_user_question|request_user_input)$/i;
const tool = (e: Ev): string => (e.kind === "tool_call" ? String(e.payload?.tool ?? "") : "");

/** Ids not worth drawing. */
export function foldedEvents(events: readonly Ev[]): Set<number> {
  const out = new Set<number>();
  const newestPlan = new Map<string, number>(); // agent → its latest plan update since you last spoke
  const asked = new Set<string>(); // agents that put a question card up since you last spoke
  let tools: Array<{ e: Ev; card: "plan" | "question" }> = [];
  const settle = () => {
    for (const { e, card } of tools) {
      const who = e.agentId ?? "";
      if (card === "plan" ? newestPlan.has(who) : asked.has(who)) out.add(e.id);
    }
    tools = [];
  };
  for (const e of events) {
    // your answer to a question is a message too, but it doesn't start a new prompt
    if (e.kind === "message" && !e.agentId && !e.payload?.answers) {
      settle();
      newestPlan.clear();
      asked.clear();
      continue;
    }
    const t = tool(e);
    if (PLAN_TOOL.test(t)) tools.push({ e, card: "plan" });
    else if (QUESTION_TOOL.test(t)) tools.push({ e, card: "question" });
    if (isQuestion(e)) asked.add(e.agentId ?? "");
    if (!isPlan(e)) continue;
    const who = e.agentId ?? "";
    const prev = newestPlan.get(who);
    if (prev !== undefined) out.add(prev);
    newestPlan.set(who, e.id);
  }
  settle();
  return out;
}

// ---- tool runs ----------------------------------------------------------------
// The desktop folds an agent's run of tool calls into one line ("Ran 2
// commands, read 3 files, updated the plan") that opens to the list; the phone
// does the same, so a busy turn isn't a screen of "⚙ …" lines.

export interface ToolGroup {
  id: number;
  kind: "tool_group";
  agentId?: string;
  chat?: string;
  ts: number;
  payload: { calls: Ev[] };
}

/** Consecutive tool calls from one agent become one group; everything else passes through. */
export function groupToolRuns<E extends Ev & { ts?: number; chat?: string }>(events: readonly E[]): Array<E | ToolGroup> {
  const out: Array<E | ToolGroup> = [];
  let run: E[] = [];
  const flush = () => {
    if (run.length === 1) out.push(run[0]!);
    else if (run.length > 1) {
      const first = run[0]!;
      out.push({ id: first.id, kind: "tool_group", agentId: first.agentId, chat: first.chat, ts: first.ts ?? 0, payload: { calls: run } });
    }
    run = [];
  };
  for (const e of events) {
    if (e.kind === "tool_call" && (!run.length || run[0]!.agentId === e.agentId)) {
      run.push(e);
      continue;
    }
    flush();
    if (e.kind === "tool_call") run.push(e);
    else out.push(e);
  }
  flush();
  return out;
}

/** "Ran 2 commands, read 3 files, updated the plan" — what a run of tools did, in words. */
export function summarizeTools(calls: readonly Ev[]): string {
  const n = { cmd: 0, read: 0, edit: 0, search: 0, web: 0, plan: 0, ask: 0, other: 0 };
  for (const c of calls) {
    const p = c.payload ?? {};
    const t = String(p.tool ?? "").toLowerCase();
    if (/(todo|plan)/.test(t)) n.plan++;
    else if (/(question|ask)/.test(t)) n.ask++;
    else if (/^(bash|shell|command|exec|run|terminal)/.test(t) || p.command) n.cmd++;
    else if (/^(read|view|cat|open)/.test(t)) n.read++;
    else if (/(write|edit|patch|create|replace)/.test(t)) n.edit++;
    else if (p.server === "web" || /(web|fetch|browse)/.test(t)) n.web++;
    else if (/(grep|glob|search|find|list|ls)/.test(t)) n.search++;
    else n.other++;
  }
  const s = (k: number, one: string, many: string) => (k ? `${k === 1 ? one.replace("#", "1") : many.replace("#", String(k))}` : "");
  const parts = [
    s(n.cmd, "ran # command", "ran # commands"),
    s(n.read, "read # file", "read # files"),
    s(n.edit, "edited # file", "edited # files"),
    s(n.search, "searched the code", "searched the code # times"),
    s(n.web, "searched the web", "searched the web # times"),
    n.plan ? "updated the plan" : "",
    n.ask ? "asked you" : "",
    s(n.other, "used # tool", "used # tools"),
  ].filter(Boolean);
  const text = parts.join(", ") || "used tools";
  return text[0]!.toUpperCase() + text.slice(1);
}
