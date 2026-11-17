---
name: loom-collaborate
description: Share Loom chats, manage basic team collaboration, and inspect cross-project search and audit records. Use for "share this chat live", "invite a teammate", "show who approved this", or "search all Loom sessions".
---

# Collaborate through Loom

Choose the smallest access the user requested: a read-only chat link, a live guest
in one chat, or team membership/project sharing. Run from the intended project.
Links and invites convey access; deliver them only to the intended recipient.
Creating a link does not authorize sending an email or chat message to someone.

## Read-only chat links

```sh
loom share main --hours 8 --json
loom share --list --json
loom share --revoke SHARE_ID
```

Without `--live`, share exposes prompts, replies, tool activity, and changes read-only.
The chat argument accepts an ID or title and defaults to main.
Creation JSON contains the returned URL, ID, title, and expiry; listing is an array.
Use the returned ID to revoke. Revocation prints text even if JSON was requested.
Default duration is 24 hours; `--hours` accepts 1–720.
Anyone with the link who can reach the daemon can read that chat.
Do not assume a localhost link works for a remote teammate; use established access.
Review chat contents for credentials before sharing.

## Live guests

```sh
loom share main --live --role view --name Priya --hours 8 --json
loom share main --live --role reply --name Sam --hours 2
loom share main --live --role approve --name Alex --hours 1
```

Choose one role per guest:

| Role | Capability |
| --- | --- |
| view | Read along. |
| reply | Send messages and stop turns in that chat. |
| approve | Also answer tool approval requests in that chat. |

Reply is the default; always specify the role so read-only intent is preserved.
The link is single-use, access expires, and messages/approvals identify the guest.
Live JSON uses `link` and guest information; do not assume the read-only `url` shape.
Guests cannot access other chats, terminals, files, git, settings, or teams directly.
An approve guest can authorize tools in this chat; grant it only for that purpose.
Loom Cloud supports access across networks when configured.

Live guests are paired clients, not entries managed by read-only share revocation:

```sh
loom clients
loom clients --revoke GUEST_CLIENT_ID
```

Read the guest's actual ID from clients or Settings → Devices before revoking.
If a one-use link was already claimed, create a new invite only for the intended guest.

## Team basics

```sh
loom team status
loom team signin
loom team create "Example team"
loom team invite
loom team join 'INVITE_LINK'
loom team share
loom team unshare
```

Use status first. Create a team or join an existing one as appropriate; these are
alternative setup paths, not a sequence to execute blindly.
Signin uses hosted GitHub sign-in; `loom team signin --paste` supports another browser.
Replace `INVITE_LINK` with the private invite through the user's secure workflow.
Invites are single-use and carry the team key. Do not publish them in logs/issues.
For multiple teams, use `--team TEAM_ID` on invite/join/share as appropriate.
Sharing exposes the project's repo, agents, goals, branches, and declared files;
team status is not a way to read private prompts or transcripts.
Unshare opts the current project out. Inspect which repo is being shared first.

`loom team auto` reports readiness for tasks across teammates' runners.
`loom team auto on` enables that setup and may write `loom.team.json` policy;
use it only when cross-machine execution is requested, and review the policy as code.
Use orchestrate `--solo` for an individual goal that must stay on this machine.
`loom team remove GITHUB_LOGIN --team TEAM_ID` removes a member and rotates the key.
`loom team leave --team TEAM_ID` leaves a team. Use these only for requested removals.
Team commands here print text; do not add an invented `--json` flag.

## Search and audit

```sh
loom find --all --json "rate limit"
loom audit --since 7d --json
```

Search returns `{hits,truncated}` across permitted projects/chats, newest first.
Read each hit's project and chat before acting; narrow the query if truncated.
Audit returns an array covering approvals and who answered, shared-chat/bridge
messages, trigger firings/skips, and baton handoffs. It is owner-only.
`--since` accepts durations such as 24h, 7d, or 30d, not arbitrary date strings.
An empty result is not proof that another scoped account has no activity.

If access fails, inspect the role, expiry, network reachability, and team selection.
Never broaden permissions to fix a missing chat. Never paste tokens into prompts,
commit `.loom/`, or forcibly restart while someone's turns run.
