---
name: loom-ops
description: Diagnose Loom health, machine resource usage, daemon versions, and orphaned worktrees. Use for "Loom is slow", "agents are waiting", "restart Loom", "check memory usage", or "clean old orchestra worktrees".
---

# Keep Loom healthy

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
Use `loom doctor --fix` for its supported unambiguous repairs after reading the report;
it changes project state and does not solve every reported issue.

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

## Logs and state

```sh
loom log -n 40
loom orchestra --json
```

`loom log` reads the current project's events; it is not the daemon's crash log.
Global state defaults to `~/.loom` (overridden by `LOOM_HOME`).
Background daemon output appends to `~/.loom/daemon.log`; it rotates to
`daemon.log.1` once over 5 MB. Inspect only relevant, redacted excerpts.
`~/.loom/daemon.json` and provider settings contain credentials; do not dump them.
Project config/history/memory live under `.loom/`. Never commit it or hand-edit
live event storage. Never paste tokens or secret-bearing logs into prompts.

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

For missing executables or authentication, fix the reported install/login issue.
For provider keys visible only in the shell, fix the daemon's configuration.
For memory pressure, lower concurrency before considering any restart.
