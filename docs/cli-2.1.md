# CLI and agentic Loom 2.1 (#426)

This batch extends the existing replay renderer, Orchestra progress events, model scoreboard,
fleet storage, demo project creation and brain APIs. It adds entry points and missing UI rather
than introducing parallel implementations. Command-name completions and `send --wait --json`
already existed; their improvements are option-aware completions and streaming NDJSON.

## Automation

```sh
loom send --json "Review the changes"
loom ask --json --models provider/model-a,provider/model-b "Compare these approaches"
loom watch --run RUN_ID --json
```

`send --json` implies waiting. `ask --json` waits for every returned model chat. Both emit one
JSON object per line on stdout, with human diagnostics on stderr:

- `type: "accepted"`: the send receipt, or the `asked` array containing model/chat/agent ids.
- `type: "delta"`: live text (`text`, `agentId`, `chat`, `off`, optional `reasoning`). These are
  previews; the durable message is authoritative if a socket drops.
- `type: "event"`: a persisted Loom event (`id`, `ts`, `kind`, `payload`, optional `agentId`,
  `chat`), plus `project`. Event ids can be used for deduplication.
- `type: "outcome"`: one per chat, with `status`, `agent`, `chat`, `project`, and the reply/cost
  when reported. Status is `ok`, `error`, `needs_input`, `timeout`, or `interrupted`.
- `type: "error"`: a transport failure explaining an interrupted stream.

`--timeout` is in seconds (default 1800). Exit codes are 0 for success, 1 for agent failure,
2 for a question, 75 for agent or daemon interruption, 124 for timeout and 130 for a stopped watcher.
For multiple asks, a failure or question makes the exit status nonzero. Stopping a watcher
leaves the daemon's work running. Queued sends wait for their own dispatch receipt.

`watch --run` emits the existing progress shapes (`kind: run|round|planned|task|report`, with
`run` identifying the run). It remains attached during `waiting_human` and stops at completed,
failed, aborted or moved. Failure/abort exits 1. `--all` cannot be combined with `--run`.

## Local setup

```sh
loom completion bash  # also zsh and fish; source the output in that shell
loom init --list-templates
loom init --template web  # also node and library
loom config validate
loom alias set review -- send --wait "Review my changes"
loom review --json
loom alias list --json
loom alias rm review
loom export --format html --chat main --out chat.html
```

Aliases are argument arrays stored in `LOOM_HOME/aliases.json` (normally `~/.loom`). Arguments
are literal, never shell code. Extra invocation arguments are appended. Nested aliases work;
cycles are rejected and built-in commands take precedence. Web Settings → CLI aliases manages
the same store. Completions use the installed CLI's Commander definitions, including options
and user aliases, without contacting or starting a daemon.

Templates are dependency-free `web`, `node`, and `library` starters. Existing destination files
are never replaced. Web and phone new-project forms offer the same templates. New projects
include the starter in their initial Git commit. No dependency installation or server startup
occurs. Config validation reads the disk file, so it can explain a broken edit while the daemon
continues using its last good config. It is also available in web project Settings and phone
Project tools.

HTML export uses Loom's existing standalone replay renderer. The web chat menu offers Export
as HTML. Phone Project tools downloads it on web, asks for a destination folder on Android,
and opens the share sheet on iOS. Phone Project tools also shows the model scoreboard. The TUI
has a fifth Scoreboard view, reachable through Shift+Tab, `/scoreboard`, or the command palette.

## API and MCP

- `GET /api/templates` returns `{ templates: [{ name, description }] }`.
- `POST /api/projects` and `POST /api/projects/new` accept optional `template`.
- `GET /api/projects/:id/config/validate` returns `{ valid, errors: [{ path, message }], warnings }`.
- `GET /api/aliases` returns `{ aliases: { name: [command, ...args] } }`.
- `PUT /api/aliases` takes `{ name, args }`; `DELETE /api/aliases` takes `{ name }`.
- `GET /api/projects/:id/chats/:chat/replay?format=json` returns `{ filename, content }` for
  phone transports. The existing HTML endpoint and download mode remain available.
- MCP adds `loom_scoreboard` (optional project/window), `loom_fleets` (list), `loom_try`
  (optional absolute dir and agent count), and `loom_memory_list` (project, optional kind/limit).

All routes authenticate normally. Aliases, project creation, demo creation and saved fleets
require an owner/unscoped device. Scoped tokens only read permitted project configs, memories,
exports and standings; an all-project scoreboard is filtered to their scope. Share-live guests
cannot access these tools or routes. HTTP and stdio MCP preserve the caller's credential.
