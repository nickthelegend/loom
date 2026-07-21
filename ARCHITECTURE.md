# Loom — Architecture & v1 Design

> **The name stuck: Loom.** A loom weaves many threads into one fabric — the agents are
> threads, shared memory is the weave, the tailnet is a literal mesh. It ships on npm as
> [`@loompad/cli`](https://www.npmjs.com/package/@loompad/cli) (`loom` was taken).

> **Status — read this as the design record, not the current map.** It's the reasoning the
> project was built from, and the *decisions* below all held. Some of the plan didn't
> survive contact: the surfaces grew from two to four (a web app and an Electron shell
> arrived alongside the CLI and phone), the phone app is Android-first over Expo rather
> than iOS-first over APNs, and the "pre-build spikes" have all been run — see
> [docs/integration-notes.md](docs/integration-notes.md) for what the agents actually do.
> Corrections are marked **[shipped]** inline. For what exists today, start at the
> [README](README.md).

## What it is

Loom is a **local-first control plane for coding agents**. One daemon runs on your
machine. It boots agent backends as background servers, exposes them behind a single
chat surface, and gives them a **shared brain** so context flows between them. You reach
it from your laptop CLI or your phone over a private Tailscale mesh, QR-paired.

Two headline workflows:
- **Handoff** — finish with Claude, slide the same context into another agent.
- **Routing** — Claude plans, another agent executes, Claude reviews.

The hard problem Loom solves: these agents have *incompatible* memory, control
interfaces, and session models, and Loom makes them behave like one organism.

## Glossary

| Term | Meaning |
|---|---|
| **Daemon** | Long-lived local process. Manages all projects, adapters, the log, networking. |
| **Project** | A working directory + `.loom/` config + its own event log, baton, and agent fleet. |
| **Event log** | Per-project append-only source of truth (messages, tool calls, edits, decisions). |
| **Adapter** | Full-duplex integration with a controllable agent (OpenCode, Claude Code). |
| **Bridge** | Read-mostly integration with a GUI agent (Antigravity). Never holds the baton. |
| **Baton** | The write lock. Exactly one agent per project holds it and may edit the tree. |
| **Projection** | Rendering the log into a target agent's native memory format on handoff. |
| **Role** | An agent instance's declared function: planner / executor / reviewer / general. |
| **Surface** | Where you interact. **[shipped]** four of them: TUI/CLI, web app, Electron desktop shell, phone app — every one a paired client of the same daemon. |

## Decisions (locked)

| Branch | Decision | Why |
|---|---|---|
| Topology | Local-first, per-user daemon; tailnet + QR pairing token | Smallest trust surface; matches BYO-agents ethos |
| v1 wedge | Unified thread + **manual** routing | Prove "one place for all agents" before auto-orchestration |
| Integration | Full-duplex **Adapters** + read-only **Bridges** | Keeps the core contract pure without abandoning GUI agents |
| Memory | Append-only event log = source of truth; **namespaced** projections | One schema to reconcile through; never clobber user config |
| Surface | One shared thread; agents take turns; baton = write lock | Directly models the handoff story |
| Capture | **Eager** live streaming into the log | Enables phone mirroring + mid-flight handoff |
| Files | One shared working tree; active agent holds write lock; interruptible | Simplest correct model for sequential routing |
| Roles | Declared roles + **suggested** (confirmed) handoffs | Scaffolds plan→execute→review; rails toward auto-routing |
| Concurrency | Many concurrent projects, **per-project** baton | Async agents across projects is half the value |
| Async | **Core**: fire-and-notify | The "check from my phone" magic; justifies native push |
| Product | OSS core + public adapter/bridge SDK | Community writes adapters (like MCP servers proliferated) |
| Runtime | TypeScript / Node (daemon, CLI, web); React Native (phone app) | One language end-to-end, biggest contributor pool |

**[shipped]** The phone app is **Android-first on Expo**, not iOS-first: push goes through
Expo's service, so Loom manages no APNs/FCM credentials — the same "no accounts, no keys"
bet the rest of the project makes. The v1 wedge row also under-sold itself: manual routing
shipped *and* so did LLM auto-routing (`src/core/router.ts`).

## Architecture

**[shipped]** — four surfaces, not two; every one a paired client of the same daemon:

```
        phone app ── tailnet ──┐
        web app  ──────────────┤        browser, or the Electron shell around it
        laptop CLI/TUI ────────┤
                               ▼
                        loom daemon
                         │
         ┌───────────────┼────────────────┐
     project A        project B         project C
     ┌────────┐       ┌────────┐        ┌────────┐
     │ log(SoT)│      │ log     │       │ log    │   ← eager stream capture
     └───┬────┘       └────────┘        └────────┘
     projections (on handoff)
   ┌─────┴──────┬─────────────┐
[adapter]   [adapter]      [bridge]
OpenCode    Claude Code    Antigravity
serve/HTTP  headless/SDK   debug port (read-mostly)
     └── all edit ONE working tree; baton = write lock ──┘
```

## Data model — the event log

Per-project, append-only, ordered. Suggested store: **SQLite** (one file per project under
`.loom/`), events as rows + JSON payloads. Event kinds (initial set):

- `message` — human or agent turn (role, author agent id, text, ts)
- `tool_call` / `tool_result` — what an agent did
- `file_edit` — path, diff/hash (stream messages live; snapshot large diffs)
- `decision` — a distilled fact worth projecting (drives memory)
- `handoff` — baton moved from X to Y, with the briefing that was injected
- `role_change`, `agent_join`, `agent_leave`

The log is the **only** source of truth. Everything an agent "knows" that Loom manages is
a *projection* of this log — never the other way around.

## Adapter contract (full-duplex — mandatory for Adapters)

An Adapter MUST implement all of:

1. `send(message)` — deliver a user/handoff turn to the agent
2. `stream()` — live event stream (messages, tool calls, edits) → written to the log
3. `injectMemory(projection)` — write Loom's namespaced memory block into the agent's
   native store **without touching user-authored files**
4. `acquireLock()` / `releaseLock()` — baton / write-lock coordination
5. `diff()` — current working-tree changes attributable to this agent
6. `interrupt()` — stop/pause the active agent

v1 Adapters: **OpenCode** (`serve` HTTP + event API), **Claude Code** (headless / SDK,
streaming JSON, memory files).

## Bridge contract (read-mostly — for GUI agents)

A Bridge implements only a subset and is **explicitly second-class**:

- `stream()` (best-effort capture) and `injectMemory()` / briefing receipt.
- **Never** acquires the baton; **never** edits the shared tree under Loom's lock.
- Antigravity (VS Code/Windsurf-class fork) attaches here via its debug port until/unless
  it exposes a real API — then it can graduate to an Adapter.

## Handoff & projection

1. You (or a suggested-handoff prompt) pass the baton from X to Y.
2. Loom distills the log into Y's **namespaced** memory format (a Loom-managed block —
   e.g. an imported memory file), so it **persists** for Y's later autonomous use.
