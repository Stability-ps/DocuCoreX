-- Accounting runs can only reference their own workspace's documents and jobs,
-- and fail_stale_accounting_run can only fail this workspace's job.
--
-- Found by the 2026-10-19 security audit (confirmed against a disposable
-- database): accounting_statement_runs.processing_job_id and .document_id, and
-- uploads.document_id, are plain foreign keys. RLS checks the row's own
-- workspace_id but not what these point at, so a user could insert a run in
-- their own workspace naming another tenant's job and then call
-- fail_stale_accounting_run (SECURITY DEFINER), which failed that job and wrote
-- the caller's text into it, visible in the victim's UI.
--
-- 1. fail_stale_accounting_run ignores a job outside the caller's workspace.
-- 2. A trigger refuses a run whose document_id or processing_job_id, or an
--    upload whose document_id, belongs to another workspace.
--
-- Checked in production before writing this: all 11 runs with a job point at a
-- job whose document is in the run's own workspace.
--
-- Covered by tests/sql/44_run_job_workspace_guard.sql.

create or replace function public.fail_stale_accounting_run(
  p_run_id uuid,
  p_workspace_id uuid,
  p_active_job_id uuid,
  p_liveness_cutoff timestamptz,
  p_reason text
) returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  current_active_job_id uuid;
  current_job_id uuid;
  current_run_status text;
  current_run_updated_at timestamptz;
  current_job_status text;
  current_job_updated_at timestamptz;
begin
  if auth.uid() is null or not exists (
    select 1 from public.profiles
     where id = auth.uid()
       and workspace_id = p_workspace_id
  ) then
    raise exception 'workspace access denied' using errcode = '42501';
  end if;

  select active_job_id, processing_job_id, status, updated_at
    into current_active_job_id, current_job_id, current_run_status, current_run_updated_at
    from public.accounting_statement_runs
   where id = p_run_id
     and workspace_id = p_workspace_id
   for update;

  if not found
     or current_run_status <> 'processing'
     or current_active_job_id is distinct from p_active_job_id then
    return false;
  end if;

  -- The run's processing_job_id is only a foreign key: before 055 it could name
  -- ANOTHER workspace's job, and this definer function then failed that job
  -- and wrote p_reason into it. Only a job whose document is in this workspace
  -- is touched; any other is treated as no job at all.
  if current_job_id is not null and not exists (
    select 1 from public.processing_jobs j
      join public.documents d on d.id = j.document_id
     where j.id = current_job_id and d.workspace_id = p_workspace_id
  ) then
    current_job_id := null;
  end if;

  if current_job_id is not null then
    select status, updated_at
      into current_job_status, current_job_updated_at
      from public.processing_jobs
     where id = current_job_id
     for update;
  end if;

  if current_job_id is null then
    if current_run_updated_at >= p_liveness_cutoff then
      return false;
    end if;
  elsif current_job_status is null then
    null;
  elsif current_job_status in ('completed', 'failed', 'cancelled') then
    null;
  elsif current_job_updated_at is null or current_job_updated_at >= p_liveness_cutoff then
    return false;
  end if;

  update public.accounting_statement_runs
     set status = 'failed',
         error = p_reason,
         processing_step = 'Stuck / Needs retry',
         updated_at = now()
   where id = p_run_id
     and workspace_id = p_workspace_id
     and status = 'processing'
     and active_job_id is not distinct from p_active_job_id;

  if not found then
    return false;
  end if;

  if current_job_id is not null then
    update public.processing_jobs
       set status = 'failed',
           progress = 100,
           message = p_reason,
           error = p_reason,
           updated_at = now()
     where id = current_job_id
       and status in ('queued', 'running');
  end if;

  return true;
end;
$$;

create or replace function public.enforce_same_workspace_references()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
-- SECURITY DEFINER so the lookup sees the referenced row whatever the caller's
-- RLS lets them see: the point is to compare workspaces, and an invisible
-- foreign row must still be refused, not waved through as "not found".
declare
  v_doc uuid := (to_jsonb(new) ->> 'document_id')::uuid;
  v_job uuid := case when tg_table_name = 'accounting_statement_runs' then (to_jsonb(new) ->> 'processing_job_id')::uuid end;
begin
  if v_doc is not null and not exists (
    select 1 from public.documents d where d.id = v_doc and d.workspace_id = new.workspace_id
  ) then
    raise exception '%.document_id must belong to the same workspace', tg_table_name using errcode = '42501';
  end if;
  if v_job is not null and not exists (
    select 1 from public.processing_jobs j join public.documents d on d.id = j.document_id
     where j.id = v_job and d.workspace_id = new.workspace_id
  ) then
    raise exception 'accounting_statement_runs.processing_job_id must belong to the same workspace' using errcode = '42501';
  end if;
  return new;
end $$;

revoke all on function public.enforce_same_workspace_references() from public, anon, authenticated;

drop trigger if exists runs_reference_own_workspace on public.accounting_statement_runs;
create trigger runs_reference_own_workspace
  before insert or update of document_id, processing_job_id, workspace_id on public.accounting_statement_runs
  for each row execute function public.enforce_same_workspace_references();

drop trigger if exists uploads_reference_own_workspace on public.uploads;
create trigger uploads_reference_own_workspace
  before insert or update of document_id, workspace_id on public.uploads
  for each row execute function public.enforce_same_workspace_references();
