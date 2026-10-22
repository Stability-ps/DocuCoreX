-- LOCAL DEVELOPMENT SEED. Never run against a hosted project.
--
-- Applied by scripts/local-db-reset.sh after every migration, so a reset always gives
-- the same isolated, synthetic starting point:
--
--   Workspace A  owner-a@docucorex.test   Owner
--                admin-a@docucorex.test   Admin
--                viewer-a@docucorex.test  Viewer
--   Workspace B  owner-b@docucorex.test   Owner   (the "other tenant")
--
-- Every account's password is: local-dev-only-password
-- The .test domain is reserved (RFC 2606); none of these addresses can exist.
-- No real customer data, here or anywhere in the local stack.

create extension if not exists pgcrypto;

do $seed$
declare
  users constant jsonb := '[
    {"id": "a0000000-0000-4000-8000-00000000000a", "email": "owner-a@docucorex.test",  "name": "Owner A",  "company": "Workspace A"},
    {"id": "a0000000-0000-4000-8000-0000000000ad", "email": "admin-a@docucorex.test",  "name": "Admin A",  "company": "Workspace A"},
    {"id": "a0000000-0000-4000-8000-0000000000a7", "email": "viewer-a@docucorex.test", "name": "Viewer A", "company": "Workspace A"},
    {"id": "b0000000-0000-4000-8000-00000000000b", "email": "owner-b@docucorex.test",  "name": "Owner B",  "company": "Workspace B"}
  ]';
  u jsonb;
  ws_a uuid;
begin
  if current_setting('server_version_num')::int < 170000 then
    raise exception 'seed expects PostgreSQL 17 (production is 17)';
  end if;

  for u in select * from jsonb_array_elements(users) loop
    -- handle_new_user (migration 001) creates each user's own workspace and profile.
    insert into auth.users (
      instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
      raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
      confirmation_token, recovery_token, email_change_token_new, email_change
    ) values (
      '00000000-0000-0000-0000-000000000000', (u->>'id')::uuid, 'authenticated', 'authenticated', u->>'email',
      crypt('local-dev-only-password', gen_salt('bf')), now(),
      '{"provider": "email", "providers": ["email"]}',
      jsonb_build_object('full_name', u->>'name', 'company', u->>'company'),
      now(), now(), '', '', '', ''
    ) on conflict (id) do nothing;

    insert into auth.identities (id, user_id, provider_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
    values (
      gen_random_uuid(), (u->>'id')::uuid, u->>'id',
      jsonb_build_object('sub', u->>'id', 'email', u->>'email', 'email_verified', true),
      'email', now(), now(), now()
    ) on conflict do nothing;
  end loop;

  select workspace_id into ws_a from public.profiles where id = 'a0000000-0000-4000-8000-00000000000a';

  -- The Admin and Viewer belong to Workspace A, not to the workspaces signup gave
  -- them. The seed runs as the database owner, so migration 052's guard (which
  -- only stops client roles) does not apply.
  update public.profiles set workspace_id = ws_a
   where id in ('a0000000-0000-4000-8000-0000000000ad', 'a0000000-0000-4000-8000-0000000000a7');
  delete from public.workspaces
   where owner_id in ('a0000000-0000-4000-8000-0000000000ad', 'a0000000-0000-4000-8000-0000000000a7');

  insert into public.team_members (workspace_id, user_id, email, role, status) values
    (ws_a, 'a0000000-0000-4000-8000-00000000000a', 'owner-a@docucorex.test',  'Owner',  'Active'),
    (ws_a, 'a0000000-0000-4000-8000-0000000000ad', 'admin-a@docucorex.test',  'Admin',  'Active'),
    (ws_a, 'a0000000-0000-4000-8000-0000000000a7', 'viewer-a@docucorex.test', 'Viewer', 'Active')
  on conflict (workspace_id, email) do nothing;

  insert into public.team_members (workspace_id, user_id, email, role, status)
  select p.workspace_id, p.id, 'owner-b@docucorex.test', 'Owner', 'Active'
    from public.profiles p where p.id = 'b0000000-0000-4000-8000-00000000000b'
  on conflict (workspace_id, email) do nothing;
end
$seed$;
