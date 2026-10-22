-- F-25: production's handle_new_user() drifted from 001_initial_schema.sql.
--
-- The live function (checked 2026-10-20 with pg_get_functiondef) creates the
-- workspace and profile but NOT the owner's team_members row; 23 of 26
-- workspaces had no membership row for their owner. Permission checks still
-- work (workspace_team_role() treats workspaces.owner_id as Owner), but the team
-- list omits the owner and lib/workspace-bootstrap.ts is the only thing that
-- backfills it, and only when the service role is configured on sign-in.
--
-- Restore the repository definition and backfill the missing rows.

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  new_workspace_id uuid;
begin
  insert into public.workspaces (name, owner_id)
  values (coalesce(new.raw_user_meta_data->>'company', 'DocuCoreX Workspace'), new.id)
  returning id into new_workspace_id;

  insert into public.profiles (id, workspace_id, full_name, company, role)
  values (
    new.id,
    new_workspace_id,
    coalesce(new.raw_user_meta_data->>'full_name', new.email),
    new.raw_user_meta_data->>'company',
    'owner'
  );

  insert into public.team_members (workspace_id, user_id, email, role, status)
  values (new_workspace_id, new.id, new.email, 'Owner', 'Active')
  on conflict (workspace_id, email) do update
    set user_id = excluded.user_id,
        role = excluded.role,
        status = excluded.status;

  return new;
end;
$$;

-- Backfill: every workspace owner gets an Active Owner row in their own workspace.
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
