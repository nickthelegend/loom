# Issue #427 implementation notes

This batch extends the existing Auto allowlist, review secret scanner, fixed 30-minute approval timeout, composer permission chips and owner-only audit. It adds the missing controls at their existing execution and presentation boundaries. No README changes are needed for this batch.

| Checklist | Existing behavior and resulting change | Main files | New tests |
| --- | --- | --- | --- |
| Per-tool rules | Auto already accepted allow globs. Added project allow/deny patterns with deny precedence across modes. | core/safety.ts, core/auto-policy.ts, adapters/model.ts, providers/claude/adapter.ts, daemon/routes/approvals.ts | r3-safety-core, r3-safety-api, r3-safety-tools, r3-safety-dom |
| Secret scanner | core/secret-scan.ts already scanned CLI review diffs. Added checks at Loom's Git process boundary and explicit per-operation overrides. | core/git-safety.ts, core/process.ts, daemon/routes/git.ts, web/safety.js, app/src/safety.tsx | r3-safety-core, r3-safety-api, r3-safety-dom |
| Protected paths | Model tools already confined writes to the project. Added protected relative globs, canonical path checks and refusal of opaque writes. | core/safety.ts, adapters/model.ts, providers/claude/adapter.ts | r3-safety-core, r3-safety-tools |
| Approval timeout | Already auto-denied after 30 minutes. Added project deadlines, expiry displays and late-answer checks. | daemon/server.ts, web/approvals.js, app/src/approvals.tsx | r3-safety-api, r3-safety-dom |
| Permission indicator | Chips already existed. Added effective sandbox labels and visibility in the simple web composer. | core/permissions.ts, daemon/runtime.ts, web/project/composer.js, app/src/permissions.tsx | r3-safety-tools, r3-safety-dom, app/test/r3-safety.test.mts |
| Shell denylist | Auto already rejected destructive commands through the Shield classifier. Added configurable patterns enforced before intercepted tools run in every mode. | core/safety.ts, adapters/model.ts, providers/claude/adapter.ts | r3-safety-core, r3-safety-tools |
| Transcript redaction | Diagnostic bundles already redacted credentials. Added redaction to event persistence, old event reads, previews, live text and the existing export paths. | core/redact.ts, core/eventlog.ts, daemon/runtime.ts, providers/live.ts | r3-safety-core, r3-safety-api, r3-safety-tools, r3-safety-dom |
| Presets | Agent permission modes existed. Added project presets, validation, persistence and editors. | core/safety.ts, daemon/runtime.ts, cli/index.ts, web/safety.js, app/src/safety.tsx | r3-safety-core, r3-safety-api, r3-safety-dom, app/test/r3-safety.test.mts |
| Risky audit | Owner-only audit already reported approvals and collaboration activity. Added risky tool classifications, hard denials, overrides and filtering. | daemon/workspace-views.ts, daemon/client.ts, cli/index.ts, web/safety.js, app/src/safety.tsx | r3-safety-api, r3-safety-dom |

Paths in the first three columns are relative to `src/` except `app/`; Vitest files are under `test/` with `.test.ts` suffixes.

## Controls

`GET /api/projects/:id/safety` reads the effective policy. `PUT` replaces it with a validated policy; omitted fields take the selected preset's defaults. The web and phone Safety controls edit the same fields. The CLI supports `loom safety`, `loom safety --preset strict` and `loom safety --file policy.json`.

```json
{
  "preset": "normal",
  "allow": ["Read*"],
  "deny": ["mcp__production__*"],
  "protectedPaths": ["secrets/**", "**/.env"],
  "shellDeny": ["curl *|*sh", "rm -rf *"],
  "approvalTimeoutMin": 10
}
```

Tool patterns support `*` and `?`; protected-path patterns also support `**` across directories. Deny wins over allow, Bypass and human approval. A protected path remains readable. Explicit allows bypass a human approval; they do not defeat the existing destructive-command checks in Auto.

Policies live under `LOOM_HOME/safety/`, keyed by project ID, outside the checkout. Until a policy is saved, existing `permissions.allow` entries populate the editor. A saved policy replaces that legacy allowlist. Saving a preset applies its permission mode to every roster agent and clears native sandbox/mode overrides so they cannot silently defeat the preset. Changes are refused during active turns, orchestra runs or crew goals, and cannot loosen a team permission ceiling. Scoped tokens and share-live guests cannot read or change safety policy, change agent permissions, override a secret scan or read the audit. Unscoped paired devices can manage project safety; the machine-wide audit remains owner/admin-only.

A secret scan failure returns HTTP 409 with `code: "secrets_detected"` and findings containing locations and descriptions, without matched secret values. `overrideSecrets: true` on a Git commit/push request permits that operation and records it in the audit. Web and phone ask explicitly before retrying. CLI equivalents are `loom git:commit "message" --override-secrets` and `loom git:push --override-secrets`. Automatic commits have no implicit override.

## Enforcement and verification limits

Hard tool policies are enforced in Loom's model tool loop and Claude's SDK PreToolUse hook. Other CLI/bridge adapters do not expose reliable interception for every tool; enabling a hard policy with one enabled is refused. Echo remains usable for offline daemon tests. Protected paths disable shell, subagent and opaque tools, since scripts can calculate filenames or invoke other programs. This is tool-level enforcement, not a new OS sandbox. Shell deny patterns match command text, not arbitrary program semantics.

Git checks cover direct Git invocations launched by Loom, including automatic/team helpers. They do not install Git hooks into the user's repository or intercept subprocesses launched independently by an agent CLI. Scans inspect staged content and outgoing commit history, with bounded output/time; a failed scan prevents the operation. Git history can contain credentials that a net branch diff would miss. Existing raw log storage is not rewritten; historical reads and exports are redacted. Native provider session files and arbitrary artifacts are outside the transcript export boundary.

Live redaction buffers candidate credential prefixes until a line or message completes, while ordinary prose continues streaming. Secret recognition is pattern-based and cannot identify every arbitrary secret string. Real external agent CLIs and physical phone interaction are deliberately not exercised by the tests; the native hook is typechecked, and model enforcement is exercised against a local HTTP provider fixture.

## Validation

- `npx tsc --noEmit -p .`: passed.
- `node scripts/build-web.mjs`: passed, before DOM tests.
- Targeted Vitest run: 14 files passed, 178 tests passed, two existing platform skips. Included all four new `r3-safety-*.test.ts` files and the existing Auto policy, approvals, Git, event log, workspace audit, live stream, provider ingestion, process, replay and model-tool tests.
- Existing composer permission DOM cases: passed in a filtered run; the shared test file was not edited.
- Phone `npx tsc --noEmit -p .`: passed.
- Phone `node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --test test/*.test.mts`: 102 passed.
- `git diff --check`: passed. README.md, hardware/ and .claude/ are unchanged. No commit was created.

Vitest used `--maxWorkers=2 --configLoader native`. The existing node_modules symlink points outside the writable worktree, so Vite's default bundled-config cache could not be written; the native config loader avoids that write without changing repository configuration. The whole repository test suite was not run.
