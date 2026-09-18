-- Loom app analytics: one row per app open per day, country only.
--
-- What a row holds, and nothing else:
--   day          the UTC day of the open (server-side default)
--   country      the device's REGION SETTING (expo-localization regionCode,
--                e.g. 'DE'), not an IP lookup or a location. May be null.
--   platform     ios | android | web | desktop
--   app_version  the app's version string
-- No user id, no device id, no email, no IP. The app sends each row with the
-- anon key only (never a signed-in session), at most once per UTC day, and
-- only while "Anonymous usage stats (country only)" is on.

create table if not exists public.app_opens (
  id          bigserial primary key,
  day         date not null default current_date,
  country     text check (char_length(country) <= 3),
  platform    text not null check (platform in ('ios', 'android', 'web', 'desktop')),
  app_version text check (char_length(app_version) <= 32),
  created_at  timestamptz not null default now()
);

comment on table public.app_opens is
  'Country-only app-open counts. Insert-only for anon/authenticated; read with the service role.';

create index if not exists app_opens_day_idx on public.app_opens (day);

-- Row level security: clients may add rows, never read, change or delete them.
alter table public.app_opens enable row level security;

drop policy if exists "app_opens: anyone may insert" on public.app_opens;
create policy "app_opens: anyone may insert"
  on public.app_opens
  for insert
  to anon, authenticated
  with check (true);

-- No SELECT / UPDATE / DELETE policies exist, so RLS denies those to anon and
-- authenticated. Belt and braces: take the table privileges away as well.
revoke all on table public.app_opens from anon, authenticated;
grant insert (country, platform, app_version) on table public.app_opens to anon, authenticated;
grant usage, select on sequence public.app_opens_id_seq to anon, authenticated;

-- Counts per country per day, for the owner. The view runs with the caller's
-- rights (security_invoker) and is not granted to anon/authenticated, so only
-- the service role (dashboard SQL editor, server code) can read it.
create or replace view public.app_opens_by_country
  with (security_invoker = true) as
  select day, coalesce(country, '??') as country, platform, count(*) as opens
  from public.app_opens
  group by day, coalesce(country, '??'), platform;

revoke all on public.app_opens_by_country from anon, authenticated;

comment on view public.app_opens_by_country is
  'Service role only. e.g. select country, sum(opens) from app_opens_by_country '
  'where day > current_date - 30 group by country order by 2 desc;';
