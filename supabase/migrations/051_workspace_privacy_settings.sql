-- Workspace control over sending documents to external AI providers.
--
-- The pipeline sends customer documents to third parties: whole PDFs to Azure
-- Document Intelligence and Mistral OCR, page images and full text to OpenAI,
-- and statement lines to OpenAI from the accounting worker
-- (docs/EXTERNAL_DATA_FLOWS.md). Until now no workspace could stop that. This
-- records the workspace's choice; the application enforces it.
--
-- No row means the workspace has not chosen, and the application treats that
-- as 'allowed', which is the behaviour every workspace has today. Whether that
-- default should change is an owner/legal decision, not a schema one.
--
-- Members of the workspace can read the setting (their own jobs must honour
-- it). Only the workspace owner can create or change it. The service role,
-- used by the conversion worker, reads it like any other table.
--
-- Covered by tests/sql/40_workspace_privacy_settings.sql.

create table if not exists public.workspace_privacy_settings (
  workspace_id uuid primary key references public.workspaces(id) on delete cascade,
  external_ai_processing text not null default 'allowed'
    check (external_ai_processing in ('allowed', 'blocked')),
  updated_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now()
);

alter table public.workspace_privacy_settings enable row level security;

drop policy if exists "Members can read their workspace privacy settings" on public.workspace_privacy_settings;
create policy "Members can read their workspace privacy settings" on public.workspace_privacy_settings
  for select using (
    workspace_id in (select workspace_id from public.profiles where id = auth.uid())
  );

drop policy if exists "Owners can create their workspace privacy settings" on public.workspace_privacy_settings;
create policy "Owners can create their workspace privacy settings" on public.workspace_privacy_settings
  for insert with check (
    workspace_id in (select id from public.workspaces where owner_id = auth.uid())
  );

drop policy if exists "Owners can change their workspace privacy settings" on public.workspace_privacy_settings;
create policy "Owners can change their workspace privacy settings" on public.workspace_privacy_settings
  for update
  using (workspace_id in (select id from public.workspaces where owner_id = auth.uid()))
  with check (workspace_id in (select id from public.workspaces where owner_id = auth.uid()));

-- No DELETE policy: an owner changes the value rather than removing the row.
revoke all on table public.workspace_privacy_settings from anon;
grant select, insert, update on table public.workspace_privacy_settings to authenticated;
grant select, insert, update, delete on table public.workspace_privacy_settings to service_role;
