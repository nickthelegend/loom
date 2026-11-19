import { resolveProvider } from "./providers.js";
import type { IntakeTask } from "./intake.js";

export function integrationUrl(base: string): URL {
  const u = new URL(base);
  const localTest = process.env.NODE_ENV === "test" && u.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname);
  if ((!localTest && u.protocol !== "https:") || u.username || u.password || u.search || u.hash) throw new Error("Integration URL must use HTTPS without credentials or query parameters");
  return u;
}
async function request(route: string, body: unknown): Promise<Record<string, any>> {
  const p = resolveProvider("jira");
  if (!p?.key) throw new Error("Configure Jira in providers: site URL and email:API-token key");
  const base = integrationUrl(p.baseUrl).href.replace(/\/$/, "");
  const r = await fetch(base + route, { method: "POST", headers: { authorization: `Basic ${Buffer.from(p.key).toString("base64")}`, "content-type": "application/json" }, body: JSON.stringify(body), redirect: "error", signal: AbortSignal.timeout(15_000) });
  if (!r.ok) throw new Error(`Jira request failed (${r.status}); check provider settings`);
  return r.status === 204 ? {} : await r.json() as Record<string, any>;
}
function adfText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return "";
  const node = value as { text?: string; content?: unknown[] };
  return node.text ?? (node.content ?? []).map(adfText).join("\n");
}
export async function jiraAssigned(label?: string): Promise<IntakeTask[]> {
  const rows: IntakeTask[] = [], seen = new Set<string>();
  let nextPageToken: string | undefined;
  do {
    const page = await request("/rest/api/3/search/jql", { jql: 'assignee = currentUser() AND statusCategory != Done' + (label ? ` AND labels = ${JSON.stringify(label)}` : ""), fields: ["summary", "description", "labels"], maxResults: 100, ...(nextPageToken ? { nextPageToken } : {}) });
    for (const r of page.issues ?? []) rows.push({ source: "jira", id: String(r.id), identifier: String(r.key), title: String(r.fields.summary), body: adfText(r.fields.description).slice(0, 8000), labels: r.fields.labels ?? [], url: `${resolveProvider("jira")!.baseUrl}/browse/${encodeURIComponent(r.key)}` });
    nextPageToken = page.isLast === true ? undefined : page.nextPageToken;
    if (nextPageToken && seen.has(nextPageToken)) throw new Error("Jira returned a repeated page cursor");
    if (nextPageToken) seen.add(nextPageToken);
  } while (nextPageToken);
  return rows;
}
export async function jiraComment(id: string, text: string): Promise<void> {
  await request(`/rest/api/3/issue/${encodeURIComponent(id)}/comment`, { body: { type: "doc", version: 1, content: [{ type: "paragraph", content: [{ type: "text", text }] }] } });
}
