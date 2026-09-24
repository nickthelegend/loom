/**
 * Supabase Edge Function: GitHub repo webhooks into the hosted Team Hub (D83).
 *
 * Deploy (needs a Supabase access token; GitHub sends no Supabase JWT, so the
 * function checks the webhook signature itself instead):
 *
 *   supabase functions deploy github-webhook --no-verify-jwt --project-ref <ref>
 *
 * Payload URL: https://<ref>.supabase.co/functions/v1/github-webhook/<team id>
 * (`loom team webhook` prints it with the team's secret). It runs with the
 * service role, which Supabase injects as SUPABASE_SERVICE_ROLE_KEY, and only
 * calls the two functions 0009_phase6.sql grants that role.
 */

import { createClient } from "npm:@supabase/supabase-js@2";

import { handleWebhook } from "./handler.ts";

const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false, autoRefreshToken: false },
});

Deno.serve((req) =>
  handleWebhook(req, {
    async secretFor(teamId) {
      const { data, error } = await sb.rpc("github_webhook_secret", { p_team: teamId });
      if (error) throw new Error(error.message);
      return typeof data === "string" && data ? data : null;
    },
    async ingest(teamId, events) {
      const { data, error } = await sb.rpc("github_webhook_ingest", { p_team: teamId, p_events: events });
      if (error) throw new Error(error.message);
      return Number(data ?? 0);
    },
  }).catch((e) => {
    // The detail goes to the function's log, not to whoever sent the request:
    // a database error message says more about the schema than a caller needs.
    console.error("github-webhook failed:", (e as Error)?.message ?? e);
    return new Response(JSON.stringify({ error: "the webhook couldn't be recorded" }), { status: 500, headers: { "content-type": "application/json" } });
  }),
);
