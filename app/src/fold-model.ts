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
