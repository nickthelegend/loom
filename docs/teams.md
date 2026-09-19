# Loom Teams: a user's guide

Several people, each with their own agents, on one GitHub repo. This guide is
the how-to; [teams-architecture.md](teams-architecture.md) has the why.

## 1. Set up a team

```bash
loom team signin                  # the hosted hub, with your GitHub account
#   or a self-hosted hub:  loom hub --host 0.0.0.0 --secret <s>   (on one machine)
#                          loom team signin http://<host>:7430 --secret <s>
loom team create "Acme"
loom team invite                  # a one-time link — it carries the team key; send it like a password
loom team join '<link>'           # on a teammate's machine
loom team share                   # in a project: its GitHub repo is now shared with the team
```

No browser on the machine? `loom team signin --paste` prints a link to open
anywhere and asks for the address you land on.

## 2. See each other (Phase 1)

`loom team` shows who is running what, right now: agents, goals, branches and
the files each task declared, plus a feed of goals, plans, PRs and CI. You see
your teammates' intent (goal and task titles), never their prompts or
transcripts. Content is encrypted to the team; the hub can't read it.

## 3. Don't collide (Phase 2)

On a shared project every orchestra task declares the files it will `touch`.
When a teammate's goal already holds some of them, the orchestrator must decide
before the task starts: wait for their PR, narrow, or proceed with a reason the
team sees. `loom.team.json` on your default branch holds the team's rules:

```jsonc
{
  "hardZones": ["db/migrations/**", "package-lock.json"],    // one goal at a time
  "permissions": { "ceiling": "auto", "bypassRequiresPlan": true },
  "agents": { "allow": ["claude-code", "codex"] },
  "delivery": { "protected": ["main"], "stack": "auto" },
  "orchestra": { "maxParallelPerMember": 6, "teamMaxConcurrentAgents": 20 },
  "landing": { "fastTest": "npm test -- --changed", "timeoutMin": 10, "autoFixAttempts": 2 },
  "review": { "enabled": true, "maxRuns": 3 },
  "budgets": { "perGoalUsd": 15, "perMemberDailyUsd": 60 },
  "runners": { "shared": true, "permissions": "bypass" }
}
```

Changing it takes a reviewed PR; a local copy can only make it stricter.

## 4. One brain (Phase 3)

What one member's agents learn reaches everyone's briefings, labelled by how
sure to be: team canon, confirmed by 2+, your own, a teammate's proposal.
`loom team brain` shows the team's memories and an inbox of contradictions,
duplicates and corrections. `loom team brain promote <id>` proposes a memory as
canon: it goes into `AGENTS.md` on one rolling `loom/canon` PR, reviewed like
code, and then every agent reads it, Loom or not.

## 5. Land safely (Phase 4)

Deliver goals as PRs (`git.delivery: "pr"`). Your daemon then watches them:

- a failing required check is rerun once; a pass on rerun is labelled flaky;
- a real failure goes back to the goal's agents, who fix it on the same PR
  (twice at most, then your phone buzzes);
- an agent from a different vendor reviews the PR and posts `loom/review`;
- `loom land` (or the Land button) merges fresh main in, runs the fast tests,
  pushes, and asks GitHub to merge when approvals and checks pass.

`loom team doctor` checks the repo for merge-queue traps and offers a fix PR.
`loom team landing` lists goal PRs, and teammates' goals that need someone:
`loom team adopt <pr>` takes one over and hands it back when it's green.

### Phase 6: landing in turn, and hearing GitHub at once

**No merge queue? Land still lands one at a time.** On a repo without GitHub's
merge queue, Land joins Loom's landing train. Each goal waits for its lane,
then takes its turn: fresh main merged in, the fast tests, a push, green checks
on that exact commit, then Loom merges it (`gh pr merge --squash`). The next goal
in the lane goes after that, on top of it. A goal in the queue shows **queued**
("waiting behind bob's goal in lane api"). If a check fails on its turn, the lane
moves on to the next goal, and yours rejoins by itself once it's green again.

Lanes are path scopes. Goals in different lanes land at the same time; a goal
that touches two lanes waits for both. With no lanes, everything shares `main`.

```jsonc
// loom.team.json
{ "landing": { "fastTest": "npm test -- --changed",
               "lanes": { "web": ["web/**"], "api": ["api/**", "db/**"] } } }
```

With a merge queue on the branch, Land works as in Phase 4: GitHub's queue does
this job.

**Webhooks: CI results the moment they happen.** Without them, Loom learns
about PRs and checks by polling `gh` (every 30–60 s). A repo webhook pushes them
to the hub instead, and your daemon reacts to a failed check or a merge right
away. Team owners set it up once per repo:

```bash
loom team webhook                     # prints the payload URL and the secret
loom team webhook --install           # or creates the webhook with gh (needs repo admin)
loom team webhook --rotate            # new secret; update the repo's webhook after
```

A self-hosted hub must be reachable from GitHub for this (a public host or a
tunnel). The hosted hub receives webhooks through a Supabase Edge Function.
Polling keeps running either way, and nothing shows up twice.

## 6. Runners (Phase 5)

A runner is your own always-on Loom (a VPS, a home server, a container) that
takes your goals while your laptop sleeps.

```bash
loom runner pair                     # on your laptop: a one-time link (it carries your team keys)
loom runner join '<link>'            # on the box — then keep it up: loom runner install
loom runner token github_pat_…       # a fine-grained token: contents + pull requests on the shared repos
loom runner doctor                   # checks the token isn't broader than that
loom runner goal "Add rate limiting" # start a goal there
loom runner move <runId>             # move a running goal; `loom runner back <runId>` brings it home
loom runner jobs                     # runners and what they're doing
```

Or run it in Docker: `docker build -f Dockerfile.runner -t loom-runner .`

Each goal gets a fresh clone (a fresh container when Docker runs), and agents
get a scrubbed environment with only their logins and the token. If a goal of
yours needs a CI fix and you've been offline 15 minutes, your runner takes it.

## 7. Deploys and release notes

`loom team deploys` lists deployments; results show in the team feed, and a
failed deploy containing your goal alerts your phone. `loom team
release-notes v1.2.0` writes notes for everything merged since that tag,
grouped by member. GitHub Environments stay the deploy gate: Loom never deploys.
