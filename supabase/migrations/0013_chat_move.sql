-- Chat transfers use the same sealed job transport and runner authorization.
alter table public.jobs drop constraint if exists jobs_kind_check;
alter table public.jobs add constraint jobs_kind_check check (kind in ('start', 'continue', 'fix', 'return', 'land', 'task', 'chat_move'));
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
  if coalesce(j->>'kind', '') not in ('start', 'continue', 'fix', 'return', 'land', 'task', 'chat_move') then
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
