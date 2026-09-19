# Team hub clients and server

Every team feature talks to a hub through one interface, `HubClient` in
[`core/team-hub.ts`](../core/team-hub.ts). Three implementations, one set of
rules:

| | Where | Use |
|---|---|---|
| `MemoryHub` | `core/team-hub.ts` | The reference: the rules, in memory. Tests run two or three members against it. |
| `loom hub` + `HttpHubClient` | `server.ts`, `client.ts` | Self-hosted: one teammate runs `loom hub --host 0.0.0.0 --secret <s>`, everyone signs in with `loom team signin http://<host>:7430`. It serves `MemoryHub` over HTTP and a WebSocket. |
| `SupabaseHubClient` | `supabase-client.ts` | Hosted: Postgres rule functions over RPC, live updates over Realtime, GitHub sign-in through Supabase Auth (loopback or paste-the-URL). The SQL is in [`supabase/`](../../supabase/README.md). |

When one changes, all three do, and the tests hold them to the same answers:
`test/team*.test.ts` (MemoryHub and `loom hub`), `test/supabase-sql.test.ts`
(the SQL on a local Postgres), and `test/supabase-hub-live.test.ts` (a real
project, opt-in).

The hub stores routing metadata in the clear and everything else sealed to the
team key; it can arbitrate leases and claims without reading goals, memories
or jobs.

**GitHub webhooks (Phase 6).** `loom hub` also takes repo webhooks at
`POST /github/webhook/:teamId`. It checks `X-Hub-Signature-256` against the
team's secret (`webhookSecret`, owners only), maps the delivery with
[`core/github-events.ts`](../core/github-events.ts), and appends the events for
the team's shared repos to its feed. The hosted hub does the same in the
`github-webhook` Edge Function (`supabase/functions/`).
