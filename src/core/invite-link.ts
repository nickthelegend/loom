/**
 * One link to join a team (daemon/onboard.ts).
 *
 * An invite is an https URL, so it opens from WhatsApp, Slack or email like
 * any link. The page it opens (site/join/) is static: it reads the #fragment
 * in the browser and hands it to the Loom on that machine, or shows the one
 * command that installs Loom and joins. The fragment never reaches a server —
 * browsers don't send it — and it is the whole invite: team key, hub, repo.
 *
 * Every older or local form still works anywhere a link is accepted:
 * `loom://team/join#…`, `http://localhost:7420/app#join=…`, or the bare
 * fragment.
 */

import { unpackInvite, type InviteFragment } from "./team-crypto.js";

/** Where invite links point. LOOM_JOIN_URL moves it (a fork, a self-hosted page). */
export const DEFAULT_JOIN_URL = "https://nickthelegend.github.io/loom/join/";

export function joinBase(env: NodeJS.ProcessEnv = process.env): string {
  return (env.LOOM_JOIN_URL || DEFAULT_JOIN_URL).replace(/#.*$/, "");
}

export function inviteLink(fragment: string, env: NodeJS.ProcessEnv = process.env): string {
  return `${joinBase(env)}#${fragment}`;
}

/** The invite fragment out of any form of the link. */
export function inviteFragment(link: string): string {
  const s = link.trim().replace(/^['"<]+|['">]+$/g, "");
  const hash = s.includes("#") ? s.slice(s.indexOf("#") + 1) : s;
  return hash.replace(/^join=/, "").replace(/^\/?/, "");
}

/** What a link would set up, without redeeming anything — for "Join Acme?". */
export function previewInvite(link: string): {
  team: string | null;
  teamId: string | null;
  repo: string | null;
  from: string | null;
  project: string | null;
  hub: string;
  crews: string[];
} | null {
  const inv: InviteFragment | null = unpackInvite(inviteFragment(link));
  if (!inv) return null;
  return {
    team: inv.team ?? null,
    teamId: inv.teamId ?? null,
    repo: inv.repo ?? null,
    from: inv.from ?? null,
    project: inv.project ?? null,
    hub: inv.hub,
    crews: (inv.crews ?? []).map((c) => c.name),
  };
}
