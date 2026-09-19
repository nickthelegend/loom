-- Loom Teams, Phase 6 ("land in turn, hear it now") — docs/teams-architecture.md D79–D84.
--
--   D82  the landing train posts `land_queued` / `land_turn`. The train itself
--        needs no new SQL: a lane's slot is a lease on `.loom/landing/<lane>`
--        claimed with that path as its own hard zone, so claim_lease (0003)
--        already refuses a second claimer atomically.
--   D83  GitHub webhooks into the hub: each team gets a webhook secret (owners
--        create and rotate it); the github-webhook Edge Function verifies a
--        delivery's X-Hub-Signature-256 with it, maps the delivery, and appends
--        the events for repos the team shares, as system events (no member).
--   D84  those events carry the same dedupe keys polling does, so feed_append's
--        (team_id, dedupe_key) uniqueness keeps a fact from appearing twice.

-- ---------------------------------------------------------------------------
-- Feed: members may post the Phase 6 events (latest list from 0007, plus these)
-- ---------------------------------------------------------------------------

create or replace function public.append_feed(p_team uuid, e jsonb) returns public.feed
language plpgsql security definer set search_path = public as $$
declare dev uuid := nullif(e->>'deviceId', '')::uuid;
begin
  perform public.require_role(p_team, 'member');
  if dev is not null and not exists (select 1 from public.devices where id = dev and user_id = auth.uid()) then
    raise exception 'that device isn''t yours' using errcode = '42501';
  end if;
  if (e->>'type') not in ('goal_started', 'goal_finished', 'plan_written', 'pr_opened', 'pr_merged', 'pr_closed',
                          'check_failed', 'check_passed', 'review_requested', 'review_submitted',
                          'overlap_decided', 'drift', 'zone_waiting', 'conflict_predicted', 'canon_proposed',
                          'goal_landed', 'goal_needs_someone', 'goal_adopted', 'goal_returned', 'check_flaky',
                          'goal_moved', 'deploy_started', 'deploy_succeeded', 'deploy_failed',
                          'land_queued', 'land_turn') then
    raise exception 'members can''t post % events', e->>'type' using errcode = '22023';
  end if;
  return public.feed_append(p_team, auth.uid(), e->>'type', coalesce(e->'meta', '{}'), e->>'repo',
                            e->'sealed', dev, e->>'sig', e->>'dedupeKey');
end $$;

-- ---------------------------------------------------------------------------
-- Webhook secrets (D83): one per team, readable by nobody but the functions
-- ---------------------------------------------------------------------------

create table if not exists public.team_webhook_secrets (
  team_id    uuid primary key references public.teams (id) on delete cascade,
  secret     text not null check (char_length(secret) between 32 and 128),
  created_at timestamptz not null default now(),
  rotated_at timestamptz not null default now()
);
alter table public.team_webhook_secrets enable row level security;
-- no policies: members can't select it; owners get it through webhook_secret()
revoke all on public.team_webhook_secrets from anon, authenticated, public;

-- The team's secret, created on first ask; p_rotate replaces it. Owners only.
create or replace function public.webhook_secret(p_team uuid, p_rotate boolean default false) returns text
language plpgsql security definer set search_path = public, extensions as $$
declare s text;
begin
  perform public.require_role(p_team, 'owner');
  select secret into s from public.team_webhook_secrets where team_id = p_team;
  if s is null or coalesce(p_rotate, false) then
    s := encode(gen_random_bytes(32), 'hex');
    insert into public.team_webhook_secrets (team_id, secret) values (p_team, s)
    on conflict (team_id) do update set secret = excluded.secret, rotated_at = now();
  end if;
  return s;
end $$;

-- The receiver's side (the Edge Function, as service_role): the secret to verify against.
create or replace function public.github_webhook_secret(p_team uuid) returns text
language sql stable security definer set search_path = public as $$
  select secret from public.team_webhook_secrets where team_id = p_team
$$;

-- A verified delivery's events (githubWebhookFeed's output): GitHub's kinds
-- only, for repos this team shares only, as system events. Returns how many
-- were new — the rest were already in the feed (polled first, or redelivered).
create or replace function public.github_webhook_ingest(p_team uuid, p_events jsonb) returns int
language plpgsql security definer set search_path = public as $$
declare e jsonb; r text; n int := 0; ev public.feed;
begin
  if not exists (select 1 from public.teams where id = p_team) then
    raise exception 'no such team' using errcode = '22023';
  end if;
  for e in select * from jsonb_array_elements(coalesce(p_events, '[]')) limit 100 loop
    continue when (e->>'type') not in ('pr_opened', 'pr_merged', 'pr_closed', 'check_failed', 'check_passed',
                                        'review_submitted', 'deploy_started', 'deploy_succeeded', 'deploy_failed');
    begin
      r := public.normalize_repo(e->>'repo');
    exception when others then
      continue;
    end;
    continue when not exists (select 1 from public.team_repos where team_id = p_team and repo = r);
    ev := public.feed_append(p_team, null, e->>'type', coalesce(e->'meta', '{}'), r, null, null, null,
                             left(e->>'dedupeKey', 300));
    if ev.id is not null then n := n + 1; end if;
  end loop;
  return n;
end $$;

grant execute on function public.webhook_secret(uuid, boolean) to authenticated;
revoke execute on function public.webhook_secret(uuid, boolean) from anon, public;
revoke all on function public.github_webhook_secret(uuid), public.github_webhook_ingest(uuid, jsonb) from anon, authenticated, public;
grant execute on function public.github_webhook_secret(uuid), public.github_webhook_ingest(uuid, jsonb) to service_role;

-- PostgREST: pick up the new functions now
notify pgrst, 'reload schema';
