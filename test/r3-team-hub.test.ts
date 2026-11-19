import { expect, it } from "vitest";
import { MemoryHub } from "../src/core/team-hub.js";
import { newTeamKey, sealForTeam } from "../src/core/team-crypto.js";

it("invite listings hide other members' invites, never expose credentials, and expire", async () => {
  let now = 1000; const hub = new MemoryHub(() => now);
  const a = hub.client(hub.signIn("alice").token), b = hub.client(hub.signIn("bob").token), c = hub.client(hub.signIn("charlie").token);
  const team = await a.createTeam("test"); await b.redeemInvite((await a.createInvite(team.id)).invite);
  const invite = await a.createInvite(team.id, 60000), own = await b.createInvite(team.id, 60000);
  expect(await b.listInvites(team.id)).toHaveLength(1); expect(JSON.stringify(await a.listInvites(team.id))).not.toContain(invite.invite);
  const alice = await a.me();
  const id = (await a.listInvites(team.id)).find(i => i.createdBy === alice.id)!.id;
  expect(await b.revokeInvite(team.id, id)).toBe(false);
  expect(await a.revokeInvite(team.id, (await b.listInvites(team.id))[0]!.id)).toBe(true);
  await expect(c.redeemInvite(own.invite)).rejects.toThrow(/invalid/);
  now += 60001; expect(await a.listInvites(team.id)).toEqual([]); await expect(c.redeemInvite(invite.invite)).rejects.toThrow(/expired/);
});

it("team fleet reads isolate members and changes preserve the author", async () => {
  const hub = new MemoryHub(), a = hub.client(hub.signIn("alice").token), b = hub.client(hub.signIn("bob").token), c = hub.client(hub.signIn("charlie").token);
  const team = await a.createTeam("test"); await b.redeemInvite((await a.createInvite(team.id)).invite);
  const sealed = sealForTeam(newTeamKey(1), { spec: "echo" });
  await b.putTeamFleet(team.id, "fleet", sealed); const author = (await b.me()).id;
  await a.putTeamFleet(team.id, "fleet", sealed); expect((await b.teamFleets(team.id))[0]!.author).toBe(author);
  await expect(c.teamFleets(team.id)).rejects.toThrow(); await expect(c.putTeamFleet(team.id, "fleet", sealed)).rejects.toThrow();
  const copy = await b.teamFleets(team.id); copy[0]!.name = "changed"; expect((await b.teamFleets(team.id))[0]!.name).toBe("fleet");
  await a.removeMember(team.id, author); await expect(b.teamFleets(team.id)).rejects.toThrow();
  await a.putTeamFleet(team.id, "fleet", null); expect(await a.teamFleets(team.id)).toEqual([]);
});
