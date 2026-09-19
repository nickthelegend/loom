# Source map

Loom is one Node process, the **daemon**, that drives agent CLIs and serves every
client: the CLI/TUI, the web app, the desktop shell, the phone. Everything below
is TypeScript compiled to `dist/` (`npm run build`).

## `core/`: the logic, no HTTP

| File | Role |
|---|---|
| `eventlog.ts` | The append-only event log (SQLite); every other state is a fold of it |
| `baton.ts`, `router.ts`, `routes.ts` | Who holds the conversation, and multi-hop pipelines |
| `projection.ts`, `distill.ts`, `memory.ts` | What an agent is told when it takes the baton |
| `brain.ts`, `brain-index.ts`, `brain-extract.ts` | The event-sourced brain: memories, retrieval, extraction |
| `orchestra.ts` | One orchestrator, many workers, each in its own worktree; delivery, landing state, moving goals between machines |
| `permissions.ts`, `approvals.ts` | Bypass / auto / always-ask per CLI, and the approval broker |
| `git.ts`, `worktree.ts` | Git plumbing |
| `skills.ts`, `mcp*.ts`, `prompts.ts` | Skills, MCP servers, the prompt manager |
| `relay-*.ts` | Loom Cloud: end-to-end encrypted relay framing |
| `team-hub.ts` | Loom Teams: the hub protocol (`HubClient`) and the in-memory reference hub |
| `team-crypto.ts` | Team keys, sealed boxes, signatures, invite fragments, memory HMACs |
| `team-leases.ts`, `team-policy.ts` | Leases, overlap, hard zones; `loom.team.json` |
| `team-memory.ts`, `team-canon.ts` | Tiered team memory; canon in `AGENTS.md` |
| `team-landing.ts` | Landing decisions: checks, flakes, review, stacks, doctor, cost, the landing train (lanes, turns) |
| `github-events.ts` | GitHub PR, check, review and deploy facts as feed events, from polling or webhooks (same dedupe keys); webhook signatures |
| `runner-setup.ts`, `hosted.ts` | Runner service files and token checks; the hosted hub's address |

## `daemon/`: the process

| File | Role |
|---|---|
| `server.ts` | HTTP + WebSocket API, auth, pairing, push |
| `runtime.ts` | One open project: agents, log, brain, orchestra, briefings |
| `app-page.ts` | The whole web app, as one HTML string (no build step) |
| `team.ts` | Team Link: this daemon on a team hub |
| `team-coordinator.ts` | Phase 2: leases, holds, WIP refs, conflict prediction |
| `team-brain.ts` | Phase 3: publishing, the tiered pool, canon PRs, the inbox |
| `landing.ts` | Phase 4: goal PRs — checks, fixes, review, Land, adopt, doctor |
| `runner.ts` | Phase 5: this daemon as a runner |
| `deploys.ts` | Deploy status and release notes |
| `relay.ts`, `push.ts` | Loom Cloud relay and phone push |

## Elsewhere

- `adapters/`: one file per agent CLI ([README](adapters/README.md)).
- `hub/`: the self-hosted and hosted team hub clients ([README](hub/README.md)).
- `cli/`: `loom …` commands and the TUI.
- `mcp/`: Loom's own MCP server (approvals, tools for agents).
- `observability/`: telemetry.
- `sdk.ts`, `index.ts`: the programmatic API.
