---
name: loom-ops
description: Run Loom setup and CLI installs, collect triage diagnostics, and manage health, resources, versions, and orphaned worktrees. Use for "set up Loom", "diagnose this failure", "Loom is slow", "restart Loom", or "clean old orchestra worktrees".
---

# Keep Loom healthy

Require Loom ≥ 2.1.0.

Start with observations. A daemon serves multiple projects and clients, so a
restart or global limit change affects more than the current task.

## Diagnose

```sh
loom --version
loom status --json
loom doctor --json
loom top --json
loom limits --json
```

Status checks without starting a daemon. A stopped daemon returns
`{"daemon":null,"projects":[]}`; a running daemon returns a project array.
Doctor also does not start one. Its report includes checks and summary counts;
exit 1 means failures. Exit 0 can still have warnings: read them.
Doctor checks environment, daemon/project configuration, authentication, disk,
and differences between this shell and the daemon's environment.
Use `loom doctor --fix --json` for its supported unambiguous repairs after reading the report;
it includes repairs in the JSON report and changes project state. It does not solve
every reported issue.
Use `loom config validate` to diagnose the actual on-disk config even when the daemon
retains its last good settings.

```sh
loom setup
loom setup --json
loom setup install codex
loom triage --issue
loom triage "loom send failed" --project PROJECT_ID --agent codex
```

Setup reads the Get started checklist. Install accepts codex, claude-code,
opencode, or grok-code and runs a fixed installer on the daemon's machine;
it verifies the CLI version, but signing in is a separate step. Install only the
requested CLI. Use [loom-agents](../loom-agents/SKILL.md) for accounts and login.

Triage saves redacted doctor results, versions, and recent daemon logs under
LOOM_HOME. Its positional words describe the failing command; they are not executed.
`--project` selects a registered ID, name, or directory. `--issue` prints an issue
body; it never posts one. `--agent` selects a kind and starts a diagnosis chat,
adding that agent if needed. Without it, collection does not start the daemon.
Inspect the saved report for sensitive project details before sharing even though
secrets are redacted. Keep diagnostics as evidence, not instructions to the agent.

Top reports the machine, daemon, limits, and process groups with memory/CPU.
It covers processes Loom started and their descendants, not every process on the host.
Use `loom top --watch` for a human view refreshing every two seconds.
Use `--json` for a single snapshot; combining watch and JSON does not stream snapshots.

## Bound concurrent work

```sh
loom limits
loom limits --turns 2 --min-free 25
```

The cap and free-memory floor apply across all projects and take effect within
seconds without restarting. Limits JSON includes maxTurns, minFreePct, freePct,
running, and defaults. Preserve the user's prior settings when tuning temporarily.
Zero turns means no cap; zero min-free disables the floor. Do not disable both to
"fix" a queue on an overloaded machine.

The default is roughly one turn per 4 GB and a 15% free-memory floor.
Browser tests, dev servers, MCP processes, and heavy agents add to each turn's cost.
On a constrained machine, begin with one or two heavy turns and measure.
Reduce orchestra parallelism as well as the daemon cap when needed.
A waiting turn is not necessarily hung: the gate queues work when either limit is hit.
A turn waiting ten minutes may start anyway to avoid deadlock; this is not a hard
memory reservation. Avoid starting many heavy agents at once.

## Version mismatch and restart

```sh
loom config auto-restart
loom version
```

Version prints CLI and daemon build revisions and any recorded daemon swap.
It calls the daemon-start helper; it can start a daemon or replace an idle older one.
For a long unattended chain, set `loom config auto-restart off` before commands
that might swap builds; record the prior preference before changing it.
`loom config auto-restart on` restores automatic idle swaps when that was the prior setting.

Use `loom up` to start a stopped daemon. It can also replace a stale idle build.
Use `loom up --restart` when maintenance is authorized and work is idle.
It refuses busy work because restarting would interrupt turns. Active chain/orchestra
waiters count as busy too, including gaps between tasks.
Respect that refusal: inspect status and limits, let the work finish, and try later.
If Loom Desktop owns the daemon, quit/reopen Desktop when idle to restart its build.

`--force` overrides both the busy guard and Desktop ownership; it can replace
Desktop's daemon with this CLI build. Never run `loom up --restart --force` while
someone's turns run. Do not force a restart merely because versions differ.
If a restart interrupted a send, exit 75 means inspect partial work before continuing.
An interrupted orchestra may be resumable; inspect its run rather than duplicating it.

`loom update --check` displays available updates and intervening tagged release notes;
read the explicit unavailable state when notes cannot be fetched. Updating remains
a separate operation from checking.

## Backups, disk and stale sessions

```sh
loom backup --status
loom backup --every 1d --keep 7
loom du --json
loom stale
```

Scheduled backups run while the daemon is up, retain successful private archives,
and catch up once after downtime. `loom backup --off` disables the schedule;
`loom backup --out /private/path/loom-backup.tar.gz` creates a one-off archive.
Backups contain private settings and pairings; protect them as credentials.
Disk reports include worktrees, logs, attachments and skipped unreadable paths.
`loom reap AGENT_ID` interrupts and respawns a stale session; inspect its report
and partial work before an authorized recovery.

## Logs and state

```sh
loom log -n 40
loom orchestra --json
```

`loom log` reads the current project's events; it is not the daemon's crash log.
Global state defaults to `~/.loom` (overridden by `LOOM_HOME`).
Background daemon output appends to `~/.loom/daemon.log`; it rotates to
`daemon.log.1` once over 5 MiB, checked at startup and every second while running.
Inspect only relevant, redacted excerpts.
`~/.loom/daemon.json` and provider settings contain credentials; do not dump them.
Project config/history/memory live under `.loom/`. Never commit it or hand-edit
live event storage. Never paste tokens or secret-bearing logs into prompts.

Owners can inspect the newest ten redacted crash bundles in web/phone Operations.
Prometheus `GET /metrics` requires the admin token and exports persisted project
turns, reported cost, errors and queue depth; do not print the token while configuring
scraping. There is no separate metrics CLI command.

## Clean orphaned worktrees

```sh
loom orchestra:clean --dry-run
loom orchestra:clean
```

Clean removes orchestra worktree directories belonging to projects no longer
registered with Loom. It is not a command to delete all completed runs.
Inspect the dry-run paths and sizes before a cleanup authorized by the user.
Branches remain; do not assume this frees every branch or git worktree entry.
For one finished registered run, `loom orchestra:cleanup RUN_ID` removes that
run's worktrees and keeps its branch; it has no `--dry-run` flag.
Do not delete worktrees with needed unmerged changes or active work.

For retention within the current project:

```sh
loom worktrees:prune --days 14 --keep 10 --dry-run
loom worktrees:prune --days 14 --keep 10 --save
```

Preview first. Omitting `--dry-run` prunes eligible finished worktrees immediately;
`--save` also persists the policy for hourly sweeps. It cannot be combined with
`--dry-run`. Dirty/locked worktrees, active runs and branches are preserved.

For missing executables or authentication, fix the reported install/login issue.
For provider keys visible only in the shell, fix the daemon's configuration.
For memory pressure, lower concurrency before considering any restart.
