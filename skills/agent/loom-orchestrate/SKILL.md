---
name: loom-orchestrate
description: Split Loom goals into parallel worktrees, select saved fleets or scoreboard models, compare implementations, and follow/apply runs. Use for "fan this out", "ask several agents", "save this fleet", or "follow this orchestra".
---

# Orchestrate one project

Require Loom ≥ 2.0.0.

Use an orchestra for one goal with parallel implementation or competing solutions.
Run from the intended Loom project. Require a git repository and known agents.
Use [loom-chain](../loom-chain/SKILL.md) for sequential goals across projects.

## Choose agents and scope

```sh
loom agents --json
loom limits --json
loom orchestrate "Add OAuth login, migration, and integration tests" -o claude-code -w codex,opencode,grok-code -p 3 --rounds 8 --max-usd 10 --solo --no-watch
```

Replace the example IDs with the actual roster. Pick an orchestrator that follows
structured planning instructions and workers capable of the required edits/tests.
The orchestrator plans and reviews; workers build in separate task worktrees.
Give the orchestrator acceptance criteria,
test commands, boundaries, and dependency hints in the goal.

- `-o` / `--orchestrator`: one `agent[@model][:effort]` planner/reviewer;
  default prefers Claude Code if present.
- `-w` / `--workers`: comma-separated fleet specs, `@name`, or `best:N`;
  default uses the project's agents.
- `-p` / `--parallel`: concurrent tasks, 1–12; default 4. Respect machine limits.
- `--rounds`: review-round budget; default 10.
- `--max-usd`: stop this goal at its reported spending budget; do not assume every
  adapter reports dollar costs or that this replaces provider billing limits.
- `--solo`: keep tasks on this machine even when team runners are available.
- `--no-watch`: return after starting. Capture the printed run ID.

Several tasks may use the same agent kind as separate sessions.
Split tasks by files and dependencies to reduce merge conflicts.
For a long task, ask the orchestrator to include `"timeoutMin": 60` on that task
in its plan. The field is clamped to 5–240 minutes; it is not a CLI flag.

## Save fleets and choose models

```sh
loom models codex
loom fleets --json
loom fleets:save parser "codex@MODEL_ID:high x2,opencode"
loom orchestrate "Fix the parser and test edge cases" -o codex -w @parser -p 2 --solo --no-watch
loom scoreboard --window 30d --json
loom scoreboard --all --window 7d
loom orchestrate "Fix the parser regression" -w best:2 -p 2 --solo --no-watch
```

Replace `MODEL_ID` with a reported model and use supported effort levels.
Fleet grammar is `agent[@model][:effort] xN`; compact `agent@model:effortx2` also
works. Quote specs containing spaces. Copies get distinct worker IDs and per-spawn
model/effort overrides. The orchestrator must resolve to one instance.
Inspect the expanded fleet and concurrency before launch; confirm large fleets
with the user unless that size is already authorized.

Saved fleets live in LOOM_HOME and work across projects, but each project's
agents must resolve. Save replaces the named definition. `loom fleets:rm parser`
removes that definition when requested. `fleets --json` returns `{fleets:[...]}`.
Use `@parser` in orchestrate, compare, or chain; saved definitions contain concrete
specs rather than nested fleet references.

Scoreboard defaults to this project over 30 days; windows are 7d, 30d, or all.
JSON includes `byKindModel` and `byModel` standings. Read sample counts alongside
completion, cost, latency, race/compare picks, and review results; missing cost
is unknown. `best:N` selects from this project's 30-day history only when N models
each have at least five race/compare entries; otherwise it retains the fallback
fleet. Use `best:N` as the entire worker selection, not alongside other specs.

## Ask several and keep one

```sh
loom compare "Implement a smaller parser and run its tests" -w @parser --wait
loom compare "Implement a smaller parser and run its tests" --best 2 -w codex,opencode --wait
loom compare RUN_ID --wait
loom compare RUN_ID --keep TASK_ID
```

A new comparison requires `-w` or `--best`; without either, the argument is a run
ID. It starts 2–8 entrants after expansion, each in a separate worktree. These
agents can edit files. `--best N` accepts 2–8 and falls back to `-w` or the roster
when history is insufficient; check that fallback also expands to 2–8 entrants.
Inspect replies, diffs, tests, time, and cost before choosing. `--keep` waits,
applies the selected successful task and removes the other worktrees: use only
when that merge and disposal are authorized. Read actual task IDs from the run.
Compare prints text, not JSON, and has no timeout flag. For a bounded wait use
`loom orchestra RUN_ID --wait --json --timeout 600`. Waiting_human needs an answer;
it is not a finished comparison.

