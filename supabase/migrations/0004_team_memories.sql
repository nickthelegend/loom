-- Loom Teams, Phase 3 ("one brain") — team memories on the hosted Team Hub.
--
-- Mirrors src/core/team-hub.ts (MemoryHub.publishMemory & co.). Decisions
-- (docs/teams-architecture.md §1a):
--   D40  only a memory's author edits or forgets it; a teammate records a
--        correction that `supersedes` it
--   D41  an exact duplicate (same HMAC of the normalized text under the team
--        key) from another member merges as a confirmation
--   D47  resolving a contradiction supersedes the loser — it's kept, linked to
--        the winner, and the winner inherits its confirmations
--   D51  memories belong to one shared repo, never across
--
-- The text rides in `sealed`, which the hub cannot read; the HMAC is the only
-- handle it has on content, and it's keyed, so it reveals nothing either.

create table if not exists public.team_memories (
  id              text not null check (id ~ '^[A-Za-z0-9_-]{4,64}$'),
  team_id         uuid not null references public.teams (id) on delete cascade,
  repo            text not null,
  author_id       uuid not null references auth.users (id) on delete cascade,
  author          text not null,
  hmac            text not null check (char_length(hmac) <= 128),
  sealed          jsonb not null,
  state           text not null default 'live' check (state in ('live', 'superseded', 'forgotten')),
  supersedes      text,
  superseded_by   text,
  resolved_by     text,
  resolved_reason text,
  confirmed_by    text[] not null default '{}',
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  primary key (team_id, id)
);
create index if not exists team_memories_repo_idx on public.team_memories (team_id, repo, state);
create index if not exists team_memories_hmac_idx on public.team_memories (team_id, repo, hmac) where state = 'live';

alter table public.team_memories enable row level security;
drop policy if exists "team_memories: members" on public.team_memories;
create policy "team_memories: members" on public.team_memories for select to authenticated
  using (public.has_team_role(team_id, 'viewer'));
revoke insert, update, delete on public.team_memories from anon, authenticated;
grant select on public.team_memories to authenticated;

-- ---------------------------------------------------------------------------
-- Rule functions
-- ---------------------------------------------------------------------------

-- Publish (or re-publish) a memory. Returns {memory, merged}.
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
    supersedes = coalesce(excluded.supersedes, team_memories.supersedes), updated_at = now()
  returning * into out;
  return jsonb_build_object('memory', to_jsonb(out), 'merged', false);
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
  update public.team_memories set hmac = p_hmac, sealed = p_sealed, updated_at = now()
   where team_id = p_team and id = p_id returning * into out;
  return out;
end $$;

create or replace function public.forget_team_memory(p_team uuid, p_id text, p_reason text) returns void
language plpgsql security definer set search_path = public as $$
declare cur public.team_memories;
begin
  perform public.require_role(p_team, 'member');
  select * into cur from public.team_memories where team_id = p_team and id = p_id;
  if cur.id is null then raise exception 'no team memory "%"', p_id using errcode = 'P0002'; end if;
  if cur.author_id <> auth.uid() then
    raise exception 'only its author can change a memory — record a correction instead' using errcode = '42501';
  end if;
  update public.team_memories set state = 'forgotten', resolved_reason = left(coalesce(p_reason, ''), 200), updated_at = now()
   where team_id = p_team and id = p_id;
end $$;

-- Any member may settle a contradiction: the loser is kept, superseded, linked (D47).
create or replace function public.resolve_memories(p_team uuid, p_winner text, p_loser text, p_reason text)
returns public.team_memories
language plpgsql security definer set search_path = public as $$
declare w public.team_memories; l public.team_memories;
  me text := (select github from public.profiles where user_id = auth.uid());
begin
  perform public.require_role(p_team, 'member');
  if p_winner = p_loser then raise exception 'a memory can''t supersede itself' using errcode = '22023'; end if;
  select * into w from public.team_memories where team_id = p_team and id = p_winner for update;
  select * into l from public.team_memories where team_id = p_team and id = p_loser for update;
  if w.id is null or l.id is null then raise exception 'both memories must exist' using errcode = 'P0002'; end if;
  update public.team_memories
     set state = 'superseded', superseded_by = p_winner, resolved_by = me,
         resolved_reason = left(coalesce(p_reason, ''), 200), updated_at = now()
   where team_id = p_team and id = p_loser returning * into l;
  update public.team_memories
     set confirmed_by = confirmed_by || array(select g from unnest(l.confirmed_by) g where not g = any(w.confirmed_by)),
         updated_at = now()
   where team_id = p_team and id = p_winner;
  perform public.feed_append(p_team, auth.uid(), 'memory_resolved',
    jsonb_build_object('winner', p_winner, 'loser', p_loser, 'reason', left(coalesce(p_reason, ''), 200)), l.repo);
  return l;
end $$;

-- Members may now also post canon proposals to the feed.
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
                          'overlap_decided', 'drift', 'zone_waiting', 'conflict_predicted', 'canon_proposed') then
    raise exception 'members can''t post % events', e->>'type' using errcode = '22023';
  end if;
  return public.feed_append(p_team, auth.uid(), e->>'type', coalesce(e->'meta', '{}'), e->>'repo',
                            e->'sealed', dev, e->>'sig', e->>'dedupeKey');
end $$;

grant execute on function public.publish_memory(uuid, jsonb), public.update_team_memory(uuid, text, text, jsonb),
  public.forget_team_memory(uuid, text, text), public.resolve_memories(uuid, text, text, text) to authenticated;
revoke execute on function public.publish_memory(uuid, jsonb), public.update_team_memory(uuid, text, text, jsonb),
  public.forget_team_memory(uuid, text, text), public.resolve_memories(uuid, text, text, text) from anon, public;

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    begin alter publication supabase_realtime add table public.team_memories; exception when duplicate_object then null; end;
  end if;
end $$;
