# Crews

Create a crew with `loom crew create ship`, give it a goal with
`loom crew goal "add a health check"`, and review the plan before
`loom crew approve`. Ship builds one card at a time, asks its reviewer and
tester, and leaves a completed branch for you to inspect with `loom crew diff`.
`loom crew apply` is an explicit local merge. GitHub PRs are merged by humans.

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
