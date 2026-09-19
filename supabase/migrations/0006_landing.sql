-- Loom Teams, Phase 4 ("land safely") — the feed events landing adds.
--
-- Decisions (docs/teams-architecture.md §1a):
--   D53  a check that passed on rerun is reported as flaky, not fixed
--   D55  a goal out of fix attempts needs someone
--   D63  adopting a teammate's goal, and handing it back, go through the feed
--   D64  goal_landed marks a goal merged, for cost per landed PR

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
                          'overlap_decided', 'drift', 'zone_waiting', 'conflict_predicted', 'canon_proposed',
                          'goal_landed', 'goal_needs_someone', 'goal_adopted', 'goal_returned', 'check_flaky') then
    raise exception 'members can''t post % events', e->>'type' using errcode = '22023';
  end if;
  return public.feed_append(p_team, auth.uid(), e->>'type', coalesce(e->'meta', '{}'), e->>'repo',
                            e->'sealed', dev, e->>'sig', e->>'dedupeKey');
end $$;
