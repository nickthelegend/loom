# Loom — master test plan (baseline)

The definition of "correct" for Loom v0.2.x, derived from README.md,
FEATURES.md, ARCHITECTURE.md, docs/teams-architecture.md (D1–D84) and the code.
**Frozen before execution**: tests added later go under "Added during testing"
at the end, never edited into the baseline.

Every test runs against the **real product**: a daemon started from `dist/`
(the same code `loom up` and the desktop app run) in a fresh `LOOM_HOME` (a
first-time user), real HTTP, real git, real agent CLIs (cheap models, total
spend ≤ ~$5), the real hosted hub (Supabase project `ufpkfpzspfzzxabklyec`), and
the private GitHub sandbox `nickthelegend/loom-e2e-sandbox` for anything that
touches GitHub. UI tests run in a real browser against the served web app.

Format: **ID — Target.** Steps → Expected (exact) · Effect (backend/persistence)
· PASS when. Status and evidence live in `e2e/results/*.json` and the final
report.

## A. Daemon, auth, first run

- **A1 — First run.** Start a daemon with an empty LOOM_HOME → `GET /api/health` 200 `{ok:true,name:"loom",version:"0.2.x"}` · `daemon.json` created with a 64-hex adminToken, mode 0600 · PASS when all three hold.
- **A2 — Unauthorized.** `GET /api/projects` with no token and with a wrong token → 401 both · no state change · PASS when both 401.
- **A3 — Bootstrap is loopback-only.** `GET /api/bootstrap` from 127.0.0.1 → 200 `{token: adminToken, admin:true}`; with `Host: evil.example` → 403; with header `x-loom-via: relay` → 403 · PASS when all three.
- **A4 — Version and updates.** `GET /api/version` → 200 with `rev`, `node`, `platform`; `GET /api/updates` → 200 `version` = package.json version · PASS when both.
- **A5 — Pairing.** `POST /api/pair/new` (admin) → 200 with `token`, `link`; `POST /api/pair/claim {token,name}` → 200 with a client token; that token → `GET /api/projects` 200; claiming the same token again → 403; `POST /api/pair/new` with the client token → 403 (admin only) · `daemon.json` clients has the device · PASS when all hold.
- **A6 — Scoped client.** Pair with `projects:[P1]` → the client sees P1 and gets 403/404 on P2's routes · PASS when isolation holds.
- **A7 — Revoke a client.** `DELETE /api/pair/clients/:id` → 200; its token → 401 afterwards · client removed from daemon.json · PASS when both.
- **A8 — Restart persistence.** Create project, chat, memory, prompt; restart the daemon → all still listed with the same ids · PASS when identical.
- **A9 — Doctor and setup.** `GET /api/doctor` 200 with checks for node/git/agents; `GET /api/setup` 200 · CLI `loom doctor` exits 0 and names installed agents · PASS when agents detected = CLIs on PATH.

## B. Projects

- **B1 — Add a project.** `POST /api/projects {dir: fresh git repo}` → 200 `{project:{id,name,dir}}`, config written with detected agents · `.loom/config.json` exists in the repo · PASS when agents list contains every installed CLI kind.
- **B2 — Invalid dir.** `POST /api/projects {dir:"/nonexistent/x"}` → 4xx with an error message · nothing registered · PASS when 4xx and list unchanged.
- **B3 — List and status.** `GET /api/projects` includes B1's project; `GET /api/projects/:id` 200 with agents and baton · PASS.
- **B4 — Unknown project.** `GET /api/projects/nope/board` → 404 with "unknown project" · PASS.
- **B5 — Config.** `GET/PATCH /api/projects/:id/config` round-trips a change (e.g. projection mode) · persisted to `.loom/config.json` · PASS when re-read equals.
- **B6 — Remove.** `DELETE /api/projects/:id` → 200; list no longer has it; the repo's files untouched · PASS.

## C. Agents and permissions

