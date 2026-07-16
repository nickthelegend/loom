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

The Orca workspace layout, drawn from Loom's real model:

- **Left sidebar (264px)** — project groups with nested agent rows: status dot
  (amber pulse = working), `baton` badge on the holder, role labels. Clicking
  an agent targets it for the next send.
- **Tab strip (37px)** — Thread | Changes (badge = changed-file count) |
  Brain | Routes; the active tab merges into the canvas. The composer docks
  under Thread only.
- **Changes pane** — per-file diff cards on `--editor-surface` with
  add/delete washes and hunk headers; Loom's `.loom/` state files filtered.
- **Right rail (304px)** — Source control: branch, changed files with
  colored status letters (click jumps to the file's diff), live route and
  needs-input cards. **Collapsed by default** — toggled from the tab strip
  (PanelRight) or its close button, state persisted (`loomRail`).
- **Terminal dock** — a bottom, resizable command runner: multiple tabs,
  a prompt showing the project dir, streamed stdout/stderr with exit codes,
  a `clear` builtin, Ctrl+backtick toggle. Each line is a fresh shell in the
  project directory (`POST /api/projects/:id/exec` → WS `term` frames).
- **New Task modal** — Orca's Create Worktree, mapped to Loom: project +
  agent + task (or pipeline) → hands the baton and starts the work. Scrim +
  glass panel; `n` opens, Cmd/Ctrl+Enter submits, Esc closes.
- **Status bar (25px)** — websocket liveness, daemon host, baton holder,
  spend meter (project share of total), working-agent count, project count,
  total spend.

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
