# Loom design system — "quiet graphite"

Loom's UI adopts the design language of [Orca](https://github.com/stablyai/orca)
(MIT), the AI-orchestrator desktop app: **monochrome and quiet** — neutral
surfaces carry the chrome, and color is reserved for *state*. Loom keeps its two
brand accents inside that rule: **thread** cyan (`#67e8f9`) marks live activity,
**shuttle** magenta (`#e879f9`) marks the baton moving between agents. Everything
else is neutral.

Canonical token sources:

| Surface | Token file |
| --- | --- |
| Web app (daemon-served) + Electron shell | `src/daemon/app-page.ts` (`:root` light / `.dark`) |
| Phone app (Expo RN) | `app/src/theme.ts` |

## Color tokens — web / desktop (from Orca desktop)

Paired *surface + foreground* roles, both themes. Dark is the default; light is
a first-class theme behind the in-app toggle (persisted as `loomTheme`).

| Role | Light | Dark |
| --- | --- | --- |
| `--background` / `--foreground` | `#fff` / `#0a0a0a` | `#0a0a0a` / `#fafafa` |
| `--card` / `--card-foreground` | `#fff` / `#0a0a0a` | `#171717` / `#fafafa` |
| `--popover` | `#fff` | `#171717` |
| `--primary` / `--primary-foreground` | `#171717` / `#fafafa` | `#e5e5e5` / `#171717` |
| `--secondary`, `--muted`, `--accent` | `#f5f5f5` | `#262626` / `#262626` / `#404040` |
| `--muted-foreground` | `#737373` | `#a1a1a1` |
| `--destructive` | `#e40014` | `#ff6568` |
| `--border` | `#e5e5e5` | `rgb(255 255 255 / 0.07)` |
| `--input` | `#e5e5e5` | `rgb(255 255 255 / 0.15)` |
| `--ring` | `#a1a1a1` | `#737373` |
| `--sidebar` / `--sidebar-accent` | `#fafafa` / `#f5f5f5` | `#171717` / `#262626` |
| state: `--thread` / `--shuttle` | `#67e8f9` / `#e879f9` | same |
| state: `--ok` / `--warn` / `--err` | `#15803d` / `#f59e0b` / `#e40014` | `#10b981` / `#eab308` / `#ff6568` |

Rules:

- **Hairlines everywhere.** 1px `--border`; in dark mode borders are 7% white —
  never brighter.
- **Tints via `color-mix`** against an existing token, never a new hex.
- **Three elevation tiers only:** hairline border (default) → border + tiny
  shadow (cards) → floating `0 10px 24px rgba(0,0,0,.18)` + glass (popovers,
  sheets, toasts). Floating surfaces use the Orca glass recipe: translucent
  popover bg + `backdrop-filter: blur()` + inset top highlight.
- Hover/active list rows use `--accent` (`--sidebar-accent` inside the rail);
  the persistent current row also carries `data-current="true"`.

## Typography

- **Sans:** `Geist` (variable woff2, weight 100–900), served by the daemon at
  `/app/fonts/geist.woff2` (embedded in `src/daemon/geist-font.ts`; SIL OFL 1.1).
  Fallback `-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif`.
  Body letter-spacing `0.01em`, antialiased.
- **Mono:** `'SF Mono', SFMono-Regular, ui-monospace, 'Cascadia Code', Menlo,
  Consolas, 'Liberation Mono', monospace` — paths, branch names, meta, anything
  literal.
- **Scale:** 11px uppercase meta (600, tracking .05em) · 12px secondary ·
  13px list rows · 14px body · 15px+ titles only.

## Radius, controls

- Base radius `10px`; `sm 6 / md 8 / lg 10 / xl 14`. Buttons + inputs `8px`;
  cards `14px`; badges/chips full.
- Buttons: default h-36px, sm h-32, xs h-24; variants `primary` (near-white on
  dark / near-black on light), `secondary`, `outline`, `ghost`, `destructive`.
- Focus: `border-color: var(--ring)` + 3px ring at 50% — on every interactive.
- Inputs h-36px, transparent bg (dark: 15%-white wash), placeholder at 60%
  muted-foreground.
- Icons: inline SVG, 16px, stroke 2, `currentColor`. Never emoji.

## Workspace shell (desktop web + Electron, ≥900px)

The Orca workspace layout, drawn from Loom's real model. Every column is
drag-resizable and persisted; double-click a handle to reset
(`loomSbW` / `loomRailW` / `loomDockW` / `loomTermH`).

- **Left sidebar (264px)** — New task + Search, then project groups with
  nested agent rows: status dot (amber pulse = working), `baton` badge on the
  holder, role labels. Clicking an agent targets it for the next send.
- **Tab strip (40px)** — *is* the window chrome: project context, then
  Thread | Brain | Routes, then the terminal / right-panel / theme toggles.
  The active tab merges into the canvas; the composer docks under Thread only.
