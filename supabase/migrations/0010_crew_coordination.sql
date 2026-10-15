-- Agent Teams P4. Review and apply separately; never applied by the client.
-- Sealed owner-approved requests and crew controls at full runner capacity.

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
                          'land_queued', 'land_turn', 'crew_request', 'crew_request_answered') then
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


drop function public.claim_job(uuid, uuid);
create or replace function public.claim_job(p_team uuid, p_runner uuid, p_instant_only boolean default false) returns public.jobs
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
     and (not p_instant_only or x.kind in ('return', 'land'))
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
revoke all on function public.claim_job(uuid, uuid, boolean) from public, anon;
grant execute on function public.claim_job(uuid, uuid, boolean) to authenticated;
notify pgrst, 'reload schema';
