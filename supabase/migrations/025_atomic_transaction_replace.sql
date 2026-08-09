-- Replace a run's transactions atomically, so a crash cannot empty a ledger.
--
-- The worker writes extracted transactions as delete-then-insert keyed on
-- run_id (main.py:6202):
--
--     delete from accounting_transactions where run_id = :run
--     insert into accounting_transactions (...613 rows...)
--
-- Two statements, no transaction between them, no unique constraint. A crash, a
-- Render deploy, or an OOM kill in that window leaves the run with ZERO
-- transactions — silent data loss, no error recorded, and the run still reading
-- as processed. For a 613-row bank statement that is the whole ledger.
--
-- PostgREST cannot express a multi-statement transaction from the client, so
-- the two statements cannot be made atomic by the caller. A function body,
-- however, runs inside a single implicit transaction: the delete and the insert
-- commit together or not at all. That is the entire point of this function.
--
-- This is deliberately NOT a fix for concurrency — that is already handled, and
-- by different mechanisms: active_job_id fences a superseded job out of a run
-- (024), and the queued -> running claim on processing_jobs stops one job being
-- dispatched twice (#80). This closes the crash window those cannot see.

create or replace function public.replace_accounting_transactions(
  p_run_id uuid,
  p_workspace_id uuid,
  p_rows jsonb
) returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  inserted integer;
begin
  -- Scoped by workspace as well as run: the worker holds a service-role key, so
  -- the function must not be able to touch another workspace's ledger even if
  -- it is called with a mismatched pair.
  delete from public.accounting_transactions
   where run_id = p_run_id
     and workspace_id = p_workspace_id;

  -- jsonb_populate_recordset maps by column name and leaves anything absent as
  -- NULL, so a caller that omits the migration-021 provenance columns writes
  -- the pre-provenance shape without a separate code path.
  insert into public.accounting_transactions
  select *
    from jsonb_populate_recordset(null::public.accounting_transactions, p_rows);

  get diagnostics inserted = row_count;
  return inserted;
end;
$$;

comment on function public.replace_accounting_transactions(uuid, uuid, jsonb) is
  'Atomically replace a run''s transactions. Delete and insert share one transaction, so a crash cannot leave the run with zero rows. Concurrency is handled separately by active_job_id and the processing_jobs claim.';

-- The worker connects with the service role; no other caller should be able to
-- rewrite a ledger wholesale.
revoke all on function public.replace_accounting_transactions(uuid, uuid, jsonb) from public;
revoke all on function public.replace_accounting_transactions(uuid, uuid, jsonb) from anon;
revoke all on function public.replace_accounting_transactions(uuid, uuid, jsonb) from authenticated;
grant execute on function public.replace_accounting_transactions(uuid, uuid, jsonb) to service_role;
