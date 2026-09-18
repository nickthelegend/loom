# Loom Teams — architecture for many people, many agents, one repo

> Status: **design, researched and decided 2026-09-18.** The decision record in
> [§1a](#1a-decision-record) was settled in a design interview with the owner, and it
> overrides anything below that disagrees with it. Nothing here is built yet except
> where a section says "exists today". It is the plan for taking Loom from one developer's
> fleet to a team of 2–10 people, each running their own agents against the same
> GitHub repository. Sources for every claim about other tools are in
> [§12](#12-sources).

## 0. The problem in one paragraph

Put five people on one repo, each with an orchestrator and four workers, and you
have ~25 agents writing code at once. The failures that follow are well-documented,
not hypothetical:

- **Reviewers drown first.** Code generation outruns review. DORA 2025 ties more AI
  adoption to higher throughput *and* higher instability.
- **AI-authored PRs carry more defects.** One study of 470 PRs found ~1.7× more
  issues than human PRs.
- **Parallel agents collide.** When two concurrent agent PRs from *different* agent
  vendors touch the same files, they conflict **41.7%** of the time. The rate for
  the same vendor is 19.8% (33,596 agent PRs, 2,807 repos). A Loom team is exactly
  that mixed-vendor case.
- Beyond that: duplicated work nobody noticed, semantic conflicts that merge cleanly
  and break main, flaky CI multiplied through merge queues, secrets leaking through
  prompt-injected PR text, and shared memory that drifts or gets poisoned.

**Worktrees give agents isolated checkouts. They do nothing about who should work
on what.** Loom Teams is the answer to that second question.

## 1. Principles

1. **Code stays on members' machines; GitHub stays the source of truth for code.**
   Loom never hosts repositories. It coordinates *intent* (who is doing what, and
   where), and it moves *memory*.
2. **Memory is the product.** Every agent on the team should start its turn knowing
   what the team has decided, what failed, what's in flight, and what a teammate's
   agent learned an hour ago. Getting this right, with provenance and without
   poisoning, is the core of the design.
3. **One reviewable unit per goal.** Worker branches never become PRs. A goal
   produces one PR, or a short stack. Agents never approve or merge.
4. **Coordinate before you collide.** Leases are taken at planning time, and
   conflicts are detected while the work is still in progress, not at merge time.
5. **Test the merged result, not the branch.** A merge queue is not optional at team
   scale.
6. **Least privilege and a signed audit trail.** Every action is traceable to a
   member, an agent, a goal and a task.
7. **Private by default.** Content (code, prompts, memory) is end-to-end encrypted
   to the team. The coordination plane sees only what it must.

## 1a. Decision record

These were settled one at a time, root first, in the order the design tree depends
on them. Later sections implement them.

| # | Decision | Chosen | Why it matters downstream |
|---|---|---|---|
| **Foundations** |||
| D1 | Who runs the Team Hub | **Hosted by Loom *and* self-hostable from day one** | One schema, migrations and Edge Functions deploy to any Supabase. `LOOM_TEAM_HUB_URL` picks the hub. |
| D2 | Privacy from the hub operator | **Content E2E, metadata plain** | Prompts, memory text, plans, goal/task titles and snippets are team-key encrypted. Member, agent, state, branch and **file paths/globs are plaintext**, so the hub arbitrates leases itself. |
| D3 | What a team is | **People; projects are GitHub repos** | Invite-based membership. One team spans many repos. A person can be in several teams. |
| D4 | Identity | **GitHub required, Google optional** | Every member maps to a GitHub login, for commit trailers, CODEOWNERS and reviewer routing. |
| **Keys, joining, scope** |||
| D5 | How a new member gets the team key | **The key rides the invite link's `#fragment`** | Same pattern as phone pairing. Invites are one-time and expire in 24h. |
| D6 | Offboarding | **Rotate forward** | The new key is sealed to each remaining **device key** (Ed25519/X25519). Invites cover joining; device keys cover rotation. History stays under the old key. |
| D7 | GitHub App for self-hosters | **One-click manifest App; `gh` polling fallback** | Hosted teams use Loom's App. Self-hosted teams generate their own, pointed at their hub. With no App, daemons poll with the member's `gh`. |
| D8 | Which projects are shared | **Opt-in per project** | Explicit "Share with team", or auto when the git remote matches a repo the team connected. Nothing else leaves the machine. |
| **Coordination** |||
| D9 | Where "touches" come from | **Declared by the orchestrator, corrected by reality** | `touches` globs are required in team mode. Leases widen on any edit outside them: live for Claude and Codex (they emit `file_edit`), at task end for Grok and Antigravity. |
| D10 | Lease strength | **Advisory, plus hard zones** | `loom.team.json` `hardZones` (e.g. `db/migrations/**`) refuse a second claim. Everything else is planning context. |
| D11 | Where WIP code is shared | **Hidden refs on GitHub** | `refs/loom/wip/<member>/<run>` hold WIP; `git merge-tree` predicts conflicts; the refs are deleted when the goal lands. |
| D12 | Lease lifetime | **Heartbeat TTL (~10 min) + reclaim on wake** | A sleeping laptop's leases go stale. On wake, the goal reclaims and gets a report of what moved. |
| **Memory** |||
| D13 | What auto-shares | **Durable kinds above the confidence floor** | Constraint, decision, convention, fact and failure memories at ≥0.6 become *proposed*. Task memories stay personal. Any memory can be marked private. |
| D14 | Who promotes to canon | **Anyone proposes; the PR decides** | Promotion opens a PR on the canon section. The repo's review rules (CODEOWNERS on AGENTS.md) gate it, so there's no separate ACL. |
| D15 | Where canon lives | **A managed section in `AGENTS.md`** | Between `<!-- loom:canon -->` markers. `CLAUDE.md` gets `@AGENTS.md`. One source of truth. |
| D16 | Aging | **Failures and facts decay (~90d) unless re-confirmed; rules persist** | A resolved contradiction marks the loser *superseded*, never deleted. |
| **Landing** |||
| D17 | Reviewable unit | **One PR per goal; auto-stack when big** | Over ~400 changed lines or 3 independent task clusters → a stack of 2–4 PRs cut along the plan graph. |
| D18 | Review | **A cross-vendor agent review is a required status check, *plus* a human CODEOWNER approval** | The reviewer agent is from a different vendor than the authors. It blocks on high-severity findings and comments on the rest. It never clicks Approve. |
| D19 | Who runs CI auto-fix | **The owner's machine; teammates can Adopt** | At most 2 attempts. After 15+ min with the owner offline, the goal shows "needs someone" and any member can Adopt it onto their daemon. |
| D20 | Testing the merged result | **GitHub merge queue if the repo has it; otherwise a Loom landing lease** | The fallback serializes landing through a hub lease on `main`: rebase on fresh main, fast tests, merge. It's the same lease machinery. |
| **Business and UX** |||
| D21 | Pricing (hosted) | **Per seat, free up to 3 members** | The hub counts members and nothing else. Model costs stay on each member's own agent subscriptions; Loom never resells tokens. |
| D22 | Who sees whose spend | **Owners see everything; members see team totals + their own** | No leaderboard of colleagues. |
| D23 | Policy enforcement | **Enforced for team-shared projects** | The daemon refuses a mode looser than `loom.team.json` allows and says why. Members can go stricter. Side projects are untouched. |
| D24 | Visibility into teammates' work | **Intent, not transcripts** | Goal and task titles, agents, file globs, state and PR/CI status (decrypted client-side). Prompts and agent output only when a thread is explicitly shared. |
| D25 | Phone alerts | **Only what needs you** | A review requested from you; your CI failed after auto-fix; a predicted conflict with your goal; an approval your agent needs; an adopt request. Everything else goes to the feed and a daily digest. |
| D26 | Where teammates show up | **A Team section in Fleet, plus a lease map** | Desktop and phone. The same data feeds orchestrators' planning context. |
| **Phase 2: stop colliding** (settled 2026-09-19) |||
| D28 | When leases overlap | **Expand globs to real files, then compare sets** | Each daemon sends the globs, the concrete files (`git ls-files` matches, capped) and literal directory prefixes (for files not yet created). Overlap is a shared file or a prefix containment. |
| D29 | What an orchestrator must do on overlap | **Declare how it handles it** | Loom won't spawn an overlapping task until the task carries `overlap: "wait:<goal>" \| "narrow" \| "proceed:<reason>"`. The refusal returns to its planning turn with the holder and their intent. The choice is posted to the feed. |
| D30 | When a `wait:` task starts | **When the other goal's PR merges to main** | Seen through the feed (`pr_merged` on `loom/orchestra/<run>/main`). The waiting goal's integration branch is then rebased onto fresh main before the task starts. |
| D31 | A claimed hard zone | **Queue the task; it starts on its own when the zone is released** | The goal's other tasks keep running. The feed and the holder are told someone is waiting. |
| D32 | A waited-on goal that never merges | **Unblock when it ends without a PR, or on "Stop waiting"** | It unblocks when that goal is aborted or failed, or 24h after it finishes with no PR, or when the waiting goal's owner clicks "Stop waiting". Every unblock is logged with its reason. |
| D33 | Drift outside declared touches | **Extend the lease and flag it; stop only in hard zones** | The lease widens, and the holder of the area plus the feed are told. Drift into someone else's hard zone interrupts the task until the zone frees up. |
| D34 | A predicted conflict | **Tell both owners and both orchestrators** | A feed item plus a phone alert to both owners with the files. Orchestrators see it at their next review. Nothing replans mid-task on its own. |
| D35 | Cadence | **On every task merge, plus every 5 min** | Push `refs/loom/wip/<member>/<run>` and run `git merge-tree --write-tree --name-only` against teammates' refs. Verified: GitHub accepts these refs and they trigger no CI. |
| D36 | When a lease is released | **When the goal's PR merges** (or the goal is abandoned) | After a task finishes, its leases are held as *landing*. D12's staleness still applies while the owner's laptop sleeps. |
| D37 | Where policy comes from | **`loom.team.json` on the default branch at origin** | Read with `git show origin/HEAD:loom.team.json`, so policy changes need a reviewed PR. A local copy can only make rules stricter. |
| D38 | What policy enforces in Phase 2 | **Hard zones, a permission ceiling (+ `bypassRequiresPlan`), an agent allowlist, protected-branch delivery, concurrency caps** | Caps: `maxParallelPerMember`, and `teamMaxConcurrentAgents` counted from hub presence. |
| D39 | A policy change mid-run | **Applies to new actions only** | Running tasks finish under the old rules; spawns, mode changes and deliveries use the new ones. Violations are noted in the feed. |
| **Build approach** |||
| D27 | Build before a live Supabase exists | **In-memory hub + real migrations** | The hub protocol is tested against an in-memory hub with two real daemons as two members; SQL, RLS and Edge Functions ship ready to deploy. |

## 2. The shape

```
 member A's Mac                      member B's Mac                 … members C–E
┌─────────────────────────┐        ┌─────────────────────────┐
│ loom daemon              │        │ loom daemon              │
│  orchestra · workers     │        │  orchestra · workers     │
│  local brain (log)       │        │  local brain (log)       │
│  Team Link ──────────────┼──┐  ┌──┼── Team Link              │
└───────────┬─────────────┘  │  │  └───────────┬─────────────┘
            │ git push/PR     │  │              │ git push/PR
            ▼                 ▼  ▼              ▼
     ┌─────────────┐   ┌──────────────────────────────┐
     │   GitHub    │──▶│  Loom Team Hub (Supabase)     │
     │ repo · PRs  │   │  Realtime: presence + feed    │
     │ merge queue │   │  Postgres: teams, members,    │
     │ Actions CI  │   │    leases, goals, brain log   │
     │ GitHub App ─┼──▶│    (ciphertext), cost rollups │
     └─────────────┘   │  Edge fn: GitHub webhooks     │
            ▲          └──────────────────────────────┘
            │ merge_group checks          ▲
            └──── CI/CD ──── deploy ──────┘ status fan-out
```

- **Member daemon** (exists today) keeps doing all agent execution, worktrees,
  credentials and fast tests. A new **Team Link** module speaks to the hub.
- **Team Hub** is a thin Supabase project, the same stack Loom Cloud already uses:
  - Postgres with row-level security per team;
  - Realtime Presence for liveness;
  - Realtime broadcast for the activity feed;
  - one Edge Function that receives GitHub App webhooks.
- **GitHub App**, one per team, with short-lived installation tokens. It is the
  only thing that talks to GitHub on the team's behalf; there are no shared PATs.

## 3. Identity, roles and policy

**Identity**
- Members sign in with **GitHub** (required, D4), or with Google plus a linked GitHub
  account, through Supabase Auth. Google sign-in exists today in the phone app.
- Each device generates an Ed25519 key. The hub stores the public key per
  `(member, device)`.
- Every event a daemon publishes is signed with it.

**The team key**
- A 32-byte **team key** encrypts content.
- **Joining (D5):** a one-time invite link (24h) carries the key in its `#fragment`,
  which is never sent to a server. It's the same pattern as phone pairing.
- **Rotation (D6):** removing a member mints a new key, sealed to each remaining
  device's public key (X25519 sealed box). Rotation is forward-only; history keeps
  its old key.

**Roles**

| Role | Can |
|---|---|
| owner | edit team policy, add/remove members, rotate the team key |
| member | run agents, take leases, open goal PRs, promote memory to canon |
| viewer | watch the feed and fleet, read canon |

**Policy lives in the repo**, as `loom.team.json`, so it's reviewed like code. An
optional org-level override sits above it that members can't loosen. This is the
committed-settings-plus-managed-overrides model Claude Code uses.

```jsonc
{
  "agents": { "allow": ["claude-code", "codex", "antigravity-cli", "grok-code"] },
  "permissions": { "ceiling": "auto", "bypassRequiresPlan": true },  // no bypass on main work without a plan
  "delivery": { "default": "pr", "protected": ["main"] },            // orchestras open PRs, never push main
  "orchestra": { "maxParallelPerMember": 6, "teamMaxConcurrentAgents": 20 },
  "memory": { "canonRequiresReview": true },
  "ci": { "autoFixAttempts": 2, "flakeRetries": 1 }
}
```

**Exists today, single-player:** per-agent permission modes (bypass, auto, ask),
real "always ask" approvals for Claude Code, the delivery policy (none, commit,
push, pr), and budgets with quarantine. Teams add a *ceiling* on top of these.

## 4. Presence and the team activity feed

Each daemon publishes a **heartbeat** every 15 seconds per active session, over
Realtime Presence:

```ts
{ member, device, project, goal?, task?, agent, kind, branch,
  touches: ["src/auth/**"],            // globs the task declared (§5)
  state: "planning" | "running" | "ci" | "review" | "waiting_human",
  intent: "add OAuth callback handler", since }
```

**Durable events** go to the feed as a broadcast plus a Postgres append:
- goal started or finished;
- plan written;
- lease taken or released;
- PR opened;
- check failed;
- memory proposed or promoted.

The GitHub App merges PR, check, review and merge events into the same feed, so
every member (and every orchestrator) reads **one timeline** for the team.

**UI.** The existing **Fleet** view, which shows every agent in every local project
with its thread and last step, grows a **Team** section:
- teammates' agents, read-only: who, which agent, which goal and task, which files,
  and state;
- their open goal PRs with check status;
- the lease map.

On the phone it's the same Fleet screen.

**Encryption.** Heartbeat content such as `intent` and `touches` is encrypted with
the team key. The hub relays it and cannot read it. Every client does its own
reasoning over the decrypted feed.

## 5. Work claiming: leases, not locks

Research is thin on the right lease size for a small team. The design therefore
leans on *advisory* leases plus *continuous* conflict detection, rather than hard
locks that deadlock.

**Taking a lease**
- When an orchestrator plans, each task declares what it will touch. This extends
  the existing `loom` action protocol:
  ```json
  {"type":"spawn","id":"t1","agent":"codex","prompt":"…","touches":["src/auth/**","test/auth/**"],"issue":"#212"}
  ```
- Before spawning, Team Link claims a **lease** per glob and per issue: a row with
  a unique constraint, a TTL of about 10 minutes, and renewal by heartbeat.
- File globs are **plaintext metadata** (D2), so the hub settles overlaps itself, in
  one Postgres transaction per claim. Glob overlap uses a normalized prefix match,
  with a conservative "may overlap" for wildcards. **Hard zones** (D10) are refused
  there. Everything else is returned as context.

**When a new plan overlaps someone else's lease**, the orchestrator gets it as
context in its planning turn: *"src/auth/** is leased by Priya's run o7x (claude,
'rotate session keys'), expires in 6 min."* It then does one of four things:
- **reorders:** depends on the other goal's PR and starts after it merges;
- **narrows** its tasks to avoid the area;
- **proceeds** (the overlap is small and it says why in the plan);
- **asks** the human. This uses the existing `ask` action and the waiting_human state.

**Continuous conflict detection.** Every running integration branch is pushed as
a work-in-progress ref, `refs/loom/wip/<member>/<run>`. Every few minutes each
daemon runs `git merge-tree` of its integration branch against teammates' WIP refs
and main.
- Predicted conflicts go to the feed and to the owning orchestrator, *while there
  is still time to coordinate*.
- This is the defence the 41.7% cross-agent conflict rate calls for.

**Hotspot affinity.** When one vendor's agent already owns a hot area, the
orchestrator is nudged to assign follow-up work there to the same vendor. Same-
vendor pairs conflict half as often.

## 6. Memory: one team brain, three tiers

**Exists today:** an append-only event log per project; memory units folded from
`memory_*` events with provenance (author agent); retrieval scoped by query; a
contradictions finder; memory import from each agent's native files (CLAUDE.md,
AGENTS.md, …); and projection back into them on handoff.

