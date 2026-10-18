-- Loom accounts sign in with GitHub only (2026-10-18).
--
-- 1. A Loom account is a GitHub account. Any other way in (email, a magic link,
--    an anonymous session, another OAuth provider) is refused at the database,
--    whatever the Auth settings say — the provider is read from
--    raw_app_meta_data, which GoTrue writes and the user can't.
-- 2. A profile's `github` login came from raw_user_meta_data.user_name, which a
--    sign-up can set to anything (an email sign-up could claim someone else's
--    login — the 2026-09-24 audit). Profiles are now made only for GitHub
--    sign-ups, with the login GitHub itself reported.
-- Existing accounts are untouched.

create or replace function public.github_only() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if coalesce(new.raw_app_meta_data->>'provider', '') <> 'github' then
    raise exception 'Loom accounts sign in with GitHub only' using errcode = '42501';
  end if;
  return new;
end $$;
drop trigger if exists on_auth_user_github_only on auth.users;
create trigger on_auth_user_github_only before insert on auth.users
  for each row execute function public.github_only();

create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  login text;
begin
  if coalesce(new.raw_app_meta_data->>'provider', '') <> 'github' then return new; end if;
  login := lower(nullif(coalesce(new.raw_user_meta_data->>'user_name', new.raw_user_meta_data->>'preferred_username'), ''));
  insert into public.profiles (user_id, github, name)
  values (new.id,
          coalesce(login, 'user-' || left(new.id::text, 8)),
          coalesce(new.raw_user_meta_data->>'full_name', new.raw_user_meta_data->>'name', ''))
  on conflict (user_id) do nothing;
  return new;
end $$;
