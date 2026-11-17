---
name: loom
description: Drive Loom's local coding agents, shared memory, chats, and baton handoffs. Use when asked to "use Loom", "send this to Codex", "hand off to another agent", or check a project's agents.
---

# Drive Loom

Loom is a local-first control plane: one daemon drives installed agent CLIs,
ACP agents, and model endpoints. Projects share memory across agent sessions.
The app, CLI, phone, bridges, and teams talk to that daemon.
Require Loom 1.3.0 or newer. Run project commands from the intended project folder.
Use discovered agent IDs; the examples assume those agents exist.

## Establish context

```sh
loom --version
loom status --json
loom doctor --json
loom version
loom projects --json
loom agents --json
```

- `loom --version` reports the installed CLI version without contacting the daemon.
- `loom status` checks health without starting it. Its JSON is a project array
  when running, or `{"daemon":null,"projects":[]}` when stopped.
- `loom doctor` diagnoses without starting a daemon; inspect warnings even on exit 0.
- `loom version` compares CLI and daemon builds. Like many commands, it calls
  the daemon-start helper and can start or replace an idle older daemon.
- A mismatch needs the [ops skill](../loom-ops/SKILL.md); protect active work.
- `loom projects --json` returns a project array. Check the directory before sending.
- In a project, `loom agents --json` returns its roster; outside one it returns
  `{project:null,machine:[...]}`. Read roles, models, access, and baton eligibility.

If the task calls for setting up this folder, use `loom init --gitignore`.
It registers the folder, detects agents, and keeps `.loom/` out of git.
If the daemon is stopped and starting it is within scope, use `loom up`.
If Loom is missing, install npm package `@loompad/cli` using the user's normal setup.

## Give an agent work

```sh
loom send --wait --json "Fix the parser regression; run its tests and report the diff."
loom send -a codex --handoff --wait --json "Continue the parser fix from shared memory."
```

The main thread follows the baton holder. The baton is the repository write lock;
passing it projects shared memory and can interrupt the previous holder's turn.
Check for active work before a handoff. Use `--handoff` only when taking that baton
is part of the user's request. It skips the handoff confirmation.
For a separate transfer, use `loom handoff codex`; `--yes` skips its confirmation.
Do not work around the lock by launching competing writers in the same checkout.
Use orchestras for parallel implementation in separate worktrees.

With `--wait --json`, read stdout as one outcome object and keep stderr separate.
Use its status and available reply, question, error, agent, and cost fields.
Handle the exit code explicitly; a timeout does not stop the agent:

| Exit | Meaning | Next action |
| --- | --- | --- |
| 0 | Done | Inspect changes and test evidence. |
| 1 | Failed | Read the error and logs before retrying. |
| 2 | Needs input | Read the question; answer with another send. |
| 75 | Daemon stopped/restarted | Inspect partial work, then send a continuation. |
| 124 | Wait timed out | Follow logs; do not duplicate a still-running task. |

`--timeout 3600` extends the CLI wait. `--fresh` resets this agent's chat session;
use it deliberately when old context is unnecessary, not as a routine retry.
`loom log -n 40` reads recent events; `loom log --follow` follows activity.

## Chats and shared context

`loom chat` opens the interactive shared thread. Its `/help` lists chat commands;
use one-shot `loom send` for automation. There is no send `--chat` flag here.
Other chats may pin an agent in the app; pinning a conversation does not take the baton.

```sh
loom digest --since 12
loom memory
loom decision "Keep the public API backward compatible."
loom find "parser regression"
loom find --all --json "parser regression"
```

Record a decision only when it reflects an agreed requirement.
Local find prints text; JSON output is implemented for the `--all` search path.
Report which agent did the work, the outcome, test evidence, and any reported cost.
Never interpret an absent cost as zero. Never paste secrets into prompts or commit `.loom/`.
Never run `loom up --restart --force` while someone's turns run.

## Choose the next skill

- [loom-orchestrate](../loom-orchestrate/SKILL.md): fan out one goal, follow and apply a run.
- [loom-chain](../loom-chain/SKILL.md): run goals across several projects in order.
- [loom-agents](../loom-agents/SKILL.md): add sessions, choose models and access modes.
- [loom-automation](../loom-automation/SKILL.md): schedules, webhooks, Slack and Discord.
- [loom-collaborate](../loom-collaborate/SKILL.md): share chats, teams, search and audit.
- [loom-ops](../loom-ops/SKILL.md): resource limits, diagnosis, restarts and cleanup.
