---
project: loom-yc-launch
product: Loom — the shared-memory layer for AI coding agents
destination: Y Combinator application (product/demo video slot)
length: 30s
format: 1920x1080 landscape
flow: collaborative
storyboard: review-before-build
vo_mode: restructured
style_preset: broadside
music: focused-technical-build
voice: kokoro am_michael (offline; no HeyGen sign-in)
---

# Brief

## What the video has to do

Convince a YC partner, in 30 seconds, that Loom is a real product solving a real,
specific pain that the partner has probably felt themselves.

The partner is skimming dozens of these. The first four seconds decide whether they
watch the rest. Lead with the pain, not the category.

## The one sentence

**Loom is the shared-memory layer for AI coding agents — one thread that every agent
reads and writes, so context survives when you switch tools.**

## The pain (this is the hook)

Every coding agent keeps its own brain in its own files. Claude Code's memory can't be
read by OpenCode. Antigravity doesn't know what you decided with Claude an hour ago.
Switch tools and you re-explain your project from scratch.

## The insight (this is why it's a company, not a feature)

Other multi-agent tools keep agents **apart** — isolated worktrees, run in parallel,
compare and merge. Loom makes the opposite bet: keep the agents' **memory together**,
so work *continues* across them instead of forking.

## The proof (this is what makes it credible, not vapor)

- **Five real agents today** — Claude Code, Codex, OpenCode, Grok Code, Antigravity —
  each verified against a real version.
- **The baton** — exactly one agent works at a time; passing it carries the context
  (memory projected, briefing armed, interrupt-safe).
- **Routes** — `loom route ship "add dark mode"` runs plan → execute → review as one
  command, the brain flowing hop to hop.
- **Observatory** — every turn, handoff and route step exported as OpenTelemetry and
  read back in-app.
- **Shipped** — `npm i -g @loompad/cli`, no account, MIT, runs headless on a server.
- **Every surface, one daemon** — TUI, web, desktop window, and a phone app.

## Constraints

- Real product footage carries the video. The user has already-edited clips of the
  desktop app and phone app; motion graphics are the connective tissue, never the star.
- No feature list. Three claims maximum.
- No jargon a generalist partner would not recognize in one pass.
- Must be legible with the sound off (captions on).

## Assets

Product footage lives in `footage/` (see `footage/README.md` for the slot list).
Static product stills available at `../../docs/img/`.
