-- Loom Teams, Phase 1 ("see each other") — the hosted Team Hub.
--
-- The same rules as the reference hub (src/core/team-hub.ts#MemoryHub), as
-- row-level security plus SECURITY DEFINER functions. Decisions it implements
-- (docs/teams-architecture.md §1a):
--   D2  content (titles, intent, summaries) arrives sealed — `sealed` jsonb is
--       ciphertext the hub cannot read; metadata (who, agent, state, branch,
--       file globs) is plain so the hub can reason over it
--   D3  a team is people; repos are shared into it
--   D4  every member is a GitHub login (profiles.github, from GitHub OAuth)
--   D5  invites are single-use, expiring, and never carry the key (the key
--       rides the link's #fragment, which never reaches this database)
--   D6  key envelopes are per device and per version; versions only move forward
--
-- Clients read through RLS-guarded selects and write only through the
-- functions below, which is where the rules live. Realtime: presence and feed
-- are published, and RLS decides who hears what.

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table if not exists public.profiles (
  user_id uuid primary key references auth.users (id) on delete cascade,
  github  text not null unique check (github ~ '^[a-z0-9](?:[a-z0-9-]{0,38})$'),
  name    text not null default ''
);

create table if not exists public.teams (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (char_length(name) between 1 and 80),
  key_version int  not null default 1,
  created_at  timestamptz not null default now()
);

create table if not exists public.team_members (
  team_id   uuid not null references public.teams (id) on delete cascade,
  user_id   uuid not null references auth.users (id) on delete cascade,
  role      text not null check (role in ('owner', 'member', 'viewer')),
  joined_at timestamptz not null default now(),
  primary key (team_id, user_id)
);

create table if not exists public.devices (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users (id) on delete cascade,
  label      text not null default 'device',
  seal_pub   text not null,
  sign_pub   text not null,
  created_at timestamptz not null default now(),
  unique (user_id, sign_pub)
);

create table if not exists public.team_invites (
  token_hash text primary key,              -- sha256 of the invite token; the token itself is never stored
  team_id    uuid not null references public.teams (id) on delete cascade,
  created_by uuid not null references auth.users (id),
  expires_at timestamptz not null,
  used_by    uuid references auth.users (id)
);

create table if not exists public.key_envelopes (
  team_id   uuid not null references public.teams (id) on delete cascade,
  device_id uuid not null references public.devices (id) on delete cascade,
  version   int  not null,
  box       text not null,                  -- the team key sealed to this device's X25519 key
  primary key (team_id, device_id, version)
);

create table if not exists public.team_repos (
  team_id uuid not null references public.teams (id) on delete cascade,
  repo    text not null check (repo ~ '^[a-z0-9_.-]+/[a-z0-9_.-]+$'),
  primary key (team_id, repo)
);

create table if not exists public.presence (
  team_id   uuid not null references public.teams (id) on delete cascade,
  user_id   uuid not null references auth.users (id) on delete cascade,
  device_id uuid not null references public.devices (id) on delete cascade,
  repo      text not null,
  agent     text not null check (char_length(agent) <= 120),
  kind      text not null,
  run_id    text,
  task_id   text,
  branch    text,
  touches   text[] not null default '{}',
  state     text not null check (state in ('idle', 'planning', 'running', 'reviewing', 'waiting_human', 'ci')),
  since     timestamptz not null,
  sealed    jsonb,
  sig       text,
  ts        timestamptz not null default now(),
  primary key (team_id, user_id, device_id, repo, agent)
);

create table if not exists public.feed (
  id         bigserial primary key,
  team_id    uuid not null references public.teams (id) on delete cascade,
  repo       text,
  user_id    uuid references auth.users (id) on delete set null,
  type       text not null,
  meta       jsonb not null default '{}',
  sealed     jsonb,
  device_id  uuid,
  sig        text,
  dedupe_key text,
  ts         timestamptz not null default now(),
  unique (team_id, dedupe_key)
);
create index if not exists feed_team_id_idx on public.feed (team_id, id);

-- ---------------------------------------------------------------------------
-- Membership helpers (SECURITY DEFINER so RLS policies can call them without
-- recursing into team_members' own policy)
-- ---------------------------------------------------------------------------

create or replace function public.team_role(p_team uuid, p_user uuid default auth.uid())
returns text language sql stable security definer set search_path = public as $$
  select role from public.team_members where team_id = p_team and user_id = p_user
$$;

create or replace function public.has_team_role(p_team uuid, p_min text)
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce(
    (select case role when 'owner' then 2 when 'member' then 1 else 0 end
       from public.team_members where team_id = p_team and user_id = auth.uid())
    >= case p_min when 'owner' then 2 when 'member' then 1 else 0 end,
    false)
$$;

-- ---------------------------------------------------------------------------
-- Row-level security: reads for members, writes only through functions
-- ---------------------------------------------------------------------------

alter table public.profiles      enable row level security;
alter table public.teams         enable row level security;
alter table public.team_members  enable row level security;
alter table public.devices       enable row level security;
alter table public.team_invites  enable row level security;
alter table public.key_envelopes enable row level security;
alter table public.team_repos    enable row level security;
alter table public.presence      enable row level security;
alter table public.feed          enable row level security;

drop policy if exists "profiles: self and teammates" on public.profiles;
create policy "profiles: self and teammates" on public.profiles for select to authenticated using (
  user_id = auth.uid() or exists (
    select 1 from public.team_members a join public.team_members b on a.team_id = b.team_id
    where a.user_id = auth.uid() and b.user_id = profiles.user_id));

drop policy if exists "teams: members" on public.teams;
create policy "teams: members" on public.teams for select to authenticated using (public.has_team_role(id, 'viewer'));

drop policy if exists "team_members: members" on public.team_members;
create policy "team_members: members" on public.team_members for select to authenticated using (public.has_team_role(team_id, 'viewer'));

drop policy if exists "devices: own and teammates'" on public.devices;
create policy "devices: own and teammates'" on public.devices for select to authenticated using (
  user_id = auth.uid() or exists (
    select 1 from public.team_members a join public.team_members b on a.team_id = b.team_id
    where a.user_id = auth.uid() and b.user_id = devices.user_id));

-- Envelopes: only the device's owner reads their own. Nobody else, ever.
drop policy if exists "key_envelopes: own devices" on public.key_envelopes;
create policy "key_envelopes: own devices" on public.key_envelopes for select to authenticated using (
  exists (select 1 from public.devices d where d.id = device_id and d.user_id = auth.uid())
  and public.has_team_role(team_id, 'viewer'));

drop policy if exists "team_repos: members" on public.team_repos;
create policy "team_repos: members" on public.team_repos for select to authenticated using (public.has_team_role(team_id, 'viewer'));

-- Presence: members see live sessions (the TTL mirrors PRESENCE_TTL_MS).
drop policy if exists "presence: members, live" on public.presence;
create policy "presence: members, live" on public.presence for select to authenticated using (
  public.has_team_role(team_id, 'viewer') and ts > now() - interval '45 seconds');

drop policy if exists "feed: members" on public.feed;
create policy "feed: members" on public.feed for select to authenticated using (public.has_team_role(team_id, 'viewer'));

-- No insert/update/delete policies: every write goes through a function below.
revoke insert, update, delete on public.profiles, public.teams, public.team_members, public.devices,
  public.team_invites, public.key_envelopes, public.team_repos, public.presence, public.feed
  from anon, authenticated;
revoke all on public.team_invites from anon, authenticated;
grant select on public.profiles, public.teams, public.team_members, public.devices, public.key_envelopes,
  public.team_repos, public.presence, public.feed to authenticated;

-- ---------------------------------------------------------------------------
-- Functions: where the rules live (mirrors MemoryHub)
-- ---------------------------------------------------------------------------

create or replace function public.normalize_repo(p text) returns text
language plpgsql immutable as $$
declare r text;
begin
  r := lower(regexp_replace(regexp_replace(regexp_replace(trim(p),
        '^(git@github\.com:|https?://github\.com/)', ''), '\.git$', ''), '/$', ''));
  if r !~ '^[a-z0-9_.-]+/[a-z0-9_.-]+$' then
    raise exception '"%" is not a GitHub repo (owner/name)', p using errcode = '22023';
  end if;
  return r;
end $$;

create or replace function public.require_role(p_team uuid, p_min text) returns void
language plpgsql stable security definer set search_path = public as $$
begin
  if public.team_role(p_team) is null then
    raise exception 'not a member of this team' using errcode = '42501';
  end if;
  if not public.has_team_role(p_team, p_min) then
    raise exception 'needs % rights', p_min using errcode = '42501';
  end if;
end $$;

create or replace function public.feed_append(p_team uuid, p_user uuid, p_type text, p_meta jsonb,
  p_repo text default null, p_sealed jsonb default null, p_device uuid default null, p_sig text default null,
  p_dedupe text default null)
returns public.feed language plpgsql security definer set search_path = public as $$
declare ev public.feed;
begin
  insert into public.feed (team_id, repo, user_id, type, meta, sealed, device_id, sig, dedupe_key)
  values (p_team, case when p_repo is null then null else public.normalize_repo(p_repo) end,
          p_user, p_type, coalesce(p_meta, '{}'), p_sealed, p_device, p_sig, p_dedupe)
  on conflict (team_id, dedupe_key) do nothing
  returning * into ev;
  return ev; -- null when deduped
end $$;
revoke all on function public.feed_append(uuid, uuid, text, jsonb, text, jsonb, uuid, text, text) from public, anon, authenticated;

create or replace function public.create_team(p_name text) returns public.teams
language plpgsql security definer set search_path = public as $$
declare t public.teams;
begin
  if auth.uid() is null then raise exception 'not signed in' using errcode = '42501'; end if;
  insert into public.teams (name) values (left(trim(p_name), 80)) returning * into t;
  insert into public.team_members (team_id, user_id, role) values (t.id, auth.uid(), 'owner');
  return t;
end $$;

create or replace function public.register_device(p_label text, p_seal_pub text, p_sign_pub text)
returns public.devices language plpgsql security definer set search_path = public as $$
declare d public.devices;
begin
  if auth.uid() is null then raise exception 'not signed in' using errcode = '42501'; end if;
  insert into public.devices (user_id, label, seal_pub, sign_pub)
  values (auth.uid(), left(coalesce(nullif(p_label, ''), 'device'), 60), p_seal_pub, p_sign_pub)
  on conflict (user_id, sign_pub) do update set label = excluded.label
  returning * into d;
  return d;
end $$;

-- Returns the raw invite token once; only its hash is stored.
create or replace function public.create_invite(p_team uuid, p_ttl_seconds int default 86400)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare tok text; exp timestamptz;
begin
  perform public.require_role(p_team, 'member');
  tok := encode(gen_random_bytes(18), 'base64');
  tok := translate(tok, '+/=', '-_');
  exp := now() + make_interval(secs => least(greatest(p_ttl_seconds, 60), 7 * 86400));
  insert into public.team_invites (token_hash, team_id, created_by, expires_at)
  values (encode(digest(tok, 'sha256'), 'hex'), p_team, auth.uid(), exp);
  return jsonb_build_object('invite', tok, 'expiresAt', (extract(epoch from exp) * 1000)::bigint);
end $$;

create or replace function public.redeem_invite(p_invite text) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare inv public.team_invites; t public.teams; r text;
begin
  if auth.uid() is null then raise exception 'not signed in' using errcode = '42501'; end if;
  select * into inv from public.team_invites
   where token_hash = encode(digest(p_invite, 'sha256'), 'hex') for update;
  if inv is null or inv.used_by is not null or inv.expires_at < now() then
    raise exception 'this invite is invalid, used or expired' using errcode = '42501';
  end if;
  update public.team_invites set used_by = auth.uid() where token_hash = inv.token_hash;
  insert into public.team_members (team_id, user_id, role) values (inv.team_id, auth.uid(), 'member')
  on conflict do nothing;
  if found then
    perform public.feed_append(inv.team_id, null, 'member_joined',
      jsonb_build_object('github', (select github from public.profiles where user_id = auth.uid())));
  end if;
  select * into t from public.teams where id = inv.team_id;
  select role into r from public.team_members where team_id = inv.team_id and user_id = auth.uid();
  return jsonb_build_object('team', to_jsonb(t), 'role', r);
end $$;

create or replace function public.remove_member(p_team uuid, p_user uuid) returns void
language plpgsql security definer set search_path = public as $$
declare target_role text; owners int;
begin
  if p_user <> auth.uid() then perform public.require_role(p_team, 'owner'); end if;
  select role into target_role from public.team_members where team_id = p_team and user_id = p_user;
  if target_role is null then raise exception 'not a member' using errcode = 'P0002'; end if;
  select count(*) into owners from public.team_members where team_id = p_team and role = 'owner';
  if target_role = 'owner' and owners = 1 then
    raise exception 'the last owner can''t leave — hand ownership over first' using errcode = '42501';
  end if;
  -- announce first, while the leaver can still hear it (see MemoryHub.removeMember)
  perform public.feed_append(p_team, null, 'member_left',
    jsonb_build_object('github', (select github from public.profiles where user_id = p_user), 'rotateKey', true));
  delete from public.team_members where team_id = p_team and user_id = p_user;
  delete from public.key_envelopes e using public.devices d
   where e.team_id = p_team and e.device_id = d.id and d.user_id = p_user;
  delete from public.presence where team_id = p_team and user_id = p_user;
end $$;

create or replace function public.put_key_envelopes(p_team uuid, p_version int, p_envelopes jsonb)
returns void language plpgsql security definer set search_path = public as $$
declare cur int; e jsonb; dev uuid;
begin
  perform public.require_role(p_team, 'member');
  select key_version into cur from public.teams where id = p_team for update;
  if p_version <> cur and p_version <> cur + 1 then
    raise exception 'key version % is stale (current %)', p_version, cur using errcode = '40001';
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

create or replace function public.share_repo(p_team uuid, p_repo text) returns void
language plpgsql security definer set search_path = public as $$
declare r text := public.normalize_repo(p_repo);
begin
  perform public.require_role(p_team, 'member');
  insert into public.team_repos (team_id, repo) values (p_team, r) on conflict do nothing;
  if found then
    perform public.feed_append(p_team, auth.uid(), 'repo_shared', jsonb_build_object('repo', r), r);
  end if;
end $$;

create or replace function public.heartbeat(p_team uuid, p jsonb) returns void
language plpgsql security definer set search_path = public as $$
declare r text := public.normalize_repo(p->>'repo'); dev uuid := (p->>'deviceId')::uuid;
begin
  perform public.require_role(p_team, 'member');
  if not exists (select 1 from public.devices where id = dev and user_id = auth.uid()) then
    raise exception 'that device isn''t yours' using errcode = '42501';
  end if;
  if not exists (select 1 from public.team_repos where team_id = p_team and repo = r) then
    raise exception '% isn''t shared with this team', r using errcode = '42501';
  end if;
  insert into public.presence (team_id, user_id, device_id, repo, agent, kind, run_id, task_id, branch,
                               touches, state, since, sealed, sig, ts)
  values (p_team, auth.uid(), dev, r, left(p->>'agent', 120), coalesce(p->>'kind', ''), p->>'runId', p->>'taskId',
          p->>'branch',
          coalesce((select array_agg(left(x, 200)) from (select jsonb_array_elements_text(p->'touches') x limit 50) s), '{}'),
          p->>'state', to_timestamp(coalesce((p->>'since')::double precision, 0) / 1000.0),
          p->'sealed', p->>'sig', now())
  on conflict (team_id, user_id, device_id, repo, agent) do update set
    kind = excluded.kind, run_id = excluded.run_id, task_id = excluded.task_id, branch = excluded.branch,
    touches = excluded.touches, state = excluded.state, since = excluded.since, sealed = excluded.sealed,
    sig = excluded.sig, ts = now();
end $$;

create or replace function public.clear_presence(p_team uuid, p_device uuid, p_repo text, p_agent text) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform public.require_role(p_team, 'member');
  delete from public.presence where team_id = p_team and user_id = auth.uid() and device_id = p_device
    and repo = public.normalize_repo(p_repo) and agent = p_agent;
end $$;

create or replace function public.append_feed(p_team uuid, e jsonb) returns public.feed
language plpgsql security definer set search_path = public as $$
declare dev uuid := nullif(e->>'deviceId', '')::uuid;
begin
  perform public.require_role(p_team, 'member');
  if dev is not null and not exists (select 1 from public.devices where id = dev and user_id = auth.uid()) then
    raise exception 'that device isn''t yours' using errcode = '42501';
  end if;
  if (e->>'type') not in ('goal_started', 'goal_finished', 'plan_written', 'pr_opened', 'pr_merged', 'pr_closed',
                          'check_failed', 'check_passed', 'review_requested', 'review_submitted') then
    raise exception 'members can''t post % events', e->>'type' using errcode = '22023';
  end if;
  return public.feed_append(p_team, auth.uid(), e->>'type', coalesce(e->'meta', '{}'), e->>'repo',
                            e->'sealed', dev, e->>'sig', e->>'dedupeKey');
end $$;

grant execute on function public.create_team(text), public.register_device(text, text, text),
  public.create_invite(uuid, int), public.redeem_invite(text), public.remove_member(uuid, uuid),
  public.put_key_envelopes(uuid, int, jsonb), public.share_repo(uuid, text), public.heartbeat(uuid, jsonb),
  public.clear_presence(uuid, uuid, text, text), public.append_feed(uuid, jsonb)
  to authenticated;
revoke execute on function public.create_team(text), public.register_device(text, text, text),
  public.create_invite(uuid, int), public.redeem_invite(text), public.remove_member(uuid, uuid),
  public.put_key_envelopes(uuid, int, jsonb), public.share_repo(uuid, text), public.heartbeat(uuid, jsonb),
  public.clear_presence(uuid, uuid, text, text), public.append_feed(uuid, jsonb)
  from anon, public;

-- The profile row is created from GitHub OAuth metadata when a user signs up.
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (user_id, github, name)
  values (new.id,
          lower(coalesce(new.raw_user_meta_data->>'user_name', new.raw_user_meta_data->>'preferred_username', 'user-' || left(new.id::text, 8))),
          coalesce(new.raw_user_meta_data->>'full_name', new.raw_user_meta_data->>'name', ''))
  on conflict (user_id) do nothing;
  return new;
end $$;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- Realtime: members hear presence and feed changes (RLS filters per member).
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    begin alter publication supabase_realtime add table public.presence; exception when duplicate_object then null; end;
    begin alter publication supabase_realtime add table public.feed; exception when duplicate_object then null; end;
  end if;
end $$;
