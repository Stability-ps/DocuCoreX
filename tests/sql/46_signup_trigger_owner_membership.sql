-- Sign-up gives the new owner an Active Owner membership; the backfill is idempotent (058).
set client_min_messages = notice;

grant usage on schema public, auth to authenticated;

insert into auth.users (id, email, raw_user_meta_data) values
  ('00000000-0000-0000-0000-0000000000d1', 'signup-owner@test.local', '{"company":"Signup Co"}'),
  ('00000000-0000-0000-0000-0000000000d2', 'backfill-owner@test.local', '{}')
on conflict do nothing;

-- d2 stands for the 23 production owners created by the drifted trigger.
delete from public.team_members
 where user_id = '00000000-0000-0000-0000-0000000000d2';

create or replace function pg_temp.backfill() returns int language plpgsql as $$
declare n int;
begin
  insert into public.team_members (workspace_id, user_id, email, role, status)
  select w.id, w.owner_id, u.email, 'Owner', 'Active'
  from public.workspaces w
  join auth.users u on u.id = w.owner_id
  where u.email is not null
    and not exists (
      select 1 from public.team_members tm
      where tm.workspace_id = w.id and tm.user_id = w.owner_id
    )
  on conflict (workspace_id, email) do update
    set user_id = excluded.user_id,
        role = 'Owner',
        status = 'Active';
  get diagnostics n = row_count;
  return n;
end $$;

do $$
declare
  signup_rows int; ws uuid; first_run int; second_run int; missing int; dups int; role text;
begin
  select count(*) into signup_rows
    from public.team_members tm join public.workspaces w on w.id = tm.workspace_id
   where w.owner_id = '00000000-0000-0000-0000-0000000000d1'
     and tm.user_id = w.owner_id and tm.role = 'Owner' and tm.status = 'Active';
  first_run := pg_temp.backfill();
  second_run := pg_temp.backfill();
  select count(*) into missing from public.workspaces w
   where not exists (select 1 from public.team_members tm where tm.workspace_id = w.id and tm.user_id = w.owner_id);
  select count(*) into dups from (
    select workspace_id, user_id from public.team_members where user_id is not null group by 1, 2 having count(*) > 1
  ) d;
  select id into ws from public.workspaces where owner_id = '00000000-0000-0000-0000-0000000000d2';
  perform set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000d2', true);
  execute 'set local role authenticated';
  role := public.workspace_team_role(ws);
  reset role;
  perform t_report('§58 sign-up creates the owner''s Active Owner membership', signup_rows = 1, format('%s rows', signup_rows));
  perform t_report('§58 the backfill adds missing owner memberships', first_run >= 1, format('%s rows', first_run));
  perform t_report('§58 the backfill is idempotent', second_run = 0, format('%s rows on the second run', second_run));
  perform t_report('§58 every workspace owner has a membership', missing = 0, format('%s missing', missing));
  perform t_report('§58 no duplicate memberships per workspace and user', dups = 0, format('%s duplicates', dups));
  perform t_report('§58 a backfilled owner is still Owner', role = 'Owner', coalesce(role, 'null'));
end $$;