- **C1 — Roster.** `GET /api/projects/:id/agents` lists every agent with kind, role, availability · PASS when available=true for installed CLIs.
- **C2 — Add/remove an agent.** add a second claude-code agent → listed; remove → gone; invalid kind → 400 · PASS.
- **C3 — Model per agent.** set claude's model to `haiku` → config shows it; next turn uses it (event payload/cost reflects haiku) · PASS.
- **C4 — Permissions per agent.** `POST .../agents/:agentId/permissions {permissions:"bypass"|"auto"|"ask"}` → 200, persisted; an invalid mode → 400; `GET /api/permissions` lists profiles for each CLI · PASS.
- **C5 — Enable/disable.** disabling an agent removes it from routing; enabling restores · PASS.

## D. Conversations (real agents)

- **D1 — Chats.** create, list, rename, delete a chat; deleting/renaming the main chat → 400 · persisted across restart (A8) · PASS.
- **D2 — Send to Claude (real).** `POST /messages {text:"Reply with exactly: PONG", agentId: claude}` → a `message` event from claude containing `PONG` within 90s; a `turn_cost` status with costUsd>0 or tokens · events persisted (`GET /events`) · PASS when the reply and cost are observed.
- **D3 — Send to Codex (real).** same with codex → reply contains PONG · PASS.
- **D4 — Send to OpenCode, Grok, Antigravity (real).** same per CLI (each its own test ID D4a/b/c) · PASS per agent when it replies.
- **D5 — Handoff.** after D2, `POST /handoff {to: codex}` → 200; the baton moves; codex's next turn gets a briefing that mentions the prior conversation (projection injected) · PASS when codex answers a question only answerable from the Claude turn ("what word did the previous agent reply with?" → PONG).
- **D6 — Interrupt.** start a long turn, `POST /interrupt` within 5s → turn ends with an interrupted status, agent idle again · PASS.
- **D7 — Empty message.** `POST /messages {text:""}` → 400 "missing text" · PASS.
- **D8 — Retry.** `POST /retry` re-runs the last failed prompt on a chosen agent · PASS when a new turn happens (only testable after a real failure; else run against a forced failure by an unavailable agent).
- **D9 — Queued prompt.** send while an agent is busy → the prompt is queued and runs after · PASS when both replies arrive in order.

## E. Brain

- **E1 — Add/list/update/forget.** `POST /brain` add a decision → listed; update text → history shows both; forget with reason → gone from list, history keeps it · persisted across restart · PASS.
- **E2 — Retrieval into a handoff.** a memory about "port 7421" reaches the next agent's briefing: ask "what port does the service use?" → answers 7421 · PASS with a real agent.
- **E3 — Conflicts.** two contradicting decisions → `GET /brain/conflicts` lists the pair · PASS.
- **E4 — Decisions endpoint.** `POST /decisions {text}` → event + a memory · PASS.
- **E5 — Native memory import.** a `CLAUDE.md` in the repo → import → memories created, idempotent on re-import · PASS.

## F. Orchestra (real agents)

- **F1 — Plan and run.** start with orchestrator claude(haiku), worker opencode (free model), goal "create hello.txt containing hi" → tasks spawned, worker writes the file on its branch, merged into `loom/orchestra/<id>/main`, run `completed` · PASS when the integration branch has hello.txt = "hi".
- **F2 — Plan mode.** same with `plan:true` → `plans/<run>/PLAN.md` and a task spec on the integration branch · PASS.
- **F3 — Apply.** `POST /orchestra/:runId/apply` → merged into the project branch · PASS when the project HEAD contains the file.
- **F4 — Abort.** abort a running run → status aborted, workers stopped · PASS.
- **F5 — Reply to a question.** a goal that makes the orchestrator ask → `waiting_human`; reply → continues · PASS.
- **F6 — Delivery = PR.** in a sandbox clone with `git.delivery:"pr"` → a real PR opened on the sandbox · PASS when `gh pr view` shows it.

## G. Git and files

- **G1 — Status/diff/branches.** `/git/*` endpoints return the real repo's status, branches and diff after a change · PASS when they match `git` itself.
- **G2 — Branch and worktree.** create a branch, checkout, create/remove a worktree; refs starting with `-` refused · PASS.
- **G3 — Commit and push.** commit a change via the API and push to the sandbox remote · PASS when the sandbox has the commit.
- **G4 — Files.** `/tree`, `/files`, `/file`, `/find`, `/grep` return real contents; path traversal (`../../etc/passwd`) refused · PASS.

