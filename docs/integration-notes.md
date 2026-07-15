# Integration surfaces — verified live

These are not guesses: each surface below was verified against the locally installed
tool before the adapter was written. Re-verify when versions move.

## Claude Code (verified: v2.1.83)

Headless invocation per turn:

```
claude -p "<prompt>" \
  --output-format stream-json --verbose \
  [--resume <session-id>] \
  [--append-system-prompt "<loom briefing>"] \
  --permission-mode acceptEdits
```

- `--output-format stream-json` — newline-delimited JSON events on stdout:
  - `{"type":"system","subtype":"init","session_id":...}` → capture session id
  - `{"type":"assistant","message":{"content":[{"type":"text"|"tool_use",...}]}}`
  - `{"type":"result","subtype":"success","total_cost_usd":...}` → run complete
- `--resume <session-id>` — continue the same conversation across turns.
- `--append-system-prompt` — **this is how Loom injects the handoff briefing** without
  touching user files.
- `--permission-mode` — `acceptEdits` default for baton holders (configurable).
- Interrupt = SIGINT to the child process (escalate SIGKILL).

## OpenCode (verified: v1.17.20)

`opencode serve --port <p> --hostname 127.0.0.1` per project dir, then HTTP:

| Purpose | Route |
|---|---|
| Health | `GET /api/health` |
| Create session | `POST /api/session` `{}` → `{ id: "ses…" }` |
| Send prompt | `POST /api/session/{id}/prompt` `{ "prompt": { "text": "…" } }` (async-admitted) |
| Wait for idle | `/api/session/{id}/wait` |
| Interrupt | `POST /api/session/{id}/interrupt` |
| Live events | `GET /event` (SSE) |
| Message detail | `GET /api/session/{id}/message/{messageID}` |

SSE event types Loom maps:
- `message.part.updated` (TextPart / ToolPart / PatchPart) → message, tool_call, file_edit
- `message.updated` with assistant `time.completed` → turn complete
- `permission.asked` / `question.asked` → **needs_input** (drives notifications)

Notes:
- Older docs say `POST /session/:id/message` and `/abort` — **wrong for 1.17.x**; it's
  `/prompt` and `/interrupt`.
- No per-prompt system-prompt field, so Loom prepends the handoff briefing to the first
  prompt after a handoff, clearly delimited.

Dogfood findings (verified live on 1.17.20):
- **`/wait` returns 503** `{"_tag":"ServiceUnavailableError","message":"Session wait is
  not available yet"}` — it's in the OpenAPI spec but stubbed. Loom's adapter therefore
  detects turn completion by **polling the message list** for a new completed assistant
  message (SSE remains the live-streaming fast path), and reconciles any text the SSE
  stream missed from the message detail.
- **Turns can end in `finish: "error"`** with an `error.message` (e.g. a provider
  rejecting headless auth). The adapter surfaces these as Loom error events.
- **`serve` sessions don't inherit your TUI's model.** A session created with `{}` used
  `github-copilot/gpt-5.6-luna` (which fails headless: "Personal Access Tokens are not
  supported") while the TUI default was `opencode/minimax-m2.5`. Set the model
  explicitly in the agent options: `{ "model": "opencode/minimax-m2.5" }`.
- Loom strips inherited `CLAUDE_CODE_*` / session `ANTHROPIC_BASE_URL` env before
  spawning agents — running `loom` from inside a Claude Code terminal otherwise poisons
  nested agent auth.

## Antigravity (bridge, best-effort)

Launched with a debug port it exposes a Chromium DevTools endpoint:
- `GET http://127.0.0.1:{port}/json/version` — presence check
- `GET http://127.0.0.1:{port}/json` — target list (read-only visibility)

No stable send/interrupt/memory surface → **Bridge tier** (never holds the baton),
receives projections via `.loom/memory/antigravity.md`.
