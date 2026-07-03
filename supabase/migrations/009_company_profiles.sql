-- Company Profiles: reusable, workspace-scoped business/issuer profiles that invoices are
-- created from. Invoices continue to store a full snapshot of the issuer/bank fields (see
-- 007_invoice_branding.sql / 008_invoice_expanded_fields.sql) so editing a company profile
-- later never changes historical invoices — only new invoices pick up the latest profile.

create table public.companies (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  is_default boolean not null default false,
  is_archived boolean not null default false,
  logo_data_url text,
  business_name text not null,
  trading_name text,
  vat_number text,
  registration_number text,
  email text,
  phone text,
  website text,
  physical_address text,
  postal_address text,
  bank_name text,
  bank_account_holder text,
  bank_account_number text,
  bank_branch_code text,
  bank_swift text,
  payment_reference text,
  default_currency text not null default 'ZAR',
  default_vat_rate numeric(5,2) not null default 15,
  default_payment_terms text not null default 'due_on_receipt',
  default_notes text,
  default_terms text,
  next_invoice_number integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.companies
  add constraint companies_default_payment_terms_check
  check (default_payment_terms in ('due_on_receipt', '7_days', '14_days', '30_days', '60_days', '90_days'));

-- Only one default company profile per workspace.
create unique index companies_one_default_per_workspace
  on public.companies (workspace_id)
  where is_default and not is_archived;

alter table public.companies enable row level security;

create policy "Users can access workspace companies" on public.companies
  for all using (
    workspace_id in (
      select workspace_id from public.profiles where id = auth.uid()
    )
  );

-- ---------------------------------------------------------------------------
-- Invoices reference the company profile they were created from (nullable —
-- legacy invoices created before this feature have no company_id).
-- ---------------------------------------------------------------------------
alter table public.invoices
  add column if not exists company_id uuid references public.companies(id) on delete set null;

create index if not exists invoices_company_id_idx on public.invoices (company_id);

-- ---------------------------------------------------------------------------
-- Per-company invoice sequence: every company profile starts its own invoices
-- at INV-000001, independent of any other company in the same workspace and
-- independent of the workspace-level sequence used for invoices with no
-- selected company (see 008_invoice_expanded_fields.sql for that fallback).
-- ---------------------------------------------------------------------------
create table public.company_invoice_sequences (
  company_id uuid primary key references public.companies(id) on delete cascade,
  next_number integer not null default 1,
  updated_at timestamptz not null default now()
);

alter table public.company_invoice_sequences enable row level security;

create policy "Users can view their company invoice sequence" on public.company_invoice_sequences
  for select using (
    company_id in (
      select id from public.companies
      where workspace_id in (select workspace_id from public.profiles where id = auth.uid())
    )
  );

-- Mutations only happen through next_company_invoice_sequence() (security definer).

create or replace function public.next_company_invoice_sequence(p_company_id uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  assigned integer;
begin
  insert into public.company_invoice_sequences (company_id, next_number)
  values (p_company_id, 2)
  on conflict (company_id) do update
    set next_number = company_invoice_sequences.next_number + 1,
        updated_at = now()
  returning next_number - 1 into assigned;

  return assigned;
end;
$$;

grant execute on function public.next_company_invoice_sequence(uuid) to authenticated;