## Plan or race

```sh
loom orchestrate "Plan the settings redesign as implementable specs" -o codex --plan --solo
loom orchestrate "Implement a smaller parser with equivalent tests" -w codex,opencode -p 2 --race --solo --no-watch
```

`--plan` writes markdown specs under `plans/<run>/`; it is not a read-only dry run.
`--race` gives every entrant the whole goal, with no orchestrator.
Compare the actual task diffs and test results before choosing an entrant.
Do not combine a race with automatic apply: choosing the winner is a separate step.

## Follow and steer

Replace `RUN_ID` with the returned ID; do not guess it.

```sh
loom orchestra --json
loom orchestra RUN_ID --json
loom orchestra RUN_ID --wait --json --progress --timeout 7200
loom orchestra:reply RUN_ID "Keep the API unchanged; add tests before accepting."
```

The list is a JSON array; one run is an object with `id`, `status`, `terminal`,
`tasks`, `branch`, and `costUsd`, plus a question when present.
Task counts include done, running, pending, needs_input, conflict, failed, cancelled.
Inspect these counts even when the run says completed.
Single-run inspection without `--wait` includes `workerModes`; waiting output does not.
`workerDetails` and `taskDetails` expose resolved worker IDs, model/effort choices,
and task results; task counts remain in `tasks`.
With `--wait --json --progress`, stdout is one final object and stderr carries
progress JSON lines. Without JSON, progress is human-readable.

Wait exits 0 for completed, 2 for waiting_human, 124 for timeout, and 1 for other
terminal states/failure. `reviewing` is still running. `moved` is terminal but not
local completion; inspect its branch/PR rather than applying blindly.
Reply to questions with `loom orchestra:reply`, then wait again on the same ID.
A wait timeout does not abort workers. For an interrupted, resumable run, use
`loom orchestra:resume RUN_ID` after checking its current state.

## Report from a worker

```sh
loom report --checkpoint "Implementation finished; running parser tests."
loom report --needs-input "Should empty input return null or an error?"
loom report --stuck "The required fixture is missing from this worktree."
loom report --done
```

Choose exactly one report option. Run inside the supplied Orchestra worker
environment: LOOM_API, LOOM_PROJECT_ID, LOOM_RUN_ID, LOOM_TASK_ID, LOOM_REPORT_TOKEN.
Never print or copy the token. Reports appear in `--progress`; they persist progress
and notify the orchestrator of questions/blockers, but do not change task status.
Report concrete checkpoints and test evidence; `--done` does not replace the final
worker response. Prefer `loom_report` when native MCP tools are attached; see
[loom-mcp](../loom-mcp/SKILL.md).

## Apply and push within the requested scope

```sh
loom orchestra:apply RUN_ID
loom orchestra:apply RACE_RUN_ID --task race-codex
```

Apply merges the integration branch into the current branch. Race apply keeps
the named successful entrant; use the actual task ID shown by the run.
Inspect the diff, task failures, and test evidence before applying.
For a goal explicitly authorized to merge automatically:

```sh
loom orchestrate "Fix the parser regression and test it" -o codex -w opencode -p 1 --solo --apply --no-watch --progress
```

Add `--push` only when publishing is authorized; it requires the `--apply` path.
`--no-watch` with `--apply` still waits, and enables the task-event progress path.
There is no orchestrate `--json`; use orchestra inspection for JSON.
Automatic apply scans the diff for secrets before merging, and refuses findings.
The CLI's scan belongs to `--apply` and chain; do not assume direct
`orchestra:apply` performs that same scan. Review secrets before manual apply too.

## Recover safely

- Unknown worker: inspect the roster and [add/configure agents](../loom-agents/SKILL.md).
- Blocked access: inspect `loom agents:mode codex`; do not silently grant bypass.
- Conflict or failed tests: send a precise correction to the orchestrator.
- Secret finding: remove the secret safely; never bypass the scan or print its value.
- Merge/push failure: check git state; a failed push can follow a successful merge.
- Never restart forcibly during active work. Never commit `.loom/` or put secrets in goals.
