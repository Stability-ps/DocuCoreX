-- Accounting foundations: the entity, its financial years, and its chart of
-- accounts. Stage 3 of docs/ACCOUNTING_WORKSPACE_PLAN.md.
--
-- The hierarchy this establishes:
--
--     Workspace  →  Company (entity)  →  Financial Year  →  Accounting data
--
-- THE ENTITY IS THE EXISTING `companies` ROW.
--
-- The plan sketched a new `accounting_entities` table. Reading the schema first
-- showed that would have been a second store for something already modelled:
-- `companies` (migration 009) is already workspace-scoped, already carries the
-- registration number, VAT number and trading name an entity is identified by,
-- already enforces one default per workspace, and is already what invoices are
-- issued from. A parallel accounting-only entity table would mean the same
-- company existing twice under two ids, and every later join would have to pick
-- one — the duplicate accounting store this programme is meant to avoid.
--
-- What genuinely is missing from `companies` is accounting CONFIGURATION, which
-- is why that goes in its own table below rather than as more columns on a table
-- whose other consumer is invoicing.
--
-- Nothing in this migration is destructive. No existing column is altered or
-- dropped, and no existing row is deleted.

-- Non-overlapping date ranges need GiST indexing over a scalar key (company_id)
-- alongside a range, which btree_gist provides.
create extension if not exists btree_gist;

-- ---------------------------------------------------------------------------
-- Accounting configuration for an entity.
-- ---------------------------------------------------------------------------
create table if not exists public.accounting_entity_settings (
  company_id uuid primary key references public.companies(id) on delete cascade,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,

  -- The currency the books are KEPT in. Presentation currency and any foreign
  -- currency handling are separate concerns and are not implied by this.
  base_currency text not null default 'ZAR',

  -- Deliberately free text with no default framework asserted. The product must
  -- not hard-code a claim that output is IFRS or IFRS-for-SMEs compliant; the
  -- accountant states the framework the entity actually reports under, and the
  -- statements are structured to support review rather than to certify.
  reporting_framework text,

  -- The financial year END, stored as month + day rather than a date, because it
  -- recurs. February is the South African default for companies; it is a default
  -- and not an assumption — every entity can set its own.
  financial_year_end_month smallint not null default 2,
  financial_year_end_day smallint not null default 28,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint accounting_entity_settings_month_valid
    check (financial_year_end_month between 1 and 12),
  constraint accounting_entity_settings_day_valid
    check (financial_year_end_day between 1 and 31),
  constraint accounting_entity_settings_currency_valid
    check (base_currency ~ '^[A-Z]{3}$')
);

-- ---------------------------------------------------------------------------
-- Financial years.
-- ---------------------------------------------------------------------------
create table if not exists public.accounting_financial_years (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,

  -- What the accountant calls it ("FY2026", "Year ended 28 February 2026").
  label text not null,
  start_date date not null,
  end_date date not null,

  -- open      — ordinary posting
  -- closed    — year-end complete; postings require a controlled reopening
  -- locked    — signed off; no posting at all
  status text not null default 'open'
    check (status in ('open', 'closed', 'locked')),

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint accounting_financial_years_ordered check (start_date <= end_date)
);

-- A financial year may not overlap another for the SAME entity. This is the
-- integrity rule of §43 stated where it cannot be bypassed: enforcing it only in
-- the UI would let a direct write, an import, or a future API create two years
-- claiming the same day, and every balance for that day would then depend on
-- which year a query happened to pick.
--
-- Ranges are inclusive of both endpoints ('[]'), because a financial year
-- genuinely includes its last day.
alter table public.accounting_financial_years
  drop constraint if exists accounting_financial_years_no_overlap;
alter table public.accounting_financial_years
  add constraint accounting_financial_years_no_overlap
  exclude using gist (
    company_id with =,
    daterange(start_date, end_date, '[]') with &&
  );

