-- Loom Teams, Phase 2 ("stop colliding") — leases on the hosted Team Hub.
--
-- Mirrors src/core/team-hub.ts (MemoryHub.claimLease & co.) and the overlap
-- rules of src/core/team-leases.ts. Decisions (docs/teams-architecture.md §1a):
--   D28  a lease carries its globs, the real files they matched, and literal
--        directory prefixes; overlap = a shared file, or a path under a prefix
--   D31  a hard zone refuses a second claim (atomically, under a team lock)
--   D12  a lease not renewed for 10 minutes is stale and stops blocking
--   D36  leases live as `active`, then `landing`, until the goal's PR merges
--
-- The hub computes collisions on plain metadata (paths are metadata — D2); the
-- goal/task titles ride in `sealed`, which it cannot read.

create table if not exists public.leases (
  id        uuid primary key default gen_random_uuid(),
  team_id   uuid not null references public.teams (id) on delete cascade,
  user_id   uuid not null references auth.users (id) on delete cascade,
  device_id uuid not null references public.devices (id) on delete cascade,
  repo      text not null,
  run_id    text not null check (char_length(run_id) <= 64),
  task_id   text not null check (char_length(task_id) <= 32),
  globs     text[] not null default '{}',
  files     text[] not null default '{}',
  prefixes  text[] not null default '{}',
  state     text not null default 'active' check (state in ('active', 'landing')),
  sealed    jsonb,
  since     timestamptz not null default now(),
  ts        timestamptz not null default now(),
  unique (team_id, user_id, run_id, task_id)
);
create index if not exists leases_team_repo_idx on public.leases (team_id, repo);

alter table public.leases enable row level security;
drop policy if exists "leases: members" on public.leases;
create policy "leases: members" on public.leases for select to authenticated using (public.has_team_role(team_id, 'viewer'));
revoke insert, update, delete on public.leases from anon, authenticated;
grant select on public.leases to authenticated;

-- ---------------------------------------------------------------------------
-- Glob and overlap, in SQL (same semantics as team-leases.ts)
-- ---------------------------------------------------------------------------

