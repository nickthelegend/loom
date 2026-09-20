# Changelog

All notable changes to Loom are documented here.

The format loosely follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### The queue can wait, and can be kept

- **Queue for later**: a prompt can be held for a time, until a goal actually
  **lands**, until that goal's **checks go green**, or until the project has
  been quiet for a while. The row says what it's waiting for and a click
  releases it. (`loom queue at 03:00 …`, `loom queue after green:<runId> …`)
- **Recipes**: save what's queued and run it on any project. Steps remember
  their target by **role**, so a recipe travels; anything the project can't
  resolve becomes an Auto prompt rather than a refusal. (`loom queue save`,
  `loom queue run`, `loom queue recipes`)
- **Drag to reorder** in the web app; the arrows stay for anyone who can't
  drag, and the phone gained up/down controls it never had.

## [0.2.3] — 2026-09-20

### The Browser tab knows your dev servers

- **Loom can run them.** Declared under `servers` in `.loom/config.json` and
  suggested from `package.json` (a suggestion you accept, never something that
  starts itself). Start, stop and restart from the Browser tab or the CLI.
- **The state is a fact, not a guess**: *running* means a port answered,
  *starting* means the process is up and nothing is listening yet, and
  *crashed* carries the exit code.
- **Its output is there too**, under the page it serves — which is where the
  reason for a blank frame usually is — and a server that dies while an agent
  is working against it says so in the thread.
- Clicking a server points the preview at it; no more typing ports from memory.
- Every server Loom started is stopped when the daemon goes, so nothing is left
  holding a port.
- `loom servers`, `loom servers start|stop|restart <name>`, `loom servers logs
  <name>`.
- **The preview emulates a width** — Fit / 375 / 768 / 1280, remembered per
  project and scaled down when the dock is narrower than the page.
- **It reloads when an agent changes files** (a toggle, on by default), so
  watching a change land doesn't involve remembering to refresh.
- **The previewed page reports back.** Loom previews a server through its own
  proxy — forwarding everything, including the hot-reload socket — and injects
  one script. The **Page** pane shows the page's console and its requests,
  live, and a click puts a line into the composer as context.
- **An element picker.** Click the thing that's wrong in the preview and its
  selector, text, box and markup land in the composer.
- **A camera button puts the view into the composer.** The page is another
  origin and can't photograph itself, so the daemon takes the shot with the
  project's own Playwright; a project without it is told exactly that.

### An Update button that actually updates

- **Loom says when a newer version is out** — checked against the published
  release, cached for hours, shown as a pill in the status bar.
- **One button in Settings → Updates**, which says exactly what it will run
  before it runs it: a git checkout pulls and rebuilds, a global npm install
  reinstalls itself, and anything else is pointed at the release rather than
  having a command guessed at and run over it.
