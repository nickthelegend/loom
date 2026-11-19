---
name: loom-collaborate
description: Share Loom chats, inspect presence, move conversations, manage chat branches and teams, and search audit records. Use for "share this chat live", "move this chat", "retry that reply", "invite a teammate", or "show who approved this".
---

# Collaborate through Loom

Require Loom ≥ 2.1.0.

Choose the smallest access the user requested: a read-only chat link, a live guest
in one chat, or team membership/project sharing. Run from the intended project.
Links and invites convey access; deliver them only to the intended recipient.
Creating a link does not authorize sending an email or chat message to someone.

## Presence, moves, and conversation branches

```sh
loom presence main --json
loom presence main --watch --json
loom runner status
loom chat:move CHAT_ID --to RUNNER_ID --no-wait --json
loom chat:branches --chat main --json
loom chat:edit USER_EVENT_ID "Preserve the API and test empty input." --chat main
loom chat:retry REPLY_EVENT_ID --chat main
loom chat:branch BRANCH_ID --chat main --preview
loom chat:branch BRANCH_ID --chat main
```

Presence shows current viewers and typing, not a durable attendance record.
`--watch` joins the chat and prints changing snapshots until interrupted.
Move targets a real runner device ID or exact label. It normally waits for the
current turn; `--no-wait` fails if busy. It sends history and eligible resume state
to that machine, leaves a source redirect, and returns source chat/job information.
Move only when transferring this conversation is authorized; inspect the destination
and its access first. Runner status shows local runner state, not a target catalog;
take the destination ID/label from the configured devices/runners.

Use event IDs from the chat history, not message text or guessed numbers. Edit
branches from a user prompt and sends the replacement; retry branches from an
agent reply and starts another turn. Both print JSON without a `--json` option.
Branches lists active ancestry and sibling choices. Switching history alone does
not restore files or undo edits made by earlier turns.

For an explicitly requested file restore, inspect the `--preview` diff first,
then use `loom chat:branch BRANCH_ID --chat main --rewind-files`.
It shows the diff and asks before restoring. `--yes` skips that prompt and is
required in a non-interactive shell; use it only for an already authorized rewind.
Protect uncommitted work and active turns before changing history or files.

## Read-only chat links

```sh
loom share main --expiry 1d --json
loom share --run RUN_ID --expiry 1h --json
loom share main --hours 8 --json
loom share --list --json
loom share --revoke SHARE_ID
```

Without `--live`, share exposes prompts, replies, tool activity, and changes read-only.
The chat argument accepts an ID or title and defaults to main.
Creation JSON contains the returned URL, ID, title, and expiry; listing is an array.
Use the returned ID to revoke. Revocation prints text even if JSON was requested.
Default duration is 24 hours; `--hours` accepts 1–720. `--expiry` offers 1h, 1d or 7d.
`--run` shares one Orchestra goal, task statuses and results read-only, excluding
local paths and worker credentials. It does not grant live chat access.
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

## Team fleets, invites and approval roles

```sh
loom fleets:team TEAM_ID
loom fleets:share TEAM_ID parser
loom fleets:team TEAM_ID --import parser
loom team:invites TEAM_ID
loom team:invites TEAM_ID --revoke INVITE_ID
loom approval-roles
loom approval-roles --mode selected --approvers DEVICE_ID,OTHER_DEVICE_ID
```

Use actual team, invite and paired-device IDs. Publish an existing saved fleet;
team storage is encrypted and only its author or a team owner can replace/remove it.
Import saves it locally for `@parser` and can replace a same-name local fleet.
Invite listing/revocation covers members' own invites or any invite for team owners;
revocation invalidates copied links too. These commands print JSON without `--json`.

Approval roles affect this project: everyone keeps existing access; selected limits
approvals to listed paired devices, while owners always retain access. Use
`--mode everyone` only when that policy change is requested. Decisions record the
device that answered. Chat `@github-login` mentions notify matching teammates through
the encrypted team feed; mention only intended recipients.

## Git and review

```sh
loom pr:describe --chat main --template release
loom review codex --diff --template security --json
loom git:stats
loom changelog:suggest MERGED_BRANCH --base HEAD
```

Checklists are standard, security or release. PR descriptions and changelog bullets
are drafts to review; these commands do not publish them. Review starts agent work.
Git stats reports per-agent lines added/removed and unique file counts.

For an authorized commit or push, `loom git:commit "Reviewed message"` scans staged
changes and `loom git:push` scans outgoing commit diffs. Both expose
`--override-secrets` for an explicit, operation-scoped owner/device override;
do not use it as an automatic retry for a secret finding. Inspect and remove the
credential first, without printing it.

## Search and audit

```sh
loom find --all --json "rate limit"
loom audit --since 7d --json
loom audit --risky --since 7d --json
loom audit --since 30d --csv > audit.csv
```

Search returns `{hits,truncated}` across permitted projects/chats, newest first.
Read each hit's project and chat before acting; narrow the query if truncated.
Audit returns an array covering approvals and who answered, shared-chat/bridge
messages, trigger firings/skips, and baton handoffs. It is owner-only.
`--since` accepts durations such as 24h, 7d, or 30d, not arbitrary date strings.
`--risky` filters tool calls, approvals, safety denials and secret overrides.
`--csv` exports the complete selected period with formula-safe quoting; it does not
apply `--risky`, so use JSON for a risky-only report. Keep exports private.
An empty result is not proof that another scoped account has no activity.

If access fails, inspect the role, expiry, network reachability, and team selection.
Never broaden permissions to fix a missing chat. Never paste tokens into prompts,
commit `.loom/`, or forcibly restart while someone's turns run.