-- A glob as a POSIX regex: ** spans directories, * and ? don't. A bare path
-- (no wildcard) means itself or anything under it.
create or replace function public.glob_regex(g text) returns text
language plpgsql immutable as $$
declare out text := ''; i int := 1; c text; n int := char_length(g);
begin
  g := regexp_replace(regexp_replace(g, '^\./', ''), '^/+', '');
  if g !~ '[*?{]' then
    return '^' || regexp_replace(regexp_replace(g, '/$', ''), '([.+^$()|\[\]\\])', '\\\1', 'g') || '(/.*)?$';
  end if;
  while i <= char_length(g) loop
    c := substr(g, i, 1);
    if c = '*' then
      if substr(g, i + 1, 1) = '*' then
        if substr(g, i + 2, 1) = '/' then out := out || '(.*/)?'; i := i + 3; continue; end if;
        out := out || '.*'; i := i + 2; continue;
      end if;
      out := out || '[^/]*';
    elsif c = '?' then out := out || '[^/]';
    elsif c in ('.', '+', '^', '$', '(', ')', '|', '[', ']', '\') then out := out || '\' || c;
    else out := out || c;
    end if;
    i := i + 1;
  end loop;
  return '^' || out || '$';
end $$;

create or replace function public.path_under(p text, prefix text) returns boolean
language sql immutable as $$
  select case
    when prefix = '' then true
    when right(prefix, 1) = '/' then left(p, char_length(prefix)) = prefix
    else p = prefix or left(p, char_length(prefix) + 1) = prefix || '/'
  end
$$;

-- The colliding paths between two scopes (empty when none).
create or replace function public.lease_overlap(
  a_globs text[], a_files text[], a_prefixes text[],
  b_globs text[], b_files text[], b_prefixes text[]) returns text[]
language sql immutable as $$
  select coalesce(array_agg(distinct x order by x), '{}') from (
    select f as x from unnest(a_files) f where f = any(b_files)
    union
    select f from unnest(a_files) f
      where exists (select 1 from unnest(b_prefixes) p where p <> '' and public.path_under(f, p))
        and exists (select 1 from unnest(b_globs) g where f ~ public.glob_regex(g))
    union
    select f from unnest(b_files) f
      where exists (select 1 from unnest(a_prefixes) p where p <> '' and public.path_under(f, p))
        and exists (select 1 from unnest(a_globs) g where f ~ public.glob_regex(g))
    union
    select case when char_length(pa) >= char_length(pb) then pa else pb end
      from unnest(a_prefixes) pa, unnest(b_prefixes) pb
      where pa <> '' and pb <> '' and (public.path_under(pa, pb) or public.path_under(pb, pa))
  ) s
$$;

-- The first hard zone a scope touches, or null.
create or replace function public.lease_zone(files text[], prefixes text[], zones text[]) returns text
language plpgsql immutable as $$
declare z text; zp text;
begin
  foreach z in array coalesce(zones, '{}') loop
    zp := case when z !~ '[*?{]' then z else
      coalesce(substring(substring(z from '^[^*?{]*') from '^(.*/)'), '') end;
    if exists (select 1 from unnest(files) f where f ~ public.glob_regex(z)) then return z; end if;
    if exists (select 1 from unnest(prefixes) p where p <> ''
                 and (public.path_under(p, zp) or (zp <> '' and public.path_under(zp, p)))) then return z; end if;
  end loop;
  return null;
end $$;

-- ---------------------------------------------------------------------------
-- Rule functions
-- ---------------------------------------------------------------------------

-- Claim (or re-claim) a lease. Returns {lease, overlaps:[{lease, paths}], blockedBy?:{lease, zone}}.
create or replace function public.claim_lease(p_team uuid, c jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  r text := public.normalize_repo(c->>'repo');
  dev uuid := (c->>'deviceId')::uuid;
  g text[] := coalesce((select array_agg(x) from (select jsonb_array_elements_text(c->'globs') x limit 50) s), '{}');
  f text[] := coalesce((select array_agg(x) from (select jsonb_array_elements_text(c->'files') x limit 500) s), '{}');
  pr text[] := coalesce((select array_agg(x) from (select jsonb_array_elements_text(c->'prefixes') x limit 50) s), '{}');
  zones text[] := coalesce((select array_agg(x) from jsonb_array_elements_text(c->'hardZones') x), '{}');
  zone text; holder public.leases; l public.leases; ov jsonb;
begin
  perform public.require_role(p_team, 'member');
  if not exists (select 1 from public.devices where id = dev and user_id = auth.uid()) then
    raise exception 'that device isn''t yours' using errcode = '42501';
  end if;
  if not exists (select 1 from public.team_repos where team_id = p_team and repo = r) then
    raise exception '% isn''t shared with this team', r using errcode = '42501';
  end if;
  -- one claimer at a time per team: hard zones are decided atomically (D31)
  perform pg_advisory_xact_lock(hashtext('loom-leases:' || p_team::text));

  select coalesce(jsonb_agg(jsonb_build_object('lease', to_jsonb(o), 'paths', to_jsonb(o.p))), '[]') into ov
  from (select x.*, public.lease_overlap(g, f, pr, x.globs, x.files, x.prefixes) p
          from public.leases x
         where x.team_id = p_team and x.repo = r and x.run_id <> c->>'runId'
           and x.ts > now() - interval '10 minutes') o
  where cardinality(o.p) > 0;

  zone := public.lease_zone(f, pr, zones);
  if zone is not null then
    select * into holder from public.leases x
     where x.team_id = p_team and x.repo = r and x.run_id <> c->>'runId'
       and x.ts > now() - interval '10 minutes'
       and public.lease_zone(x.files, x.prefixes, array[zone]) = zone
     limit 1;
    if holder.id is not null then
      return jsonb_build_object('lease', null, 'overlaps', ov,
        'blockedBy', jsonb_build_object('lease', to_jsonb(holder), 'zone', zone));
    end if;
  end if;

  insert into public.leases (team_id, user_id, device_id, repo, run_id, task_id, globs, files, prefixes, sealed)
  values (p_team, auth.uid(), dev, r, c->>'runId', c->>'taskId', g, f, pr, c->'sealed')
  on conflict (team_id, user_id, run_id, task_id) do update set
    device_id = excluded.device_id, globs = excluded.globs, files = excluded.files,
    prefixes = excluded.prefixes, sealed = excluded.sealed, state = 'active', ts = now()
  returning * into l;
  return jsonb_build_object('lease', to_jsonb(l), 'overlaps', ov);
end $$;

create or replace function public.renew_leases(p_team uuid, p_device uuid) returns int
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  perform public.require_role(p_team, 'member');
  update public.leases set ts = now() where team_id = p_team and user_id = auth.uid() and device_id = p_device;
  get diagnostics n = row_count;
  return n;
end $$;

create or replace function public.set_run_lease_state(p_team uuid, p_run text, p_state text) returns int
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  perform public.require_role(p_team, 'member');
  if p_state not in ('active', 'landing') then raise exception 'bad state' using errcode = '22023'; end if;
  update public.leases set state = p_state, ts = now()
   where team_id = p_team and user_id = auth.uid() and run_id = p_run and state <> p_state;
  get diagnostics n = row_count;
  return n;
end $$;

create or replace function public.release_leases(p_team uuid, p_run text, p_reason text) returns int
language plpgsql security definer set search_path = public as $$
declare n int; r text;
begin
  perform public.require_role(p_team, 'member');
  select repo into r from public.leases where team_id = p_team and user_id = auth.uid() and run_id = p_run limit 1;
  delete from public.leases where team_id = p_team and user_id = auth.uid() and run_id = p_run;
  get diagnostics n = row_count;
  if n > 0 then
    perform public.feed_append(p_team, auth.uid(), 'lease_released',
      jsonb_build_object('runId', p_run, 'leases', n, 'reason', left(coalesce(p_reason, ''), 120)), r);
  end if;
  return n;
end $$;

-- Members may now also post the Phase 2 coordination events.
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
                          'overlap_decided', 'drift', 'zone_waiting', 'conflict_predicted') then
    raise exception 'members can''t post % events', e->>'type' using errcode = '22023';
  end if;
  return public.feed_append(p_team, auth.uid(), e->>'type', coalesce(e->'meta', '{}'), e->>'repo',
                            e->'sealed', dev, e->>'sig', e->>'dedupeKey');
end $$;

-- removing a member drops their leases too
create or replace function public.drop_member_leases() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  delete from public.leases where team_id = old.team_id and user_id = old.user_id;
  return old;
end $$;
drop trigger if exists on_member_removed_leases on public.team_members;
create trigger on_member_removed_leases after delete on public.team_members
  for each row execute function public.drop_member_leases();

grant execute on function public.claim_lease(uuid, jsonb), public.renew_leases(uuid, uuid),
  public.set_run_lease_state(uuid, text, text), public.release_leases(uuid, text, text) to authenticated;
revoke execute on function public.claim_lease(uuid, jsonb), public.renew_leases(uuid, uuid),
  public.set_run_lease_state(uuid, text, text), public.release_leases(uuid, text, text) from anon, public;

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    begin alter publication supabase_realtime add table public.leases; exception when duplicate_object then null; end;
  end if;
end $$;