**Teams: the log becomes many logs**
- Each member's daemon owns a **signed, append-only stream**, encrypted with the
  team key and replicated through the hub, in a Postgres table of ciphertext rows.
- The team log is the **union** of the streams, ordered by hybrid logical clocks.
- A union of append-only streams can't conflict. Conflicts exist only in the
  *derived* memory, which is where they belong.

**Three tiers, with promotion as the safety valve.** This follows Devin's
suggest-and-approve flow.

| Tier | Written by | Read by | Durable home |
|---|---|---|---|
| **personal** | your agents | your agents | your stream |
| **proposed** | any member's agents | everyone's agents, trust-weighted | team log |
| **canon** | a *human* promotion | everyone's agents, first | **git**: `AGENTS.md` / `CLAUDE.md` Loom sections + `.loom/brain/canon.md` |

- **Canon lives in git.** Promotion opens a small PR, so team memory is
  code-reviewed and versioned. Agents outside Loom see it too, because AGENTS.md is
  the cross-vendor convention. Rolling back a bad memory is `git revert`.
- **Provenance on every unit:** member, agent, goal, task, and the source text it
  came from. Retrieval weights by tier, trust and recency.
- **Poisoning defence.** Units derived from *untrusted* input (issue or PR text,
  web pages, third-party code comments) are tagged. They are never auto-promoted,
  and they rank below team-authored units. Memory-poisoning attacks exceed 95%
  injection success in research, so this is not paranoia.
