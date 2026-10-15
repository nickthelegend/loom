# Native Brain continuity

The deterministic implementation is **opt-in**. This guide describes what works
now; it does not claim every milestone in the [approved plan](proposals/brain-continuity-implementation.md)
is finished. Release gates and results are in [BRAIN-TODO](refactoring/BRAIN-TODO.md)
and [BRAIN-NOTES](refactoring/BRAIN-NOTES.md).

## Enable and switch

Enable **Native context continuity** in Settings → Preferences, or set
`brain.continuity: true` in `.loom/config.json`. Finish/reconcile active turns and clear queued prompts before
changing modes. The default remains the legacy workflow.

Select Codex, Claude Code or OpenCode in an ordinary chat. The next request captures its
target/model. Requests sent during another foreground turn queue until it finishes;
later picker changes do not retarget them. Explicit handoff/Stop interrupts, waits
for process close, and refuses unproven quiescence. Preparing turns can also be stopped.

| Capability | Current support |
| --- | --- |
| Codex | Any installed version; `codex app-server`, explicit `thread/resume`; context in ordinary turn input (stdin, no argv limit). Acceptance is the `turn/start` response or `turn/started`. |
| Claude Code | Any installed version, driven through the Claude Agent SDK; explicit resume by session; context in the ordinary user message (stdin). Acceptance is the `requesting` status or the first output. |
| Lost native session | A resume that finds no session fails before any turn starts. The adapter reports `NativeSessionMissing`; the receipt fails and the binding moves to a new epoch, so the next packet reconstructs into a fresh session. |
| Harness health | Each native CLI is probed with `--version` every 20 s and before dispatch. An unreachable CLI refuses the turn before the request is recorded. Status reports `available` and `cliVersion`; transitions are logged. Protocol drift appears as missing acceptance evidence, never as success. |
| Per-chat model | Supported. Changing the model keeps the same native session (Codex and Claude accept a model on resume; OpenCode switches the session's model in place); other configuration changes select a new binding. |
| OpenCode | Driven over `opencode serve`'s HTTP API (verified on 1.18.31); explicit resume by session; context in the ordinary prompt. Acceptance is the prompt's admission; the turn is over, and quiescent, when `/api/session/active` no longer lists the session. A session the server no longer has fails before anything is sent, and the next packet rebuilds in a new one. An agent pointed at a running server (`baseUrl`) is probed by that server's health. |
| Bridges | Native continuity unsupported; legacy workflow available. |
| Parallel subagents/orchestra | Unsupported in this sequential mode. |
| Embeddings/inference/cheap helpers | Not loaded or launched by this mode; helpers disabled. |
| Attachments | Existing `[image]`/`[file]` upload protocol rejected; ordinary workspace references usable. |
| Native compaction | Every harness reports it: Claude as `status: compacting` then `compact_boundary`, Codex as a `contextCompaction` item, OpenCode as `session.next.compaction.started`/`.ended`. The binding is marked compacted, and the next packet rebuilds reviewed state and recent history into the same resumed session. The UI shows compaction while it runs, and the context in use against the model's window. No private transcript modifications. |

Checked fixtures are not live account validation on every listed version or
cross-platform packaging certification.

## Context and storage

One ordinary foreground request contains an origin-labelled historical block and
the current request once. What the block carries depends on the target session:

- **Resumed session (delta).** The native session already holds everything earlier
  packets gave it and its own turns. It receives only what it lacks: user messages
  sent to another agent meanwhile, other agents' work since its last turn, and
  reviewed items if they changed. Returning after a short detour costs roughly the
  size of that detour, not the conversation.
- **New or compacted session (reconstruction).** Current reviewed items, the most
  recent user messages exactly, one-line headlines for older user messages (full
  text in a local evidence file) and recent observations, all within the target.

A request becomes conversation history only once it may have reached a harness.
Queued, overflowed or refused requests are not shown to other turns. Discussion is not automatically accepted
as a decision; agent claims are not automatically verified work. Corrections carry
revision/supersession and source references. Small user points never depend on top-K.

Canonical originals remain in `.loom/log.db` on EventLog's existing connection.
Brain adds versioned requests, native bindings, items/revisions/dispositions, packets,
receipts and FTS5 projections with lexical fallback. There is no second canonical
database or vector service. Writes retain the synchronous owner semantics; worker
isolation is a measured follow-up, without `Atomics.wait` or memory-only acknowledgements.

Source references include project, event ID, SHA-256 and validated UTF-8 spans.
Packets, rendered text/hashes and receipts are separate immutable/transitioned records.
Native IDs are scoped to chat, agent instance, workspace, compatibility fingerprint
and epoch. Ambiguous legacy instance IDs are neither adopted nor overwritten.

App packet assembly prevents cross-chat injection. A native coding harness with
project filesystem access can still inspect other local files; application scoping
is not a sandbox isolating private chats from a trusted local agent.

## Budgets and checkpoints

The default target is **6,000 estimated turn-input tokens**, including the current
request and app-added context, estimated from UTF-8 bytes / 3,
rounded up. This is a heuristic, not a provider tokenizer or verified native capacity.
Native history, tools, output and provider caching affect usage outside
that estimate. The wire field retains its v1 name `estimatedAddedTokens`. Resuming a native session does not imply free or unlimited context.

Priority is: reviewed items and the current request, then user messages (exact
newest-first up to about 75% of the target, then headlines), then observations.
Nothing is dropped silently: each source is recorded as exact, summarized
(reviewed checkpoint), referenced (headline plus evidence file) or omitted.
Omitted observations are reconsidered by the next delta. Overflow now occurs only
when reviewed items plus the current request exceed the target. It saves the
request/packet without starting a coding turn. The review dialog
lets you increase the target or create a reviewed checkpoint from selected originals,
then resume the saved request. Increasing the target can consume more quota and
still exceed native capacity. Exact restrictions and unresolved questions belong in
the checkpoint; the app does not certify your summary's fidelity.

Original checkpoint evidence is accessible as content-addressed local JSON under
`.loom/brain/artifacts/`. It is flushed and atomically finalized before reference.
Submission checks integrity and rejects unsafe paths. Unreferenced crash artifacts
are retained for now; automatic GC/deletion/retention remains a release gate.

Checkpoints can be created or changed only while no agent turn is running, so a
running agent cannot forge user-reviewed context through the local API.

Protocol limits: 4 MB serialized contract input, nesting depth 32, 1 million
characters per text field, 1 MB rendered context, 10,000 protected messages/items,
1,000 item sources, 32 MB native JSONL records/retrieval artifacts, 100 MB offline JSONL imports, and
an explicitly chosen added-context target of 128–100,000 estimated tokens.
Exceeding limits produces an error/overflow instead of silent truncation.

## Delivery and recovery

`prepared` means stored; `submitting` means durable intent to call the harness.
`accepted` requires correlated native turn/output evidence, not spawn or initialization.
Execution is separately `running`, `complete`, `failed`, `interrupted` or `unknown`.
A provider error may arrive before process exit; it does not release the runtime
writer barrier early. Accepted does not mean understood or retained.

After restart/lost acknowledgement, uncertain runs keep their workspace lease.
Inspect native processes and changed files, then explicitly reconcile with evidence.
Reconciliation clears the lease and increments the binding epoch; it does not replay
the action. Reconciliation is atomic with binding invalidation and cannot be repeated
on a resolved receipt. Retry is a new deliberate request. Failed stops block successors.

Native POSIX launches own a process group. Parent exit starts inherited-child cleanup;
completion waits for containment and output drain. Unknown termination retains the
writer lease. Escaped/detached children are not fully contained; inspect them during
manual recovery. Windows native harnesses launch inside kill-on-close Job Objects;
the launch handshake completes containment before any harness or tool can start.
Shutdown verifies zero job members, and failed inspection retains the writer lease.
The daemon probes assignment on the current host (including enclosing jobs) before
enabling native continuity. OpenCode supports both the legacy `/api/session` API
and npm 1.19.0's `/session/:id/prompt_async` admission and `/session/status` idle proof.
App-owned diff/commit work also finishes before the next native turn starts.

The Brain pane lists the latest 100 attempt summaries and loads individual full
packets on demand. Project-authenticated routes under
`/api/projects/:id/brain/continuity` are:

| Method/path | Purpose |
| --- | --- |
| `GET /?requestId=...` | Bounded attempt summaries, counts, estimates and outcomes. |
| `GET /packets/:packetId` | One packet and exact rendered text/hash. |
| `GET /source/:eventId?chat=...` | Scoped original text/source hash. |
| `GET /items?chat=...`, `POST /items` | Reviewed `ContextItemV1` records. |
| `POST /checkpoint` | `{chat,itemId,eventIds,reviewed:true}`; atomic full-source dispositions. |
| `POST /requests/:requestId/resume` | `{targetAddedTokens}`; rebuild an unsubmitted overflow/preflight request. Submitted requests cannot be replayed here. |
| `POST /search/rebuild` | `{}`; rebuild FTS transactionally from canonical events. |
| `POST /reconcile` | `{receiptId,evidence,quiescent:true}`; explicit uncertain-run reconciliation. |

`POST /api/projects/:id/messages` accepts `requestId`. Same ID/content/target does
not append/execute twice; different content is a conflict. Captured queued text,
target and model are immutable, including whitespace. Native queue action edits are
unsupported until durable supersession is implemented; remove the unsent entry and
submit a new request. Removal stops dispatch, but retains original evidence.
Autonomous routes, orchestra and subagents reject before starting in native mode.

## Migration and ownership

Activation backs up SQLite with `VACUUM INTO` before schema migration. Request/event
transactions publish only after commit. A second live Brain owner or unowned event
writer is refused. Dead-owner takeover is conservative; live/reused PIDs do not
authorize takeover. Use a local filesystem; network-filesystem recovery is not certified.

Legacy JSONL remains readable with `LOOM_STORE=jsonl` but cannot provide transactional
continuity. Stop the daemon, then run:

```sh
loom brain:migrate /path/to/project
```

The importer backs up JSONL/SQLite, preserves IDs/Main history and records a manifest.
Repeated imports are idempotent. Malformed records/conflicting IDs abort the import;
distinct histories are never merged/renumbered silently. Original files remain.
An unmatched SQLite/JSONL pair fails visibly. New SQLite events are not automatically
copied back to JSONL for an older reader; rollback requires explicit backup/export
reconciliation.

## Verification and follow-ups

Protocol fakes (a Claude CLI speaking the SDK control protocol, a Codex app-server
speaking JSON-RPC; `test/native-fakes.ts`) test switching, chat isolation, corrections, explicit resume after restart,
captured queue targets/models, idempotency, protected overflow and uncertain delivery.
Storage tests exercise migration conflicts/rollback, SQLite contention, commit-before-
publication and unknown schema rejection. Ordinary tests make no paid model calls.

Remaining gates include isolated account-supported
cheap helpers, OpenCode parity, retention/GC, full platform packaging and long-history
quality/performance comparisons. Electron optimization remains future work.
See [architecture](../ARCHITECTURE.md) and the linked notes/TODO for measured evidence.

Cleanup evidence and the complete E01–E64 status audit are in
[BRAIN-AUDIT](refactoring/BRAIN-AUDIT.md).
