-- Fleet contents stay encrypted; membership and author checks live at the hub.
create table public.team_fleets (
  team_id uuid not null references public.teams(id) on delete cascade,
  name text not null check (name ~ '^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$'),
  author uuid not null references auth.users(id),
  sealed jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (team_id, name)
);
alter table public.team_fleets enable row level security;
revoke all on public.team_fleets from anon, authenticated;

create function public.list_team_fleets(p_team uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  perform public.require_role(p_team, 'viewer');
  return coalesce((select jsonb_agg(jsonb_build_object('name', name, 'author', author,
    'sealed', sealed, 'updatedAt', (extract(epoch from updated_at)*1000)::bigint) order by name)
    from public.team_fleets where team_id = p_team), '[]'::jsonb);
end $$;

create function public.put_team_fleet(p_team uuid, p_name text, p_sealed jsonb) returns void
language plpgsql security definer set search_path = public as $$
declare old public.team_fleets;
begin
  perform public.require_role(p_team, 'member');
  -- Serialize first creation too, so competing authors cannot replace each other.
  perform pg_advisory_xact_lock(hashtextextended(p_team::text || '/' || p_name, 0));
  select * into old from public.team_fleets where team_id = p_team and name = p_name;
  if old.author is not null and old.author <> auth.uid() and not public.has_team_role(p_team, 'owner') then
    raise exception 'only the author or team owner may change this fleet' using errcode = '42501';
  end if;
  if p_name is null or p_name !~ '^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$' or
      (p_sealed is not null and (coalesce(p_sealed->>'c', '') = '' or coalesce(p_sealed->>'v', '') !~ '^[1-9][0-9]*$' or length(p_sealed::text) > 16000)) then
    raise exception 'invalid fleet';
  end if;
  if p_sealed is null then
    delete from public.team_fleets where team_id = p_team and name = p_name;
  else
    insert into public.team_fleets(team_id, name, author, sealed) values(p_team, p_name, auth.uid(), p_sealed)
    on conflict(team_id, name) do update set sealed = excluded.sealed, updated_at = now();
  end if;
end $$;

create function public.list_team_invites(p_team uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  perform public.require_role(p_team, 'member');
  return coalesce((select jsonb_agg(jsonb_build_object('id', token_hash, 'createdBy', created_by,
    'expiresAt', (extract(epoch from expires_at)*1000)::bigint) order by expires_at)
    from public.team_invites where team_id = p_team and used_by is null and expires_at > now()
      and (created_by = auth.uid() or public.has_team_role(p_team, 'owner'))), '[]'::jsonb);
end $$;

create function public.revoke_team_invite(p_team uuid, p_id text) returns boolean
language plpgsql security definer set search_path = public as $$
begin
  perform public.require_role(p_team, 'member');
  delete from public.team_invites where team_id = p_team and token_hash = p_id and used_by is null
    and (created_by = auth.uid() or public.has_team_role(p_team, 'owner'));
  return found;
end $$;

revoke all on function public.list_team_fleets(uuid), public.put_team_fleet(uuid,text,jsonb),
  public.list_team_invites(uuid), public.revoke_team_invite(uuid,text) from public, anon;
grant execute on function public.list_team_fleets(uuid), public.put_team_fleet(uuid,text,jsonb),
  public.list_team_invites(uuid), public.revoke_team_invite(uuid,text) to authenticated;

create function public.validate_team_mention() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.type <> 'mention' then return new; end if;
  if not exists (select 1 from public.team_repos where team_id = new.team_id and repo = new.repo) then
    raise exception 'mention repo is not shared' using errcode = '42501';
  end if;
  if not exists (select 1 from public.team_members m join public.profiles p on p.user_id = m.user_id
      where m.team_id = new.team_id and p.github = new.meta->>'to') then
    raise exception 'mention recipient is not a teammate';
  end if;
  if new.sealed is null or coalesce(new.sealed->>'c', '') = '' or coalesce(new.sealed->>'v', '') !~ '^[1-9][0-9]*$' or length(new.sealed::text) > 16000 then raise exception 'mention must be sealed and bounded'; end if;
  return new;
end $$;
create trigger validate_team_mention before insert on public.feed for each row execute function public.validate_team_mention();
revoke all on function public.validate_team_mention() from public, anon, authenticated;


-- Keep the existing feed authorization and crew checks while admitting mentions.
create or replace function public.append_feed(p_team uuid, e jsonb) returns public.feed
language plpgsql security definer set search_path = public as $$
declare dev uuid := nullif(e->>'deviceId', '')::uuid;
  request public.feed; previous public.feed; rid text := e->'meta'->>'requestId';
  expiry numeric; mine text;
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
                          'land_queued', 'land_turn', 'crew_request', 'crew_request_answered', 'mention') then
    raise exception 'members can''t post % events', e->>'type' using errcode = '22023';
  end if;

  if e->>'type' in ('crew_request', 'crew_request_answered') then
    if rid is null or rid !~ '^[a-zA-Z0-9-]{1,80}$' then raise exception 'invalid crew request id' using errcode = '22023'; end if;
    -- Serialize answers and retries for the same request before checking dedupe.
    perform pg_advisory_xact_lock(hashtextextended(p_team::text || ':' || rid, 0));
    select * into request from public.feed where team_id = p_team and type = 'crew_request' and meta->>'requestId' = rid;
    if e->>'type' = 'crew_request' then
      if e->>'dedupeKey' is distinct from 'crew-request:' || rid then raise exception 'invalid crew request dedupe key' using errcode = '22023'; end if;
      if not exists (select 1 from public.team_repos where team_id = p_team and repo = public.normalize_repo(e->>'repo')) then raise exception 'request repo is not shared' using errcode = '42501'; end if;
      if not exists (select 1 from public.team_members m join public.profiles p on p.user_id = m.user_id where m.team_id = p_team and m.role <> 'viewer' and lower(p.github) = lower(e->'meta'->>'owner')) then raise exception 'requested owner is not a member' using errcode = '42501'; end if;
      if coalesce(e->'meta'->>'crew', '') !~ '^[a-z0-9][a-z0-9-]{0,40}$' or coalesce(e->'meta'->>'teammate', '') !~ '^[a-z0-9][a-z0-9-]{0,40}$' then raise exception 'invalid crew or teammate' using errcode = '22023'; end if;
      expiry := (e->'meta'->>'expiresAt')::numeric;
      if expiry is null or expiry <= extract(epoch from now())*1000 or expiry > extract(epoch from now()+interval '7 days')*1000 then raise exception 'crew request expiry must be within seven days' using errcode = '22023'; end if;
      if e->'sealed' is null or e->'sealed' = 'null'::jsonb or octet_length((e->'sealed')::text) > 16000 then raise exception 'crew request text must be sealed and bounded' using errcode = '22023'; end if;
      if request.id is not null and (request.user_id is distinct from auth.uid() or request.meta is distinct from e->'meta' or request.sealed is distinct from e->'sealed') then raise exception 'crew request id already used' using errcode = 'PT409'; end if;
    else
      if request.id is null or request.repo is distinct from e->>'repo' then raise exception 'crew request not found' using errcode = 'P0002'; end if;
      select github into mine from public.profiles where user_id = auth.uid();
      if lower(request.meta->>'owner') is distinct from lower(mine) then raise exception 'only the crew owner may answer' using errcode = '42501'; end if;
      if coalesce(e->'meta'->>'state', '') not in ('accepted', 'declined') or e->>'dedupeKey' is distinct from 'crew-answer:' || rid then raise exception 'invalid crew answer' using errcode = '22023'; end if;
      select * into previous from public.feed where team_id = p_team and type = 'crew_request_answered' and meta->>'requestId' = rid;
      if previous.id is not null and previous.meta->>'state' is distinct from e->'meta'->>'state' then raise exception 'crew request already answered' using errcode = 'PT409'; end if;
      if previous.id is null and (request.meta->>'expiresAt')::numeric <= extract(epoch from now())*1000 then raise exception 'crew request expired' using errcode = 'PT409'; end if;
    end if;
  end if;
  return public.feed_append(p_team, auth.uid(), e->>'type', coalesce(e->'meta', '{}'), e->>'repo',
                            e->'sealed', dev, e->>'sig', e->>'dedupeKey');
end $$;
notify pgrst, 'reload schema';
