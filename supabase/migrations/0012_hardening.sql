-- 0012 — production hardening from the 2026-09-24 audit, and task jobs.
--
-- 1. Presence deletes leaked across teams. Realtime doesn't apply RLS to DELETE
--    payloads, and a delete carries the primary key — which was the whole
--    identity (team, user, device, repo, agent) — so any signed-in subscriber
--    saw other teams' repo names come and go. The key is now an opaque uuid;
--    the identity stays unique for upserts (ON CONFLICT names the columns).
--    Clients from 0012 on remember ids from inserts/updates; older ones simply
--    stop seeing departures, and the 45-second presence window ages them out.
-- 2. put_key_envelopes let any member overwrite a teammate's envelope at the
--    current key version, i.e. hand that device a team key of their choosing.
--    At the current version a member may now only add envelopes for devices
--    that have none; replacing one (and rotating) stays the owner's.
-- 3. team_role() and has_team_role() are SECURITY DEFINER lookups of membership;
--    anon never needs them.
-- 4. Ephemeral rows (stale presence, expired leases and invites, old feed) were
--    never cleaned up. prune_ephemeral() does it; it's scheduled with pg_cron
--    when the extension exists, and callable by the service role otherwise.

-- 1 ---------------------------------------------------------------------------
alter table public.presence add column if not exists id uuid not null default gen_random_uuid();
do $$
begin
  if exists (select 1 from pg_constraint where conrelid = 'public.presence'::regclass and conname = 'presence_pkey'
             and pg_get_constraintdef(oid) like '%team_id%') then
    alter table public.presence drop constraint presence_pkey;
    alter table public.presence add constraint presence_pkey primary key (id);
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.presence'::regclass and conname = 'presence_identity') then
    alter table public.presence add constraint presence_identity unique (team_id, user_id, device_id, repo, agent);
  end if;
end $$;
alter table public.presence replica identity default;

-- 2 ---------------------------------------------------------------------------
create or replace function public.put_key_envelopes(p_team uuid, p_version int, p_envelopes jsonb)
returns void language plpgsql security definer set search_path = public as $$
declare cur int; e jsonb; dev uuid; owner boolean;
begin
  perform public.require_role(p_team, 'member');
  select key_version into cur from public.teams where id = p_team for update;
  if p_version <> cur and p_version <> cur + 1 then
    raise exception 'key version % is stale (current %)', p_version, cur using errcode = 'PT409';
  end if;
  if p_version = cur + 1 then perform public.require_role(p_team, 'owner'); end if;
  owner := public.has_team_role(p_team, 'owner');
  for e in select * from jsonb_array_elements(p_envelopes) loop
    dev := (e->>'deviceId')::uuid;
    if not exists (select 1 from public.devices d join public.team_members m
                    on m.user_id = d.user_id and m.team_id = p_team where d.id = dev) then
      raise exception 'device % isn''t on this team', dev using errcode = '22023';
    end if;
    if owner then
      insert into public.key_envelopes (team_id, device_id, version, box)
      values (p_team, dev, p_version, e->>'box')
      on conflict (team_id, device_id, version) do update set box = excluded.box;
    else
      -- a member seals the current key for a device that has none; never replaces one
      insert into public.key_envelopes (team_id, device_id, version, box)
      values (p_team, dev, p_version, e->>'box')
      on conflict (team_id, device_id, version) do nothing;
    end if;
  end loop;
  if p_version = cur + 1 then
    update public.teams set key_version = p_version where id = p_team;
    perform public.feed_append(p_team, auth.uid(), 'key_rotated', jsonb_build_object('version', p_version));
  end if;
end $$;

-- 3 ---------------------------------------------------------------------------
revoke execute on function public.team_role(uuid, uuid), public.has_team_role(uuid, text) from anon, public;
grant execute on function public.team_role(uuid, uuid), public.has_team_role(uuid, text) to authenticated;

-- 4 ---------------------------------------------------------------------------
create or replace function public.prune_ephemeral() returns jsonb
language plpgsql security definer set search_path = public as $$
declare p int; l int; i int; f int;
begin
  delete from public.presence where ts < now() - interval '1 hour';
  get diagnostics p = row_count;
  delete from public.leases where ts < now() - interval '1 day';
  get diagnostics l = row_count;
  delete from public.team_invites where expires_at < now() - interval '7 days';
  get diagnostics i = row_count;
  delete from public.feed where ts < now() - interval '90 days';
  get diagnostics f = row_count;
  return jsonb_build_object('presence', p, 'leases', l, 'invites', i, 'feed', f);
end $$;
revoke execute on function public.prune_ephemeral() from anon, authenticated, public;

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('loom-prune-ephemeral', '17 * * * *', 'select public.prune_ephemeral()');
  end if;
exception when others then null; -- no cron here: run prune_ephemeral() from the service role
end $$;


-- 5 ---------------------------------------------------------------------------
-- Team auto-orchestration: a goal owner's orchestra sends single tasks to
-- teammates' shared runners as 'task' jobs; each runs one task with its own
-- agent and pushes a branch back for the owner to integrate.
alter table public.jobs drop constraint if exists jobs_kind_check;
alter table public.jobs add constraint jobs_kind_check check (kind in ('start', 'continue', 'fix', 'return', 'land', 'task'));
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
  if coalesce(j->>'kind', '') not in ('start', 'continue', 'fix', 'return', 'land', 'task') then
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
