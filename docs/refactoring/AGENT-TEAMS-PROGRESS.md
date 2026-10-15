# Agent Teams implementation and Windows audit

User scope confirmed on 2026-10-15: finish Windows reliability, then implement
Agent Teams P2–P5 in separate reviewable PRs. Humans merge the PRs. Hosted
acceptance and trusted signing issues remain open when external access is missing.
The feature contract is [agent-teams.md](../proposals/agent-teams.md).

## Windows foundation — PR #218

Native Job Object containment, OpenCode 1.19 protocol parity, contained spec runs
and dev servers, IPv6 localhost readiness, and source installation checks are
implemented. Real Codex/OpenCode sequential native resume across an OS daemon
restart, parallel Orchestra, and the sequential Ship crew passed on Windows.

The audit found a native race in node-pty 1.1.0 during simultaneous terminal
exits. The dependency is pinned to 1.2.0-beta.15, containing upstream #922. The
DLL backend also leaves its output worker alive after public `onExit` (#887);
Loom now drains that connection with a compatibility bridge for the pinned
version, awaits shutdown, and ignores stale terminal callbacks after id reuse.
45 ConPTY checks and 42 pipe checks passed; a standalone terminal process exits
normally; production staging verifies Job Objects and ConPTY execution/shutdown.
The full CI matrix must pass on the current Windows PR head before approval.

Automatic approval review rejected launching the packaged desktop UI. Do not
retry that launch. The packaged daemon has CLI acceptance evidence. Installers
are unsigned, and current desktop UI acceptance remains incomplete.

## P2 — persistent teammates

Branch: `feat/crew-persistent-teammates`, stacked on the Windows PR.

- [x] Native binding per seat, delta on the second card.
- [x] Stable checkout across goals, distinct goal branches.
- [x] Graceful mid-goal restart resumes the binding; uncertain actions require
  explicit receipt reconciliation before replay.
- [x] Explicit teammate refresh starts a new epoch.
- [x] Crew memory scope, retrieval isolation and human promotion to project memory.
- [ ] Native fake acceptance, HTTP route checks, regression/DOM checks and CI.

Local validation: build/typecheck passed; native restart/delta/recovery tests
passed (3), crew/memory HTTP and the Crew DOM acceptance passed, and the existing
crew/brain regressions passed. Full CI remains a separate release gate.

## P3 — parallel and safe

- [ ] Builder worktrees and in-crew leases, with overlap holds and resolution.
- [ ] Race and Fan-out plays reuse Orchestra/worktree mechanisms.
- [ ] Merge-tree prediction before integration; conflicts return to the owner.
- [ ] Explicit reviewer/tester results; absent protocol output cannot approve.
- [ ] Stop and test timeout quiesce all tool descendants on Windows.
- [ ] Overlap, conflict, stop, race and fan-out integration tests.

## P4 — several people

- [ ] Crew/teammate metadata in presence and Fleet, without transcript sharing.
- [ ] Cross-member requests with owner acceptance/decline.
- [ ] Runner-hosted crews, policy limits and role permission ceilings.
- [ ] Per-crew/member/goal budget accounting and visible budget holds.
- [ ] Two-member overlapping work acceptance using the existing hub harness.
- [ ] No hosted migration or landing/merge-policy changes without owner approval.

## P5 — usable from desktop and phone

- [ ] Templates, roster/state/context/spend and board lane.
- [ ] Phone Crew sheet: start goal, approve plan, watch cards, pause/resume/stop.
- [ ] Meaningful notifications, native refresh/recovery and docs.
- [ ] HTTP, DOM and phone model checks; build and complete CI.

## Separate open issues

- #200: phone currently selects Google while hosted Auth enables GitHub. Code
  parity can be fixed locally; redirect allow-list and phone acceptance need
  hosted/admin and device access.
- #199: public read-only links require dedicated authorization, viewer,
  expiry/revocation and hosted acceptance; paired encrypted relay is not public sharing.
- #70: trusted signing certificates and installed release-to-release acceptance.
- #215 stays open until every phase's acceptance criteria are met.
