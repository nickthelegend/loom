# Loom 2

Loom 2 is the release where Loom stops being a tool you configure and becomes a crew you direct:
fleets of agents on different models, a way in for someone who has never used it, and agents that
can drive Loom themselves.

This page records how the 2.0 feature set was chosen (ideas, judging, cuts) and where each feature
lives in the product.

## How it was chosen

Sources: a fresh gap scan of Agent Orchestrator (Apache-2.0) and T3 Code (MIT) against Loom 1.3
plus the 27 issues shipped since (#356–#382), and the four things asked for directly: anyone can
walk through it, skills, agentic Loom, and orchestration across every model.

Each candidate was scored 1–5 on **first-run impact** (does a new user see it in their first ten
minutes), **wow** (would someone show it to a friend), **orchestration value** (does it help run
many agents on many models), and **fit** (can it ship well, without new runtime dependencies or
accounts). The cut line was 15/20.

| Candidate | Source | First run | Wow | Orchestration | Fit | Total | Verdict |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Zero-setup demo + walkthrough (`loom try`) | AO scratch-project plan | 5 | 5 | 3 | 4 | **17** | ✅ #402 |
| Get started checklist + one-click agent installs | AO, T3 WelcomeWizard | 5 | 3 | 3 | 5 | **16** | ✅ #403 |
| Loom as an MCP server (`loom mcp-server`, `loom connect`) | T3 MCP server | 2 | 5 | 5 | 4 | **16** | ✅ #404 |
| Bundled Loom skills installed into agent CLIs | AO `using-ao` | 3 | 4 | 4 | 5 | **16** | ✅ #405 |
| Model scoreboard + saved fleets | new | 2 | 4 | 5 | 5 | **16** | ✅ #406 |
| Automatic chat titles | T3 | 4 | 2 | 1 | 5 | 12 | ✅ bundled into #407 (cheap, visible everywhere) |
| Open in editor | T3, AO | 3 | 2 | 1 | 5 | 11 | ✅ bundled into #407 |
| `loom triage` | T3 | 2 | 2 | 1 | 5 | 10 | ✅ bundled into #407 |
| More ACP agent presets (Goose, Qwen…) | AO's 27 agents | 2 | 2 | 4 | 2 | 10 | ❌ needs each CLI verified for real first |
| Phone widgets / Live Activities | T3 | 1 | 4 | 2 | 1 | 8 | ❌ native modules, store builds |
| Usage from CLI transcripts (ccusage-style) | T3 | 1 | 2 | 3 | 3 | 9 | ❌ later |
| Global screenshot hotkey | T3 | 1 | 3 | 1 | 2 | 7 | ❌ later |
| Translations | AO | 2 | 1 | 1 | 2 | 6 | ❌ later |
| VS Code theme import, PiP preview, snooze | T3 | 1 | 2 | 1 | 3 | 7 | ❌ polish backlog |

## Where each feature lives

```
┌ Sidebar ─────────────┐┌ Main ───────────────────────────────────────────────────────────┐
│ ✦ Home        ← NEW  ││ Home (#403)                                                      │
│ ☰ New task           ││  ┌ Get started ───────────┐ ┌ Try Loom in two minutes ──────┐   │
│ ⊕ New project        ││  │ ✓ Try the demo          │ │ [spool]  Try a demo project   │   │
│ projects             ││  │ ○ Connect an agent [▶]  │ └───────────────────────────────┘   │
│  ▸ Loom Demo   ×3    ││  │ ○ Run a fleet …         │ ┌ Teach your agents Loom ───────┐   │
│  ▸ your-app          ││  └─────────────────────────┘ │ [book]   Loom for agents      │   │
│ (empty: Try a demo)  ││  Your projects  ▢ ▢ ▢        └───────────────────────────────┘   │
│                      ││  Who's winning · 30 days  [trophy]  claude-opus-5-5 67% …        │
└──────────────────────┘└──────────────────────────────────────────────────────────────────┘

Project ▸ composer ▸ Orchestrate (Developer mode)
  Lead · Team [chips] [+fleet] [+model] [★ scoreboard]      ← scoreboard + saved fleets (#406)
  +fleet menu: agent · model · how many · Save fleet… · saved fleets (@squad)

Settings
  Setup ............ Install buttons for missing CLIs (#403); "Try Loom first" when nothing's installed (#402)
  Loom for agents .. skills per agent folder, Install/Update/Remove (#405); `loom connect` per CLI (#404)
  Preferences ▸ Tools ▸ Loom tools for agents (per project) (#404)

Explorer ▸ right-click a file ▸ Open in Zed / VS Code / Cursor … (#407)      ⌘K ▸ same, + Model scoreboard
First open of a demo project ▸ the walkthrough: send → watch → steer → Agents → Developer mode (#402)

Phone
  Board ▸ Get started card (try the demo, new project, open one) (#403)
  New project sheet ▸ Try a demo project (#402)
  Orchestra ▸ fleet editor ▸ saved fleets (#406)
```

## The walkthrough

A new user with no agent CLI and no keys:

1. `npm i -g @loompad/cli && loom try`, or the **Try a demo project** button on Home or in Setup.
2. The demo project opens with three demo agents (scripted, offline, $0.00), and the walkthrough starts.
3. **Ask for something.** It sends "Add dark mode". The agent reads, edits `styles.css` for real and runs the tests (simulated, and it says so).
4. **Steer while it works.** It sends a second request, then steers it mid-turn with "Also cover an empty list". The note lands in the running turn.
5. **Your agents.** It opens the Agents tab.
6. **Bring your own agents.** Setup installs Claude Code, Codex or OpenCode in one click. Developer mode brings back Orchestra, races and the terminal.

The DOM test `the demo walkthrough (#402)` walks exactly this path against a real daemon on every CI run.
