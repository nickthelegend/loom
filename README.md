# Loom

**One CLI for all your coding agents.** Loom weaves Claude Code, OpenCode — and bridges
like Antigravity — into a single shared thread per project: one conversation, one shared
memory, one baton.

```
        iOS app  ── tailnet ──┐          (v1.5)
        laptop CLI ───────────┤          (v1 · now)
                              ▼
                        loom daemon
                              │
              ┌───────────────┼───────────────┐
          project A        project B       project C     ← independent batons
              │
      ┌───────┴────────┐
      │ event log (SoT)│   ← every message/tool call/edit, streamed live
      └───────┬────────┘
        projections on handoff
     ┌────────┼─────────────┐
 [adapter]  [adapter]    [bridge]
 Claude     OpenCode     Antigravity
 Code       serve API    debug port (read-only)
     └── one working tree · baton = write lock ──┘
```

## Why

Every coding agent keeps its own brain. Claude Code's memory can't be read by
Antigravity; OpenCode doesn't know what you decided with Claude an hour ago. Switching
tools means re-explaining your project, every time.

Loom fixes the seam:

- **Shared thread** — one conversation; agents take turns.
- **Shared memory** — an append-only event log is the source of truth; on every handoff
  it's *projected* into the next agent's native context (namespaced — your own
  `CLAUDE.md`/`AGENTS.md` are never touched).
- **The baton** — exactly one agent holds the write lock per project. Handoffs are
  explicit, confirmed, and interrupt-safe.
- **Roles** — declare a planner / executor / reviewer; Loom *suggests* handoffs at
  natural boundaries ("plan looks complete — hand to the executor?"). You confirm.
- **Routes** — or let Loom drive the chain: `loom route ship "add dark mode"` runs
  plan → execute → review as one command, pausing (and notifying you) whenever an agent
  has a question, resuming when you answer.
- **Fire-and-notify** — agents run in the background across many projects; Loom notifies
  you when one finishes or needs input.
- **Phone-ready** — bind the daemon to your Tailscale interface, pair a device with a
  single-use QR token, and every surface talks to the same API. (Native iOS app: v1.5.)

## Install

Requires Node ≥ 22.5. From source:

```bash
git clone https://github.com/nickthelegend/loom.git
cd loom
npm install && npm run build && npm link   # → `loom` on your PATH
```

## Quickstart

```bash
cd your-project
loom init          # detects installed agents (claude, opencode), assigns roles
loom chat          # one shared thread with all of them
```

Inside `loom chat`:

```
you> make a plan for the auth refactor
claude-code …streams its plan…
  💡 plan looks complete — hand to the executor?  (/handoff opencode)
you> /handoff opencode
  ⟶ baton: claude-code → opencode        (shared context projected + briefed)
you> continue the work
opencode …executes with full knowledge of the plan…
```

`@agent message` addresses a specific agent (Loom asks before moving the baton — it will
interrupt in-flight work). `/decision <text>` pins a fact into shared memory forever.

## Routing — multi-hop pipelines

Handoffs are unlimited and manual by default. **Routes** automate a chain of them:

```bash
loom route ship "add a dark-mode toggle"          # named pipeline from config
loom route planner,executor "fix the flaky test"  # ad-hoc: roles…
loom route claude-code,opencode,claude-code "…"   # …or agent ids, any length
```

What happens per hop: interrupt-safe **handoff** → shared-memory **projection** →
**briefing** → the step's role instruction. Then:

- step finishes cleanly → Loom advances to the next agent automatically;
- the agent asks a question → the route **pauses** (`waiting_human`), you get a
  notification, `loom route --status` and the board show the question; you answer in
  the shared thread (`loom send "…"`) and the route **resumes by itself**;
- an agent errors or a step times out (45 min default) → the route fails loudly;
- **you always outrank the route**: any manual `handoff`/`interrupt` cancels it, and
  `loom route --abort` stops it and interrupts the in-flight turn.

`--detach` returns immediately (fire-and-notify); following with Ctrl-C also leaves the
route running server-side. One route per project at a time (the baton is one write
lock); run routes across *different* projects in parallel freely.

Define named pipelines in `.loom/config.json` (steps are roles or agent ids):

```json
"routes": { "ship": ["planner", "executor", "reviewer"] }
```

`loom init` seeds a `ship` route automatically when it detects at least two roles.

## Commands

| Command | What it does |
|---|---|
| `loom init` | Make the current directory a Loom project (auto-detects agents) |
| `loom chat` | Interactive shared thread (`/handoff`, `/interrupt`, `/decision`, `@agent`) |
| `loom send <text>` | One-shot message (`-a <agent>` to address someone specific) |
| `loom handoff <agent>` | Pass the baton — interrupts, projects memory, briefs the target |
| `loom route <spec> "<task>"` | Run a pipeline (name, or `a,b,c` ids/roles); `--status` / `--abort` / `--detach` |
| `loom routes` | List named pipelines defined for this project |
| `loom interrupt` | Stop the current holder's turn (cancels an active route) |
| `loom decision <text>` | Record a decision into shared memory |
| `loom log [-f]` | Show (or follow) the project event log |
| `loom agents` / `loom projects` / `loom status` | Who's who, board of projects, daemon health |
| `loom up [--tailnet]` / `loom down` / `loom daemon` | Daemon lifecycle (`--tailnet` binds to your Tailscale IP) |
| `loom pair` | QR with a single-use pairing token for a phone/device |

