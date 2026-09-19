-- A stale key-version write answers 409 instead of hanging (found in Phase 5).
--
-- 0002's put_key_envelopes raised SQLSTATE 40001 (serialization_failure) for
-- "key version is stale". PostgREST treats 40001 as retryable, so on the hosted
-- hub a stale write retried for a minute instead of failing. PT409 is
-- PostgREST's code for a plain HTTP 409, which the client maps like MemoryHub's
-- stale-version conflict. Same function otherwise.

create or replace function public.put_key_envelopes(p_team uuid, p_version int, p_envelopes jsonb)
returns void language plpgsql security definer set search_path = public as $$
declare cur int; e jsonb; dev uuid;
begin
  perform public.require_role(p_team, 'member');
  select key_version into cur from public.teams where id = p_team for update;
  if p_version <> cur and p_version <> cur + 1 then
    raise exception 'key version % is stale (current %)', p_version, cur using errcode = 'PT409';
  end if;
  if p_version = cur + 1 then perform public.require_role(p_team, 'owner'); end if;
  for e in select * from jsonb_array_elements(p_envelopes) loop
    dev := (e->>'deviceId')::uuid;
    if not exists (select 1 from public.devices d join public.team_members m
                    on m.user_id = d.user_id and m.team_id = p_team where d.id = dev) then
      raise exception 'device % isn''t on this team', dev using errcode = '22023';
    end if;
    insert into public.key_envelopes (team_id, device_id, version, box)
    values (p_team, dev, p_version, e->>'box')
    on conflict (team_id, device_id, version) do update set box = excluded.box;
  end loop;
  if p_version = cur + 1 then
    update public.teams set key_version = p_version where id = p_team;
    perform public.feed_append(p_team, auth.uid(), 'key_rotated', jsonb_build_object('version', p_version));
  end if;
end $$;
