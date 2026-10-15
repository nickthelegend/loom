import { describe, expect, it } from "vitest";
import { MemoryHub, type FeedIn } from "../src/core/team-hub.js";
import { HttpHubClient, hubSignIn } from "../src/hub/client.js";
import { startHubServer } from "../src/hub/server.js";
import { crewRequests } from "../src/core/crew-requests.js";
for (const transport of ["memory", "http"]) describe(`crew request authorization over ${transport}`, () => {
  it("enforces owner answers, sealed content, expiry and immutable retry IDs", async () => {
    let now = Date.now(); const hub = new MemoryHub(() => now);
    const server = transport === "http" ? await startHubServer({ port: 0, secret: "crew-requests", hub }) : null;
    const client = async (who: string) => server ? new HttpHubClient(server.url, (await hubSignIn(server.url, who, { secret: "crew-requests" })).token) : hub.client(hub.signIn(who).token);
    try {
      const a = await client("alice"), b = await client("bob"), outsider = await client("carol");
      const team = (await a.createTeam("Requests")).id;
      await b.redeemInvite((await a.createInvite(team)).invite); await a.shareRepo(team, "acme/app");
      const request: FeedIn = { type: "crew_request", repo: "acme/app", meta: { requestId: "req-1", owner: "bob", crew: "ship", teammate: "tester", expiresAt: now + 1000 }, sealed: { v: 1, c: "encrypted" }, dedupeKey: "crew-request:req-1" };
      await expect(a.appendFeed(team, { ...request, sealed: undefined })).rejects.toMatchObject({ status: 400 });
      await expect(outsider.appendFeed(team, request)).rejects.toMatchObject({ status: 403 });
      await a.appendFeed(team, request); expect(await a.appendFeed(team, request)).toBeNull();
      await expect(a.appendFeed(team, { ...request, meta: { ...request.meta, teammate: "reviewer" } })).rejects.toMatchObject({ status: 409 });
      const answer: FeedIn = { type: "crew_request_answered", repo: "acme/app", meta: { requestId: "req-1", state: "accepted" }, dedupeKey: "crew-answer:req-1" };
      await expect(a.appendFeed(team, answer)).rejects.toMatchObject({ status: 403 });
      await b.appendFeed(team, answer); expect(await b.appendFeed(team, answer)).toBeNull();
      await expect(b.appendFeed(team, { ...answer, meta: { ...answer.meta, state: "declined" } })).rejects.toMatchObject({ status: 409 });
      const next = { ...request, meta: { ...request.meta, requestId: "req-2" }, dedupeKey: "crew-request:req-2" };
      await a.appendFeed(team, next); now += 1001;
      await expect(b.appendFeed(team, { ...answer, meta: { ...answer.meta, requestId: "req-2" }, dedupeKey: "crew-answer:req-2" })).rejects.toMatchObject({ status: 409 });
      const views = crewRequests(await a.feed(team), () => ({ text: "run tests" }), now);
      expect(views.find(r => r.id === "req-1")!.state).toBe("accepted"); expect(views.find(r => r.id === "req-2")!.state).toBe("expired");
    } finally { await server?.close(); }
  });
});
