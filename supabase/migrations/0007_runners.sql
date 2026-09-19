-- Loom Teams, Phase 5 — runners and the job queue on the hosted Team Hub.
--
-- Mirrors src/core/team-hub.ts (MemoryHub.registerRunner & co.). Decisions
-- (docs/teams-architecture.md §1a):
--   D67  a runner is a member's always-on headless Loom daemon
--   D68  it takes its owner's goals; a runner marked shared takes any member's
--   D71  jobs carry sealed payloads; a runner claims one atomically and
--        heartbeats it; 10 minutes of silence makes it claimable again (D12)
--   D72  deploy statuses reach the feed (deploy_started/succeeded/failed)
--   D74  revoking a runner removes its device (and its key envelopes); the
--        owner rotates the team key next (D6)
--   D75  a goal moved to a runner is announced (goal_moved)
--
-- Routing metadata (repo, kind, who, which runner, state) is plain so the hub
-- can match jobs to runners; the goal, run record, progress and result are
-- sealed to the team (D2).

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table if not exists public.runners (
  device_id uuid primary key references public.devices (id) on delete cascade,
  user_id   uuid not null references auth.users (id) on delete cascade,
  kinds     text[] not null default '{}',
  shared    boolean not null default false,
  capacity  int not null default 1 check (capacity between 1 and 8),
  last_seen timestamptz not null default now()
);
create index if not exists runners_user_idx on public.runners (user_id);

create table if not exists public.jobs (
  id            uuid primary key default gen_random_uuid(),
  team_id       uuid not null references public.teams (id) on delete cascade,
  repo          text not null,
  kind          text not null check (kind in ('start', 'continue', 'fix', 'return', 'land')),
  user_id       uuid not null references auth.users (id) on delete cascade,
  github        text not null default '',          -- who asked, as MemoryHub snapshots it
  target        uuid,                              -- a specific runner (device id), or any eligible one
  state         text not null default 'queued' check (state in ('queued', 'claimed', 'done', 'failed', 'cancelled')),
  runner_id     uuid,                              -- plain: a revoked runner's jobs keep their history
  runner_github text,
  claimed_at    timestamptz,
  heartbeat_at  timestamptz,
  sealed        jsonb not null,
  progress      jsonb,
  result        jsonb,
  error         text check (char_length(error) <= 500),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists jobs_team_state_idx on public.jobs (team_id, state, created_at);

-- ---------------------------------------------------------------------------
-- Row-level security: reads for teammates, writes only through functions
-- ---------------------------------------------------------------------------

-- Does the caller share any team with this user? (SECURITY DEFINER so the
-- policy doesn't recurse into team_members' own policy.)
create or replace function public.shares_team_with(p_user uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.team_members a join public.team_members b on a.team_id = b.team_id
    where a.user_id = auth.uid() and b.user_id = p_user)
$$;

alter table public.runners enable row level security;
alter table public.jobs    enable row level security;

drop policy if exists "runners: own and teammates'" on public.runners;
create policy "runners: own and teammates'" on public.runners for select to authenticated using (
  user_id = auth.uid() or public.shares_team_with(user_id));

drop policy if exists "jobs: members" on public.jobs;
create policy "jobs: members" on public.jobs for select to authenticated using (public.has_team_role(team_id, 'viewer'));

revoke insert, update, delete on public.runners, public.jobs from anon, authenticated;
grant select on public.runners, public.jobs to authenticated;

-- ---------------------------------------------------------------------------
-- Functions (mirror MemoryHub)
-- ---------------------------------------------------------------------------

create or replace function public.require_own_device(p_device uuid) returns void
language plpgsql stable security definer set search_path = public as $$
begin
  if auth.uid() is null or not exists (select 1 from public.devices where id = p_device and user_id = auth.uid()) then
    raise exception 'that device isn''t yours' using errcode = '42501';
  end if;
end $$;

-- A runner as MemoryHub returns it: {deviceId, userId, github, label, kinds, shared, capacity, lastSeen}
create or replace function public.runner_json(r public.runners) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'deviceId', r.device_id, 'userId', r.user_id,
    'github', coalesce((select github from public.profiles where user_id = r.user_id), ''),
    'label', coalesce((select label from public.devices where id = r.device_id), ''),
    'kinds', to_jsonb(r.kinds), 'shared', r.shared, 'capacity', r.capacity,
    'lastSeen', (extract(epoch from r.last_seen) * 1000)::bigint)
$$;

create or replace function public.register_runner(p_device uuid, p_kinds jsonb, p_shared boolean, p_capacity int default 1)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  k text[] := public.array_union_ordered(
    coalesce((select array_agg(x) from jsonb_array_elements_text(coalesce(p_kinds, '[]')) x), '{}'), '{}', 20);
  r public.runners;
