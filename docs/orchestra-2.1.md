# Orchestra 2.1: issue #417 implementation notes

## Existing-feature audit

Checked `src/core/orchestra.ts`, `src/core/recipes.ts`, fleet expansion, daemon routes, CLI commands, the web Orchestra module/styles, and the phone Orchestra view before building.

| Item | Existing behavior | Change |
| --- | --- | --- |
| Single-task retry | Orchestrator follow-up messages reran a task on its pinned worker. | Human/API reassignment to another agent/model, preserving worktree and dependencies. |
| USD cap | `maxUsd`, 80% warning, `waiting_human` pause, and reply-to-extend already existed. | Validate caps; expose budget settings in web/phone; explicitly raise a budget and resume pending work. Account for remote task cost too. |
| Mermaid export | Web displayed a task graph. | Portable Mermaid API, CLI export, web/phone copy. |
| Recipes | Machine-local recipes stored prompt queues and roles. | Separate Orchestra recipes preserve goal, resolved fleet, and run options without changing queue recipes. |
| Stalled workers | Worker progress reports and task timeouts existed. | Track output/report inactivity, mark stalls, clear them on progress, and offer reassignment. |
| Timeline | Task timestamps, start/end events, and a web duration strip existed. | Persist per-attempt event history, expose an API, add report/retry events to the view and a phone strip. |
| Per-kind parallelism | A total per-run limit and team capacity policy existed. | Apply a kind limit in addition to those limits, counting workers awaiting team admission. |
| Dry-run plan | `--plan` wrote durable markdown specs, then ran workers. | `--plan-only` requires explicit approval; preview includes prompts and dependencies. It can be combined with `--plan`. |
| Completion webhook | Inbound trigger webhooks and team GitHub webhooks existed. | Outbound signed completion for a run, with a project-local secret and recorded delivery outcome. |

## API and CLI

New start options for `POST /api/projects/:id/orchestra`:

```json
{
  "goal": "Build the feature",
  "workers": ["codex@modelx2"],
  "maxUsd": 5,
  "planOnly": true,
  "stallMinutes": 10,
  "kindLimits": { "codex": 2 },
  "webhookUrl": "https://example.com/loom-complete"
}
```

`maxUsd` and `stallMinutes` must be finite positive numbers; kind limits are integers from 1 to 100. Omitted kind limits use the overall run limit. `planOnly` cannot be combined with a race. Planning consumes model budget; approval does not bypass a depleted budget. An already-running worker finishes its turn when the budget is reached, so the cap is a scheduling limit rather than a provider billing guarantee.

Paths relative to `/api/projects/:id/orchestra/:runId`:

- `POST /tasks/:taskId/retry { "agent": "agent@model:effort" }`: choose a local replacement for a failed, cancelled, blocked, or stalled task. Wait for the old turn to settle before starting the replacement. Merged tasks and applied/moved runs cannot be retried. Dependencies and the task worktree survive; the attempt count increases only when the replacement starts.
- `POST /budget { "maxUsd": 10 }`: update the budget; pending work resumes if this clears a budget pause.
- `POST /approve-plan {}`: approve once. Ordinary replies cannot accidentally approve a preview.
- `GET /graph`: `{ "mermaid": "flowchart TD\n..." }`.
- `GET /timeline`: `{ "events": [{ "at": 123, "taskId": "task", "attempt": 1, "phase": "task_started" }] }`. Reports add `text`; all timestamps are server milliseconds. Events survive restarts, including history beyond the latest 20 task reports.
- `POST /recipe { "name": "Daily fleet" }`: save the run's goal, resolved fleet and options.

`GET /api/orchestra-recipes` lists Orchestra recipes. `PUT /api/orchestra-recipes { "name": "...", "options": { ... } }` saves or replaces one. `POST /api/projects/:id/orchestra-recipes/:name/run {}` starts one in a new thread. Recipes omit chat and adopted-PR identity. Existing queue recipes remain under `loom queue recipes`.

The start and mutation endpoints above, machine recipe access, and webhook-secret access require owner/admin credentials. Scoped devices and Share-live guests are refused. Worker report credentials still authorize only their report endpoint.

CLI additions:

```sh
loom orchestrate "Build the feature" --plan-only --max-usd 5 --kind-limits '{"codex":2}' --stall-minutes 10 --webhook-url https://example.com/complete
loom orchestra:approve RUN
loom orchestra:retry RUN TASK agent@model:effort
loom orchestra:graph RUN
loom recipes save NAME RUN
loom recipes run NAME
loom recipes
```

## Webhook contract

A successfully completed run sends one POST attempt to its `webhookUrl`. The JSON body includes `event: "orchestra.completed"`, project id, run id, status, goal, summary, cost, and task outcomes. Redirects are refused; the request times out after ten seconds. Failures do not alter the run's completed state. `webhookDelivery` records pending/sent/failed and the error; the web and phone display it. No automatic retry is made, avoiding duplicate side effects at receivers.

`X-Loom-Signature-256` is `sha256=` followed by hex HMAC-SHA256 of the exact body bytes. `X-Loom-Delivery` is the run id, usable for receiver deduplication. Owners retrieve the signing secret using `GET /api/projects/:id/orchestra-webhook-secret`; the daemon creates it once in `.loom/webhook-secret` with mode 0600. It is shared by runs in that project and never included in run records, recipes, or timeline events. Receivers should verify the HMAC before processing a delivery.

## Verification

New tests live in `test/r3-orchestra-fleets.test.ts`, `test/r3-orchestra-dom.test.ts`, and `app/test/r3-orchestra-options.test.mts`. They use real ephemeral daemons, temporary `LOOM_HOME`, git worktrees, echo workers, and a local webhook receiver. The DOM tests mount the actual rebuilt inlined web page. No real agent CLIs are used.
