---
name: loom-chain
description: Run and merge Loom goals sequentially across several projects with preflight checks and machine-readable results. Use for "run this across my repos", "chain these projects", or "work through these goals overnight".
---

# Chain goals across projects

A chain starts one orchestra per line, waits for it, scans its diff for secrets,
and merges it into that project's branch before starting the next line.
This changes working branches. Confirm the requested scope includes those merges;
add publishing only when the user has requested it.

## Prepare the file

Read `loom projects --json` for registered names and directories.
Use a project name, ID, or folder on the left of `::`.
Use one goal per line. Blank lines and lines beginning with `#` are ignored.
Options in brackets after `::` override command-wide run defaults.

```text
# <project> :: [run options] <goal>
api :: [-o codex -w opencode,grok-code -p 2 --solo --max-usd 5] Add rate limiting and integration tests.
/work/customer portal :: [-o grok-code -w codex -p 1] Add accessible error messages and test them.
```

Spaces in the project path are literal; do not add shell quotes inside the file.
Only these line options are parsed: `-o` / `--orchestrator`, `-w` / `--workers`,
`-p` / `--parallel`, `--solo`, and `--max-usd`.
The bracket parser splits on whitespace; avoid values requiring shell quoting.
Choose agents that are available in each target project.

## Check before a long run

```sh
loom chain plan.txt --check --json
```

Always run `--check` before a long chain, using the same file and run defaults
as execution. It starts no goals. It can still start/connect to the daemon.
Read `{ok,steps}`: each step includes project, resolved workers/modes, errors,
and warnings. Exit 1 means a check failed; exit 0 does not mean no warnings.

Resolve missing projects, missing folders, uncommitted tracked changes, unavailable
agents, and configuration typos. Check `.loom/` is ignored; its absence is a warning,
not a failing exit. Preflight does not reject all untracked-file collisions.
Inspect git status yourself, and do not discard or stash someone else's work blindly.
Initialize an intended new project from its folder with `loom init --gitignore`.
An access warning is not permission to switch an agent to bypass.

## Execute and capture results

For a long unattended run, inspect `loom config auto-restart`, then use
`loom config auto-restart off` to keep it on its starting daemon build.
Record the prior setting; restore it afterward only if you changed it.

```sh
loom chain plan.txt --check --json -o codex -w opencode -p 2 --solo --max-usd 5
loom chain plan.txt --json --progress -o codex -w opencode -p 2 --solo --max-usd 5 >chain-result.json 2>chain-events.jsonl
```

The command defaults apply to each line unless its brackets override them.
`--max-usd` is per run, not a cap on the entire file.
`--push` pushes each successfully merged branch to origin; omit it for local work.
`--keep-going` continues after a failed project; otherwise the chain stops there.
Do not use keep-going when later goals depend on earlier results.
The file is optional: `loom chain - --check` reads a plan from stdin.

With `--json`, stdout is one `{ok,steps}` summary.
Stderr gets `{"step":...}` records as outcomes happen; `--progress` also adds
`{"progress":...}` records. Keep the streams separate and allow diagnostic text
on stderr. A nonzero exit or `ok:false` requires inspecting each result.
Execution steps include project, runId, status, ok, and optional merge/push/error fields.
Compare the returned steps with the plan; stopping early leaves later lines unrun.

## Interpret and recover

- "Already on origin" means origin already contains the work, local was
  fast-forwarded, and no additional push was needed. It is successful, not skipped work.
- A secrets result means nothing was applied through that step's apply path.
  Fix the diff without revealing the secret; do not bypass the scan.
- A push failure can mean the merge already succeeded. Inspect git before retrying.
- A waiting_human result needs `loom orchestra:reply RUN_ID "the answer"` in that
  project's folder, then `loom orchestra RUN_ID --wait --json`.
- The chain process does not resume itself after that reply. Finish the existing
  run using [loom-orchestrate](../loom-orchestrate/SKILL.md), then create/check a plan
  containing only the remaining goals. Re-running the whole file starts new runs.
- On interruption, inspect existing run IDs before starting replacement work.

Never run `loom up --restart --force` while someone's turns run.
Never paste tokens into goals, commit `.loom/`, or increase permissions silently.
Report each project's result, applied branch, push outcome, and unfinished goals.
