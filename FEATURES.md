# The 2026-07-30 run — an auditable ledger

One line per discrete feature or fix shipped in this run, in landing order,
grouped by the commit family that carried it. Tests are listed at the end and
counted separately — a test proves a feature, it isn't one.

## Sessions & agents
1. fix — Console loses errors logged between backfill and socket-open (reconcile on open)
2. feat — instance numbering: `codex`, `codex-2`, `codex-3` share one project brain
3. feat — `agents/available` reports a per-kind session count, not a boolean
4. feat — add-agent rail offers "add another" with a ×n badge; bridges drop off
5. feat — CLI `agents:add` (`--as`, `--role`)
6. feat — CLI `agents:rm`
7. feat — CLI `agents:available` (`--json`)
8. feat — typed client: addAgent / availableAgents / removeAgent
9. feat — sub-agent engine: children run beside the parent, never touch the baton
10. feat — narrowed subtask briefing with retrieval scoped to the child's task
11. fix — async tails after close() threw ERR_INVALID_STATE into unhandled rejections
12. feat — API `POST/GET /subtasks`
13. feat — CLI `spawn`
14. feat — CLI `subtasks`
15. feat — typed client: spawnSubtask / subtasks
16. feat — retryTurn: re-run a failed prompt elsewhere, failure as briefing not message text
17. feat — API `POST /retry`
18. feat — CLI `retry`
19. feat — echo adapter `fail:` trigger (recovery paths testable without forged events)
20. feat — stale-session busy clock (started at dispatch, stopped by terminal events)
21. feat — `staleSessions()` — hung past ten minutes
22. feat — `reapSession()`: interrupt → stop → respawn, baton released if held
23. feat — API `GET /stale`, `POST /agents/:id/reap`
24. feat — CLI `stale`
25. feat — CLI `reap`

## The Browser tab
26. feat — Browser tab in the dock, peer to Console
27. feat — spec discovery by name, never inside node_modules, 200-file cap
28. feat — SpecRunner: one per project, streamed, stoppable, LOOM_SPEC_CMD seam
29. feat — `spec`/`spec_done` WS frames + pass/fail recorded in the Console
30. feat — URL bar + iframe preview for a local dev server
31. feat — failing spec stages its reporter tail in the composer
32. feat — CLI `specs`
33. feat — CLI `specs:run`
34. fix — closing a CONNECTING WebSocket emitted an async error try/catch never saw

## The brain
35. feat — `Brain.export`: live memories as a self-describing portable document
36. feat — `Brain.import`: hash-deduped, junk rows skipped not fatal
37. feat — API `GET /brain/export`, `POST /brain/import`
38. feat — CLI `brain:export`
39. feat — CLI `brain:import`
40. feat — recency decay: 7-day half-life to a 0.55 floor, multiplies match not bias
41. feat — decay factor visible in `explain`
42. feat — fuzzy channel: hashed trigram vectors, typos + morphology, honestly not synonymy
43. feat — fuzzy score in `explain`
44. feat — contradiction scan: negation-pair signal
45. feat — contradiction scan: same-topic-divergent signal (facts exempt)
46. feat — API `GET /brain/conflicts`, every flag names its signal
47. feat — CLI `brain:conflicts`
48. feat — CLI `brain:forget` (+ typed client forgetMemory)

## Money
49. fix — an agent over its cap looked healthy until the next dispatch; pause lands with the turn_cost
50. feat — CLI `budgets` (measured spend vs cap)
51. feat — CLI `budget <id> <usd>` (0 clears)
52. feat — typed client: budgets / setBudget
53. feat — `costSeries`: day buckets with a per-agent split, absent days absent
54. feat — API `GET /costs/series?days=`
55. feat — CLI `costs --series [days]`

