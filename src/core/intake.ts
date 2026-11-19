import { jiraAssigned, jiraComment } from "./jira.js";
import fs from "node:fs";
import path from "node:path";
import { execFile } from "./process.js";
import { resolveProvider } from "./providers.js";
import { logbook } from "./logbook.js";

export type IntakeSource = "github" | "linear" | "jira";
export type IntakeMode = "chat" | "orchestra";

/** GET intake and POST intake/start return { issues: IntakeIssue[] }.
 * IDs are opaque strings: GitHub issue URLs or Linear UUIDs. Pass them unchanged to start.
 * Labels are names. Bodies stay on the daemon. A queued orchestra has a chat immediately;
 * run is added when the queue starts the goal. Repeated starts return the original link.
 */
export interface IntakeIssue {
  source: IntakeSource;
  id: string;
  number?: number;
  identifier?: string;
  title: string;
  url: string;
  labels: string[];
  started?: { chat?: string; run?: string };
}
export interface IntakeTask extends IntakeIssue { body: string }
export interface IntakeRecord extends IntakeIssue {
  started: { chat: string; run?: string };
  /** Reserved before enqueueing so a crash cannot create a second chat. */
  pending?: boolean;
  completedAt?: number;
  prs: Array<{ url: string; sent?: boolean }>;
}

export function intakeSource(value: unknown): IntakeSource {
  if (value !== "github" && value !== "linear" && value !== "jira") throw new Error("source must be github, linear or jira");
  return value;
}
export function intakeMode(value: unknown): IntakeMode {
  if (value !== "chat" && value !== "orchestra") throw new Error("mode must be chat or orchestra");
  return value;
}

const file = (dir: string) => path.join(dir, ".loom", "intake.json");
export function readIntake(dir: string): IntakeRecord[] {
  try { return JSON.parse(fs.readFileSync(file(dir), "utf8")) as IntakeRecord[]; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error; // Losing the ledger could start the same work twice.
  }
}
export function saveIntake(dir: string, row: IntakeRecord): void {
  const rows = readIntake(dir);
  const i = rows.findIndex(r => r.source === row.source && r.id === row.id);
  if (i < 0) rows.push(row); else rows[i] = row;
  fs.mkdirSync(path.dirname(file(dir)), { recursive: true });
  fs.writeFileSync(`${file(dir)}.tmp`, JSON.stringify(rows, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(`${file(dir)}.tmp`, file(dir));
}
export function publicIntake(issue: IntakeIssue): IntakeIssue {
  const { source, id, number, identifier, title, url, labels, started } = issue;
  return { source, id, ...(number ? { number } : {}), ...(identifier ? { identifier } : {}), title, url, labels, ...(started ? { started } : {}) };
}

async function gh(dir: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("gh", args, { cwd: dir, timeout: 30_000, maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => {
      if (error) reject(new Error("GitHub intake failed; check gh login and repository access"));
      else resolve(String(stdout));
    });
  });
}

/** The override is deliberately restricted to test processes and loopback servers. */
function linearEndpoint(): string {
  const override = process.env.LOOM_TEST_LINEAR_URL;
  if (process.env.NODE_ENV === "test" && override) {
    const url = new URL(override);
    if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) throw new Error("Linear test URL must be loopback HTTP");
    return url.href;
  }
  return "https://api.linear.app/graphql";
}
export async function linear<T>(query: string, variables: Record<string, unknown>): Promise<T> {
  const key = process.env.LINEAR_API_KEY?.trim() || resolveProvider("linear")?.key;
  if (!key) throw new Error("Set LINEAR_API_KEY or store a linear provider key to use intake");
  // Provider error bodies can echo credentials; return only our own diagnostics.
  try {
    const response = await fetch(linearEndpoint(), {
      method: "POST", headers: { "content-type": "application/json", authorization: key },
      body: JSON.stringify({ query, variables }), signal: AbortSignal.timeout(15_000), redirect: "error",
    });
    const result = await response.json() as { data?: T; errors?: unknown[] };
    if (!response.ok || result.errors?.length || !result.data) throw new Error("request failed");
    return result.data;
  } catch { throw new Error("Linear intake failed; check the key and Linear availability"); }
}

