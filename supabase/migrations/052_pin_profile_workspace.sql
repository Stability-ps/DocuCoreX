-- A user cannot move themselves into another workspace.
--
-- CRITICAL. 001 created
--   create policy "Users can update own profile" on public.profiles
--     for update using (auth.uid() = id);
-- with no WITH CHECK and no column restriction. Every tenant boundary in this
-- schema (every RLS policy, the storage policies, the SECURITY DEFINER guards in
-- 027 and 046) decides membership with
--   workspace_id in (select workspace_id from profiles where id = auth.uid())
-- so the one column a user could rewrite on their own row decided which tenant
-- they were in. With the public anon key and their own session, any user could
--   PATCH /rest/v1/profiles?id=eq.<self>  {"workspace_id": "<victim workspace>"}
-- and then read, change and delete that workspace's documents, results,
-- invoices, ledgers and stored files. Reproduced against a disposable database
-- built from these migrations (2026-10-19). The only obstacle is knowing the
-- victim's workspace UUID, which is the first segment of every storage path.
--
-- Fix: a trigger refuses any change to profiles.workspace_id or profiles.id made
-- by a client role (anon, authenticated). Workspace assignment is done by the
-- signup trigger (handle_new_user, SECURITY DEFINER) and by
-- lib/workspace-bootstrap.ts with the service role; neither runs as a client
-- role, so both keep working. The update policy also gains a WITH CHECK.
--
-- profiles.role is deliberately NOT pinned: it is a free-text field users edit
-- in Settings, and nothing authorises on it.
--
-- Covered by tests/sql/41_profile_workspace_pinned.sql.

create or replace function public.profiles_pin_workspace()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  if current_user in ('anon', 'authenticated')
     and (new.workspace_id is distinct from old.workspace_id or new.id is distinct from old.id) then
    raise exception 'profiles.workspace_id cannot be changed by the user'
      using errcode = '42501';
  end if;
  return new;
end $$;

drop trigger if exists profiles_pin_workspace on public.profiles;
create trigger profiles_pin_workspace
  before update on public.profiles
  for each row execute function public.profiles_pin_workspace();

drop policy if exists "Users can update own profile" on public.profiles;
create policy "Users can update own profile" on public.profiles
  for update using (auth.uid() = id) with check (auth.uid() = id);
