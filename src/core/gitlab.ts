import { resolveProvider } from "./providers.js";
import { integrationUrl } from "./jira.js";

export interface GitlabIdentity { provider: "gitlab"; repo: string; prNumber: number }
export function gitlabIdentity(value: string): GitlabIdentity | null {
  const u = new URL(value);
  const match = /^\/(.+)\/-\/merge_requests\/([1-9]\d*)\/?$/.exec(u.pathname);
  if (!match) return null;
  if (u.protocol !== "https:" || u.username || u.password || u.port || u.search || u.hash || !Number.isSafeInteger(Number(match[2]))) throw new Error("Invalid GitLab merge request URL");
  return { provider: "gitlab", repo: `${u.hostname}/${match[1]}`, prNumber: Number(match[2]) };
}

/** The key is sent only to the configured GitLab host, never a pasted MR's destination. */
export async function gitlabView(repo: string, number: number, reviews: boolean) {
  const provider = resolveProvider("gitlab");
  if (!provider?.key) throw new Error("Configure a GitLab provider token with read_api access");
  const base = integrationUrl(provider.baseUrl);
  const slash = repo.indexOf("/");
  const test = process.env.NODE_ENV === "test" && base.protocol === "http:";
  if (!test && repo.slice(0, slash) !== base.hostname) throw new Error("MR host must match the GitLab provider URL");
  const project = encodeURIComponent(repo.slice(slash + 1));
  const root = `/projects/${project}`;
  const request = async (route: string) => {
    const r = await fetch(`${base.href.replace(/\/$/, "")}/api/v4${route}`, { headers: { "PRIVATE-TOKEN": provider.key! }, redirect: "error", signal: AbortSignal.timeout(15_000) });
    if (!r.ok) throw new Error(`GitLab request failed (${r.status})`);
    return { body: await r.json() as any, next: r.headers.get("x-next-page") };
  };
  const mr = (await request(`${root}/merge_requests/${number}`)).body;
  const state = ({ opened: "OPEN", merged: "MERGED", closed: "CLOSED", locked: "OPEN" } as const)[mr.state as "opened" | "merged" | "closed" | "locked"];
  if (!state) throw new Error("GitLab returned an invalid MR state");
  const comments: Array<{ id: string; body: string; author: { login: string }; authorAssociation: string }> = [];
  if (reviews && state === "OPEN") {
    let page = "1";
    const seen = new Set<string>();
    const trusted = new Map<number, boolean>();
    while (page) {
      if (seen.has(page)) throw new Error("GitLab returned a repeated page");
      seen.add(page);
      const result = await request(`${root}/merge_requests/${number}/discussions?per_page=100&page=${encodeURIComponent(page)}`);
      for (const discussion of result.body) for (const note of discussion.notes ?? []) {
        if (note.system || note.author?.bot || !note.author?.id || !note.body?.trim()) continue;
        const id = Number(note.author.id);
        if (!trusted.has(id)) {
          try { trusted.set(id, Number((await request(`${root}/members/all/${id}`)).body.access_level) >= 30); }
          catch { trusted.set(id, false); }
        }
        if (trusted.get(id)) comments.push({ id: String(note.id), body: String(note.body), author: { login: String(note.author.username) }, authorAssociation: "COLLABORATOR" });
      }
      page = result.next ?? "";
    }
  }
  const pipeline = mr.head_pipeline;
  return { state, url: String(mr.web_url), mergeable: String(mr.detailed_merge_status ?? "unknown"), headRefOid: String(mr.sha ?? ""), comments,
    statusCheckRollup: pipeline && ["failed", "canceled"].includes(pipeline.status) ? [{ name: "GitLab pipeline", conclusion: "FAILURE", detailsUrl: String(pipeline.web_url ?? mr.web_url) }] : [] };
}
