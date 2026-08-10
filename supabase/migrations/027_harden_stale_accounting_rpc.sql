-- Follow-up for databases where migration 026 was already applied.
-- The stale-run repair RPC is called only by authenticated application users,
-- so require a real user identity and an explicit workspace membership check.

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

revoke all on function public.fail_stale_accounting_run(uuid, uuid, uuid, timestamptz, text) from public;
revoke all on function public.fail_stale_accounting_run(uuid, uuid, uuid, timestamptz, text) from anon;
revoke all on function public.fail_stale_accounting_run(uuid, uuid, uuid, timestamptz, text) from service_role;
grant execute on function public.fail_stale_accounting_run(uuid, uuid, uuid, timestamptz, text) to authenticated;
