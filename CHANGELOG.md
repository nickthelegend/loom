# Changelog

All notable changes to Loom are documented here.

The format loosely follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Design — quiet graphite (2026-07-16)

- Every surface redesigned on one system adapted from
  [Orca](https://github.com/stablyai/orca) (MIT): neutral monochrome tokens,
  1px hairlines, three elevation tiers with a glass floating layer, and color
  reserved for state — thread cyan (live), shuttle magenta (baton), selvage
  edges per agent. Spec in `docs/design-system.md`.
- Web app: light + dark themes with a persisted in-app toggle, Geist variable
  type served by the daemon at `/app/fonts/geist.woff2` (SIL OFL 1.1, embedded
  — no CDN), SVG icon set replacing emoji, Orca button/input/card/chip
  variants, sleek scrollbars, and a readable centered thread column.
- Desktop web shell (≥900px) is the full Orca workspace: project groups with
  nested agent rows in the sidebar (status dots, baton badge, click-to-target),
  a tab strip over the pane (Thread | Changes | Brain | Routes), per-file diff
  cards with add/delete washes, a Source-control right rail (≥1200px) whose
  file rows jump to their diff, and a status bar (websocket liveness, host,
  baton, working count, total spend).
- Desktop shell: Orca window chrome — canvas-colored background, macOS
  traffic lights at x16/y18 centered in 48px drag strips, 600×400 minimums,
  restyled failure page.
- Phone app: graphite surfaces, near-white primary CTA, accessory-key agent
  chips, session top bar + neutral-underline tabs, command-dock composer with
  an arming send button, diff washes, numbered pairing steps.
- Desktop chrome tightened to Orca's: tabs live in the 40px top strip beside
  the project context; the sidebar gains a Search row (filters projects and
  agents), an add-project action, and a bottom utility rail.
- Split workspace: the Changes pane docks beside the Thread (persisted
  toggle, default on ≥1280px) under a project/branch breadcrumb; diff cards
  gain old/new line-number gutters; `turn_diff` events render as expandable
  terminal-style `Update(n files)` cards; the thread tops with an agent
  header block (monogram, role, baton, project dir); sidebar projects wear
  hash-hued repo glyphs and the status bar a real spend meter. `BUILD_REV`
  now also hashes the served app so UI-only rebuilds bump the rev.
- Fixed: the desktop web shell now renders the hash-addressed project on
  first load; live websocket frames buffer until history hydrates (an early
  event could previously wipe the rendered backlog).
- Fixed: the desktop shell could open yesterday's UI. `BUILD_REV` is now a
  content hash (mtimes skew across runtimes on exFAT), the shell restarts a
  stale daemon before loading, spawns the daemon under a real Node runtime
  (Electron's bundled Node predates `node:sqlite`, silently degrading the
  event store), and `/app` is served `Cache-Control: no-store`.

## [0.1.0] — 2026-07-15

### Core engine

- Scaffold TypeScript project with verified integration notes.
- Event log (SQLite + JSONL), agent registry, baton, projections, suggestions, and notify subsystem.
- Shared claude-cli helper and LLM-synthesized projections (opt-in, template fallback).
- Echo, claude-code, and opencode adapters with antigravity bridge and factory.
- Auto-capture `Decision:` lines into shared memory; handoff events snapshot outgoing tree state.
- Cost telemetry — per-agent ledger rehydrated from the log, route cost attribution, `loom costs`, $ on board/TUI/app.
- Adapter SDK guide, README, MIT license, and architecture design spec.

### Routing

- Multi-hop route engine — role/id pipelines, pause-on-question, auto-resume, abort, timeouts, bridge refresh every hop.
- Dynamic mode — LLM router picks each hop (claude headless, rules fallback), hop budget, reasons in `route_step`; `loom route auto --router --max-hops`.
- Per-step instructions in named routes (`{step, instruction}`); rich pipeline docs and LLM projections.
- `loom route` / `loom routes` CLI — live follow, `--status`, `--abort`, `--detach`, route events in chat and board.
- Route picker sheet on the phone app — auto/named/custom dropdown, start+abort, hop reasons in banner.
- Routing guide covering pipelines, pause/resume, and precedence rules.

### Surfaces (TUI / CLI / phone app)

- Full-screen TUI as the default command — tab-based agent switching, slash commands, live stream, route progress, in-TUI QR pairing.
- Ctrl+P command palette — fuzzy filter over shifts/routes/commands, template insertion, arrow+enter.
- Complete CLI command set — `init`, `up`/`down`, chat REPL, handoff confirm, pair QR, board, log follow.
- `loom doctor` — environment, daemon, and project diagnostics with actionable fixes.
- Phone web app served at `/app` — QR deep-link pairing, board, live thread over WebSocket, agent chips with shift-on-send, route banner, interrupt, install-to-home-screen manifest.
- Form-submit composer for mobile keyboards; phone-over-Tailscale walkthrough.

### Security & operations

- Multi-project daemon with REST + WebSocket server, bearer auth, QR pairing tokens, and tailnet binding.
- Paired-device management — `loom clients`, admin-only revoke, immediate 401 for revoked tokens.
- Read-modify-write daemon config on claim/revoke so PID/host/port survive pairing.
- Stale-build auto-restart via health endpoint; `loom up --restart`; pair refuses unreachable localhost QR with exact fix steps.
- Hot-reload edited `.loom/config.json` when project is quiet.
- Auto-clear ghost baton holders after agent removal.
- Sanitize inherited Claude-session env vars (`CLAUDECODE`, `CLAUDE_CODE_*`, `ANTHROPIC_BASE_URL`) when spawning agent CLIs.

### Testing & CI

- Unit + end-to-end suite (76 tests) covering eventlog, baton, projection, suggestions, auth, costs, and daemon e2e.
- Routing e2e tests — completion, role/named resolution, pause-on-question + auto-resume, abort, manual-handoff cancel, 409 double-start.
- GitHub Actions CI (Node 22 and 24, build + test).
- OpenCode adapter hardening from dogfooding Loom on itself — poll-based turn completion, error surfacing, model validation, orphan serve reaping.
