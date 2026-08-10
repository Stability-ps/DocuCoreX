-- Atomically retire the current extraction attempt and create its replacement.
-- The partial unique index from migration 016 permits only one queued/running
-- extraction job per document, so these operations cannot safely be split
-- across separate PostgREST requests.

create or replace function public.begin_accounting_reprocess(
  p_run_id uuid,
  p_workspace_id uuid
) returns uuid
language plpgsql
security invoker
set search_path = public
as $$
declare
  current_document_id uuid;
  replacement_job_id uuid;
begin
  if auth.uid() is null or not exists (
    select 1
      from public.profiles
     where id = auth.uid()
       and workspace_id = p_workspace_id
  ) then
    raise exception 'workspace access denied' using errcode = '42501';
  end if;

  -- Serializes concurrent Force Reprocess requests for the same statement.
  select document_id
    into current_document_id
    from public.accounting_statement_runs
   where id = p_run_id
     and workspace_id = p_workspace_id
   for update;

  if not found or current_document_id is null then
    raise exception 'accounting statement run not found' using errcode = 'P0002';
  end if;

  -- Retire whichever extraction attempt owns the document. This update removes
  -- it from processing_jobs_one_active_per_doc_type before the insert below.
  update public.processing_jobs
     set status = 'cancelled',
         progress = 100,
         message = 'Superseded by accounting reprocess',
         error = null,
         updated_at = now()
   where document_id = current_document_id
     and type = 'extraction'
     and status in ('queued', 'running');

  insert into public.processing_jobs (
    document_id,
    type,
    status,
    progress,
    message
  ) values (
    current_document_id,
    'extraction',
    'queued',
    0,
    'Accounting reprocessing queued'
  ) returning id into replacement_job_id;

  update public.accounting_statement_runs
     set status = 'processing',
         processing_job_id = replacement_job_id,
         active_job_id = replacement_job_id,
         job_accepted_at = null,
         job_superseded_at = now(),
         error = null,
         updated_at = now()
   where id = p_run_id
     and workspace_id = p_workspace_id;

  return replacement_job_id;
end;
$$;

revoke all on function public.begin_accounting_reprocess(uuid, uuid) from public;
revoke all on function public.begin_accounting_reprocess(uuid, uuid) from anon;
revoke all on function public.begin_accounting_reprocess(uuid, uuid) from service_role;
grant execute on function public.begin_accounting_reprocess(uuid, uuid) to authenticated;
