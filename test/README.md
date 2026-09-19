# Tests

```bash
npm test                       # everything CI runs (build first: npm run build)
npx vitest run test/<file>     # one file
```

`npm test` runs in two passes: every file in parallel except the browser-UI
suites (`test/app-*dom.test.ts`), then those one at a time, because each loads
the whole web app into jsdom against a real daemon and they contend when run
together.

## What's here

- **Unit**: pure modules (`*-units.test.ts`, `team-landing.test.ts`, …).
- **Daemon**: a real daemon on a free port, real SQLite, fake agent CLIs
  (`fake-*` scripts) that behave like `claude`, `codex`, `grok`, `opencode`,
  `agy`.
- **Teams, end to end** (`team.test.ts`, `team-phase2..5.test.ts`): two or three
  members, each a real project runtime and Team Link, on a real `loom hub`, with
  a real bare git origin. GitHub is a fake `gh`.
- **SQL** (`supabase-sql.test.ts`): every migration on a throwaway local Postgres,
  checked as the `authenticated` role. Skipped without `initdb`/`psql`.
- **Live** (`supabase-hub-live.test.ts`): a real Supabase project,
  `LOOM_LIVE_SUPABASE=1` only.
- **UI** (`app-*dom.test.ts`): the web app in jsdom.

## Housekeeping

Tests make their temp dirs with `tmpDir()` in `helpers.ts`; they're removed when
the run ends (`global-setup.ts`). Set `LOOM_KEEP_TEST_DIRS=1` to keep them for a
look. Tests never use `~/.loom`: each sets its own `LOOM_HOME`.
