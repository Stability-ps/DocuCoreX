-- Minimal stand-in for the Supabase-managed pieces the migrations reference.
create schema if not exists auth;
create table if not exists auth.users (
  id uuid primary key default gen_random_uuid(),
  email text,
  -- Supabase's real column; migration 001 installs a trigger that reads it.
  raw_user_meta_data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
-- Supabase reads the caller from the JWT. Here it is a session setting, so a
-- test can act as a specific user.
create or replace function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
$$;
create or replace function auth.role() returns text language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claim.role', true), ''), 'authenticated');
$$;
-- Roles the RLS tests need. `app_user` is a plain role so RLS applies to it;
-- `service_role` mirrors Supabase's BYPASSRLS service key.
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'app_user') then create role app_user login; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role login bypassrls; end if;
end $$;
-- Supabase's built-in roles, which the migrations GRANT to.
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticator') then create role authenticator noinherit login; end if;
end $$;
grant anon, authenticated, service_role to app_user;
create schema if not exists storage;
create table if not exists storage.buckets (
  id text primary key, name text, public boolean default false,
  file_size_limit bigint, allowed_mime_types text[]
);
create table if not exists storage.objects (
  id uuid primary key default gen_random_uuid(),
  bucket_id text references storage.buckets(id), name text, owner uuid,
  created_at timestamptz default now(), metadata jsonb
);
