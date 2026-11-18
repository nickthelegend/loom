# Brain and memory · issue #419

## Existing behavior and the improvements in this batch

This inventory was taken before implementation; it also supplies the feature notes for a future PR.

| Item | Already present | Improvement |
| --- | --- | --- |
| Search filters | Kind filtering on lists; agent/chat scope in retrieval; phone text search | Server-side kind, learning-agent and inclusive creation-date filters, combined with lexical/semantic search; web, phone and CLI controls |
| Export | Portable JSON API, CLI and web download | Human-readable Markdown in the repo, preserving scopes, pin/priority and trust metadata on import |
| Duplicates | Exact text hashes; team duplicate review; solo conflict warnings | Solo near-duplicate review, same-kind/same-scope merge, archive the second memory; negations remain conflict candidates |
| Pins | No solo pin or priority | Persist pin and integer priority, order pins first and keep all eligible pins beyond the result limit |
| Stale | Prompt-usage counts; team aging | Flag 30 days since last injection (or creation if never injected); reversible archive |
| Import | JSON exports and automatic native ADE files | Plain Markdown file, pasted text or public URL; limits and redirect/address validation |
| Chat scope | Stored chat scope and partial retrieval filtering | Creation/edit controls, scope-aware deduplication, no chat-only retrieval without the matching chat, no team publication of scoped memories |
| History | Add/update/forget event records | Full before/after state and patches, named paired-device attribution, revert as another event |
| Why injected | Search score arithmetic and aggregate usage counts | Frozen per-turn selection at dispatch, with text, scores and reasons, persisted in the event log |

## CLI

```sh
loom brain:search sqlite --kind decision --agent user --since 2026-01-01 --until 2026-12-31 --chat main --explain
loom brain:export --md docs/BRAIN.md
loom brain:import notes.md
loom brain:import https://example.com/notes.md
loom brain:add "Use sqlite for this experiment" --kind decision --chat main
loom brain:list --stale
loom brain:list --archived
loom brain:pin MEMORY_ID --priority 20
loom brain:pin MEMORY_ID --off
loom brain:archive MEMORY_ID
loom brain:archive MEMORY_ID --restore
loom brain:duplicates
loom brain:merge KEEP_ID OTHER_ID --text "The reviewed merged wording"
loom brain:history MEMORY_ID
loom brain:history MEMORY_ID --revert EVENT_ID
loom brain:why TURN_MESSAGE_EVENT_ID
```

Markdown export creates parent directories and refuses to overwrite existing files. Choose a new path for another snapshot. JSON export/import remains supported. Ordinary Markdown headings select a memory kind when they name one; paragraphs and list entries become memories. Loom Markdown exports carry metadata comments so a round trip retains scope and injection settings. Archived and expired memories do not travel in a live export.

The learning-agent filter matches `provenance.agentId`, rather than the agent allowed to receive a scoped memory. Dates use `createdAt`, with a date-only `until` including the whole UTC day. Chat filtering includes project-wide memories plus that chat's memories. With no chat, retrieval excludes chat-only memories; the management list can still show every chat's memories to the owner.

Pins obey chat/agent/crew scope, expiry, archive and confidence eligibility. They are always selected once eligible, and priorities sort descending. Native continuity includes explicitly pinned memories in its budgeted supplement; ordinary legacy retrieval remains disabled there. An oversized mandatory supplement uses the existing overflow/recovery path. Saved injection records describe what Loom passed to the adapter, not whether the model understood or obeyed it.

A merge is a human decision: it saves the reviewed wording on the keeper, unions entities, preserves stronger pin/priority and privacy flags, and archives the other memory. Revert restores the chosen revision's editable fields as a new event. Archive is reversible; forgetting retains its existing tombstone semantics.

## API and clients

All routes below are under `/api/projects/:id/brain` and reject scoped tokens and share-live guests. Unscoped paired devices can manage project memories. Writing a Markdown file in the repo and fetching a URL require owner/admin credentials. No batch action changes global configuration.

- `GET /?kind=&agent=&since=&until=&chat=&includeArchived=1` lists memories with stale state. `GET /search?q=...` accepts the same filters and returns scored hits.
- `GET /export?format=md` returns Markdown; `POST /export {md}` writes a new `.md` file inside the project, checking existing symlink ancestors.
- `POST /import {markdown}` or `{url}` supplements the original JSON document form. URLs use HTTP(S), at most three redirects, checked/pinned public DNS addresses, a request timeout and a 1 MB response bound. URL memories are untrusted and are not automatically pinned.
- `POST /` creates a memory with optional `chat`, `scope`, `pinned` and `priority`. `PATCH /:mid` edits those fields and `archived`.
- `GET /duplicates` returns candidate pairs and suggested wording; `POST /merge {keep,other,text}` applies reviewed wording.
- `GET /:mid/history` returns actor, timestamp, patch and before/after state; `POST /:mid/revert {eventId}` restores a revision.
- `GET /injections?chat=&turn=` returns the latest 100 matching dispatch records, including memory snapshots, score details and the memory briefing.

The web Memory tab has combined filters, Markdown file upload/URL import, repo export, scope controls, merge review and history. Phone Memory uses the same APIs, supports pasted Markdown/URLs, and has the same review controls. Both display per-turn explanations in the thread and in Memory. Owner-only actions remain subject to server authorization on a paired phone.