- **Contradictions surface; they don't win silently.** When two members' units
  disagree (for example "use zod for validation" against "use valibot"), the
  contradictions finder puts both in the feed with their provenance. A human picks
  one, and the loser is recorded as superseded, not deleted.
- **What every agent is briefed with**, in order:
  1. relevant canon;
  2. the **live team context** for the files its task touches: who else is working
     nearby, which PRs are open against those paths, and what failed recently;
  3. proposed units ranked by trust;
  4. personal units.

  Item 2 is what "agents see other teams' work" means in practice.

## 7. Branches, PRs and the merge path

```
worker branches (local only)          goal branch (pushed)          main
loom/orchestra/<run>/t1 ─┐
loom/orchestra/<run>/t2 ─┼─ merge ─▶ loom/orchestra/<run>/main ─▶ PR ─▶ merge queue ─▶ main
loom/orchestra/<run>/t3 ─┘   (exists today)     (delivery=pr exists today)
```

- **One PR per goal.** A goal too big for one review becomes a **stack** of 2–4 PRs
  cut along the plan's dependency graph (Graphite's model), each with its task spec
  files attached. The PR body is generated from `plans/<run>/PLAN.md` (exists
  today). Reviewers get the *why*, not just the diff.
- **Pre-queue pushrebase-lite.** Before a goal PR enters the queue, the daemon:
  1. rebases the integration branch onto fresh main;
  2. re-runs the fast local test set;
  3. pushes.

  This is Meta's server-side pushrebase idea, done client-side.