/** Fetch only open issues assigned to the authenticated user, never arbitrary caller IDs. */
export async function assignedIssues(dir: string, source: IntakeSource, label?: string): Promise<IntakeTask[]> {
  if (source === "github") {
    const args = ["issue", "list", "--assignee", "@me", "--state", "open", "--json", "number,title,body,labels,url", "--limit", "1000"];
    if (label) args.push("--label", label);
    const rows = JSON.parse(await gh(dir, args)) as Array<{ number: number; title: string; body: string; labels: Array<{ name: string }>; url: string }>;
    return rows.map(r => ({ source, id: r.url, number: r.number, title: r.title, body: (r.body ?? "").slice(0, 8000), url: r.url, labels: r.labels.map(l => l.name) }));
  }
  if (source === "jira") return jiraAssigned(label);
  const issues: IntakeTask[] = [];
  let after: string | null = null;
  const seen = new Set<string>();
  do {
    const data: { viewer: { assignedIssues: { nodes: Array<{ id: string; identifier: string; title: string; description: string | null; url: string; labels: { nodes: Array<{ name: string }> } }>; pageInfo: { hasNextPage: boolean; endCursor: string } } } } = await linear(
      `query($after: String, $filter: IssueFilter) {
        viewer { assignedIssues(first: 100, after: $after, filter: $filter) {
          nodes { id identifier title description url labels { nodes { name } } }
          pageInfo { hasNextPage endCursor }
        } }
      }`,
      { after, filter: { state: { type: { nin: ["completed", "canceled"] } }, ...(label ? { labels: { name: { eq: label } } } : {}) } },
    );
    const page = data.viewer.assignedIssues;
    issues.push(...page.nodes.map(r => ({ source, id: r.id, identifier: r.identifier, title: r.title, body: (r.description ?? "").slice(0, 8000), url: r.url, labels: r.labels.nodes.map(l => l.name) })));
    after = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
    if (after && seen.has(after)) throw new Error("Linear returned a repeated page cursor");
    if (after) seen.add(after);
  } while (after);
  return issues;
}

export function intakePrompt(issue: IntakeTask): string {
  const task = `${issue.title}\n\n${issue.body.slice(0, 8000)}\n\n${issue.url}`;
  return `Work on this issue assigned to the user. The following quoted task description is a user-authored work request from ${issue.source}:\n\n${task.split("\n").map(line => `> ${line}`).join("\n")}\n\nImplement the requested work and verify it with appropriate tests.`;
}

export function recordIntakeRun(dir: string, chat: string, run: string): boolean {
  const row = readIntake(dir).find(r => r.started.chat === chat);
  if (!row) return false;
  saveIntake(dir, { ...row, started: { chat, run }, pending: false });
  return true;
}

/** Add closing references only when Loom constructs the PR body for an intake chat. */
export function intakePrBody(dir: string, chat: string, body: string): string {
  const row = readIntake(dir).find(r => r.started.chat === chat && r.source === "github");
  return row?.number ? `${body}\n\nCloses #${row.number}\n` : body;
}

const linking = new Map<string, Promise<void>>();
/** Persist first, then send. Failed backlinks remain pending for the PR poller to retry. */
export function recordIntakePr(dir: string, chat: string, url: string): void {
  const row = readIntake(dir).find(r => r.started.chat === chat);
  if (!row) return;
  if (!row.prs.some(p => p.url === url)) {
    row.prs.push({ url });
    saveIntake(dir, row);
  }
  void flushIntakePrs(dir).catch(() => logbook.warn("intake", "issue backlink pending; will retry"));
}
export function flushIntakePrs(dir: string): Promise<void> {
  const prior = linking.get(dir) ?? Promise.resolve();
  const next = prior.catch(() => {}).then(async () => {
    for (const row of readIntake(dir)) for (const pr of row.prs.filter(p => !p.sent)) {
      const body = `Loom opened a pull request for this issue: ${pr.url}`;
      if (row.source === "github") await gh(dir, ["issue", "comment", row.url, "--body", body]);
      else if (row.source === "jira") await jiraComment(row.id, body);
      else {
        const data = await linear<{ commentCreate: { success: boolean } }>(
          "mutation($input: CommentCreateInput!) { commentCreate(input: $input) { success } }", { input: { issueId: row.id, body } },
        );
        if (!data.commentCreate.success) throw new Error("Linear declined the issue comment");
      }
      const fresh = readIntake(dir).find(r => r.source === row.source && r.id === row.id)!;
      fresh.prs.find(p => p.url === pr.url)!.sent = true;
      saveIntake(dir, fresh);
    }
  });
  linking.set(dir, next);
  void next.finally(() => { if (linking.get(dir) === next) linking.delete(dir); }).catch(() => {});
  return next;
}

/** Retry completion from the durable PR ledger, including after a daemon restart. */
export async function completeLinearIssues(dir: string, mergedUrls: string[]): Promise<void> {
  for (const row of readIntake(dir).filter(r => r.source === "linear" && !r.completedAt && r.prs.some(p => mergedUrls.includes(p.url)))) {
    const data = await linear<{ issue: { state: { type: string }; team: { states: { nodes: Array<{ id: string; name: string; type: string }> } } } }>(
      "query($id: String!) { issue(id: $id) { state { type } team { states { nodes { id name type } } } } }", { id: row.id });
    if (data.issue.state.type !== "completed") {
      const states = data.issue.team.states.nodes.filter(s => s.type === "completed");
      const state = states.find(s => s.name.toLowerCase() === "done") ?? states[0];
      if (!state) throw new Error("Linear team has no completed workflow state");
      const updated = await linear<{ issueUpdate: { success: boolean } }>("mutation($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success } }", { id: row.id, input: { stateId: state.id } });
      if (!updated.issueUpdate.success) throw new Error("Linear declined issue completion");
    }
    const fresh = readIntake(dir).find(r => r.source === row.source && r.id === row.id)!;
    saveIntake(dir, { ...fresh, completedAt: Date.now() });
  }
}