begin
  perform public.require_own_device(p_device);
  insert into public.runners (device_id, user_id, kinds, shared, capacity, last_seen)
  values (p_device, auth.uid(), k, coalesce(p_shared, false), greatest(1, least(8, coalesce(p_capacity, 1))), now())
  on conflict (device_id) do update set
    kinds = excluded.kinds, shared = excluded.shared, capacity = excluded.capacity, last_seen = now()
  returning * into r;
  return public.runner_json(r);
end $$;

-- MemoryHub.runners: the runners of this team's members (a viewer may look).
create or replace function public.team_runners(p_team uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  perform public.require_role(p_team, 'viewer');
  return coalesce((
    select jsonb_agg(public.runner_json(r) order by r.last_seen)
    from public.runners r join public.team_members m on m.user_id = r.user_id and m.team_id = p_team), '[]'::jsonb);
end $$;

-- Remove one of your devices. Its runner record and key envelopes go with it
-- (and, by cascade, its presence and leases); rotating the team key is the
-- owner's next step (D74, D6).
create or replace function public.revoke_device(p_device uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform public.require_own_device(p_device);
  delete from public.runners where device_id = p_device;
  delete from public.key_envelopes where device_id = p_device;
  delete from public.devices where id = p_device and user_id = auth.uid();
end $$;

create or replace function public.create_job(p_team uuid, j jsonb) returns public.jobs
language plpgsql security definer set search_path = public as $$
declare
  r text;
  tgt uuid := nullif(j->>'target', '')::uuid;
  run public.runners;
  job public.jobs;
begin
  perform public.require_role(p_team, 'member');
  perform public.require_own_device(nullif(j->>'deviceId', '')::uuid);
  r := public.normalize_repo(j->>'repo');
  if not exists (select 1 from public.team_repos where team_id = p_team and repo = r) then
    raise exception '% isn''t shared with this team', r using errcode = '42501';
  end if;
  if coalesce(j->>'kind', '') not in ('start', 'continue', 'fix', 'return', 'land') then
    raise exception 'bad job kind' using errcode = '22023';
  end if;
  if coalesce(j->'sealed'->>'c', '') = '' then
    raise exception 'a job needs its sealed payload' using errcode = '22023';
  end if;
  if tgt is not null then
    select * into run from public.runners where device_id = tgt;
    if run.device_id is null
       or not exists (select 1 from public.team_members where team_id = p_team and user_id = run.user_id) then
      raise exception 'no such runner on this team' using errcode = 'P0002';
    end if;
    if run.user_id <> auth.uid() and not run.shared then
      raise exception 'that runner isn''t shared' using errcode = '42501';
    end if;
  end if;
  insert into public.jobs (team_id, repo, kind, user_id, github, target, sealed)
  values (p_team, r, j->>'kind', auth.uid(),
          coalesce((select github from public.profiles where user_id = auth.uid()), ''), tgt, j->'sealed')
  returning * into job;
  return job;
end $$;

-- The oldest queued (or stale-claimed) job this runner may take, claimed
-- atomically: `for update skip locked` means two runners never get the same
-- row. Eligible = targeted at this runner, else its owner's, else anyone's
-- when the runner is shared (D68). Returns null when there is none.
create or replace function public.claim_job(p_team uuid, p_runner uuid) returns public.jobs
language plpgsql security definer set search_path = public as $$
declare run public.runners; job public.jobs;
begin
  perform public.require_role(p_team, 'member');
  perform public.require_own_device(p_runner);
  select * into run from public.runners where device_id = p_runner;
  if run.device_id is null then
    raise exception 'that device isn''t a runner — register it first' using errcode = '42501';
  end if;
  update public.runners set last_seen = now() where device_id = p_runner;
  select * into job from public.jobs x
   where x.team_id = p_team
     and (x.state = 'queued' or (x.state = 'claimed' and coalesce(x.heartbeat_at, '-infinity') < now() - interval '10 minutes'))
     and (case when x.target is not null then x.target = run.device_id
               else x.user_id = run.user_id or run.shared end)
   order by x.created_at, x.id
   limit 1
   for update skip locked;
  if job.id is null then return null; end if;
  update public.jobs set state = 'claimed', runner_id = run.device_id,
         runner_github = coalesce((select github from public.profiles where user_id = run.user_id), ''),
         claimed_at = now(), heartbeat_at = now(), updated_at = now()
   where id = job.id
  returning * into job;
  return job;
end $$;

-- The job, locked, if this runner (one of your devices) holds it.
create or replace function public.held_job(p_team uuid, p_job uuid, p_runner uuid) returns public.jobs
language plpgsql security definer set search_path = public as $$
declare job public.jobs;
begin
  perform public.require_role(p_team, 'member');
  perform public.require_own_device(p_runner);
  select * into job from public.jobs where id = p_job and team_id = p_team for update;
  if job.id is null then raise exception 'no job "%"', p_job using errcode = 'P0002'; end if;
  if job.runner_id is distinct from p_runner or job.state <> 'claimed' then
    raise exception 'that runner doesn''t hold this job' using errcode = 'PT409'; -- 409; not 40001, which PostgREST retries
  end if;
  return job;
end $$;
revoke all on function public.held_job(uuid, uuid, uuid) from public, anon, authenticated;

create or replace function public.heartbeat_job(p_team uuid, p_job uuid, p_runner uuid, p_progress jsonb default null)
returns public.jobs language plpgsql security definer set search_path = public as $$
declare job public.jobs;
begin
  perform public.held_job(p_team, p_job, p_runner);
  update public.jobs set heartbeat_at = now(), updated_at = now(),
         progress = case when p_progress is null or p_progress = 'null'::jsonb then progress else p_progress end
   where id = p_job
  returning * into job;
  update public.runners set last_seen = now() where device_id = p_runner;
  return job;
end $$;

create or replace function public.finish_job(p_team uuid, p_job uuid, p_runner uuid, p_state text,
  p_result jsonb default null, p_error text default null)
returns public.jobs language plpgsql security definer set search_path = public as $$
declare job public.jobs;
begin
  perform public.held_job(p_team, p_job, p_runner);
  if p_state is null or p_state not in ('done', 'failed') then
    raise exception 'a job finishes done or failed' using errcode = '22023';
  end if;
  update public.jobs set state = p_state, updated_at = now(),
         result = case when p_result is null or p_result = 'null'::jsonb then result else p_result end,
         error = coalesce(left(nullif(p_error, ''), 500), error)
   where id = p_job
  returning * into job;
  return job;
end $$;

-- Its author withdraws it; a finished job stays as it finished.
create or replace function public.cancel_job(p_team uuid, p_job uuid) returns public.jobs
language plpgsql security definer set search_path = public as $$
declare job public.jobs;
begin
  perform public.require_role(p_team, 'member');
  select * into job from public.jobs where id = p_job and team_id = p_team for update;
  if job.id is null then raise exception 'no job "%"', p_job using errcode = 'P0002'; end if;
  if job.user_id <> auth.uid() then
    raise exception 'only whoever asked can cancel a job' using errcode = '42501';
  end if;
  if job.state in ('done', 'failed') then return job; end if;
  update public.jobs set state = 'cancelled', updated_at = now() where id = p_job returning * into job;
  return job;
end $$;

-- ---------------------------------------------------------------------------
-- Feed: members may post the Phase 5 events (latest list from 0006, plus these)
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
                          'goal_moved', 'deploy_started', 'deploy_succeeded', 'deploy_failed') then
    raise exception 'members can''t post % events', e->>'type' using errcode = '22023';
  end if;
  return public.feed_append(p_team, auth.uid(), e->>'type', coalesce(e->'meta', '{}'), e->>'repo',
                            e->'sealed', dev, e->>'sig', e->>'dedupeKey');
end $$;

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------

revoke all on function public.require_own_device(uuid), public.runner_json(public.runners) from public, anon, authenticated;
grant execute on function public.shares_team_with(uuid) to authenticated;
revoke execute on function public.shares_team_with(uuid) from anon, public;

grant execute on function public.register_runner(uuid, jsonb, boolean, int), public.team_runners(uuid),
  public.revoke_device(uuid), public.create_job(uuid, jsonb), public.claim_job(uuid, uuid),
  public.heartbeat_job(uuid, uuid, uuid, jsonb), public.finish_job(uuid, uuid, uuid, text, jsonb, text),
  public.cancel_job(uuid, uuid)
  to authenticated;
revoke execute on function public.register_runner(uuid, jsonb, boolean, int), public.team_runners(uuid),
  public.revoke_device(uuid), public.create_job(uuid, jsonb), public.claim_job(uuid, uuid),
  public.heartbeat_job(uuid, uuid, uuid, jsonb), public.finish_job(uuid, uuid, uuid, text, jsonb, text),
  public.cancel_job(uuid, uuid)
  from anon, public;

-- Realtime: members hear job changes (RLS filters per member).
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    begin alter publication supabase_realtime add table public.jobs; exception when duplicate_object then null; end;
  end if;
end $$;

-- PostgREST: pick up the new functions now
notify pgrst, 'reload schema';
