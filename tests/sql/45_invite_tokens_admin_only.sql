-- Invite tokens are visible only to Owners and Admins; anon has no grants (057).
set client_min_messages = notice;

grant usage on schema public, auth to authenticated;
grant select, insert, update, delete on public.invites to authenticated;

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000e1', 'invite-viewer@test.local'),
  ('00000000-0000-0000-0000-0000000000e2', 'invite-admin@test.local')
on conflict do nothing;
update public.profiles set workspace_id = '11111111-0000-0000-0000-000000000001'
 where id in ('00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000e2');
insert into public.team_members (workspace_id, user_id, email, role, status) values
  ('11111111-0000-0000-0000-000000000001', '00000000-0000-0000-0000-0000000000e1', 'invite-viewer@test.local', 'Viewer', 'Active'),
  ('11111111-0000-0000-0000-000000000001', '00000000-0000-0000-0000-0000000000e2', 'invite-admin@test.local', 'Admin', 'Active')
on conflict (workspace_id, email) do nothing;
insert into public.invites (workspace_id, email, role) values
  ('11111111-0000-0000-0000-000000000001', 'invitee@test.local', 'Viewer');

create or replace function pg_temp.invites_visible_to(uid uuid) returns int language plpgsql as $$
declare n int;
begin
  perform set_config('request.jwt.claim.sub', uid::text, true);
  execute 'set local role authenticated';
  select count(*) into n from public.invites where workspace_id = '11111111-0000-0000-0000-000000000001';
  reset role;
  return n;
end $$;

do $$
declare viewer int; admin int; owner int; anon_denied boolean := false;
begin
  viewer := pg_temp.invites_visible_to('00000000-0000-0000-0000-0000000000e1');
  admin := pg_temp.invites_visible_to('00000000-0000-0000-0000-0000000000e2');
  owner := pg_temp.invites_visible_to('00000000-0000-0000-0000-0000000000a1');
  begin
    execute 'set local role anon';
    perform count(*) from public.invites;
  exception when insufficient_privilege then anon_denied := true;
  end;
  reset role;
  perform t_report('§57 a Viewer cannot read invite tokens', viewer = 0, format('%s visible', viewer));
  perform t_report('§57 an Admin can still read invites', admin = 1, format('%s visible', admin));
  perform t_report('§57 the Owner can still read invites', owner = 1, format('%s visible', owner));
  perform t_report('§57 anon has no access to invites', anon_denied);
end $$;
