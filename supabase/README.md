# Supabase: hosted Loom Team Hub and Loom Cloud

Everything the hosted side of Loom needs lives in `migrations/`. The same SQL
deploys to Loom's own project or to any Supabase project you run (D1 in
[docs/teams-architecture.md](../docs/teams-architecture.md)).

| Migration | What it adds |
|---|---|
| `0001_app_opens.sql` | Country-only app-open counts (no user data) |
| `0002_teams.sql` | Teams, members, devices, invites, key envelopes, shared repos, presence, the team feed; RLS and the rule functions (Phase 1) |
| `0003_team_leases.sql` | Leases on files, overlap and hard zones, computed in SQL (Phase 2) |
| `0004_team_memories.sql` | Team memories: sealed rows, HMAC-merged confirmations, resolution (Phase 3) |
| `0005_hosted_hub.sql` | `extend_lease`, `team_member_list` for the hosted client |
| `0006_landing.sql` | Landing feed events: landed, needs someone, adopted, returned, flaky (Phase 4) |
| `0007_runners.sql` | Runners and the job queue with atomic claims (Phase 5) |
| `0008_key_version_conflict.sql` | A stale key-version write answers 409 instead of hanging |

**The hub never reads content.** Goal and task titles, memory text and job
payloads are sealed to the team key before they leave a member's machine. The
hub sees routing metadata only: who, which repo, file paths, states (D2).

**Writes only go through functions.** Tables are read-only to the
`authenticated` role through row-level security; every write is a `SECURITY
DEFINER` function that checks membership and rules first.

## Apply the migrations

With the database connection string (Dashboard → Connect; use the **session
pooler** address if your network has no IPv6):

```bash
for m in supabase/migrations/*.sql; do
  psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -1 -f "$m"
done
```

They're idempotent: re-running one is safe.

## Sign-in

Members sign in with GitHub through Supabase Auth (D65). Create a GitHub OAuth
App (GitHub → Settings → Developer settings → OAuth Apps) with the callback
`https://<project-ref>.supabase.co/auth/v1/callback`, then paste its client ID
and secret into Supabase → Authentication → Providers → GitHub.

## Tests

- `test/supabase-sql.test.ts` runs every migration against a throwaway local
  Postgres and checks the rules as the `authenticated` role. It needs `initdb`
  and `psql` on the machine, and is skipped otherwise.
- `test/supabase-hub-live.test.ts` runs a two-member flow against a real
  project: `LOOM_LIVE_SUPABASE=1` with `SUPABASE_URL`,
  `SUPABASE_PUBLISHABLE_KEY` and `SUPABASE_SECRET_KEY` in the environment. It
  creates `loomtest-*` users and deletes them afterwards.
