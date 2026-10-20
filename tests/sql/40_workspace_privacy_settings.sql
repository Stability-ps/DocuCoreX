-- Workspace privacy settings: members read, only the owner writes, tenants are isolated (051).
set client_min_messages = notice;

grant usage on schema public to authenticated;
grant select on public.profiles, public.workspaces to authenticated; -- Supabase grants these by default

-- A member of the fixture workspace who is not its owner, and a second tenant.
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000c1', 'privacy-member@test.local'),
  ('00000000-0000-0000-0000-0000000000c2', 'privacy-other@test.local')
on conflict do nothing;
insert into public.workspaces (id, name, owner_id)
values ('11111111-0000-0000-0000-0000000000c2', 'Privacy Other', '00000000-0000-0000-0000-0000000000c2') on conflict do nothing;
update public.profiles set workspace_id = '11111111-0000-0000-0000-000000000001' where id = '00000000-0000-0000-0000-0000000000c1';
update public.profiles set workspace_id = '11111111-0000-0000-0000-0000000000c2' where id = '00000000-0000-0000-0000-0000000000c2';

insert into public.workspace_privacy_settings (workspace_id, external_ai_processing)
values ('11111111-0000-0000-0000-0000000000c2', 'blocked');

-- The owner (a1) of the fixture workspace sets it.
set role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', false);
insert into public.workspace_privacy_settings (workspace_id, external_ai_processing, updated_by)
values ('11111111-0000-0000-0000-000000000001', 'blocked', '00000000-0000-0000-0000-0000000000a1');
reset role;
select t_report('§51 the owner can set their workspace''s choice',
  exists (select 1 from public.workspace_privacy_settings where workspace_id = '11111111-0000-0000-0000-000000000001' and external_ai_processing = 'blocked'));

-- A non-owner member can read it but not change it.
do $$
declare seen text; changed int; blocked boolean := false;
begin
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c1', true);
  select external_ai_processing into seen from public.workspace_privacy_settings where workspace_id = '11111111-0000-0000-0000-000000000001';
  update public.workspace_privacy_settings set external_ai_processing = 'allowed' where workspace_id = '11111111-0000-0000-0000-000000000001';
  get diagnostics changed = row_count;
  reset role;
  perform t_report('§51 a member reads their workspace''s choice', seen = 'blocked', coalesce(seen, 'nothing visible'));
  perform t_report('§51 a member who is not the owner cannot change it', changed = 0, format('%s rows changed', changed));
end $$;

-- Nobody sees or changes another tenant's choice.
do $$
declare visible int; changed int; inserted boolean := true;
begin
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', true);
  select count(*) into visible from public.workspace_privacy_settings where workspace_id = '11111111-0000-0000-0000-0000000000c2';
  update public.workspace_privacy_settings set external_ai_processing = 'allowed' where workspace_id = '11111111-0000-0000-0000-0000000000c2';
  get diagnostics changed = row_count;
  begin
    insert into public.workspace_privacy_settings (workspace_id, external_ai_processing)
    values ('11111111-0000-0000-0000-0000000000c2', 'allowed');
  exception when others then inserted := false;
  end;
  reset role;
  perform t_report('§51 another tenant''s choice is invisible', visible = 0, format('%s visible', visible));
  perform t_report('§51 another tenant''s choice cannot be changed', changed = 0, format('%s rows changed', changed));
  perform t_report('§51 a choice cannot be created for another tenant', not inserted);
end $$;

select t_report('§51 the other tenant''s choice is untouched',
  (select external_ai_processing from public.workspace_privacy_settings where workspace_id = '11111111-0000-0000-0000-0000000000c2') = 'blocked');

-- Only the two known values are accepted.
do $$
declare refused boolean := false;
begin
  begin
    update public.workspace_privacy_settings set external_ai_processing = 'sometimes' where workspace_id = '11111111-0000-0000-0000-000000000001';
  exception when check_violation then refused := true;
  end;
  perform t_report('§51 only allowed/blocked are accepted', refused);
end $$;

-- anon has no access at all.
do $$
declare blocked boolean := false;
begin
  begin
    set local role anon;
    perform count(*) from public.workspace_privacy_settings;
  exception when insufficient_privilege then blocked := true;
  end;
  reset role;
  perform t_report('§51 anon cannot read privacy settings', blocked);
end $$;

-- Deleting the workspace removes its setting.
delete from public.workspaces where id = '11111111-0000-0000-0000-0000000000c2';
select t_report('§51 the setting goes with its workspace',
  not exists (select 1 from public.workspace_privacy_settings where workspace_id = '11111111-0000-0000-0000-0000000000c2'));

delete from public.workspace_privacy_settings where workspace_id = '11111111-0000-0000-0000-000000000001';
