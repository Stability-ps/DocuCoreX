-- F-20: invite tokens were readable by every workspace member.
--
-- 054 kept "Members can read invites" (SELECT for anyone whose profile is in the
-- workspace), so a Viewer could read public.invites.token. Nothing uses the
-- table today (invites are team_members rows with status 'Invited'; there is no
-- acceptance flow and prod had 0 invite rows on 2026-10-20), so this is latent,
-- but a bearer token for a future membership must only be visible to the people
-- who may create it. Owners and Admins keep access through
-- "Owners and admins can manage invites" (FOR ALL, from 054).
--
-- anon never had a usable path (RLS, auth.uid() is null) but held table and
-- column grants; remove them.

drop policy if exists "Members can read invites" on public.invites;

revoke all on table public.invites from anon;
