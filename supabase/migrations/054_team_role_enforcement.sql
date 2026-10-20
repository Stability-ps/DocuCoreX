-- Team membership is managed by the workspace owner and Admins only.
--
-- 002 gave team_members (and invites) a single FOR ALL policy: any member of a
-- workspace could insert, update or delete any membership row, including
-- promoting themselves to Owner or removing everyone else. The API added only a
-- "keep one Owner" rule. Today every workspace has a single user (there is no
-- invite-acceptance flow), so nothing has been exploited, but the moment
-- invitations work this would hand every invitee full control.
--
-- Who may change membership:
--   * the workspace owner (workspaces.owner_id): anything;
--   * an active Admin: rows that are not, and do not become, Owner, and never
--     their own row;
--   * anyone else (Finance, Auditor, Viewer): read only.
-- The API enforces the same rules (lib/team-permissions.ts) and keeps its
-- "never remove the last Owner" check.
--
-- workspace_team_role() is SECURITY DEFINER because a policy on team_members
-- cannot itself select from team_members under RLS without recursing. It only
-- ever answers for the caller (auth.uid()), never for an arbitrary user.
--
-- Covered by tests/sql/43_team_role_enforcement.sql.

create or replace function public.workspace_team_role(p_workspace_id uuid)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select case
    when exists (select 1 from public.workspaces w where w.id = p_workspace_id and w.owner_id = auth.uid()) then 'Owner'
    else (
      select tm.role from public.team_members tm
      where tm.workspace_id = p_workspace_id and tm.user_id = auth.uid() and tm.status = 'Active'
      order by case tm.role when 'Owner' then 0 when 'Admin' then 1 else 2 end
      limit 1
    )
  end;
$$;

revoke all on function public.workspace_team_role(uuid) from public, anon;
grant execute on function public.workspace_team_role(uuid) to authenticated, service_role;

-- Reading the team stays as it was: any member of the workspace.
drop policy if exists "Users can access team members" on public.team_members;
drop policy if exists "Members can read their team" on public.team_members;
create policy "Members can read their team" on public.team_members
  for select using (workspace_id in (select workspace_id from public.profiles where id = auth.uid()));

drop policy if exists "Owners and admins can add members" on public.team_members;
create policy "Owners and admins can add members" on public.team_members
  for insert with check (
    public.workspace_team_role(workspace_id) = 'Owner'
    or (public.workspace_team_role(workspace_id) = 'Admin' and role <> 'Owner'
        and user_id is distinct from auth.uid())
  );

drop policy if exists "Owners and admins can change members" on public.team_members;
create policy "Owners and admins can change members" on public.team_members
  for update
  using (
    public.workspace_team_role(workspace_id) = 'Owner'
    or (public.workspace_team_role(workspace_id) = 'Admin' and role <> 'Owner'
        and user_id is distinct from auth.uid())
  )
  with check (
    public.workspace_team_role(workspace_id) = 'Owner'
    or (public.workspace_team_role(workspace_id) = 'Admin' and role <> 'Owner'
        and user_id is distinct from auth.uid())
  );

drop policy if exists "Owners and admins can remove members" on public.team_members;
create policy "Owners and admins can remove members" on public.team_members
  for delete using (
    public.workspace_team_role(workspace_id) = 'Owner'
    or (public.workspace_team_role(workspace_id) = 'Admin' and role <> 'Owner'
        and user_id is distinct from auth.uid())
  );

-- Invites follow the same rule (an invite is a future membership).
drop policy if exists "Users can access invites" on public.invites;
drop policy if exists "Members can read invites" on public.invites;
create policy "Members can read invites" on public.invites
  for select using (workspace_id in (select workspace_id from public.profiles where id = auth.uid()));

drop policy if exists "Owners and admins can manage invites" on public.invites;
create policy "Owners and admins can manage invites" on public.invites
  for all
  using (
    public.workspace_team_role(workspace_id) = 'Owner'
    or (public.workspace_team_role(workspace_id) = 'Admin' and role <> 'Owner')
  )
  with check (
    public.workspace_team_role(workspace_id) = 'Owner'
    or (public.workspace_team_role(workspace_id) = 'Admin' and role <> 'Owner')
  );