- **A checkout with uncommitted changes is refused** (modified tracked files —
  an untracked scratch file doesn't stop a fast-forward).
- The commands' output streams while they run, then the daemon restarts on the
  new build and the page reconnects to it.
- `loom update [--check] [--yes]` does the same from the terminal.

## [0.2.1] — 2026-09-20

### The prompt queue

- **What you type while something is running now waits where you can see it.** A
  prompt sent to a busy agent used to be queued invisibly — logged into the
  thread as if it had been sent, with nothing to look at and nothing to change —
  and a goal typed while another goal ran was refused outright.
- **The queue is a surface**, above the composer on the web, the desktop app and
  the phone, and `loom queue` in the terminal: every waiting prompt with who
  takes it, editable in place, movable, removable, pausable.
- **Each prompt names its own target:** one agent, the **orchestrator** (a whole
  new goal, started when the running one finishes), or the auto router — and you
  can change it while the prompt waits. The baton moves with it.
- **A question holds the queue:** an agent that stops to ask you something isn't
  answered by whatever you queued behind it. The queue waits and names who
  asked; your typed reply goes straight out and lifts the hold, so what was
  waiting runs next. A pause you set yourself stays until you resume it.
- **Stop pauses the queue** instead of emptying it, and a prompt that can't be
  sent (budget, quarantine, a policy, a missing agent) stays put with the reason
  on the queue rather than disappearing.
- **A prompt enters the conversation when it is sent**, not when it is queued, so
  the thread stays an honest record of what each agent was actually asked.
- Survives a daemon restart, reloaded **paused** (`.loom/queue.json`). API:
  `GET/POST /api/projects/:id/queue`, `PATCH|DELETE .../queue/:itemId`,
  `POST .../queue/pause`, `DELETE .../queue`, plus a live `queue` socket frame.

### Fixed

- **An override of `loom/review` made while that review is still running** is no
  longer overwritten when the review finishes (D61) — found on a real PR, where
  a late review wrote `failure` over the owner's decision.
- **A turn is no longer blamed for Loom's own `.loom/` files.** In a project that
  doesn't gitignore `.loom/`, the event log and the queue file were landing in
  the agent's turn diff.
- **grok-code and agy** are detected from their own auth files instead of being
  reported signed-out, and the status bar says **live**, not offline, before a
  project is open.
- **A reply that lands after its window closed** no longer throws from a redraw.
- **An overridden review leaves its status where the owner put it.** A review
  coming back to a commit that was already overridden kept the decision but
  posted nothing, leaving its own "reviewing…" status pending — on a repo that
  requires `loom/review`, for ever.
- **Retargeting a queued prompt** to an agent the project doesn't have is
  refused when you make the change, not when the queue reaches it.

### Loom Teams, Phase 6: land in turn, hear it now

- **6 more design decisions** (D79–D84), settled with the owner.
- **The landing train:** on a repo with no merge queue, Land queues a goal in its
  lanes and Loom merges it on its turn: fresh main in, the fast tests, a push,
  green checks on that commit, then `gh pr merge --squash`. The slot is a team-hub
  lease on `.loom/landing/<lane>` held as a hard zone, so every hub (in-memory,
  `loom hub`, hosted SQL) arbitrates it with no new API. Waiting goals show
  **queued** and go as soon as the lane frees. A red check on its turn hands the
  lane on, and the goal rejoins when it's green. Repos with a merge queue land as
  before.
- **Lanes:** `landing.lanes` in `loom.team.json` are path scopes; goals in
  different lanes land at the same time.
- **GitHub webhooks into the hub, no App needed:** `loom hub` takes
  `POST /github/webhook/:teamId`, checks `X-Hub-Signature-256` against the team's
  secret, and posts PR, check, review and deploy events to the feed.
  `loom team webhook [--install] [--rotate]` sets it up. The hosted hub gets a
  `github-webhook` Edge Function and `supabase/migrations/0009_phase6.sql`
  (deployment pending).
- **Polling and webhooks agree:** one mapping (`src/core/github-events.ts`) gives
  both the same dedupe keys, so a fact is posted once. Failing checks are now one
  feed event per check and commit, and `gh pr list` polling reads `headRefOid`.
- **Faster fixes:** a check result or merge for one of your goal PRs makes your
  daemon look at it immediately, not at the next 30-second poll.
- **UI:** a `queued` landing chip (desktop and phone), and feed lines for the
  train and for reviews that arrive by webhook.

## [0.2.0] — 2026-09-19

Loom Teams: five phases, 78 design decisions, several people and their agents on
one repo. The sections below go phase by phase, newest first.

### Loom Teams: loose ends closed

- **Paste-the-URL sign-in** for the hosted hub on machines without a browser
  (`loom team signin --paste`; `loom runner join` uses it by default).
- **Stacks fold when a lower PR keeps failing:** its lower PRs close and the top
  one retargets the base branch, so the normal fix loop can fix it.
- **CI minutes per goal:** Actions time on a goal's branch is recorded when it
  lands and shown in team spend (desktop and phone).
- **Docs:** a Teams user guide ([docs/teams.md](docs/teams.md)), a docs index,
  a source map, and READMEs for `supabase/`, `src/hub/`, `test/`, `scripts/`
  and `hardware/`.

### Loom Teams, Phase 5: runners

- **12 more design decisions** (D67–D78), settled in a design interview.
- **Runners:** a member's always-on Loom daemon that takes goals from the team
  hub. Pair it with `loom runner pair` / `join` (a device of the same member,
  revocable with key rotation); keep it up with `loom runner install` or
  `Dockerfile.runner`.
- **Jobs on the hub:** start / continue / fix / return / land, with atomic claims,
  heartbeats carrying a progress snapshot, and stale reclaim (MemoryHub, `loom
  hub`, SQL `0007_runners.sql`).
- **Move a running goal** to a runner at a safe point (branches pushed to
  `refs/loom/run/<id>/*`, the orchestrator resumes there) and **bring it back**;
  Land reaches goals that live on a runner.
- **Trust tier:** a fresh clone (or container) per goal, a scrubbed environment,
  `runners.permissions` as the ceiling, shared runners only when
  `runners.shared` allows, a fine-grained token checked by `loom runner doctor`.
- **Away-from-keyboard CI fixes:** the owner's runner takes a goal that needs
  someone once the owner has been offline 15 minutes.
- **Deploys and release notes:** deployment results in the feed, a phone alert
  when a failed deploy contains your goal, `loom team release-notes --since`.
- **Phone:** tapping an alert opens its project and goal.

### Loom Teams, Phase 4: land safely

- **15 more design decisions** (D52–D66), settled in a design interview.
- **Checks come back to the owner:** the owner's daemon polls its goal PRs every
  30s (`gh pr checks --required`). A failing check is rerun once; a pass on rerun
  is labelled `loom:flaky`. A real failure's log tail (fenced as untrusted) reopens
  the goal, and the fix is pushed to the same PR. At most 2 attempts, then the
  goal needs a human and the phone is alerted.
- **Cross-vendor review:** a different-vendor agent reviews each goal PR on open
  and after each fix (max 3), posts a COMMENT review and a `loom/review` status;
  only high findings fail it, and they share the fix budget. Owners can override
  with a reason.
- **Land** (`loom land`, a button on desktop and phone): fresh main merged in,
  `landing.fastTest` from `loom.team.json`, push, `gh pr merge --auto --squash`.
  Conflicts get one agent attempt; hard-zone conflicts go to a human.
- **Stacks** (opt-in, `delivery.stack: "auto"`): big goals become 2–4 PRs cut
  along the integration branch's merge commits, landed bottom-up.
- **Adopt:** a teammate takes a stuck goal whose owner is away, fixes it on the
  owner's branch, and hands it back; the owner's daemon backs off meanwhile.
- **Budgets:** per-goal cap (pauses the goal) and per-member daily cap (no new
  goals); cost rollups per member/day, per goal and per landed PR.
- **Doctor:** `loom team doctor` reports merge-queue traps and opens a PR adding
  `merge_group:` to workflows. It never changes settings.
- **Hosted hub:** `SupabaseHubClient` over RPC and Realtime, GitHub sign-in via
  Supabase (loopback), `loom team signin` defaults to hosted; SQL `0005`
  (`extend_lease`, `team_member_list`) and `0006` (landing feed events).

### Loom Teams, Phase 3: one brain

- **12 more design decisions** (D40–D51), settled in a design interview.
- **Team memories:** durable memories from a shared project are published to the
  hub sealed under the team key, with an HMAC of the normalized text. The hub
  merges exact twins as confirmations without reading them (MemoryHub, `loom hub`
  and SQL `0004_team_memories.sql`, tested on Postgres).
- **Who can change what:** only a memory's author edits or forgets it; a teammate
  records a correction that supersedes it. Resolving keeps the loser, linked to
  the winner, which inherits its confirmations.
- **Tiered briefings:** canon > confirmed by 2+ > your own > a teammate's
  proposal, each line labelled. Failures and facts age out of briefings after ~90
  days unless re-confirmed.
- **Untrusted memories:** a turn that read the web, GitHub issue/PR text or a
  fetched URL marks what it taught as untrusted. Untrusted memories stay personal
  until you trust them.
- **Canon in `AGENTS.md`:** a Loom-managed section with per-line markers; lines
  added by hand count too. Promotion goes through one rolling `loom/canon` PR,
  which also adds `@AGENTS.md` to `CLAUDE.md`. The native-memory import skips the
  section, so canon never loops back in.
- **Live team context** in worker and handoff briefings, up to 1.5k characters:
  - teammates' leases on the same paths;
  - open PRs that change them (PR feed events now carry changed paths);
  - failing checks;
  - predicted conflicts.
- **Inbox:** contradictions, near-duplicates, corrections, untrusted memories and
  promotion candidates. REST `/api/projects/:id/team/brain[/:action]` and
  `loom team brain`.

### Loom Teams, Phase 2: stop colliding

- **12 more design decisions** (D28–D39), settled in a design interview.
- **Leases:**
  - scopes are expanded to real files plus directory prefixes, and hard zones come
    from `loom.team.json`;
  - hub claim, extend, renew, landing and release, with atomic hard-zone
    arbitration, in both MemoryHub and SQL (tested on Postgres).
- **Orchestra holds** stop a task from starting:
  - **decide:** the task overlaps a teammate's lease and needs an `overlap`
    decision;
  - **wait:** it waits for another goal's PR to merge, then rebases onto main;
  - **zone:** it queues behind a held hard zone;
  - **capacity:** the team is at its agent limit;
  - "Stop waiting" releases a wait by hand.
- **Drift:** when a worker edits outside its declared touches, the lease widens and
  the team is told. Drift into someone else's hard zone pauses the worker.
- **WIP refs** (`refs/loom/wip/<member>/<run>`) plus `git merge-tree` predict
  conflicts. Both owners and both orchestrators hear about them.
- **Leases are released when the goal lands.** "Landing" means a merged PR, a
  delivered push, or an applied run.
- **Team policy enforced:** permission ceiling (`bypassRequiresPlan`), agent
  allowlist, protected-branch delivery (forces a PR), and per-member and
  team-wide concurrency caps.
- **Fixes:**
  - an orchestrator replying with no actions while nothing was running looped
    until the round limit, and now waits for a human;
  - an abort during a run's final wrap-up was overwritten by "completed";
  - a member's own `gh` poll reporting their PR merged was ignored.

### Loom Teams, Phase 1: see each other

- **The design is settled:** 27 decisions from a design interview, recorded in
  docs/teams-architecture.md §1a.
- **Team crypto:**
  - an XChaCha20-Poly1305 team key;
  - an X25519 sealed box for key envelopes;
  - Ed25519 signatures on everything a daemon publishes;
  - the invite link carries the key in its `#fragment`.
- **The hub:**
  - the `HubClient` protocol, with `MemoryHub` as the reference rules;
  - `loom hub`, a self-hosted hub over HTTP + WebSocket;
  - the hosted hub's SQL (RLS plus rule functions), tested against a real Postgres.
- **Team Link in the daemon:**
  - sign-in, create, invite, join and leave;
  - removal rotates the key forward;
  - opt-in project sharing, with auto-match on the git remote;
  - heartbeats carry intent only;
  - a goal/plan/PR feed, with `gh` polling when there is no GitHub App.
- **Worker commits carry `Loom-Goal`, `Loom-Task`, `Loom-Agent` and `Loom-Member`
  trailers.**
- **The orchestra protocol gains `touches`** (declared file globs per task).
- **Fix:** a removed member's daemon now hears its own removal. It was cut off
  before the announcement.

### Permissions, plan mode, git delivery, fleet, prompts

- **Permission modes per agent: bypass, auto, always ask.**
  - Each is mapped onto each CLI's own flags, and every cell was verified against
    the real CLI (`scripts/verify-permissions.mjs`).
  - Always ask on Claude Code routes each tool use to a real approval in Loom,
    through a built-in MCP permission-prompt server. Verified with the real CLI
    (`scripts/verify-approvals.mjs`).
  - Two cells measured broken are shown as unavailable instead of lying: OpenCode
    "ask", and Antigravity "auto" (which writes to agy's scratch folder).
- **Plan mode.**
  - Chat turns write a markdown plan instead of code.
  - Orchestras commit `plans/<run>/PLAN.md` plus a spec per task before workers
    start, and write results back at the end.
- **Git delivery policy: none, commit, push, or PR.** Covers chat turns and finished
  orchestras. PR mode pushes the run's branch and opens a PR with `gh`.
- **Fleet:** `GET /api/activity` and a Fleet view of every agent's thread, task and
  last step.
- **Prompt manager:** saved and pinned prompts, plus automatic sent-prompt history
  (`/api/prompts`).
- **Teams:** researched architecture in docs/teams-architecture.md.

### Orchestra: one orchestrator, many parallel workers

- **`loom orchestrate "<goal>"`**, plus Orchestrate mode in the app.
  - Any agent can orchestrate: Claude Code, Codex, Antigravity, Grok or OpenCode.
    It plans the goal into a task graph.
  - Worker agents run every ready task at once, mixed kinds or several of the same
    kind. Each task gets its own thread and git worktree.
  - Finished work merges into `loom/orchestra/<run>/main`, and the orchestrator
    reviews, follows up, or finishes.
  - `orchestra:apply` merges the run into your branch. Nothing touches it before
    that.
  - Verified against the real CLIs:
    - Claude orchestrating Codex and Antigravity (278 s);
    - Codex orchestrating Grok, OpenCode and Claude Code (82 s, $0.31).
    - Both delivered working code with passing tests
      (`scripts/verify-orchestra.mjs`).
  - Design credit: Agent Orchestrator (Apache-2.0). See THIRD_PARTY_NOTICES.md.

### Loom Cloud: reach your agents from any network

- A Supabase Realtime relay, end-to-end encrypted (XChaCha20-Poly1305). The key
  exists only in the pairing QR's URL fragment, so Supabase relays ciphertext.
- Relayed requests run against the daemon with the phone's own token. The admin
  bootstrap is refused over the relay.
- New commands: `loom cloud enable|disable|rotate`. Setup guide: docs/cloud.md.
- Connection patterns credited to T3 Code (MIT).

### Fixes found by running the real agents

- A worker's `.loom/` state made `git add` fail whenever the project gitignored
  `.loom/`. That failed every real Codex task.
- A project reached through a symlink (every macOS temp dir) registered twice, so
  two runtimes ran over one `.loom/`.
- OpenCode's default model is refused headless ("Model is unavailable"). With no
  model pinned, the adapter now picks one the server can actually run.
- `test/git.test.ts` assumed the default branch is `main`; CI runners use `master`.


### Hardening (production-readiness pass)

- **Closed a DNS-rebinding path to the admin token.** `GET /api/bootstrap` handed
  the admin token to any loopback socket; it now also requires a loopback `Host`
  header, so a malicious page (whose hostname rebinds to 127.0.0.1 but is still
  sent as the `Host`) is refused — while the genuine local console still boots.
- **WebSocket token out of the URL.** The durable bearer token rode in `/ws?token=`
  (browser history, proxy logs); it now travels in a `loom.bearer.<token>`
  subprotocol header, with `?token=` kept as a fallback for the CLI/native clients.
- **git flag-injection guard.** A ref/branch beginning with `-` (e.g. `-f`, which
  would force-discard the working tree) is rejected in `checkout` and worktree add.
- **No phantom daemon on an occupied port.** `loom daemon` on a taken port now
  reports "port already in use" and exits non-zero, instead of Express firing the
  listen callback on EADDRINUSE and printing a false "listening".
- The **security model** section of the README is rewritten to match: the local
  admin bootstrap and its rebinding check, the shared-host caveat, and the honest
  note that a paired client can open a real shell (arbitrary code as the daemon
  user) — bearer + tailnet is the boundary, so pair only devices you control.

### `loom tui` — a tabbed workspace, not just a thread

- The TUI is now four views: **Thread** (the streamed conversation), **Board**
  (agents, your cards, issues and PRs in the four flow columns), **Brain** (the
  memory the project has learned, grouped by kind with failures first and who
  learned each), and **Diff** (the working tree — changed files and a colourised
  patch). **`shift+tab`** cycles them, `/board /brain /diff /thread` and the
  `ctrl+p` palette jump straight to one, `pgup/pgdn` scrolls, and the viewport
  tracks a terminal resize. Everything the single pane did — routes, handoff,
  `/pair` QR, interrupt, the palette — stays. Backed by real data (new
  `brain`/`board` daemon-client methods) with pure, unit-tested formatters.

### Connect a phone — a QR from inside the app

- A **Connect a phone** button beside the terminal opens a modal with a QR (or a
  copy link) and a **Local network / Tailnet** toggle. When the daemon is still
  localhost-only, **Enable phone access** adds a *second listener* on the chosen
  LAN/tailnet IP — localhost is never torn down, so there's no dropped-socket
  window and none of the EADDRINUSE races a live rebind to `0.0.0.0` hits. The
  local (loopback) window bootstraps the admin token, so it can pair phones with
  no pairing dance of its own; a paired phone is never admin.
- **Client errors reach the Console.** `window.onerror` and unhandled rejections
  now stream into the same Console tab as the daemon's own logs, with the error
  dot — nothing dies silently in the browser.

### Brain — stronger injection, and it's genuinely shared

- The learned memory reaches every agent, not just Claude: the brief rides in
  Grok's `--rules` (a real system channel), and for Codex/OpenCode it's framed as
  an unmissable `LOOM SESSION MEMORY — authoritative, read first` block instead of
  loose preamble. The brain is the **project's** — a fact one agent learns reaches
  whoever takes the baton next ([`brain-shared` test](test/brain-shared.test.ts):
  five agents, five prompts, one shared memory). An opt-in eval
  (`LOOM_TEST_REAL=1`) checks a real model actually *uses* an injected brief.

### Native search — one palette over everything (⌘K)

- **⌘K / Ctrl+K** opens a command palette from anywhere, even mid-type. One box
  searches across **commands** (go to Thread/Board/Brain, open a panel, New task,
  Settings, toggle terminal/theme…), **agents** (talk to one), **files** and
  **code** (the project's own `/find` + `/grep`), **conversations**, and
  **worktrees** (jump to one — it `cd`s there in the terminal). Commands, agents
  and worktrees filter instantly; the daemon-backed sections stream in as you
  type. ↑↓ navigate a flat list, ↵ acts, esc closes. A ⌘K affordance sits in the
  sidebar search.

### Connect GitHub from the status bar

- The bottom bar shows whether `gh` is signed in and as whom. When it isn't, a
  **Connect GitHub** button runs the interactive `gh auth login --web` in the
  real terminal (Loom never touches the token — gh stores it) and polls until
  you're in, then lights the board up. The whole GitHub half (PRs, Projects,
  review) depends on this being true, so it lives where you can see it.

### GitHub & Linear, native

- **One board, three sources.** A segmented control switches the Board between
  **GitHub** (the live kanban), **Projects** (browse the owner's GitHub Project v2
  boards, items laid out by their Status column), and **Linear** (recent issues).
- **Review and approve PRs in place.** Open a PR's diff in-app and post the three
  reviewer verbs — comment, request changes, approve — through your own `gh`, signed
  as you. Approve asks first, because it publishes.
- **Open a worktree from any task.** One click cuts a checked-out branch in its own
  sibling directory: a PR worktree checks the branch out (forks included, via
  `gh pr checkout` into a detached worktree); an issue worktree cuts a fresh branch.
- **File a Linear issue with a team selector.** Loom reads `LINEAR_API_KEY` from the
  daemon's own environment and never stores it — the same bet it makes with `gh`. No
  key → an honest "not connected", never a dead form.

### Settings — one sectioned screen

- The lone Setup modal is now **Settings**, with a nav rail: **Setup** (what the
  machine still needs), **Diagnostics** (`loom doctor`, run live), **Updates** (build
  rev + how far the checkout is behind its remote), **Preferences** (theme, brain
  extractor, handoff brief style, default agent — read live, no restart), **Devices**
  (paired clients, revoke, pair), and **About**.
- `/api/setup`, `/api/doctor`, and `/api/updates` moved behind the auth wall — they
  inventory the machine, which matters the moment the daemon binds past localhost.

### The Brain learns on its own (mem0-style)

- After each turn a small Claude reads what changed and files typed memory **units**
  — constraint, decision, convention, fact, failure — reconciled on write
  (add / update / forget, never a growing blob), the approach mem0 pioneered, adapted
  to Loom's event log. Every unit's evidence is verified against the turn before it's
  kept. Retrieval unions an entity index with BM25.
- The **Brain tab** shows the learned units by kind; the extractor toggles off per
  project in Settings.

### Composer

- The agent chip is a real **picker** now — click it to switch which agent the
  composer talks to, instead of hunting the sidebar. Each control (attach, switch
  agent, model, send) is its own labelled button, and the message box starts at two
  lines, grows, then scrolls.

### Real agent output

- Agent **thinking** is shown in a collapsible block, kept apart from the reply, and
  messages render as **rich markdown** (headings, lists, code, inline code) instead of
  raw text.

### Board — everything in flight, and Tasks folded into it

- **The Tasks tab is gone.** The Board covers it: search issues and pull
  requests from the board itself, in GitHub's own query language
  (`is:issue is:open label:bug`), and **Start** still hands an issue to an
  agent. Tabs are Thread | Board | Brain.
- **Add your own cards.** `+ Task`, or the `+` in any column — including Ready
  to merge. These are yours, so the column *is* the state: dragging one really
  moves it and it persists. That's the difference from a PR card, whose truth
  belongs to GitHub and can only be pinned. Click a card's title to retitle it.
- Issues only appear when you search for them — a repo's whole backlog would
  bury the work actually in flight. And asking for issues no longer also hands
  back unrelated PRs: `gh pr list --search "is:issue …"` ignores the qualifier
  and returns open PRs, so the board now asks for what you actually asked for.

### Board — everything in flight, in one place

- A **Board** tab replaces Routes: four columns — working → needs you → in
  review → ready to merge — holding every piece of live work in the project.
- Cards are derived from real state, never stored. Loom supplies the ones with
  no PR yet (which agent is running, which is blocked on a question); the
  project's GitHub remote supplies the rest through your own `gh`: draft,
  review pending, CI failed, changes requested, approved. A card shows the
  agent's own logo, the branch, and links to the PR.
- **Drag a card** and it stays where you put it (per project, across reloads).
  A pin only moves a card — the badge keeps reporting what GitHub and the daemon
  actually say, because a drag can't approve a review or turn a red build green.
  Drop it back where its state says it belongs, or click its `pinned` mark, and
  it goes back to being placed by reality.
- No remote, or no `gh`? The agent half of the board is ours and still real —
  it renders, with a line saying why the pull requests are missing.
- **Routes lost its tab, not its home**: named pipelines and custom step lists
  both live in the New task modal (several agents *is* a pipeline), and live
  route state plus abort live in the Source Control rail. The mobile route sheet
  is untouched.

### Chats, and roles you name yourself

- **A project holds conversations.** The sidebar nests chats under each
  project; create, rename (double-click), and forget them. Everything else
  stays shared — one brain, one baton, one working tree. Only the talking is
  split. Forgetting a chat unlists it and nothing more: the log is append-only
  and the brain is built from all of it, so deleting a conversation shouldn't
  quietly rewrite what the project decided.
- Agents moved to the rail's roster, which is where they belong — an agent
  works the whole project, not one conversation.
- **Roles are free text.** Not planner|executor|reviewer|general any more: call
  an agent "architect" or "the one that writes docs". Click the role and type.
  Those three names still mean something if you use them (they seed the default
  ship pipeline, the rules router prefers a reviewer last, a route step matches
  by role) and nothing if you don't.
- The event log gained a `chat` column. **The first cut of that migration
  destroyed logs**: the chat index was created before the column was added,
  sqlite threw "no such column", and `EventLog.open` caught it and quietly
  started an *empty* JSONL log beside a database full of history. Migrate
  first, then index — and that catch now only covers the one case it was for
  (a runtime with no `node:sqlite`). If the module is there and the log won't
  open, it throws: losing the thread is worse than failing loudly.

### ADE brand marks

- Claude Code, Antigravity, opencode, Kiro and Codex now appear as their own
  logos wherever an agent does: the sidebar, the thread, agent chips, the New
  task modal, and board cards. Rendered from
  [@lobehub/icons](https://github.com/lobehub/lobe-icons) (MIT) by
  `scripts/gen-brand-icons.mjs` and frozen into an SVG sprite — the web app has
  no build step and no CDN, so it can't import React components.
- Keyed by adapter *kind*, not by name: you can call an agent anything, but its
  kind is what it is. A kind with no mark (a custom adapter, `echo`) keeps the
  hue monogram rather than borrowing someone else's brand.
- **Bridges are visible at last.** Antigravity is a bridge, and every view
  filtered bridges out — so a configured bridge rendered nowhere and Loom looked
  like it had ignored your config. Bridges now show in the sidebar, marked as
  bridges and not clickable, because they never hold the baton.

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

- **The phone gets Tasks too**, which is where the feature always wanted to
  live: see an issue on the train, tap it, confirm, and an agent is working
  before you look up. Same daemon endpoint, same honest unavailable states. It
  asks for confirmation first — the desktop shows the brief in an editable field
  before it goes, and a tap on a scrolling list has no such beat.

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
- **Enter did nothing on the pairing screen.** Paste a token, press Enter — the
  entire gesture that screen exists for — and nothing happened; only the button
  worked. Same in the route form. Both now submit on Enter, like every other
  field in the app.
- The Tasks `Issues`/`PRs` toggle was dead while the first `gh` fetch was in
  flight — the loading branch rendered the buttons but returned before wiring
  them, so they were inert for exactly as long as anyone would be looking at
  them.
- The GitHub mark in the Tasks provider row was an enabled button with hover and
  a pointer cursor, and no handler. It's the only provider Loom reads, so it's
  now the indicator it always was, not a control that does nothing.
- Dead code and CSS removed: an unused `dockShowing`, two write-only state hooks
  no consumer ever read, and five rules for classes nothing renders. `route()`
  now also clears `state.retheme`, which alone survived a view teardown holding
  the previous render's terminals.
- **Tasks blamed a missing remote for every failure it didn't recognise.** A
  timeout, a 500, a rate limit, or a private repo you lack scope for all told
  you to "add a GitHub remote and reload" — with the remote right there. gh's
  failures are now sorted by what gh actually prints, and the panel shows gh's
  own words. Fixes a live mis-read too: gh's message for a *non-GitHub* remote
  mentions `gh auth login`, so a GitLab remote was reported as "signed out".
- The terminal routes answered **429 "too many requests" for any failure to
  start a shell**, and `/term/input` could hand a JSON client Express's HTML
  error page. Only the session cap is a 429 now, and it says what the cap is.
- `cliAvailable()` had no timeout. It runs in front of HTTP handlers (Tasks
  probes `gh` on every request), so one wedged `gh --version` hung that request
  forever with no reply. Bounded at 5s, and the child is reaped.

### Documentation

- **Every SDK example told you to import from `loom-agents/sdk` — a package that
  has never existed.** It's `threadloom/sdk`. `test/docs.test.ts` now checks that
  the docs only import packages that resolve, and only names the SDK exports.
- `ARCHITECTURE.md` is the pre-build design record, and read as though it were
  the current map: two surfaces instead of four, an iOS-first app over APNs
  (it's Android-first over Expo), and settled questions still framed as risks.
  It now says what it is, and the corrections are marked inline.
- `desktop/README.md` claimed the bootstrap was unit-tested (it wasn't — now it
  is) and that `main.js` "only creates the window" (it owns the menu and the
  folder-picker IPC).
- The `LOOM_*` environment variables are documented, and Loom's own
  `LOOM_TERMINAL=1` marker is written down.

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

- `test/workspace.test.ts` (34 tests) covers the surfaces the desktop UI is
  built on and previously had none: Explorer listing/reading/find, the sandbox
  (traversal, absolute paths, symlink escape, unauthenticated access), and the
  terminal end-to-end (streams output, exit codes, no sentinel leakage, `cd`
  and variables persisting, terminal isolation, and Ctrl+C giving exit 130
  while the shell survives).
- `test/desktop-app.test.ts` covers the Electron bootstrap, which had claimed to
  be unit-tested without being it: the build-rev fingerprint (including that a
  UI-only rebuild moves it), the stale-daemon decision (and that an
  un-fingerprintable daemon is never killed), and the pairing handshake —
  against a fake daemon, so no test can spawn or kill a real one. The
  rev-mirrors-the-daemon check imports the built daemon's own `BUILD_REV`
  rather than re-deriving it, so the two can't drift in agreement.
- **Two tests couldn't fail**, which is worse than not having them. The
  interrupt test passed in pty mode with `PtySession.interrupt()` gutted: a pty
  echoes what you type, so it matched `/alive/` on the echo of `echo alive`
  while `sleep 30` still held the shell. And `LOOM_EXPECT_PTY` was referenced
  once, set nowhere, and inverted — no value of it could fail the pty suite
  when node-pty was absent, so a failed build (it's optional, and has no Linux
  prebuild) would have downgraded every pty test to a no-op with CI green.
  `LOOM_EXPECT_PTY=1` now asserts the backend and CI sets it; that run confirms
  the runner really does build node-pty.
- `test/tasks.test.ts` locks gh's failure classification against the strings gh
  actually prints, and `test/docs.test.ts` checks the docs only import things
  that resolve. Every new test above was checked by breaking the code and
  watching it go red.
- CI now typechecks `app/`, which nothing was compiling.
- Suite: 96 → 179.

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
  traffic lights centered in the app's own top strip, 600×400 minimums,
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
