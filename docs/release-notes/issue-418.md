# Issue 418: models and routing

The implementation extends the existing model selection, accounting and scoreboard paths.
No README changes and no separate duplicate routing system.

| Item | Existing behavior checked | Improvement |
| --- | --- | --- |
| Aliases | Provider/CLI aliases and explicit chat models | User alias map, cycle validation, shared resolution including fleet specs |
| Fallback | ModelAdapter already retried configured fallbacks on 402/429; CLI quota relay already existed | Validated per-agent editing, aliases and provider-qualified fallbacks, cap checks |
| Reasoning | Per-agent and per-chat effort | Project default, with explicit turn/chat/agent precedence |
| Health | Agent readiness and provider model catalog probes | Bounded one-token model request, latency/error history in Settings and CLI |
| Estimate | Composer rough token count, historical forecasts, cold-session estimate | Selected-model pre-send price and context estimate on web/phone |
| Caps | Agent budgets and free-provider request caps | Per-model token/USD limits across projects, UTC reset and 80% warning |
| CSV | Scoreboard JSON, tables and window/scope selection | CSV API, CLI export, web download, phone share |
| Options | Some field-specific checks and config warnings | Save-time argument/option validation and dedicated editors |
| Digest | General project activity digest | Seven-day scoreboard digest and optional persisted Monday notification |

## Configuration and API

`loom models:config` reads machine model settings. Pass a JSON file to replace them:

```json
{
  "aliases": { "fast": "ollama/qwen3", "smart": "openrouter/vendor/model", "cheap": "fast" },
  "caps": { "smart": { "usd": 5, "tokens": 100000 } },
  "mondayDigest": false
}
```

Caps are stored against resolved model IDs. Removing an alias does not remove a cap.
USD usage uses reported cost where present, otherwise the cached model price; unknown
prices remain unavailable. Estimates assume 1,024 output tokens unless the agent sets
`maxTokens`, include the known session size, and are approximate. Caps refuse new work
once recorded usage reaches the limit; an already-running provider request can cross it.

`loom models:effort high` sets the project default (`default` clears it).
`loom agents:options AGENT '{"extraArgs":[],"fallbacks":["cheap"]}'` edits a model agent;
CLI agents use extra arguments and effort, and retain their quota-relay configuration.

- `GET/PUT /api/model-routing`: aliases, caps, Monday opt-in; GET also returns usage and saved health.
- `POST /api/model-routing/health`: fresh bounded model probes. These send a one-token request and may incur provider charges.
- `PATCH /api/projects/:id/config`: `defaultEffort` (`low`, `medium`, `high`, or empty).
- `GET/PUT /api/projects/:id/agents/:agentId/options`: extraArgs, fallbacks and effort.
- `POST /api/projects/:id/estimate`: text, optional agentId/chat/model; approximate input/output tokens, USD or null, and cap status.
- `GET /api/scoreboard?format=csv`: attachment; `format=csv-json` wraps the same CSV for authenticated web/phone clients. Existing project/window filters apply; `by=byModel` exports model-only rows.
- `GET /api/scoreboard?digest=1`: seven-day text and scoreboard data.

Machine settings/probes require owner/admin. Scoped tokens and shared-chat guests cannot
use the new settings, estimate or export endpoints. Existing scoped scoreboard JSON
behavior remains unchanged. Project editing is available to unscoped paired devices.
Monday notifications use the daemon machine's desktop notification mechanism and UTC,
with a persisted date marker to avoid sending again after a restart.
