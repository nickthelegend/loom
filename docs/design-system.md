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

- **Left sidebar (264px)** — New task / New project + Search, then project
  groups with nested **chat** rows (a project holds many conversations; they
  share one brain, one baton, one working tree). Hover a chat for its ×,
  double-click to rename; `+ New chat` at the end. Agents are NOT here — they
  work the whole project, so they live in the rail's roster.
- **Tab strip (40px)** — *is* the window chrome: project context, then
  Thread | Board | Brain, then the terminal / right-panel / theme toggles.
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
  - *Agents* — New task + the roster: status dot (amber pulse = working),
    `baton` badge, brand mark, and a role you can click and retype (roles are
    free text — planner/executor/reviewer are suggestions, not a menu).
    Bridges appear here too, badged and unclickable.
- **Terminal dock** — a bottom, resizable strip of real shells (`loomTerm`,
  Ctrl+backtick). See *Terminal* below.
- **Tasks pane** — the project's GitHub issues/PRs, read through the user's own
  `gh` CLI (never a token of ours). Provider mark, `Issues`/`PRs` segmented
  control, repo pill, `Open` / `Assigned to me` chips, a mono query box taking
  GitHub's search syntax verbatim, and a fixed-column table — id pill, title +
  author + labels *in the colours GitHub reports*, assignee stack, status
  badge, relative time, and a `Start →` that drafts a task from the issue.
  Colour rule holds: the only colour is state (open/closed/merged/draft) and
  GitHub's own label hues, which are data, not chrome. Every unavailable
  reason (`no-cli` / `no-auth` / `no-remote`) gets a written panel — an empty
  table would claim "no issues", which is a different fact.
- **Board pane** — Orca's board, on Loom's data. Four columns (working / needs
  you / in review / ready to merge), each a card list; a card is a status dot +
  label, the agent (with its brand mark), title, branch, and PR link or "no PR
  yet". Colour is state only: amber working/blocked, red CI, grey review, green
  ready. **Cards are derived, never stored** — dragging one pins it in a column
  (`loomBoardPins:<pid>`) and nothing more, so the badge always reports what
  GitHub and the daemon say. Dropping a card in its computed column clears the
  pin. Replaced the Routes tab; routes live on in the New Task modal (named
  pipelines, or several agents = custom steps) and the Source Control rail
  (live state + abort).
- **Brand marks** — ADE logos from @lobehub/icons (MIT), frozen into an SVG
  sprite by `scripts/gen-brand-icons.mjs` and instantiated with
  `<use href="#brand-<kind>">`. They are the one exception to the monochrome
  rule: a logo is the agent's identity, not our state palette, so it keeps its
  own colours. Keyed by adapter **kind**; an unknown kind keeps the hue
  monogram rather than wearing another vendor's mark. A sprite, not inline
  copies, because Antigravity and Codex carry internal ids.
- **New Task modal** — Orca's Create Worktree, mapped to Loom: project + task
  + **one agent, or several** (several = a pipeline through them, in the order
  you picked). Scrim + glass panel; `n` opens, Cmd/Ctrl+Enter submits, Esc
  closes.
- **New Project modal** — same chrome; `p` opens. Folder + optional name, and
  a native picker (`window.loomNative.pickFolder`, exposed by the Electron
  preload) when the shell can offer one — a browser types the path, since the
  daemon may be on another host.
- **Status bar (25px)** — websocket liveness, daemon host, baton holder,
  spend meter (project share of total), working-agent count, project count,
  total spend.

### Terminal

Each tab owns a long-lived shell in the project directory. There are two
backends behind one interface (`src/daemon/terminals.ts`); the daemon reports
which is live via `/api/health` and the WebSocket hello.

**`pty` — the real thing** (when `node-pty` is available). The shell is on a
tty, so it draws its own prompt, echoes, and has job control: `^C`/`^Z`,
`less`, `vim`, `htop`, and a real window size all work. The front end is
xterm.js, served from `node_modules` at `/app/vendor/*` — no bundler, no CDN.

- Keystrokes go up the WebSocket; a POST per keystroke can't carry a tty.
- FitAddon + a ResizeObserver keep the pty's window matched to the pane.
  Fitting is refused while the pane has no box: measuring a hidden element
  yields a 1×1 grid, and the pty would be sized to match.
- Terminals open only after the socket is listening, or the shell's first
  output (its prompt) is broadcast to nobody.
- The palette is mapped from the design tokens and repaints on theme toggle.
- Cmd/Ctrl+C copies with a selection, interrupts without; Cmd/Ctrl+V pastes.

**`pipe` — the fallback** (no node-pty). `node-pty` is a native module, so it
is an *optionalDependency* and ships prebuilds only for macOS/Windows; Loom
runs headless on Linux boxes that may have no toolchain, and `npm i -g
threadloom` must never break. A long-lived shell on plain pipes:

- `cd` and exported variables still persist; tabs are isolated.
- No tty, so the daemon reports each command's exit code and cwd out of band:
  the shell prints a sentinel, which the daemon strips from the stream
  (holding back partial matches across chunk boundaries). That's how the
  client draws the prompt and surfaces failures.
- **Ctrl+C** signals the shell's process group. The shell survives because it
  is sent a no-op `INT` trap at open — handled signals reset to default in
  children, so the foreground job still dies. Real `^C → exit 130 → prompt`.
- No echo or job control, so the client drives it a line at a time and renders
  ANSI SGR itself against the theme tokens.

`FORCE_COLOR` and a `cat` pager are set in both, so tools colourise and never
block. `LOOM_NO_PTY=1` forces the fallback — CI runs the suite both ways so it
can't rot.

One packaging wrinkle worth knowing: node-pty's prebuilt `spawn-helper` ships
without the executable bit, and node-pty then fails every spawn with a bare
"posix_spawnp failed". The loader repairs the mode, and proves it can spawn
before trusting it — a load isn't proof.

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