-- ---------------------------------------------------------------------------
-- Chart of accounts.
-- ---------------------------------------------------------------------------
create table if not exists public.accounting_accounts (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,

  code text not null,
  name text not null,

  account_type text not null
    check (account_type in ('asset', 'liability', 'equity', 'income', 'cost_of_sales', 'expense', 'other_income', 'other_expense', 'taxation')),

  -- Which side increases the account. Derived from the type on seeding, but
  -- stored rather than computed: a contra account (accumulated depreciation is
  -- an asset with a credit normal balance) is a real and ordinary case, so the
  -- two cannot be assumed to follow one another.
  normal_balance text not null check (normal_balance in ('debit', 'credit')),

  parent_id uuid references public.accounting_accounts(id) on delete restrict,

  -- Accounts are deactivated, never deleted, once anything references them.
  -- Deleting an account with history would orphan the ledger; §11 requires
  -- deactivation instead. The posting-side guard lands with postings in Stage 4.
  is_active boolean not null default true,

  -- System accounts (bank control, VAT control, retained earnings) are required
  -- by the engine and may not be removed or retyped by a user.
  is_system boolean not null default false,

  -- The default tax treatment for postings to this account. Named
  -- vat_default rather than tax_code because the tax-code table is Stage 6;
  -- this holds the existing five-value treatment vocabulary until then.
  vat_default text
    check (vat_default is null or vat_default in ('standard', 'zero_rated', 'exempt', 'out_of_scope', 'review')),

  description text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- One account code per entity. Case-insensitive, so "6100" and " 6100 " cannot
-- become two accounts that print identically in a trial balance.
create unique index if not exists accounting_accounts_code_per_company
  on public.accounting_accounts (company_id, lower(trim(code)));

create index if not exists accounting_accounts_company_idx
  on public.accounting_accounts (company_id, code);

create index if not exists accounting_accounts_parent_idx
  on public.accounting_accounts (parent_id);

create index if not exists accounting_financial_years_company_idx
  on public.accounting_financial_years (company_id, start_date desc);

-- ---------------------------------------------------------------------------
-- Row level security. Same workspace rule as every other accounting table.
-- ---------------------------------------------------------------------------
alter table public.accounting_entity_settings enable row level security;
alter table public.accounting_financial_years enable row level security;
alter table public.accounting_accounts enable row level security;

drop policy if exists "Users can access accounting entity settings" on public.accounting_entity_settings;
create policy "Users can access accounting entity settings" on public.accounting_entity_settings
  for all using (
    workspace_id in (select workspace_id from public.profiles where id = auth.uid())
  )
  with check (
    workspace_id in (select workspace_id from public.profiles where id = auth.uid())
  );

drop policy if exists "Users can access accounting financial years" on public.accounting_financial_years;
create policy "Users can access accounting financial years" on public.accounting_financial_years
  for all using (
    workspace_id in (select workspace_id from public.profiles where id = auth.uid())
  )
  with check (
    workspace_id in (select workspace_id from public.profiles where id = auth.uid())
  );

drop policy if exists "Users can access accounting accounts" on public.accounting_accounts;
create policy "Users can access accounting accounts" on public.accounting_accounts
  for all using (
    workspace_id in (select workspace_id from public.profiles where id = auth.uid())
  )
  with check (
    workspace_id in (select workspace_id from public.profiles where id = auth.uid())
  );

-- ---------------------------------------------------------------------------
-- Seeding.
--
-- The starter chart is EXACTLY the chart the product already reports against
-- (lib/accounting/model.ts CHART). It is not a new or improved chart, because
-- introducing one here would silently change what every existing export means.
-- Stage 5, which makes the ledger authoritative, is where the chart may grow;
-- until then this is a faithful transcription, and a test asserts the two
-- remain identical code-for-code and name-for-name.
-- ---------------------------------------------------------------------------
create or replace function public.accounting_seed_chart_of_accounts(target_company uuid, target_workspace uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.accounting_accounts
    (company_id, workspace_id, code, name, account_type, normal_balance, is_system, vat_default)
  values
    (target_company, target_workspace, '1000', 'Cash at Bank',                  'asset',     'debit',  true,  'out_of_scope'),
    (target_company, target_workspace, '1200', 'VAT Control',                   'asset',     'debit',  true,  'out_of_scope'),
    (target_company, target_workspace, '1300', 'Loan Receivable',               'asset',     'debit',  false, 'out_of_scope'),
    (target_company, target_workspace, '2000', 'Loans',                         'liability', 'credit', false, 'out_of_scope'),
    (target_company, target_workspace, '2100', 'SARS / Tax Liability',          'liability', 'credit', true,  'out_of_scope'),
    (target_company, target_workspace, '2200', 'VAT Payable',                   'liability', 'credit', true,  'out_of_scope'),
    (target_company, target_workspace, '2300', 'Director Loan / Drawings',      'liability', 'credit', false, 'out_of_scope'),
    (target_company, target_workspace, '2900', 'Suspense / Review Required',    'liability', 'credit', true,  'review'),
    (target_company, target_workspace, '2910', 'Refund Suspense',               'liability', 'credit', true,  'review'),
    (target_company, target_workspace, '2920', 'Inter-account Transfers',       'liability', 'credit', true,  'out_of_scope'),
    (target_company, target_workspace, '3000', 'Capital',                       'equity',    'credit', false, 'out_of_scope'),
    (target_company, target_workspace, '3100', 'Retained Earnings',             'equity',    'credit', true,  'out_of_scope'),
    (target_company, target_workspace, '4000', 'Sales / Revenue',               'income',    'credit', false, 'standard'),
    (target_company, target_workspace, '4100', 'Interest Received',             'income',    'credit', false, 'exempt'),
    (target_company, target_workspace, '4200', 'Revenue Review',                'income',    'credit', false, 'review'),
    (target_company, target_workspace, '4300', 'Cash Deposits (Review)',        'income',    'credit', false, 'review'),
    (target_company, target_workspace, '5000', 'Bank Charges',                  'expense',   'debit',  false, 'standard'),
    (target_company, target_workspace, '5100', 'Motor Vehicle Expenses',        'expense',   'debit',  false, 'standard'),
    (target_company, target_workspace, '5200', 'Communication',                 'expense',   'debit',  false, 'standard'),
    (target_company, target_workspace, '5300', 'Insurance',                     'expense',   'debit',  false, 'exempt'),
    (target_company, target_workspace, '5400', 'Payroll / Salaries',            'expense',   'debit',  false, 'out_of_scope'),
    (target_company, target_workspace, '5500', 'Software Subscriptions',        'expense',   'debit',  false, 'standard'),
    (target_company, target_workspace, '5600', 'Courier / Delivery',            'expense',   'debit',  false, 'standard'),
    (target_company, target_workspace, '5650', 'Supplier Payments',             'expense',   'debit',  false, 'review'),
    (target_company, target_workspace, '5700', 'Travel / Meals / Entertainment','expense',   'debit',  false, 'standard'),
    (target_company, target_workspace, '5800', 'Levies',                        'expense',   'debit',  false, 'standard'),
    (target_company, target_workspace, '5900', 'Finance Costs',                 'expense',   'debit',  false, 'exempt'),
    (target_company, target_workspace, '5950', 'Other Operating Expenses',      'expense',   'debit',  false, 'review')
  -- Idempotent: re-running this migration, or seeding a company that already has
  -- a chart, must not duplicate accounts or overwrite an accountant's edits.
  on conflict do nothing;
end;
$$;

-- ---------------------------------------------------------------------------
-- Backfill.
--
-- Every workspace gets a default company if it has none, so that accounting has
-- an entity to belong to. Workspaces that already have companies keep them
-- exactly as they are — this creates nothing where something already exists.
-- ---------------------------------------------------------------------------
do $$
declare
  workspace_row record;
  company_row record;
  new_company uuid;
begin
  for workspace_row in select id, name from public.workspaces loop
    if not exists (select 1 from public.companies where workspace_id = workspace_row.id and not is_archived) then
      insert into public.companies (workspace_id, is_default, business_name)
      values (workspace_row.id, true, coalesce(nullif(trim(workspace_row.name), ''), 'My Company'))
      returning id into new_company;
    end if;
  end loop;

  -- Configuration and a starter chart for every company that lacks them.
  for company_row in select id, workspace_id from public.companies where not is_archived loop
    insert into public.accounting_entity_settings (company_id, workspace_id)
    values (company_row.id, company_row.workspace_id)
    on conflict (company_id) do nothing;

    if not exists (select 1 from public.accounting_accounts where company_id = company_row.id) then
      perform public.accounting_seed_chart_of_accounts(company_row.id, company_row.workspace_id);
    end if;
  end loop;
end;
$$;