- **GitHub merge queue by default**, with required checks on `merge_group`. A queue
  whose checks don't run on `merge_group` waits forever; Loom's setup doctor checks
  for this. Teams that outgrow it can use Mergify scopes or Aviator affected-targets
  to split the queue by path, so a failure in `web/` doesn't stall `api/`.
- **Agents never approve or merge.** They can *review*: a teammate's configured
  reviewer agent posts a pre-review on every goal PR (AO's auto-reviewer). The human
  CODEOWNER still approves, and merging is the queue's job.
- **Commit trailers make every line traceable:**
  ```
  Co-Authored-By: codex <codex@loom.local>
  Loom-Member: priya
  Loom-Goal: o7x2k
  Loom-Task: t3
  ```

## 8. CI/CD

1. **Checks come back to the owner.** The GitHub App relays check runs to the hub.
   The daemon that owns the goal (identified by the branch) receives the failure,
   and its orchestrator starts a **bounded auto-fix loop**: the failing check's log
   tail goes to the worker that owns the files, as a follow-up with the `send`
   action (exists today).
   - At most `autoFixAttempts` tries (default 2), each a new commit.
   - After that, the goal waits on a human.
2. **Flakes are classified before they are blamed.** Re-run once. Check the test's
   pass rate on main over the last N runs. A likely flake is labelled rather than
   "fixed" by an agent rewriting a test. Trunk's pending-failure-depth idea applies
   to the queue itself.
3. **No agents in CI with secrets.** Fix loops run on the member's machine, where
   credentials already are. Any CI-side agent gets read-only permissions, OIDC
   tokens instead of stored secrets, and sanitized input. "Comment and Control"
   (2026) exfiltrated keys through a PR *title*.
4. **Workflow runs on agent branches need a trusted member identity.** Otherwise a
   human approves them, as GitHub does for its Copilot agent.
5. **Deployments.** GitHub Environments with required reviewers stay the gate. Loom
   shows deploy status in the feed and on the phone, and writes release notes from
   the merged goals' PLAN.md results.
6. **CI cost is attributed to the goal** through its PR's check runs (§10).

## 9. A day with five people

**09:10** Aisha starts a goal from her phone: *"add Google sign-in to the web app"*.
Plan mode is on.
- Her orchestrator (Claude) plans 4 tasks.
- Team Link leases `web/src/auth/**`, `api/routes/session.ts` and issue #212.
- `plans/o1/PLAN.md` lands on her goal branch.

**09:12** Ben asks his orchestrator (Codex) to *"refactor the session store to
Redis"*.
- His plan wants `api/routes/session.ts`.
- The planning turn is told the file is leased by Aisha's o1 until about 09:22,
  with her intent line.
- Codex makes its task depend on o1's PR, starts the unrelated tasks now, and says
  so in its plan.
- Ben sees the decision in his thread. Aisha sees "Ben's o2 is waiting on your o1"
  in the feed.

**09:40** The merge-tree check predicts a conflict between Aisha's
`web/src/auth/button.tsx` and Chen's design-system goal (o3).
- Both orchestrators are told.
- Chen's orchestrator narrows its task to leave `button.tsx` alone and adds a
  follow-up task that depends on o1.

**10:05** Aisha's goal PR opens with the PLAN.md-derived description.
- Dev's reviewer agent (Grok) posts a pre-review.
- Aisha's CODEOWNER, Emma, approves on her phone.
- The PR enters the merge queue.

**10:20** `merge_group` CI fails in `api/`.
- The check is relayed to Aisha's daemon.
- Her orchestrator sends the log to the worker that owned `api/routes/session.ts`.
- Attempt 1 fixes it, and the queue retries.
- Merged at 10:31.
- Ben's o2 was waiting on it. Its dependent task starts on its own, on top of
  fresh main.

**10:35** Aisha's agents learned *"session cookies must be SameSite=Lax because of
the OAuth redirect"*.
- It's a proposed unit with full provenance, so everyone's agents working near
  `auth/` see it in their briefings immediately.
- Emma promotes it to canon. A one-line PR to `AGENTS.md` merges, and now every
  agent, in or out of Loom, knows it.

## 10. Cost, budgets and fairness

- Every agent event already carries tokens, and cost where the vendor reports it.
  Teams tag each event with member, goal and task, then roll up:
  - per member and day;
  - per goal;
  - per *landed PR*, which counts the real cost including abandoned goals;
  - CI minutes per goal.
- Budgets exist today per agent and per day. Teams add per-member caps, a team-wide
  **concurrent-agent cap** (Jules-style concurrency tiers), and a per-goal ceiling
  that pauses a run before it overspends.

## 11. What runs where

| Local (member daemon) | Hub (Supabase) | GitHub |
|---|---|---|
| all agent execution, worktrees, code | presence, feed relay | code, PRs, reviews |
| credentials, secrets | lease table (HMAC keys) | merge queue |
| fast tests, pushrebase-lite | encrypted brain streams | Actions CI/CD, environments |
| brain folding, retrieval, briefing | goal index, cost rollups (metadata) | CODEOWNERS |
| conflict prediction (`merge-tree`) | GitHub webhook receiver | the team's GitHub App |
| approvals UI (desktop and phone) | auth, device keys | |

Optional later: **cloud sandboxes** per goal, so a goal can keep going while its
owner's laptop is closed, or so CI-triggered fix jobs run without a member online.
This is a separate trust tier with its own secrets model, which is how AO cloud,
Cursor background agents and Codex cloud do it. Not in v1.

## 12. Failure modes → mitigations

| Failure | Mitigation |
|---|---|
| PR flood / review bottleneck | one PR per goal; stacks for big goals; reviewer-agent pre-review; PLAN.md as the PR description |
| cross-vendor merge conflicts | leases at plan time; continuous `merge-tree` prediction; hotspot vendor affinity |
| duplicated work | issue leases; team feed in planning context |
| semantic conflicts (clean merge, broken main) | merge queue tests the merged result; pushrebase-lite before queueing |
| flaky CI stalling the queue | flake classification; one retry; failure-depth tolerance; queue scopes |
| secrets exfiltrated via prompt injection | no agents with secrets in CI; OIDC; untrusted-input tagging; "ask" mode for risky tools |
| poisoned or stale memory | tiers; human promotion; provenance; canon in git behind review |
| runaway cost | per-member, per-goal and team caps; concurrency cap; cost per landed PR |
| "who did this?" | signed event log; commit trailers; approvals recorded as events |
| an orchestrator deadlocked on someone else's lease | leases expire; the orchestrator can reorder, narrow, proceed-with-reason or ask |

## 13. Build plan

**Phase 1: see each other.** Built per D27. Status on 2026-09-18:

| Piece | Status |
|---|---|
| Team crypto: team key, sealed boxes, Ed25519 signatures, invite fragments (`src/core/team-crypto.ts`) | ✅ built, tested |
| Hub protocol plus reference hub (`src/core/team-hub.ts`: `HubClient`, `MemoryHub`) | ✅ built, tested |
| Self-hosted hub: `loom hub` server plus `HttpHubClient` (`src/hub/`) | ✅ built, tested over real HTTP + WebSocket |
| Team Link in the daemon (`src/daemon/team.ts`): sign-in, create, invite and join, forward rotation, opt-in sharing plus remote auto-match, heartbeats (intent only), goal feed, `gh` polling fallback | ✅ built; two members tested end to end |
| Hosted-hub SQL (`supabase/migrations/0002_teams.sql`): tables, RLS, rule functions, Realtime | ✅ built; tested against a real Postgres 16 as the `authenticated` role |
| Commit trailers on worker commits (`Loom-Goal`, `Loom-Task`, `Loom-Agent`, `Loom-Member`) | ✅ built, tested |
| CLI: `loom hub`, `loom team [signin/create/invite/join/share/unshare/remove/leave]`; REST `/api/team/*` | ✅ built, tested |
| Team section in Fleet (desktop and phone), Team settings | 🔨 in progress |
| Hosted client: `SupabaseHubClient` + GitHub OAuth loopback sign-in | ⏳ waits for a live Supabase project, so it's tested for real rather than written blind |
| GitHub App manifest flow + webhook Edge Function (D7) | ⏳ with the hosted client; until then the `gh` polling fallback covers PRs and checks |

The original Phase 1 plan:
- Team Hub schema:
  - `teams`, `members`, `devices` and `team_keys`;
  - `presence` over Realtime;
  - `feed` in Postgres plus broadcast.
- Team Link: sign in, join a team by invite, publish heartbeats, subscribe to the feed.
- Team section in the Fleet view, desktop and phone.
- GitHub App: webhook to Edge Function to feed (PRs, checks, reviews).
- `delivery: "pr"` as the team default (exists today), plus commit trailers.

**Phase 2: stop colliding.** Built per D28–D39. Status on 2026-09-19:

| Piece | Status |
|---|---|
| Lease scopes, overlap and hard zones (`src/core/team-leases.ts`) | ✅ built, tested (including `**/*.test.ts` vs `src/auth/**`) |
| Team policy `loom.team.json` from origin, local-only-stricter (`src/core/team-policy.ts`) | ✅ built, tested |
| Hub leases: claim, extend, renew, landing, release; atomic hard-zone arbitration | ✅ MemoryHub + `loom hub` + SQL (`0003_team_leases.sql`, tested on Postgres 16) |
| Orchestra holds (decide, wait, zone, capacity), `overlap` decisions, rebase before a wait, pause on drift, "Stop waiting" | ✅ built, tested |
| Team coordinator (`src/daemon/team-coordinator.ts`): admission, drift, WIP refs, `merge-tree` prediction, lease lifecycle | ✅ built; two members tested end to end on a real bare origin |
| Policy enforced: permission ceiling, agent allowlist, protected-branch delivery, concurrency caps | ✅ built, tested |
| UI: holds on task cards, lease list, new feed sentences, policy panel (desktop and phone) | 🔨 in progress |

The original Phase 2 plan:
- `touches` in the orchestra protocol; lease claims and renewals; lease context in
  planning turns.
- WIP refs and periodic `merge-tree` prediction, reported into the feed and to
  orchestrators.
- `loom.team.json` policy: agent allowlist, permission ceiling, delivery rules,
  concurrency caps.

**Phase 3: one brain (3 weeks)**
- Signed per-member streams, encrypted replication, HLC union.
- Personal, proposed and canon tiers; promotion flow; canon export to AGENTS.md
  through a PR.
- Untrusted-input tagging; trust-weighted retrieval; the team-context block in
  briefings.

**Phase 4: land safely (2 weeks)**
- Merge-queue integration (`merge_group` doctor check); pushrebase-lite; stacked
  goal PRs.
- The check relay drives the orchestrator's bounded auto-fix loop; flake
  classification.
- Cost rollups per member, goal and landed PR; team budgets.

**Phase 5 (optional): cloud sandboxes** for away-from-keyboard goals.

## 14. What Loom already has that this builds on

- **Orchestra** (`src/core/orchestra.ts`): one orchestrator and many parallel
  workers, a task graph, worktrees, an integration branch, review rounds, `send` for
  follow-ups.
- **Plan mode:** `plans/<run>/PLAN.md` plus one spec per task that any agent can
  execute.
- **Git delivery:** none / commit / push / pr, with PRs opened through `gh`.
- **Permissions and approvals:** bypass / auto / ask per agent, with real approval
  routing for Claude Code, all verified against the real CLIs.
- **Fleet view:** every agent's thread, task and last step.
- **Brain:** event log, memory units, contradictions, and import/projection into
  each agent's native memory files.
- **Loom Cloud:** a Supabase Realtime relay, end-to-end encrypted, and Google
  sign-in. The hub reuses the same project and keys model.

## 15. Sources

**Reviews, AI-authored code and PR volume**
- DORA 2025: https://cloud.google.com/blog/products/ai-machine-learning/announcing-the-2025-dora-report
  and https://redmonk.com/rstephens/2025/12/18/dora2025/
- AI vs human PR defects (CodeRabbit): https://www.coderabbit.ai/blog/state-of-ai-vs-human-code-generation-report
- Agent PR volume (secondary sources): https://www.danilchenko.dev/posts/2026-04-11-github-ai-agents-pull-requests/

**Conflicts and keeping main green**
- Concurrent agent PR conflicts: https://arxiv.org/abs/2607.04697
- Semantic conflicts: https://dl.acm.org/doi/10.1145/3546944 and https://arxiv.org/pdf/2310.02395
- Uber SubmitQueue: https://www.uber.com/blog/research/keeping-master-green-at-scale/
- Meta Sapling (pushrebase): https://github.com/facebook/sapling

**Merge queues**
- GitHub merge queue: https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/managing-a-merge-queue
- Graphite stack-aware queue: https://graphite.com/blog/the-first-stack-aware-merge-queue
- Mergify scopes: https://docs.mergify.com/merge-queue/scopes/
- Aviator affected targets: https://docs.aviator.co/mergequeue/affected-targets
- Trunk anti-flake protection: https://docs.trunk.io/merge-queue/concepts-and-optimizations/anti-flake-protection

**Agent platforms**
- Copilot coding agent: https://docs.github.com/en/copilot/concepts/agents/coding-agent/about-coding-agent
  and https://github.blog/news-insights/company-news/welcome-home-agents/
- Codex cloud environments: https://developers.openai.com/codex/cloud/environments
- Jules: https://jules.google/
- Cursor cloud agents and rules: https://cursor.com/docs/cloud-agent and https://cursor.com/docs/rules
- Factory audit: https://docs.factory.ai/enterprise/compliance-audit-and-monitoring
- Claude Code settings and GitHub Actions: https://code.claude.com/docs/en/settings
  and https://code.claude.com/docs/en/github-actions
- Agent Orchestrator: https://github.com/Untrivial-ai/agent-orchestrator

**Memory**
- Devin Knowledge: https://docs.devin.ai/product-guides/knowledge
- AGENTS.md: https://agents.md/
- Cline Memory Bank: https://docs.cline.bot/best-practices/memory-bank
- Memory poisoning: https://arxiv.org/html/2601.05504v2

**Security**
- Comment and Control / prompt injection in CI: https://venturebeat.com/security/ai-agent-runtime-security-system-card-audit-comment-and-control-2026

**Where the evidence is thin:** there is no rigorous data on duplicated work or on
the right lease size for 2–10 people. Vendor speed-up figures (Graphite, Jules,
Mergify) are self-reported. The PR-volume figures come from secondary blogs.
Memory-poisoning is demonstrated in research, not in reported team incidents.
Agent Orchestrator's cloud internals are inferred from its issue titles. The lease
design above is deliberately advisory and cheap to tune for exactly this reason.