## The board
56. feat — `blockedBy` links, validated against existing cards
57. feat — `taskBlockers()`: blocked while any blocker short of `ready`
58. feat — dependency cycles refused at write (`wouldCycle`)
59. feat — API `GET /board/tasks/:id/blockers`
60. feat — API `POST /board/tasks/:id/dispatch` — card becomes a turn; blocked 409s with names
61. feat — API `GET /board/tasks` (list your cards; only POST existed)
62. feat — typed client: listTasks / createTask
63. feat — CLI `task` (`--agent`, `--column`, `--blocked-by`)
64. feat — CLI `tasks`
65. feat — board payload carries an unfinished-blocker count
66. feat — blocked badge (⛔ n) on own cards

## Git policies (all opt-in)
67. feat — `commitPerTurn`: one commit per turn, prompt as subject, agent as co-author
68. feat — `stageAndCommitFiles`: staging scoped to the turn's own files
69. feat — commit failure is a Console line, never a failed turn
70. feat — `branchPerTask`: card → Working checks out `task/<id>-<slug>`
71. feat — `ensureBranch`: create-or-switch, idempotent, never `checkout -B`
72. feat — card → Review logs the exact `gh pr create` instead of running it
73. feat — `worktreePerAgent`: each adapter in a sibling checkout on `agent/<id>`
74. feat — snapshots/diffs/commits read the agent's own tree (`agentDir`)
75. feat — worktree fallback to the shared tree with a Console warning

## Routes
76. feat — `saveRoute`: named pipelines validated against the current roster
77. feat — `deleteRoute`
78. feat — API `PUT/DELETE /routes/:name`
79. feat — CLI `routes:save`
80. feat — CLI `routes:rm`
81. feat — `onFail`: a step names an earlier step to re-enter on error
82. feat — onFail resolution: backward-only, refused loudly otherwise
83. feat — loop budget: three re-entries then an honest failure naming the loop
84. feat — loops visible in the thread (`route_step {loopedFrom, loop}`)

## Ops & lifecycle
85. feat — snapshot(): brain + board + config, not the tree, not the log
86. feat — restore(): board/config replace, brain merges, roster reconciles
87. feat — API `GET /snapshot`, `POST /restore`
88. feat — CLI `snapshot`
89. feat — CLI `restore`
90. feat — MCP health poll loop (60s, HTTP servers)
91. feat — down/up transitions named in the Console
92. feat — `healthyMcps`: measured-down servers withheld from turns
93. feat — API `GET/POST /mcps/health`
94. feat — CLI `mcp:health`
95. feat — doctor `fixProject`: repairs what has exactly one safe repair
96. feat — doctor `--fix` flag, re-diagnoses after
97. feat — terminal scrollback persisted (debounced + synchronous on shutdown)
98. feat — scrollback seeded into the next session under an honest divider
99. feat — deliberate close forgets the file (no haunting)
100. fix — forgetting a project now stops its spec run
101. fix — forgetting a project drops its daemon-side scrollback files
102. feat — stale-session / spec-runner shutdown on daemon close

## Security
103. feat — pairing tokens carry a project scope chosen at mint
104. feat — claim copies scope; the device cannot widen it
105. feat — `allowedProjects()` on the auth manager
106. feat — one scope wall over every project route, matched by resolved id
107. feat — scoped tokens see only their world in the project list
108. feat — event fan-out skips out-of-scope sockets
109. feat — terminal fan-out skips out-of-scope sockets
110. feat — log fan-out: scoped sockets get their projects only; daemon-level stays admin
111. feat — minting with an unknown project is a loud 400, not a dud token

## Voice & hardware
112. feat — `POST /voice`: audio in, text out via configured LOOM_STT_CMD
113. feat — no transcriber is an honest 501 with the setup line; silence is 422
114. feat — composer mic: hold to record, release to transcribe, fills the box
115. feat — mic hidden where MediaRecorder doesn't exist
116. fix — voice temp files could collide across simultaneous requests
117. feat — backend `loomAgentState`: live status as four renderable words
118. feat — backend `GET /pad/state` (degrades to ready, never invents a fault)
119. feat — firmware `net.padState`
120. feat — firmware LED patterns: breathe / sharp blink / solid red / steady
121. feat — firmware state poll, never mid-recording (compiles clean, esp32s3)

