# Changelog

All notable changes to Loom are documented here.

The format loosely follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Tasks — start work from a real GitHub issue

- New **Tasks** tab per project: the repo's open issues and pull requests in a
  sortable table (id, title, author, labels, assignees, status, updated), with
  an `Issues`/`PRs` switch, `Open` / `Assigned to me` filters, a query box that
  accepts GitHub's own search syntax (`assignee:@me is:issue is:open`), and
  pagination. Labels wear the colours GitHub reports for them.
- **Start** on any row opens Create task with the issue number, title, and URL
  already drafted, so a GitHub issue becomes an agent task in two clicks.
- Data comes from **your own `gh` CLI**, which already holds your auth — Loom
  needs no token, no OAuth app, no PAT of its own. It shells out the same way
  the adapters shell out to the coding agents you have installed.
- When it can't list, it says why (`gh` not installed, signed out, or no GitHub
  remote) instead of showing an empty table that reads as "no issues". The
  fetch is capped at 60, and a capped list says so rather than letting the last
  page imply it's the last issue. GitLab and Linear appear disabled — the row
  shows which providers exist and which one Loom can actually read.

### New project

- A **New project** button in the sidebar (shortcut <kbd>P</kbd>) with a proper
  modal, replacing the inline path field. It reports which ADEs were detected
  on the host after registering, and refuses a bad path out loud.
- In the desktop app the folder comes from a **native macOS picker**; in a
  browser the path is typed, since the daemon may be on another host. The
  preload exposes only that one call — no `require`, no ipc passthrough.

### Fixed

- The right rail showed the project you just navigated away from: it renders
  from `state.project`, which only a fetch filled in, so every switch left it
  one project behind until you touched it.

### Terminal — real PTYs

- Terminals now run on a real pseudo-terminal via **node-pty**, rendered with
  **xterm.js**: the shell is on a tty, so it draws its own prompt, echoes, and
  job control works — `^C`/`^Z`, `less`, `vim`, `htop`, window size. Verified
  end to end in the desktop app: `$(tty)` resolves to a real device, `stty`
  reports the fitted window, and `vi` repaints the alternate screen.
- node-pty is an **optionalDependency** with a probing loader, so a machine
  that can't build it still installs Loom and quietly gets the previous
  pipe-backed shell (`cd`/vars persist, `^C` works). `npm i -g threadloom`
  never breaks. `LOOM_NO_PTY=1` forces the fallback, and CI runs the suite
  both ways so it can't rot.
- Fixes a node-pty packaging bug: its prebuilt `spawn-helper` ships without the
  executable bit, so every spawn died with a bare "posix_spawnp failed". The
  loader repairs it, and proves it can spawn rather than trusting the require.
- Terminal input now travels over the project WebSocket (a tty needs a
  round-trip per keystroke); sessions keep scrollback and replay it, so a
  reload rejoins the session it left. Adds `/term/resize`, tab titles from OSC,
  clipboard keys, and reports the active mode from `/api/health`.
- Terminal logic moved out of `server.ts` into `src/daemon/terminals.ts`.

### Security

- **A symlink inside a project could read files anywhere on disk.** The
  Explorer endpoints resolved paths with `path.resolve`, which resolves
  straight *through* symlinks, so the sandbox only stopped lexical `../`
  traversal. Containment is now verified twice — lexically and again against
  `fs.realpathSync`. Found by the new workspace tests.

### Testing

- `test/workspace.test.ts` (28 tests) covers the surfaces the desktop UI is
  built on and previously had none: Explorer listing/reading/find, the sandbox
  (traversal, absolute paths, symlink escape, unauthenticated access), and the
  terminal end-to-end (streams output, exit codes, no sentinel leakage, `cd`
  and variables persisting, terminal isolation, and Ctrl+C giving exit 130
  while the shell survives). Suite: 96 → 124.

### Accessibility

- Every icon-only control now carries an `aria-label`, mirrored from its
  tooltip by an observer so string-rendered UI can't miss one. Verified: 17
  icon-only controls on desktop, 6 on mobile, none unnamed.

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
- Right rail is a 4-view panel (Explorer / Search / Source Control / Tasks)
  with a top icon switcher, open by default on the Explorer. Explorer is a
  lazy project file tree (folders expand on click; files open in the dock —
  changed files as a diff, others as a read-only preview). Search finds files
  by name; Source Control lists the branch + changed files; Tasks holds a
  per-project New-task button and the agent roster. Backed by new sandboxed
  daemon endpoints: `GET /files`, `/file` (400KB cap), `/find` (200 results).
- The Changes/diff view is no longer an always-on split — it's a dock to the
  right of the chat that opens only when you click a change (an `Update(…)`
  card in the thread, or a file in Explorer / Search / Source Control) and
  closes with an X. The rail itself collapses from the tab strip (PanelRight).
- Real terminals: each tab owns a long-lived shell in the project directory
  (`POST /term/open|input|signal|close`, streamed over the project
  WebSocket), so `cd` and exported vars persist between commands. A sentinel
  printed after each command carries the exit code and cwd — the daemon
  strips it from the stream, so the prompt tracks the live directory and
  non-zero exits surface. Ctrl+C signals the shell's process group and the
  shell survives via a no-op INT trap, giving real `^C → exit 130 → prompt`
  behaviour. Includes ANSI colour rendering, ArrowUp/Down history, Ctrl+L,
  click-to-focus, multiple tabs, drag-resize, and a Ctrl+backtick toggle.
- Every column is drag-resizable with persisted widths and double-click to
  reset — sidebar, diff dock, and right rail, each clamped so the chat can't
  be squeezed out.
- New Task flow (Orca's Create Worktree): a sidebar action, the Tasks rail
  view, and the `n` shortcut open a modal to pick a project, a task, and
  **one ADE or several** — one agent messages it directly; several run it as
  a pipeline hop to hop (e.g. claude → codex).
- Phone home rebuilt to the Orca mobile layout: Welcome-back hero, stat
  tiles (Projects / Agents / Spend), a Daemon card, a Resume card, hue-glyph
  project cards, and quick-action pills.
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
