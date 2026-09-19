-- Loom Teams — what the hosted hub client (src/hub/supabase-client.ts) needs
-- beyond 0002–0004, so every HubClient method has a rule on the hosted hub:
--
--   extend_lease       MemoryHub.extendLease: widen your own lease (drift, D33);
--                      only the new part is judged, a held hard zone refuses
--                      (D31) — under the same per-team advisory lock as claim_lease
--   team_member_list   MemoryHub.members: members with their GitHub login, role
--                      and devices in one call, refusing non-members (RLS alone
--                      would answer them with an empty list)
--
-- Everything else maps onto 0002–0004 directly: me/teams/repos/presence/feed/
-- leases/memories/key envelopes are RLS-guarded selects.

-- a ∪ b, first-seen order, at most n — MemoryHub's [...new Set([...a, ...b])].slice(0, n)
create or replace function public.array_union_ordered(a text[], b text[], n int) returns text[]
language sql immutable as $$
  select coalesce(array_agg(x order by o), '{}') from (
    select x, min(o) o from unnest(coalesce(a, '{}') || coalesce(b, '{}')) with ordinality t(x, o)
    group by x order by min(o) limit n
  ) s
$$;

-- Returns {lease, overlaps:[{lease, paths}], blockedBy?:{lease, zone}} — claim_lease's shape.
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

  zone := public.lease_zone(f, pr, zones);
  if zone is not null then
    select * into holder from public.leases x
     where x.team_id = p_team and x.repo = l.repo and x.run_id <> l.run_id
       and x.ts > now() - interval '10 minutes'
       and public.lease_zone(x.files, x.prefixes, array[zone]) = zone
     limit 1;
    if holder.id is not null then
      return jsonb_build_object('lease', null, 'overlaps', ov,
        'blockedBy', jsonb_build_object('lease', to_jsonb(holder), 'zone', zone));
    end if;
  end if;

  update public.leases set
    globs = public.array_union_ordered(l.globs, g, 50),
    files = public.array_union_ordered(l.files, f, 500),
    prefixes = public.array_union_ordered(l.prefixes, pr, 50),
    ts = now()
  where id = l.id
  returning * into l;
  return jsonb_build_object('lease', to_jsonb(l), 'overlaps', ov);
end $$;

-- MemoryHub.members: [{user:{id,github,name}, role, joinedAt, devices:[{id,userId,label,sealPub,signPub,createdAt}]}]
create or replace function public.team_member_list(p_team uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  perform public.require_role(p_team, 'viewer');
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'user', jsonb_build_object('id', m.user_id, 'github', coalesce(p.github, ''), 'name', coalesce(p.name, '')),
      'role', m.role,
      'joinedAt', (extract(epoch from m.joined_at) * 1000)::bigint,
      'devices', coalesce((
        select jsonb_agg(jsonb_build_object(
          'id', d.id, 'userId', d.user_id, 'label', d.label, 'sealPub', d.seal_pub, 'signPub', d.sign_pub,
          'createdAt', (extract(epoch from d.created_at) * 1000)::bigint) order by d.created_at)
        from public.devices d where d.user_id = m.user_id), '[]'::jsonb)
    ) order by m.joined_at)
    from public.team_members m left join public.profiles p on p.user_id = m.user_id
    where m.team_id = p_team), '[]'::jsonb);
end $$;

grant execute on function public.extend_lease(uuid, uuid, jsonb, jsonb), public.team_member_list(uuid) to authenticated;
revoke execute on function public.extend_lease(uuid, uuid, jsonb, jsonb), public.team_member_list(uuid) from anon, public;

-- PostgREST: pick up the new functions now
notify pgrst, 'reload schema';