## H. Prompts, board, skills, MCP

- **H1 — Prompt manager.** create, list, update, delete a prompt; recent list · persisted · PASS.
- **H2 — Board.** create a card, move it, delete; empty title refused · persisted · PASS.
- **H3 — Skills.** `/skills` lists discoverable skills; install/remove one · PASS.
- **H4 — MCP.** `/api/mcp/catalog` real rows; add/remove an MCP server to the project; config written · PASS.

## I. Observability

- **I1 — Metrics, costs, insights.** after real turns, `/metrics`, `/costs`, `/insights/*` report non-zero turns for the agents used · PASS.
- **I2 — Budgets.** set a per-agent daily budget below spend → the next send is refused with a budget error · PASS.
- **I3 — Logs and activity.** `/api/logs`, `/api/activity` reflect the run · PASS.
- **I4 — Webhook alerts.** `POST /api/webhooks/alerts` with a firing alert for an agent → that agent is quarantined; resolved → released · PASS.

## J. Terminal

- **J1 — PTY.** open a terminal, write `echo hi`, read `hi` back over WS, resize, signal, close · PASS.

## K. Phone connection and Loom Cloud

- **K1 — Push registration.** `POST /api/push/register {token}` → stored on the client record; `DELETE` removes it · PASS. (Delivery to a real phone: BLOCKED without a device.)
- **K2 — Loom Cloud relay (real Supabase Realtime).** enable cloud → status connected; a relay client (the phone's protocol) sends an encrypted request through Supabase and gets the real response; `/api/bootstrap` via relay refused · PASS when the round trip works end to end.

## L. Teams — hosted hub, real GitHub

- **L1 — GitHub sign-in (hosted).** `loom team signin` loopback flow in a real browser → session stored; `me` = the GitHub login · PASS (BLOCKED if the browser has no GitHub session).
- **L2 — Create, invite, join.** create a team, invite, a second member joins (a throwaway hosted user), both see both · PASS.
- **L3 — Share and presence.** share the sandbox repo; a running agent appears in the other member's presence within 20s with intent decrypted · PASS.
- **L4 — Feed.** a goal start/finish appears in the other member's feed · PASS.
- **L5 — Leases and holds.** overlapping `touches` → the second task holds for a decision; hard zone `db/**` queues · PASS.
- **L6 — Team brain.** a memory from member A reaches member B's briefing labelled "proposed by …"; promote → a real `loom/canon` PR on the sandbox · PASS.
- **L7 — Landing on the sandbox.** a goal PR → real CI runs → green; review agent (a different vendor) posts a COMMENT and a `loom/review` status; Land → the PR merges on GitHub · PASS when merged and status observed.
- **L8 — Doctor on the sandbox.** reports no merge queue and missing merge_group; fix → a real PR adding `merge_group:` · PASS.
- **L9 — Deploys and release notes.** the deploy workflow on main creates a `staging` deployment → `deploy_succeeded` in the feed; `release-notes --since <tag>` lists the landed PR · PASS.
- **L10 — Runner.** pair a second daemon as a runner; start a goal on it (real agent) → runs in a fresh clone and delivers a PR; move a running goal; bring it back · PASS.
- **L11 — Landing train (Phase 6).** no merge queue on the sandbox → two Lands in one lane serialize; different lanes land together · PASS.
- **L12 — Webhooks (Phase 6).** self-hosted hub receives a real GitHub webhook (signature verified) → feed event without polling · PASS.

## M. Web app UI (real browser)

- **M1 — First open.** `/app` on a fresh daemon loads with no console errors; the local admin bootstraps; empty state offers to add a project · PASS.
- **M2 — Add project from the UI** and see agents · PASS.
- **M3 — Chat in the UI** with a real agent; reply renders; composer modes (plan toggle, permissions dropdown, prompt manager) work · PASS.
- **M4 — Orchestra in the UI**: start, watch tasks and threads, apply · PASS.
- **M5 — Settings**: version shown, pairing QR/link, team panel, runner panel, doctor · PASS.
- **M6 — Refresh/re-entry**: reload mid-run → state restored · PASS.
- **M7 — Console/network**: no errors, no failed requests during M1–M6 · PASS.

## N. Distribution

- **N1 — CLI install from git.** `npm install -g github:nickthelegend/loom` in a clean prefix → `loom --version` = 0.2.x · PASS.
- **N2 — macOS dmg.** built dmg mounts; the app is a valid ad-hoc-signed bundle (`codesign --verify --deep --strict`), identifier `dev.loom.desktop`, launches and starts/uses a daemon · PASS.
- **N3 — Android apk.** release build contains `assets/index.android.bundle` and verifies with `apksigner` against the project key · PASS.
- **N4 — Windows exe / Linux AppImage & deb.** built by the release workflow · PASS when the jobs succeed and the files are attached.
- **N5 — Runner image.** Dockerfile.runner builds; CLI and daemon run inside (CI job) · PASS.
- **N6 — Phone app on a device.** BLOCKED without an Android device/emulator here.
- **N7 — LoomPad hardware.** BLOCKED without the device.

## O. The prompt queue and multi-agent workflows (real agents)

- **O1 — Queue behind a real turn.** Send a prompt that keeps a real CLI busy, queue three more: the queue lists them, says what it's waiting for, and **none of them is in the thread yet**. Edit one, remove one, reorder them; when the turn ends they go in the queue's order, one at a time, and the removed one never runs. Live `queue` frames reach the socket · PASS.
- **O2 — Change who takes a waiting prompt.** A prompt queued for claude-code, retargeted to codex while it waits: the baton moves to codex, and codex's reply carries the token · PASS.
- **O3 — A goal queued behind a goal.** One orchestra run at a time (a direct second start is still 400); a goal queued for the orchestrator starts itself when the first finishes, and completes · PASS.
- **O4 — Stop holds the queue.** Stop mid-turn pauses the queue with a reason and keeps the prompt; nothing runs while it's paused; resume sends it · PASS.
- **O5 — `loom queue` from the terminal.** add / list / edit / move / to / rm / clear / pause / resume all drive the same queue the app shows · PASS.
- **O6 — One orchestrator, two vendors in parallel.** A goal whose two tasks go to different agents (opencode and codex): both run in their own worktrees, and both files land on the integration branch · PASS.

## Added during testing

(Discovered gaps become tests here: DEFINE → FAIL → FIX → VERIFY.)

- **X1 — v0.2.0 apk has no JS bundle** (found while planning N3): the release built `assembleDebug`. → fixed to a release-signed `assembleRelease` with a bundle check.
- **X2 — Mac app bundle signature invalid** (found while planning N2): only Electron's linker signature. → fixed with an ad-hoc signing hook.
- **X3 — "offline" before a project is open** (found in M1): the status bar read the WebSocket, which only opens with a project. → it now reads the daemon's own reachability.
- **X4 — grok-code and agy reported signed-out** (found in M1/Setup): the probes ran a CLI that needed a TTY, or timed out at 6s. → both now read their own auth files, with a longer probe.
- **X5 — A late review clobbers an override** (found in L7b, on a real sandbox PR): the owner overrode `loom/review`, and the review that was still running finished and wrote `failure` over it, in the GitHub status and in the goal. → an override now names the commit it covers, and a review that finishes after it leaves the decision alone.
- **X6 — Queued prompts were invisible** (found while testing the queue by hand): a prompt sent to a busy agent was logged into the thread as if sent, couldn't be seen, edited or reordered, and Stop dropped it. → the prompt queue (area O).
- **X7 — A question's hold stranded the next prompt** (found by the full suite, three hung tests in app-dom): with the queue held so an agent's question couldn't be answered by what you queued behind it, anything typed to that busy agent joined a paused queue nothing would resume. → answering the agent that asked lifts that hold; a pause you set yourself, or Stop's, stays.
- **X8 — An overridden review left its status pending** (found while rewriting the override test): when a review came back to a commit the owner had already overridden, the decision was kept in the goal but nothing was posted, leaving the "reviewing…" status that same review had posted on its way in — a required `loom/review` would wait for ever. → it re-posts the owner's success, with their reason.
