-- Only the workspace owner and Admins manage membership (054).
set client_min_messages = notice;

grant usage on schema public, auth to authenticated; -- Supabase grants these by default
grant select, insert, update, delete on public.team_members, public.invites to authenticated;
grant select on public.profiles, public.workspaces to authenticated;

-- Workspace 0001 is owned by a1. Add an Admin, a Viewer, and an outside owner.
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000f1', 'team-admin@test.local'),
  ('00000000-0000-0000-0000-0000000000f2', 'team-viewer@test.local'),
  ('00000000-0000-0000-0000-0000000000f3', 'team-outsider@test.local')
on conflict do nothing;
update public.profiles set workspace_id = '11111111-0000-0000-0000-000000000001'
 where id in ('00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-0000000000f2');
insert into public.team_members (id, workspace_id, user_id, email, role, status) values
  ('77777777-0000-0000-0000-0000000000a0', '11111111-0000-0000-0000-000000000001', '00000000-0000-0000-0000-0000000000a1', 'acct@test.local', 'Owner', 'Active'),
  ('77777777-0000-0000-0000-0000000000f1', '11111111-0000-0000-0000-000000000001', '00000000-0000-0000-0000-0000000000f1', 'team-admin@test.local', 'Admin', 'Active'),
  ('77777777-0000-0000-0000-0000000000f2', '11111111-0000-0000-0000-000000000001', '00000000-0000-0000-0000-0000000000f2', 'team-viewer@test.local', 'Viewer', 'Active')
on conflict (workspace_id, email) do nothing;

create or replace function pg_temp.as_user(uid uuid) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', uid::text, true);
  execute 'set local role authenticated';
end $$;

-- The Viewer tries to escalate and to remove people.
do $$
declare n int; inserted boolean := true; promoted int; removed int; owner_rows int;
begin
  perform pg_temp.as_user('00000000-0000-0000-0000-0000000000f2');
  update public.team_members set role = 'Owner' where id = '77777777-0000-0000-0000-0000000000f2';
  get diagnostics promoted = row_count;
  delete from public.team_members where id = '77777777-0000-0000-0000-0000000000f1';
  get diagnostics removed = row_count;
  begin
    insert into public.team_members (workspace_id, email, role, status) values ('11111111-0000-0000-0000-000000000001', 'friend@test.local', 'Owner', 'Invited');
  exception when insufficient_privilege then inserted := false;
  end;
  select count(*) into n from public.team_members where workspace_id = '11111111-0000-0000-0000-000000000001';
  reset role;
  perform t_report('§54 a Viewer cannot promote themselves', promoted = 0, format('%s rows changed', promoted));
  perform t_report('§54 a Viewer cannot remove members', removed = 0, format('%s rows removed', removed));
  perform t_report('§54 a Viewer cannot add members', not inserted);
  perform t_report('§54 a Viewer can still see the team', n = 3, format('%s visible', n));
end $$;

-- The Admin: can manage ordinary members, cannot touch Owners or themselves.
do $$
declare added boolean := true; add_owner boolean := true; self int; owner_row int; viewer_row int;
begin
  perform pg_temp.as_user('00000000-0000-0000-0000-0000000000f1');
  begin
    insert into public.team_members (workspace_id, email, role, status) values ('11111111-0000-0000-0000-000000000001', 'new-viewer@test.local', 'Viewer', 'Invited');
  exception when insufficient_privilege then added := false;
  end;
  begin
    insert into public.team_members (workspace_id, email, role, status) values ('11111111-0000-0000-0000-000000000001', 'new-owner@test.local', 'Owner', 'Invited');
  exception when insufficient_privilege then add_owner := false;
  end;
  update public.team_members set role = 'Owner' where id = '77777777-0000-0000-0000-0000000000f1';
  get diagnostics self = row_count;
  update public.team_members set role = 'Viewer' where id = '77777777-0000-0000-0000-0000000000a0';
  get diagnostics owner_row = row_count;
  begin
    update public.team_members set role = 'Finance' where id = '77777777-0000-0000-0000-0000000000f2';
    get diagnostics viewer_row = row_count;
  exception when insufficient_privilege then viewer_row := -1;
  end;
  reset role;
  perform t_report('§54 an Admin can invite an ordinary member', added);
  perform t_report('§54 an Admin cannot create an Owner', not add_owner);
  perform t_report('§54 an Admin cannot change their own role', self = 0, format('%s rows changed', self));
  perform t_report('§54 an Admin cannot demote the Owner', owner_row = 0, format('%s rows changed', owner_row));
  perform t_report('§54 an Admin can change an ordinary member''s role', viewer_row = 1, format('%s rows changed', viewer_row));
end $$;

-- An Admin cannot promote someone else to Owner either.
do $$
declare refused boolean := false;
begin
  perform pg_temp.as_user('00000000-0000-0000-0000-0000000000f1');
  begin
    update public.team_members set role = 'Owner' where id = '77777777-0000-0000-0000-0000000000f2';
  exception when insufficient_privilege then refused := true;
  end;
  reset role;
  perform t_report('§54 an Admin cannot promote anyone to Owner', refused);
end $$;

-- The workspace owner can do anything.
do $$
declare promoted int;
begin
  perform pg_temp.as_user('00000000-0000-0000-0000-0000000000a1');
  update public.team_members set role = 'Admin' where id = '77777777-0000-0000-0000-0000000000f2';
  get diagnostics promoted = row_count;
  reset role;
  perform t_report('§54 the owner can change any role', promoted = 1);
end $$;

-- Someone from another workspace can do nothing here.
do $$
declare changed int; visible int;
begin
  perform pg_temp.as_user('00000000-0000-0000-0000-0000000000f3');
  update public.team_members set role = 'Viewer' where workspace_id = '11111111-0000-0000-0000-000000000001';
  get diagnostics changed = row_count;
  select count(*) into visible from public.team_members where workspace_id = '11111111-0000-0000-0000-000000000001';
  reset role;
  perform t_report('§54 an outsider can neither see nor change the team', changed = 0 and visible = 0, format('%s changed, %s visible', changed, visible));
end $$;

-- The role helper answers only for the caller, and not for anon.
do $$
declare r text; blocked boolean := false;
begin
  perform pg_temp.as_user('00000000-0000-0000-0000-0000000000f1');
  r := public.workspace_team_role('11111111-0000-0000-0000-000000000001');
  reset role;
  begin
    set local role anon;
    perform public.workspace_team_role('11111111-0000-0000-0000-000000000001');
  exception when insufficient_privilege then blocked := true;
  end;
  reset role;
  perform t_report('§54 the role helper reports the caller''s own role', r = 'Admin', coalesce(r, 'null'));
  perform t_report('§54 anon cannot call the role helper', blocked);
end $$;

delete from public.team_members where workspace_id = '11111111-0000-0000-0000-000000000001';
