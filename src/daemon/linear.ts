/**
 * Linear, through the user's own key — the same bet gh makes for GitHub. Loom
 * holds no Linear token of its own: the personal API key lives in the daemon's
 * environment (`LINEAR_API_KEY`, which the user exports), and this module reads
 * it from `process.env` and hands it straight to Linear's GraphQL endpoint. It
 * is never written to disk by us, never sent to a client, never logged.
 *
 * Everything degrades honestly: no key → `reason: "no-key"` with the one line a
 * setup panel needs, not an empty team list that reads like "you have no teams".
 */

const ENDPOINT = "https://api.linear.app/graphql";

export type LinearUnavailable = {
  available: false;
  reason: "no-key" | "auth" | "error";
  detail: string;
};

export interface LinearTeam {
  id: string;
  key: string;
  name: string;
}

export interface LinearIssue {
  id: string;
  identifier: string;
  title: string;
  state: string;
  url: string;
  assignee: string | null;
  updatedAt: string;
}

export type LinearTeams = { available: true; teams: LinearTeam[] };
export type LinearIssues = { available: true; issues: LinearIssue[] };
export type LinearCreated = {
  available: true;
  issue: { id: string; identifier: string; title: string; url: string };
};

/** The key, from the daemon's environment — or null when it isn't set. */
export function linearKey(): string | null {
  const k = process.env.LINEAR_API_KEY?.trim();
  return k || null;
}

export function linearConfigured(): boolean {
  return linearKey() !== null;
}

const NO_KEY: LinearUnavailable = {
  available: false,
  reason: "no-key",
  detail: "Set LINEAR_API_KEY in the daemon's environment to enable Linear, then reload.",
};

/** One line for a setup panel, mapped from Linear's own error text. */
function classify(msg: string): LinearUnavailable {
  const first = (msg.split("\n").find((l) => l.trim()) ?? msg).trim().slice(0, 300);
  if (/authentication|unauthorized|invalid api key|401|403/i.test(first)) {
    return { available: false, reason: "auth", detail: "LINEAR_API_KEY was rejected — check the key." };
  }
  return { available: false, reason: "error", detail: first };
}

interface GqlResponse<T> {
  data?: T;
  errors?: { message: string }[];
}

async function gql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
  const key = linearKey();
  if (!key) throw new Error("no-key");
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: key },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(15_000),
  });
  const json = (await res.json()) as GqlResponse<T>;
  if (json.errors?.length) throw new Error(json.errors[0]?.message ?? "Linear error");
  if (!res.ok || !json.data) throw new Error(`HTTP ${res.status}`);
  return json.data;
}

/** The teams this key can see — the selector in the New issue form. */
export async function linearTeams(): Promise<LinearTeams | LinearUnavailable> {
  if (!linearConfigured()) return NO_KEY;
  try {
    const data = await gql<{ teams: { nodes: LinearTeam[] } }>(
      "query { teams(first: 100) { nodes { id key name } } }",
    );
    return { available: true, teams: data.teams.nodes };
  } catch (err) {
    return classify(String((err as Error).message));
  }
}

/** Recent issues, optionally scoped to one team — the Linear column's contents. */
export async function listLinearIssues(teamId?: string): Promise<LinearIssues | LinearUnavailable> {
  if (!linearConfigured()) return NO_KEY;
  try {
    const filter = teamId ? { team: { id: { eq: teamId } } } : {};
    const data = await gql<{
      issues: {
        nodes: {
          id: string;
          identifier: string;
          title: string;
          url: string;
          updatedAt: string;
          state?: { name?: string };
          assignee?: { name?: string } | null;
        }[];
      };
    }>(
      `query($filter: IssueFilter) {
        issues(first: 50, filter: $filter, orderBy: updatedAt) {
          nodes { id identifier title url updatedAt state { name } assignee { name } }
        }
      }`,
      { filter },
    );
    return {
      available: true,
      issues: data.issues.nodes.map((n) => ({
        id: n.id,
        identifier: n.identifier,
        title: n.title,
        url: n.url,
        updatedAt: n.updatedAt,
        state: n.state?.name ?? "",
        assignee: n.assignee?.name ?? null,
      })),
    };
  } catch (err) {
    return classify(String((err as Error).message));
  }
}

/** Create an issue on a team. The one write — gated behind a confirm in the UI. */
export async function linearCreateIssue(input: {
  teamId: string;
  title: string;
  description?: string;
}): Promise<LinearCreated | LinearUnavailable> {
  if (!linearConfigured()) return NO_KEY;
  if (!input.teamId) return { available: false, reason: "error", detail: "pick a team first" };
  if (!input.title.trim()) return { available: false, reason: "error", detail: "an issue needs a title" };
  try {
    const data = await gql<{
      issueCreate: {
        success: boolean;
        issue: { id: string; identifier: string; title: string; url: string } | null;
      };
    }>(
      `mutation($input: IssueCreateInput!) {
        issueCreate(input: $input) { success issue { id identifier title url } }
      }`,
      {
        input: {
          teamId: input.teamId,
          title: input.title.trim(),
          ...(input.description?.trim() ? { description: input.description.trim() } : {}),
        },
      },
    );
    if (!data.issueCreate.success || !data.issueCreate.issue) {
      throw new Error("Linear declined to create the issue");
    }
    return { available: true, issue: data.issueCreate.issue };
  } catch (err) {
    return classify(String((err as Error).message));
  }
}
