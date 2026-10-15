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
All ten CI jobs passed on Windows PR head bd64d26.

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
- [x] Native fake acceptance, HTTP route checks, regression/DOM checks and CI (all ten jobs on 2cb501b).

Local validation: build/typecheck passed; native restart/delta/recovery tests
passed (3), crew/memory HTTP and the Crew DOM acceptance passed, and the existing
crew/brain regressions passed. Full CI remains a separate release gate.

## P3 — parallel and safe

- [x] Builder worktrees and in-crew leases, with overlap holds and resolution.
- [x] Race and Fan-out plays reuse Orchestra/worktree mechanisms.
- [x] Merge-tree prediction before integration; conflicts return to the owner.
- [x] Explicit reviewer/tester results; absent protocol output cannot approve.
- [x] Stop and test timeout quiesce all tool descendants on Windows.
- [x] Overlap, conflict, stop, race and fan-out integration tests.

Local validation: build/typecheck passed. Nine parallel-flow checks and the
existing crew/HTTP suites passed (24 checks). Orchestra, native continuity and
Crew DOM acceptance passed (30 more checks). Native fan-out holds two distinct
workspace receipts and integrates both results. All ten CI jobs passed on P3 head 7e1b326; the corrected POSIX fixture retains detached-child coverage on Windows.

## P4 — several people

- [x] Crew/teammate metadata in presence and Fleet, without transcript sharing.
- [x] Cross-member requests with owner acceptance/decline.
- [x] Runner-hosted crews, policy limits and role permission ceilings.
- [x] Per-crew/member/goal budget accounting and visible budget holds.
- [x] Two-member overlapping work acceptance using the existing hub harness.
- [x] No hosted migration or landing/merge-policy changes without owner approval.

## P5 — usable from desktop and phone

- [x] Templates, parallel seat activity, native epochs, per-seat/goal/daily spend, and crew metadata on the shared board.
- [x] Phone Crew view: start/approve/watch, pause/resume/stop, race selection, refresh, budget and team/runner controls.
- [x] Crew deep links and notifications for budget/lease holds, race choices and incoming owner requests; docs.
- [x] Build/typecheck, HTTP, four Crew DOM flows and 76 phone model checks.
- [ ] Complete exact-head CI and physical native phone acceptance. Browser mobile layout inspected at 390x844; it does not establish native-device acceptance.

P5 local evidence: 96 existing board/shell/team regressions and 24 cost/crew/parallel checks passed. Four Crew
DOM flows cover planning/approval/apply, Stop/Resume, Race/pick/play/pause, and
parallel-seat/owner-request/runner-control UI. Both app and daemon compile.
Mechanical UI scan is clear; desktop and phone browser layouts inspected.

## Separate open issues

- #200: PR #224 aligns phone GitHub sign-in and validates PKCE callbacks.
  Hosted redirect allow-list and physical phone acceptance still need
  hosted/admin and device access. The issue stays open.
- #199: public read-only links require dedicated authorization, viewer,
  expiry/revocation and hosted acceptance; paired encrypted relay is not public sharing.
- #70: trusted signing certificates and installed release-to-release acceptance.
- #215 stays open until every phase's acceptance criteria are met.
