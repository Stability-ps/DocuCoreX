-- Follow-up for databases where migration 026 was already applied.
-- jsonb_populate_recordset produces SQL NULL for an absent JSON field, so an
-- INSERT ... SELECT does not invoke the accounting_transactions.id default.
--
-- accounting_transactions.id is `uuid primary key default gen_random_uuid()`,
-- and ParsedTransaction carries no id, so transaction_insert_row emits rows
-- without one. Under 026 every such row arrived as an explicit NULL and failed
-- the primary key's not-null constraint. There is no softer failure mode: the
-- worker has no client-side fallback by design, and 026 revoked the migration
-- 025 function from service_role, so this RPC is the only path to the ledger.
--
-- The ids are generated in JSON before the insert rather than by an explicit
-- column list, which keeps the `select *` rowtype contract of 026 intact — a
-- new ParsedTransaction field still reaches the table without touching this
-- function.

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