3. Loom also prepends a short "you're picking up ___, current state is ___" briefing for
   Y's immediate turn (cheap, focused).
4. Your own `CLAUDE.md` / `AGENTS.md` are never edited.

## Networking & security

- Daemon binds **only** to the Tailscale interface. Tailscale provides device auth + E2E
  encryption — that is the trust boundary.
- **QR pairing**: encodes a short-lived, one-time pairing **token** bound to the node's
  identity — not raw secrets, never in a URL query string. Enrolls the phone as a known
  client.
- No hosted backend in v1. (Optional relay is a *later, opt-in* product decision, not core.)

## Concurrency & async

- Daemon runs **many projects at once**; each has an independent baton and log.
- Agents are **long-running/background**. When one **needs input** or **finishes**, Loom
  notifies you: a local CLI/desktop notification, and **push to the phone** — **[shipped]**
  through Expo's push service (`src/daemon/push.ts`), not APNs.
- The primary surface is a **board of projects**, each opening into a shared thread.

## Surfaces

**[shipped]** All four exist; none is "later".

- **TUI / CLI.** Full experience: create projects, add agents, chat, pass the baton, watch
  streams, get notified.
- **Web app.** Served by the daemon itself at `/app` (`src/daemon/app-page.ts`) — no build
  step, no CDN. On a wide screen it's the full workspace (thread, tasks, explorer, diffs,
  a real pty terminal); on a phone-sized screen it's the board.
- **Desktop shell.** A thin first-party Electron window around that same `/app`
  ([`desktop/`](desktop/README.md)) — not an IDE, no editor.
- **Phone app (React Native / Expo).** Thin client over the tailnet to the daemon's
  WebSocket API. Push for "needs input" / "done". Android-first; iOS needs only a build.

## Open risks / pre-build spikes

**[shipped]** These were assumptions to verify before building — all have since been run
against real, pinned versions; the findings live in
[docs/integration-notes.md](docs/integration-notes.md). Kept here as the record of what
was uncertain at the start:

1. **OpenCode `serve`** — confirm it exposes a live event/SSE stream and per-session
   control sufficient for eager capture + interrupt.
2. **Claude Code headless** — confirm streaming-JSON event shape, memory-file locations,
   and clean interrupt/cancel.
3. **Antigravity debug port** — determine what the port actually exposes (CDP? extension
   host?) and whether even read-only capture is stable. Highest-uncertainty item.
4. **Baton correctness** — the write-lock must be airtight; a leaked lock strands a project.
5. **Suggested-handoff detection** — start with a simple heuristic (agent signals "plan
   complete"); a model-based classifier is a later refinement.

## v1 build sequence (proposed)

**[shipped]** Every step below is built, in roughly this order — with step 10 landing as
an Expo/Android app rather than iOS/APNs, and a web app plus desktop shell arriving that
this list never anticipated. See the [CHANGELOG](CHANGELOG.md) for what actually happened.

1. Daemon skeleton + project model + SQLite event log.
2. First Adapter (Claude Code headless) — send, stream→log, injectMemory, lock, interrupt.
3. CLI: create project, chat one agent, watch stream.
4. Second Adapter (OpenCode serve). Now two agents exist.
5. Baton + handoff + namespaced projection → the core "shift from A to B" demo.
6. Roles + suggested handoffs.
7. Multi-project concurrency + background/notify (CLI notifications).
8. Tailnet binding + QR pairing token.
9. Antigravity **Bridge** (read-only) — the first GUI participant.
10. iOS app (v1.5) hitting the same daemon API + APNs push.
11. Publish the adapter/bridge SDK + docs (OSS).

## Naming

Working name **Loom**. Decide once we see which of {routing, memory, surface} feels like
the soul in practice — Baton if handoff dominates, Choir if it's the shared-context feel,
Switchboard if it stays a router. Loom is the safe, brandable default.

**[shipped]** Loom it is — the shared-context feel won, which is why the tagline settled on
*the shared-memory layer*. The npm package is `@loompad/cli`; the command stayed `loom`.
