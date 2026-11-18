-- #431: the hosted hub's half of two fixes the reference hub (src/core/team-hub.ts) got too.
--
--   lease_zones      every hard zone a scope touches. claim_lease and extend_lease
--                    used lease_zone, which stops at the first, so a claim spanning
--                    src/auth/** and db/migrations/** was let through whenever the
--                    first zone was free, even with the second already held (D31).
--   confirmations    an author's edit kept confirmed_by, so the new text showed as
--                    confirmed by teammates who only ever confirmed the old one (D41).
--                    A content change (a new hmac) now starts confirmations over.
--
-- CREATE OR REPLACE keeps each function's grants.

create or replace function public.lease_zones(files text[], prefixes text[], zones text[]) returns text[]
language sql immutable as $$
  select coalesce(array_agg(z order by o), '{}')
    from unnest(coalesce(zones, '{}')) with ordinality t(z, o)
   where public.lease_zone(files, prefixes, array[z]) is not null
$$;

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

  -- every hard zone the claim touches, not only the first one listed
  foreach zone in array public.lease_zones(f, pr, zones) loop
    select * into holder from public.leases x
     where x.team_id = p_team and x.repo = r and x.run_id <> c->>'runId'
       and x.ts > now() - interval '10 minutes'
       and public.lease_zone(x.files, x.prefixes, array[zone]) = zone
     limit 1;
    if holder.id is not null then
      return jsonb_build_object('lease', null, 'overlaps', ov,
        'blockedBy', jsonb_build_object('lease', to_jsonb(holder), 'zone', zone));
    end if;
  end loop;

  insert into public.leases (team_id, user_id, device_id, repo, run_id, task_id, globs, files, prefixes, sealed)
  values (p_team, auth.uid(), dev, r, c->>'runId', c->>'taskId', g, f, pr, c->'sealed')
  on conflict (team_id, user_id, run_id, task_id) do update set
    device_id = excluded.device_id, globs = excluded.globs, files = excluded.files,
    prefixes = excluded.prefixes, sealed = excluded.sealed, state = 'active', ts = now()
  returning * into l;
  return jsonb_build_object('lease', to_jsonb(l), 'overlaps', ov);
end $$;

create or replace function public.extend_lease(p_team uuid, p_lease uuid, scope jsonb, hard_zones jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  g text[] := coalesce((select array_agg(x) from (select jsonb_array_elements_text(scope->'globs') x limit 50) s), '{}');
  f text[] := coalesce((select array_agg(x) from (select jsonb_array_elements_text(scope->'files') x limit 500) s), '{}');
  pr text[] := coalesce((select array_agg(x) from (select jsonb_array_elements_text(scope->'prefixes') x limit 50) s), '{}');
  zones text[] := coalesce((select array_agg(x) from jsonb_array_elements_text(hard_zones) x), '{}');
  zone text; holder public.leases; l public.leases; ov jsonb;
begin
  perform public.require_role(p_team, 'member');
  -- the same lock as claim_lease: a widening and a claim can't both take a hard zone (D31)
  perform pg_advisory_xact_lock(hashtext('loom-leases:' || p_team::text));
  select * into l from public.leases where id = p_lease and team_id = p_team for update;
  if l.id is null or l.user_id <> auth.uid() then
    raise exception 'that lease isn''t yours' using errcode = '42501';
  end if;

  -- only the NEW part is judged — what was already held stays held
  select coalesce(jsonb_agg(jsonb_build_object('lease', to_jsonb(o) - 'p', 'paths', to_jsonb(o.p))), '[]') into ov
  from (select x.*, public.lease_overlap(g, f, pr, x.globs, x.files, x.prefixes) p
          from public.leases x
         where x.team_id = p_team and x.repo = l.repo and x.run_id <> l.run_id
           and x.ts > now() - interval '10 minutes') o
  where cardinality(o.p) > 0;

  foreach zone in array public.lease_zones(f, pr, zones) loop
    select * into holder from public.leases x
     where x.team_id = p_team and x.repo = l.repo and x.run_id <> l.run_id
       and x.ts > now() - interval '10 minutes'
       and public.lease_zone(x.files, x.prefixes, array[zone]) = zone
     limit 1;
    if holder.id is not null then
      return jsonb_build_object('lease', null, 'overlaps', ov,
        'blockedBy', jsonb_build_object('lease', to_jsonb(holder), 'zone', zone));
    end if;
  end loop;

  update public.leases set
    globs = public.array_union_ordered(l.globs, g, 50),
    files = public.array_union_ordered(l.files, f, 500),
    prefixes = public.array_union_ordered(l.prefixes, pr, 50),
    ts = now()
  where id = l.id
  returning * into l;
  return jsonb_build_object('lease', to_jsonb(l), 'overlaps', ov);
end $$;

create or replace function public.update_team_memory(p_team uuid, p_id text, p_hmac text, p_sealed jsonb)
returns public.team_memories
language plpgsql security definer set search_path = public as $$
declare out public.team_memories;
begin
  perform public.require_role(p_team, 'member');
  select * into out from public.team_memories where team_id = p_team and id = p_id;
  if out.id is null then raise exception 'no team memory "%"', p_id using errcode = 'P0002'; end if;
  if out.author_id <> auth.uid() then
    raise exception 'only its author can change a memory — record a correction instead' using errcode = '42501';
  end if;
  update public.team_memories set hmac = p_hmac, sealed = p_sealed, updated_at = now(),
         -- teammates confirmed the old words, not these
         confirmed_by = case when hmac = p_hmac then confirmed_by else array[author] end
   where team_id = p_team and id = p_id returning * into out;
  return out;
end $$;

create or replace function public.publish_memory(p_team uuid, m jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  r text := public.normalize_repo(m->>'repo');
  dev uuid := (m->>'deviceId')::uuid;
  mid text := m->>'id';
  me text := (select github from public.profiles where user_id = auth.uid());
  own public.team_memories; twin public.team_memories; out public.team_memories;
begin
  perform public.require_role(p_team, 'member');
  if not exists (select 1 from public.devices where id = dev and user_id = auth.uid()) then
    raise exception 'that device isn''t yours' using errcode = '42501';
  end if;
  if not exists (select 1 from public.team_repos where team_id = p_team and repo = r) then
    raise exception '% isn''t shared with this team', r using errcode = '42501';
  end if;
  if mid is null or mid !~ '^[A-Za-z0-9_-]{4,64}$' then raise exception 'bad memory id' using errcode = '22023'; end if;
  if coalesce(m->>'hmac', '') = '' or coalesce(m->'sealed'->>'c', '') = '' then
    raise exception 'a team memory needs its hmac and sealed content' using errcode = '22023';
  end if;
  -- one publisher at a time per team+repo, so two twins can't both land as new
  perform pg_advisory_xact_lock(hashtext('loom-memories:' || p_team::text || ':' || r));

  select * into own from public.team_memories where team_id = p_team and id = mid;
  if own.id is not null and own.author_id <> auth.uid() then
    raise exception 'that memory id belongs to someone else' using errcode = '42501';
  end if;

  if own.id is null then
    select * into twin from public.team_memories
     where team_id = p_team and repo = r and hmac = m->>'hmac' and state = 'live' and id <> mid
     limit 1;
    if twin.id is not null then
      update public.team_memories
         set confirmed_by = case when me = any(confirmed_by) then confirmed_by else confirmed_by || me end,
             updated_at = now()
       where team_id = p_team and id = twin.id
       returning * into out;
      return jsonb_build_object('memory', to_jsonb(out), 'merged', true);
    end if;
  end if;

  if m->>'supersedes' is not null and not exists
       (select 1 from public.team_memories where team_id = p_team and id = m->>'supersedes') then
    raise exception 'no team memory "%" to supersede', m->>'supersedes' using errcode = 'P0002';
  end if;

  insert into public.team_memories (id, team_id, repo, author_id, author, hmac, sealed, supersedes, confirmed_by)
  values (mid, p_team, r, auth.uid(), me, m->>'hmac', m->'sealed', m->>'supersedes', array[me])
  on conflict (team_id, id) do update set
    hmac = excluded.hmac, sealed = excluded.sealed, state = 'live',
    -- a re-publish with different words starts its confirmations over
    confirmed_by = case when team_memories.hmac = excluded.hmac then team_memories.confirmed_by else excluded.confirmed_by end,
    supersedes = coalesce(excluded.supersedes, team_memories.supersedes), updated_at = now()
  returning * into out;
  return jsonb_build_object('memory', to_jsonb(out), 'merged', false);
end $$;

grant execute on function public.lease_zones(text[], text[], text[]) to authenticated;