## Small surfaces
122. feat — `HEAD /api/health` (bodyless liveness)
123. feat — `GET /api/version` (rev, node, platform, uptime, pid)
124. feat — `PATCH /projects/:id` rename — the id never moves
125. feat — `renameProject` in the registry
126. feat — `GET /events/search?q=` (messages, decisions, questions)
127. feat — CLI `rename`
128. feat — CLI `find`
129. feat — CLI `version` (CLI vs daemon build, names the fix)
130. feat — CLI `open`
131. feat — typed client: nine newer routes (snapshot…costSeries)
132. feat — typed client: renameProject / searchEvents / version / forgetMemory
133. fix — subtask brief capped at 10k chars, alternative named

## UI
134. feat — Console search box
135. feat — Console scope menu, built from the records themselves
136. feat — filtered-empty ≠ nothing-went-wrong states
137. feat — review comments: clickable diff rows carrying file:line
138. feat — comment editor (Enter adds, Escape cancels)
139. feat — review bar: count, stage-in-composer, discard
140. feat — staged comments leave as ONE message through the composer
141. feat — subtask events render in the thread, indented as borrowed hands
142. feat — Observatory timeline shows reaped / committed / branched / restored
143. feat — ⌘K palette reaches the Browser tab and the Console
144. feat — skill authoring scaffolds SKILL.md validated by the loader's parser
145. feat — API `POST /skills/author`, enabled by default

## Docs & backlog
146. docs — commands table: the eighteen missing rows
147. docs — fan-out / multi-session / Browser tab sections
148. docs — brain behaviours (decay, fuzzy, conflicts, portability)
149. docs — git policies + looping routes
150. docs — scoped tokens + odds-and-ends
151. content — 30 feature-request issues, written and triaged (29 closed with implementations)
152. content — 6 follow-on issues capturing the honest next steps

## The fable wave (153–165)
153. feat — CLI `brain:search` (`--explain` shows the per-hit arithmetic)
154. feat — typed client searchBrain
155. feat — `specs:run --wait`: the verdict as an exit code, failure tail printed
156. feat — typed client logs()
157. feat — `safety.snapshotBeforeRoutes`: a pre-route checkpoint nobody had to remember
158. feat — pre-route snapshots bounded to the newest five
159. feat — CLI `budget all <usd>` — cap the whole fleet in one line
160. feat — stale-build reload banner: socket reconnect compares page rev vs daemon rev
161. feat — patchConfig accepts git + safety policies (false deletes the key)
162. feat — settings() reports policies measured, not assumed
163. feat — Settings modal: Policies section with one honest description each
164. feat — Brain tab surfaces likely contradictions, quiet when clean
165. content — 6 follow-on issues (#31–#36) capturing the honest next steps

## The build-verification pass (166–168)
166. fix — a project registered from a `.loom/config.json` with no `name` got `name: null`:
     `--name` silently ignored, nameless rows in every list, and `snapshot()`'s declared
     `project: string` absent from the JSON. Fixed at the route (fill in and persist) and
     at `registerProject` (never store a blank label)
167. chore — `docs/img` out of the npm tarball: 1.9 MB → 783 kB packed, 4.1 MB → 2.9 MB
     unpacked, for 5 screenshots nothing in the package referenced
168. verify — the published artifact proven, not assumed: real `tsc` emit, all four
     package.json entrypoints, `npm pack` → clean-dir install → both bins linked →
     daemon boots → `/app` serves 627 kB → project created, brain written, retrieval
     scored, a real turn completed

## Test suites written or extended (proof, counted apart)
agent-instances (12) · subagents (10) · specs+voice (10) · brain-portable (7) ·
cli-watch (3) · budgets (+1) · retry (3) · stale-sessions (4) · costs (+2) ·
board (+4) · snapshot (3) · scoped-tokens+small-surfaces (13) · routes-crud (5) ·
routes-onfail (4) · commit-per-turn+branch (4) · worktree-per-agent (4) ·
scrollback (3) · mcp health (+2) · pre-route snapshots (+2) · project naming (6) · brain decay/fuzzy/conflicts (+11) ·
doctor fixes (+4) · app-dom: browser tab, console filters, review comments (+5) ·
backend loom state (+1)
