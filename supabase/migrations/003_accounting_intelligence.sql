create table if not exists public.accounting_statement_runs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  document_id uuid references public.documents(id) on delete set null,
  processing_job_id uuid references public.processing_jobs(id) on delete set null,
  bank text not null default 'FNB South Africa',
  statement_type text not null default 'business_bank_statement',
  status text not null default 'queued'
    check (status in ('queued', 'processing', 'review', 'completed', 'failed', 'cancelled')),
  company_name text,
  account_number text,
  statement_period_start date,
  statement_period_end date,
  opening_balance numeric(14,2),
  closing_balance numeric(14,2),
  transaction_count int not null default 0,
  bank_charges_total numeric(14,2) not null default 0,
  source_storage_path text not null,
  workbook_storage_path text,
  extraction_provider text not null default 'python_fastapi',
  confidence numeric(5,2) not null default 0,
  error text,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.accounting_transactions (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.accounting_statement_runs(id) on delete cascade,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  transaction_date date,
  description text not null,
  debit_amount numeric(14,2),
  credit_amount numeric(14,2),
  running_balance numeric(14,2),
  bank_charge boolean not null default false,
  account_category text not null default 'Uncategorised',
  vat_treatment text not null default 'review'
    check (vat_treatment in ('standard', 'zero_rated', 'exempt', 'out_of_scope', 'review')),
  supported_by_invoice boolean not null default false,
  notes text not null default '',
  confidence numeric(5,2) not null default 0,
  review_status text not null default 'needs_review'
    check (review_status in ('needs_review', 'ready', 'approved')),
  source_page int,
  raw_text text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists accounting_statement_runs_workspace_idx
  on public.accounting_statement_runs(workspace_id, created_at desc);

create index if not exists accounting_statement_runs_document_idx
  on public.accounting_statement_runs(document_id);

create index if not exists accounting_transactions_run_idx
  on public.accounting_transactions(run_id, transaction_date);

create index if not exists accounting_transactions_workspace_idx
  on public.accounting_transactions(workspace_id, created_at desc);

alter table public.accounting_statement_runs enable row level security;
alter table public.accounting_transactions enable row level security;

drop policy if exists "Users can access accounting statement runs" on public.accounting_statement_runs;
create policy "Users can access accounting statement runs" on public.accounting_statement_runs
  for all using (
    workspace_id in (
      select workspace_id from public.profiles where id = auth.uid()
    )
  )
  with check (
    workspace_id in (
      select workspace_id from public.profiles where id = auth.uid()
    )
  );

drop policy if exists "Users can access accounting transactions" on public.accounting_transactions;
create policy "Users can access accounting transactions" on public.accounting_transactions
  for all using (
    workspace_id in (
      select workspace_id from public.profiles where id = auth.uid()
    )
  )
  with check (
    workspace_id in (
      select workspace_id from public.profiles where id = auth.uid()
    )
  );
