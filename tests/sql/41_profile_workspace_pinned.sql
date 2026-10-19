-- A user cannot rewrite their own profile's workspace (052).
set client_min_messages = notice;

grant usage on schema public, auth to authenticated; -- Supabase grants these by default
grant select, update on public.profiles to authenticated; -- Supabase grants these by default
grant select on public.documents to authenticated;

-- A victim tenant with a document, and an attacker in their own workspace.
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000d1', 'pin-attacker@test.local'),
  ('00000000-0000-0000-0000-0000000000d2', 'pin-victim@test.local')
on conflict do nothing;
insert into public.workspaces (id, name, owner_id) values
  ('11111111-0000-0000-0000-0000000000d1', 'Attacker WS', '00000000-0000-0000-0000-0000000000d1'),
  ('11111111-0000-0000-0000-0000000000d2', 'Victim WS', '00000000-0000-0000-0000-0000000000d2')
on conflict do nothing;
update public.profiles set workspace_id = '11111111-0000-0000-0000-0000000000d1' where id = '00000000-0000-0000-0000-0000000000d1';
update public.profiles set workspace_id = '11111111-0000-0000-0000-0000000000d2' where id = '00000000-0000-0000-0000-0000000000d2';
insert into public.documents (workspace_id, owner_id, name, mime_type, storage_path)
values ('11111111-0000-0000-0000-0000000000d2', '00000000-0000-0000-0000-0000000000d2', 'victim-secret.pdf', 'application/pdf', '11111111-0000-0000-0000-0000000000d2/documents/v.pdf');
select t_report('§52 (setup) the victim document exists', exists (select 1 from public.documents where name = 'victim-secret.pdf'));

-- The attack: the attacker points their own profile at the victim's workspace.
do $$
declare refused boolean := false; visible int;
begin
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000d1', true);
  begin
    update public.profiles set workspace_id = '11111111-0000-0000-0000-0000000000d2' where id = auth.uid();
  exception when insufficient_privilege then refused := true;
  end;
  select count(*) into visible from public.documents where name = 'victim-secret.pdf';
  reset role;
  perform t_report('§52 a user cannot move their profile into another workspace', refused);
  perform t_report('§52 so the victim''s documents stay invisible', visible = 0, format('%s visible', visible));
end $$;

select t_report('§52 the attacker''s profile still points at their own workspace',
  (select workspace_id from public.profiles where id = '00000000-0000-0000-0000-0000000000d1') = '11111111-0000-0000-0000-0000000000d1');

-- Leaving a workspace (setting it to null) is refused the same way.
do $$
declare refused boolean := false;
begin
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000d1', true);
  begin
    update public.profiles set workspace_id = null where id = auth.uid();
  exception when insufficient_privilege then refused := true;
  end;
  reset role;
  perform t_report('§52 a user cannot clear their workspace either', refused);
end $$;

-- Ordinary profile edits still work, including the free-text role.
do $$
declare changed int;
begin
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000d1', true);
  update public.profiles set full_name = 'Renamed', company = 'Co', role = 'Bookkeeper', updated_at = now() where id = auth.uid();
  get diagnostics changed = row_count;
  reset role;
  perform t_report('§52 name, company and role edits still save', changed = 1, format('%s rows changed', changed));
end $$;

-- The service role (workspace bootstrap) can still assign a workspace.
do $$
begin
  set local role service_role;
  update public.profiles set workspace_id = '11111111-0000-0000-0000-0000000000d2' where id = '00000000-0000-0000-0000-0000000000d1';
  reset role;
  perform t_report('§52 the service role can still assign a workspace',
    (select workspace_id from public.profiles where id = '00000000-0000-0000-0000-0000000000d1') = '11111111-0000-0000-0000-0000000000d2');
  update public.profiles set workspace_id = '11111111-0000-0000-0000-0000000000d1' where id = '00000000-0000-0000-0000-0000000000d1';
end $$;

-- A new signup still gets a profile (handle_new_user runs as its definer).
insert into auth.users (id, email) values ('00000000-0000-0000-0000-0000000000d3', 'pin-newcomer@test.local');
select t_report('§52 signup still creates a profile',
  exists (select 1 from public.profiles where id = '00000000-0000-0000-0000-0000000000d3'));

delete from public.documents where name = 'victim-secret.pdf';
