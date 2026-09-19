/**
 * The hosted hub's GitHub webhook receiver (Loom Teams D7, D83), as a plain
 * Request → Response function so it runs under Deno (index.ts) and under the
 * test suite alike. The same rules as `loom hub`'s POST /github/webhook/:team:
 *
 *   - the team comes from the path: …/github-webhook/<team id>
 *   - an unknown team, or one with no secret, is 404
 *   - X-Hub-Signature-256 must be HMAC-SHA256 of the exact body under the
 *     team's secret (constant-time compare), else 401
 *   - `ping` is acknowledged; anything else is mapped (github-events.ts) and
 *     handed to `ingest`, which keeps repos the team shares and dedupes
 */

import { githubWebhookFeed, verifyGithubSignature, type GhFeed } from "../_shared/github-events.ts";

export interface WebhookDeps {
  /** The team's webhook secret, or null (no such team, or none set). */
  secretFor(teamId: string): Promise<string | null>;
  /** Append the events for repos the team shares; returns how many were new. */
  ingest(teamId: string, events: GhFeed[]): Promise<number>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

export async function handleWebhook(req: Request, deps: WebhookDeps): Promise<Response> {
  if (req.method !== "POST") return json(405, { error: "POST only" });
  const teamId = new URL(req.url).pathname.split("/").filter(Boolean).pop() ?? "";
  if (!UUID.test(teamId)) return json(404, { error: "no webhook for this team" });
  const secret = await deps.secretFor(teamId);
  if (!secret) return json(404, { error: "no webhook for this team" });
  const body = new Uint8Array(await req.arrayBuffer());
  if (!(await verifyGithubSignature(secret, body, req.headers.get("x-hub-signature-256")))) {
    return json(401, { error: "bad or missing X-Hub-Signature-256" });
  }
  const event = req.headers.get("x-github-event") ?? "";
  if (event === "ping") return json(200, { ok: true, pong: true });
  let payload: unknown;
  try {
    payload = JSON.parse(new TextDecoder().decode(body));
  } catch {
    return json(400, { error: "the payload isn't JSON: set the webhook's content type to application/json" });
  }
  const events = githubWebhookFeed(event, payload);
  const accepted = events.length ? await deps.ingest(teamId, events) : 0;
  return json(202, { accepted });
}
