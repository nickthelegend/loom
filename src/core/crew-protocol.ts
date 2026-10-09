/**
 * Agent Teams — what a teammate may say back (docs/proposals/agent-teams.md §8.3).
 *
 * A teammate ends its turn with a ```loom block of actions, exactly as an
 * Orchestra orchestrator does, so any agent can be on a crew — one with no
 * tools at all included. This file parses that block and decides which of
 * the actions this teammate's role is allowed to take; the engine does the
 * rest. Pure: no I/O, no clock.
 */

export type CrewRole = "lead" | "builder" | "reviewer" | "tester" | "researcher";
export const CREW_ROLES: CrewRole[] = ["lead", "builder", "reviewer", "tester", "researcher"];

export interface PlannedCard {
  title: string;
  detail?: string;
  touches?: string[];
  role?: CrewRole;
  /** A teammate id the Lead wants on it. */
  assignee?: string;
  /** Titles or 1-based indexes of cards in the same plan this one waits for. */
  blockedBy?: string[];
}

export type CrewAction =
  | { type: "plan"; cards: PlannedCard[] }
  | { type: "post"; to?: string; text: string }
  | { type: "review"; verdict: "approve" | "changes"; notes: string }
  | { type: "test"; result: "pass" | "fail"; log?: string }
  | { type: "ask"; question: string }
  | { type: "done"; summary: string };

/** What each role may do. Anything else is refused and said back to it. */
export const ROLE_ACTIONS: Record<CrewRole, CrewAction["type"][]> = {
  lead: ["plan", "post", "ask", "done"],
  builder: ["post", "ask", "done"],
  reviewer: ["review", "post", "ask"],
  tester: ["test", "post", "ask"],
  researcher: ["post", "ask", "done"],
};

type Json = Record<string, unknown>;
const str = (v: unknown, max = 4000): string => (typeof v === "string" ? v : v == null ? "" : String(v)).trim().slice(0, max);
const strList = (v: unknown, max = 20): string[] =>
  (Array.isArray(v) ? v : typeof v === "string" && v ? [v] : []).map((x) => str(x, 300)).filter(Boolean).slice(0, max);

/** The action list in a reply: the last ```loom (or ```json) block with "actions", else a bare {"actions": …}. */
function actionsJson(text: string): unknown[] | null {
  const blocks = [...text.matchAll(/```(?:loom|json)?[ \t]*\n([\s\S]*?)```/g)].map((m) => m[1]!).reverse();
  for (const b of blocks) {
    try {
      const v = JSON.parse(b) as Json;
      if (Array.isArray(v?.actions)) return v.actions;
    } catch {
      /* not this one */
    }
  }
  const at = text.lastIndexOf('{"actions"');
  if (at >= 0) {
    let depth = 0;
    for (let i = at; i < text.length; i++) {
      if (text[i] === "{") depth++;
      else if (text[i] === "}" && --depth === 0) {
        try {
          const v = JSON.parse(text.slice(at, i + 1)) as Json;
          if (Array.isArray(v.actions)) return v.actions;
        } catch {
          /* fall through */
        }
        break;
      }
    }
  }
  return null;
}

function toAction(raw: unknown): CrewAction | null {
  const a = (raw ?? {}) as Json;
  const type = str(a.type ?? a.action, 20).toLowerCase();
  if (type === "plan") {
    const cards = (Array.isArray(a.cards) ? a.cards : [])
      .map((c): PlannedCard | null => {
        const o = (c ?? {}) as Json;
        const title = str(o.title, 200);
        if (!title) return null;
        const role = str(o.role, 20).toLowerCase();
        const blockedBy = strList(o.blockedBy ?? o.after ?? o.dependsOn);
        const touches = strList(o.touches ?? o.files);
        return {
          title,
          ...(str(o.detail ?? o.description) ? { detail: str(o.detail ?? o.description) } : {}),
          ...(touches.length ? { touches } : {}),
          ...((CREW_ROLES as string[]).includes(role) ? { role: role as CrewRole } : {}),
          ...(str(o.assignee ?? o.to, 60) ? { assignee: str(o.assignee ?? o.to, 60).replace(/^@/, "") } : {}),
          ...(blockedBy.length ? { blockedBy } : {}),
        };
      })
      .filter((c): c is PlannedCard => !!c)
      .slice(0, 12);
    return cards.length ? { type, cards } : null;
  }
  if (type === "post") {
    const text = str(a.text ?? a.message);
    if (!text) return null;
    const to = str(a.to, 60).replace(/^@/, "");
    return { type, text, ...(to ? { to } : {}) };
  }
  if (type === "review") {
    const v = str(a.verdict, 20).toLowerCase();
    const verdict = /^(approve|approved|lgtm|pass|ok)$/.test(v) ? "approve" : /^(changes|request_changes|reject|fail)$/.test(v) ? "changes" : null;
    return verdict ? { type, verdict, notes: str(a.notes ?? a.text) } : null;
  }
  if (type === "test") {
    const r = str(a.result ?? a.status, 20).toLowerCase();
    const result = /^(pass|passed|ok|green)$/.test(r) ? "pass" : /^(fail|failed|red|error)$/.test(r) ? "fail" : null;
    if (!result) return null;
    const log = str(a.log, 6000);
    return { type, result, ...(log ? { log } : {}) };
  }
  if (type === "ask") {
    const question = str(a.question ?? a.text, 1000);
    return question ? { type, question } : null;
  }
  if (type === "done") return { type, summary: str(a.summary ?? a.text) };
  return null;
}

/**
 * Parse a teammate's reply. `allowed` are the actions its role may take;
 * `refused` are well-formed actions it isn't allowed (said back to it).
 */
export function parseCrewReply(text: string, role: CrewRole): { allowed: CrewAction[]; refused: CrewAction[]; found: boolean } {
  const raw = actionsJson(text);
  if (!raw) return { allowed: [], refused: [], found: false };
  const all = raw.map(toAction).filter((a): a is CrewAction => !!a);
  const ok = ROLE_ACTIONS[role];
  return { allowed: all.filter((a) => ok.includes(a.type)), refused: all.filter((a) => !ok.includes(a.type)), found: true };
}

/** The protocol as a teammate's briefing says it, for its role. */
export function protocolFor(role: CrewRole): string {
  const ex: Record<CrewAction["type"], string> = {
    plan: '{"type":"plan","cards":[{"title":"Add rate limiting to /api","detail":"…","touches":["src/api/**"],"role":"builder","blockedBy":[]}]}',
    post: '{"type":"post","to":"@tester","text":"does npm test fail on main too?"}',
    review: '{"type":"review","verdict":"approve","notes":"…cite file:line…"}',
    test: '{"type":"test","result":"pass","log":"…last lines of output…"}',
    ask: '{"type":"ask","question":"Postgres or SQLite for the limiter store?"}',
    done: '{"type":"done","summary":"what you did, in two or three sentences"}',
  };
  const lines = ROLE_ACTIONS[role].map((t) => `  ${ex[t]}`).join(",\n");
  return [
    "End your reply with ONE fenced block in this exact form (only the actions you need):",
    "```loom",
    `{"actions": [\n${lines}\n]}`,
    "```",
  ].join("\n");
}