## Supported agents

| Agent | Tier | Transport | Status |
|---|---|---|---|
| Claude Code | adapter (full-duplex) | headless CLI, `stream-json`, `--resume`, briefing via `--append-system-prompt` | ✅ verified against 2.1.83 |
| OpenCode | adapter (full-duplex) | `opencode serve` HTTP + SSE (`/prompt`, `/interrupt`, `/event`) | ✅ verified against 1.17.20 |
| Echo | adapter (demo/tests) | in-process | ✅ |
| Antigravity | **bridge** (read-mostly) | Chromium debug port — presence + memory projections only | 🔶 experimental |

**Adapters** implement the full contract (send / stream / injectMemory / interrupt /
diff) and may hold the baton. **Bridges** only observe and receive shared-memory
projections — they never hold the write lock. That's a design decision, not a gap: GUI
agents without a stable API can't be trusted with interrupt-safe writes. See
[docs/integration-notes.md](docs/integration-notes.md) for the verified surfaces.

## How it works

- **Event log** (`.loom/log.db`, SQLite via `node:sqlite`, JSONL fallback) — every
  message, tool call, file edit, decision, and handoff, appended in order. The log *is*
  the project's memory; everything else is a view of it.
- **Projection** — on handoff, Loom distills the log into
  `.loom/memory/<agent>.md` (persistent, namespaced) and arms a short one-shot briefing
  injected with the target's next turn (system-prompt append for Claude Code, delimited
  preamble for OpenCode).
- **Baton** — persisted per project (`.loom/state.json`). Messages route to the holder;
  addressing a non-holder returns `409 not_holder` and the surface asks you to confirm a
  handoff. Ghost holders (agent removed from config) self-heal.
- **Daemon** — one process, many projects. REST for commands, WebSocket for the live
  stream. Config edits hot-reload when the project is quiet.

## Security model

- The daemon binds to `127.0.0.1` by default, or your **Tailscale interface** with
  `--tailnet` — never `0.0.0.0`. The tailnet is the trust boundary: device auth and E2E
  encryption come from Tailscale.
- Every request needs a bearer token (`~/.loom/daemon.json`, mode 0600).
- Pairing: `loom pair` mints a **short-lived (10 min), single-use** token, rendered as a
  QR. The device exchanges it for a long-lived client token. Secrets never ride in URLs.
- Paired clients are not admins: they can't mint new pairing tokens.

## Adapter SDK

Add an agent in ~40 lines — implement the contract, register the kind:

```ts
import { AdapterBase, registerAgentKind, type SendInput } from "loom-agents/sdk";

class MyAgentAdapter extends AdapterBase {
  async available() { return true; }
  async start() {}
  async stop() {}
  async send(input: SendInput) {
    this._busy = true;
    try {
      // …drive your agent; stream progress:
      this.emit({ kind: "message", payload: { text: "done!" } });
      this.emit({ kind: "run_complete", payload: {} });
    } finally { this._busy = false; }
  }
  async interrupt() {}
}

registerAgentKind("my-agent", (cfg, dir) => new MyAgentAdapter(cfg.id, "my-agent", dir));
```

Full guide: [docs/adapters.md](docs/adapters.md). Design rationale and every decision
with its why: [ARCHITECTURE.md](ARCHITECTURE.md).

## Configuration

`.loom/config.json` (created by `loom init`, hot-reloaded on edit):

```json
{
  "name": "my-project",
  "agents": [
    { "id": "claude-code", "kind": "claude-code", "role": "planner" },
    { "id": "opencode",    "kind": "opencode",    "role": "executor",
      "options": {} },
    { "id": "antigravity", "kind": "antigravity", "role": "general",
      "options": { "debugPort": 9222 } }
  ],
  "defaultAgent": "claude-code",
  "routes": { "ship": ["planner", "executor", "planner"] }
}
```

Roles: `planner` · `executor` · `reviewer` · `general`. Claude Code options:
`permissionMode` (default `acceptEdits`), `model`. OpenCode options: `baseUrl` to reuse
a running server.

## Development

```bash
npm test          # 37 tests: unit + full HTTP/WS end-to-end
npm run build     # tsc → dist/
npm run dev       # run the CLI from source (tsx)
```

## Roadmap

- **v1.5** — native iOS app (React Native): live thread, push on *needs input / done*,
  QR pairing against the same daemon API.
- Dynamic routing (an LLM picks the next hop from results) on top of the shipped
  pipeline engine.
- LLM-synthesized projections behind the same interface.
- More adapters/bridges via the SDK — contributions welcome.

## License

MIT © Nivesh Gajengi
