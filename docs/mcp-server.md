# Loom as an MCP server

An agent can use Loom to start other agents, send and steer messages, run an
Orchestra, compare models, search shared memory, record decisions, and report
worker progress. This is separate from `loom mcp`, which configures outside MCP
servers for Loom to consume. No MCP SDK or additional dependency is required.

## Connect an agent CLI

Start the local daemon (`loom daemon`), then register Loom:

```sh
loom connect claude --dry-run
# claude mcp add loom -- loom mcp-server
loom connect claude
loom connect codex
loom connect opencode
loom connect grok
loom connect --list
```

All four use `<agent> mcp add loom -- loom mcp-server`. `claude-code` and
`grok-code` are accepted aliases. The agent CLI owns configuration and its
registration scope; run the command in the project where you want the server.
Loom never edits an agent's config file. `--list` asks each CLI's `mcp list`,
including registrations made outside Loom. A failed or missing CLI is reported
as unavailable. `--dry-run` only prints commands, including with `--list`.

Use a version of the CLI that supports these commands. References:
[OpenCode MCP management](https://opencode.ai/docs/mcp-servers/),
[Grok MCP management](https://docs.x.ai/build/cli/reference).

For another MCP client, register this stdio server:

```json
{"mcpServers":{"loom":{"command":"loom","args":["mcp-server"]}}}
```

`loom mcp-server` reads the existing daemon address and CLI token from
`LOOM_HOME` (normally `~/.loom`). It does not autostart, restart, or switch the
daemon. Stdout contains only newline-delimited JSON-RPC; diagnostics use stderr.

## HTTP transport

The same tools are available at `POST /mcp` on the daemon origin. This is
stateless Streamable HTTP with JSON responses. Supply:

```text
Authorization: Bearer <existing Loom token>
Content-Type: application/json
Accept: application/json, text/event-stream
MCP-Protocol-Version: 2025-06-18
```

An initialize request:

```json
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"example","version":"1"}}}
```

The response advertises protocol `2025-06-18` and tools capability. Send
`notifications/initialized`, then `tools/list`, `tools/call`, or `ping`.
Notifications receive HTTP 202 with an empty body (no response over stdio).
Notifications cannot invoke tools. Requests return one JSON-RPC response, with
no session id or SSE subscription; GET and DELETE return 405. An absent version
header or `2025-03-26` is accepted for transport compatibility. Unsupported
version headers return 400. Browser origins must match the endpoint's host and
port. The request body limit is 2 MB.

Missing/invalid tokens return 401. Shared-chat guests receive 403. Existing
project-scoped pairing tokens list only their allowed projects, and every tool
call goes through the existing REST project scope wall, including project-name
resolution. The original caller's token is forwarded; it is never replaced
with an admin token.

## Tool contract

`tools/list` is the authoritative JSON Schema catalog. Inputs are strict
objects; unknown fields and incorrect types produce JSON-RPC `-32602`.
Project tools require `project` (project id or name). Obtain ids using
`loom_projects`. Unless specified, `chat` defaults to `main`.

| Tool | Inputs beyond `project` | Structured result |
| --- | --- | --- |
| `loom_status` | `project` is optional | `{project}` or `{projects}` with runtime statuses |
| `loom_projects` | No inputs, including no `project` | `{projects}` visible to this credential |
| `loom_agents` | None | `{agents}`; each has its available `models` |
| `loom_add_agents` | `kind`, optional `model`, `count` (1–100) | First agent config plus `agents` array |
| `loom_chats` | None | `{chats}` |
| `loom_read_chat` | Optional `chat`, `limit` (1–1000, default 50) | `{messages: LoomEvent[]}`, chronological, filtered before limiting |
| `loom_send` | `text`; optional `chat`, `agent`, `model`, `effort`, `wait`, `timeoutMs` | Send receipt; when waiting, outcome and `timedOut` |
| `loom_steer` | `text`; optional `chat`, `agent` | `{steered:true}` or queue receipt and reason |
| `loom_orchestra_start` | `goal`, `workers: string[]`; optional `orchestrator`, `maxParallel`, `plan` | `{run}` |
| `loom_orchestra_status` | Optional `run` | `{run}` or `{runs,active}` |
| `loom_compare` | `prompt`, `entrants: string[]`; optional `wait`, `timeoutMs` | `{run}`, plus `timedOut` when waiting |
| `loom_brain_search` | `query`, optional `limit` (1–50) | `{hits}` with memory and score |
| `loom_remember` | `text`, `kind`: `decision`, `constraint`, or `convention` | `{memory,created}` |
| `loom_report` | `run`, `task`, `kind`; optional `text` | `{report:{at,kind,text}}` |
| `loom_board` | `action`: `list` or `add`; add requires `title`, optionally `agent`, `column` | `{tasks}` or `{task}` |

A tool result contains both `content: [{type:"text",text:JSON.stringify(data)}]`
and `structuredContent: data`. Operation failures have `isError:true`, a text
explanation, and `structuredContent:{error:string}`. Protocol errors use
JSON-RPC error codes: parse `-32700`, invalid request `-32600`, unknown method
`-32601`, unknown tool or invalid arguments `-32602`.

`loom_send` uses the daemon's normal per-message model/effort validation and
queue. With `wait:true`, it waits for its own `turn_started` request id, so a
previous turn's completion cannot be mistaken for its reply. A completed
outcome contains `status` (`ok`, `error`, `needs_input`), `agent`, `reply`,
`costUsd` (nullable), and optionally `durationMs`, `error`, or `question`.
Timeouts return the receipt with `timedOut:true`; the underlying work continues.
Waits default to 60,000 ms and accept 1–300,000 ms. Comparison waits stop at a
terminal run or `waiting_human`; read `run.status` to distinguish them.

Fleet entries use the existing `agent[@model][:effort] xN` grammar, for example
`codex@gpt-5.4:high x2`. Compare expands to 2–8 entrants. `workers` and `entrants`
are arrays of specs, not comma-delimited strings. They use enabled project
agents and the existing Orchestra worktree lifecycle. These tools do not expose
apply, cleanup, or deletion actions.

Reports use the existing report API. Kinds are `checkpoint`, `needs_input`,
`stuck`, and `done`; text is required except for `done` and is limited to 4000
characters. Reporting never changes task status. Only owner/admin credentials
or the matching worker credential may report. Runs expose the latest 20 reports
and `lastReport`; existing `orchestra` WebSocket events carry updates.

Read tools advertise `readOnlyHint:true`. Send, steer, Orchestra start and
compare advertise `destructiveHint:true` because agents can edit files. Agent
addition, memories, reports and board additions advertise
`destructiveHint:false`. `loom_board` is not advertised as read-only because it
also supports addition. No tool deletes data.

## Project option and worker credentials

Set `loomTools: true` in `.loom/config.json`, or use:

```http
PATCH /api/projects/:id/config
Content-Type: application/json

{"loomTools":true}
```

GET `/api/projects/:id/config` and the PATCH response include the effective
`loomTools:boolean`, defaulting to false. Non-boolean PATCH values return 400.
Changes apply to the next turn. Regular turns, subagents, and orchestrators
receive the server when enabled. Orchestra workers receive it automatically,
including compare entrants. Attachment requires an MCP-capable adapter; an
adapter without MCP support retains its existing behavior.

The server is attached through existing per-agent MCP configuration as a stdio
process using the current Node executable and Loom entry point. This also works
in a source checkout and avoids relying on an agent's PATH or HTTP-header
support. It receives `LOOM_MCP_API`, `LOOM_MCP_TOKEN`, and `LOOM_PROJECT_ID`;
workers also receive `LOOM_RUN_ID` and `LOOM_TASK_ID`. Initialize instructions
supply these non-secret ids for native tool calls. Both MCP environment overrides
must be supplied together; an incomplete override never falls back to admin.

Credentials are random, held in daemon memory, scoped to the project and (for
reports) the particular run/task. They cannot access daemon-wide management
routes or another project's API. The temporary MCP file and credential are
removed when the turn settles, including failure/interruption. Credentials do
not enter `daemon.json` or Orchestra run records and do not survive a daemon
restart. Existing `LOOM_REPORT_TOKEN` credentials remain report-only.

The REST API additionally exposes
`GET /api/projects/:id/chats/:chat/messages?limit=N` for UI consumers. It returns
`{messages:LoomEvent[]}` in chronological order, limited after filtering to
message events on the active chat branch. `limit` defaults to 50 and must be an
integer from 1 through 1000. The existing messages POST accepts `requestId`;
`status` events with `state:"turn_started"` carry the effective id. Legacy
queued sends return `requestId:"queue:<queueId>"`; native continuity keeps its
request id. These additions require no web or phone screen changes.

Design reference: [T3 Code's MCP server and toolkits](https://github.com/pingdotgg/t3code/tree/main/apps/server/src/mcp)
(MIT), credited in the implementation header. Loom implements its own protocol
and uses its existing daemon client, authorization, and APIs.
