---
name: loom
description: Drive Loom's local agents, demo, bundled skills, MCP connections, shared memory, and chats. Use for "use Loom", "try Loom", "connect Loom tools", "send this to Codex", or a baton handoff.
---

# Drive Loom

Loom is a local-first control plane: one daemon drives installed agent CLIs,
ACP agents, and model endpoints. Projects share memory across agent sessions.
The app, CLI, phone, bridges, and teams talk to that daemon.
Require Loom ≥ 2.0.0. Run project commands from the intended project folder.
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

## Try, set up, and install skills

```sh
loom try --no-open --agents 3
loom setup --json
loom skills agents --json
loom skills install loom --agent codex --dry-run
loom skills install loom --agent codex
```

Try creates or reuses a demo under the daemon's projectsRoot; `--dir PATH` chooses
the destination. Its agents are scripted, offline, and free. Edits are real;
streamed command output and usage are simulated. Use real agents for custom work.
Setup shows the Get started checklist; use [loom-ops](../loom-ops/SKILL.md) for CLI installs.

The bundled-skills commands work without a project or daemon. `--agent` accepts
claude-code, codex, grok, opencode, or all (default). Codex and OpenCode share
`~/.agents/skills`. Install creates missing directories and protects unmanaged
same-name folders. Inspect conflicts rather than trying to overwrite them.
Use `loom skills uninstall loom --agent codex --dry-run` before a requested removal;
omit `--dry-run` to remove managed copies, including OpenCode's shared copies.
`--target /path/to/skills` selects a custom destination instead of standard ones
unless `--agent` is also given. The bundle is the installed Loom release's copy;
install this repository separately for its latest skills.

For a new real project, `loom new example --agent codex` creates and registers it
under projectsRoot, including Git initialization and a first commit.
`loom clone REPOSITORY_URL --name example` clones and registers an existing repo.
Read the returned project ID and directory before sending work.

## Connect Loom tools

```sh
loom connect codex --dry-run
loom connect codex
loom connect --list
```

Run registration in the intended project. Supported CLIs are claude, codex,
opencode, and grok (claude-code and grok-code are aliases). Their own MCP command
controls registration scope. For another MCP client, register command `loom`
with arguments `["mcp-server"]`.
OpenCode's registration is interactive: choose a local server and enter
`loom mcp-server` when prompted.

`loom mcp-server` serves stdio JSON-RPC and uses existing daemon credentials;
it does not start or restart the daemon. Start it with `loom up` when authorized.
This differs from `loom mcp`, which configures servers consumed by Loom.
For agents running inside Loom, project config `loomTools: true` in
`.loom/config.json` enables project-scoped tools on the next turn; default is false.
Orchestra workers receive tools automatically when their adapter supports MCP.
Use [loom-mcp](../loom-mcp/SKILL.md) when those native tools are available.

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
loom steer "Preserve the existing API; add a regression test." --chat main
loom btw "Why does this parser buffer input?" --chat main
loom chat:title main
loom chat:title main "Parser regression"
loom open --in code
loom open src/parser.ts:42 --in last
```

Steer adds input to a running turn where supported; otherwise it queues the input
and prints the reason. Do not send the same correction again after a queue receipt.
Btw asks a private read-only side question using the parent's agent/model without
changing the main history or memory; it prints the reply and closes the side chat.
Its `--chat` takes a chat ID. Chat title accepts an ID or title; `--auto` derives a
title only for a default-named chat. An explicit title and `--auto` are alternatives.
Open without a file or `--in` opens the app. Editor mode requires an installed
editor ID; `last` reuses the saved choice. Paths are relative to the shell and must
stay inside the project. Use [loom-agents](../loom-agents/SKILL.md) for model selection
and [loom-collaborate](../loom-collaborate/SKILL.md) for conversation branches/moves.

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
- [loom-mcp](../loom-mcp/SKILL.md): native Loom tools, bounded waits, and worker reports.
