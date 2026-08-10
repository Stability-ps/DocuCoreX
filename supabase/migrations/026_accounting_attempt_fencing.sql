-- Close the remaining accounting-attempt races.
--
-- A job fence is useful only when the destructive write and the ownership check
-- happen in the same database transaction. Checking active_job_id in Python and
-- then calling the old replacement RPC leaves a gap in which Force Reprocess can
-- supersede the job. The owned replacement below locks the run, verifies the
-- attempt, and replaces the ledger as one transaction.

create or replace function public.replace_accounting_transactions_owned(
  p_run_id uuid,
  p_workspace_id uuid,
  p_job_id uuid,
  p_rows jsonb
) returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  current_job_id uuid;
  current_status text;
  inserted integer;
  normalized_rows jsonb;
begin
  select active_job_id, status
    into current_job_id, current_status
    from public.accounting_statement_runs
   where id = p_run_id
     and workspace_id = p_workspace_id
   for update;

  if not found then
    raise exception 'accounting run not found for owned transaction replacement';
  end if;

  if current_job_id is distinct from p_job_id or current_status <> 'processing' then
    raise exception 'accounting job does not own writable run';
  end if;

  delete from public.accounting_transactions
   where run_id = p_run_id
     and workspace_id = p_workspace_id;

  select coalesce(
           jsonb_agg(
             case
               when nullif(transaction_row ->> 'id', '') is null
                 then jsonb_set(transaction_row, '{id}', to_jsonb(gen_random_uuid()), true)
               else transaction_row
             end
           ),
           '[]'::jsonb
         )
    into normalized_rows
    from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) as transaction_row;

  insert into public.accounting_transactions
  select *
    from jsonb_populate_recordset(null::public.accounting_transactions, normalized_rows);

  get diagnostics inserted = row_count;
  return inserted;
end;
$$;

revoke all on function public.replace_accounting_transactions_owned(uuid, uuid, uuid, jsonb) from public;
revoke all on function public.replace_accounting_transactions_owned(uuid, uuid, uuid, jsonb) from anon;
revoke all on function public.replace_accounting_transactions_owned(uuid, uuid, uuid, jsonb) from authenticated;
grant execute on function public.replace_accounting_transactions_owned(uuid, uuid, uuid, jsonb) to service_role;

-- Once the owned replacement exists, an older worker must fail safely instead
-- of continuing to call the unfenced migration-025 function during a rolling
-- deploy. The new worker never calls this signature.
revoke execute on function public.replace_accounting_transactions(uuid, uuid, jsonb) from service_role;

-- Read-side stale repair also needs a database-side compare-and-set. The caller
-- may observe a stale heartbeat and race with a heartbeat, completion, or Force
-- Reprocess before its update arrives. This function locks the run and checks the
-- linked job's CURRENT heartbeat/status before changing either row.

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

  -- Missing jobs, terminal jobs, and running jobs with a genuinely cold
  -- heartbeat are recoverable. Queued/running jobs with fresh activity are not.
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
grant execute on function public.fail_stale_accounting_run(uuid, uuid, uuid, timestamptz, text) to authenticated;
revoke all on function public.fail_stale_accounting_run(uuid, uuid, uuid, timestamptz, text) from service_role;
