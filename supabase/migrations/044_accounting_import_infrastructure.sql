-- Import infrastructure: batches, their error reports, and the chart of
-- accounts import that is the first thing built on top of it.
-- Stage 8A of docs/ACCOUNTING_WORKSPACE_PLAN.md.
--
-- A BATCH ROW IS CREATED ONLY AT COMMIT TIME, never at preview time. Preview
-- is a read-only validation pass — it touches nothing. This means there is
-- no "abandoned preview" state to clean up, and every batch row that exists
-- represents something that actually happened, with real created-or-updated
-- records to point at. The counts on the row (total/valid/rejected) are the
-- COMMIT's own result, independently re-validated at commit time rather than
-- trusted from whatever the client says the preview showed.
--
-- BATCHES AND THEIR ERRORS ARE APPEND-ONLY, the same trigger-enforced
-- guarantee as accounting_postings (036) and accounting_audit_events (041),
-- and for the same reason: a record of what an import did must not become
-- editable after the fact, including for the service role.

create table if not exists public.accounting_import_batches (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,

  import_type text not null check (import_type in ('chart_of_accounts', 'journals')),
  filename text not null,

  total_groups integer not null default 0,
  valid_groups integer not null default 0,
  rejected_groups integer not null default 0,

  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),

  constraint accounting_import_batches_counts_sane
    check (valid_groups + rejected_groups <= total_groups and valid_groups >= 0 and rejected_groups >= 0)
);

create index if not exists accounting_import_batches_company_idx
  on public.accounting_import_batches (company_id, created_at desc);

-- One row per rejected row or rejected journal group, persisted at commit so
-- the error report can be re-downloaded later from import history (8C) —
-- rejected rows are never written anywhere else, so this is the only place
-- their detail survives past the request that rejected them.
create table if not exists public.accounting_import_batch_errors (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid not null references public.accounting_import_batches(id) on delete cascade,
  company_id uuid not null references public.companies(id) on delete cascade,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,

  -- The account code (chart import) or journal reference (journal import)
  -- the rejected rows belonged to. Nullable: a row-level error before
  -- grouping (e.g. an unparseable line) may have no group identity yet.
  group_reference text,
  row_numbers integer[] not null default '{}',
  message text not null,

  created_at timestamptz not null default now()
);

create index if not exists accounting_import_batch_errors_batch_idx
  on public.accounting_import_batch_errors (batch_id);

create or replace function public.accounting_import_are_append_only()
returns trigger
language plpgsql
as $$
begin
  raise exception
    '% is append-only: a row cannot be % once recorded.',
    tg_table_name, lower(tg_op)
    using errcode = 'restrict_violation';
end;
$$;

drop trigger if exists accounting_import_batches_no_update on public.accounting_import_batches;
create trigger accounting_import_batches_no_update
  before update on public.accounting_import_batches
  for each row execute function public.accounting_import_are_append_only();
drop trigger if exists accounting_import_batches_no_delete on public.accounting_import_batches;
create trigger accounting_import_batches_no_delete
  before delete on public.accounting_import_batches
  for each row execute function public.accounting_import_are_append_only();

drop trigger if exists accounting_import_batch_errors_no_update on public.accounting_import_batch_errors;
create trigger accounting_import_batch_errors_no_update
  before update on public.accounting_import_batch_errors
  for each row execute function public.accounting_import_are_append_only();
drop trigger if exists accounting_import_batch_errors_no_delete on public.accounting_import_batch_errors;
create trigger accounting_import_batch_errors_no_delete
  before delete on public.accounting_import_batch_errors
  for each row execute function public.accounting_import_are_append_only();

-- Every committed batch is an audit event too — an import is exactly the
-- kind of action an auditor wants to see, same SECURITY DEFINER shape as 041.
create or replace function public.accounting_import_batches_log()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.accounting_audit_events (company_id, workspace_id, actor_id, action, entity_type, entity_id, new_value)
  values (
    new.company_id, new.workspace_id, auth.uid(),
    case new.import_type when 'chart_of_accounts' then 'chart_of_accounts_imported' else 'journals_imported' end,
    'accounting_import_batch', new.id::text, to_jsonb(new)
  );
  return new;
end;
$$;

drop trigger if exists accounting_import_batches_audit_insert on public.accounting_import_batches;
create trigger accounting_import_batches_audit_insert
  after insert on public.accounting_import_batches
  for each row execute function public.accounting_import_batches_log();

-- ---------------------------------------------------------------------------
-- The traceability link. ON DELETE SET NULL, not CASCADE — deleting a batch
-- record (there is no UI to do this; kept as a safe default) must never
-- destroy the accounts it created, the same reasoning as
-- accounting_postings.source_transaction_id (036, §43).
-- ---------------------------------------------------------------------------
alter table public.accounting_accounts
  add column if not exists import_batch_id uuid references public.accounting_import_batches(id) on delete set null;

create index if not exists accounting_accounts_import_batch_idx
  on public.accounting_accounts (import_batch_id) where import_batch_id is not null;

-- ---------------------------------------------------------------------------
-- Row level security.
-- ---------------------------------------------------------------------------
alter table public.accounting_import_batches enable row level security;
alter table public.accounting_import_batch_errors enable row level security;

drop policy if exists "Users can access accounting import batches" on public.accounting_import_batches;
create policy "Users can access accounting import batches" on public.accounting_import_batches
  for all using (workspace_id in (select workspace_id from public.profiles where id = auth.uid()))
  with check (workspace_id in (select workspace_id from public.profiles where id = auth.uid()));

drop policy if exists "Users can access accounting import batch errors" on public.accounting_import_batch_errors;
create policy "Users can access accounting import batch errors" on public.accounting_import_batch_errors
  for all using (workspace_id in (select workspace_id from public.profiles where id = auth.uid()))
  with check (workspace_id in (select workspace_id from public.profiles where id = auth.uid()));
