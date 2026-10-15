# Crews

Create a crew with `loom crew create ship`, give it a goal with
`loom crew goal "add a health check"`, and review the plan before
`loom crew approve`. Ship builds one card at a time, asks its reviewer and
tester, and leaves a completed branch for you to inspect with `loom crew diff`.
`loom crew apply` is an explicit local merge. GitHub PRs are merged by humans.

## Parallel plays

Use `loom crew goal "the goal" --play fanout` to run ready cards in separate
builder worktrees. A seat runs one turn at a time, and at most four builders
can run concurrently. Set the crew's cap with `--parallel` when creating it.
Cards with overlapping `touches` wait; the next card branches from the integrated
result. Reviewer and tester steps require explicit protocol verdicts. A test
command's actual exit status also counts as test evidence.

Before integration, Loom uses Git's `merge-tree` prediction. A conflict goes
back to its owning builder's checkout for repair and another review/test round;
the integration checkout stays clean. This needs a Git version that supports
`merge-tree --write-tree` (Git 2.38 or newer).

`--play race` gives every builder the same goal in its own checkout. Compare
the entrants, then use `loom crew pick builder-1` (or the card id). Only the
chosen entrant is integrated; apply remains a separate human action.

Native fan-out keeps one binding per seat/workspace and holds independent
workspace writer leases. Test commands also use process containment, so Stop
and timeouts wait for detached descendants to exit. An unverified shutdown
blocks continuation instead of releasing the checkout.

## Persistent teammates

Enable `brain.continuity` in the project to use native sessions for crew seats.
All seats must use Codex, Claude Code or OpenCode. On Windows, the harness and
its tools are contained in a verified Job Object before execution.

Each seat gets a separate private thread and native binding, even when seats
share a roster agent. The second card receives a delta packet. Native crews
reuse a stable checkout across goals and create a new branch for each goal;
the prior goal's branch remains available. Save any uncommitted files before
starting the next goal.

`loom crew stop` waits for the active turn to settle. After a daemon restart,
`loom crew resume` continues an interrupted goal in the same checkout and
native session. A hard crash or lost acknowledgement can leave an uncertain
receipt. Inspect it in Brain diagnostics and explicitly reconcile its outcome;
Loom refuses to replay the action or refresh the seat while that receipt is active.

`loom crew refresh --to builder-1` starts a new session epoch for a stopped
teammate. It reconstructs context on that seat's next turn and preserves the
crew's recorded conversation.

Crew decisions can be stored with `POST /api/projects/:id/crews/:crew/memory`
and `{ "text": "the decision" }`. They are retrieved only for that crew and
are not published to the team. A human can promote a decision to project memory
with `POST /api/projects/:id/crews/:crew/memory/:memory/promote`.

The remaining parallel, multi-person and phone work is tracked in
[the implementation checklist](refactoring/AGENT-TEAMS-PROGRESS.md).


## Team coordination and runners

On shared repositories, `loom.team.json` can cap crew count, roster size,
role permissions, daily crew spend and goal/member spend. Reviewed policy is
read from the origin default branch; local policy can only tighten it. New
turns pause when a budget is exhausted; already active turns finish first.
`pause` preserves plan approval, and `resume` resumes after an owner review.

Cards must declare `touches`. Team claims are atomic for those scopes, and
another crew waits before writing. Resolve a hold with `narrow` and revised
scopes, `wait:<goal>` (refreshes the base after it lands), or an explicit
`proceed:<reason>` outside hard zones. Protected branches require PR delivery.

Cross-member requests are encrypted, expire after one day, and require the
requested owner's accept/decline. Reviewer, tester and researcher requests
are read-only in the owner's checkout. The inbox records delivery before
execution and never automatically repeats an interrupted request. A checkout
change during such a request holds the crew for inspection. Request IDs and
answers are immutable; teammates cannot answer for another owner.

A crew can start on a team runner. It maps roster IDs to installed kinds,
ignores sender executable/options/hooks, and applies the runner permission
ceiling. Owners can approve, say, pause, resume, stop or pick remotely. A
completed build opens one PR for human review; crew controls never merge it.
Failed or uncertain runner clones and native bindings are kept for inspection.

The hosted hub needs migration `0010_crew_coordination.sql` for requests and
control jobs at full capacity. Review/apply it separately with admin access;
Loom does not apply it. The self-hosted hub supports these paths directly.


A reviewed role/runner permission ceiling is checked against the actual harness
before work starts. OpenCode's `ask` mode is currently unverified/unsupported,
so a team role requiring it must use Codex/Claude (or a separately reviewed,
supported role setting). Loom refuses the seat instead of silently using auto.
Tightening permissions during a goal settles and recreates the warm adapter
before its next turn; native compatibility changes receive a fresh binding.

The `hub-sql` CI job runs all migrations and authorization checks in a disposable
PostgreSQL cluster and fails if tools are missing. It never connects to hosted
Supabase. Migration 0010 and the other SQL checks passed there (26 checks).