- **Diff dock (right of the chat, closed by default)** — opens only when you
  click a change: an `Update(n files)` card in the thread, or a file in
  Explorer / Search / Source Control. Per-file diff cards on
  `--editor-surface` with add/delete washes, hunk headers and old/new line
  gutters; Loom's `.loom/` state files filtered. Closes with an X.
- **Right rail (304px, `loomRail`, open by default on Explorer)** — four
  views behind an icon switcher (`loomRailView`):
  - *Explorer* — lazy project file tree; a file opens its diff if changed,
    else a read-only preview.
  - *Search* — filename find across the project.
  - *Source Control* — branch, changed files with colored status letters,
    live route and needs-input cards.
  - *Tasks* — per-project New task + the agent roster.
- **Terminal dock** — a bottom, resizable strip of real shells (`loomTerm`,
  Ctrl+backtick). See *Terminal* below.
- **New Task modal** — Orca's Create Worktree, mapped to Loom: project + task
  + **one agent, or several** (several = a pipeline through them, in the order
  you picked). Scrim + glass panel; `n` opens, Cmd/Ctrl+Enter submits, Esc
  closes.
- **Status bar (25px)** — websocket liveness, daemon host, baton holder,
  spend meter (project share of total), working-agent count, project count,
  total spend.

### Terminal

Each tab owns a long-lived shell in the project directory, so it behaves like
a terminal rather than a command runner:

- `cd` and exported variables **persist** between commands; tabs are isolated.
- After each command the shell prints a sentinel carrying the exit code and
  cwd. The daemon strips it from the stream (holding back partial matches
  across chunk boundaries) and emits an exit/cwd frame — that's how the prompt
  tracks the live directory and how failures surface.
- **Ctrl+C** signals the shell's process group. The shell survives because it
  is sent a no-op `INT` trap at open — handled signals reset to default in
  children, so the foreground job still dies. Real `^C → exit 130 → prompt`.
- ANSI SGR renders against the theme tokens; other escapes are stripped.
  `FORCE_COLOR` and a `cat` pager are set so tools still colourise and never
  block without a tty.
- It is **not a PTY** (that needs a native dep, which would break
  `npm i -g threadloom`), so there's no echo or job control.

### The file sandbox

Explorer endpoints (`/files`, `/file`, `/find`) hand file contents to any
paired client, so containment is checked twice: lexically (stops `../`, and
covers paths that don't exist yet) and again via `realpath` (stops a symlink
*inside* the project pointing out of it — `path.resolve` resolves straight
through links). Both are covered by `test/workspace.test.ts`.

Mobile home mirrors the Orca companion: a Welcome-back hero, three stat
tiles (Projects / Agents / Spend), a Daemon card (host + counts), a Resume
card for the active project, hue-glyph project cards, and quick-action
pills.

Mobile (<900px) keeps the single-column thread: chips row, glass sheets, and
the docked composer.

## Window chrome (Electron)

Matches Orca: `titleBarStyle: hiddenInset` (macOS) with traffic lights at
`{x:16, y:12}`, min 600×400, canvas-colored background (`#0a0a0a`). The web app
draws 36px draggable title strips (`-webkit-app-region: drag`) keyed off the
`data-electron` attribute set by the preload; macOS reserves an 80px
traffic-light gutter. Sidebar strip wears `--sidebar` with an inset 1px seam.

## Phone app (from Orca mobile — graphite, dark-only)

`app/src/theme.ts`:

- Surfaces: `bgBase #111111`, `bgPanel #1a1a1a`, `bgRaised #242424`,
  border `#2a2a2a`, editor `#1e1e1e`.
- Text: `#e0e0e0` / `#888888` / `#555555`; primary CTA is **near-white**
  (`#f5f5f5`) with dark text — the single loudest thing on any screen.
- State: green `#22c55e`, amber `#f59e0b`, red `#ef4444`, thread `#67e8f9`,
  shuttle `#e879f9`; `accentBlue #3b82f6` for links/selection only.
- Spacing `4/8/12/16/24`; radii: rows+buttons+inputs `6`, cards `14`.
- Active/selected states are **neutral grey** (raised bg or 2px grey left
  border), not colored.
- Composer is a command dock: `bgPanel` bar, raised 6px-radius input, circular
  34px send button with an ↑ glyph.
- Diffs: added `rgba(129,184,139,.1)` / deleted `rgba(199,78,57,.11)` washes
  with green/red gutters, mono 11–12px.

## The weave, kept

Loom's identity survives as state, per Orca's own rule:

- **Selvage edges** — agent messages carry a 2px left border in a per-agent hue
  (`hsl(hash(agent), 50%, 52%)`).
- **Shuttle handoff** — `a ⟿ b` rows in shuttle magenta.
- **Woven loader** — staggered warp bars shimmering in thread cyan.
- **Warp ground** — a near-invisible vertical-thread texture on the dark canvas.
- Live/needs-input dots pulse in thread/amber.

## Credits

Design system adapted from [Orca](https://github.com/stablyai/orca) (MIT,
© Lovecast Inc.). Geist typeface © Vercel, SIL OFL 1.1.
