import { nextCron, parseCron, type Trigger } from "./triggers.js";

export const webhookTemplates = [
  { id: "issue", name: "GitHub issue", prompt: "Work on #{{body.issue.number}}: {{body.issue.title}}\n{{body.issue.body}}", event: "issues", payload: { issue: { number: 42, title: "Fix login", body: "Login fails after refresh." } } },
  { id: "ci", name: "CI failure", prompt: "Investigate {{body.workflow_run.name}}: {{body.workflow_run.conclusion}}\n{{body.workflow_run.html_url}}", event: "workflow_run", payload: { workflow_run: { name: "Tests", conclusion: "failure", html_url: "https://github.com/owner/repo/actions/runs/42" } } },
  { id: "custom", name: "Entire payload", prompt: "Handle {{event}}:\n{{body}}", event: "custom", payload: { message: "Hello" } },
];

/** A signed delivery proves the sender, not the comment author's right to run agents. */
export function githubCommand(body: unknown, event?: string): { id: string; number: number; prompt: string; url: string } | null {
  if (event !== "issue_comment" || !body || typeof body !== "object") return null;
  const b = body as { action?: string; issue?: { number?: number; html_url?: string; pull_request?: unknown }; comment?: { id?: number; body?: string; author_association?: string; user?: { type?: string } } };
  const c = b.comment;
  if (b.action !== "created" || !c?.id || !b.issue?.number || b.issue.pull_request || c.user?.type === "Bot" || !["OWNER", "MEMBER", "COLLABORATOR"].includes(c.author_association ?? "")) return null;
  const prompt = /^\/loom\s+([\s\S]+)$/i.exec(c.body?.trim() ?? "")?.[1]?.trim();
  if (!prompt || prompt.length > 20_000) return null;
  return { id: String(c.id), number: b.issue.number, prompt, url: b.issue.html_url ?? "" };
}

const stamp = (ms: number) => new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
const escape = (s: string) => s.replace(/\\/g, "\\\\").replace(/\r?\n/g, "\\n").replace(/;/g, "\\;").replace(/,/g, "\\,");
/** A bounded forecast preserves cron's local-time and day-of-month OR weekday semantics. */
export function triggerCalendar(project: string, triggers: Trigger[], now = Date.now()): string {
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Loom//Schedules//EN", "CALSCALE:GREGORIAN", "X-WR-CALNAME:Loom schedules (next 100 occurrences per trigger)"];
  for (const t of triggers.filter(t => t.enabled && t.kind === "schedule")) {
    let at = now;
    const cron = t.cron ? parseCron(t.cron) : null;
    for (let i = 0; i < 100; i++) {
      const anchor = t.lastFiredAt ?? t.createdAt;
      at = t.everyMin ? anchor + (Math.max(0, Math.floor((at - anchor) / (t.everyMin * 60_000))) + 1) * t.everyMin * 60_000 : cron ? nextCron(cron, new Date(at))?.getTime() ?? Infinity : Infinity;
      if (!Number.isFinite(at) || at > now + 366 * 86_400_000) break;
      lines.push("BEGIN:VEVENT", `UID:${escape(project)}-${escape(t.id)}-${at}@loom`, `DTSTAMP:${stamp(t.createdAt)}`, `DTSTART:${stamp(at)}`, `SUMMARY:${escape(t.name)}`, `DESCRIPTION:${escape(t.cron ? `Cron: ${t.cron} (daemon local time)` : `Every ${t.everyMin} minutes`)}`, "END:VEVENT");
    }
  }
  lines.push("END:VCALENDAR");
  // Fold by UTF-8 octets, without splitting a multibyte character.
  return lines.map(line => {
    let out = "", width = 0;
    for (const ch of line) {
      const n = Buffer.byteLength(ch);
      if (width + n > 75) { out += "\r\n "; width = 1; }
      out += ch; width += n;
    }
    return out;
  }).join("\r\n") + "\r\n";
}
